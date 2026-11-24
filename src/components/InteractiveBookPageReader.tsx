import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Crosshair,
  Database,
  Headphones,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  Zap,
} from 'lucide-react';
import {
  base64AudioToObjectUrl,
  deleteCachedAudioEntry,
  generateNoorAlBayanOnServer,
  getCachedAudioEntry,
  saveCachedAudioEntry,
  synthesizeSpeechOnServer,
} from '../services/bookStorage';
import {
  computeSegmentTahajjiContext,
  generateNoorAlBayanClientFallback,
  inferArabicDiacriticsForWord,
  isWordStartingWithHamzatWasl,
  normalizeUthmaniForTts,
} from '../services/clientArabicEngine';
import { getReciterAyahAudioUrl } from '../services/multiDb';
import {
  getSavedTeacherReciterId,
  saveTeacherReciterId,
  toArabicIndicDigits,
} from '../services/mushafService';
import {
  lookupWordAudioAcrossLibrary,
  saveWordAudioToLibraryDb,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  QURAN_RECITERS,
  type BookPageRecord,
  type BookTextSegment,
  type BookWordAudioRecord,
  type NoorAlBayanStep,
} from '../types/platform';

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
 * so the reader sees the selected word/ayah in its original calligraphy.
 */
export const WordImageCropPreview: React.FC<{
  imageDataUrl: string;
  box: [number, number, number, number];
  altText: string;
}> = ({ imageDataUrl, box, altText }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasValidBox = box[2] > box[0] && box[3] > box[1];

  useEffect(() => {
    if (!hasValidBox) return;
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
  }, [imageDataUrl, box, hasValidBox]);

  if (!hasValidBox) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-label={altText}
      className="max-w-full max-h-36 rounded-xl border-2 border-[#EADBC8] bg-white mx-auto block"
    />
  );
};

interface ResolvedWordAudio {
  cacheKey: string;
  source: 'local' | 'db' | 'generated';
  audioBase64: string;
  mimeType: string;
  diacritizedWord: string;
  wasAutoDiacritized: boolean;
  steps: NoorAlBayanStep[];
  fullReading: string;
}

interface InteractiveBookPageReaderProps {
  workspace: ComplexWorkspaceData;
  bookTitle: string;
  pages: BookPageRecord[];
  currentPageIndex: number;
  onChangePageIndex: (nextIndex: number, isContinuousAutoAdvance?: boolean) => void;
  manualNavigationSeq?: number;
  currentUserId?: string;
  zoomPercent?: number;
  flipSeq?: number;
  flipDirection?: 'next' | 'prev' | null;
  rememberTeacherReciter?: boolean;
}

export const InteractiveBookPageReader: React.FC<InteractiveBookPageReaderProps> = ({
  workspace,
  bookTitle,
  pages,
  currentPageIndex,
  onChangePageIndex,
  manualNavigationSeq = 0,
  currentUserId = 'teacher_reader',
  zoomPercent = 100,
  flipSeq = 0,
  flipDirection = null,
  rememberTeacherReciter = true,
}) => {
  const currentPage = pages[currentPageIndex] || null;

  // Build segments list (falls back to whitespace tokens from fullText if page has no segments yet)
  const activeSegments = useMemo<BookTextSegment[]>(() => {
    if (!currentPage) return [];
    if (Array.isArray(currentPage.segments) && currentPage.segments.length > 0) {
      return currentPage.segments;
    }
    const rawTokens = String(currentPage.fullText || '')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
    return rawTokens.slice(0, 350).map((word, idx) => ({
      id: `txt_p${currentPage.pageNumber}_${idx + 1}`,
      text: word,
      plainText: word,
      kind: 'word' as const,
      box: [0, 0, 0, 0] as [number, number, number, number],
    }));
  }, [currentPage]);

  const [selectedSegment, setSelectedSegment] = useState<BookTextSegment | null>(
    () => activeSegments[0] || null
  );
  const [selectedReciterId, setSelectedReciterId] = useState<string>(() =>
    rememberTeacherReciter ? getSavedTeacherReciterId() : QURAN_RECITERS[0].id
  );
  const [autoPlayOnTap, setAutoPlayOnTap] = useState(false);

  // Word Audio & Noor Al-Bayan State
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
  const prefetchMapRef = useRef<Map<string, Promise<ResolvedWordAudio>>>(new Map());
  const phrasePrefetchMapRef = useRef<Map<string, Promise<{ base64Wav: string; mimeType: string; cacheKey: string } | null>>>(new Map());
  const dbRecordSessionCacheRef = useRef<Map<string, BookWordAudioRecord | null>>(new Map());
  const activeNavSeqRef = useRef<number>(manualNavigationSeq);
  const selectedSegmentIdRef = useRef<string | null>(null);
  selectedSegmentIdRef.current = selectedSegment?.id || null;
  const continuousStatusRef = useRef<'idle' | 'playing' | 'paused'>('idle');
  continuousStatusRef.current = continuousStatus;
  const lastPageKeyRef = useRef<string>('');

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
    startWatchdogId: number | null;
    maxDurationId: number | null;
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
    startWatchdogId: null,
    maxDurationId: null,
  });

  // Pre-warm Web Speech API voices list
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const warm = () => {
      try {
        window.speechSynthesis.getVoices();
      } catch {
        // Ignore
      }
    };
    warm();
    window.speechSynthesis.addEventListener?.('voiceschanged', warm);
    return () => {
      window.speechSynthesis.removeEventListener?.('voiceschanged', warm);
    };
  }, []);

  const clearSpeechTimers = useCallback(() => {
    if (speechStateRef.current.timerId !== null) {
      window.clearInterval(speechStateRef.current.timerId);
      speechStateRef.current.timerId = null;
    }
    if (speechStateRef.current.startDelayId !== null) {
      window.clearTimeout(speechStateRef.current.startDelayId);
      speechStateRef.current.startDelayId = null;
    }
    if (speechStateRef.current.startWatchdogId !== null) {
      window.clearTimeout(speechStateRef.current.startWatchdogId);
      speechStateRef.current.startWatchdogId = null;
    }
    if (speechStateRef.current.maxDurationId !== null) {
      window.clearTimeout(speechStateRef.current.maxDurationId);
      speechStateRef.current.maxDurationId = null;
    }
  }, []);

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
    setAudioLoadingMode(null);
    setNoorLoading(false);
  }, [clearSpeechTimers, detachAndStopAudioElement]);

  const stopContinuousReading = useCallback(() => {
    continuousTokenRef.current++;
    continuousPausedRef.current = false;
    setPickingBoundary(null);
    setContinuousStatus('idle');
    setContinuousProgress(null);
    stopAndResetAudio();
  }, [stopAndResetAudio]);

  // Clean up audio & continuous loop on unmount
  useEffect(() => {
    return () => {
      continuousTokenRef.current++;
      stopAndResetAudio();
    };
  }, [stopAndResetAudio]);

  const getSegmentContext = useCallback(
    (seg: BookTextSegment, overrideSegments?: BookTextSegment[]) => {
      const list =
        overrideSegments && overrideSegments.length > 0 ? overrideSegments : activeSegments;
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
    [activeSegments]
  );

  // Helper to check DB + local cache for saved word readings cleanly (without generating)
  const lookupSavedWordRecord = useCallback(
    async (
      mode: 'noor_albayan' | 'normal',
      wordText: string,
      ctx?: { nextWord?: string; isEndOfAyah?: boolean; contextSuffix?: string }
    ): Promise<ResolvedWordAudio | null> => {
      const normalizedText = wordText.trim().replace(/\s+/g, ' ');
      if (!normalizedText) return null;
      const contextSuffix = mode === 'noor_albayan' ? ctx?.contextSuffix || '' : '';
      const cacheKey = `${
        mode === 'noor_albayan' ? `fath_v4${contextSuffix}` : 'normal_v2'
      }_${normalizedText}`;
      const instantLocal =
        mode === 'noor_albayan'
          ? generateNoorAlBayanClientFallback(wordText, {
              nextWord: ctx?.nextWord,
              isEndOfAyah: ctx?.isEndOfAyah,
            })
          : null;

      // 1. Local IndexedDB check
      const localCached = await getCachedAudioEntry(cacheKey);
      if (localCached && localCached.base64Wav && localCached.base64Wav.length > 120) {
        return {
          cacheKey,
          source: 'local',
          audioBase64: localCached.base64Wav,
          mimeType: localCached.mimeType || 'audio/wav',
          diacritizedWord:
            localCached.diacritizedWord || instantLocal?.diacritizedWord || wordText,
          wasAutoDiacritized: Boolean(
            localCached.wasAutoDiacritized ?? instantLocal?.wasAutoDiacritized
          ),
          steps: localCached.steps || instantLocal?.steps || [],
          fullReading:
            localCached.fullReading ||
            instantLocal?.fullReading ||
            localCached.diacritizedWord ||
            wordText,
        };
      }

      // 2. Session-memoized Firestore `wordAudio` lookup across library shards
      let dbHit: BookWordAudioRecord | null;
      if (dbRecordSessionCacheRef.current.has(cacheKey)) {
        dbHit = dbRecordSessionCacheRef.current.get(cacheKey) || null;
      } else {
        dbHit = await lookupWordAudioAcrossLibrary(workspace, mode, wordText, contextSuffix);
        dbRecordSessionCacheRef.current.set(cacheKey, dbHit);
      }

      if (dbHit) {
        const diacritizedWord =
          dbHit.diacritizedWord || instantLocal?.diacritizedWord || wordText;
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

      return null;
    },
    [workspace]
  );

  // Hydrate saved DB state silently when selecting a segment so saved words appear ready immediately
  const hydrateSegmentSavedInfo = useCallback(
    async (seg: BookTextSegment) => {
      const targetId = seg.id;
      const ctx = getSegmentContext(seg);
      const [noorSaved, normalSaved] = await Promise.all([
        lookupSavedWordRecord('noor_albayan', seg.text, ctx).catch(() => null),
        lookupSavedWordRecord('normal', seg.text).catch(() => null),
      ]);

      // Ensure user didn't already switch to another segment while lookup was in flight
      if (selectedSegmentIdRef.current !== targetId) return;

      if (noorSaved) {
        setNoorDiacritizedWord(noorSaved.diacritizedWord);
        setNoorAutoDiacritized(noorSaved.wasAutoDiacritized);
        setNoorSteps(noorSaved.steps);
        setNoorFullReading(noorSaved.fullReading);
        setWordAudioStatus('قراءة التهجي محفوظة في القاعدة — جاهزة للتشغيل المباشر');
      } else if (normalSaved) {
        setWordAudioStatus('القراءة العادية محفوظة في القاعدة — جاهزة للتشغيل المباشر');
      }
    },
    [getSegmentContext, lookupSavedWordRecord]
  );

  // Stop continuous reading if parent performed a manual navigation (header/footer/swipe)
  useEffect(() => {
    if (manualNavigationSeq !== activeNavSeqRef.current) {
      activeNavSeqRef.current = manualNavigationSeq;
      stopContinuousReading();
    }
  }, [manualNavigationSeq, stopContinuousReading]);

  // Select first word only when actually switching to a new page (when not driven by continuous loop)
  useEffect(() => {
    const pageKey = `${currentPage?.id || 'none'}_${currentPageIndex}`;
    if (lastPageKeyRef.current === pageKey) return;
    lastPageKeyRef.current = pageKey;
    if (continuousStatusRef.current === 'playing') return;

    const first = activeSegments[0] || null;
    setSelectedSegment(first);
    selectedSegmentIdRef.current = first?.id || null;
    setContinuousStartId(first?.id || '');
    setContinuousEndId('');
    setPickingBoundary(null);
    setNoorSteps([]);
    setNoorFullReading('');
    setNoorDiacritizedWord('');
    setNoorAutoDiacritized(false);
    setWordAudioStatus(null);
    setAudioError(null);
    if (first) {
      void hydrateSegmentSavedInfo(first);
    }
  }, [currentPage?.id, currentPageIndex, activeSegments, hydrateSegmentSavedInfo]);

  const splitArabicSpeechChunks = (text: string): string[] => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const rawParts = clean
      .split(/(?<=[،.؛؟\n])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
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
    (mode: AudioMode, text: string, startChunkIdx = 0, onComplete?: () => void) => {
      const runToken = ++audioRunTokenRef.current;
      detachAndStopAudioElement();
      clearSpeechTimers();
      setAudioError(null);

      let completed = false;
      const fireComplete = () => {
        if (completed) return;
        completed = true;
        onComplete?.();
      };

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setAudioPlaying(false);
        setAudioError('متصفحك لا يدعم القراءة الصوتية التلقائية بدون خادم.');
        fireComplete();
        return;
      }

      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser cancel errors
      }

      const cleanText = text.trim();
      if (!cleanText) {
        fireComplete();
        return;
      }
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
        if (speechStateRef.current.startWatchdogId !== null) {
          window.clearTimeout(speechStateRef.current.startWatchdogId);
          speechStateRef.current.startWatchdogId = null;
        }
        if (speechStateRef.current.maxDurationId !== null) {
          window.clearTimeout(speechStateRef.current.maxDurationId);
          speechStateRef.current.maxDurationId = null;
        }

        if (idx >= chunks.length) {
          clearSpeechTimers();
          speechStateRef.current.active = false;
          setAudioPlaying(false);
          setAudioCurrentTime(estimatedSeconds);
          fireComplete();
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

        let utteranceStarted = false;
        let chunkSettled = false;

        const finishChunk = () => {
          if (chunkSettled) return;
          chunkSettled = true;
          if (speechStateRef.current.startWatchdogId !== null) {
            window.clearTimeout(speechStateRef.current.startWatchdogId);
            speechStateRef.current.startWatchdogId = null;
          }
          if (speechStateRef.current.maxDurationId !== null) {
            window.clearTimeout(speechStateRef.current.maxDurationId);
            speechStateRef.current.maxDurationId = null;
          }
          if (audioRunTokenRef.current !== runToken || !speechStateRef.current.active) return;
          speakChunkAt(idx + 1);
        };

        utterance.onstart = () => {
          utteranceStarted = true;
          if (speechStateRef.current.startWatchdogId !== null) {
            window.clearTimeout(speechStateRef.current.startWatchdogId);
            speechStateRef.current.startWatchdogId = null;
          }
        };

        utterance.onend = () => {
          finishChunk();
        };

        utterance.onerror = (ev) => {
          if (audioRunTokenRef.current !== runToken) return;
          if (ev.error === 'canceled' || ev.error === 'interrupted') return;
          if (idx + 1 < chunks.length) {
            finishChunk();
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
              'لا توجد حزمة صوت عربي مفعّلة في هذا المتصفح حالياً، لكن التهجي البصري معروض بالأسفل.'
            );
          } else {
            setAudioError('تعذّر تشغيل القارئ الصوتي في المتصفح مؤقتاً؛ اضغط أعد المحاولة.');
          }
          fireComplete();
        };

        speechStateRef.current.startWatchdogId = window.setTimeout(() => {
          if (audioRunTokenRef.current !== runToken || !speechStateRef.current.active || chunkSettled) {
            return;
          }
          if (!utteranceStarted && !window.speechSynthesis.speaking) {
            try {
              window.speechSynthesis.cancel();
            } catch {
              // Ignore
            }
            if (idx + 1 < chunks.length) {
              finishChunk();
            } else {
              clearSpeechTimers();
              speechStateRef.current.active = false;
              setAudioPlaying(false);
              const hasAnyArabicVoice = (window.speechSynthesis.getVoices() || []).some((v) =>
                v.lang.toLowerCase().startsWith('ar')
              );
              if (!hasAnyArabicVoice) {
                setAudioError(
                  'المتصفح الحالي لا يحتوي على صوت عربي مثبّت للنطق التلقائي؛ يظهر التهجي البصري بالأسفل.'
                );
              }
              fireComplete();
            }
          }
        }, 2200);

        speechStateRef.current.maxDurationId = window.setTimeout(
          () => {
            if (audioRunTokenRef.current !== runToken || !speechStateRef.current.active || chunkSettled) {
              return;
            }
            try {
              window.speechSynthesis.cancel();
            } catch {
              // Ignore
            }
            finishChunk();
          },
          Math.max(8500, chunkText.length * 165)
        );

        try {
          window.speechSynthesis.speak(utterance);
        } catch {
          clearSpeechTimers();
          speechStateRef.current.active = false;
          setAudioPlaying(false);
          fireComplete();
        }
      };

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
      badCacheKey?: string,
      onEndedCallback?: () => void
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
      let startedPlaying = false;
      const clearLoadWatchdog = () => {
        if (audioLoadWatchdogRef.current !== null) {
          window.clearTimeout(audioLoadWatchdogRef.current);
          audioLoadWatchdogRef.current = null;
        }
      };

      const triggerFallback = () => {
        if (fallbackHandled || audioRunTokenRef.current !== runToken) return;
        fallbackHandled = true;
        clearLoadWatchdog();
        detachAndStopAudioElement();
        if (badCacheKey) {
          void deleteCachedAudioEntry(badCacheKey);
        }
        if (onFallback) {
          onFallback();
        } else {
          setAudioPlaying(false);
          setAudioError('تعذّر تشغيل الملف الصوتي حالياً؛ تأكد من الاتصال وحاول مجدداً.');
          onEndedCallback?.();
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
        if (audioRunTokenRef.current !== runToken) return;
        clearLoadWatchdog();
        setAudioPlaying(false);
        setAudioCurrentTime(audio.duration || 0);
        onEndedCallback?.();
      };
      audio.onerror = () => {
        triggerFallback();
      };

      audioLoadWatchdogRef.current = window.setTimeout(() => {
        if (audioRunTokenRef.current === runToken && !startedPlaying && audio.paused) {
          triggerFallback();
        }
      }, 3500);

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

  const resolveSegmentAudio = useCallback(
    async (
      seg: BookTextSegment,
      mode: 'noor_albayan' | 'normal',
      options?: { callToken?: number; showUi?: boolean; segments?: BookTextSegment[] }
    ): Promise<ResolvedWordAudio> => {
      const normalizedText = seg.text.trim().replace(/\s+/g, ' ');
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
        if (options?.callToken !== undefined && audioRunTokenRef.current !== options.callToken) {
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

      // 1 & 2. Check Local Cache and ALL Library DB Shards (`wordAudio`)
      const saved = await lookupSavedWordRecord(mode, seg.text, ctx);
      if (saved) {
        applyBreakdownUi({
          diacritizedWord: saved.diacritizedWord,
          wasAutoDiacritized: saved.wasAutoDiacritized,
          steps: saved.steps,
          fullReading: saved.fullReading,
          sourceLabel:
            saved.source === 'local'
              ? 'محفوظة مسبقاً (تشغيل فوري من القاعدة)'
              : 'تم جلب الصوت المحفوظ من قاعدة المكتبة مباشرة',
        });
        return saved;
      }

      // 3. Deduplicate concurrent generation
      const existingInFlight = prefetchMapRef.current.get(cacheKey);
      if (existingInFlight) {
        const res = await existingInFlight;
        applyBreakdownUi({
          diacritizedWord: res.diacritizedWord,
          wasAutoDiacritized: res.wasAutoDiacritized,
          steps: res.steps,
          fullReading: res.fullReading,
          sourceLabel:
            res.source === 'generated'
              ? 'تم التوليد والحفظ تلقائياً في قاعدة المكتبة النشطة'
              : 'محفوظة مسبقاً',
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
        }

        // Persist into library DB shard so next opens read directly from DB
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
        }).then((savedRec) => {
          if (savedRec) {
            dbRecordSessionCacheRef.current.set(cacheKey, savedRec);
          }
        });

        return {
          cacheKey,
          source: 'generated',
          audioBase64,
          mimeType,
          diacritizedWord,
          wasAutoDiacritized,
          steps,
          fullReading: tts.text || fullReading,
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
              : 'تم تجهيز النطق وحفظ التفصيل في القاعدة النشطة',
        });
        return result;
      } finally {
        prefetchMapRef.current.delete(cacheKey);
      }
    },
    [currentUserId, getSegmentContext, lookupSavedWordRecord, workspace]
  );

  const handlePlayNoorAlBayan = useCallback(
    async (overrideSegment?: BookTextSegment) => {
      const targetSeg = overrideSegment || selectedSegment;
      if (!targetSeg) return;
      if (continuousStatus !== 'idle') {
        continuousTokenRef.current++;
        continuousPausedRef.current = false;
        setContinuousStatus('idle');
        setContinuousProgress(null);
      }
      const callToken = ++audioRunTokenRef.current;
      setAudioError(null);
      setAudioLoadingMode('noor_albayan');
      setNoorLoading(true);
      const safetyUnlockTimer = window.setTimeout(() => {
        if (audioRunTokenRef.current === callToken) {
          setNoorLoading(false);
          setAudioLoadingMode(null);
        }
      }, 12500);

      try {
        const resolved = await resolveSegmentAudio(targetSeg, 'noor_albayan', {
          callToken,
          showUi: true,
        });
        if (audioRunTokenRef.current !== callToken) return;

        const script = resolved.fullReading || targetSeg.text;
        if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
          const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
          await playAudioSource(
            'noor_albayan',
            url,
            true,
            () => playBrowserSpeech('noor_albayan', script),
            resolved.cacheKey
          );
        } else {
          playBrowserSpeech('noor_albayan', script);
        }
      } catch {
        const ctx = getSegmentContext(targetSeg);
        const fallback = generateNoorAlBayanClientFallback(targetSeg.text, {
          nextWord: ctx.nextWord,
          isEndOfAyah: ctx.isEndOfAyah,
        });
        setNoorDiacritizedWord(fallback.diacritizedWord);
        setNoorAutoDiacritized(fallback.wasAutoDiacritized);
        setNoorSteps(fallback.steps);
        setNoorFullReading(fallback.fullReading);
        playBrowserSpeech('noor_albayan', fallback.fullReading);
      } finally {
        window.clearTimeout(safetyUnlockTimer);
        setNoorLoading(false);
        setAudioLoadingMode(null);
      }
    },
    [
      continuousStatus,
      getSegmentContext,
      playAudioSource,
      playBrowserSpeech,
      resolveSegmentAudio,
      selectedSegment,
    ]
  );

  const handlePlayNormalReading = useCallback(
    async (overrideSegment?: BookTextSegment) => {
      const targetSeg = overrideSegment || selectedSegment;
      if (!targetSeg) return;
      if (continuousStatus !== 'idle') {
        continuousTokenRef.current++;
        continuousPausedRef.current = false;
        setContinuousStatus('idle');
        setContinuousProgress(null);
      }
      const callToken = ++audioRunTokenRef.current;
      setAudioError(null);
      setAudioLoadingMode('normal');
      const safetyUnlockTimer = window.setTimeout(() => {
        if (audioRunTokenRef.current === callToken) {
          setAudioLoadingMode(null);
        }
      }, 12500);

      try {
        const resolved = await resolveSegmentAudio(targetSeg, 'normal', {
          callToken,
          showUi: true,
        });
        if (audioRunTokenRef.current !== callToken) return;

        const script = resolved.fullReading || targetSeg.text;
        if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
          const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
          await playAudioSource(
            'normal',
            url,
            true,
            () => playBrowserSpeech('normal', script),
            resolved.cacheKey
          );
        } else {
          playBrowserSpeech('normal', script);
        }
      } catch {
        playBrowserSpeech('normal', targetSeg.text);
      } finally {
        window.clearTimeout(safetyUnlockTimer);
        setAudioLoadingMode(null);
      }
    },
    [continuousStatus, playAudioSource, playBrowserSpeech, resolveSegmentAudio, selectedSegment]
  );

  const handlePlaySheikhAyah = useCallback(
    async (overrideReciterId?: string, overrideSegment?: BookTextSegment) => {
      const targetSeg = overrideSegment || selectedSegment;
      if (!targetSeg) return;
      if (!targetSeg.surahNumber || !targetSeg.ayahNumber) {
        setAudioError('لم يتم تحديد رقم السورة والآية لهذه الكلمة؛ جرّب القراءة العادية أو التهجي.');
        return;
      }
      if (continuousStatus !== 'idle') {
        continuousTokenRef.current++;
        continuousPausedRef.current = false;
        setContinuousStatus('idle');
        setContinuousProgress(null);
      }
      const reciterId = overrideReciterId || selectedReciterId;
      const reciter = QURAN_RECITERS.find((r) => r.id === reciterId) || QURAN_RECITERS[0];
      setAudioError(null);
      setAudioLoadingMode('sheikh');
      try {
        const url = getReciterAyahAudioUrl(
          reciter.everyAyahFolder,
          targetSeg.surahNumber,
          targetSeg.ayahNumber
        );
        await playAudioSource('sheikh', url, false, () => {
          playBrowserSpeech('normal', targetSeg.text);
        });
      } catch {
        playBrowserSpeech('normal', targetSeg.text);
      } finally {
        setAudioLoadingMode(null);
      }
    },
    [continuousStatus, playAudioSource, playBrowserSpeech, selectedReciterId, selectedSegment]
  );

  const handleSelectSegment = (seg: BookTextSegment) => {
    if (pickingBoundary === 'start') {
      const pickedIdx = activeSegments.findIndex((s) => s.id === seg.id);
      const endIdx = continuousEndId
        ? activeSegments.findIndex((s) => s.id === continuousEndId)
        : -1;
      setContinuousStartId(seg.id);
      if (endIdx >= 0 && pickedIdx > endIdx) {
        setContinuousEndId('');
      }
      setSelectedSegment(seg);
      setPickingBoundary(null);
      setAudioError(null);
      void hydrateSegmentSavedInfo(seg);
      return;
    }
    if (pickingBoundary === 'end') {
      const pickedIdx = activeSegments.findIndex((s) => s.id === seg.id);
      const startIdx = continuousStartId
        ? activeSegments.findIndex((s) => s.id === continuousStartId)
        : -1;
      setContinuousEndId(seg.id);
      if (startIdx < 0 || startIdx > pickedIdx) {
        setContinuousStartId(seg.id);
        setSelectedSegment(seg);
        void hydrateSegmentSavedInfo(seg);
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
      const pickedIdx = activeSegments.findIndex((s) => s.id === seg.id);
      const endIdx = activeSegments.findIndex((s) => s.id === continuousEndId);
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
    void hydrateSegmentSavedInfo(seg);

    if (autoPlayOnTap) {
      if (seg.kind === 'ayah' && seg.surahNumber && seg.ayahNumber) {
        void handlePlaySheikhAyah(undefined, seg);
      } else if (continuousMode === 'normal') {
        void handlePlayNormalReading(seg);
      } else {
        void handlePlayNoorAlBayan(seg);
      }
    }
  };

  const resolveConnectedPhraseAudio = useCallback(
    async (
      phraseText: string
    ): Promise<{ base64Wav: string; mimeType: string; cacheKey: string } | null> => {
      const cleanPhrase = normalizeUthmaniForTts(phraseText) || phraseText.trim();
      if (!cleanPhrase) return null;
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
        } catch {
          // Fall back cleanly in caller
        }
        return null;
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

      const callToken = ++audioRunTokenRef.current;
      const stepCacheKey = `step_v4_${spokenStep}`;
      setAudioError(null);
      setAudioLoadingMode('noor_albayan');

      try {
        let wav = await getCachedAudioEntry(stepCacheKey);
        if (!wav || !wav.base64Wav || wav.base64Wav.length <= 120) {
          const tts = await synthesizeSpeechOnServer({
            text: spokenStep,
            mode: 'noor_albayan',
          }).catch(() => null);
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
          }
        }
        if (audioRunTokenRef.current !== callToken) return;
        if (wav?.base64Wav && wav.base64Wav.length > 120) {
          const url = base64AudioToObjectUrl(wav.base64Wav, wav.mimeType || 'audio/wav');
          await playAudioSource(
            'noor_albayan',
            url,
            true,
            () => playBrowserSpeech('noor_albayan', spokenStep),
            stepCacheKey
          );
        } else {
          playBrowserSpeech('noor_albayan', spokenStep);
        }
      } catch {
        playBrowserSpeech('noor_albayan', spokenStep);
      } finally {
        if (audioRunTokenRef.current === callToken) {
          setAudioLoadingMode(null);
        }
      }
    },
    [continuousStatus, playAudioSource, playBrowserSpeech, stopContinuousReading]
  );

  const getSegmentsForPage = (p?: BookPageRecord): BookTextSegment[] => {
    if (!p) return [];
    if (Array.isArray(p.segments) && p.segments.length > 0) return p.segments;
    const rawTokens = String(p.fullText || '')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
    return rawTokens.slice(0, 350).map((word, idx) => ({
      id: `txt_p${p.pageNumber}_${idx + 1}`,
      text: word,
      plainText: word,
      kind: 'word' as const,
      box: [0, 0, 0, 0] as [number, number, number, number],
    }));
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
          const pSegs = getSegmentsForPage(pages[p]);
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

      for (let pIdx = startPageIdx; pIdx < pages.length && !reachedEnd; pIdx++) {
        if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;
        const page = pages[pIdx];
        const segs = getSegmentsForPage(page);
        if (!page || segs.length === 0) continue;

        if (pIdx !== currentPageIndex) {
          onChangePageIndex(pIdx, true);
          await new Promise((r) => window.setTimeout(r, 90));
        }
        if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;

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
              ? getSegmentsForPage(pages[pIdx + 1])
              : [];
          const nextSeg = nextSegOnSamePage || nextPageSegs[0];
          if (nextSeg) {
            void resolveSegmentAudio(nextSeg, wordAudioMode, {
              showUi: false,
              segments: nextSegOnSamePage ? segs : nextPageSegs,
            }).catch(() => {});
          }

          // Prefetch cumulative connected phrase while current word's Tahajji plays
          const currentPhraseText =
            mode === 'cumulative_tahajji'
              ? buildCumulativePhraseText(pIdx, sIdx)
              : '';
          const isCumulativeStep =
            mode === 'cumulative_tahajji' &&
            (pIdx > anchorPageIdx || sIdx > anchorSegIdx) &&
            currentPhraseText.length > 0;
          if (isCumulativeStep) {
            void resolveConnectedPhraseAudio(currentPhraseText).catch(() => {});
          }

          const resolved = await resolveSegmentAudio(seg, wordAudioMode, {
            showUi: true,
            segments: segs,
          });
          if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;

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

          await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const safetyMaxWait = wordAudioMode === 'noor_albayan' ? 28000 : 14000;
            const safetyTimer = window.setTimeout(done, safetyMaxWait);
            const finishWord = () => {
              window.clearTimeout(safetyTimer);
              done();
            };

            const script = resolved.fullReading || seg.text;
            if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
              const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
              void playAudioSource(
                wordAudioMode,
                url,
                true,
                () => playBrowserSpeech(wordAudioMode, script, 0, finishWord),
                resolved.cacheKey,
                finishWord
              );
            } else {
              playBrowserSpeech(wordAudioMode, script, 0, finishWord);
            }
          });

          if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;

          // If in Cumulative Tahajji mode and we have accumulated > 1 word, read the connected phrase!
          if (isCumulativeStep) {
            await new Promise((r) => window.setTimeout(r, 180));
            if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;

            setContinuousProgress({
              currentIndex: sIdx + 1,
              totalCount: segs.length,
              wordText: seg.text,
              pageNumber: page.pageNumber,
              sourceLabel: 'الربط التجميعي من البداية حتى هذه الكلمة',
              cumulativePhrase: currentPhraseText,
            });

            const phraseWav = await resolveConnectedPhraseAudio(currentPhraseText);
            if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;

            await new Promise<void>((resolve) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              const safetyTimer = window.setTimeout(
                done,
                Math.min(45000, Math.max(12000, currentPhraseText.length * 140))
              );
              const finishPhrase = () => {
                window.clearTimeout(safetyTimer);
                done();
              };

              if (phraseWav && phraseWav.base64Wav.length > 120) {
                const url = base64AudioToObjectUrl(phraseWav.base64Wav, phraseWav.mimeType);
                void playAudioSource(
                  'normal',
                  url,
                  true,
                  () => playBrowserSpeech('normal', currentPhraseText, 0, finishPhrase),
                  phraseWav.cacheKey,
                  finishPhrase
                );
              } else {
                playBrowserSpeech('normal', currentPhraseText, 0, finishPhrase);
              }
            });

            if (continuousTokenRef.current !== loopToken || continuousPausedRef.current) return;
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
      currentPageIndex,
      onChangePageIndex,
      pages,
      playAudioSource,
      playBrowserSpeech,
      resolveConnectedPhraseAudio,
      resolveSegmentAudio,
    ]
  );

  const handleStartContinuousReading = () => {
    if (activeSegments.length === 0) return;
    let startIdx = activeSegments.findIndex((s) => s.id === continuousStartId);
    if (startIdx < 0 && selectedSegment) {
      startIdx = activeSegments.findIndex((s) => s.id === selectedSegment.id);
    }
    if (startIdx < 0) startIdx = 0;

    let validEndId = continuousEndId;
    if (validEndId) {
      const endIdx = activeSegments.findIndex((s) => s.id === validEndId);
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

  const activeReciter =
    QURAN_RECITERS.find((r) => r.id === selectedReciterId) || QURAN_RECITERS[0];

  if (!currentPage) return null;

  return (
    <div className="w-full max-w-7xl mx-auto space-y-4">
      {/* Continuous Reading Control Bar */}
      {activeSegments.length > 0 && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-3 shadow-xs">
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
                  يقرأ الكلمات بالتسلسل ويجلب الصوت المحفوظ فوراً من القاعدة أو ينشئه ويحفظه تلقائياً
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAutoPlayOnTap((v) => !v)}
                className={`min-h-[36px] px-3 rounded-xl border-2 font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                  autoPlayOnTap
                    ? 'bg-[#58CC02] border-[#46A302] text-white'
                    : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#58CC02]'
                }`}
              >
                <Zap className="w-3.5 h-3.5 shrink-0" />
                <span>نطق مباشر عند لمس الكلمة: {autoPlayOnTap ? 'مفعّل' : 'متوقف'}</span>
              </button>

              {/* Mode Selector: بالتهجي / تهجي تجميعي / سريعة */}
              <div className="flex flex-wrap items-center gap-1.5 bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-1">
                <button
                  type="button"
                  disabled={continuousStatus === 'playing'}
                  onClick={() => setContinuousMode('noor_albayan')}
                  className={`min-h-[36px] px-3 rounded-xl font-display font-bold text-xs cursor-pointer transition-colors disabled:opacity-60 ${
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
                  className={`min-h-[36px] px-3 rounded-xl font-display font-bold text-xs cursor-pointer transition-colors disabled:opacity-60 ${
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
                  className={`min-h-[36px] px-3 rounded-xl font-display font-bold text-xs cursor-pointer transition-colors disabled:opacity-60 ${
                    continuousMode === 'normal'
                      ? 'bg-[#46A302] text-white'
                      : 'text-[#4A220D] hover:bg-white'
                  }`}
                >
                  سريعة (قراءة عادية)
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
            {/* Start word selector */}
            <div className="lg:col-span-4 flex items-center gap-1.5">
              <label
                htmlFor="teacher-continuous-start-select"
                className="text-xs font-bold text-[#7D4E35] shrink-0 whitespace-nowrap"
              >
                ابدأ من:
              </label>
              <select
                id="teacher-continuous-start-select"
                disabled={continuousStatus === 'playing'}
                value={continuousStartId || selectedSegment?.id || activeSegments[0]?.id || ''}
                onChange={(e) => {
                  const seg = activeSegments.find((s) => s.id === e.target.value);
                  if (seg) {
                    setContinuousStartId(seg.id);
                    setSelectedSegment(seg);
                    if (continuousEndId) {
                      const sI = activeSegments.findIndex((x) => x.id === seg.id);
                      const eI = activeSegments.findIndex((x) => x.id === continuousEndId);
                      if (eI >= 0 && sI > eI) setContinuousEndId('');
                    }
                    void hydrateSegmentSavedInfo(seg);
                  }
                }}
                className="w-full min-w-0 min-h-[42px] px-2.5 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D]"
              >
                {activeSegments.map((seg, i) => (
                  <option key={seg.id} value={seg.id}>
                    {toArabicIndicDigits(i + 1)}. {seg.text.slice(0, 32)}
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
                htmlFor="teacher-continuous-end-select"
                className="text-xs font-bold text-[#7D4E35] shrink-0 whitespace-nowrap"
              >
                انتهِ عند:
              </label>
              <select
                id="teacher-continuous-end-select"
                disabled={continuousStatus === 'playing'}
                value={continuousEndId}
                onChange={(e) => {
                  const val = e.target.value;
                  setContinuousEndId(val);
                  if (val) {
                    const eI = activeSegments.findIndex((x) => x.id === val);
                    const sI = activeSegments.findIndex((x) => x.id === continuousStartId);
                    if (sI < 0 || sI > eI) {
                      const endSeg = activeSegments[eI];
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
                {activeSegments.map((seg, i) => (
                  <option key={seg.id} value={seg.id}>
                    {toArabicIndicDigits(i + 1)}. {seg.text.slice(0, 32)}
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
            <div className="bg-[#FDF6EE] border border-[#58CC02]/40 rounded-2xl px-4 py-2.5 space-y-1.5 text-xs font-bold">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[#4A220D]">
                  <Volume2 className="w-4 h-4 text-[#46A302] shrink-0" />
                  <span>
                    صفحة {toArabicIndicDigits(continuousProgress.pageNumber)} · كلمة{' '}
                    {toArabicIndicDigits(continuousProgress.currentIndex)} من{' '}
                    {toArabicIndicDigits(continuousProgress.totalCount)}:
                  </span>
                  <span className="font-display font-extrabold text-sm text-[#F56900]">
                    {continuousProgress.wordText}
                  </span>
                </div>
                <span className="text-[11px] font-bold text-[#46A302] inline-flex items-center gap-1">
                  <Database className="w-3.5 h-3.5" />
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
        </div>
      )}

      {/* Main 12-Column Interactive Page + Audio Inspector */}
      <div
        key={flipSeq}
        className={`grid grid-cols-1 lg:grid-cols-12 gap-5 items-start ${
          flipDirection === 'next'
            ? 'animate-mushaf-next'
            : flipDirection === 'prev'
            ? 'animate-mushaf-prev'
            : ''
        }`}
      >
        {/* Left / Right Main Book Canvas + Interactive Overlays + Word Strip */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-2.5 sm:p-4 shadow-sm overflow-auto">
            <div
              style={{
                width: zoomPercent === 100 ? '100%' : `${zoomPercent}%`,
                maxWidth: zoomPercent > 100 ? 'none' : '100%',
              }}
              className="relative mx-auto overflow-hidden rounded-2xl border border-[#EADBC8] bg-[#FDF6EE]"
            >
              <img
                src={currentPage.imageDataUrl}
                alt={`صفحة ${currentPage.pageNumber} من ${bookTitle}`}
                className="w-full h-auto block select-none"
                draggable={false}
              />
              {/* Clickable Hotspots over recognized words & ayahs */}
              {(() => {
                const startIdx = continuousStartId
                  ? currentPage.segments.findIndex((x) => x.id === continuousStartId)
                  : -1;
                const endIdx = continuousEndId
                  ? currentPage.segments.findIndex((x) => x.id === continuousEndId)
                  : -1;
                return currentPage.segments.map((seg, segIdx) => {
                  const [ymin, xmin, ymax, xmax] = seg.box;
                  if (!(ymax > ymin && xmax > xmin)) return null;
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

          {/* Extracted Interactive Words Strip */}
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-sm sm:text-base font-extrabold text-[#4A220D]">
                كلمات الصفحة المتعرّف عليها ({toArabicIndicDigits(activeSegments.length)})
              </h3>
              <span className="text-xs text-[#7D4E35]">
                اضغط على أي كلمة أو آية في الصورة أو القائمة للقراءة
              </span>
            </div>

            {activeSegments.length === 0 ? (
              <p className="text-sm text-[#7D4E35]">
                {currentPage.fullText || 'لم يتم استخراج مقاطع نصية من هذه الصفحة.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2 leading-loose" dir="rtl">
                {(() => {
                  const startIdx = continuousStartId
                    ? activeSegments.findIndex((x) => x.id === continuousStartId)
                    : -1;
                  const endIdx = continuousEndId
                    ? activeSegments.findIndex((x) => x.id === continuousEndId)
                    : -1;
                  return activeSegments.map((seg, segIdx) => {
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
                            ﴿{toArabicIndicDigits(seg.ayahNumber)}﴾
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

        {/* Right / Interactive Word & Ayah Reading Inspector */}
        <div className="lg:col-span-5 lg:sticky lg:top-2 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto space-y-4">
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
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-5 shadow-sm">
              <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#F7EBDD]">
                <span className="font-display text-sm font-extrabold text-[#F56900]">
                  {selectedSegment.kind === 'ayah'
                    ? `آية قرآنية${
                        selectedSegment.surahName ? ` · سورة ${selectedSegment.surahName}` : ''
                      }${
                        selectedSegment.ayahNumber
                          ? ` (${toArabicIndicDigits(selectedSegment.ayahNumber)})`
                          : ''
                      }`
                    : 'كلمة / جملة قرائية'}
                </span>
                <Sparkles className="w-4 h-4 text-[#F56900]" />
              </div>

              {/* Cropped Original Word Image + Diacritized Text */}
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3 text-center">
                {selectedSegment.box[2] > selectedSegment.box[0] && (
                  <p className="text-[11px] font-bold text-[#7D4E35]">
                    صورة الكلمة من صفحة الكتاب الأصلية
                  </p>
                )}
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

              {/* Primary Reading Buttons */}
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

              {/* Option 3: Sheikh Selection for Quranic Ayahs */}
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
                      htmlFor="teacher-book-reciter-select"
                      className="block text-xs font-bold text-[#7D4E35]"
                    >
                      اختر الشيخ القارئ:
                    </label>
                    <select
                      id="teacher-book-reciter-select"
                      value={selectedReciterId}
                      onChange={(e) => {
                        setSelectedReciterId(e.target.value);
                        if (rememberTeacherReciter) {
                          saveTeacherReciterId(e.target.value);
                        }
                      }}
                      className="w-full min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
                    >
                      {QURAN_RECITERS.map((reciter, idx) => (
                        <option key={reciter.id} value={reciter.id}>
                          {toArabicIndicDigits(idx + 1)}. {reciter.name} ({reciter.style})
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

              {audioError && (
                <div
                  role="alert"
                  className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{audioError}</span>
                </div>
              )}

              {/* Active Audio Transport Controls */}
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

              {/* Al-Fath Al-Rabbani Spelling Breakdown Steps */}
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
                              {toArabicIndicDigits(i + 1)}
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
    </div>
  );
};
