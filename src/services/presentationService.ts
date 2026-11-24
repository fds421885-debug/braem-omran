import JSZip from 'jszip';
import { collection, deleteDoc, doc, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { generateValidId } from './multiDb';
import {
  estimateRecordBytes,
  executeTabWriteWithRollover,
  findExistingDocInTabPool,
  getDocsFresh,
  getReadDbsForComplexTab,
  type ComplexWorkspaceData,
} from './platformService';
import type {
  PresentationChatTurn,
  PresentationInteractiveBlock,
  PresentationRecord,
  PresentationSlide,
  PresentationSlideLayout,
  PresentationThemeTone,
} from '../types/platform';

export interface ParsedPptxSlide {
  slideNumber: number;
  title: string;
  paragraphs: string[];
  notes: string;
}

export interface PresentationAiChatResponse {
  assistantReply: string;
  operation: 'replace_deck' | 'update_slide' | 'append_slides';
  targetSlideIndex?: number;
  deckTitle: string;
  description: string;
  slides: PresentationSlide[];
}

const ALLOWED_HTML_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'br',
  'hr',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'button',
]);

const ALLOWED_ATTRS = new Set([
  'class',
  'dir',
  'data-tahajji',
  'data-ayah',
  'data-surah',
  'data-ayah-num',
  'data-surah-name',
  'type',
  'role',
  'aria-label',
]);

/**
 * DOMParser-based allowlist sanitizer so AI-generated HTML renders safely
 * without <script>, <style>, <iframe>, or inline event handlers.
 */
export function sanitizeSlideHtml(rawHtml: string): string {
  const input = String(rawHtml || '').trim();
  if (!input) return '';
  if (typeof DOMParser === 'undefined') {
    return input.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
  }

  const parser = new DOMParser();
  const docHtml = parser.parseFromString(`<div id="slide-root">${input}</div>`, 'text/html');
  const root = docHtml.getElementById('slide-root');
  if (!root) return '';

  const cleanNode = (node: Node): void => {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (!ALLOWED_HTML_TAGS.has(tag)) {
          if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
            el.remove();
            continue;
          }
          // Unwrap unsupported benign tags while preserving children
          cleanNode(el);
          const frag = docHtml.createDocumentFragment();
          while (el.firstChild) frag.appendChild(el.firstChild);
          el.replaceWith(frag);
          continue;
        }

        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
            el.removeAttribute(attr.name);
          }
        }
        if (tag === 'button' && !el.getAttribute('type')) {
          el.setAttribute('type', 'button');
        }
        cleanNode(el);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
      }
    }
  };

  cleanNode(root);
  return root.innerHTML.slice(0, 18000);
}

function normalizeSlideList(rawSlides: PresentationSlide[]): PresentationSlide[] {
  const validLayouts = new Set<PresentationSlideLayout>([
    'cover',
    'quran_ayah',
    'tahajji_words',
    'points',
    'comparison',
    'summary',
  ]);
  const validTones = new Set<PresentationThemeTone>(['cream', 'orange', 'green', 'espresso']);

  return rawSlides.slice(0, 40).map((s, idx) => {
    const blocks: PresentationInteractiveBlock[] = (Array.isArray(s.interactiveBlocks) ? s.interactiveBlocks : [])
      .filter((b) => b && typeof b.arabicText === 'string' && b.arabicText.trim().length > 0)
      .slice(0, 8)
      .map((b, bIdx) => ({
        id: String(b.id || `blk_${idx}_${bIdx}`).slice(0, 80),
        type:
          b.type === 'ayah' || b.type === 'tahajji_words' || b.type === 'tip'
            ? b.type
            : 'card',
        label: String(b.label || '').trim().slice(0, 80),
        arabicText: String(b.arabicText || '').trim().slice(0, 1200),
        ...(b.type === 'ayah' && Number(b.surahNumber) >= 1 && Number(b.ayahNumber) >= 1
          ? {
              surahNumber: Math.round(Number(b.surahNumber)),
              ayahNumber: Math.round(Number(b.ayahNumber)),
              surahName: String(b.surahName || '').trim().slice(0, 60),
            }
          : {}),
        note: String(b.note || '').trim().slice(0, 300),
      }));

    return {
      id: String(s.id || `slide_${idx + 1}`).slice(0, 80),
      order: idx,
      title: String(s.title || `الشريحة ${idx + 1}`).trim().slice(0, 180),
      subtitle: String(s.subtitle || '').trim().slice(0, 220),
      layout: validLayouts.has(s.layout) ? s.layout : 'points',
      themeTone: validTones.has(s.themeTone) ? s.themeTone : 'cream',
      htmlContent: sanitizeSlideHtml(s.htmlContent || ''),
      interactiveBlocks: blocks,
      speakerNotes: String(s.speakerNotes || '').trim().slice(0, 1000),
    };
  });
}

function normalizeChatHistory(rawHistory: PresentationChatTurn[]): PresentationChatTurn[] {
  return rawHistory
    .filter((t) => t && (t.role === 'user' || t.role === 'model') && typeof t.text === 'string' && t.text.trim())
    .slice(-60)
    .map((t, idx) => ({
      id: String(t.id || `turn_${idx}`).slice(0, 80),
      role: t.role,
      text: String(t.text || '').trim().slice(0, 2500),
      timestampMs: Number(t.timestampMs) || Date.now(),
      ...(typeof t.targetSlideIndex === 'number' ? { targetSlideIndex: t.targetSlideIndex } : {}),
    }));
}

export async function listPresentationsInComplex(
  workspace: ComplexWorkspaceData
): Promise<PresentationRecord[]> {
  try {
    const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
    const byId = new Map<string, PresentationRecord>();
    await Promise.all(
      readDbs.map(async (targetDb) => {
        const snap = await getDocsFresh(
          query(collection(targetDb, 'presentations'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null);
        snap?.forEach((d) => {
          const rec = d.data() as PresentationRecord;
          if (rec && rec.active !== false) {
            byId.set(rec.id, {
              ...rec,
              slides: Array.isArray(rec.slides) ? rec.slides : [],
              chatHistory: Array.isArray(rec.chatHistory) ? rec.chatHistory : [],
            });
          }
        });
      })
    );
    return Array.from(byId.values()).sort((a, b) => {
      const aSec = (a.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
      const bSec = (b.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
      return bSec - aSec;
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'presentations');
  }
}

export async function savePresentationRecord(params: {
  workspace: ComplexWorkspaceData;
  id?: string;
  mosqueId?: string;
  halaqaId?: string;
  title: string;
  description?: string;
  sourceType: 'ai' | 'pptx_import';
  sourceFileName?: string;
  slides: PresentationSlide[];
  chatHistory: PresentationChatTurn[];
  createdBy: string;
  createdByName: string;
}): Promise<PresentationRecord> {
  const {
    workspace,
    id,
    mosqueId = '',
    halaqaId = '',
    title,
    description = '',
    sourceType,
    sourceFileName = '',
    slides,
    chatHistory,
    createdBy,
    createdByName,
  } = params;

  const cleanTitle = title.trim().slice(0, 180);
  if (!cleanTitle) {
    throw new Error('يرجى كتابة عنوان للعرض التقديمي قبل الحفظ.');
  }

  const recordId = id || generateValidId('prs');
  const cleanMosqueId = String(mosqueId || '').trim().slice(0, 128);
  const cleanHalaqaId = String(halaqaId || '').trim().slice(0, 128);
  const cleanDescription = String(description || '').trim().slice(0, 600);
  const cleanSourceType: 'ai' | 'pptx_import' = sourceType === 'pptx_import' ? 'pptx_import' : 'ai';
  const cleanSourceFileName = String(sourceFileName || '').trim().slice(0, 200);
  const cleanCreatedBy = (auth.currentUser?.uid || createdBy || 'staff').slice(0, 128);
  const cleanCreatedByName = (createdByName || 'معلم / مشرف').trim().slice(0, 120);

  let cleanSlides = normalizeSlideList(slides);
  const cleanHistory = normalizeChatHistory(chatHistory);

  // Guard Firestore 1 MiB document size limit cleanly before writing
  let approxBytes = estimateRecordBytes({
    id: recordId,
    complexId: workspace.complex.id,
    title: cleanTitle,
    description: cleanDescription,
    slides: cleanSlides,
    chatHistory: cleanHistory,
  });
  if (approxBytes > 880_000) {
    cleanSlides = cleanSlides.map((s) => ({
      ...s,
      htmlContent: s.htmlContent.slice(0, 9000),
    }));
    approxBytes = estimateRecordBytes({
      id: recordId,
      slides: cleanSlides,
      chatHistory: cleanHistory.slice(-20),
    });
  }

  try {
    const located = id
      ? await findExistingDocInTabPool(workspace, 'curricula', 'presentations', recordId)
      : { exists: false, db: workspace.complexDb, shard: null };

    if (located.exists) {
      await updateDoc(doc(located.db, 'presentations', recordId), {
        mosqueId: cleanMosqueId,
        halaqaId: cleanHalaqaId,
        title: cleanTitle,
        description: cleanDescription,
        slides: cleanSlides,
        chatHistory: cleanHistory.slice(-60),
        active: true,
        updatedAt: serverTimestamp(),
      });
    } else {
      const payload = {
        id: recordId,
        complexId: workspace.complex.id,
        mosqueId: cleanMosqueId,
        halaqaId: cleanHalaqaId,
        title: cleanTitle,
        description: cleanDescription,
        sourceType: cleanSourceType,
        sourceFileName: cleanSourceFileName,
        slides: cleanSlides,
        chatHistory: cleanHistory.slice(-60),
        createdBy: cleanCreatedBy,
        createdByName: cleanCreatedByName,
        active: true,
      };
      await executeTabWriteWithRollover(
        workspace,
        'curricula',
        Math.max(approxBytes, estimateRecordBytes(payload)),
        true,
        async (targetDb) => {
          await setDoc(doc(targetDb, 'presentations', recordId), {
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      );
    }

    return {
      id: recordId,
      complexId: workspace.complex.id,
      mosqueId: cleanMosqueId,
      halaqaId: cleanHalaqaId,
      title: cleanTitle,
      description: cleanDescription,
      sourceType: cleanSourceType,
      sourceFileName: cleanSourceFileName,
      slides: cleanSlides,
      chatHistory: cleanHistory.slice(-60),
      createdBy: cleanCreatedBy,
      createdByName: cleanCreatedByName,
      active: true,
    };
  } catch (err) {
    handleFirestoreError(err, id ? OperationType.UPDATE : OperationType.CREATE, `presentations/${recordId}`);
  }
}

export async function deletePresentationRecord(
  workspace: ComplexWorkspaceData,
  presentationId: string
): Promise<void> {
  try {
    const located = await findExistingDocInTabPool(
      workspace,
      'curricula',
      'presentations',
      presentationId
    );
    await deleteDoc(doc(located.db, 'presentations', presentationId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `presentations/${presentationId}`);
  }
}

function resolveZipRelativePath(baseDir: string, target: string): string {
  const cleanTarget = target.replace(/^\/+/, '');
  if (cleanTarget.startsWith('ppt/')) return cleanTarget;
  const parts = `${baseDir}/${cleanTarget}`.split('/');
  const resolved: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') resolved.pop();
    else resolved.push(p);
  }
  return resolved.join('/');
}

function extractXmlParagraphs(xmlText: string): string[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  const paragraphs: string[] = [];
  const pNodes = Array.from(xmlDoc.getElementsByTagNameNS('*', 'p'));
  if (pNodes.length > 0) {
    for (const p of pNodes) {
      const tNodes = Array.from(p.getElementsByTagNameNS('*', 't'));
      const line = tNodes
        .map((t) => t.textContent || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (line) paragraphs.push(line);
    }
  } else {
    const tNodes = Array.from(xmlDoc.getElementsByTagNameNS('*', 't'));
    const joined = tNodes
      .map((t) => t.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (joined) paragraphs.push(joined);
  }
  return paragraphs;
}

/**
 * Parses a PowerPoint (.pptx) archive entirely in-browser with JSZip.
 */
export async function parsePptxFile(file: File): Promise<ParsedPptxSlide[]> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.ppt') && !lowerName.endsWith('.pptx')) {
    throw new Error('صيغة .ppt القديمة غير مدعومة مباشرة؛ يرجى حفظ الملف بصيغة .pptx ثم إعادة رفعه.');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('تعذّر قراءة ملف الباوربوينت؛ تأكد أنه ملف .pptx صالح وغير تالف.');
  }

  const orderedSlidePaths: string[] = [];
  const presXmlFile = zip.file('ppt/presentation.xml');
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');

  if (presXmlFile && presRelsFile) {
    try {
      const [presXml, relsXml] = await Promise.all([
        presXmlFile.async('string'),
        presRelsFile.async('string'),
      ]);
      const parser = new DOMParser();
      const presDoc = parser.parseFromString(presXml, 'application/xml');
      const relsDoc = parser.parseFromString(relsXml, 'application/xml');

      const relMap = new Map<string, string>();
      for (const rel of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
        const rId = rel.getAttribute('Id') || '';
        const target = rel.getAttribute('Target') || '';
        if (rId && target) {
          relMap.set(rId, resolveZipRelativePath('ppt', target));
        }
      }

      const sldIds = Array.from(presDoc.getElementsByTagNameNS('*', 'sldId'));
      for (const node of sldIds) {
        const rId =
          node.getAttribute('r:id') ||
          node.getAttributeNS(
            'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
            'id'
          ) ||
          '';
        const resolved = rId ? relMap.get(rId) : undefined;
        if (resolved && zip.file(resolved)) {
          orderedSlidePaths.push(resolved);
        }
      }
    } catch {
      // Fallback to numeric sorting below
    }
  }

  if (orderedSlidePaths.length === 0) {
    const slideEntries = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const numA = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
        const numB = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
        return numA - numB;
      });
    orderedSlidePaths.push(...slideEntries);
  }

  if (orderedSlidePaths.length === 0) {
    throw new Error('لم يتم العثور على شرائح داخل ملف الباوربوينت.');
  }

  const results: ParsedPptxSlide[] = [];
  for (let i = 0; i < Math.min(orderedSlidePaths.length, 35); i++) {
    const slidePath = orderedSlidePaths[i];
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const slideXml = await slideFile.async('string');
    const paragraphs = extractXmlParagraphs(slideXml);
    const title = paragraphs[0] || `الشريحة ${i + 1}`;
    const bodyParagraphs = paragraphs.slice(1);

    // Optional speaker notes lookup via slide rels
    let notesText = '';
    const slideBaseName = slidePath.split('/').pop() || '';
    const slideRelsPath = `ppt/slides/_rels/${slideBaseName}.rels`;
    const slideRelsFile = zip.file(slideRelsPath);
    if (slideRelsFile) {
      try {
        const relXml = await slideRelsFile.async('string');
        const parser = new DOMParser();
        const relDoc = parser.parseFromString(relXml, 'application/xml');
        for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
          const target = rel.getAttribute('Target') || '';
          if (target.includes('notesSlide')) {
            const notePath = resolveZipRelativePath('ppt/slides', target);
            const noteFile = zip.file(notePath);
            if (noteFile) {
              const nXml = await noteFile.async('string');
              const nLines = extractXmlParagraphs(nXml).filter((l) => !/^\d+$/.test(l));
              notesText = nLines.join(' ').trim();
            }
            break;
          }
        }
      } catch {
        // Optional notes are best-effort
      }
    }

    results.push({
      slideNumber: i + 1,
      title,
      paragraphs: bodyParagraphs,
      notes: notesText,
    });
  }

  return results;
}

export async function generateOrEditPresentationWithAi(params: {
  message: string;
  history: Array<{ role: 'user' | 'model'; text: string }>;
  presentationTitle: string;
  currentSlides: PresentationSlide[];
  targetSlideIndex?: number;
  importedPptxSlides?: ParsedPptxSlide[];
}): Promise<PresentationAiChatResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 65000);

  let resp: Response;
  try {
    resp = await fetch('/api/presentations/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(params),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('استغرق إنشاء الشرائح وقتاً طويلاً؛ حاول تبسيط الطلب أو تقسيمه.');
    }
    throw new Error('تعذّر الاتصال بخادم الذكاء الاصطناعي.');
  } finally {
    window.clearTimeout(timeoutId);
  }

  const data = (await resp.json().catch(() => null)) as
    | (PresentationAiChatResponse & { error?: string })
    | null;

  if (!resp.ok || !data || !Array.isArray(data.slides) || data.slides.length === 0) {
    throw new Error(data?.error || 'تعذّر توليد العرض التقديمي حالياً.');
  }

  return {
    ...data,
    slides: normalizeSlideList(data.slides),
  };
}
