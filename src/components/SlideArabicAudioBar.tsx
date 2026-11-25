import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Headphones,
  Loader2,
  Pause,
  Play,
  Repeat,
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
import { generateNoorAlBayanClientFallback } from '../services/clientArabicEngine';
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
  type NoorAlBayanStep,
  type PresentationInteractiveBlock,
} from '../types/platform';

export interface SlideAudioTarget {
  text: string;
  type: 'ayah' | 'tahajji_words' | 'card' | 'tip';
  surahNumber?: number;
  ayahNumber?: number;
  surahName?: string;
  label?: string;
}

export type SlideAudioPlayMode = 'noor_albayan' | 'normal' | 'cumulative_tahajji' | 'sheikh';

export interface SlideAudioCommand {
  id: number;
  target: SlideAudioTarget;
  mode: SlideAudioPlayMode;
}

interface SlideArabicAudioBarProps {
  workspace: ComplexWorkspaceData;
  currentUserId: string;
  selectedTarget: SlideAudioTarget | null;
  slideBlocks: PresentationInteractiveBlock[];
  onSelectTarget: (target: SlideAudioTarget) => void;
  commandRequest?: SlideAudioCommand | null;
  slideKey?: string;
  compact?: boolean;
}

type AudioMode = 'noor_albayan' | 'normal' | 'cumulative_tahajji' | 'sheikh';
type SequentialMode = 'noor_albayan' | 'normal' | 'sheikh_and_normal';

/**
 * Module-level singleton coordinator: guarantees at most ONE audio element and
 * ONE async playback loop can ever be active at any moment across the studio/fullscreen.
 */
let globalPlaybackEpoch = 0;
let globalActiveAudioEl: HTMLAudioElement | null = null;
let globalActiveObjectUrl: string | null = null;
let globalActiveStopHandler: (() => void) | null = null;

function detachGlobalAudioElement(): void {
  const audio = globalActiveAudioEl;
  globalActiveAudioEl = null;
  if (audio) {
    audio.onloadedmetadata = null;
    audio.ontimeupdate = null;
    audio.onplay = null;
    audio.onpause = null;
    audio.onended = null;
    audio.onerror = null;
    audio.onstalled = null;
    try {
      audio.pause();
      audio.src = '';
    } catch {
      // Ignore cleanup errors
    }
  }
  if (globalActiveObjectUrl) {
    try {
      URL.revokeObjectURL(globalActiveObjectUrl);
    } catch {
      // Ignore revoke errors
    }
    globalActiveObjectUrl = null;
  }
}

function claimGlobalAudioStop(callerStopHandler: () => void): number {
  globalPlaybackEpoch += 1;
  detachGlobalAudioElement();
  const prevStop = globalActiveStopHandler;
  globalActiveStopHandler = callerStopHandler;
  if (prevStop && prevStop !== callerStopHandler) {
    try {
      prevStop();
    } catch {
      // Non-fatal
    }
  }
  return globalPlaybackEpoch;
}

function extractCleanArabicWords(text: string): string[] {
  const normalized = canonicalizeArabicForAudioKey(text) || text.trim().replace(/\s+/g, ' ');
  return normalized
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * Splits long Arabic verses/phrases into short 4–7 word segments so Gemini TTS
 * stays fast (< 3s), fits cleanly inside Firestore cache limits, and never hangs.
 */
function splitArabicIntoSafePhrases(text: string, maxWords = 7): string[] {
  const normalized = canonicalizeArabicForAudioKey(text) || text.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const clauses = normalized
    .split(/([،؛.!؟۞۝:]+)/)
    .reduce<string[]>((acc, part) => {
      const cleaned = part.trim();
      if (!cleaned) return acc;
      if (/^[،؛.!؟۞۝:]+$/.test(cleaned) && acc.length > 0) {
        acc[acc.length - 1] = `${acc[acc.length - 1]}${cleaned}`.trim();
      } else {
        acc.push(cleaned);
      }
      return acc;
    }, []);

  const chunks: string[] = [];
  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      if (words.length > 0) chunks.push(words.join(' '));
      continue;
    }
    for (let i = 0; i < words.length; i += maxWords) {
      const slice = words.slice(i, i + maxWords).join(' ').trim();
      if (slice) chunks.push(slice);
    }
  }
  return chunks.length > 0 ? chunks : [normalized];
}

export const SlideArabicAudioBar: React.FC<SlideArabicAudioBarProps> = ({
  workspace,
  currentUserId,
  selectedTarget,
  slideBlocks,
  onSelectTarget,
  commandRequest = null,
  slideKey,
  compact = false,
}) => {
  const [selectedReciterId, setSelectedReciterId] = useState<string>(() =>
    getSavedTeacherReciterId()
  );
  const [noorLoading, setNoorLoading] = useState(false);
  const [noorSteps, setNoorSteps] = useState<NoorAlBayanStep[]>([]);
  const [noorFullReading, setNoorFullReading] = useState<string>('');
  const [noorDiacritizedWord, setNoorDiacritizedWord] = useState<string>('');
  const [audioLoadingMode, setAudioLoadingMode] = useState<AudioMode | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [activeAudioMode, setActiveAudioMode] = useState<AudioMode | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [wordStatusNote, setWordStatusNote] = useState<string | null>(null);
  const [cumulativeBanner, setCumulativeBanner] = useState<string | null>(null);

  // Strict sequential reading over interactive blocks/words on the slide
  const [seqMode, setSeqMode] = useState<SequentialMode>('noor_albayan');
  const [seqPlaying, setSeqPlaying] = useState(false);
  const [seqIndex, setSeqIndex] = useState<number>(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const runTokenRef = useRef<number>(0);
  const requestTokenRef = useRef<number>(0);
  const seqTokenRef = useRef<number>(0);
  const lastHandledCommandIdRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  const clearUiStateOnly = useCallback(() => {
    runTokenRef.current += 1;
    requestTokenRef.current += 1;
    seqTokenRef.current += 1;
    audioRef.current = null;
    if (!isMountedRef.current) return;
    setSeqPlaying(false);
    setAudioPlaying(false);
    setActiveAudioMode(null);
    setAudioLoadingMode(null);
    setNoorLoading(false);
    setCumulativeBanner(null);
  }, []);

  const stopAllAudio = useCallback(() => {
    claimGlobalAudioStop(clearUiStateOnly);
    clearUiStateOnly();
  }, [clearUiStateOnly]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      runTokenRef.current += 1;
      requestTokenRef.current += 1;
      seqTokenRef.current += 1;
      if (globalActiveStopHandler === clearUiStateOnly) {
        globalPlaybackEpoch += 1;
        detachGlobalAudioElement();
        globalActiveStopHandler = null;
      }
    };
  }, [clearUiStateOnly]);

  // Stop active playback cleanly whenever user switches slides
  const prevSlideKeyRef = useRef<string | undefined>(slideKey);
  useEffect(() => {
    if (prevSlideKeyRef.current !== slideKey) {
      prevSlideKeyRef.current = slideKey;
      stopAllAudio();
      setAudioError(null);
    }
  }, [slideKey, stopAllAudio]);

  useEffect(() => {
    if (!selectedTarget) {
      setNoorSteps([]);
      setNoorFullReading('');
      setNoorDiacritizedWord('');
      setWordStatusNote(null);
      return;
    }
    const instant = generateNoorAlBayanClientFallback(selectedTarget.text, {});
    setNoorDiacritizedWord(instant.diacritizedWord);
    setNoorSteps(instant.steps);
    setNoorFullReading(instant.fullReading);
    setAudioError(null);
  }, [selectedTarget]);

  const waitWithCancellation = useCallback(
    async (
      totalMs: number,
      isCancelled: () => boolean,
      onTick?: (remSec: number) => void
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

  const playAudioStrict = useCallback(
    (
      mode: AudioMode,
      url: string,
      isObjectUrl: boolean,
      badCacheKey: string | undefined,
      isCancelled: () => boolean
    ): Promise<'ended' | 'error' | 'cancelled'> => {
      return new Promise((resolve) => {
        if (isCancelled() || !isMountedRef.current) {
          if (isObjectUrl) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              // Ignore
            }
          }
          resolve('cancelled');
          return;
        }

        // Synchronously detach any previous audio element before creating a clean new one
        detachGlobalAudioElement();
        const runToken = ++runTokenRef.current;
        const audio = new Audio();
        audioRef.current = audio;
        globalActiveAudioEl = audio;
        if (isObjectUrl) {
          globalActiveObjectUrl = url;
        }

        let settled = false;
        let startedPlaying = false;
        let guardId: number | null = null;
        let startWatchdogId: number | null = null;

        const finish = (outcome: 'ended' | 'error' | 'cancelled') => {
          if (settled) return;
          settled = true;
          if (guardId !== null) window.clearInterval(guardId);
          if (startWatchdogId !== null) window.clearTimeout(startWatchdogId);

          audio.onloadedmetadata = null;
          audio.ontimeupdate = null;
          audio.onplay = null;
          audio.onpause = null;
          audio.onended = null;
          audio.onerror = null;
          audio.onstalled = null;

          if (globalActiveAudioEl === audio) {
            try {
              audio.pause();
              audio.src = '';
            } catch {
              // Ignore
            }
            globalActiveAudioEl = null;
          }
          if (audioRef.current === audio) {
            audioRef.current = null;
          }
          if (isObjectUrl && globalActiveObjectUrl === url) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              // Ignore
            }
            globalActiveObjectUrl = null;
          }
          if (isMountedRef.current && runTokenRef.current === runToken) {
            setAudioPlaying(false);
            if (outcome !== 'ended') {
              setActiveAudioMode(null);
            }
          }
          resolve(outcome);
        };

        audio.preload = 'auto';
        audio.src = url;

        audio.onplay = () => {
          if (settled || runTokenRef.current !== runToken || isCancelled()) {
            finish('cancelled');
            return;
          }
          if (isMountedRef.current) {
            setAudioPlaying(true);
          }
        };
        audio.ontimeupdate = () => {
          if (settled || runTokenRef.current !== runToken || isCancelled()) return;
          if ((audio.currentTime || 0) > 0.01) {
            startedPlaying = true;
          }
        };
        audio.onpause = () => {
          if (settled || runTokenRef.current !== runToken) return;
          if (isMountedRef.current) setAudioPlaying(false);
        };
        audio.onended = () => {
          if (settled || runTokenRef.current !== runToken) {
            finish('cancelled');
            return;
          }
          finish('ended');
        };
        audio.onerror = () => {
          if (settled || runTokenRef.current !== runToken || isCancelled()) {
            finish('cancelled');
            return;
          }
          if (badCacheKey) void deleteCachedAudioEntry(badCacheKey);
          finish('error');
        };

        // Initial buffering/playback start watchdog (covers stuck buffering or blocked autoplay)
        startWatchdogId = window.setTimeout(() => {
          if (!settled && runTokenRef.current === runToken && !startedPlaying) {
            if (badCacheKey) void deleteCachedAudioEntry(badCacheKey);
            finish('error');
          }
        }, 9000);

        let lastTime = -1;
        let stalledSince = 0;
        guardId = window.setInterval(() => {
          if (settled) return;
          if (isCancelled() || runTokenRef.current !== runToken || !isMountedRef.current) {
            finish('cancelled');
            return;
          }
          if (audio.ended) {
            finish('ended');
            return;
          }

          const ct = audio.currentTime || 0;

          // User clicked Pause intentionally: do not trigger stall error while paused
          if (audio.paused && startedPlaying) {
            stalledSince = 0;
            return;
          }

          // Playback is actively advancing
          if (!audio.paused && Math.abs(ct - lastTime) > 0.01) {
            lastTime = ct;
            stalledSince = 0;
            if (ct > 0.01) startedPlaying = true;
            return;
          }

          // Workaround for embedded Chromium iframes where currentTime stops just at duration without firing onended
          if (
            startedPlaying &&
            Number.isFinite(audio.duration) &&
            audio.duration > 0.15 &&
            ct >= audio.duration - 0.12
          ) {
            if (stalledSince === 0) {
              stalledSince = Date.now();
            } else if (Date.now() - stalledSince > 900) {
              finish('ended');
            }
            return;
          }

          // Audio is not paused yet currentTime has completely frozen -> track real stall duration
          if (!audio.paused) {
            if (stalledSince === 0) {
              stalledSince = Date.now();
            } else if (Date.now() - stalledSince > 9500) {
              if (badCacheKey) void deleteCachedAudioEntry(badCacheKey);
              finish('error');
            }
          }
        }, 350);

        if (isMountedRef.current) {
          setAudioError(null);
          setActiveAudioMode(mode);
        }

        audio.play().catch(() => {
          if (!settled) {
            finish(isCancelled() ? 'cancelled' : 'error');
          }
        });
      });
    },
    []
  );

  const resolveAudioClip = useCallback(
    async (
      text: string,
      mode: 'noor_albayan' | 'normal',
      surahName?: string,
      showUi = true
    ): Promise<{
      cacheKey: string;
      audioBase64: string;
      mimeType: string;
      diacritizedWord: string;
      steps: NoorAlBayanStep[];
      fullReading: string;
      ttsError?: string;
      ttsRetryAfterMs?: number;
      ttsRetryable: boolean;
    }> => {
      const clean =
        canonicalizeArabicForAudioKey(text) || text.trim().replace(/\s+/g, ' ');
      const cacheKey = `${mode === 'noor_albayan' ? 'fath_v4' : 'normal_v2'}_${clean}`;

      // 1. Browser IndexedDB cache
      const local = await getCachedAudioEntry(cacheKey).catch(() => null);
      if (local && local.base64Wav && local.base64Wav.length > 120) {
        if (showUi && mode === 'noor_albayan' && isMountedRef.current) {
          setNoorDiacritizedWord(local.diacritizedWord || clean);
          setNoorSteps(local.steps || []);
          setNoorFullReading(local.fullReading || clean);
          setWordStatusNote('صوت محفوظ جاهز (تشغيل فوري)');
        }
        return {
          cacheKey,
          audioBase64: local.base64Wav,
          mimeType: local.mimeType || 'audio/wav',
          diacritizedWord: local.diacritizedWord || clean,
          steps: local.steps || [],
          fullReading: local.fullReading || clean,
          ttsRetryable: true,
        };
      }

      // 2. Global Audio Pool -> Presentations DB -> Library DB cache
      const dbRec = await lookupWordAudioAcrossLibrary(workspace, mode, clean, '', {
        preferredTabKey: 'presentations',
      }).catch(() => null);
      if (dbRec && dbRec.audioBase64 && dbRec.audioBase64.length > 120) {
        await saveCachedAudioEntry({
          key: cacheKey,
          base64Wav: dbRec.audioBase64,
          mimeType: dbRec.mimeType || 'audio/wav',
          diacritizedWord: dbRec.diacritizedWord,
          wasAutoDiacritized: dbRec.wasAutoDiacritized,
          steps: dbRec.steps || [],
          fullReading: dbRec.fullReading,
          updatedAtMs: Date.now(),
        }).catch(() => {});
        if (showUi && mode === 'noor_albayan' && isMountedRef.current) {
          setNoorDiacritizedWord(dbRec.diacritizedWord || clean);
          setNoorSteps(dbRec.steps || []);
          setNoorFullReading(dbRec.fullReading || clean);
          setWordStatusNote('تم جلب الصوت من قاعدة البيانات (متاح عبر كل الأجهزة)');
        }
        return {
          cacheKey,
          audioBase64: dbRec.audioBase64,
          mimeType: dbRec.mimeType || 'audio/wav',
          diacritizedWord: dbRec.diacritizedWord,
          steps: dbRec.steps || [],
          fullReading: dbRec.fullReading,
          ttsRetryable: true,
        };
      }

      // 3. Server generation (Al-Fath Al-Rabbani + Gemini TTS)
      const fallback = mode === 'noor_albayan' ? generateNoorAlBayanClientFallback(clean, {}) : null;
      let diacritizedWord = fallback?.diacritizedWord || clean;
      let wasAutoDiacritized = fallback?.wasAutoDiacritized || false;
      let steps: NoorAlBayanStep[] = fallback?.steps || [];
      let fullReading = fallback?.fullReading || clean;

      if (mode === 'noor_albayan') {
        const breakdown = await generateNoorAlBayanOnServer({
          text: clean,
          surahName,
        }).catch(() => null);
        if (breakdown) {
          diacritizedWord = breakdown.diacritizedWord;
          wasAutoDiacritized = breakdown.wasAutoDiacritized;
          steps = breakdown.steps;
          fullReading = breakdown.fullReading || breakdown.diacritizedWord;
        }
        if (showUi && isMountedRef.current) {
          setNoorDiacritizedWord(diacritizedWord);
          setNoorSteps(steps);
          setNoorFullReading(fullReading);
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
        }).catch(() => {});

        void saveWordAudioToLibraryDb({
          workspace,
          mode,
          wordText: clean,
          diacritizedWord,
          wasAutoDiacritized,
          fullReading,
          steps,
          audioBase64,
          mimeType,
          createdBy: currentUserId,
          preferredTabKey: 'presentations',
        });
        if (showUi && isMountedRef.current) {
          setWordStatusNote('تم توليد الصوت وحفظه سحابياً لجميع الأجهزة');
        }
      }

      return {
        cacheKey,
        audioBase64,
        mimeType,
        diacritizedWord,
        steps,
        fullReading: tts.text || fullReading,
        ttsError: tts.engine === 'unavailable' ? tts.error : undefined,
        ttsRetryAfterMs: tts.engine === 'unavailable' ? tts.retryAfterMs : undefined,
        ttsRetryable: tts.engine === 'unavailable' ? tts.isRateLimited !== false : true,
      };
    },
    [workspace, currentUserId]
  );

  const playClipWithRetry = useCallback(
    async (
      displayMode: AudioMode,
      fetchMode: 'noor_albayan' | 'normal',
      text: string,
      surahName: string | undefined,
      isCancelled: () => boolean,
      showUi = true
    ): Promise<'ended' | 'failed' | 'cancelled'> => {
      const maxAttempts = 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isCancelled()) return 'cancelled';
        if (isMountedRef.current) {
          setAudioLoadingMode(displayMode);
          if (fetchMode === 'noor_albayan') setNoorLoading(true);
        }

        const resolved = await resolveAudioClip(text, fetchMode, surahName, showUi);
        if (isCancelled()) return 'cancelled';

        if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
          if (isMountedRef.current) {
            setAudioLoadingMode(null);
            setNoorLoading(false);
          }
          const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
          const outcome = await playAudioStrict(
            displayMode,
            url,
            true,
            resolved.cacheKey,
            isCancelled
          );
          if (outcome === 'cancelled') return 'cancelled';
          if (outcome === 'ended') return 'ended';
        } else if (!resolved.ttsRetryable) {
          // Permanent permission/configuration block: surface right away instead of hanging
          if (isMountedRef.current) {
            setAudioLoadingMode(null);
            setNoorLoading(false);
            setAudioError(
              resolved.ttsError || 'تعذّر توليد الصوت لهذا المجمع أو الحساب.'
            );
          }
          return 'failed';
        }

        if (attempt >= maxAttempts) {
          if (isMountedRef.current) {
            setAudioLoadingMode(null);
            setNoorLoading(false);
            setAudioError(
              resolved.ttsError ||
                'هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحظات ثم إعادة المحاولة.'
            );
          }
          return 'failed';
        }

        const waitMs = Math.max(3500, Math.min(18000, resolved.ttsRetryAfterMs || 7000));
        const ok = await waitWithCancellation(waitMs, isCancelled, (rem) => {
          if (isMountedRef.current) {
            setAudioError(
              `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(rem)} ث)...`
            );
          }
        });
        if (!ok) return 'cancelled';
      }
      return 'failed';
    },
    [playAudioStrict, resolveAudioClip, waitWithCancellation]
  );

  /**
   * Robust segmented playback for targets:
   * - In `noor_albayan` with > 2 words: spells word-by-word strictly in order so long
   *   Ayahs/sentences never timeout Gemini TTS or exceed WAV size caps.
   * - In `normal` with > 8 words: splits into short 4–7 word phrases strictly in order.
   */
  const playTargetSegmented = useCallback(
    async (
      displayMode: AudioMode,
      fetchMode: 'noor_albayan' | 'normal',
      target: SlideAudioTarget,
      isCancelled: () => boolean,
      showUi = true
    ): Promise<'ended' | 'failed' | 'cancelled'> => {
      const words = extractCleanArabicWords(target.text);
      if (words.length === 0) return 'ended';

      if (fetchMode === 'noor_albayan') {
        if (words.length <= 2) {
          return playClipWithRetry(
            displayMode,
            'noor_albayan',
            words.join(' '),
            target.surahName,
            isCancelled,
            showUi
          );
        }

        for (let w = 0; w < words.length; w++) {
          if (isCancelled()) return 'cancelled';
          if (showUi && isMountedRef.current) {
            setWordStatusNote(
              `تهجي (${toArabicIndicDigits(w + 1)}/${toArabicIndicDigits(words.length)}): ${words[w]}`
            );
          }
          const res = await playClipWithRetry(
            displayMode,
            'noor_albayan',
            words[w],
            target.surahName,
            isCancelled,
            true
          );
          if (res !== 'ended') return res;
        }
        return 'ended';
      }

      // Normal mode: chunk long Ayahs / paragraphs into <= 7-word phrases
      const phrases =
        words.length <= 8
          ? [words.join(' ')]
          : splitArabicIntoSafePhrases(target.text, 7);

      for (let p = 0; p < phrases.length; p++) {
        if (isCancelled()) return 'cancelled';
        if (showUi && phrases.length > 1 && isMountedRef.current) {
          setWordStatusNote(
            `جاري القراءة (${toArabicIndicDigits(p + 1)}/${toArabicIndicDigits(phrases.length)})...`
          );
        }
        const res = await playClipWithRetry(
          displayMode,
          'normal',
          phrases[p],
          target.surahName,
          isCancelled,
          p === 0 && showUi
        );
        if (res !== 'ended') return res;
      }
      return 'ended';
    },
    [playClipWithRetry]
  );

  const playSingleWithRetry = useCallback(
    async (mode: 'noor_albayan' | 'normal', target: SlideAudioTarget) => {
      const epoch = claimGlobalAudioStop(clearUiStateOnly);
      clearUiStateOnly();
      const callToken = ++requestTokenRef.current;
      const isCancelled = () =>
        !isMountedRef.current ||
        requestTokenRef.current !== callToken ||
        globalPlaybackEpoch !== epoch;

      setAudioError(null);
      try {
        await playTargetSegmented(mode, mode, target, isCancelled, true);
      } finally {
        if (
          isMountedRef.current &&
          requestTokenRef.current === callToken &&
          globalPlaybackEpoch === epoch
        ) {
          setAudioLoadingMode(null);
          setNoorLoading(false);
          setActiveAudioMode(null);
        }
      }
    },
    [clearUiStateOnly, playTargetSegmented]
  );

  /**
   * Cumulative Tahajji ("يتهجى ويرجع من البداية"):
   * Spells word 0 -> spells word 1 + reads words 0..1 -> ...
   * Splits cumulative phrase into safe chunks if verse is longer than 8 words.
   */
  const runCumulativeTahajji = useCallback(
    async (target: SlideAudioTarget) => {
      const words = extractCleanArabicWords(target.text);
      if (words.length === 0) return;

      if (words.length === 1) {
        await playSingleWithRetry('noor_albayan', target);
        return;
      }

      const epoch = claimGlobalAudioStop(clearUiStateOnly);
      clearUiStateOnly();
      const callToken = ++requestTokenRef.current;
      const isCancelled = () =>
        !isMountedRef.current ||
        requestTokenRef.current !== callToken ||
        globalPlaybackEpoch !== epoch;

      setAudioError(null);
      try {
        for (let i = 0; i < words.length; i++) {
          if (isCancelled()) return;
          const currentWord = words[i];
          setCumulativeBanner(
            `تهجي الكلمة (${toArabicIndicDigits(i + 1)}/${toArabicIndicDigits(words.length)}): ${currentWord}`
          );
          const wordResult = await playClipWithRetry(
            'cumulative_tahajji',
            'noor_albayan',
            currentWord,
            target.surahName,
            isCancelled,
            true
          );
          if (wordResult !== 'ended' || isCancelled()) return;

          if (i > 0) {
            const phraseSoFar = words.slice(0, i + 1).join(' ');
            setCumulativeBanner(`الربط من البداية: ${phraseSoFar}`);
            const phraseResult = await playTargetSegmented(
              'cumulative_tahajji',
              'normal',
              { ...target, text: phraseSoFar },
              isCancelled,
              false
            );
            if (phraseResult !== 'ended' || isCancelled()) return;
          }
        }
      } finally {
        if (
          isMountedRef.current &&
          requestTokenRef.current === callToken &&
          globalPlaybackEpoch === epoch
        ) {
          setAudioLoadingMode(null);
          setNoorLoading(false);
          setActiveAudioMode(null);
          setCumulativeBanner(null);
        }
      }
    },
    [clearUiStateOnly, playClipWithRetry, playSingleWithRetry, playTargetSegmented]
  );

  const playSheikhAyah = useCallback(
    async (overrideTarget?: SlideAudioTarget) => {
      const target = overrideTarget || selectedTarget;
      if (!target?.surahNumber || !target?.ayahNumber) return;

      const epoch = claimGlobalAudioStop(clearUiStateOnly);
      clearUiStateOnly();
      const callToken = ++requestTokenRef.current;
      const isCancelled = () =>
        !isMountedRef.current ||
        requestTokenRef.current !== callToken ||
        globalPlaybackEpoch !== epoch;

      const reciter =
        QURAN_RECITERS.find((r) => r.id === selectedReciterId) || QURAN_RECITERS[0];
      const url = getReciterAyahAudioUrl(
        reciter.everyAyahFolder,
        target.surahNumber,
        target.ayahNumber
      );

      setAudioError(null);
      setAudioLoadingMode('sheikh');
      try {
        const outcome = await playAudioStrict('sheikh', url, false, undefined, isCancelled);
        if (outcome === 'error' && !isCancelled()) {
          setAudioError('تعذّر جلب تلاوة الشيخ لهذه الآية حالياً.');
        }
      } finally {
        if (
          isMountedRef.current &&
          requestTokenRef.current === callToken &&
          globalPlaybackEpoch === epoch
        ) {
          setAudioLoadingMode(null);
          setActiveAudioMode(null);
        }
      }
    },
    [clearUiStateOnly, playAudioStrict, selectedReciterId, selectedTarget]
  );

  // Keep latest handlers in a ref so `commandRequest` effect ONLY fires on a new command ID
  const commandHandlersRef = useRef({
    playSheikhAyah,
    runCumulativeTahajji,
    playSingleWithRetry,
  });
  commandHandlersRef.current = {
    playSheikhAyah,
    runCumulativeTahajji,
    playSingleWithRetry,
  };

  useEffect(() => {
    if (!commandRequest || commandRequest.id === lastHandledCommandIdRef.current) return;
    lastHandledCommandIdRef.current = commandRequest.id;

    const { playSheikhAyah: sheikhFn, runCumulativeTahajji: cumFn, playSingleWithRetry: singleFn } =
      commandHandlersRef.current;

    if (commandRequest.mode === 'sheikh') {
      void sheikhFn(commandRequest.target);
    } else if (commandRequest.mode === 'cumulative_tahajji') {
      void cumFn(commandRequest.target);
    } else if (commandRequest.mode === 'noor_albayan') {
      void singleFn('noor_albayan', commandRequest.target);
    } else {
      void singleFn('normal', commandRequest.target);
    }
  }, [commandRequest]);

  const playableBlocks = useMemo(
    () => slideBlocks.filter((b) => b.arabicText && b.arabicText.trim().length > 0),
    [slideBlocks]
  );

  const handleStartSequentialSlideRead = async () => {
    if (playableBlocks.length === 0) return;

    const epoch = claimGlobalAudioStop(clearUiStateOnly);
    clearUiStateOnly();
    const token = ++seqTokenRef.current;
    const isCancelled = () =>
      !isMountedRef.current ||
      seqTokenRef.current !== token ||
      globalPlaybackEpoch !== epoch;

    setAudioError(null);
    setSeqPlaying(true);

    try {
      for (let i = 0; i < playableBlocks.length; i++) {
        if (isCancelled()) return;
        const blk = playableBlocks[i];
        setSeqIndex(i);
        const blockTarget: SlideAudioTarget = {
          text: blk.arabicText,
          type: blk.type,
          surahNumber: blk.surahNumber,
          ayahNumber: blk.ayahNumber,
          surahName: blk.surahName,
          label: blk.label,
        };
        onSelectTarget(blockTarget);

        // If `sheikh_and_normal` and block is a Quran Ayah with coordinates, play Sheikh first,
        // falling back seamlessly to chunked normal voice if reciter file fails.
        if (
          seqMode === 'sheikh_and_normal' &&
          blk.type === 'ayah' &&
          blk.surahNumber &&
          blk.ayahNumber
        ) {
          const reciter =
            QURAN_RECITERS.find((r) => r.id === selectedReciterId) || QURAN_RECITERS[0];
          const url = getReciterAyahAudioUrl(
            reciter.everyAyahFolder,
            blk.surahNumber,
            blk.ayahNumber
          );
          setAudioLoadingMode('sheikh');
          const sheikhOutcome = await playAudioStrict('sheikh', url, false, undefined, isCancelled);
          if (isMountedRef.current && !isCancelled()) {
            setAudioLoadingMode(null);
          }
          if (sheikhOutcome === 'cancelled' || isCancelled()) return;
          if (sheikhOutcome === 'ended') continue;
          // If reciter MP3 errored, continue cleanly with chunked normal reading
        }

        const effectiveMode: 'noor_albayan' | 'normal' =
          seqMode === 'noor_albayan' ? 'noor_albayan' : 'normal';
        const outcome = await playTargetSegmented(
          effectiveMode,
          effectiveMode,
          blockTarget,
          isCancelled,
          true
        );
        if (outcome !== 'ended' || isCancelled()) return;
      }
    } finally {
      if (
        isMountedRef.current &&
        seqTokenRef.current === token &&
        globalPlaybackEpoch === epoch
      ) {
        setSeqPlaying(false);
        setAudioLoadingMode(null);
        setNoorLoading(false);
        setActiveAudioMode(null);
      }
    }
  };

  const handleTogglePause = () => {
    const audio = audioRef.current || globalActiveAudioEl;
    if (!audio || !audio.src) return;
    if (audio.paused) {
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  const hasAyahCoords = Boolean(
    selectedTarget?.surahNumber &&
      selectedTarget.surahNumber >= 1 &&
      selectedTarget?.ayahNumber &&
      selectedTarget.ayahNumber >= 1
  );

  const wordCount = useMemo(() => {
    if (!selectedTarget?.text) return 0;
    return selectedTarget.text.trim().split(/\s+/).filter(Boolean).length;
  }, [selectedTarget]);

  return (
    <div
      className={`bg-white border-2 border-[#EADBC8] rounded-3xl ${
        compact ? 'p-3' : 'p-4'
      } space-y-3`}
      dir="rtl"
    >
      {/* Top Selected Item + Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
            <Headphones className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="font-quran text-lg sm:text-xl text-[#4A220D] leading-[1.9] truncate">
              {selectedTarget
                ? selectedTarget.text
                : 'اضغط على أيقونة السماعة أو أي كلمة أو آية في الشريحة'}
            </p>
            <p className="text-[11px] font-bold text-[#7D4E35] truncate">
              {hasAyahCoords
                ? `آية قرآنية · سورة ${selectedTarget?.surahName || toArabicIndicDigits(selectedTarget!.surahNumber!)} (آية ${toArabicIndicDigits(selectedTarget!.ayahNumber!)})`
                : wordStatusNote || 'قراءة مباشرة · تهجي الفتح الرباني · تهجي تجميعي · تلاوة المشايخ'}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!selectedTarget || audioLoadingMode === 'noor_albayan'}
            onClick={() => selectedTarget && void playSingleWithRetry('noor_albayan', selectedTarget)}
            className={`min-h-[38px] px-3 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
              activeAudioMode === 'noor_albayan'
                ? 'duo-btn-orange'
                : 'bg-[#F56900]/12 border-2 border-[#F56900]/50 text-[#4A220D] hover:border-[#F56900]'
            }`}
          >
            {audioLoadingMode === 'noor_albayan' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-[#F56900]" />
            )}
            <span>تهجي مباشر</span>
          </button>

          {wordCount > 1 && (
            <button
              type="button"
              disabled={!selectedTarget || audioLoadingMode === 'cumulative_tahajji'}
              onClick={() => selectedTarget && void runCumulativeTahajji(selectedTarget)}
              className={`min-h-[38px] px-3 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                activeAudioMode === 'cumulative_tahajji'
                  ? 'duo-btn-orange'
                  : 'bg-[#FFA900]/15 border-2 border-[#FFA900]/60 text-[#4A220D] hover:border-[#F56900]'
              }`}
            >
              {audioLoadingMode === 'cumulative_tahajji' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Repeat className="w-3.5 h-3.5 text-[#D98A00]" />
              )}
              <span>تهجي ويرجع</span>
            </button>
          )}

          <button
            type="button"
            disabled={!selectedTarget || audioLoadingMode === 'normal'}
            onClick={() => selectedTarget && void playSingleWithRetry('normal', selectedTarget)}
            className={`min-h-[38px] px-3 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
              activeAudioMode === 'normal'
                ? 'duo-btn-green'
                : 'bg-[#FDF6EE] border-2 border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
            }`}
          >
            {audioLoadingMode === 'normal' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-[#46A302]" />
            )}
            <span>قراءة مباشرة</span>
          </button>

          {hasAyahCoords && (
            <div className="inline-flex items-center gap-1">
              <select
                value={selectedReciterId}
                onChange={(e) => {
                  setSelectedReciterId(e.target.value);
                  saveTeacherReciterId(e.target.value);
                }}
                aria-label="اختيار القارئ"
                className="min-h-[38px] max-w-[140px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-[11px] font-bold text-[#4A220D] cursor-pointer"
              >
                {QURAN_RECITERS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={audioLoadingMode === 'sheikh'}
                onClick={() => void playSheikhAyah()}
                className="duo-btn-green min-h-[38px] px-3 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {audioLoadingMode === 'sheikh' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <BookOpen className="w-3.5 h-3.5" />
                )}
                <span>تلاوة الشيخ</span>
              </button>
            </div>
          )}

          {playableBlocks.length > 0 && (
            <div className="inline-flex items-center gap-1 bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-0.5">
              <select
                value={seqMode}
                onChange={(e) => setSeqMode(e.target.value as SequentialMode)}
                aria-label="نمط القراءة التتابعية للشريحة"
                className="min-h-[34px] px-2 rounded-lg bg-white text-[11px] font-bold text-[#4A220D] cursor-pointer"
              >
                <option value="noor_albayan">تتابعي: تهجي</option>
                <option value="normal">تتابعي: قراءة</option>
                <option value="sheikh_and_normal">تتابعي: تلاوة وقراءة</option>
              </select>
              {!seqPlaying ? (
                <button
                  type="button"
                  onClick={() => void handleStartSequentialSlideRead()}
                  className="min-h-[34px] px-2.5 rounded-lg bg-[#58CC02] hover:bg-[#46A302] text-white font-display font-bold text-[11px] inline-flex items-center gap-1 cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>اقرأ عناصر الشريحة</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopAllAudio}
                  className="min-h-[34px] px-2.5 rounded-lg bg-[#D95338] text-white font-display font-bold text-[11px] inline-flex items-center gap-1 cursor-pointer"
                >
                  <Square className="w-3 h-3" />
                  <span>
                    إيقاف ({toArabicIndicDigits(seqIndex + 1)}/{toArabicIndicDigits(playableBlocks.length)})
                  </span>
                </button>
              )}
            </div>
          )}

          {(audioPlaying || activeAudioMode !== null || cumulativeBanner !== null || audioLoadingMode !== null) && (
            <div className="inline-flex items-center gap-1">
              {(audioPlaying || activeAudioMode !== null) && (
                <button
                  type="button"
                  onClick={handleTogglePause}
                  aria-label={audioPlaying ? 'إيقاف مؤقت' : 'استئناف'}
                  className="w-9 h-9 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-[#4A220D] flex items-center justify-center cursor-pointer"
                >
                  {audioPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
              )}
              <button
                type="button"
                onClick={stopAllAudio}
                aria-label="إيقاف الصوت"
                className="w-9 h-9 rounded-xl border-2 border-[#D95338]/40 bg-[#D95338]/10 text-[#D95338] flex items-center justify-center cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Cumulative Tahajji Progress Banner */}
      {cumulativeBanner && (
        <div className="bg-[#FFF8EB] border-2 border-[#FFA900]/50 rounded-2xl px-3.5 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Repeat className="w-4 h-4 text-[#D98A00] shrink-0" />
            <span className="font-quran text-lg text-[#4A220D] leading-[1.9] truncate">
              {cumulativeBanner}
            </span>
          </div>
          <button
            type="button"
            onClick={stopAllAudio}
            className="px-2.5 py-1 rounded-lg bg-[#D95338] text-white text-[11px] font-bold cursor-pointer shrink-0"
          >
            إيقاف
          </button>
        </div>
      )}

      {/* Tahajji Visual Steps Pill Ribbon */}
      {selectedTarget && (noorLoading || noorSteps.length > 0) && (
        <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-[#7D4E35]">
            <span>تفصيل التهجي (منهج الفتح الرباني):</span>
            {noorDiacritizedWord && (
              <span className="font-quran text-lg text-[#4A220D] leading-[1.8]">
                {noorDiacritizedWord}
              </span>
            )}
          </div>
          {noorSteps.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {noorSteps.slice(0, 14).map((st, idx) => (
                <div
                  key={`${st.part}_${idx}`}
                  className="px-2 py-1 rounded-xl bg-white border border-[#EADBC8] text-[11px] flex items-center gap-1.5"
                >
                  <span className="font-display font-extrabold text-[#F56900]">{st.reading}</span>
                  <span className="text-[#7D4E35] text-[10px]">({st.ruleLabel})</span>
                </div>
              ))}
            </div>
          )}
          {noorFullReading && (
            <p className="text-[11px] font-bold text-[#4A220D]/85 leading-relaxed">
              {noorFullReading}
            </p>
          )}
        </div>
      )}

      {audioError && (
        <div className="bg-[#FFF4ED] border border-[#F56900]/40 rounded-xl px-3 py-2 flex items-center gap-2 text-xs font-bold text-[#9A3412]">
          <AlertCircle className="w-4 h-4 shrink-0 text-[#F56900]" />
          <span>{audioError}</span>
        </div>
      )}
    </div>
  );
};
