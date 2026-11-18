import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { BookTextSegment, NoorAlBayanStep } from '../types/platform';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const DB_NAME = 'braem_omran_books_db';
const DB_VERSION = 1;
const STORE_JOBS = 'jobs';
const STORE_AUDIO = 'audioCache';
const MAX_PAGE_DATAURL_CHARS = 620000;

export interface BookLocalPage {
  pageNumber: number;
  imageDataUrl: string;
  width: number;
  height: number;
  uploaded: boolean;
  recognized: boolean;
  fullText: string;
  segments: BookTextSegment[];
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
  const qualities = [0.85, 0.72, 0.58, 0.45, 0.34];
  for (const q of qualities) {
    const dataUrl = canvas.toDataURL('image/jpeg', q);
    if (dataUrl.length <= MAX_PAGE_DATAURL_CHARS) {
      return dataUrl;
    }
  }
  // If still large, downscale dimensions once and re-encode
  const scaled = document.createElement('canvas');
  scaled.width = Math.max(320, Math.round(canvas.width * 0.72));
  scaled.height = Math.max(320, Math.round(canvas.height * 0.72));
  const ctx = scaled.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, scaled.width, scaled.height);
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  }
  return scaled.toDataURL('image/jpeg', 0.55);
}

export async function extractBookFilePages(
  file: File,
  onProgress: (done: number, total: number) => void
): Promise<{
  fileType: 'pdf' | 'image';
  pages: BookLocalPage[];
}> {
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

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
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const totalPages = Math.min(pdf.numPages, 2000);
  if (totalPages < 1) {
    throw new Error('ملف PDF فارغ ولا يحتوي على صفحات.');
  }

  const pages: BookLocalPage[] = [];
  onProgress(0, totalPages);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetScale = Math.min(2.0, Math.max(1.1, 1180 / Math.max(1, baseViewport.width)));
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
    });

    onProgress(pageNum, totalPages);
  }

  return {
    fileType: 'pdf',
    pages,
  };
}

export async function analyzeBookPageOnServer(params: {
  imageDataUrl: string;
  pageNumber: number;
  bookTitle?: string;
}): Promise<{
  fullText: string;
  segments: BookTextSegment[];
}> {
  const res = await fetch('/api/books/analyze-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => ({}))) as {
    fullText?: string;
    segments?: BookTextSegment[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || 'تعذّر التعرف على نص هذه الصفحة.');
  }
  return {
    fullText: String(data.fullText || '').trim(),
    segments: Array.isArray(data.segments) ? data.segments : [],
  };
}

export async function generateNoorAlBayanOnServer(params: {
  text: string;
  surahName?: string;
}): Promise<{
  diacritizedWord: string;
  steps: NoorAlBayanStep[];
  fullReading: string;
}> {
  const res = await fetch('/api/books/noor-albayan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => ({}))) as {
    diacritizedWord?: string;
    steps?: NoorAlBayanStep[];
    fullReading?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || 'تعذّر تجهيز قراءة التهجي.');
  }
  return {
    diacritizedWord: String(data.diacritizedWord || params.text),
    steps: Array.isArray(data.steps) ? data.steps : [],
    fullReading: String(data.fullReading || params.text),
  };
}

export async function synthesizeSpeechOnServer(params: {
  text: string;
  mode: 'noor_albayan' | 'normal';
}): Promise<{
  audioBase64: string;
  mimeType: string;
}> {
  const res = await fetch('/api/tts/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => ({}))) as {
    audioBase64?: string;
    mimeType?: string;
    error?: string;
  };
  if (!res.ok || !data.audioBase64) {
    throw new Error(data.error || 'تعذّر توليد الصوت العربي الآن.');
  }
  return {
    audioBase64: data.audioBase64,
    mimeType: data.mimeType || 'audio/wav',
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
