import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Database,
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
  Square,
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
  type PageOcrProgress,
} from '../services/bookStorage';
import {
  computeSegmentTahajjiContext,
  generateNoorAlBayanClientFallback,
  inferArabicDiacriticsForWord,
  isWordStartingWithHamzatWasl,
  normalizeUthmaniForTts,
} from '../services/clientArabicEngine';
import { generateValidId, getReciterAyahAudioUrl } from '../services/multiDb';
import {
  canonicalizeArabicForAudioKey,
  deleteBookFromWorkspace,
  listBooksInComplex,
  loadBookPages,
  lookupWordAudioAcrossLibrary,
  renameBookInWorkspace,
  saveWordAudioToLibraryDb,
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
  const [pageOcrProgress, setPageOcrProgress] = useState<PageOcrProgress | null>(null);
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
  const [wordAudioStatus, setWordAudioStatus] = useState<string | null>(null);

  // Continuous Reading Mode State (القراءة المتواصلة ووضع البداية والنهاية التجميعي)
  const [continuousMode, setContinuousMode] = useState<
    'noor_albayan' | 'cumulative_tahajji' | 'normal'
  >('noor_albayan');
  const [continuousStartId, setContinuousStartId] = useState<string>('');
  const [continuousEndId, setContinuousEndId] = useState<string>('');
  const [pickingBoundary, setPickingBoundary] = useState<'start' | 'end' | null>(null);
  const [continuousAutoNextPage, setContinuousAutoNextPage] = useState(true);
  const [continuousStatus, setContinuousStatus] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [continuousProgress, setContinuousProgress] = useState<{
    currentIndex: number;
    totalCount: number;
    wordText: string;
    pageNumber: number;
    sourceLabel: string;
    cumulativePhrase?: string;
  } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeObjectUrlRef = useRef<string | null>(null);
  const audioLoadWatchdogRef = useRef<number | null>(null);
  const audioRunTokenRef = useRef<number>(0);
  const audioRequestTokenRef = useRef<number>(0);
  const continuousTokenRef = useRef<number>(0);
  const continuousPausedRef = useRef<boolean>(false);
  const continuousPositionRef = useRef<{
    pageIndex: number;
    segIndex: number;
    mode: 'noor_albayan' | 'cumulative_tahajji' | 'normal';
    anchorPageIndex: number;
    anchorSegIndex: number;
    endSegId: string;
  }>({
    pageIndex: 0,
    segIndex: 0,
    mode: 'noor_albayan',
    anchorPageIndex: 0,
    anchorSegIndex: 0,
    endSegId: '',
  });
  const wordChipRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const prefetchMapRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const phrasePrefetchMapRef = useRef<
    Map<
      string,
      Promise<{
        base64Wav: string;
        mimeType: string;
        cacheKey: string;
        error?: string;
        retryAfterMs?: number;
      }>
    >
  >(new Map());

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

  // Clean up audio element & ObjectURLs on unmount
  useEffect(() => {
    return () => {
      continuousTokenRef.current++;
      audioRequestTokenRef.current++;
      audioRunTokenRef.current++;
      if (audioLoadWatchdogRef.current !== null) {
        window.clearTimeout(audioLoadWatchdogRef.current);
      }
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
      setPageOcrProgress(null);
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

          setPageOcrProgress({
            pageNumber: page.pageNumber,
            pagePercent: 1,
            stageText: `جاري تجهيز الصفحة ${page.pageNumber} لبدء التعرف الذكي...`,
          });

          const analyzed = await analyzeBookPageOnServer({
            imageDataUrl: page.imageDataUrl,
            ocrImageDataUrl: page.ocrImageDataUrl,
            pageNumber: page.pageNumber,
            bookTitle: workingJob.title,
            embeddedSegments: page.embeddedSegments,
            onProgress: (prog) => {
              if (activeRunIdRef.current === runId && !pauseRequestedRef.current) {
                setPageOcrProgress(prog);
              }
            },
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
          setPageOcrProgress(null);
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

  const detachAndStopAudioElement = useCallback(() => {
    if (audioLoadWatchdogRef.current !== null) {
      window.clearTimeout(audioLoadWatchdogRef.current);
      audioLoadWatchdogRef.current = null;
    }
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
    audioRequestTokenRef.current++;
    audioRunTokenRef.current++;
    detachAndStopAudioElement();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
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
    setAudioLoadingMode(null);
    setNoorLoading(false);
  }, [detachAndStopAudioElement]);

  const stopContinuousReading = useCallback(() => {
    continuousTokenRef.current++;
    continuousPausedRef.current = false;
    setPickingBoundary(null);
    setContinuousStatus('idle');
    setContinuousProgress(null);
    stopAndResetAudio();
  }, [stopAndResetAudio]);

  const openBookReader = async (book: BookRecord) => {
    continuousTokenRef.current++;
    setContinuousStatus('idle');
    setContinuousProgress(null);
    setPickingBoundary(null);
    stopAndResetAudio();
    setSelectedSegment(null);
    setContinuousStartId('');
    setContinuousEndId('');
    setNoorSteps([]);
    setNoorFullReading('');
    setNoorDiacritizedWord('');
    setNoorAutoDiacritized(false);
    setWordAudioStatus(null);
    setReaderBook(book);
    setCurrentPageIndex(0);
    setLoadingReader(true);
    try {
      const pages = await loadBookPages(workspace, book.id);
      setReaderPages(pages);
      const firstSeg = pages[0]?.segments?.[0] || null;
      setSelectedSegment(firstSeg);
      if (firstSeg) {
        setContinuousStartId(firstSeg.id);
      }
    } catch {
      setFeedback({ type: 'err', text: 'تعذّر تحميل صفحات الكتاب.' });
    } finally {
      setLoadingReader(false);
    }
  };

  const handleSelectSegment = (seg: BookTextSegment) => {
    const activeSegs = readerPages[currentPageIndex]?.segments || [];
    if (pickingBoundary === 'start') {
      const pickedIdx = activeSegs.findIndex((s) => s.id === seg.id);
      const endIdx = continuousEndId ? activeSegs.findIndex((s) => s.id === continuousEndId) : -1;
      setContinuousStartId(seg.id);
      if (endIdx >= 0 && pickedIdx > endIdx) {
        setContinuousEndId('');
      }
      setSelectedSegment(seg);
      setPickingBoundary(null);
      setAudioError(null);
      return;
    }
    if (pickingBoundary === 'end') {
      const pickedIdx = activeSegs.findIndex((s) => s.id === seg.id);
      const startIdx = continuousStartId
        ? activeSegs.findIndex((s) => s.id === continuousStartId)
        : -1;
      setContinuousEndId(seg.id);
      if (startIdx < 0 || startIdx > pickedIdx) {
        setContinuousStartId(seg.id);
        setSelectedSegment(seg);
      }
      setPickingBoundary(null);
      setAudioError(null);
      return;
    }

    if (continuousStatus !== 'idle') {
      stopContinuousReading();
    } else {
      stopAndResetAudio();
    }
    setSelectedSegment(seg);
    setContinuousStartId(seg.id);
    if (continuousEndId) {
      const pickedIdx = activeSegs.findIndex((s) => s.id === seg.id);
      const endIdx = activeSegs.findIndex((s) => s.id === continuousEndId);
      if (endIdx >= 0 && pickedIdx > endIdx) {
        setContinuousEndId('');
      }
    }
    setNoorSteps([]);
    setNoorFullReading('');
    setNoorDiacritizedWord('');
    setNoorAutoDiacritized(false);
    setWordAudioStatus(null);
    setAudioError(null);
  };

  const playAudioSource = useCallback(
    async (
      mode: AudioMode,
      url: string,
      isObjectUrl: boolean,
      onPlaybackError?: () => void,
      badCacheKey?: string,
      onEndedCallback?: () => void
    ) => {
      const runToken = ++audioRunTokenRef.current;
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

      let errorHandled = false;
      let endedHandled = false;
      let startedPlaying = false;
      const clearLoadWatchdog = () => {
        if (audioLoadWatchdogRef.current !== null) {
          window.clearTimeout(audioLoadWatchdogRef.current);
          audioLoadWatchdogRef.current = null;
        }
      };

      const triggerPlaybackError = () => {
        if (errorHandled || endedHandled || audioRunTokenRef.current !== runToken) return;
        errorHandled = true;
        clearLoadWatchdog();
        detachAndStopAudioElement();
        if (badCacheKey) {
          void deleteCachedAudioEntry(badCacheKey);
        }
        setAudioPlaying(false);
        setAudioError('تعذّر تشغيل الملف الصوتي حالياً؛ يرجى الانتظار لحين استعادة الصوت تلقائياً.');
        onPlaybackError?.();
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
        startedPlaying = true;
        clearLoadWatchdog();
        setAudioCurrentTime(audio.currentTime || 0);
        if (Number.isFinite(audio.duration)) {
          setAudioDuration(audio.duration);
        }
      };
      audio.onplay = () => {
        if (audioRunTokenRef.current !== runToken) return;
        startedPlaying = true;
        clearLoadWatchdog();
        setAudioPlaying(true);
      };
      audio.onpause = () => {
        if (audioRunTokenRef.current !== runToken) return;
        setAudioPlaying(false);
      };
      audio.onended = () => {
        if (endedHandled || audioRunTokenRef.current !== runToken) return;
        endedHandled = true;
        clearLoadWatchdog();
        setAudioPlaying(false);
        setAudioCurrentTime(audio.duration || 0);
        onEndedCallback?.();
      };
      audio.onerror = () => {
        triggerPlaybackError();
      };

      // Watchdog prevents silent <audio> stall if codec/stream never starts playing within 8 seconds
      audioLoadWatchdogRef.current = window.setTimeout(() => {
        if (audioRunTokenRef.current === runToken && !startedPlaying && audio.paused) {
          triggerPlaybackError();
        }
      }, 8000);

      setAudioError(null);
      setActiveAudioMode(mode);
      try {
        await audio.play();
      } catch {
        triggerPlaybackError();
      }
    },
    [detachAndStopAudioElement]
  );

  // Strictly waits until the HTMLAudioElement finishes reading the entire clip before returning
  const playAudioStrict = useCallback(
    (
      mode: AudioMode,
      url: string,
      badCacheKey: string | undefined,
      isCancelled: () => boolean
    ): Promise<'ended' | 'error' | 'cancelled'> => {
      return new Promise((resolve) => {
        let settled = false;
        let guardId: number | null = null;
        const finish = (outcome: 'ended' | 'error' | 'cancelled') => {
          if (settled) return;
          settled = true;
          if (guardId !== null) {
            window.clearInterval(guardId);
            guardId = null;
          }
          resolve(outcome);
        };

        void playAudioSource(
          mode,
          url,
          true,
          () => finish('error'),
          badCacheKey,
          () => finish('ended')
        );

        let lastTime = -1;
        let stalledSince = 0;
        guardId = window.setInterval(() => {
          if (settled) return;
          if (isCancelled()) {
            finish('cancelled');
            return;
          }
          const audio = audioRef.current;
          if (!audio) {
            finish('ended');
            return;
          }
          if (audio.ended) {
            finish('ended');
            return;
          }
          const ct = audio.currentTime || 0;
          if (!audio.paused || ct !== lastTime) {
            lastTime = ct;
            stalledSince = 0;
            return;
          }
          if (!audio.src) {
            finish('ended');
            return;
          }
          if (stalledSince === 0) {
            stalledSince = Date.now();
          } else if (Date.now() - stalledSince > 18000) {
            finish('error');
          }
        }, 450);
      });
    },
    [playAudioSource]
  );

  const waitWithCancellation = useCallback(
    async (
      totalMs: number,
      isCancelled: () => boolean,
      onTick?: (remainingSeconds: number) => void
    ): Promise<boolean> => {
      const totalSeconds = Math.max(1, Math.ceil(totalMs / 1000));
      for (let rem = totalSeconds; rem >= 1; rem--) {
        if (isCancelled()) return false;
        onTick?.(rem);
        await new Promise<void>((r) => window.setTimeout(r, 1000));
      }
      return !isCancelled();
    },
    []
  );

  interface ResolvedWordAudio {
    cacheKey: string;
    source: 'local' | 'db' | 'generated';
    audioBase64: string;
    mimeType: string;
    diacritizedWord: string;
    wasAutoDiacritized: boolean;
    steps: NoorAlBayanStep[];
    fullReading: string;
    ttsError?: string;
    ttsRetryAfterMs?: number;
  }

  const getSegmentContext = useCallback(
    (seg: BookTextSegment, overrideSegments?: BookTextSegment[]) => {
      const list =
        overrideSegments && overrideSegments.length > 0
          ? overrideSegments
          : readerPages[currentPageIndex]?.segments || [];
      const idx = list.findIndex((s) => s.id === seg.id);
      if (idx < 0) {
        return {
          nextWord: undefined as string | undefined,
          isEndOfAyah: seg.kind === 'ayah',
          contextSuffix: seg.kind === 'ayah' ? '_waqf' : '',
        };
      }
      const { nextWord, isEndOfAyah } = computeSegmentTahajjiContext(list, idx);
      const contextSuffix = isEndOfAyah
        ? '_waqf'
        : isWordStartingWithHamzatWasl(nextWord)
        ? '_wasl'
        : '';
      return { nextWord, isEndOfAyah, contextSuffix };
    },
    [currentPageIndex, readerPages]
  );

  const resolveSegmentAudio = useCallback(
    async (
      seg: BookTextSegment,
      mode: 'noor_albayan' | 'normal',
      options?: { callToken?: number; showUi?: boolean; segments?: BookTextSegment[] }
    ): Promise<ResolvedWordAudio> => {
      const normalizedText =
        canonicalizeArabicForAudioKey(seg.text) || seg.text.trim().replace(/\s+/g, ' ');
      const ctx = getSegmentContext(seg, options?.segments);
      const contextSuffix = mode === 'noor_albayan' ? ctx.contextSuffix : '';
      const cacheKey = `${
        mode === 'noor_albayan' ? `fath_v4${contextSuffix}` : 'normal_v2'
      }_${normalizedText}`;

      const applyBreakdownUi = (data: {
        diacritizedWord: string;
        wasAutoDiacritized: boolean;
        steps: NoorAlBayanStep[];
        fullReading: string;
        sourceLabel?: string;
      }) => {
        if (options?.callToken !== undefined && audioRequestTokenRef.current !== options.callToken) {
          return;
        }
        if (mode === 'noor_albayan') {
          setNoorDiacritizedWord(data.diacritizedWord);
          setNoorAutoDiacritized(data.wasAutoDiacritized);
          setNoorSteps(data.steps);
          setNoorFullReading(data.fullReading);
        }
        if (options?.showUi && data.sourceLabel) {
          setWordAudioStatus(data.sourceLabel);
        }
      };

      // Instant local breakdown on Tahajji click so UI never freezes on spinner
      const instantLocal =
        mode === 'noor_albayan'
          ? generateNoorAlBayanClientFallback(seg.text, {
              nextWord: ctx.nextWord,
              isEndOfAyah: ctx.isEndOfAyah,
            })
          : null;
      if (instantLocal && options?.showUi) {
        applyBreakdownUi({
          diacritizedWord: instantLocal.diacritizedWord,
          wasAutoDiacritized: instantLocal.wasAutoDiacritized,
          steps: instantLocal.steps,
          fullReading: instantLocal.fullReading,
        });
      }

      // 1. Check local IndexedDB cache
      const localCached = await getCachedAudioEntry(cacheKey);
      if (localCached && localCached.base64Wav && localCached.base64Wav.length > 120) {
        const diacritizedWord =
          localCached.diacritizedWord || instantLocal?.diacritizedWord || seg.text;
        const fullReading =
          localCached.fullReading || instantLocal?.fullReading || diacritizedWord;
        const steps = localCached.steps || instantLocal?.steps || [];
        const wasAutoDiacritized = Boolean(
          localCached.wasAutoDiacritized ?? instantLocal?.wasAutoDiacritized
        );
        applyBreakdownUi({
          diacritizedWord,
          wasAutoDiacritized,
          steps,
          fullReading,
          sourceLabel: 'محفوظة مسبقاً (تشغيل فوري من القاعدة)',
        });
        return {
          cacheKey,
          source: 'local',
          audioBase64: localCached.base64Wav,
          mimeType: localCached.mimeType || 'audio/wav',
          diacritizedWord,
          wasAutoDiacritized,
          steps,
          fullReading,
        };
      }

      // 2. Search across ALL shards of `library` DB (active + older filled shards)
      const dbHit = await lookupWordAudioAcrossLibrary(workspace, mode, seg.text, contextSuffix);
      if (dbHit) {
        const diacritizedWord =
          dbHit.diacritizedWord || instantLocal?.diacritizedWord || seg.text;
        const fullReading =
          dbHit.fullReading || instantLocal?.fullReading || diacritizedWord;
        const steps =
          dbHit.steps && dbHit.steps.length > 0 ? dbHit.steps : instantLocal?.steps || [];
        const wasAutoDiacritized = Boolean(
          dbHit.wasAutoDiacritized ?? instantLocal?.wasAutoDiacritized
        );

        if (dbHit.audioBase64 && dbHit.audioBase64.length > 120) {
          await saveCachedAudioEntry({
            key: cacheKey,
            base64Wav: dbHit.audioBase64,
            mimeType: dbHit.mimeType || 'audio/wav',
            diacritizedWord,
            wasAutoDiacritized,
            steps,
            fullReading,
            updatedAtMs: Date.now(),
          });
          applyBreakdownUi({
            diacritizedWord,
            wasAutoDiacritized,
            steps,
            fullReading,
            sourceLabel: 'تم جلب الصوت المحفوظ من قاعدة المكتبة مباشرة',
          });
          return {
            cacheKey,
            source: 'db',
            audioBase64: dbHit.audioBase64,
            mimeType: dbHit.mimeType || 'audio/wav',
            diacritizedWord,
            wasAutoDiacritized,
            steps,
            fullReading,
          };
        }
      }

      // 3. Deduplicate concurrent resolution / prefetch for identical (mode + word + context)
      const existingInFlight = prefetchMapRef.current.get(cacheKey) as
        | Promise<ResolvedWordAudio>
        | undefined;
      if (existingInFlight) {
        const res = await existingInFlight;
        applyBreakdownUi({
          diacritizedWord: res.diacritizedWord,
          wasAutoDiacritized: res.wasAutoDiacritized,
          steps: res.steps,
          fullReading: res.fullReading,
          sourceLabel:
            res.audioBase64 && res.audioBase64.length > 120
              ? res.source === 'generated'
                ? 'تم التوليد والحفظ تلقائياً في قاعدة المكتبة النشطة'
                : 'محفوظة مسبقاً'
              : 'هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار...',
        });
        return res;
      }

      const workPromise = (async (): Promise<ResolvedWordAudio> => {
        let diacritizedWord = instantLocal?.diacritizedWord || seg.text;
        let wasAutoDiacritized = instantLocal?.wasAutoDiacritized || false;
        let steps: NoorAlBayanStep[] = instantLocal?.steps || [];
        let fullReading = instantLocal?.fullReading || seg.text;

        if (mode === 'noor_albayan') {
          const breakdown = await generateNoorAlBayanOnServer({
            text: seg.text,
            surahName: seg.surahName,
            nextWord: ctx.nextWord,
            isEndOfAyah: ctx.isEndOfAyah,
          }).catch(() => null);
          if (breakdown) {
            diacritizedWord = breakdown.diacritizedWord;
            wasAutoDiacritized = breakdown.wasAutoDiacritized;
            steps = breakdown.steps;
            fullReading =
              breakdown.fullReading ||
              breakdown.steps.map((s) => s.reading).join(' ، ') ||
              breakdown.diacritizedWord;
          }
          if (options?.showUi) {
            applyBreakdownUi({
              diacritizedWord,
              wasAutoDiacritized,
              steps,
              fullReading,
            });
          }
        }

        const tts = await synthesizeSpeechOnServer({
          text: fullReading,
          mode,
        });

        const audioBase64 = tts.engine === 'server_wav' ? tts.audioBase64 : '';
        const mimeType = tts.mimeType || 'audio/wav';

        if (audioBase64 && audioBase64.length > 120) {
          await saveCachedAudioEntry({
            key: cacheKey,
            base64Wav: audioBase64,
            mimeType,
            diacritizedWord,
            wasAutoDiacritized,
            steps,
            fullReading,
            updatedAtMs: Date.now(),
          });

          // Only persist completed audio into library DB shards so failed/busy attempts never save empty audio
          void saveWordAudioToLibraryDb({
            workspace,
            mode,
            wordText: seg.text,
            diacritizedWord,
            wasAutoDiacritized,
            fullReading,
            steps,
            audioBase64,
            mimeType,
            createdBy: currentUserId,
            contextSuffix,
          });
        }

        return {
          cacheKey,
          source: 'generated',
          audioBase64,
          mimeType,
          diacritizedWord,
          wasAutoDiacritized,
          steps,
          fullReading: tts.text || fullReading,
          ttsError: tts.engine === 'unavailable' ? tts.error : undefined,
          ttsRetryAfterMs: tts.engine === 'unavailable' ? tts.retryAfterMs : undefined,
        };
      })();

      prefetchMapRef.current.set(cacheKey, workPromise);
      try {
        const result = await workPromise;
        applyBreakdownUi({
          diacritizedWord: result.diacritizedWord,
          wasAutoDiacritized: result.wasAutoDiacritized,
          steps: result.steps,
          fullReading: result.fullReading,
          sourceLabel:
            result.audioBase64.length > 120
              ? 'تم إنشاء الصوت وحفظه تلقائياً في قاعدة المكتبة النشطة'
              : 'هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحين الاستعادة تلقائياً...',
        });
        return result;
      } finally {
        prefetchMapRef.current.delete(cacheKey);
      }
    },
    [currentUserId, getSegmentContext, workspace]
  );

  const handlePlayNoorAlBayan = async (overrideSegment?: BookTextSegment) => {
    const targetSeg = overrideSegment || selectedSegment;
    if (!targetSeg) return;
    if (continuousStatus !== 'idle') {
      continuousTokenRef.current++;
      continuousPausedRef.current = false;
      setContinuousStatus('idle');
      setContinuousProgress(null);
    }
    const callToken = ++audioRequestTokenRef.current;
    detachAndStopAudioElement();
    setAudioError(null);
    setAudioLoadingMode('noor_albayan');
    setNoorLoading(true);

    const isCancelled = () => audioRequestTokenRef.current !== callToken;

    try {
      const maxAttempts = 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isCancelled()) return;
        const resolved = await resolveSegmentAudio(targetSeg, 'noor_albayan', {
          callToken,
          showUi: true,
        });
        if (isCancelled()) return;

        if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
          setAudioError(null);
          setNoorLoading(false);
          setAudioLoadingMode(null);
          const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
          await playAudioSource(
            'noor_albayan',
            url,
            true,
            () => {
              if (!isCancelled()) {
                setAudioError('تعذّر تشغيل الصوت حالياً؛ يرجى الانتظار لحظات والمحاولة مجدداً.');
              }
            },
            resolved.cacheKey
          );
          return;
        }

        if (attempt >= maxAttempts) {
          setAudioError(
            resolved.ttsError ||
              'لا يزال هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار قليلاً ثم الضغط على «قراءة بالتهجي» مرة أخرى.'
          );
          return;
        }

        const waitMs = Math.max(4000, Math.min(20000, resolved.ttsRetryAfterMs || 8000));
        const ok = await waitWithCancellation(waitMs, isCancelled, (remSec) => {
          setAudioError(
            `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${attempt} — إعادة خلال ${remSec} ث)...`
          );
        });
        if (!ok) return;
      }
    } catch {
      if (!isCancelled()) {
        setAudioError('هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار ثم إعادة المحاولة.');
      }
    } finally {
      if (audioRequestTokenRef.current === callToken) {
        setNoorLoading(false);
        setAudioLoadingMode(null);
      }
    }
  };

  const resolveConnectedPhraseAudio = useCallback(
    async (
      phraseText: string
    ): Promise<{
      base64Wav: string;
      mimeType: string;
      cacheKey: string;
      error?: string;
      retryAfterMs?: number;
    }> => {
      const cleanPhrase = normalizeUthmaniForTts(phraseText) || phraseText.trim();
      if (!cleanPhrase) {
        return { base64Wav: '', mimeType: 'audio/wav', cacheKey: 'phrase_empty' };
      }
      const cacheKey = `phrase_v4_${cleanPhrase}`;
      const local = await getCachedAudioEntry(cacheKey);
      if (local?.base64Wav && local.base64Wav.length > 120) {
        return {
          base64Wav: local.base64Wav,
          mimeType: local.mimeType || 'audio/wav',
          cacheKey,
        };
      }
      const existing = phrasePrefetchMapRef.current.get(cacheKey);
      if (existing) return existing;

      const work = (async () => {
        try {
          const tts = await synthesizeSpeechOnServer({
            text: cleanPhrase,
            mode: 'normal',
          });
          if (tts.engine === 'server_wav' && tts.audioBase64.length > 120) {
            await saveCachedAudioEntry({
              key: cacheKey,
              base64Wav: tts.audioBase64,
              mimeType: tts.mimeType || 'audio/wav',
              diacritizedWord: cleanPhrase,
              fullReading: cleanPhrase,
              updatedAtMs: Date.now(),
            });
            return {
              base64Wav: tts.audioBase64,
              mimeType: tts.mimeType || 'audio/wav',
              cacheKey,
            };
          }
          return {
            base64Wav: '',
            mimeType: 'audio/wav',
            cacheKey,
            error: tts.error,
            retryAfterMs: tts.retryAfterMs,
          };
        } catch {
          return {
            base64Wav: '',
            mimeType: 'audio/wav',
            cacheKey,
            error: 'هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحين استعادة القراءة تلقائياً.',
            retryAfterMs: 8000,
          };
        }
      })();

      phrasePrefetchMapRef.current.set(cacheKey, work);
      try {
        return await work;
      } finally {
        phrasePrefetchMapRef.current.delete(cacheKey);
      }
    },
    []
  );

  const handlePlaySingleNoorStep = useCallback(
    async (step: NoorAlBayanStep) => {
      if (continuousStatus !== 'idle') {
        stopContinuousReading();
      }
      const bareShortVowelLabels = new Set(['فتحة', 'ضمة', 'كسرة', 'حرف متحرك']);
      const silentAlifLabels =
        step.ruleLabel.includes('تسقط وصلاً') ||
        step.ruleLabel.includes('لا يُنطق') ||
        step.ruleLabel.includes('لا تُنطق');

      let rawLine: string;
      if (!step.ruleLabel || bareShortVowelLabels.has(step.ruleLabel)) {
        rawLine = step.reading;
      } else if (
        silentAlifLabels &&
        (!step.reading || step.reading === step.part || step.reading === 'ا' || step.reading === 'ٱ')
      ) {
        rawLine = step.ruleLabel;
      } else {
        rawLine = `${step.ruleLabel}، ${step.reading}`;
      }

      const spokenStep = normalizeUthmaniForTts(rawLine) || rawLine.trim();
      if (!spokenStep) return;

      const callToken = ++audioRequestTokenRef.current;
      detachAndStopAudioElement();
      const stepCacheKey = `step_v4_${spokenStep}`;
      setAudioError(null);
      setAudioLoadingMode('noor_albayan');

      const isCancelled = () => audioRequestTokenRef.current !== callToken;

      try {
        let wav = await getCachedAudioEntry(stepCacheKey);
        let lastError: string | undefined;
        let lastRetryAfterMs = 8000;

        if (!wav || !wav.base64Wav || wav.base64Wav.length <= 120) {
          const maxAttempts = 6;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (isCancelled()) return;
            const tts = await synthesizeSpeechOnServer({
              text: spokenStep,
              mode: 'noor_albayan',
            }).catch(() => null);
            if (isCancelled()) return;

            if (tts && tts.engine === 'server_wav' && tts.audioBase64.length > 120) {
              wav = {
                key: stepCacheKey,
                base64Wav: tts.audioBase64,
                mimeType: tts.mimeType || 'audio/wav',
                diacritizedWord: spokenStep,
                fullReading: spokenStep,
                updatedAtMs: Date.now(),
              };
              void saveCachedAudioEntry(wav);
              break;
            }

            lastError =
              tts?.error ||
              'هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحين استعادة القراءة تلقائياً.';
            lastRetryAfterMs = tts?.retryAfterMs || 8000;

            if (attempt >= maxAttempts) {
              setAudioError(lastError);
              return;
            }

            const waitMs = Math.max(4000, Math.min(20000, lastRetryAfterMs));
            const ok = await waitWithCancellation(waitMs, isCancelled, (remSec) => {
              setAudioError(
                `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين عودة النطق تلقائياً (المحاولة ${attempt} — إعادة خلال ${remSec} ث)...`
              );
            });
            if (!ok) return;
          }
        }

        if (isCancelled()) return;
        if (wav?.base64Wav && wav.base64Wav.length > 120) {
          setAudioError(null);
          setAudioLoadingMode(null);
          const url = base64AudioToObjectUrl(wav.base64Wav, wav.mimeType || 'audio/wav');
          await playAudioSource(
            'noor_albayan',
            url,
            true,
            () => {
              if (!isCancelled()) {
                setAudioError('تعذّر تشغيل مقطع التهجي حالياً؛ يرجى الانتظار ثم إعادة المحاولة.');
              }
            },
            stepCacheKey
          );
        }
      } catch {
        if (!isCancelled()) {
          setAudioError('هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار ثم إعادة المحاولة.');
        }
      } finally {
        if (audioRequestTokenRef.current === callToken) {
          setAudioLoadingMode(null);
        }
      }
    },
    [
      continuousStatus,
      detachAndStopAudioElement,
      playAudioSource,
      stopContinuousReading,
      waitWithCancellation,
    ]
  );

  const handlePlayNormalReading = async () => {
    if (!selectedSegment) return;
    if (continuousStatus !== 'idle') {
      continuousTokenRef.current++;
      continuousPausedRef.current = false;
      setContinuousStatus('idle');
      setContinuousProgress(null);
    }
    const callToken = ++audioRequestTokenRef.current;
    detachAndStopAudioElement();
    setAudioError(null);
    setAudioLoadingMode('normal');

    const isCancelled = () => audioRequestTokenRef.current !== callToken;

    try {
      const maxAttempts = 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isCancelled()) return;
        const resolved = await resolveSegmentAudio(selectedSegment, 'normal', {
          callToken,
          showUi: true,
        });
        if (isCancelled()) return;

        if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
          setAudioError(null);
          setAudioLoadingMode(null);
          const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
          await playAudioSource(
            'normal',
            url,
            true,
            () => {
              if (!isCancelled()) {
                setAudioError('تعذّر تشغيل الصوت حالياً؛ يرجى الانتظار لحظات والمحاولة مجدداً.');
              }
            },
            resolved.cacheKey
          );
          return;
        }

        if (attempt >= maxAttempts) {
          setAudioError(
            resolved.ttsError ||
              'لا يزال هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار قليلاً ثم إعادة المحاولة.'
          );
          return;
        }

        const waitMs = Math.max(4000, Math.min(20000, resolved.ttsRetryAfterMs || 8000));
        const ok = await waitWithCancellation(waitMs, isCancelled, (remSec) => {
          setAudioError(
            `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${attempt} — إعادة خلال ${remSec} ث)...`
          );
        });
        if (!ok) return;
      }
    } catch {
      if (!isCancelled()) {
        setAudioError('هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار ثم إعادة المحاولة.');
      }
    } finally {
      if (audioRequestTokenRef.current === callToken) {
        setAudioLoadingMode(null);
      }
    }
  };

  const runContinuousFrom = useCallback(
    async (
      startPageIdx: number,
      startSegIdx: number,
      mode: 'noor_albayan' | 'cumulative_tahajji' | 'normal',
      anchorPageIdx: number,
      anchorSegIdx: number,
      endSegId: string
    ) => {
      const loopToken = ++continuousTokenRef.current;
      continuousPausedRef.current = false;
      setPickingBoundary(null);
      setContinuousStatus('playing');
      setAudioError(null);

      const wordAudioMode: 'noor_albayan' | 'normal' =
        mode === 'normal' ? 'normal' : 'noor_albayan';

      const buildCumulativePhraseText = (currPIdx: number, currSIdx: number): string => {
        const collected: string[] = [];
        for (let p = anchorPageIdx; p <= currPIdx; p++) {
          const pSegs = readerPages[p]?.segments || [];
          const fromIdx = p === anchorPageIdx ? anchorSegIdx : 0;
          const toIdx = p === currPIdx ? currSIdx : pSegs.length - 1;
          for (let s = fromIdx; s <= toIdx; s++) {
            const item = pSegs[s];
            if (!item) continue;
            const voc = inferArabicDiacriticsForWord(item.text).vocalized || item.text;
            collected.push(voc);
          }
        }
        return normalizeUthmaniForTts(collected.join(' ')) || collected.join(' ');
      };

      let reachedEnd = false;

      for (let pIdx = startPageIdx; pIdx < readerPages.length && !reachedEnd; pIdx++) {
        if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;
        const page = readerPages[pIdx];
        if (!page || !page.segments || page.segments.length === 0) continue;

        setCurrentPageIndex(pIdx);
        await new Promise((r) => window.setTimeout(r, 70));
        if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;

        const segs = page.segments;
        const firstSegIdx = pIdx === startPageIdx ? Math.max(0, startSegIdx) : 0;

        for (let sIdx = firstSegIdx; sIdx < segs.length; sIdx++) {
          if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;
          const seg = segs[sIdx];
          continuousPositionRef.current = {
            pageIndex: pIdx,
            segIndex: sIdx,
            mode,
            anchorPageIndex: anchorPageIdx,
            anchorSegIndex: anchorSegIdx,
            endSegId,
          };
          setSelectedSegment(seg);

          const chipEl = wordChipRefs.current[seg.id];
          if (chipEl) {
            chipEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }

          setContinuousProgress({
            currentIndex: sIdx + 1,
            totalCount: segs.length,
            wordText: seg.text,
            pageNumber: page.pageNumber,
            sourceLabel: 'جاري البحث في قاعدة المكتبة وتجهيز الصوت...',
          });

          const nextSegOnSamePage =
            endSegId && seg.id === endSegId ? undefined : segs[sIdx + 1];
          const nextPageSegs =
            continuousAutoNextPage && !(endSegId && seg.id === endSegId)
              ? readerPages[pIdx + 1]?.segments || []
              : [];
          const nextSeg = nextSegOnSamePage || nextPageSegs[0];

          const currentPhraseText =
            mode === 'cumulative_tahajji'
              ? buildCumulativePhraseText(pIdx, sIdx)
              : '';
          const isCumulativeStep =
            mode === 'cumulative_tahajji' &&
            (pIdx > anchorPageIdx || sIdx > anchorSegIdx) &&
            currentPhraseText.length > 0;

          const isLoopCancelled = () =>
            continuousTokenRef.current !== loopToken || continuousPausedRef.current;

          const pauseLoopWithErrorOnCurrentWord = (message: string) => {
            continuousPausedRef.current = true;
            continuousTokenRef.current++;
            setContinuousStatus('paused');
            stopAndResetAudio();
            setAudioError(message);
            setContinuousProgress({
              currentIndex: sIdx + 1,
              totalCount: segs.length,
              wordText: seg.text,
              pageNumber: page.pageNumber,
              sourceLabel: message,
            });
          };

          // Resolve current word audio with automatic wait-and-retry if Gemini TTS has temporary load
          let resolved: ResolvedWordAudio | null = null;
          const maxTtsRetries = 15;
          for (let attempt = 1; attempt <= maxTtsRetries; attempt++) {
            if (isLoopCancelled()) return;
            const candidate = await resolveSegmentAudio(seg, wordAudioMode, {
              showUi: true,
              segments: segs,
            });
            if (isLoopCancelled()) return;

            if (candidate.audioBase64 && candidate.audioBase64.length > 120) {
              resolved = candidate;
              setAudioError(null);
              break;
            }

            if (attempt >= maxTtsRetries) {
              pauseLoopWithErrorOnCurrentWord(
                candidate.ttsError ||
                  'لا يزال هناك ضغط على محرك الصوت حالياً؛ تم الإيقاف عند هذه الكلمة. يرجى الانتظار قليلاً ثم الضغط على «متابعة».'
              );
              return;
            }

            const waitMs = Math.max(4000, Math.min(20000, candidate.ttsRetryAfterMs || 8000));
            const keptGoing = await waitWithCancellation(waitMs, isLoopCancelled, (remSec) => {
              const waitMsg = `هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${attempt} — إعادة خلال ${remSec} ث)...`;
              setAudioError(waitMsg);
              setContinuousProgress({
                currentIndex: sIdx + 1,
                totalCount: segs.length,
                wordText: seg.text,
                pageNumber: page.pageNumber,
                sourceLabel: waitMsg,
              });
            });
            if (!keptGoing) return;
          }

          if (!resolved || isLoopCancelled()) return;

          setContinuousProgress({
            currentIndex: sIdx + 1,
            totalCount: segs.length,
            wordText: seg.text,
            pageNumber: page.pageNumber,
            sourceLabel:
              resolved.source === 'generated'
                ? 'جديد · تم التوليد والحفظ بالقاعدة النشطة'
                : 'محفوظ مسبقاً بالقاعدة (تشغيل فوري)',
          });

          const prefetchTimer = window.setTimeout(() => {
            if (isLoopCancelled()) return;
            if (isCumulativeStep) {
              void resolveConnectedPhraseAudio(currentPhraseText).catch(() => {});
            } else if (nextSeg) {
              void resolveSegmentAudio(nextSeg, wordAudioMode, {
                showUi: false,
                segments: nextSegOnSamePage ? segs : nextPageSegs,
              }).catch(() => {});
            }
          }, 400);

          const wordUrl = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
          const wordPlayOutcome = await playAudioStrict(
            wordAudioMode,
            wordUrl,
            resolved.cacheKey,
            isLoopCancelled
          );
          window.clearTimeout(prefetchTimer);

          if (wordPlayOutcome === 'cancelled' || isLoopCancelled()) return;
          if (wordPlayOutcome === 'error') {
            pauseLoopWithErrorOnCurrentWord(
              'تعذّر تشغيل صوت هذه الكلمة حالياً؛ تم التوقف عند نفس الكلمة. اضغط «متابعة» لإعادة التشغيل.'
            );
            return;
          }

          if (isCumulativeStep) {
            await new Promise((r) => window.setTimeout(r, 200));
            if (isLoopCancelled()) return;

            setContinuousProgress({
              currentIndex: sIdx + 1,
              totalCount: segs.length,
              wordText: seg.text,
              pageNumber: page.pageNumber,
              sourceLabel: 'الربط التجميعي من البداية حتى هذه الكلمة',
              cumulativePhrase: currentPhraseText,
            });

            let phraseWav: {
              base64Wav: string;
              mimeType: string;
              cacheKey: string;
              error?: string;
              retryAfterMs?: number;
            } | null = null;

            for (let attempt = 1; attempt <= maxTtsRetries; attempt++) {
              if (isLoopCancelled()) return;
              const candidatePhrase = await resolveConnectedPhraseAudio(currentPhraseText);
              if (isLoopCancelled()) return;

              if (candidatePhrase.base64Wav && candidatePhrase.base64Wav.length > 120) {
                phraseWav = candidatePhrase;
                setAudioError(null);
                break;
              }

              if (attempt >= maxTtsRetries) {
                pauseLoopWithErrorOnCurrentWord(
                  candidatePhrase.error ||
                    'لا يزال هناك ضغط على محرك الصوت أثناء قراءة الربط التجميعي؛ تم التوقف عند هذه الكلمة. اضغط «متابعة» بعد قليل.'
                );
                return;
              }

              const waitMs = Math.max(
                4000,
                Math.min(20000, candidatePhrase.retryAfterMs || 8000)
              );
              const keptGoing = await waitWithCancellation(waitMs, isLoopCancelled, (remSec) => {
                const waitMsg = `هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لاستكمال الربط التجميعي تلقائياً (المحاولة ${attempt} — إعادة خلال ${remSec} ث)...`;
                setAudioError(waitMsg);
                setContinuousProgress({
                  currentIndex: sIdx + 1,
                  totalCount: segs.length,
                  wordText: seg.text,
                  pageNumber: page.pageNumber,
                  sourceLabel: waitMsg,
                  cumulativePhrase: currentPhraseText,
                });
              });
              if (!keptGoing) return;
            }

            if (!phraseWav || isLoopCancelled()) return;

            const phraseUrl = base64AudioToObjectUrl(phraseWav.base64Wav, phraseWav.mimeType);
            const phraseOutcome = await playAudioStrict(
              'normal',
              phraseUrl,
              phraseWav.cacheKey,
              isLoopCancelled
            );

            if (phraseOutcome === 'cancelled' || isLoopCancelled()) return;
            if (phraseOutcome === 'error') {
              pauseLoopWithErrorOnCurrentWord(
                'تعذّر تشغيل صوت الربط التجميعي حالياً؛ اضغط «متابعة» لإعادة المحاولة.'
              );
              return;
            }
          }

          if (endSegId && seg.id === endSegId) {
            reachedEnd = true;
            break;
          }

          await new Promise((r) =>
            window.setTimeout(r, wordAudioMode === 'noor_albayan' ? 240 : 180)
          );
        }

        if (!continuousAutoNextPage || reachedEnd) break;
      }

      if (continuousTokenRef.current === loopToken && !continuousPausedRef.current) {
        setContinuousStatus('idle');
        setContinuousProgress(null);
      }
    },
    [
      continuousAutoNextPage,
      playAudioStrict,
      readerPages,
      resolveConnectedPhraseAudio,
      resolveSegmentAudio,
      stopAndResetAudio,
      waitWithCancellation,
    ]
  );

  const handleStartContinuousReading = () => {
    const segs = readerPages[currentPageIndex]?.segments || [];
    if (segs.length === 0) return;
    let startIdx = segs.findIndex((s) => s.id === continuousStartId);
    if (startIdx < 0 && selectedSegment) {
      startIdx = segs.findIndex((s) => s.id === selectedSegment.id);
    }
    if (startIdx < 0) startIdx = 0;

    let validEndId = continuousEndId;
    if (validEndId) {
      const endIdx = segs.findIndex((s) => s.id === validEndId);
      if (endIdx < startIdx) {
        validEndId = '';
      }
    }

    void runContinuousFrom(
      currentPageIndex,
      startIdx,
      continuousMode,
      currentPageIndex,
      startIdx,
      validEndId
    );
  };

  const handlePauseContinuousReading = () => {
    continuousPausedRef.current = true;
    continuousTokenRef.current++;
    setContinuousStatus('paused');
    stopAndResetAudio();
  };

  const handleResumeContinuousReading = () => {
    const pos = continuousPositionRef.current;
    void runContinuousFrom(
      pos.pageIndex,
      pos.segIndex,
      pos.mode,
      pos.anchorPageIndex,
      pos.anchorSegIndex,
      pos.endSegId
    );
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
    const callToken = ++audioRequestTokenRef.current;
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
        if (audioRequestTokenRef.current === callToken) {
          setAudioError('تعذّر تحميل تلاوة القارئ حالياً؛ يرجى التحقق من الاتصال والمحاولة مجدداً.');
        }
      });
    } catch {
      if (audioRequestTokenRef.current === callToken) {
        setAudioError('تعذّر تشغيل تلاوة القارئ حالياً؛ يرجى الانتظار والمحاولة مجدداً.');
      }
    } finally {
      if (audioRequestTokenRef.current === callToken) {
        setAudioLoadingMode(null);
      }
    }
  };

  const handlePauseAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
  };

  const handleResumeAudio = async () => {
    if (audioRef.current && audioRef.current.src) {
      await audioRef.current.play().catch(() => {
        setAudioError('تعذّر استئناف الصوت حالياً؛ يرجى إعادة التشغيل.');
      });
    }
  };

  const handleRestartAudio = async () => {
    if (audioRef.current && audioRef.current.src) {
      audioRef.current.currentTime = 0;
      setAudioCurrentTime(0);
      await audioRef.current.play().catch(() => {
        setAudioError('تعذّر إعادة تشغيل الصوت حالياً؛ يرجى المحاولة مجدداً.');
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
    setPageOcrProgress({
      pageNumber: currentPage.pageNumber,
      pagePercent: 1,
      stageText: `جاري تجهيز الصفحة ${currentPage.pageNumber} لإعادة التعرف الذكي...`,
    });
    setFeedback(null);
    try {
      const analyzed = await analyzeBookPageOnServer({
        imageDataUrl: currentPage.imageDataUrl,
        pageNumber: currentPage.pageNumber,
        bookTitle: readerBook.title,
        onProgress: (prog) => {
          setPageOcrProgress(prog);
        },
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
      setPageOcrProgress(null);
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
                stopContinuousReading();
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
                اضغط على أي كلمة أو آية في صفحة الكتاب للمعاينة والاستماع، أو شغّل القراءة المتواصلة
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
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
              <div className="flex items-center gap-1.5 sm:gap-2 bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-1 sm:p-1.5 shrink-0">
                <button
                  type="button"
                  disabled={currentPageIndex <= 0}
                  onClick={() => {
                    stopContinuousReading();
                    const nextIdx = Math.max(0, currentPageIndex - 1);
                    setCurrentPageIndex(nextIdx);
                    setContinuousEndId('');
                    const first = readerPages[nextIdx]?.segments?.[0] || null;
                    if (first) handleSelectSegment(first);
                  }}
                  aria-label="الصفحة السابقة"
                  className="min-h-[38px] px-2.5 sm:px-3 rounded-xl bg-white border border-[#EADBC8] text-[#4A220D] font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" />
                  <span className="hidden sm:inline">السابقة</span>
                </button>
                <span className="px-2 sm:px-3 text-xs sm:text-sm font-display font-extrabold text-[#4A220D] tabular-nums whitespace-nowrap">
                  {currentPageIndex + 1} / {readerPages.length}
                </span>
                <button
                  type="button"
                  disabled={currentPageIndex >= readerPages.length - 1}
                  onClick={() => {
                    stopContinuousReading();
                    const nextIdx = Math.min(readerPages.length - 1, currentPageIndex + 1);
                    setCurrentPageIndex(nextIdx);
                    setContinuousEndId('');
                    const first = readerPages[nextIdx]?.segments?.[0] || null;
                    if (first) handleSelectSegment(first);
                  }}
                  aria-label="الصفحة التالية"
                  className="min-h-[38px] px-2.5 sm:px-3 rounded-xl bg-white border border-[#EADBC8] text-[#4A220D] font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <span className="hidden sm:inline">التالية</span>
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Continuous Reading Control Bar (القراءة المتواصلة بالتهجي أو السريعة) */}
        {currentPage && currentPage.segments.length > 0 && (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#F56900]/10 text-[#F56900] flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-display text-sm sm:text-base font-extrabold text-[#4A220D]">
                    القراءة المتواصلة
                  </h3>
                  <p className="text-[11px] text-[#7D4E35]">
                    يقرأ الكلمات بالتسلسل ويجلب الصوت المحفوظ فوراً أو ينشئه ويحفظه في قاعدة المكتبة النشطة تلقائياً
                  </p>
                </div>
              </div>

              {/* Mode Selector: بالتهجي / تهجي تجميعي / سريعة */}
              <div className="flex flex-wrap items-center gap-1.5 bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-1 w-full sm:w-auto">
                <button
                  type="button"
                  disabled={continuousStatus === 'playing'}
                  onClick={() => setContinuousMode('noor_albayan')}
                  className={`min-h-[38px] px-2.5 sm:px-3 rounded-xl font-display font-bold text-xs cursor-pointer transition-colors disabled:opacity-60 text-center ${
                    continuousMode === 'noor_albayan'
                      ? 'bg-[#F56900] text-white'
                      : 'text-[#4A220D] hover:bg-white'
                  }`}
                >
                  بالتهجي (الفتح الرباني)
                </button>
                <button
                  type="button"
                  disabled={continuousStatus === 'playing'}
                  onClick={() => setContinuousMode('cumulative_tahajji')}
                  className={`min-h-[38px] px-2.5 sm:px-3 rounded-xl font-display font-bold text-xs cursor-pointer transition-colors disabled:opacity-60 text-center ${
                    continuousMode === 'cumulative_tahajji'
                      ? 'bg-[#8B5CF6] text-white'
                      : 'text-[#4A220D] hover:bg-white'
                  }`}
                >
                  تهجي تجميعي (من البداية)
                </button>
                <button
                  type="button"
                  disabled={continuousStatus === 'playing'}
                  onClick={() => setContinuousMode('normal')}
                  className={`min-h-[38px] px-2.5 sm:px-3 rounded-xl font-display font-bold text-xs cursor-pointer transition-colors disabled:opacity-60 text-center ${
                    continuousMode === 'normal'
                      ? 'bg-[#46A302] text-white'
                      : 'text-[#4A220D] hover:bg-white'
                  }`}
                >
                  سريعة (قراءة عادية)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
              {/* Start word selector */}
              <div className="lg:col-span-4 flex items-center gap-1.5">
                <label
                  htmlFor="continuous-start-select"
                  className="text-xs font-bold text-[#7D4E35] shrink-0 whitespace-nowrap"
                >
                  ابدأ من:
                </label>
                <select
                  id="continuous-start-select"
                  disabled={continuousStatus === 'playing'}
                  value={continuousStartId || selectedSegment?.id || currentPage.segments[0]?.id || ''}
                  onChange={(e) => {
                    const seg = currentPage.segments.find((s) => s.id === e.target.value);
                    if (seg) {
                      setContinuousStartId(seg.id);
                      setSelectedSegment(seg);
                      if (continuousEndId) {
                        const sI = currentPage.segments.findIndex((x) => x.id === seg.id);
                        const eI = currentPage.segments.findIndex((x) => x.id === continuousEndId);
                        if (eI >= 0 && sI > eI) setContinuousEndId('');
                      }
                    }
                  }}
                  className="w-full min-w-0 min-h-[42px] px-2.5 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D]"
                >
                  {currentPage.segments.map((seg, i) => (
                    <option key={seg.id} value={seg.id}>
                      {i + 1}. {seg.text.slice(0, 32)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={continuousStatus === 'playing'}
                  onClick={() =>
                    setPickingBoundary((p) => (p === 'start' ? null : 'start'))
                  }
                  title="تحديد كلمة البداية بالنقر"
                  className={`min-h-[42px] px-2.5 rounded-xl border-2 font-display font-bold text-xs inline-flex items-center gap-1 shrink-0 cursor-pointer disabled:opacity-50 ${
                    pickingBoundary === 'start'
                      ? 'bg-[#F56900] border-[#C95200] text-white'
                      : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                  }`}
                >
                  <Crosshair className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">
                    {pickingBoundary === 'start' ? 'انقر...' : 'بداية'}
                  </span>
                </button>
              </div>

              {/* End word selector */}
              <div className="lg:col-span-4 flex items-center gap-1.5">
                <label
                  htmlFor="continuous-end-select"
                  className="text-xs font-bold text-[#7D4E35] shrink-0 whitespace-nowrap"
                >
                  انتهِ عند:
                </label>
                <select
                  id="continuous-end-select"
                  disabled={continuousStatus === 'playing'}
                  value={continuousEndId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setContinuousEndId(val);
                    if (val) {
                      const eI = currentPage.segments.findIndex((x) => x.id === val);
                      const sI = currentPage.segments.findIndex((x) => x.id === continuousStartId);
                      if (sI < 0 || sI > eI) {
                        const endSeg = currentPage.segments[eI];
                        if (endSeg) {
                          setContinuousStartId(endSeg.id);
                          setSelectedSegment(endSeg);
                        }
                      }
                    }
                  }}
                  className="w-full min-w-0 min-h-[42px] px-2.5 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D]"
                >
                  <option value="">حتى نهاية الصفحة</option>
                  {currentPage.segments.map((seg, i) => (
                    <option key={seg.id} value={seg.id}>
                      {i + 1}. {seg.text.slice(0, 32)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={continuousStatus === 'playing'}
                  onClick={() =>
                    setPickingBoundary((p) => (p === 'end' ? null : 'end'))
                  }
                  title="تحديد كلمة النهاية بالنقر"
                  className={`min-h-[42px] px-2.5 rounded-xl border-2 font-display font-bold text-xs inline-flex items-center gap-1 shrink-0 cursor-pointer disabled:opacity-50 ${
                    pickingBoundary === 'end'
                      ? 'bg-[#46A302] border-[#357D01] text-white'
                      : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#46A302]'
                  }`}
                >
                  <Crosshair className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">
                    {pickingBoundary === 'end' ? 'انقر...' : 'نهاية'}
                  </span>
                </button>
              </div>

              {/* Transport action buttons */}
              <div className="lg:col-span-4 flex flex-wrap items-center justify-between lg:justify-end gap-2">
                {!continuousEndId && (
                  <label className="inline-flex items-center gap-1.5 text-xs font-bold text-[#4A220D] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={continuousAutoNextPage}
                      onChange={(e) => setContinuousAutoNextPage(e.target.checked)}
                      className="w-4 h-4 accent-[#58CC02] rounded cursor-pointer"
                    />
                    <span>التالي تلقائياً</span>
                  </label>
                )}

                {continuousStatus === 'idle' && (
                  <button
                    type="button"
                    onClick={handleStartContinuousReading}
                    className="duo-btn-green w-full sm:w-auto min-h-[44px] px-5 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Play className="w-4 h-4 shrink-0" />
                    <span>
                      {continuousMode === 'cumulative_tahajji'
                        ? 'ابدأ التهجي التجميعي'
                        : 'ابدأ القراءة المتواصلة'}
                    </span>
                  </button>
                )}

                {continuousStatus === 'playing' && (
                  <>
                    <button
                      type="button"
                      onClick={handlePauseContinuousReading}
                      className="min-h-[42px] px-4 rounded-xl bg-[#4A220D] text-white font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      <span>إيقاف مؤقت</span>
                    </button>
                    <button
                      type="button"
                      onClick={stopContinuousReading}
                      className="min-h-[42px] px-4 rounded-xl bg-[#D95338] text-white font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span>إيقاف</span>
                    </button>
                  </>
                )}

                {continuousStatus === 'paused' && (
                  <>
                    <button
                      type="button"
                      onClick={handleResumeContinuousReading}
                      className="duo-btn-green min-h-[42px] px-4 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>متابعة</span>
                    </button>
                    <button
                      type="button"
                      onClick={stopContinuousReading}
                      className="min-h-[42px] px-4 rounded-xl bg-[#D95338] text-white font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span>إيقاف</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {pickingBoundary && (
              <div className="bg-[#FDF6EE] border border-[#F56900]/40 rounded-xl px-3.5 py-2 text-xs font-bold text-[#F56900]">
                {pickingBoundary === 'start'
                  ? 'اضغط الآن على أي كلمة في صورة الصفحة أو من قائمة الكلمات لتحديد نقطة البداية.'
                  : 'اضغط الآن على أي كلمة في صورة الصفحة أو من قائمة الكلمات لتحديد نقطة النهاية.'}
              </div>
            )}

            {continuousProgress && (
              <div
                className={`rounded-2xl px-4 py-2.5 space-y-1.5 text-xs font-bold border ${
                  continuousProgress.sourceLabel.includes('ضغط')
                    ? 'bg-[#FFF5EE] border-[#F56900]/50'
                    : 'bg-[#FDF6EE] border-[#58CC02]/40'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[#4A220D]">
                    <Volume2
                      className={`w-4 h-4 shrink-0 ${
                        continuousProgress.sourceLabel.includes('ضغط')
                          ? 'text-[#F56900]'
                          : 'text-[#46A302]'
                      }`}
                    />
                    <span>
                      صفحة {continuousProgress.pageNumber} · كلمة {continuousProgress.currentIndex} من{' '}
                      {continuousProgress.totalCount}:
                    </span>
                    <span className="font-display font-extrabold text-sm text-[#F56900]">
                      {continuousProgress.wordText}
                    </span>
                  </div>
                  <span
                    className={`text-[11px] font-bold inline-flex items-center gap-1 ${
                      continuousProgress.sourceLabel.includes('ضغط')
                        ? 'text-[#D95338]'
                        : 'text-[#46A302]'
                    }`}
                  >
                    {continuousProgress.sourceLabel.includes('ضغط') ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    ) : (
                      <Database className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span>{continuousProgress.sourceLabel}</span>
                  </span>
                </div>
                {continuousProgress.cumulativePhrase && (
                  <div className="bg-white border border-[#8B5CF6]/30 rounded-xl px-3 py-1.5 text-xs sm:text-sm font-display font-extrabold text-[#4A220D]">
                    <span className="text-[#8B5CF6] ml-1.5">الربط التجميعي:</span>
                    <span>{continuousProgress.cumulativePhrase}</span>
                  </div>
                )}
              </div>
            )}

            {continuousStatus !== 'idle' && audioError && (
              <div
                role="alert"
                className="rounded-2xl bg-[#FFF5EE] border-2 border-[#F56900]/40 px-4 py-2.5 text-xs font-bold text-[#B54708] flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 text-[#F56900] shrink-0" />
                <span>{audioError}</span>
              </div>
            )}
          </div>
        )}

        {/* Live Per-Page Progress Banner in Reader View */}
        {reanalyzingPage && (
          <div className="bg-[#FDF6EE] border-2 border-[#58CC02] rounded-2xl p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs sm:text-sm font-display font-extrabold text-[#4A220D]">
                <Loader2 className="w-4 h-4 text-[#46A302] animate-spin shrink-0" />
                <span>
                  إعادة التعرف الذكي على الصفحة{' '}
                  {pageOcrProgress?.pageNumber ?? currentPage?.pageNumber ?? ''}
                </span>
              </div>
              <span className="px-2.5 py-0.5 rounded-lg bg-[#58CC02]/15 border border-[#58CC02]/40 text-xs sm:text-sm font-display font-extrabold text-[#46A302] tabular-nums">
                {pageOcrProgress?.pagePercent ?? 2}%
              </span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-white border border-[#EADBC8] overflow-hidden">
              <div
                className="h-full bg-[#58CC02] transition-all duration-200"
                style={{ width: `${pageOcrProgress?.pagePercent ?? 2}%` }}
              />
            </div>
            <p className="text-xs font-bold text-[#7D4E35] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
              <span>
                {pageOcrProgress?.stageText || 'جاري تجهيز الصفحة لبدء القراءة...'}
              </span>
            </p>
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
                  {(() => {
                    const startIdx = continuousStartId
                      ? currentPage.segments.findIndex((x) => x.id === continuousStartId)
                      : -1;
                    const endIdx = continuousEndId
                      ? currentPage.segments.findIndex((x) => x.id === continuousEndId)
                      : -1;
                    return currentPage.segments.map((seg, segIdx) => {
                      const [ymin, xmin, ymax, xmax] = seg.box;
                      const top = Math.max(0, Math.min(99, ymin / 10));
                      const left = Math.max(0, Math.min(99, xmin / 10));
                      const width = Math.max(2, Math.min(100 - left, (xmax - xmin) / 10));
                      const height = Math.max(2, Math.min(100 - top, (ymax - ymin) / 10));
                      const isSelected = selectedSegment?.id === seg.id;
                      const isEnd = Boolean(continuousEndId && seg.id === continuousEndId);
                      const inSelectedRange =
                        startIdx >= 0 &&
                        endIdx >= startIdx &&
                        segIdx >= startIdx &&
                        segIdx <= endIdx;
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
                              : isEnd
                              ? 'bg-[#46A302]/25 ring-2 ring-[#46A302]'
                              : inSelectedRange
                              ? 'bg-[#58CC02]/15 ring-1 ring-[#58CC02]/60'
                              : seg.kind === 'ayah'
                              ? 'hover:bg-[#58CC02]/20 hover:ring-2 hover:ring-[#58CC02]/70'
                              : 'hover:bg-[#F56900]/15 hover:ring-1 hover:ring-[#F56900]/60'
                          }`}
                        />
                      );
                    });
                  })()}
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
                    {(() => {
                      const startIdx = continuousStartId
                        ? currentPage.segments.findIndex((x) => x.id === continuousStartId)
                        : -1;
                      const endIdx = continuousEndId
                        ? currentPage.segments.findIndex((x) => x.id === continuousEndId)
                        : -1;
                      return currentPage.segments.map((seg, segIdx) => {
                        const isSelected = selectedSegment?.id === seg.id;
                        const isEnd = Boolean(continuousEndId && seg.id === continuousEndId);
                        const isStart = Boolean(continuousStartId && seg.id === continuousStartId);
                        const inSelectedRange =
                          startIdx >= 0 &&
                          endIdx >= startIdx &&
                          segIdx >= startIdx &&
                          segIdx <= endIdx;
                        return (
                          <button
                            key={seg.id}
                            ref={(el) => {
                              wordChipRefs.current[seg.id] = el;
                            }}
                            type="button"
                            onClick={() => handleSelectSegment(seg)}
                            className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-base font-bold transition-colors cursor-pointer inline-flex items-center gap-1 ${
                              isSelected
                                ? 'bg-[#F56900] border-[#C95200] text-white'
                                : isEnd
                                ? 'bg-[#46A302] border-[#357D01] text-white'
                                : inSelectedRange
                                ? 'bg-[#58CC02]/15 border-[#58CC02] text-[#4A220D]'
                                : seg.kind === 'ayah'
                                ? 'bg-[#58CC02]/10 border-[#58CC02]/40 text-[#4A220D] hover:border-[#58CC02]'
                                : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                            }`}
                          >
                            {isStart && !isSelected && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F56900]/15 text-[#F56900] font-extrabold">
                                بداية
                              </span>
                            )}
                            <span>{seg.text}</span>
                            {isEnd && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/25 text-white font-extrabold">
                                نهاية
                              </span>
                            )}
                            {seg.kind === 'ayah' && seg.ayahNumber ? (
                              <span className="mr-1 text-xs opacity-80 tabular-nums">
                                ﴿{seg.ayahNumber}﴾
                              </span>
                            ) : null}
                          </button>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            </div>

            {/* Interactive Word / Ayah Reading Inspector */}
            <div className="lg:col-span-5 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto space-y-4">
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

                  {wordAudioStatus && (
                    <div className="rounded-xl bg-[#58CC02]/10 border border-[#58CC02]/40 px-3 py-2 text-[11px] font-bold text-[#46A302] flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5 shrink-0" />
                      <span>{wordAudioStatus}</span>
                    </div>
                  )}

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
                            ? 'جاري التشغيل: تهجي الفتح الرباني'
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

                  {/* Al-Fath Al-Rabbani Spelling Steps Breakdown Card */}
                  {noorLoading ? (
                    <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 text-center text-xs font-bold text-[#7D4E35] flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-[#F56900]" />
                      <span>جاري إعداد التهجي بطريقة الفتح الرباني...</span>
                    </div>
                  ) : (
                    noorSteps.length > 0 && (
                      <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                            تفصيل التهجي (الفتح الرباني):
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
                              onClick={() => void handlePlaySingleNoorStep(step)}
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
          className="duo-btn-orange w-full sm:w-auto min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap disabled:opacity-60"
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
                    setPageOcrProgress(null);
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

          {/* Live Per-Page Progress Panel */}
          {isRunningJob && activeJob.status === 'processing' && pageOcrProgress && (
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-3.5 sm:p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs sm:text-sm font-display font-extrabold text-[#4A220D] tabular-nums">
                  <Loader2 className="w-4 h-4 text-[#F56900] animate-spin shrink-0" />
                  <span>
                    تقدّم الصفحة الحالية: صفحة {pageOcrProgress.pageNumber} من{' '}
                    {activeJobStats.total}
                  </span>
                </div>
                <span className="px-2.5 py-0.5 rounded-lg bg-[#58CC02]/15 border border-[#58CC02]/40 text-xs sm:text-sm font-display font-extrabold text-[#46A302] tabular-nums">
                  {pageOcrProgress.pagePercent}%
                </span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-white border border-[#EADBC8] overflow-hidden">
                <div
                  className="h-full bg-[#58CC02] transition-all duration-200"
                  style={{ width: `${pageOcrProgress.pagePercent}%` }}
                />
              </div>
              <p className="text-xs font-bold text-[#7D4E35] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
                <span>{pageOcrProgress.stageText}</span>
              </p>
            </div>
          )}

          {isRunningJob && activeJob.status === 'uploading' && (
            <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl px-3.5 py-2.5 text-xs font-bold text-[#7D4E35] flex items-center gap-2 tabular-nums">
              <Loader2 className="w-4 h-4 text-[#F56900] animate-spin shrink-0" />
              <span>
                جاري رفع الصفحة{' '}
                {Math.min(activeJobStats.total, activeJobStats.uploaded + 1)} من{' '}
                {activeJobStats.total} وحفظها في المكتبة...
              </span>
            </div>
          )}
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
            className="fixed inset-0 z-[90] flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
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
            className="fixed inset-0 z-[90] flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
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
