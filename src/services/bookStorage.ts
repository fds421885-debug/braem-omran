import * as pdfjsLib from 'pdfjs-dist';
import type { BookTextSegment, NoorAlBayanStep } from '../types/platform';
import {
  analyzeBookPageInBrowser,
  enhanceImageDataUrlForRecognition,
  generateNoorAlBayanClientFallback,
  inferArabicDiacriticsForWord,
  verifyAndAlignSegmentsWithQuran,
  type PageOcrProgress,
} from './clientArabicEngine';

export type { PageOcrProgress };

function getPdfJsAssetBaseUrl(): string {
  const rawBase = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
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
  /** High-resolution / low-compression image used during recognition, then pruned */
  ocrImageDataUrl?: string;
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
  diacritizedWord?: string;
  wasAutoDiacritized?: boolean;
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

export async function deleteCachedAudioEntry(key: string): Promise<void> {
  try {
    const db = await openBooksDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO, 'readwrite');
      tx.objectStore(STORE_AUDIO).delete(key);
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
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      const imageDataUrl = encodeCanvasWithinBudget(canvas);

      // Keep crisp full-native source for OCR (preserves 2560px screenshots & low-res uploads before JPEG budget compression)
      let ocrImageDataUrl = imageDataUrl;
      const ocrMaxWidth = 2600;
      const ocrRatio =
        img.width > ocrMaxWidth
          ? ocrMaxWidth / img.width
          : img.width < 1500
          ? Math.min(2.6, 2000 / Math.max(1, img.width))
          : 1;
      const ocrW = Math.max(100, Math.round(img.width * ocrRatio));
      const ocrH = Math.max(100, Math.round(img.height * ocrRatio));
      const ocrCanvas = document.createElement('canvas');
      ocrCanvas.width = ocrW;
      ocrCanvas.height = ocrH;
      const ocrCtx = ocrCanvas.getContext('2d');
      if (ocrCtx) {
        ocrCtx.imageSmoothingEnabled = true;
        ocrCtx.imageSmoothingQuality = 'high';
        ocrCtx.fillStyle = '#FFFFFF';
        ocrCtx.fillRect(0, 0, ocrW, ocrH);
        ocrCtx.drawImage(img, 0, 0, ocrW, ocrH);
        ocrImageDataUrl = ocrCanvas.toDataURL('image/jpeg', 0.95);
      }

      onProgress(1, 1);

      return {
        fileType: 'image',
        pages: [
          {
            pageNumber: 1,
            imageDataUrl,
            ocrImageDataUrl,
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
        // Render at high DPI (~2450px wide, up to 4.5x for low-res PDFs) for OCR & fine harakat clarity
        const ocrWidthRatio = 2450 / Math.max(1, baseViewport.width);
        const ocrHeightRatio = 3400 / Math.max(1, baseViewport.height);
        let ocrScale = Math.min(4.5, Math.max(1.2, Math.min(ocrWidthRatio, ocrHeightRatio)));
        // Safety pixel cap (~7.5M px) so mobile browsers never run out of memory
        const rawArea = baseViewport.width * ocrScale * (baseViewport.height * ocrScale);
        if (rawArea > 7_500_000) {
          ocrScale *= Math.sqrt(7_500_000 / rawArea);
        }

        const ocrViewport = page.getViewport({ scale: ocrScale });
        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = Math.max(160, Math.round(ocrViewport.width));
        ocrCanvas.height = Math.max(160, Math.round(ocrViewport.height));
        const ocrCtx = ocrCanvas.getContext('2d');
        if (!ocrCtx) throw new Error('تعذّر تهيئة معالجة صفحة الكتاب.');

        ocrCtx.fillStyle = '#FFFFFF';
        ocrCtx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);

        await page.render({
          canvasContext: ocrCtx,
          viewport: ocrViewport,
          canvas: ocrCanvas,
        }).promise;

        const ocrImageDataUrl = ocrCanvas.toDataURL('image/jpeg', 0.94);

        // Downsample cleanly to display dimensions & Firestore size budget
        const dispRatio = Math.min(
          1,
          1220 / Math.max(1, ocrCanvas.width),
          1750 / Math.max(1, ocrCanvas.height)
        );
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(120, Math.round(ocrCanvas.width * dispRatio));
        canvas.height = Math.max(120, Math.round(ocrCanvas.height * dispRatio));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('تعذّر تهيئة رسم صفحة الكتاب.');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(ocrCanvas, 0, 0, canvas.width, canvas.height);

        // Also inspect embedded text layer softly (optional hint for text/hybrid PDFs)
        let embeddedSegments: EmbeddedWordHint[] = [];
        try {
          const textContent = await page.getTextContent();
          const hints: EmbeddedWordHint[] = [];
          for (const item of textContent.items) {
            if (!('str' in item)) continue;
            const rawStr = String(item.str || '')
              .normalize('NFKC')
              .replace(/[\u200B-\u200F\uFEFF]/g, '')
              .trim();
            if (!rawStr) continue;

            const tx = pdfjsLib.Util.transform(ocrViewport.transform, item.transform);
            const itemLeftPx = tx[4];
            const itemBaselinePx = tx[5];
            const itemFontH = Math.max(
              10,
              Math.hypot(tx[2], tx[3]) || item.height * ocrScale || 14
            );
            const itemWidthPx = Math.max(
              12,
              (item.width || rawStr.length * 6) * ocrScale
            );

            const words = rawStr.split(/\s+/).filter(Boolean);
            const wordSliceW = itemWidthPx / Math.max(1, words.length);
            const isRtlRun = /[\u0600-\u06FF]/.test(rawStr);

            words.forEach((word, wIdx) => {
              if (hints.length >= 420) return;
              const wx0 = isRtlRun
                ? Math.max(0, itemLeftPx + itemWidthPx - (wIdx + 1) * wordSliceW)
                : itemLeftPx + wIdx * wordSliceW;
              const wx1 = Math.min(ocrCanvas.width, wx0 + wordSliceW);
              const wy0 = Math.max(0, itemBaselinePx - itemFontH);
              const wy1 = Math.min(ocrCanvas.height, itemBaselinePx + itemFontH * 0.25);

              const ymin = Math.max(
                0,
                Math.min(990, Math.round((wy0 / ocrCanvas.height) * 1000))
              );
              const xmin = Math.max(
                0,
                Math.min(990, Math.round((wx0 / ocrCanvas.width) * 1000))
              );
              const ymax = Math.max(
                ymin + 8,
                Math.min(1000, Math.round((wy1 / ocrCanvas.height) * 1000))
              );
              const xmax = Math.max(
                xmin + 8,
                Math.min(1000, Math.round((wx1 / ocrCanvas.width) * 1000))
              );

              hints.push({ text: word, ymin, xmin, ymax, xmax });
            });
          }
          embeddedSegments = hints;
        } catch {
          // Image-only scanned PDF — handled cleanly by super-OCR
        }

        const imageDataUrl = encodeCanvasWithinBudget(canvas);
        pages.push({
          pageNumber: pageNum,
          imageDataUrl,
          ocrImageDataUrl,
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timerId: number | null = null;
  if (controller && typeof window !== 'undefined') {
    timerId = window.setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // Ignore abort cleanup error
      }
    }, timeoutMs);
  }
  try {
    return await fetch(url, {
      ...init,
      signal: controller ? controller.signal : init.signal,
    });
  } finally {
    if (timerId !== null && typeof window !== 'undefined') {
      window.clearTimeout(timerId);
    }
  }
}

export async function analyzeBookPageOnServer(params: {
  imageDataUrl: string;
  ocrImageDataUrl?: string;
  pageNumber: number;
  bookTitle?: string;
  embeddedSegments?: EmbeddedWordHint[];
  onProgress?: (progress: PageOcrProgress) => void;
}): Promise<{
  fullText: string;
  segments: BookTextSegment[];
}> {
  const emit = (pagePercent: number, stageText: string) => {
    params.onProgress?.({
      pageNumber: params.pageNumber,
      pagePercent: Math.max(1, Math.min(100, Math.round(pagePercent))),
      stageText,
    });
  };

  if (!params.ocrImageDataUrl) {
    emit(3, 'جاري رفع دقة صورة الصفحة وتنعيم الحروف قبل التحليل...');
  } else {
    emit(4, 'تم تجهيز نسخة عالية الدقة من الصفحة لبدء التحليل...');
  }

  const highResSource =
    params.ocrImageDataUrl ||
    (await enhanceImageDataUrlForRecognition(params.imageDataUrl));

  if (staticHostWithoutApi !== true) {
    let serverPct = 16;
    let progressTimer: number | null = null;
    try {
      emit(16, 'جاري إرسال الصفحة إلى محرك الذكاء الاصطناعي...');
      if (typeof window !== 'undefined') {
        progressTimer = window.setInterval(() => {
          serverPct = Math.min(80, serverPct + 7);
          const stage =
            serverPct < 38
              ? 'جاري قراءة النصوص والآيات والحركات على الصفحة...'
              : serverPct < 62
              ? 'جاري استخراج الكلمات وضبط التشكيل العربي...'
              : 'جاري تحديد إحداثيات ومواقع الكلمات بدقة...';
          emit(serverPct, stage);
        }, 700);
      }

      const res = await fetchWithTimeout(
        '/api/books/analyze-page',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageDataUrl: highResSource,
            pageNumber: params.pageNumber,
            bookTitle: params.bookTitle,
          }),
        },
        22000
      );

      if (progressTimer !== null) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }

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
            return await verifyAndAlignSegmentsWithQuran({
              segments: serverSegments,
              fullText: String(data.fullText || '').trim(),
              pageNumber: params.pageNumber,
              onProgress: params.onProgress,
            });
          }
        } else if (res.status !== 404 && res.status !== 405 && res.status !== 501) {
          // If server returned a transient/upstream failure on a PDF scan, fall through to in-browser OCR below!
        }
      } else {
        staticHostWithoutApi = true;
      }
    } catch {
      // Static host or offline API — use pure browser Arabic OCR below
    } finally {
      if (progressTimer !== null) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }
    }
  }

  return analyzeBookPageInBrowser({
    imageDataUrl: highResSource,
    pageNumber: params.pageNumber,
    embeddedSegments: params.embeddedSegments,
    onProgress: params.onProgress,
  });
}

export async function generateNoorAlBayanOnServer(params: {
  text: string;
  surahName?: string;
}): Promise<{
  diacritizedWord: string;
  wasAutoDiacritized: boolean;
  steps: NoorAlBayanStep[];
  fullReading: string;
}> {
  if (staticHostWithoutApi !== true) {
    try {
      const res = await fetchWithTimeout(
        '/api/books/noor-albayan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        },
        6000
      );

      if (!isStaticMissingApi(res)) {
        const data = (await res.json().catch(() => ({}))) as {
          diacritizedWord?: string;
          wasAutoDiacritized?: boolean;
          steps?: NoorAlBayanStep[];
          fullReading?: string;
          error?: string;
        };
        if (res.ok && Array.isArray(data.steps) && data.steps.length > 0) {
          staticHostWithoutApi = false;
          return {
            diacritizedWord: String(data.diacritizedWord || params.text),
            wasAutoDiacritized: Boolean(data.wasAutoDiacritized),
            steps: data.steps,
            fullReading: String(data.fullReading || data.diacritizedWord || params.text),
          };
        }
      } else {
        staticHostWithoutApi = true;
      }
    } catch {
      // Fall back cleanly to deterministic in-browser Noor Al-Bayan engine
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
  const preparedText =
    params.mode === 'normal'
      ? params.text
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => inferArabicDiacriticsForWord(w).vocalized)
          .join(' ') || params.text
      : params.text;

  if (staticHostWithoutApi !== true) {
    try {
      const res = await fetchWithTimeout(
        '/api/tts/speak',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: preparedText,
            mode: params.mode,
          }),
        },
        9500
      );

      if (!isStaticMissingApi(res)) {
        const data = (await res.json().catch(() => ({}))) as {
          audioBase64?: string;
          mimeType?: string;
          error?: string;
        };
        if (res.ok && data.audioBase64 && data.audioBase64.length > 120) {
          staticHostWithoutApi = false;
          return {
            engine: 'server_wav',
            audioBase64: data.audioBase64,
            mimeType: data.mimeType || 'audio/wav',
            text: preparedText,
          };
        }
      } else {
        staticHostWithoutApi = true;
      }
    } catch {
      // Static host, timeout, rate limit, or offline API — fall through to chunked browser SpeechSynthesis
    }
  }

  return {
    engine: 'browser_speech',
    audioBase64: '',
    mimeType: 'text/speech',
    text: preparedText,
  };
}

function buildWavWithRiffHeader(pcmBytes: Uint8Array, sampleRate = 24000): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcmBytes.length, true);

  const out = new Uint8Array(44 + pcmBytes.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcmBytes, 44);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Ensures audioBase64 stays comfortably within Firestore's 1 MiB document size limit
 * by halving PCM sample rate (24kHz -> 12kHz) when clips are longer, or returning empty if still too large.
 */
export function shrinkWavBase64ForDb(
  base64Data: string,
  mimeType = 'audio/wav',
  maxChars = 640000
): { audioBase64: string; mimeType: string } {
  if (!base64Data) return { audioBase64: '', mimeType };
  if (base64Data.length <= maxChars) return { audioBase64: base64Data, mimeType };

  try {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const isRiff =
      bytes.length > 44 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleRate = isRiff ? view.getUint32(24, true) : 24000;
    const pcmStart = isRiff ? 44 : 0;
    const sampleCount = Math.floor((bytes.length - pcmStart) / 2);

    // Try 2x downsample, then 3x if needed
    for (const factor of [2, 3]) {
      const targetRate = Math.max(8000, Math.round(sampleRate / factor));
      const newSamples = Math.floor(sampleCount / factor);
      const downsampled = new Uint8Array(newSamples * 2);
      const outView = new DataView(downsampled.buffer);
      for (let i = 0; i < newSamples; i++) {
        const srcByte = pcmStart + i * factor * 2;
        const sample = view.getInt16(srcByte, true);
        outView.setInt16(i * 2, sample, true);
      }
      const wrapped = buildWavWithRiffHeader(downsampled, targetRate);
      const encoded = bytesToBase64(wrapped);
      if (encoded.length <= maxChars) {
        return { audioBase64: encoded, mimeType: 'audio/wav' };
      }
    }
  } catch {
    // Non-fatal fallback
  }

  return { audioBase64: '', mimeType: 'text/speech' };
}

export function base64AudioToObjectUrl(base64Data: string, mimeType = 'audio/wav'): string {
  const binary = atob(base64Data);
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const hasRiffHeader =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  const normalizedMime = mimeType.toLowerCase();
  if (
    !hasRiffHeader &&
    (normalizedMime.includes('wav') ||
      normalizedMime.includes('pcm') ||
      normalizedMime.includes('l16'))
  ) {
    bytes = buildWavWithRiffHeader(bytes, 24000);
    mimeType = 'audio/wav';
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}
