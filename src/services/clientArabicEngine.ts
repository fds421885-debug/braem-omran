import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { BookTextSegment, NoorAlBayanStep } from '../types/platform';

interface CompactAyahEntry {
  surahNumber: number;
  ayahNumber: number;
  surahName: string;
  diacritizedWords: string[];
  plainWords: string[];
}

interface QuranIndexData {
  ayahs: CompactAyahEntry[];
  trigIndex: Map<string, number[]>;
}

const QURAN_CACHE_DB = 'braem_omran_quran_cache_v1';
const QURAN_CACHE_STORE = 'quranData';
const QURAN_CACHE_KEY = 'full_quran_uthmani_v1';

let ocrWorkerPromise: Promise<Worker> | null = null;
let quranIndexPromise: Promise<QuranIndexData | null> | null = null;

export function stripArabicDiacriticsForMatch(input: string): string {
  return input
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\u0621-\u064A0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getArabicLetterName(ch: string): string {
  const names: Record<string, string> = {
    ا: 'أَلِفْ',
    أ: 'أَلِفْ هَمْزَة',
    إ: 'أَلِفْ هَمْزَة',
    آ: 'أَلِفْ مَدّ',
    ٱ: 'أَلِفْ وَصْل',
    ب: 'بَاءْ',
    ت: 'تَاءْ',
    ث: 'ثَاءْ',
    ج: 'جِيمْ',
    ح: 'حَاءْ',
    خ: 'خَاءْ',
    د: 'دَالْ',
    ذ: 'ذَالْ',
    ر: 'رَاءْ',
    ز: 'زَايْ',
    س: 'سِينْ',
    ش: 'شِينْ',
    ص: 'صَادْ',
    ض: 'ضَادْ',
    ط: 'طَاءْ',
    ظ: 'ظَاءْ',
    ع: 'عَيْنْ',
    غ: 'غَيْنْ',
    ف: 'فَاءْ',
    ق: 'قَافْ',
    ك: 'كَافْ',
    ل: 'لَامْ',
    م: 'مِيمْ',
    ن: 'نُونْ',
    ه: 'هَاءْ',
    ة: 'تَاءْ مَرْبُوطَة',
    و: 'وَاوْ',
    ي: 'يَاءْ',
    ى: 'أَلِفْ مَقْصُورَة',
    ء: 'هَمْزَة',
    ؤ: 'هَمْزَة عَلَى وَاو',
    ئ: 'هَمْزَة عَلَى نَبِرَة',
  };
  return names[ch] || ch;
}

const FATHA = '\u064E';
const DAMMA = '\u064F';
const KASRA = '\u0650';
const FATHATAN = '\u064B';
const DAMMATAN = '\u064C';
const KASRATAN = '\u064D';
const SHADDA = '\u0651';
const SUKOON = '\u0652';
const DAGGER_ALIF = '\u0670';

function isCombiningMark(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x06d6 && code <= 0x06ed)
  );
}

interface ParsedUnit {
  letter: string;
  marks: string;
  hasFatha: boolean;
  hasDamma: boolean;
  hasKasra: boolean;
  hasFathatan: boolean;
  hasDammatan: boolean;
  hasKasratan: boolean;
  hasShadda: boolean;
  hasSukoon: boolean;
  hasDaggerAlif: boolean;
}

function parseArabicWordUnits(word: string): ParsedUnit[] {
  const chars = Array.from(word.trim());
  const units: ParsedUnit[] = [];

  for (const ch of chars) {
    if (ch === '\u0640') continue; // Tatweel
    if (isCombiningMark(ch)) {
      const prev = units[units.length - 1];
      if (prev) {
        prev.marks += ch;
        if (ch === FATHA) prev.hasFatha = true;
        if (ch === DAMMA) prev.hasDamma = true;
        if (ch === KASRA) prev.hasKasra = true;
        if (ch === FATHATAN) prev.hasFathatan = true;
        if (ch === DAMMATAN) prev.hasDammatan = true;
        if (ch === KASRATAN) prev.hasKasratan = true;
        if (ch === SHADDA) prev.hasShadda = true;
        if (ch === SUKOON) prev.hasSukoon = true;
        if (ch === DAGGER_ALIF) prev.hasDaggerAlif = true;
      }
      continue;
    }

    if (/[\u0621-\u064A]/.test(ch)) {
      units.push({
        letter: ch,
        marks: '',
        hasFatha: false,
        hasDamma: false,
        hasKasra: false,
        hasFathatan: false,
        hasDammatan: false,
        hasKasratan: false,
        hasShadda: false,
        hasSukoon: false,
        hasDaggerAlif: false,
      });
    }
  }

  return units;
}

function describeUnitRule(unit: ParsedUnit): {
  ruleLabel: string;
  spokenRule: string;
} {
  if (unit.hasShadda) {
    if (unit.hasFathatan) {
      return {
        ruleLabel: 'شدة وتنوين بالفتح',
        spokenRule: 'شَدَّةٌ وَتَنْوِينٌ بِالْفَتْحِ',
      };
    }
    if (unit.hasDammatan) {
      return {
        ruleLabel: 'شدة وتنوين بالضم',
        spokenRule: 'شَدَّةٌ وَتَنْوِينٌ بِالضَّمِّ',
      };
    }
    if (unit.hasKasratan) {
      return {
        ruleLabel: 'شدة وتنوين بالكسر',
        spokenRule: 'شَدَّةٌ وَتَنْوِينٌ بِالْكَسْرِ',
      };
    }
    if (unit.hasFatha) {
      return { ruleLabel: 'شدة وفتحة', spokenRule: 'شَدَّةٌ وَفَتْحَة' };
    }
    if (unit.hasDamma) {
      return { ruleLabel: 'شدة وضمة', spokenRule: 'شَدَّةٌ وَضَمَّة' };
    }
    if (unit.hasKasra) {
      return { ruleLabel: 'شدة وكسرة', spokenRule: 'شَدَّةٌ وَكَسْرَة' };
    }
    return { ruleLabel: 'شدة', spokenRule: 'شَدَّةٌ' };
  }

  if (unit.hasFathatan) {
    return { ruleLabel: 'تنوين بالفتح', spokenRule: 'تَنْوِينٌ بِالْفَتْحِ' };
  }
  if (unit.hasDammatan) {
    return { ruleLabel: 'تنوين بالضم', spokenRule: 'تَنْوِينٌ بِالضَّمِّ' };
  }
  if (unit.hasKasratan) {
    return { ruleLabel: 'تنوين بالكسر', spokenRule: 'تَنْوِينٌ بِالْكَسْرِ' };
  }
  if (unit.hasSukoon) {
    return { ruleLabel: 'سكون', spokenRule: 'سُكُونْ' };
  }
  if (unit.hasFatha) {
    return { ruleLabel: 'فتحة', spokenRule: 'فَتْحَة' };
  }
  if (unit.hasDamma) {
    return { ruleLabel: 'ضمة', spokenRule: 'ضَمَّة' };
  }
  if (unit.hasKasra) {
    return { ruleLabel: 'كسرة', spokenRule: 'كَسْرَة' };
  }
  return { ruleLabel: 'حرف', spokenRule: 'حَرْفٌ' };
}

/**
 * Generates authentic Noor Al-Bayan spelling breakdown purely in the browser
 * so static hosting (GitHub Pages / Netlify / etc.) works 100% without a backend.
 */
export function generateNoorAlBayanClientFallback(text: string): {
  diacritizedWord: string;
  steps: NoorAlBayanStep[];
  fullReading: string;
} {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  const steps: NoorAlBayanStep[] = [];
  const spokenParts: string[] = [];

  for (const word of words) {
    const units = parseArabicWordUnits(word);
    if (units.length === 0) continue;

    let cumulative = '';

    for (let i = 0; i < units.length; i++) {
      const curr = units[i];
      const prev = i > 0 ? units[i - 1] : null;
      const next = i + 1 < units.length ? units[i + 1] : null;

      // Detect natural Madd letters (Alif after Fatha, Waw after Damma, Ya after Kasra)
      const isAlifMadd =
        (curr.letter === 'ا' || curr.letter === 'ى') &&
        !curr.marks &&
        prev &&
        (prev.hasFatha || prev.hasFathatan);
      const isWawMadd =
        curr.letter === 'و' && !curr.marks && prev && prev.hasDamma;
      const isYaMadd =
        (curr.letter === 'ي' || curr.letter === 'ى') &&
        !curr.marks &&
        prev &&
        prev.hasKasra;

      if (isAlifMadd || isWawMadd || isYaMadd) {
        const maddLabel = isAlifMadd
          ? 'أَلِفٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ'
          : isWawMadd
          ? 'وَاوٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ'
          : 'يَاءٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ';
        const maddRule = isAlifMadd
          ? 'مد بالألف حركتان'
          : isWawMadd
          ? 'مد بالواو حركتان'
          : 'مد بالياء حركتان';
        cumulative += curr.letter;
        steps.push({
          part: curr.letter,
          ruleLabel: maddRule,
          reading: cumulative,
        });
        spokenParts.push(`${maddLabel}: ${cumulative}`);
        continue;
      }

      // Silent Alif Lam (Shamsiya / Qamariya) detection at start of word
      if (
        i === 0 &&
        curr.letter === 'ا' &&
        !curr.marks &&
        next &&
        next.letter === 'ل'
      ) {
        cumulative += curr.letter;
        steps.push({
          part: 'ا',
          ruleLabel: 'همزة وصل تسقط وصلاً وتُقرأ أَ',
          reading: 'أَ',
        });
        spokenParts.push('هَمْزَةُ وَصْلٍ: أَ');
        continue;
      }

      const unitGlyph = `${curr.letter}${curr.marks}`;
      cumulative += unitGlyph;

      if (curr.hasDaggerAlif) {
        const letterName = getArabicLetterName(curr.letter);
        steps.push({
          part: unitGlyph,
          ruleLabel: 'فتحة وألف صغيرة مد طبيعي حركتان',
          reading: cumulative,
        });
        spokenParts.push(
          `${letterName} فَتْحَة وَأَلِفٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ: ${cumulative}`
        );
        continue;
      }

      const { ruleLabel, spokenRule } = describeUnitRule(curr);
      const letterName = getArabicLetterName(curr.letter);
      const syllable =
        curr.hasSukoon && prev
          ? `${prev.letter}${prev.marks}${unitGlyph}`
          : unitGlyph;

      steps.push({
        part: unitGlyph,
        ruleLabel,
        reading: cumulative,
      });

      if (curr.hasSukoon) {
        spokenParts.push(`${letterName} ${spokenRule}: ${syllable}، ${cumulative}`);
      } else {
        spokenParts.push(`${letterName} ${spokenRule}: ${syllable}`);
        if (i > 0) {
          spokenParts.push(cumulative);
        }
      }
    }

    spokenParts.push(word);
  }

  return {
    diacritizedWord: text,
    steps,
    fullReading:
      spokenParts.length > 0 ? `${spokenParts.join('، ')}.` : text,
  };
}

function openQuranCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QURAN_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QURAN_CACHE_STORE)) {
        db.createObjectStore(QURAN_CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadCachedQuranRaw(): Promise<CompactAyahEntry[] | null> {
  try {
    const db = await openQuranCacheDb();
    const res = await new Promise<{ key: string; ayahs: CompactAyahEntry[] } | null>(
      (resolve, reject) => {
        const tx = db.transaction(QURAN_CACHE_STORE, 'readonly');
        const req = tx.objectStore(QURAN_CACHE_STORE).get(QURAN_CACHE_KEY);
        req.onsuccess = () =>
          resolve(
            (req.result as { key: string; ayahs: CompactAyahEntry[] } | undefined) ||
              null
          );
        req.onerror = () => reject(req.error);
      }
    );
    db.close();
    return res?.ayahs || null;
  } catch {
    return null;
  }
}

async function saveCachedQuranRaw(ayahs: CompactAyahEntry[]): Promise<void> {
  try {
    const db = await openQuranCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QURAN_CACHE_STORE, 'readwrite');
      tx.objectStore(QURAN_CACHE_STORE).put({
        key: QURAN_CACHE_KEY,
        ayahs,
        savedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage quota errors
  }
}

function buildQuranIndex(ayahs: CompactAyahEntry[]): QuranIndexData {
  const trigIndex = new Map<string, number[]>();
  for (let i = 0; i < ayahs.length; i++) {
    const words = ayahs[i].plainWords;
    for (let w = 0; w <= words.length - 3; w++) {
      const key = `${words[w]} ${words[w + 1]} ${words[w + 2]}`;
      const list = trigIndex.get(key);
      if (list) {
        if (list.length < 15) list.push(i);
      } else {
        trigIndex.set(key, [i]);
      }
    }
  }
  return { ayahs, trigIndex };
}

async function getQuranIndex(): Promise<QuranIndexData | null> {
  if (quranIndexPromise) return quranIndexPromise;

  quranIndexPromise = (async () => {
    const cached = await loadCachedQuranRaw();
    if (cached && cached.length > 6000) {
      return buildQuranIndex(cached);
    }

    // Fetch complete Uthmani / Simple Quran JSON from reliable public CDNs
    try {
      const res = await fetch('https://api.alquran.cloud/v1/quran/quran-simple');
      if (res.ok) {
        const json = (await res.json()) as {
          data?: {
            surahs?: Array<{
              number: number;
              name: string;
              ayahs: Array<{ numberInSurah: number; text: string }>;
            }>;
          };
        };
        const surahs = json.data?.surahs || [];
        if (surahs.length >= 114) {
          const ayahs: CompactAyahEntry[] = [];
          for (const surah of surahs) {
            const cleanSurahName = surah.name.replace(/^سُورَةُ\s+|^سورة\s+/u, '').trim();
            for (const ay of surah.ayahs) {
              const diacWords = ay.text
                .trim()
                .split(/\s+/)
                .filter(Boolean);
              const plainWords = diacWords
                .map((w) => stripArabicDiacriticsForMatch(w))
                .filter(Boolean);
              if (plainWords.length > 0) {
                ayahs.push({
                  surahNumber: surah.number,
                  ayahNumber: ay.numberInSurah,
                  surahName: cleanSurahName,
                  diacritizedWords: diacWords,
                  plainWords,
                });
              }
            }
          }
          await saveCachedQuranRaw(ayahs);
          return buildQuranIndex(ayahs);
        }
      }
    } catch {
      // Try second public CDN below
    }

    try {
      const res = await fetch(
        'https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist/quran.json'
      );
      if (res.ok) {
        const surahs = (await res.json()) as Array<{
          id: number;
          name: string;
          verses: Array<{ id: number; text: string }>;
        }>;
        if (Array.isArray(surahs) && surahs.length >= 114) {
          const ayahs: CompactAyahEntry[] = [];
          for (const surah of surahs) {
            for (const ay of surah.verses || []) {
              const diacWords = ay.text
                .trim()
                .split(/\s+/)
                .filter(Boolean);
              const plainWords = diacWords
                .map((w) => stripArabicDiacriticsForMatch(w))
                .filter(Boolean);
              if (plainWords.length > 0) {
                ayahs.push({
                  surahNumber: surah.id,
                  ayahNumber: ay.id,
                  surahName: surah.name,
                  diacritizedWords: diacWords,
                  plainWords,
                });
              }
            }
          }
          await saveCachedQuranRaw(ayahs);
          return buildQuranIndex(ayahs);
        }
      }
    } catch {
      // Offline / blocked CDN — gracefully skip Ayah tagging
    }

    return null;
  })();

  return quranIndexPromise;
}

function enrichSegmentsWithQuranMatch(
  segments: BookTextSegment[],
  index: QuranIndexData | null
): BookTextSegment[] {
  if (!index || segments.length < 3) return segments;

  const plainList = segments.map((s) => stripArabicDiacriticsForMatch(s.text));
  const updated = segments.map((s) => ({ ...s }));

  for (let i = 0; i <= plainList.length - 3; i++) {
    const w1 = plainList[i];
    const w2 = plainList[i + 1];
    const w3 = plainList[i + 2];
    if (!w1 || !w2 || !w3) continue;

    const trigKey = `${w1} ${w2} ${w3}`;
    const candidateAyahIndices = index.trigIndex.get(trigKey);
    if (!candidateAyahIndices || candidateAyahIndices.length === 0) continue;

    for (const ayIdx of candidateAyahIndices) {
      const ayah = index.ayahs[ayIdx];
      // Find where trigKey occurs in ayah.plainWords
      const startPos = ayah.plainWords.findIndex(
        (_, pos) =>
          pos <= ayah.plainWords.length - 3 &&
          ayah.plainWords[pos] === w1 &&
          ayah.plainWords[pos + 1] === w2 &&
          ayah.plainWords[pos + 2] === w3
      );
      if (startPos < 0) continue;

      // Expand forward while OCR words match Ayah words
      let matchLen = 3;
      while (
        i + matchLen < plainList.length &&
        startPos + matchLen < ayah.plainWords.length &&
        plainList[i + matchLen] === ayah.plainWords[startPos + matchLen]
      ) {
        matchLen++;
      }

      for (let k = 0; k < matchLen; k++) {
        const segIdx = i + k;
        const diacWord = ayah.diacritizedWords[startPos + k];
        updated[segIdx] = {
          ...updated[segIdx],
          text: diacWord || updated[segIdx].text,
          plainText: ayah.plainWords[startPos + k] || updated[segIdx].plainText,
          kind: 'ayah',
          surahNumber: ayah.surahNumber,
          ayahNumber: ayah.ayahNumber,
          surahName: ayah.surahName,
        };
      }
      i += matchLen - 1;
      break;
    }
  }

  return updated;
}

async function getArabicOcrWorker(): Promise<Worker> {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const worker = await createWorker('ara', 1);
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
    });
    return worker;
  })().catch((err) => {
    ocrWorkerPromise = null;
    throw err;
  });
  return ocrWorkerPromise;
}

async function buildPreprocessedOcrCanvas(
  imageDataUrl: string
): Promise<{ canvas: HTMLCanvasElement; origWidth: number; origHeight: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('تعذّر تحميل صورة الصفحة للتعرف النصي.'));
    el.src = imageDataUrl;
  });

  const origWidth = Math.max(1, img.width);
  const origHeight = Math.max(1, img.height);
  // Slight upscale helps Arabic diacritic/ligature OCR accuracy in Tesseract
  const scale = origWidth < 1200 ? 1.5 : 1.0;
  const w = Math.round(origWidth * scale);
  const h = Math.round(origHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { canvas, origWidth, origHeight };
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Enhance contrast & convert subtle warm scan backgrounds to crisp black-on-white
  try {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Boost whites & darken ink smoothly without harsh aliasing
      const stretched = lum > 205 ? 255 : lum < 65 ? 0 : Math.min(255, Math.max(0, (lum - 65) * 1.82));
      d[i] = stretched;
      d[i + 1] = stretched;
      d[i + 2] = stretched;
    }
    ctx.putImageData(imgData, 0, 0);
  } catch {
    // Non-fatal: keep original rendered canvas if pixel read is restricted
  }

  return { canvas, origWidth, origHeight };
}

/**
 * Full 100% browser-based Arabic OCR + Ayah matching engine.
 * Runs cleanly on static hosts (GitHub Pages / Netlify / Cloudflare Pages) without a server.
 */
export async function analyzeBookPageInBrowser(params: {
  imageDataUrl: string;
  pageNumber: number;
  embeddedSegments?: Array<{
    text: string;
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
  }>;
}): Promise<{
  fullText: string;
  segments: BookTextSegment[];
}> {
  const [{ canvas }, quranIndex] = await Promise.all([
    buildPreprocessedOcrCanvas(params.imageDataUrl),
    getQuranIndex().catch(() => null),
  ]);

  let rawSegments: BookTextSegment[] = [];
  let ocrText = '';

  try {
    const worker = await getArabicOcrWorker();
    const res = await worker.recognize(canvas, {}, { text: true, blocks: true });
    ocrText = (res.data.text || '').trim();

    const blocks = res.data.blocks || [];
    const cw = Math.max(1, canvas.width);
    const ch = Math.max(1, canvas.height);

    let wordCounter = 0;
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            const cleanText = (word.text || '').trim();
            if (!cleanText) continue;
            // Skip stray punctuation/noise under 2 non-symbol chars unless Arabic/number
            const plain = stripArabicDiacriticsForMatch(cleanText);
            if (!plain && cleanText.length < 2) continue;

            wordCounter++;
            if (rawSegments.length >= 420) break;

            const ymin = Math.max(0, Math.min(990, Math.round((word.bbox.y0 / ch) * 1000)));
            const xmin = Math.max(0, Math.min(990, Math.round((word.bbox.x0 / cw) * 1000)));
            const ymax = Math.max(ymin + 8, Math.min(1000, Math.round((word.bbox.y1 / ch) * 1000)));
            const xmax = Math.max(xmin + 8, Math.min(1000, Math.round((word.bbox.x1 / cw) * 1000)));

            rawSegments.push({
              id: `p${params.pageNumber}_w${wordCounter}`,
              text: cleanText.slice(0, 120),
              plainText: plain || cleanText.slice(0, 120),
              kind: 'word',
              box: [ymin, xmin, ymax, xmax],
            });
          }
        }
      }
    }
  } catch (err) {
    // Fallback to PDF embedded text layer if available
    if (!params.embeddedSegments || params.embeddedSegments.length === 0) {
      throw err instanceof Error
        ? err
        : new Error('تعذّر التعرف على نص الصفحة في المتصفح.');
    }
  }

  // If scanned OCR returned very few tokens while the PDF has an embedded Unicode layer, prefer/merge embedded layer
  if (
    params.embeddedSegments &&
    params.embeddedSegments.length > rawSegments.length + 4
  ) {
    rawSegments = params.embeddedSegments.slice(0, 420).map((seg, idx) => ({
      id: `p${params.pageNumber}_w${idx + 1}`,
      text: seg.text.slice(0, 120),
      plainText: stripArabicDiacriticsForMatch(seg.text) || seg.text.slice(0, 120),
      kind: 'word',
      box: [seg.ymin, seg.xmin, seg.ymax, seg.xmax],
    }));
  }

  const enrichedSegments = enrichSegmentsWithQuranMatch(rawSegments, quranIndex);
  const fullText =
    enrichedSegments.length > 0
      ? enrichedSegments.map((s) => s.text).join(' ').slice(0, 18000)
      : ocrText.slice(0, 18000);

  return {
    fullText,
    segments: enrichedSegments,
  };
}
