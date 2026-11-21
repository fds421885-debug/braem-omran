import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  FileText,
  Headphones,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  WifiOff,
  X,
} from 'lucide-react';
import {
  analyzeBookPageOnServer,
  base64AudioToObjectUrl,
  deleteBookJobLocal,
  deleteCachedAudioEntry,
  extractBookFilePages,
  generateNoorAlBayanOnServer,
  getBookJobLocal,
  getCachedAudioEntry,
  listBookJobsForComplexLocal,
  saveBookJobLocal,
  saveCachedAudioEntry,
  synthesizeSpeechOnServer,
  type BookJobState,
  type BookLocalPage,
} from '../services/bookStorage';
import { generateValidId, getReciterAyahAudioUrl } from '../services/multiDb';
import {
  deleteBookFromWorkspace,
  listBooksInComplex,
  loadBookPages,
  renameBookInWorkspace,
  upsertBookPageRecord,
  upsertBookRecord,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  QURAN_RECITERS,
  type BookPageRecord,
  type BookRecord,
  type BookTextSegment,
  type NoorAlBayanStep,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';

interface BookLibrarySectionProps {
  workspace: ComplexWorkspaceData;
  currentUserId: string;
}

type AudioMode = 'noor_albayan' | 'normal' | 'sheikh';

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Renders the exact cropped pixel region from the book page onto a <canvas>
 * so the supervisor sees the clicked word/ayah in its original font & calligraphy.
 */
const WordImageCropPreview: React.FC<{
  imageDataUrl: string;
  box: [number, number, number, number];
  altText: string;
}> = ({ imageDataUrl, box, altText }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const [ymin, xmin, ymax, xmax] = box;
      const padX = 24;
      const padY = 18;
      const sx = Math.max(0, Math.floor((xmin / 1000) * img.width) - padX);
      const sy = Math.max(0, Math.floor((ymin / 1000) * img.height) - padY);
      const ex = Math.min(img.width, Math.ceil((xmax / 1000) * img.width) + padX);
      const ey = Math.min(img.height, Math.ceil((ymax / 1000) * img.height) + padY);
      const sw = Math.max(20, ex - sx);
      const sh = Math.max(20, ey - sy);

      const targetWidth = Math.min(440, Math.max(180, sw * 2));
      const targetHeight = Math.max(64, Math.round((sh / sw) * targetWidth));

      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
    };
    img.src = imageDataUrl;
    return () => {
      cancelled = true;
    };
  }, [imageDataUrl, box]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={altText}
      className="max-w-full max-h-36 rounded-xl border-2 border-[#EADBC8] bg-white mx-auto block"
    />
  );
};

export const BookLibrarySection: React.FC<BookLibrarySectionProps> = ({
  workspace,
  currentUserId,
}) => {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [localJobs, setLocalJobs] = useState<BookJobState[]>([]);
  const [loadingBooks, setLoadingBooks] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // Add Book Flow State
  const [showAddForm, setShowAddForm] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Active upload & AI recognition job state
  const [activeJob, setActiveJob] = useState<BookJobState | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [isRunningJob, setIsRunningJob] = useState(false);
  const activeRunIdRef = useRef<number>(0);
  const pauseRequestedRef = useRef<boolean>(false);

  // Rename & Delete Modals
  const [renamingBook, setRenamingBook] = useState<BookRecord | null>(null);
  const [renameTitleVal, setRenameTitleVal] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [deletingBook, setDeletingBook] = useState<BookRecord | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Interactive Book Reader State
  const [readerBook, setReaderBook] = useState<BookRecord | null>(null);
  const [readerPages, setReaderPages] = useState<BookPageRecord[]>([]);
  const [loadingReader, setLoadingReader] = useState(false);
  const [reanalyzingPage, setReanalyzingPage] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedSegment, setSelectedSegment] = useState<BookTextSegment | null>(null);

  // Audio & Noor Al-Bayan State
  const [selectedReciterId, setSelectedReciterId] = useState<string>(QURAN_RECITERS[0].id);
  const [noorLoading, setNoorLoading] = useState(false);
  const [noorSteps, setNoorSteps] = useState<NoorAlBayanStep[]>([]);
  const [noorFullReading, setNoorFullReading] = useState<string>('');
  const [noorDiacritizedWord, setNoorDiacritizedWord] = useState<string>('');
  const [noorAutoDiacritized, setNoorAutoDiacritized] = useState(false);
  const [audioLoadingMode, setAudioLoadingMode] = useState<AudioMode | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [activeAudioMode, setActiveAudioMode] = useState<AudioMode | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeObjectUrlRef = useRef<string | null>(null);
  const audioRunTokenRef = useRef<number>(0);
  const speechStateRef = useRef<{
    active: boolean;
    text: string;
    chunks: string[];
    chunkIndex: number;
    mode: AudioMode;
    startedAtMs: number;
    elapsedBeforePauseMs: number;
    timerId: number | null;
    startDelayId: number | null;
  }>({
    active: false,
    text: '',
    chunks: [],
    chunkIndex: 0,
    mode: 'normal',
    startedAtMs: 0,
    elapsedBeforePauseMs: 0,
    timerId: null,
    startDelayId: null,
  });

  const loadBooksAndJobs = useCallback(async () => {
    setLoadingBooks(true);
    try {
      const [remoteBooks, cachedJobs] = await Promise.all([
        listBooksInComplex(workspace),
        listBookJobsForComplexLocal(workspace.complex.id),
      ]);
      setBooks(remoteBooks);
      setLocalJobs(cachedJobs.filter((j) => j.status !== 'ready'));
    } finally {
      setLoadingBooks(false);
    }
  }, [workspace]);

  useEffect(() => {
    void loadBooksAndJobs();
  }, [loadBooksAndJobs]);

  // Warn user before leaving page while actively uploading or recognizing a book
  useEffect(() => {
    if (!isRunningJob) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRunningJob]);

  // Clean up audio element, SpeechSynthesis & ObjectURLs on unmount
  useEffect(() => {
    return () => {
      audioRunTokenRef.current++;
      if (audioRef.current) {
        audioRef.current.onloadedmetadata = null;
        audioRef.current.ontimeupdate = null;
        audioRef.current.onplay = null;
        audioRef.current.onpause = null;
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
      }
      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current);
      }
      if (speechStateRef.current.timerId !== null) {
        window.clearInterval(speechStateRef.current.timerId);
      }
      if (speechStateRef.current.startDelayId !== null) {
        window.clearTimeout(speechStateRef.current.startDelayId);
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const syncBookRecordFromJob = useCallback(
    async (job: BookJobState) => {
      const uploadedPages = job.pages.filter((p) => p.uploaded).length;
      const recognizedPages = job.pages.filter((p) => p.recognized).length;
      const record: BookRecord = {
        id: job.bookId,
        complexId: job.complexId,
        title: job.title,
        fileName: job.fileName,
        fileType: job.fileType,
        totalPages: job.totalPages,
        uploadedPages,
        recognizedPages,
        status: job.status,
        createdBy: currentUserId,
      };
      await upsertBookRecord(workspace, record);
    },
    [workspace, currentUserId]
  );

  const runBookPipeline = useCallback(
    async (initialJob: BookJobState) => {
      const runId = ++activeRunIdRef.current;
      pauseRequestedRef.current = false;
      setIsRunningJob(true);
      setFeedback(null);

      let workingJob: BookJobState = {
        ...initialJob,
        pages: initialJob.pages.map((p) => ({ ...p })),
        lastError: undefined,
        updatedAtMs: Date.now(),
      };

      const commitProgress = async (next: BookJobState) => {
        workingJob = { ...next, updatedAtMs: Date.now() };
        setActiveJob(workingJob);
        await saveBookJobLocal(workingJob);
        setLocalJobs((prev) => {
          const rest = prev.filter((x) => x.bookId !== workingJob.bookId);
          return workingJob.status === 'ready' ? rest : [workingJob, ...rest];
        });
      };

      const isNetworkOrTransientError = (err: unknown): boolean => {
        if (!navigator.onLine) return true;
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        return (
          msg.includes('network') ||
          msg.includes('failed to fetch') ||
          msg.includes('timeout') ||
          msg.includes('unavailable') ||
          msg.includes('offline') ||
          msg.includes('503') ||
          msg.includes('429')
        );
      };

      try {
        // Phase 1: Upload pages to Firestore (skip already uploaded pages on resume)
        workingJob.status = 'uploading';
        await commitProgress(workingJob);
        if (navigator.onLine) {
          await syncBookRecordFromJob(workingJob).catch(() => {});
        }

        for (let i = 0; i < workingJob.pages.length; i++) {
          if (activeRunIdRef.current !== runId || pauseRequestedRef.current) return;
          const page = workingJob.pages[i];
          if (page.uploaded) continue;

          if (!navigator.onLine) {
            throw new Error('انقطع الاتصال بالإنترنت أثناء الرفع.');
          }

          await upsertBookPageRecord(workspace, {
            id: `${workingJob.bookId}_p${page.pageNumber}`,
            bookId: workingJob.bookId,
            complexId: workingJob.complexId,
            pageNumber: page.pageNumber,
            imageDataUrl: page.imageDataUrl,
            width: page.width,
            height: page.height,
            recognized: page.recognized,
            fullText: page.fullText,
            segments: page.segments,
          });

          workingJob.pages[i] = { ...page, uploaded: true };
          await commitProgress(workingJob);
          await syncBookRecordFromJob(workingJob).catch(() => {});
        }

        // Phase 2: AI Smart Recognition page-by-page (skip already recognized pages)
        workingJob.status = 'processing';
        await commitProgress(workingJob);
        await syncBookRecordFromJob(workingJob).catch(() => {});

        for (let i = 0; i < workingJob.pages.length; i++) {
          if (activeRunIdRef.current !== runId || pauseRequestedRef.current) return;
          const page = workingJob.pages[i];
          if (page.recognized) continue;

          if (!navigator.onLine) {
            throw new Error('انقطع الاتصال بالإنترنت أثناء التعرف الذكي.');
          }

          const analyzed = await analyzeBookPageOnServer({
            imageDataUrl: page.imageDataUrl,
            ocrImageDataUrl: page.ocrImageDataUrl,
            pageNumber: page.pageNumber,
            bookTitle: workingJob.title,
            embeddedSegments: page.embeddedSegments,
          });

          const updatedPage: BookLocalPage = {
            ...page,
            ocrImageDataUrl: undefined,
            uploaded: true,
            recognized: true,
            fullText: analyzed.fullText,
            segments: analyzed.segments,
          };

          await upsertBookPageRecord(workspace, {
            id: `${workingJob.bookId}_p${page.pageNumber}`,
            bookId: workingJob.bookId,
            complexId: workingJob.complexId,
            pageNumber: page.pageNumber,
            imageDataUrl: updatedPage.imageDataUrl,
            width: updatedPage.width,
            height: updatedPage.height,
            recognized: true,
            fullText: updatedPage.fullText,
            segments: updatedPage.segments,
          });

          workingJob.pages[i] = updatedPage;
          await commitProgress(workingJob);
          await syncBookRecordFromJob(workingJob).catch(() => {});
        }

        if (activeRunIdRef.current !== runId) return;

        // Done!
        workingJob.status = 'ready';
        await commitProgress(workingJob);
        await syncBookRecordFromJob(workingJob);
        await deleteBookJobLocal(workingJob.bookId);
        await loadBooksAndJobs();
        setFeedback({
          type: 'ok',
          text: `تم! اكتمل رفع ومعالجة كتاب "${workingJob.title}" بجميع صفحاته (${workingJob.totalPages} صفحة).`,
        });
      } catch (err) {
        if (activeRunIdRef.current !== runId) return;
        const transient = isNetworkOrTransientError(err);
        workingJob.status = transient ? 'paused' : 'error';
        workingJob.lastError =
          err instanceof Error
            ? err.message
            : 'تعذّر إكمال رفع أو معالجة الكتاب؛ تم حفظ تقدمك تلقائياً.';
        await commitProgress(workingJob);
        if (navigator.onLine) {
          await syncBookRecordFromJob(workingJob).catch(() => {});
        }
        await loadBooksAndJobs();
      } finally {
        if (activeRunIdRef.current === runId) {
          setIsRunningJob(false);
        }
      }
    },
    [workspace, syncBookRecordFromJob, loadBooksAndJobs]
  );

  // Listen for online/offline events to pause or auto-resume cleanly
  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
    };
    const handleOnline = () => {
      setIsOnline(true);
      if (
        activeJob &&
        (activeJob.status === 'paused' || activeJob.status === 'error') &&
        !isRunningJob
      ) {
        void runBookPipeline(activeJob);
      }
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [activeJob, isRunningJob, runBookPipeline]);

  const handleSelectBookFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const cleanTitle = newBookTitle.trim();
    if (cleanTitle.length < 2) {
      setFeedback({ type: 'err', text: 'يرجى كتابة عنوان الكتاب أولاً ثم اختيار الملف.' });
      return;
    }

    setFeedback(null);
    const bookId = generateValidId('bk');
    setShowAddForm(false);

    try {
      setExtractProgress({ done: 0, total: 1 });
      const extracted = await extractBookFilePages(file, (done, total) => {
        setExtractProgress({ done, total });
      });

      const newJob: BookJobState = {
        bookId,
        complexId: workspace.complex.id,
        title: cleanTitle,
        fileName: file.name,
        fileType: extracted.fileType,
        totalPages: extracted.pages.length,
        status: 'uploading',
        pages: extracted.pages,
        updatedAtMs: Date.now(),
      };

      await saveBookJobLocal(newJob);
      setActiveJob(newJob);
      setNewBookTitle('');
      setExtractProgress({ done: 0, total: 0 });
      await runBookPipeline(newJob);
    } catch (err) {
      setExtractProgress({ done: 0, total: 0 });
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر قراءة ملف الكتاب المختار.',
      });
    }
  };

  const handleResumeSavedJob = async (jobOrBook: BookJobState | BookRecord) => {
    setFeedback(null);
    const bookId = 'bookId' in jobOrBook ? jobOrBook.bookId : jobOrBook.id;
    let job = await getBookJobLocal(bookId);

    if (!job && 'id' in jobOrBook) {
      // Rebuild resume job directly from remote pages if user reopened on another tab/session
      const remotePages = await loadBookPages(workspace, jobOrBook.id);
      if (remotePages.length === 0) {
        setFeedback({
          type: 'err',
          text: 'هذا الكتاب توقف قبل رفع أي صفحة؛ يرجى حذفه وإعادة رفعه من جديد.',
        });
        return;
      }
      job = {
        bookId: jobOrBook.id,
        complexId: jobOrBook.complexId,
        title: jobOrBook.title,
        fileName: jobOrBook.fileName,
        fileType: jobOrBook.fileType,
        totalPages: Math.max(jobOrBook.totalPages, remotePages.length),
        status: 'paused',
        pages: remotePages.map((p) => ({
          pageNumber: p.pageNumber,
          imageDataUrl: p.imageDataUrl,
          width: p.width,
          height: p.height,
          uploaded: true,
          recognized: p.recognized,
          fullText: p.fullText,
          segments: p.segments,
        })),
        updatedAtMs: Date.now(),
      };
    }

    if (!job) {
      setFeedback({ type: 'err', text: 'تعذّر العثور على بيانات استكمال هذا الكتاب.' });
      return;
    }

    setActiveJob(job);
    await runBookPipeline(job);
  };

  const clearSpeechTimers = useCallback(() => {
    if (speechStateRef.current.timerId !== null) {
      window.clearInterval(speechStateRef.current.timerId);
      speechStateRef.current.timerId = null;
    }
    if (speechStateRef.current.startDelayId !== null) {
      window.clearTimeout(speechStateRef.current.startDelayId);
      speechStateRef.current.startDelayId = null;
    }
  }, []);

  const detachAndStopAudioElement = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onloadedmetadata = null;
      audio.ontimeupdate = null;
      audio.onplay = null;
      audio.onpause = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current);
      activeObjectUrlRef.current = null;
    }
  }, []);

  const stopAndResetAudio = useCallback(() => {
    audioRunTokenRef.current++;
    detachAndStopAudioElement();
    clearSpeechTimers();
    speechStateRef.current.active = false;
    speechStateRef.current.chunks = [];
    speechStateRef.current.chunkIndex = 0;
    speechStateRef.current.elapsedBeforePauseMs = 0;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser quirk
      }
    }
    setAudioPlaying(false);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setActiveAudioMode(null);
    setAudioError(null);
  }, [clearSpeechTimers, detachAndStopAudioElement]);

  const openBookReader = async (book: BookRecord) => {
    stopAndResetAudio();
    setSelectedSegment(null);
    setNoorSteps([]);
    setNoorFullReading('');
    setNoorDiacritizedWord('');
    setNoorAutoDiacritized(false);
    setReaderBook(book);
    setCurrentPageIndex(0);
    setLoadingReader(true);
    try {
      const pages = await loadBookPages(workspace, book.id);
      setReaderPages(pages);
      const firstSeg = pages[0]?.segments?.[0] || null;
      setSelectedSegment(firstSeg);
    } catch {
      setFeedback({ type: 'err', text: 'تعذّر تحميل صفحات الكتاب.' });
    } finally {
      setLoadingReader(false);
    }
  };

  const handleSelectSegment = (seg: BookTextSegment) => {
    stopAndResetAudio();
    setSelectedSegment(seg);
    setNoorSteps([]);
    setNoorFullReading('');
    setNoorDiacritizedWord('');
    setNoorAutoDiacritized(false);
    setAudioError(null);
  };

  const splitArabicSpeechChunks = (text: string): string[] => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const rawParts = clean.split(/(?<=[،.؛؟\n])\s*/).map((s) => s.trim()).filter(Boolean);
    const chunks: string[] = [];
    let buffer = '';
    for (const part of rawParts) {
      if (!buffer) {
        buffer = part;
      } else if (buffer.length + part.length + 1 <= 115) {
        buffer = `${buffer} ${part}`;
      } else {
        chunks.push(buffer);
        buffer = part;
      }
    }
    if (buffer) chunks.push(buffer);
    return chunks.length > 0 ? chunks : [clean];
  };

  const playBrowserSpeech = useCallback(
    (mode: AudioMode, text: string, startChunkIdx = 0) => {
      const runToken = ++audioRunTokenRef.current;
      detachAndStopAudioElement();
      clearSpeechTimers();
      setAudioError(null);

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setAudioPlaying(false);
        setAudioError('متصفحك لا يدعم القراءة الصوتية التلقائية بدون خادم.');
        return;
      }

      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser cancel errors
      }

      const cleanText = text.trim();
      if (!cleanText) return;
      const chunks = splitArabicSpeechChunks(cleanText);
      const estimatedSeconds = Math.max(
        1.4,
        Math.round(
          cleanText.split(/\s+/).filter(Boolean).length *
            (mode === 'noor_albayan' ? 0.92 : 0.62) *
            10
        ) / 10
      );

      speechStateRef.current.active = true;
      speechStateRef.current.text = cleanText;
      speechStateRef.current.chunks = chunks;
      speechStateRef.current.chunkIndex = Math.max(0, Math.min(chunks.length - 1, startChunkIdx));
      speechStateRef.current.mode = mode;
      speechStateRef.current.elapsedBeforePauseMs = 0;
      speechStateRef.current.startedAtMs = Date.now();

      setActiveAudioMode(mode);
      setAudioDuration(estimatedSeconds);
      setAudioCurrentTime(0);
      setAudioPlaying(true);

      const pickArabicVoice = (): SpeechSynthesisVoice | undefined => {
        const voices = window.speechSynthesis.getVoices() || [];
        return (
          voices.find((v) => v.lang.toLowerCase() === 'ar-sa') ||
          voices.find((v) => v.lang.toLowerCase().startsWith('ar-eg')) ||
          voices.find((v) => v.lang.toLowerCase().startsWith('ar'))
        );
      };

      const speakChunkAt = (idx: number) => {
        if (audioRunTokenRef.current !== runToken || !speechStateRef.current.active) return;
        if (idx >= chunks.length) {
          clearSpeechTimers();
          speechStateRef.current.active = false;
          setAudioPlaying(false);
          setAudioCurrentTime(estimatedSeconds);
          return;
        }

        speechStateRef.current.chunkIndex = idx;
        const chunkText = chunks[idx];
        const utterance = new SpeechSynthesisUtterance(chunkText);
        const arVoice = pickArabicVoice();
        if (arVoice) {
          utterance.voice = arVoice;
        }
        utterance.lang = arVoice?.lang || 'ar-SA';
        utterance.rate = mode === 'noor_albayan' ? 0.78 : 0.95;
        utterance.pitch = 1.0;

        utterance.onend = () => {
          if (audioRunTokenRef.current !== runToken || !speechStateRef.current.active) return;
          speakChunkAt(idx + 1);
        };

        utterance.onerror = (ev) => {
          if (audioRunTokenRef.current !== runToken) return;
          if (ev.error === 'canceled' || ev.error === 'interrupted') return;
          // Try next chunk cleanly before surfacing voice missing notice
          if (idx + 1 < chunks.length) {
            speakChunkAt(idx + 1);
            return;
          }
          clearSpeechTimers();
          speechStateRef.current.active = false;
          setAudioPlaying(false);
          const hasAnyArabicVoice = (window.speechSynthesis.getVoices() || []).some((v) =>
            v.lang.toLowerCase().startsWith('ar')
          );
          if (!hasAnyArabicVoice) {
            setAudioError(
              'لا توجد حزمة صوت عربي مفعّلة في هذا المتصفح حالياً، لكن يمكنك متابعة التهجي البصري خطوة بخطوة بالأسفل.'
            );
          } else {
            setAudioError('تعذّر تشغيل القارئ الصوتي في المتصفح مؤقتاً؛ اضغط أعد المحاولة.');
          }
        };

        try {
          window.speechSynthesis.speak(utterance);
        } catch {
          clearSpeechTimers();
          speechStateRef.current.active = false;
          setAudioPlaying(false);
        }
      };

      // Small 45ms delay prevents Chromium synchronous cancel()+speak() deadlock
      speechStateRef.current.startDelayId = window.setTimeout(() => {
        if (audioRunTokenRef.current !== runToken || !speechStateRef.current.active) return;
        speechStateRef.current.startedAtMs = Date.now();
        speechStateRef.current.timerId = window.setInterval(() => {
          if (audioRunTokenRef.current !== runToken) {
            clearSpeechTimers();
            return;
          }
          const totalMs =
            speechStateRef.current.elapsedBeforePauseMs +
            (Date.now() - speechStateRef.current.startedAtMs);
          setAudioCurrentTime(Math.min(estimatedSeconds, totalMs / 1000));
        }, 120);
        speakChunkAt(speechStateRef.current.chunkIndex);
      }, 45);
    },
    [clearSpeechTimers, detachAndStopAudioElement]
  );

  const playAudioSource = useCallback(
    async (
      mode: AudioMode,
      url: string,
      isObjectUrl: boolean,
      onFallback?: () => void,
      badCacheKey?: string
    ) => {
      const runToken = ++audioRunTokenRef.current;
      clearSpeechTimers();
      speechStateRef.current.active = false;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // Ignore
        }
      }

      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      const audio = audioRef.current;
      detachAndStopAudioElement();
      if (isObjectUrl) {
        activeObjectUrlRef.current = url;
      }

      let fallbackHandled = false;
      const triggerFallback = () => {
        if (fallbackHandled || audioRunTokenRef.current !== runToken) return;
        fallbackHandled = true;
        detachAndStopAudioElement();
        if (badCacheKey) {
          void deleteCachedAudioEntry(badCacheKey);
        }
        if (onFallback) {
          onFallback();
        } else {
          setAudioPlaying(false);
          setAudioError('تعذّر تشغيل الملف الصوتي حالياً؛ تأكد من الاتصال وحاول مجدداً.');
        }
      };

      audio.preload = 'auto';
      audio.src = url;
      audio.currentTime = 0;
      audio.onloadedmetadata = () => {
        if (audioRunTokenRef.current !== runToken) return;
        setAudioDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      };
      audio.ontimeupdate = () => {
        if (audioRunTokenRef.current !== runToken) return;
        setAudioCurrentTime(audio.currentTime || 0);
        if (Number.isFinite(audio.duration)) {
          setAudioDuration(audio.duration);
        }
      };
      audio.onplay = () => {
        if (audioRunTokenRef.current !== runToken) return;
        setAudioPlaying(true);
      };
      audio.onpause = () => {
        if (audioRunTokenRef.current !== runToken) return;
        setAudioPlaying(false);
      };
      audio.onended = () => {
        if (audioRunTokenRef.current !== runToken) return;
        setAudioPlaying(false);
        setAudioCurrentTime(audio.duration || 0);
      };
      audio.onerror = () => {
        triggerFallback();
      };

      setAudioError(null);
      setActiveAudioMode(mode);
      try {
        await audio.play();
      } catch {
        triggerFallback();
      }
    },
    [clearSpeechTimers, detachAndStopAudioElement]
  );

  const handlePlayNoorAlBayan = async (overrideSegment?: BookTextSegment) => {
    const targetSeg = overrideSegment || selectedSegment;
    if (!targetSeg) return;
    const callToken = ++audioRunTokenRef.current;
    setAudioError(null);
    setAudioLoadingMode('noor_albayan');
    setNoorLoading(true);
    try {
      const cacheKey = `noor_v2_${targetSeg.text}`;
      const cached = await getCachedAudioEntry(cacheKey);
      if (audioRunTokenRef.current !== callToken) return;

      if (cached && cached.base64Wav && cached.base64Wav.length > 120) {
        const displayWord = cached.diacritizedWord || targetSeg.text;
        const script = cached.fullReading || displayWord;
        setNoorSteps(cached.steps || []);
        setNoorFullReading(script);
        setNoorDiacritizedWord(displayWord);
        setNoorAutoDiacritized(Boolean(cached.wasAutoDiacritized));
        const url = base64AudioToObjectUrl(cached.base64Wav, cached.mimeType);
        await playAudioSource(
          'noor_albayan',
          url,
          true,
          () => playBrowserSpeech('noor_albayan', script),
          cacheKey
        );
        return;
      }

      const breakdown = await generateNoorAlBayanOnServer({
        text: targetSeg.text,
        surahName: targetSeg.surahName,
      });
      if (audioRunTokenRef.current !== callToken) return;

      setNoorDiacritizedWord(breakdown.diacritizedWord);
      setNoorAutoDiacritized(breakdown.wasAutoDiacritized);
      setNoorSteps(breakdown.steps);
      setNoorFullReading(breakdown.fullReading);

      const speechScript =
        breakdown.fullReading ||
        `${breakdown.steps.map((s) => s.reading).join(' ، ')} ، ${breakdown.diacritizedWord}`;

      const tts = await synthesizeSpeechOnServer({
        text: speechScript,
        mode: 'noor_albayan',
      });
      if (audioRunTokenRef.current !== callToken) return;

      if (tts.engine === 'browser_speech') {
        playBrowserSpeech('noor_albayan', tts.text);
        return;
      }

      await saveCachedAudioEntry({
        key: cacheKey,
        base64Wav: tts.audioBase64,
        mimeType: tts.mimeType,
        diacritizedWord: breakdown.diacritizedWord,
        wasAutoDiacritized: breakdown.wasAutoDiacritized,
        steps: breakdown.steps,
        fullReading: speechScript,
        updatedAtMs: Date.now(),
      });

      const url = base64AudioToObjectUrl(tts.audioBase64, tts.mimeType);
      await playAudioSource(
        'noor_albayan',
        url,
        true,
        () => playBrowserSpeech('noor_albayan', speechScript),
        cacheKey
      );
    } catch {
      // Ultimate guarantee: Noor Al-Bayan NEVER deadlocks!
      const fallback = await generateNoorAlBayanOnServer({
        text: targetSeg.text,
        surahName: targetSeg.surahName,
      }).catch(() => null);
      if (fallback) {
        setNoorDiacritizedWord(fallback.diacritizedWord);
        setNoorAutoDiacritized(fallback.wasAutoDiacritized);
        setNoorSteps(fallback.steps);
        setNoorFullReading(fallback.fullReading);
        playBrowserSpeech('noor_albayan', fallback.fullReading);
      } else {
        playBrowserSpeech('noor_albayan', targetSeg.text);
      }
    } finally {
      setNoorLoading(false);
      setAudioLoadingMode(null);
    }
  };

  const handlePlaySingleNoorStep = (step: NoorAlBayanStep) => {
    const line = `${step.ruleLabel}، ${step.reading}`;
    playBrowserSpeech('noor_albayan', line);
  };

  const handlePlayNormalReading = async () => {
    if (!selectedSegment) return;
    const callToken = ++audioRunTokenRef.current;
    setAudioError(null);
    setAudioLoadingMode('normal');
    try {
      const cacheKey = `normal_v2_${selectedSegment.text}`;
      const cached = await getCachedAudioEntry(cacheKey);
      if (audioRunTokenRef.current !== callToken) return;

      if (cached && cached.base64Wav && cached.base64Wav.length > 120) {
        const url = base64AudioToObjectUrl(cached.base64Wav, cached.mimeType);
        await playAudioSource(
          'normal',
          url,
          true,
          () => playBrowserSpeech('normal', cached.fullReading || selectedSegment.text),
          cacheKey
        );
        return;
      }

      const tts = await synthesizeSpeechOnServer({
        text: selectedSegment.text,
        mode: 'normal',
      });
      if (audioRunTokenRef.current !== callToken) return;

      if (tts.engine === 'browser_speech') {
        playBrowserSpeech('normal', tts.text);
        return;
      }

      await saveCachedAudioEntry({
        key: cacheKey,
        base64Wav: tts.audioBase64,
        mimeType: tts.mimeType,
        fullReading: tts.text,
        updatedAtMs: Date.now(),
      });

      const url = base64AudioToObjectUrl(tts.audioBase64, tts.mimeType);
      await playAudioSource(
        'normal',
        url,
        true,
        () => playBrowserSpeech('normal', tts.text),
        cacheKey
      );
    } catch {
      playBrowserSpeech('normal', selectedSegment.text);
    } finally {
      setAudioLoadingMode(null);
    }
  };

  const handlePlaySheikhAyah = async (overrideReciterId?: string) => {
    if (!selectedSegment) return;
    if (
      !selectedSegment.surahNumber ||
      !selectedSegment.ayahNumber
    ) {
      setAudioError('لم يتم تحديد رقم السورة والآية لهذه الكلمة؛ جرّب القراءة العادية أو التهجي.');
      return;
    }
    const reciterId = overrideReciterId || selectedReciterId;
    const reciter =
      QURAN_RECITERS.find((r) => r.id === reciterId) || QURAN_RECITERS[0];
    setAudioError(null);
    setAudioLoadingMode('sheikh');
    try {
      const url = getReciterAyahAudioUrl(
        reciter.everyAyahFolder,
        selectedSegment.surahNumber,
        selectedSegment.ayahNumber
      );
      await playAudioSource('sheikh', url, false, () => {
        playBrowserSpeech('normal', selectedSegment.text);
      });
    } catch {
      playBrowserSpeech('normal', selectedSegment.text);
    } finally {
      setAudioLoadingMode(null);
    }
  };

  const handlePauseAudio = () => {
    if (speechStateRef.current.active && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.pause();
      speechStateRef.current.elapsedBeforePauseMs +=
        Date.now() - speechStateRef.current.startedAtMs;
      clearSpeechTimers();
      setAudioPlaying(false);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
  };

  const handleResumeAudio = async () => {
    if (speechStateRef.current.active && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        speechStateRef.current.startedAtMs = Date.now();
        setAudioPlaying(true);
      } else {
        playBrowserSpeech(
          speechStateRef.current.mode,
          speechStateRef.current.text,
          speechStateRef.current.chunkIndex
        );
      }
      return;
    }
    if (audioRef.current && audioRef.current.src) {
      await audioRef.current.play().catch(() => {
        if (selectedSegment) {
          playBrowserSpeech(activeAudioMode || 'normal', selectedSegment.text);
        }
      });
    }
  };

  const handleRestartAudio = async () => {
    if (speechStateRef.current.active || speechStateRef.current.text) {
      if (!audioRef.current?.src) {
        playBrowserSpeech(
          speechStateRef.current.mode,
          speechStateRef.current.text || selectedSegment?.text || ''
        );
        return;
      }
    }
    if (audioRef.current && audioRef.current.src) {
      audioRef.current.currentTime = 0;
      setAudioCurrentTime(0);
      await audioRef.current.play().catch(() => {
        if (selectedSegment) {
          playBrowserSpeech(activeAudioMode || 'normal', selectedSegment.text);
        }
      });
    }
  };

  const activeJobStats = useMemo(() => {
    if (!activeJob) return null;
    const uploaded = activeJob.pages.filter((p) => p.uploaded).length;
    const recognized = activeJob.pages.filter((p) => p.recognized).length;
    const total = Math.max(1, activeJob.totalPages);
    const uploadPct = Math.round((uploaded / total) * 100);
    const ocrPct = Math.round((recognized / total) * 100);
    return { uploaded, recognized, total, uploadPct, ocrPct };
  }, [activeJob]);

  const currentPage = readerPages[currentPageIndex] || null;
  const activeReciter =
    QURAN_RECITERS.find((r) => r.id === selectedReciterId) || QURAN_RECITERS[0];

  const handleConfirmRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingBook) return;
    setSavingRename(true);
    try {
      await renameBookInWorkspace(workspace, renamingBook.id, renameTitleVal);
      setRenamingBook(null);
      setFeedback({ type: 'ok', text: 'تم تعديل عنوان الكتاب بنجاح.' });
      await loadBooksAndJobs();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تعديل عنوان الكتاب.',
      });
    } finally {
      setSavingRename(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingBook) return;
    setConfirmingDelete(true);
    try {
      await deleteBookFromWorkspace(workspace, deletingBook.id);
      await deleteBookJobLocal(deletingBook.id);
      if (activeJob?.bookId === deletingBook.id) {
        setActiveJob(null);
      }
      if (readerBook?.id === deletingBook.id) {
        stopAndResetAudio();
        setReaderBook(null);
      }
      setDeletingBook(null);
      setFeedback({ type: 'ok', text: 'تم حذف الكتاب من المكتبة بنجاح.' });
      await loadBooksAndJobs();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حذف الكتاب.',
      });
    } finally {
      setConfirmingDelete(false);
    }
  };

  const handleReanalyzeCurrentPage = async () => {
    if (!readerBook || !currentPage || reanalyzingPage) return;
    stopAndResetAudio();
    setNoorSteps([]);
    setNoorFullReading('');
    setNoorDiacritizedWord('');
    setNoorAutoDiacritized(false);
    setReanalyzingPage(true);
    setFeedback(null);
    try {
      const analyzed = await analyzeBookPageOnServer({
        imageDataUrl: currentPage.imageDataUrl,
        pageNumber: currentPage.pageNumber,
        bookTitle: readerBook.title,
      });
      const updatedRecord: BookPageRecord = {
        ...currentPage,
        recognized: true,
        fullText: analyzed.fullText,
        segments: analyzed.segments,
      };
      await upsertBookPageRecord(workspace, updatedRecord);
      setReaderPages((prev) =>
        prev.map((p) => (p.id === updatedRecord.id ? updatedRecord : p))
      );
      setSelectedSegment(updatedRecord.segments[0] || null);
      setFeedback({
        type: 'ok',
        text: `تم إعادة التعرف على الصفحة ${currentPage.pageNumber} بدقة محسّنة (${updatedRecord.segments.length} كلمة).`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر إعادة تحليل هذه الصفحة.',
      });
    } finally {
      setReanalyzingPage(false);
    }
  };

  const handleReanalyzeBook = async (book: BookRecord) => {
    if (isRunningJob) return;
    setFeedback(null);
    try {
      const remotePages = await loadBookPages(workspace, book.id);
      if (remotePages.length === 0) {
        setFeedback({ type: 'err', text: 'لا توجد صفحات محفوظة لإعادة تحليلها.' });
        return;
      }
      const reJob: BookJobState = {
        bookId: book.id,
        complexId: book.complexId,
        title: book.title,
        fileName: book.fileName,
        fileType: book.fileType,
        totalPages: Math.max(book.totalPages, remotePages.length),
        status: 'processing',
        pages: remotePages.map((p) => ({
          pageNumber: p.pageNumber,
          imageDataUrl: p.imageDataUrl,
          width: p.width,
          height: p.height,
          uploaded: true,
          recognized: false,
          fullText: '',
          segments: [],
        })),
        updatedAtMs: Date.now(),
      };
      await saveBookJobLocal(reJob);
      setActiveJob(reJob);
      await runBookPipeline(reJob);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر بدء إعادة تحليل الكتاب.',
      });
    }
  };

  // ==================== INTERACTIVE READER VIEW ====================
  if (readerBook) {
    return (
      <div className="space-y-5">
        {/* Top Reader Bar */}
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => {
                stopAndResetAudio();
                setReaderBook(null);
              }}
              className="duo-btn-cream min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <span>العودة للمكتبة</span>
            </button>
            <div className="min-w-0">
              <h2 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] truncate">
                {readerBook.title}
              </h2>
              <p className="text-xs text-[#7D4E35] tabular-nums">
                اضغط على أي كلمة أو آية في صفحة الكتاب للمعاينة والاستماع
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {currentPage && (
              <button
                type="button"
                disabled={reanalyzingPage || loadingReader}
                onClick={() => void handleReanalyzeCurrentPage()}
                className="duo-btn-green min-h-[40px] px-3.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${reanalyzingPage ? 'animate-spin' : ''}`}
                />
                <span>{reanalyzingPage ? 'جاري التحسين...' : 'إعادة تحليل الصفحة'}</span>
              </button>
            )}

            {readerPages.length > 0 && (
              <div className="flex items-center gap-2 bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-1.5 shrink-0">
                <button
                  type="button"
                  disabled={currentPageIndex <= 0}
                  onClick={() => {
                    const nextIdx = Math.max(0, currentPageIndex - 1);
                    setCurrentPageIndex(nextIdx);
                    const first = readerPages[nextIdx]?.segments?.[0] || null;
                    if (first) handleSelectSegment(first);
                  }}
                  aria-label="الصفحة السابقة"
                  className="min-h-[38px] px-3 rounded-xl bg-white border border-[#EADBC8] text-[#4A220D] font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" />
                  <span>السابقة</span>
                </button>
                <span className="px-3 text-xs sm:text-sm font-display font-extrabold text-[#4A220D] tabular-nums whitespace-nowrap">
                  صفحة {currentPageIndex + 1} من {readerPages.length}
                </span>
                <button
                  type="button"
                  disabled={currentPageIndex >= readerPages.length - 1}
                  onClick={() => {
                    const nextIdx = Math.min(readerPages.length - 1, currentPageIndex + 1);
                    setCurrentPageIndex(nextIdx);
                    const first = readerPages[nextIdx]?.segments?.[0] || null;
                    if (first) handleSelectSegment(first);
                  }}
                  aria-label="الصفحة التالية"
                  className="min-h-[38px] px-3 rounded-xl bg-white border border-[#EADBC8] text-[#4A220D] font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <span>التالية</span>
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {feedback && (
          <div
            role="alert"
            className={`rounded-2xl border-2 px-4 py-3 text-sm font-bold flex items-center gap-2 ${
              feedback.type === 'ok'
                ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#46A302]'
                : 'bg-[#D95338]/10 border-[#D95338]/40 text-[#D95338]'
            }`}
          >
            {feedback.type === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        {loadingReader ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8">
            <ModernLoader label="جاري فتح صفحات الكتاب التفاعلي..." />
          </div>
        ) : !currentPage ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8 text-center text-sm text-[#7D4E35]">
            لا توجد صفحات جاهزة للعرض في هذا الكتاب بعد.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left / Right Main Book Canvas + Interactive Overlays */}
            <div className="lg:col-span-7 space-y-4">
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-3 sm:p-4">
                <div className="relative w-full overflow-hidden rounded-2xl border border-[#EADBC8] bg-[#FDF6EE]">
                  <img
                    src={currentPage.imageDataUrl}
                    alt={`صفحة ${currentPage.pageNumber} من ${readerBook.title}`}
                    className="w-full h-auto block select-none"
                  />
                  {/* Clickable Hotspots right over original words */}
                  {currentPage.segments.map((seg) => {
                    const [ymin, xmin, ymax, xmax] = seg.box;
                    const top = Math.max(0, Math.min(99, ymin / 10));
                    const left = Math.max(0, Math.min(99, xmin / 10));
                    const width = Math.max(2, Math.min(100 - left, (xmax - xmin) / 10));
                    const height = Math.max(2, Math.min(100 - top, (ymax - ymin) / 10));
                    const isSelected = selectedSegment?.id === seg.id;
                    return (
                      <button
                        key={seg.id}
                        type="button"
                        onClick={() => handleSelectSegment(seg)}
                        title={seg.text}
                        aria-label={seg.text}
                        style={{
                          top: `${top}%`,
                          left: `${left}%`,
                          width: `${width}%`,
                          height: `${height}%`,
                        }}
                        className={`absolute rounded-md transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-[#F56900]/25 ring-2 ring-[#F56900]'
                            : seg.kind === 'ayah'
                            ? 'hover:bg-[#58CC02]/20 hover:ring-2 hover:ring-[#58CC02]/70'
                            : 'hover:bg-[#F56900]/15 hover:ring-1 hover:ring-[#F56900]/60'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Extracted Interactive Text Strip */}
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-sm sm:text-base font-extrabold text-[#4A220D]">
                    كلمات الصفحة المتعرّف عليها ({currentPage.segments.length})
                  </h3>
                  <span className="text-xs text-[#7D4E35]">
                    اضغط على أي كلمة أو جزء آية
                  </span>
                </div>

                {currentPage.segments.length === 0 ? (
                  <p className="text-sm text-[#7D4E35]">
                    {currentPage.fullText || 'لم يتم استخراج مقاطع نصية من هذه الصفحة.'}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2 leading-loose" dir="rtl">
                    {currentPage.segments.map((seg) => {
                      const isSelected = selectedSegment?.id === seg.id;
                      return (
                        <button
                          key={seg.id}
                          type="button"
                          onClick={() => handleSelectSegment(seg)}
                          className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-base font-bold transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-[#F56900] border-[#C95200] text-white'
                              : seg.kind === 'ayah'
                              ? 'bg-[#58CC02]/10 border-[#58CC02]/40 text-[#4A220D] hover:border-[#58CC02]'
                              : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                          }`}
                        >
                          <span>{seg.text}</span>
                          {seg.kind === 'ayah' && seg.ayahNumber ? (
                            <span className="mr-1.5 text-xs opacity-80 tabular-nums">
                              ﴿{seg.ayahNumber}﴾
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Interactive Word / Ayah Reading Inspector */}
            <div className="lg:col-span-5 lg:sticky lg:top-24 space-y-4">
              {!selectedSegment ? (
                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-2">
                  <BookOpen className="w-10 h-10 text-[#F56900] mx-auto" />
                  <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                    اختر كلمة من الصفحة
                  </h3>
                  <p className="text-sm text-[#7D4E35]">
                    انقر مباشرة على أي كلمة داخل صورة الصفحة أو من قائمة الكلمات لعرض صورتها وتهجئتها وسماعها.
                  </p>
                </div>
              ) : (
                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-5">
                  <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#F7EBDD]">
                    <span className="font-display text-sm font-extrabold text-[#F56900]">
                      {selectedSegment.kind === 'ayah'
                        ? `آية قرآنية${
                            selectedSegment.surahName ? ` · سورة ${selectedSegment.surahName}` : ''
                          }${selectedSegment.ayahNumber ? ` (${selectedSegment.ayahNumber})` : ''}`
                        : 'كلمة / جملة قرائية'}
                    </span>
                    <Sparkles className="w-4 h-4 text-[#F56900]" />
                  </div>

                  {/* Cropped word image from the actual book page */}
                  <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3 text-center">
                    <p className="text-[11px] font-bold text-[#7D4E35]">
                      صورة الكلمة من صفحة الكتاب الأصلية
                    </p>
                    <WordImageCropPreview
                      imageDataUrl={currentPage.imageDataUrl}
                      box={selectedSegment.box}
                      altText={selectedSegment.text}
                    />
                    <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#4A220D] pt-1 leading-relaxed">
                      {noorDiacritizedWord || selectedSegment.text}
                    </p>
                    {noorAutoDiacritized && (
                      <p className="text-[11px] font-bold text-[#46A302]">
                        تم ضبط التشكيل التلقائي لبيان النطق الصحيح للكلمة غير المشكولة
                      </p>
                    )}
                  </div>

                  {/* Primary Reading Options */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={audioLoadingMode !== null}
                      onClick={() => void handlePlayNoorAlBayan()}
                      className="duo-btn-orange min-h-[50px] px-4 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 whitespace-nowrap"
                    >
                      {audioLoadingMode === 'noor_albayan' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4 shrink-0" />
                      )}
                      <span>قراءة بالتهجي</span>
                    </button>

                    <button
                      type="button"
                      disabled={audioLoadingMode !== null}
                      onClick={() => void handlePlayNormalReading()}
                      className="duo-btn-cream min-h-[50px] px-4 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 whitespace-nowrap"
                    >
                      {audioLoadingMode === 'normal' ? (
                        <Loader2 className="w-4 h-4 animate-spin text-[#F56900]" />
                      ) : (
                        <Volume2 className="w-4 h-4 text-[#F56900] shrink-0" />
                      )}
                      <span>قراءة عادية</span>
                    </button>
                  </div>

                  {/* Option 3: Reciter Selection for Quranic Ayahs */}
                  {selectedSegment.kind === 'ayah' && (
                    <div className="bg-[#58CC02]/5 border-2 border-[#58CC02]/40 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <Headphones className="w-4 h-4 text-[#46A302] shrink-0" />
                        <p className="font-display text-sm font-extrabold text-[#4A220D]">
                          قراءة الآية بصوت الشيخ (١٠ مشايخ)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <label
                          htmlFor="reciter-select"
                          className="block text-xs font-bold text-[#7D4E35]"
                        >
                          اختر الشيخ القارئ:
                        </label>
                        <select
                          id="reciter-select"
                          value={selectedReciterId}
                          onChange={(e) => setSelectedReciterId(e.target.value)}
                          className="w-full min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
                        >
                          {QURAN_RECITERS.map((reciter, idx) => (
                            <option key={reciter.id} value={reciter.id}>
                              {idx + 1}. {reciter.name} ({reciter.style})
                            </option>
                          ))}
                        </select>
                      </div>

                      <button
                        type="button"
                        disabled={audioLoadingMode !== null}
                        onClick={() => void handlePlaySheikhAyah()}
                        className="duo-btn-green w-full min-h-[48px] px-4 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 whitespace-nowrap"
                      >
                        {audioLoadingMode === 'sheikh' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Play className="w-4 h-4 shrink-0" />
                        )}
                        <span>تشغيل الآية بصوت {activeReciter.name}</span>
                      </button>
                    </div>
                  )}

                  {/* Audio Error Banner */}
                  {audioError && (
                    <div
                      role="alert"
                      className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                    >
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{audioError}</span>
                    </div>
                  )}

                  {/* Active Audio Transport Controls (Pause / Resume from exact spot / Restart) */}
                  {(activeAudioMode !== null || audioDuration > 0 || audioCurrentTime > 0) && (
                    <div className="bg-[#FDF6EE] border-2 border-[#F56900]/40 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between gap-2 text-xs font-bold text-[#4A220D]">
                        <span>
                          {activeAudioMode === 'noor_albayan'
                            ? 'جاري التشغيل: تهجي نور البيان'
                            : activeAudioMode === 'sheikh'
                            ? `تلاوة: ${activeReciter.name}`
                            : 'جاري التشغيل: قراءة عادية'}
                        </span>
                        <span className="tabular-nums text-[#F56900]">
                          {formatAudioTime(audioCurrentTime)} / {formatAudioTime(audioDuration)}
                        </span>
                      </div>

                      <input
                        type="range"
                        min={0}
                        max={Math.max(1, audioDuration || 1)}
                        step={0.1}
                        value={Math.min(audioCurrentTime, Math.max(1, audioDuration || 1))}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (audioRef.current) {
                            audioRef.current.currentTime = val;
                          }
                          setAudioCurrentTime(val);
                        }}
                        aria-label="شريط تقدم الصوت"
                        className="w-full accent-[#F56900] cursor-pointer"
                      />

                      <div className="flex flex-wrap items-center gap-2">
                        {audioPlaying ? (
                          <button
                            type="button"
                            onClick={handlePauseAudio}
                            className="flex-1 min-h-[42px] px-3 py-2 rounded-xl bg-[#4A220D] text-white font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                          >
                            <Pause className="w-4 h-4 shrink-0" />
                            <span>إيقاف مؤقت</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleResumeAudio()}
                            className="duo-btn-green flex-1 min-h-[42px] px-3 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                          >
                            <Play className="w-4 h-4 shrink-0" />
                            <span>إكمال من حيث توقف</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => void handleRestartAudio()}
                          className="duo-btn-cream min-h-[42px] px-4 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                        >
                          <RotateCcw className="w-4 h-4 text-[#F56900] shrink-0" />
                          <span>أعِد</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Noor Al-Bayan Spelling Steps Breakdown Card */}
                  {noorLoading ? (
                    <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 text-center text-xs font-bold text-[#7D4E35] flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-[#F56900]" />
                      <span>جاري إعداد التهجي بطريقة نور البيان...</span>
                    </div>
                  ) : (
                    noorSteps.length > 0 && (
                      <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                            تفصيل التهجي (نور البيان):
                          </p>
                          <span className="text-[11px] text-[#7D4E35]">
                            اضغط على أي خطوة لسماعها
                          </span>
                        </div>
                        <div className="space-y-2">
                          {noorSteps.map((step, i) => (
                            <button
                              key={`${step.part}_${i}`}
                              type="button"
                              onClick={() => handlePlaySingleNoorStep(step)}
                              className="w-full text-right bg-white border border-[#EADBC8] hover:border-[#F56900] rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs transition-colors cursor-pointer"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-6 h-6 rounded-lg bg-[#F56900]/10 text-[#F56900] font-extrabold inline-flex items-center justify-center shrink-0 tabular-nums">
                                  {i + 1}
                                </span>
                                <span className="font-display font-extrabold text-sm text-[#4A220D] shrink-0">
                                  {step.part}
                                </span>
                                <span className="text-[#7D4E35] truncate">{step.ruleLabel}</span>
                              </div>
                              <span className="font-bold text-[#46A302] inline-flex items-center gap-1.5 shrink-0">
                                <span>{step.reading}</span>
                                <Volume2 className="w-3.5 h-3.5 text-[#F56900]" />
                              </span>
                            </button>
                          ))}
                        </div>
                        {noorFullReading && (
                          <p className="text-xs font-bold text-[#4A220D] bg-white border border-[#EADBC8] rounded-xl p-3 leading-relaxed">
                            {noorFullReading}
                          </p>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================== LIBRARY HOME & UPLOAD WORKFLOW ====================
  return (
    <div className="space-y-6">
      {/* Header + Add Book Trigger */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D]">
            الملفات والكتب الذكية
          </h2>
          <p className="text-xs sm:text-sm text-[#7D4E35] mt-0.5">
            ارفع الكتب والمناهج ليتعرف عليها النظام تلقائياً بالحركات ويوفر التهجي الصوتي وتلاوة الآيات.
          </p>
        </div>

        <button
          type="button"
          disabled={isRunningJob || extractProgress.total > 0}
          onClick={() => setShowAddForm((prev) => !prev)}
          className="duo-btn-orange min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap disabled:opacity-60"
        >
          <Plus className="w-4 h-4 shrink-0" />
          <span>أضف كتاب</span>
        </button>
      </div>

      {/* Warning if offline */}
      {!isOnline && (
        <div
          role="alert"
          className="bg-[#D95338]/10 border-2 border-[#D95338]/40 rounded-2xl px-4 py-3 text-xs sm:text-sm font-bold text-[#D95338] flex items-center gap-2.5"
        >
          <WifiOff className="w-5 h-5 shrink-0" />
          <span>
            انقطع الاتصال بالإنترنت؛ سيتم حفظ التقدم تلقائياً واستكمال الرفع والمعالجة فور عودة الاتصال.
          </span>
        </div>
      )}

      {feedback && (
        <div
          role="alert"
          className={`rounded-2xl border-2 px-4 py-3 text-sm font-bold flex items-center gap-2 ${
            feedback.type === 'ok'
              ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#46A302]'
              : 'bg-[#D95338]/10 border-[#D95338]/40 text-[#D95338]'
          }`}
        >
          {feedback.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Add Book Form */}
      {showAddForm && (
        <div className="bg-white border-2 border-[#F56900]/50 rounded-3xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
              إضافة كتاب جديد للمكتبة الذكية
            </h3>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              aria-label="إغلاق"
              className="p-1.5 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-8">
              <label
                htmlFor="new-book-title-input"
                className="block font-display text-xs font-bold text-[#4A220D] mb-1.5"
              >
                عنوان الكتاب
              </label>
              <input
                id="new-book-title-input"
                type="text"
                value={newBookTitle}
                onChange={(e) => setNewBookTitle(e.target.value)}
                placeholder="مثال: كتاب نور البيان أو القاعدة النورانية أو جزء عمّ"
                className="w-full min-h-[48px] px-4 py-2.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm font-bold text-[#4A220D] focus:outline-none focus:border-[#F56900] focus:bg-white"
              />
            </div>

            <div className="sm:col-span-4">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf,application/x-pdf,image/*"
                onChange={handleSelectBookFile}
                className="hidden"
              />
              <button
                type="button"
                disabled={newBookTitle.trim().length < 2}
                onClick={() => fileInputRef.current?.click()}
                className="duo-btn-green w-full min-h-[48px] px-4 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                <Upload className="w-4 h-4 shrink-0" />
                <span>ارفع كتاب (PDF أو صورة)</span>
              </button>
            </div>
          </div>
          <p className="text-xs text-[#7D4E35]">
            اكتب عنوان الكتاب أولاً ثم اضغط على «ارفع كتاب» لاختيار ملف PDF أو صورة صفحة الكتاب.
          </p>
        </div>
      )}

      {/* Local Extraction Progress */}
      {extractProgress.total > 0 && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-[#F56900]" />
              <span>جاري تجهيز صفحات الملف...</span>
            </span>
            <span className="font-display font-extrabold text-sm text-[#F56900] tabular-nums">
              {Math.round((extractProgress.done / Math.max(1, extractProgress.total)) * 100)}%
            </span>
          </div>
          <div className="w-full h-3 rounded-full bg-[#FDF6EE] border border-[#EADBC8] overflow-hidden">
            <div
              className="h-full bg-[#F56900] transition-all duration-300"
              style={{
                width: `${Math.round(
                  (extractProgress.done / Math.max(1, extractProgress.total)) * 100
                )}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Active Upload + AI Smart Recognition Pipeline Card */}
      {activeJob && activeJobStats && activeJob.status !== 'ready' && (
        <div className="bg-white border-2 border-[#F56900] rounded-3xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                {activeJob.title}
              </h3>
              <p className="text-xs text-[#7D4E35] tabular-nums">
                إجمالي الصفحات: {activeJobStats.total} · {activeJob.fileName}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {isRunningJob ? (
                <button
                  type="button"
                  onClick={() => {
                    pauseRequestedRef.current = true;
                    setIsRunningJob(false);
                    setActiveJob((prev) =>
                      prev ? { ...prev, status: 'paused' } : prev
                    );
                  }}
                  className="duo-btn-cream min-h-[40px] px-3.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Pause className="w-3.5 h-3.5 text-[#F56900]" />
                  <span>إيقاف مؤقت</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runBookPipeline(activeJob)}
                  className="duo-btn-orange min-h-[40px] px-4 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>استكمال من صفحة {Math.min(activeJobStats.total, activeJobStats.recognized + 1)}</span>
                </button>
              )}
            </div>
          </div>

          {/* Persistent Stay-on-Site Warning */}
          <div className="bg-[#FDF6EE] border border-[#F56900]/40 rounded-2xl px-4 py-3 text-xs sm:text-sm font-bold text-[#4A220D] flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-[#F56900] shrink-0" />
            <span>
              يرجى عدم الخروج من الموقع حتى يكتمل الرفع والتعرف الذكي على الكتاب بالكامل؛ ولو انقطع الاتصال سيعود ويكمل تلقائياً من حيث توقف.
            </span>
          </div>

          {activeJob.lastError && (
            <div className="bg-[#D95338]/10 border border-[#D95338]/40 rounded-2xl px-4 py-2.5 text-xs font-bold text-[#D95338]">
              {activeJob.lastError}
            </div>
          )}

          {/* Dual Progress Bars */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-bold text-[#4A220D]">
                <span>١. رفع صفحات الكتاب</span>
                <span className="text-[#F56900] tabular-nums">
                  {activeJobStats.uploadPct}% ({activeJobStats.uploaded} / {activeJobStats.total})
                </span>
              </div>
              <div className="w-full h-3 rounded-full bg-[#FDF6EE] border border-[#EADBC8] overflow-hidden">
                <div
                  className="h-full bg-[#F56900] transition-all duration-300"
                  style={{ width: `${activeJobStats.uploadPct}%` }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-bold text-[#4A220D]">
                <span>٢. التعرف الذكي على النصوص والآيات</span>
                <span className="text-[#46A302] tabular-nums">
                  {activeJobStats.ocrPct}% ({activeJobStats.recognized} / {activeJobStats.total})
                </span>
              </div>
              <div className="w-full h-3 rounded-full bg-[#FDF6EE] border border-[#EADBC8] overflow-hidden">
                <div
                  className="h-full bg-[#58CC02] transition-all duration-300"
                  style={{ width: `${activeJobStats.ocrPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unfinished Local Jobs Saved in IndexedDB (Resume Recovery) */}
      {!isRunningJob &&
        localJobs.filter((j) => j.bookId !== activeJob?.bookId).length > 0 && (
          <div className="bg-[#FDF6EE] border-2 border-[#F56900]/50 rounded-3xl p-4 sm:p-5 space-y-3">
            <h3 className="font-display text-base font-extrabold text-[#4A220D]">
              كتب محفوظة لم يكتمل رفعها أو معالجتها ({localJobs.filter((j) => j.bookId !== activeJob?.bookId).length})
            </h3>
            <div className="space-y-2.5">
              {localJobs
                .filter((j) => j.bookId !== activeJob?.bookId)
                .map((job) => {
                  const recCount = job.pages.filter((p) => p.recognized).length;
                  const pct = Math.round((recCount / Math.max(1, job.totalPages)) * 100);
                  return (
                    <div
                      key={job.bookId}
                      className="bg-white border border-[#EADBC8] rounded-2xl p-3.5 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div>
                        <p className="font-display font-extrabold text-sm text-[#4A220D]">
                          {job.title}
                        </p>
                        <p className="text-xs text-[#7D4E35] tabular-nums">
                          توقف عند {pct}% ({recCount} من {job.totalPages} صفحة)
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleResumeSavedJob(job)}
                        className="duo-btn-orange min-h-[40px] px-4 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>استكمال المعالجة الآن</span>
                      </button>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

      {/* Books Grid */}
      {loadingBooks ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8">
          <ModernLoader label="جاري تحميل مكتبة الكتب..." />
        </div>
      ) : books.length === 0 ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8 text-center space-y-3">
          <BookOpen className="w-12 h-12 text-[#F56900] mx-auto" />
          <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
            المكتبة فارغة حالياً
          </h3>
          <p className="text-sm text-[#7D4E35] max-w-md mx-auto">
            اضغط على زر «أضف كتاب» أعلاه لرفع أي كتاب تعليمي أو مصحف مصور، وسيتم تحويله لكتاب تفاعلي ذكي بالصوت والتهجي.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {books.map((book) => {
            const pct = Math.round(
              (book.recognizedPages / Math.max(1, book.totalPages)) * 100
            );
            const isReady = book.status === 'ready' || book.recognizedPages >= book.totalPages;

            return (
              <div
                key={book.id}
                className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="w-11 h-11 rounded-2xl bg-[#F56900]/10 text-[#F56900] flex items-center justify-center shrink-0">
                      <FileText className="w-5 h-5" />
                    </div>
                    <span
                      className={`text-xs font-display font-extrabold px-2.5 py-1 rounded-xl ${
                        isReady
                          ? 'bg-[#58CC02]/15 text-[#46A302]'
                          : 'bg-[#F56900]/15 text-[#F56900]'
                      }`}
                    >
                      {isReady ? 'تم التجهيز' : `${pct}%`}
                    </span>
                  </div>

                  <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] line-clamp-2">
                    {book.title}
                  </h3>
                  <p className="text-xs text-[#7D4E35] tabular-nums">
                    {book.totalPages} صفحة · تم التعرف على {book.recognizedPages}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#F7EBDD]">
                  {isReady ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void openBookReader(book)}
                        className="duo-btn-orange flex-1 min-h-[42px] px-3 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <BookOpen className="w-4 h-4 shrink-0" />
                        <span>معاينة وقراءة</span>
                      </button>
                      <button
                        type="button"
                        disabled={isRunningJob}
                        onClick={() => void handleReanalyzeBook(book)}
                        title="إعادة التعرف على النص بدقة محسّنة"
                        aria-label={`إعادة تحليل ${book.title}`}
                        className="min-h-[42px] px-3 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] hover:border-[#58CC02] text-xs font-bold text-[#46A302] inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleResumeSavedJob(book)}
                        className="duo-btn-orange flex-1 min-h-[42px] px-3 py-2 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                        <span>استكمال</span>
                      </button>
                      {book.uploadedPages > 0 && (
                        <button
                          type="button"
                          onClick={() => void openBookReader(book)}
                          className="duo-btn-cream min-h-[42px] px-3 py-2 rounded-xl font-display font-bold text-xs cursor-pointer whitespace-nowrap"
                        >
                          معاينة
                        </button>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setRenamingBook(book);
                      setRenameTitleVal(book.title);
                    }}
                    aria-label={`تعديل ${book.title}`}
                    className="min-h-[42px] px-3 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-[#F56900]" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeletingBook(book)}
                    aria-label={`حذف ${book.title}`}
                    className="min-h-[42px] px-3 rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] hover:bg-[#D95338]/10 text-xs font-bold text-[#D95338] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rename Modal */}
      {renamingBook &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleConfirmRename}
              className="w-full max-w-md bg-white border-2 border-[#EADBC8] rounded-3xl p-6 space-y-4 shadow-xl"
              dir="rtl"
            >
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                تعديل عنوان الكتاب
              </h3>
              <input
                type="text"
                value={renameTitleVal}
                onChange={(e) => setRenameTitleVal(e.target.value)}
                required
                className="w-full min-h-[46px] px-4 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm font-bold text-[#4A220D] focus:outline-none focus:border-[#F56900] focus:bg-white"
              />
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={savingRename}
                  className="duo-btn-orange flex-1 min-h-[44px] rounded-xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {savingRename ? 'جاري الحفظ...' : 'حفظ العنوان'}
                </button>
                <button
                  type="button"
                  disabled={savingRename}
                  onClick={() => setRenamingBook(null)}
                  className="duo-btn-cream flex-1 min-h-[44px] rounded-xl font-display font-bold text-sm cursor-pointer"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* Delete Modal */}
      {deletingBook &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
            role="dialog"
            aria-modal="true"
          >
            <div
              className="w-full max-w-sm bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4 shadow-xl"
              dir="rtl"
            >
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                حذف كتاب «{deletingBook.title}»؟
              </h3>
              <p className="text-sm text-[#7D4E35]">
                سيتم حذف الكتاب وجميع صفحاته والنصوص المستخرجة منه بشكل نهائي.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={confirmingDelete}
                  onClick={() => void handleConfirmDelete()}
                  className="flex-1 min-h-[44px] rounded-xl bg-[#D95338] text-white font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {confirmingDelete ? 'جاري الحذف...' : 'تأكيد الحذف'}
                </button>
                <button
                  type="button"
                  disabled={confirmingDelete}
                  onClick={() => setDeletingBook(null)}
                  className="duo-btn-cream flex-1 min-h-[44px] rounded-xl font-display font-bold text-sm cursor-pointer"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
