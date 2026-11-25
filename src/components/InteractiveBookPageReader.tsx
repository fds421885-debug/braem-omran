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
  canonicalizeArabicForAudioKey,
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
  ttsError?: string;
  ttsRetryAfterMs?: number;
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
  const prefetchMapRef = useRef<Map<string, Promise<ResolvedWordAudio>>>(new Map());
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
  const dbRecordSessionCacheRef = useRef<Map<string, BookWordAudioRecord | null>>(new Map());
  const activeNavSeqRef = useRef<number>(manualNavigationSeq);
  const selectedSegmentIdRef = useRef<string | null>(null);
  selectedSegmentIdRef.current = selectedSegment?.id || null;
  const continuousStatusRef = useRef<'idle' | 'playing' | 'paused'>('idle');
  continuousStatusRef.current = continuousStatus;
  const lastPageKeyRef = useRef<string>('');

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
      const normalizedText =
        canonicalizeArabicForAudioKey(wordText) || wordText.trim().replace(/\s+/g, ' ');
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

      // Load-start watchdog only if playback never even began within 8 seconds
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

          // Only persist completed audio into library DB shards so failed/busy attempts never store empty audio
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
              `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(remSec)} ث)...`
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
    },
    [
      continuousStatus,
      detachAndStopAudioElement,
      playAudioSource,
      resolveSegmentAudio,
      selectedSegment,
      waitWithCancellation,
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
      const callToken = ++audioRequestTokenRef.current;
      detachAndStopAudioElement();
      setAudioError(null);
      setAudioLoadingMode('normal');

      const isCancelled = () => audioRequestTokenRef.current !== callToken;

      try {
        const maxAttempts = 6;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (isCancelled()) return;
          const resolved = await resolveSegmentAudio(targetSeg, 'normal', {
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
              `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(remSec)} ث)...`
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
    },
    [
      continuousStatus,
      detachAndStopAudioElement,
      playAudioSource,
      resolveSegmentAudio,
      selectedSegment,
      waitWithCancellation,
    ]
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
      const callToken = ++audioRequestTokenRef.current;
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
    },
    [continuousStatus, playAudioSource, selectedReciterId, selectedSegment]
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
                `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين عودة النطق تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(remSec)} ث)...`
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
              const waitMsg = `هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(remSec)} ث)...`;
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

          // Prefetch next item gently in background while playing current word cleanly
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

          // If in Cumulative Tahajji mode and we have accumulated > 1 word, read the connected phrase strictly to completion!
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
                const waitMsg = `هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لاستكمال الربط التجميعي تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(remSec)} ث)...`;
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
      currentPageIndex,
      onChangePageIndex,
      pages,
      playAudioStrict,
      resolveConnectedPhraseAudio,
      resolveSegmentAudio,
      stopAndResetAudio,
      waitWithCancellation,
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
                    صفحة {toArabicIndicDigits(continuousProgress.pageNumber)} · كلمة{' '}
                    {toArabicIndicDigits(continuousProgress.currentIndex)} من{' '}
                    {toArabicIndicDigits(continuousProgress.totalCount)}:
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
