import { QURAN_RECITERS, type QuranRangeRef } from '../types/platform';

export interface MushafSurahMeta {
  n: number;
  name: string;
  count: number;
  startPage: number;
  endPage: number;
  rev: string;
}

export interface MushafWordToken {
  s: number; // Surah number 1..114
  a: number; // Ayah number
  t: string; // Uthmani token text or end-of-ayah Arabic numeral
  e?: 1;     // 1 if end-of-ayah ornament token
}

export interface MushafPageHeader {
  s: number;
  bannerLine: number;
  bismillahLine: number | null;
}

export interface MushafPageData {
  p: number; // Page number 1..604
  j: number; // Juz 1..30
  h: number; // Hizb 1..60
  r: number; // Rub al-hizb
  headers: MushafPageHeader[];
  sajdahs: { s: number; a: number }[];
  lines: Record<string, MushafWordToken[]>;
}

const TEACHER_RECITER_STORAGE_KEY = 'braem_teacher_reciter_id';
export const DEFAULT_TEACHER_RECITER_ID = 'minshawy';

let surahsCache: MushafSurahMeta[] | null = null;
let surahsPromise: Promise<MushafSurahMeta[]> | null = null;

let ayahPagesCache: Record<string, number[]> | null = null;
let ayahPagesPromise: Promise<Record<string, number[]>> | null = null;

const chunkCache = new Map<number, MushafPageData[]>();
const chunkPromises = new Map<number, Promise<MushafPageData[]>>();

function getBasePrefix(): string {
  const raw = import.meta.env.BASE_URL || '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function getChunkIndexForPage(pageNumber: number): number {
  const clamped = Math.max(1, Math.min(604, Math.floor(pageNumber)));
  return Math.ceil(clamped / 100);
}

export async function getSurahsList(): Promise<MushafSurahMeta[]> {
  if (surahsCache) return surahsCache;
  if (!surahsPromise) {
    surahsPromise = fetch(`${getBasePrefix()}mushaf/surahs.json`)
      .then((res) => {
        if (!res.ok) throw new Error('تعذّر تحميل فهرس سور المصحف الشريف.');
        return res.json() as Promise<MushafSurahMeta[]>;
      })
      .then((data) => {
        surahsCache = data;
        return data;
      })
      .catch((err) => {
        surahsPromise = null;
        throw err;
      });
  }
  return surahsPromise;
}

export async function getAyahPagesMap(): Promise<Record<string, number[]>> {
  if (ayahPagesCache) return ayahPagesCache;
  if (!ayahPagesPromise) {
    ayahPagesPromise = fetch(`${getBasePrefix()}mushaf/ayah_pages.json`)
      .then((res) => {
        if (!res.ok) throw new Error('تعذّر تحميل خريطة صفحات الآيات.');
        return res.json() as Promise<Record<string, number[]>>;
      })
      .then((data) => {
        ayahPagesCache = data;
        return data;
      })
      .catch((err) => {
        ayahPagesPromise = null;
        throw err;
      });
  }
  return ayahPagesPromise;
}

export async function getMushafChunk(chunkIndex: number): Promise<MushafPageData[]> {
  const idx = Math.max(1, Math.min(7, Math.floor(chunkIndex)));
  const cached = chunkCache.get(idx);
  if (cached) return cached;

  const existingPromise = chunkPromises.get(idx);
  if (existingPromise) return existingPromise;

  const p = fetch(`${getBasePrefix()}mushaf/chunk_${idx}.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`تعذّر تحميل صفحات المصحف (الجزء ${idx}).`);
      return res.json() as Promise<MushafPageData[]>;
    })
    .then((pages) => {
      chunkCache.set(idx, pages);
      return pages;
    })
    .catch((err) => {
      chunkPromises.delete(idx);
      throw err;
    });

  chunkPromises.set(idx, p);
  return p;
}

export async function getMushafPage(pageNumber: number): Promise<MushafPageData> {
  const clamped = Math.max(1, Math.min(604, Math.floor(pageNumber)));
  const chunkIdx = getChunkIndexForPage(clamped);
  const pages = await getMushafChunk(chunkIdx);
  const found = pages.find((pg) => pg.p === clamped);
  if (!found) {
    throw new Error(`الصفحة رقم ${clamped} غير موجودة في بيانات المصحف.`);
  }
  // Background-prefetch adjacent chunk if near boundary
  if (clamped % 100 >= 95 && chunkIdx < 7) {
    void getMushafChunk(chunkIdx + 1).catch(() => {});
  } else if (clamped % 100 <= 5 && chunkIdx > 1) {
    void getMushafChunk(chunkIdx - 1).catch(() => {});
  }
  return found;
}

export async function getPageForAyah(surahNumber: number, ayahNumber: number): Promise<number> {
  const map = await getAyahPagesMap();
  const s = Math.max(1, Math.min(114, Math.floor(surahNumber)));
  const a = Math.max(1, Math.floor(ayahNumber));
  const pagesArr = map[String(s)];
  if (!Array.isArray(pagesArr) || pagesArr.length === 0) return 1;
  return pagesArr[a - 1] ?? pagesArr[0] ?? 1;
}

export function compareAyahPos(s1: number, a1: number, s2: number, a2: number): number {
  if (s1 !== s2) return s1 - s2;
  return a1 - a2;
}

export function isAyahInRange(
  surahNumber: number,
  ayahNumber: number,
  range: QuranRangeRef | null | undefined
): boolean {
  if (!range) return false;
  // Normalize range order gracefully if user accidentally picked end before start
  const startIsBeforeEnd =
    compareAyahPos(range.startSurah, range.startAyah, range.endSurah, range.endAyah) <= 0;
  const fromS = startIsBeforeEnd ? range.startSurah : range.endSurah;
  const fromA = startIsBeforeEnd ? range.startAyah : range.endAyah;
  const toS = startIsBeforeEnd ? range.endSurah : range.startSurah;
  const toA = startIsBeforeEnd ? range.endAyah : range.startAyah;

  return (
    compareAyahPos(surahNumber, ayahNumber, fromS, fromA) >= 0 &&
    compareAyahPos(surahNumber, ayahNumber, toS, toA) <= 0
  );
}

export function getNextAyahCoords(
  surahNumber: number,
  ayahNumber: number,
  surahs: MushafSurahMeta[]
): { surah: number; ayah: number } | null {
  const currentSurah = surahs.find((s) => s.n === surahNumber);
  if (!currentSurah) return null;
  if (ayahNumber < currentSurah.count) {
    return { surah: surahNumber, ayah: ayahNumber + 1 };
  }
  if (surahNumber < 114) {
    return { surah: surahNumber + 1, ayah: 1 };
  }
  return null; // Reached end of Surat An-Nas (114:6)
}

export function toArabicIndicDigits(value: number): string {
  const digits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return String(Math.max(0, Math.floor(value)))
    .split('')
    .map((ch) => {
      const idx = Number(ch);
      return Number.isNaN(idx) ? ch : digits[idx];
    })
    .join('');
}

export function formatQuranRangeSummary(
  surahs: MushafSurahMeta[],
  range: QuranRangeRef | null | undefined
): string {
  if (!range) return 'غير محدد';
  const startSurah = surahs.find((s) => s.n === range.startSurah);
  const endSurah = surahs.find((s) => s.n === range.endSurah);
  const sName = startSurah ? `سورة ${startSurah.name}` : `سورة ${range.startSurah}`;
  const eName = endSurah ? `سورة ${endSurah.name}` : `سورة ${range.endSurah}`;
  if (range.startSurah === range.endSurah) {
    if (range.startAyah === range.endAyah) {
      return `${sName} · آية ${toArabicIndicDigits(range.startAyah)}`;
    }
    return `${sName} · من آية ${toArabicIndicDigits(range.startAyah)} إلى ${toArabicIndicDigits(
      range.endAyah
    )}`;
  }
  return `من ${sName} (${toArabicIndicDigits(range.startAyah)}) إلى ${eName} (${toArabicIndicDigits(
    range.endAyah
  )})`;
}

export function getSavedTeacherReciterId(): string {
  if (typeof window === 'undefined') return DEFAULT_TEACHER_RECITER_ID;
  try {
    const saved = window.localStorage.getItem(TEACHER_RECITER_STORAGE_KEY);
    if (saved && QURAN_RECITERS.some((r) => r.id === saved)) {
      return saved;
    }
  } catch {
    // Non-fatal storage restriction
  }
  return DEFAULT_TEACHER_RECITER_ID;
}

export function saveTeacherReciterId(reciterId: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (QURAN_RECITERS.some((r) => r.id === reciterId)) {
      window.localStorage.setItem(TEACHER_RECITER_STORAGE_KEY, reciterId);
    }
  } catch {
    // Non-fatal
  }
}

let sharedFlipAudioCtx: AudioContext | null = null;

/**
 * Generates an organic parchment page-flip sound via Web Audio API without requiring external audio assets.
 */
export function playPageTurnSound(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    if (!sharedFlipAudioCtx) {
      sharedFlipAudioCtx = new AudioCtx();
    }
    if (sharedFlipAudioCtx.state === 'suspended') {
      void sharedFlipAudioCtx.resume().catch(() => {});
    }

    const ctx = sharedFlipAudioCtx;
    const duration = 0.21;
    const sampleRate = ctx.sampleRate;
    const bufferSize = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      const progress = i / bufferSize;
      // Soft attack, airy paper rustle peak around 30%, crisp tail decay
      const envelope =
        progress < 0.25
          ? progress / 0.25
          : Math.pow(1 - (progress - 0.25) / 0.75, 1.8);
      const white = Math.random() * 2 - 1;
      data[i] = white * envelope * 0.22;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(3200, ctx.currentTime + duration * 0.6);
    filter.frequency.exponentialRampToValueAtTime(950, ctx.currentTime + duration);
    filter.Q.value = 0.9;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.005, ctx.currentTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  } catch {
    // Non-fatal if browser blocks AudioContext
  }
}
