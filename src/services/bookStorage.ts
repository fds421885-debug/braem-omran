import * as pdfjsLib from 'pdfjs-dist';
import type { BookTextSegment, NoorAlBayanStep } from '../types/platform';
import {
  analyzeBookPageInBrowser,
  generateNoorAlBayanClientFallback,
} from './clientArabicEngine';

function getPdfJsAssetBaseUrl(): string {
  const rawBase = import.meta.env.BASE_URL || '/';
  const normalizedBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  if (typeof window !== 'undefined' && window.location) {
    try {
      return new URL(`${normalizedBase}pdfjs/`, window.location.href).href;
    } catch {
      return `${normalizedBase}pdfjs/`;
    }
  }
  return `${normalizedBase}pdfjs/`;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = `${getPdfJsAssetBaseUrl()}pdf.worker.min.mjs`;

const DB_NAME = 'braem_omran_books_db';
const DB_VERSION = 1;
const STORE_JOBS = 'jobs';
const STORE_AUDIO = 'audioCache';
const MAX_PAGE_DATAURL_CHARS = 600000;

let staticHostWithoutApi: boolean | null = null;

export interface EmbeddedWordHint {
  text: string;
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface BookLocalPage {
  pageNumber: number;
  imageDataUrl: string;
  width: number;
  height: number;
  uploaded: boolean;
  recognized: boolean;
  fullText: string;
  segments: BookTextSegment[];
  embeddedSegments?: EmbeddedWordHint[];
}

export interface BookJobState {
  bookId: string;
  complexId: string;
  title: string;
  fileName: string;
  fileType: 'pdf' | 'image';
  totalPages: number;
  status: 'uploading' | 'processing' | 'paused' | 'ready' | 'error';
  lastError?: string;
  pages: BookLocalPage[];
  updatedAtMs: number;
}

export interface AudioCacheEntry {
  key: string;
  base64Wav: string;
  mimeType: string;
  steps?: NoorAlBayanStep[];
  fullReading?: string;
  updatedAtMs: number;
}

function openBooksDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_JOBS)) {
        db.createObjectStore(STORE_JOBS, { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('تعذّر فتح التخزين المحلي للكتب.'));
  });
}

export async function saveBookJobLocal(job: BookJobState): Promise<void> {
  try {
    const db = await openBooksDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).put(job);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal fallback when private browsing blocks IndexedDB
  }
}

export async function getBookJobLocal(bookId: string): Promise<BookJobState | null> {
  try {
    const db = await openBooksDb();
    const res = await new Promise<BookJobState | null>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).get(bookId);
      req.onsuccess = () => resolve((req.result as BookJobState | undefined) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return res;
  } catch {
    return null;
  }
}

export async function listBookJobsForComplexLocal(complexId: string): Promise<BookJobState[]> {
  try {
    const db = await openBooksDb();
    const all = await new Promise<BookJobState[]>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).getAll();
      req.onsuccess = () => resolve((req.result as BookJobState[]) || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all
      .filter((j) => j.complexId === complexId)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  } catch {
    return [];
  }
}

export async function deleteBookJobLocal(bookId: string): Promise<void> {
  try {
    const db = await openBooksDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).delete(bookId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal
  }
}

export async function getCachedAudioEntry(key: string): Promise<AudioCacheEntry | null> {
  try {
    const db = await openBooksDb();
    const res = await new Promise<AudioCacheEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO, 'readonly');
      const req = tx.objectStore(STORE_AUDIO).get(key);
      req.onsuccess = () => resolve((req.result as AudioCacheEntry | undefined) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return res;
  } catch {
    return null;
  }
}

export async function saveCachedAudioEntry(entry: AudioCacheEntry): Promise<void> {
  try {
    const db = await openBooksDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO, 'readwrite');
      tx.objectStore(STORE_AUDIO).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal
  }
}

function encodeCanvasWithinBudget(canvas: HTMLCanvasElement): string {
  const qualities = [0.84, 0.72, 0.58, 0.45, 0.36];
  let current = canvas;

  for (let pass = 0; pass < 4; pass++) {
    for (const q of qualities) {
      const dataUrl = current.toDataURL('image/jpeg', q);
      if (dataUrl.length <= MAX_PAGE_DATAURL_CHARS) {
        return dataUrl;
      }
    }
    const scaled = document.createElement('canvas');
    scaled.width = Math.max(300, Math.round(current.width * 0.76));
    scaled.height = Math.max(300, Math.round(current.height * 0.76));
    const ctx = scaled.getContext('2d');
    if (!ctx) break;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, scaled.width, scaled.height);
    ctx.drawImage(current, 0, 0, scaled.width, scaled.height);
    current = scaled;
  }

  return current.toDataURL('image/jpeg', 0.32);
}

async function detectIsPdfFile(file: File): Promise<boolean> {
  const nameLower = file.name.toLowerCase();
  if (
    file.type === 'application/pdf' ||
    file.type === 'application/x-pdf' ||
    nameLower.endsWith('.pdf')
  ) {
    return true;
  }
  try {
    const headerSlice = await file.slice(0, 8).text();
    return headerSlice.startsWith('%PDF-');
  } catch {
    return false;
  }
}

async function openPdfDocumentRobust(buffer: ArrayBuffer) {
  const pdfBase = getPdfJsAssetBaseUrl();
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${pdfBase}pdf.worker.min.mjs`;

  const commonOptions = {
    data: new Uint8Array(buffer),
    cMapUrl: `${pdfBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfBase}standard_fonts/`,
    wasmUrl: `${pdfBase}wasm/`,
    iccUrl: `${pdfBase}iccs/`,
    useSystemFonts: true,
    isEvalSupported: false,
  };

  try {
    return await pdfjsLib.getDocument(commonOptions).promise;
  } catch {
    // Fallback retry with worker fetch disabled in case of strict static CORS/CDN setup
    return await pdfjsLib.getDocument({
      ...commonOptions,
      useWorkerFetch: false,
    }).promise;
  }
}

export async function extractBookFilePages(
  file: File,
  onProgress: (done: number, total: number) => void
): Promise<{
  fileType: 'pdf' | 'image';
  pages: BookLocalPage[];
}> {
  const isPdf = await detectIsPdfFile(file);

  if (!isPdf) {
    onProgress(0, 1);
    const imgUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('تعذّر قراءة ملف الصورة المحدد.'));
        el.src = imgUrl;
      });

      const maxWidth = 1280;
      const ratio = img.width > maxWidth ? maxWidth / img.width : 1;
      const width = Math.max(100, Math.round(img.width * ratio));
      const height = Math.max(100, Math.round(img.height * ratio));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('تعذّر تهيئة رسم الصفحة.');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      const imageDataUrl = encodeCanvasWithinBudget(canvas);
      onProgress(1, 1);

      return {
        fileType: 'image',
        pages: [
          {
            pageNumber: 1,
            imageDataUrl,
            width,
            height,
            uploaded: false,
            recognized: false,
            fullText: '',
            segments: [],
          },
        ],
      };
    } finally {
      URL.revokeObjectURL(imgUrl);
    }
  }

  const buffer = await file.arrayBuffer();
  const pdf = await openPdfDocumentRobust(buffer);

  try {
    const totalPages = Math.min(pdf.numPages, 2000);
    if (totalPages < 1) {
      throw new Error('ملف PDF فارغ ولا يحتوي على صفحات.');
    }

    const pages: BookLocalPage[] = [];
    onProgress(0, totalPages);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        // Scale cleanly for both low-res PDFs AND huge scanned image PDFs (e.g., 3000px wide scans)
        const widthRatio = 1220 / Math.max(1, baseViewport.width);
        const heightRatio = 1750 / Math.max(1, baseViewport.height);
        const targetScale = Math.min(2.2, Math.max(0.2, Math.min(widthRatio, heightRatio)));
        const viewport = page.getViewport({ scale: targetScale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(120, Math.round(viewport.width));
        canvas.height = Math.max(120, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('تعذّر تهيئة معالجة صفحة الكتاب.');

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        }).promise;

        // Also inspect embedded text layer softly (optional hint for text/hybrid PDFs)
        let embeddedSegments: EmbeddedWordHint[] = [];
        try {
          const textContent = await page.getTextContent();
          const hints: EmbeddedWordHint[] = [];
          for (const item of textContent.items) {
            if (!('str' in item)) continue;
            const rawStr = String(item.str || '').trim();
            if (!rawStr) continue;

            const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const itemLeftPx = tx[4];
            const itemBaselinePx = tx[5];
            const itemFontH = Math.max(10, Math.hypot(tx[2], tx[3]) || item.height * targetScale || 14);
            const itemWidthPx = Math.max(12, (item.width || rawStr.length * 6) * targetScale);

            const words = rawStr.split(/\s+/).filter(Boolean);
            const wordSliceW = itemWidthPx / Math.max(1, words.length);

            words.forEach((word, wIdx) => {
              if (hints.length >= 420) return;
              // RTL word progression from right edge to left
              const wx1 = itemLeftPx + itemWidthPx - wIdx * wordSliceW;
              const wx0 = Math.max(0, wx1 - wordSliceW);
              const wy0 = Math.max(0, itemBaselinePx - itemFontH);
              const wy1 = Math.min(canvas.height, itemBaselinePx + itemFontH * 0.25);

              const ymin = Math.max(0, Math.min(990, Math.round((wy0 / canvas.height) * 1000)));
              const xmin = Math.max(0, Math.min(990, Math.round((wx0 / canvas.width) * 1000)));
              const ymax = Math.max(ymin + 8, Math.min(1000, Math.round((wy1 / canvas.height) * 1000)));
              const xmax = Math.max(xmin + 8, Math.min(1000, Math.round((wx1 / canvas.width) * 1000)));

              hints.push({ text: word, ymin, xmin, ymax, xmax });
            });
          }
          embeddedSegments = hints;
        } catch {
          // Image-only scanned PDF — no embedded text layer, which is handled cleanly by OCR
        }

        const imageDataUrl = encodeCanvasWithinBudget(canvas);
        pages.push({
          pageNumber: pageNum,
          imageDataUrl,
          width: canvas.width,
          height: canvas.height,
          uploaded: false,
          recognized: false,
          fullText: '',
          segments: [],
          ...(embeddedSegments.length > 0 ? { embeddedSegments } : {}),
        });

        onProgress(pageNum, totalPages);
      } finally {
        page.cleanup();
      }

      // Yield briefly to keep UI responsive during heavy multi-page PDF decoding
      await new Promise((r) => setTimeout(r, 0));
    }

    return {
      fileType: 'pdf',
      pages,
    };
  } finally {
    await pdf.cleanup().catch(() => {});
    const maybeDestroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy;
    if (typeof maybeDestroy === 'function') {
      await maybeDestroy.call(pdf).catch(() => {});
    }
  }
}

function isStaticMissingApi(res: Response): boolean {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (res.status === 404 || res.status === 405 || res.status === 501) return true;
  if (!ct.includes('application/json')) return true;
  return false;
}

export async function analyzeBookPageOnServer(params: {
  imageDataUrl: string;
  pageNumber: number;
  bookTitle?: string;
  embeddedSegments?: EmbeddedWordHint[];
}): Promise<{
  fullText: string;
  segments: BookTextSegment[];
}> {
  if (staticHostWithoutApi !== true) {
    try {
      const res = await fetch('/api/books/analyze-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: params.imageDataUrl,
          pageNumber: params.pageNumber,
          bookTitle: params.bookTitle,
        }),
      });

      if (!isStaticMissingApi(res)) {
        const data = (await res.json().catch(() => ({}))) as {
          fullText?: string;
          segments?: BookTextSegment[];
          error?: string;
        };
        if (res.ok) {
          staticHostWithoutApi = false;
          const serverSegments = Array.isArray(data.segments) ? data.segments : [];
          if (serverSegments.length > 0 || (data.fullText || '').trim().length > 0) {
            return {
              fullText: String(data.fullText || '').trim(),
              segments: serverSegments,
            };
          }
        } else if (res.status !== 404 && res.status !== 405 && res.status !== 501) {
          // If server returned a transient/upstream failure on a PDF scan, fall through to in-browser OCR below!
        }
      } else {
        staticHostWithoutApi = true;
      }
    } catch {
      // Static host or offline API — use pure browser Arabic OCR below
    }
  }

  return analyzeBookPageInBrowser({
    imageDataUrl: params.imageDataUrl,
    pageNumber: params.pageNumber,
    embeddedSegments: params.embeddedSegments,
  });
}

export async function generateNoorAlBayanOnServer(params: {
  text: string;
  surahName?: string;
}): Promise<{
  diacritizedWord: string;
  steps: NoorAlBayanStep[];
  fullReading: string;
}> {
  if (staticHostWithoutApi !== true) {
    try {
      const res = await fetch('/api/books/noor-albayan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!isStaticMissingApi(res)) {
        const data = (await res.json().catch(() => ({}))) as {
          diacritizedWord?: string;
          steps?: NoorAlBayanStep[];
          fullReading?: string;
          error?: string;
        };
        if (res.ok) {
          staticHostWithoutApi = false;
          return {
            diacritizedWord: String(data.diacritizedWord || params.text),
            steps: Array.isArray(data.steps) ? data.steps : [],
            fullReading: String(data.fullReading || params.text),
          };
        }
      } else {
        staticHostWithoutApi = true;
      }
    } catch {
      // Fall back to deterministic in-browser Noor Al-Bayan engine
    }
  }

  return generateNoorAlBayanClientFallback(params.text);
}

export async function synthesizeSpeechOnServer(params: {
  text: string;
  mode: 'noor_albayan' | 'normal';
}): Promise<{
  engine: 'server_wav' | 'browser_speech';
  audioBase64: string;
  mimeType: string;
  text: string;
}> {
  if (staticHostWithoutApi !== true) {
    try {
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!isStaticMissingApi(res)) {
        const data = (await res.json().catch(() => ({}))) as {
          audioBase64?: string;
          mimeType?: string;
          error?: string;
        };
        if (res.ok && data.audioBase64) {
          staticHostWithoutApi = false;
          return {
            engine: 'server_wav',
            audioBase64: data.audioBase64,
            mimeType: data.mimeType || 'audio/wav',
            text: params.text,
          };
        }
      } else {
        staticHostWithoutApi = true;
      }
    } catch {
      // Static host without server — use browser SpeechSynthesis
    }
  }

  return {
    engine: 'browser_speech',
    audioBase64: '',
    mimeType: 'text/speech',
    text: params.text,
  };
}

export function base64AudioToObjectUrl(base64Data: string, mimeType = 'audio/wav'): string {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}
