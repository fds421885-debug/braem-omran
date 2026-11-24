import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Headphones,
  Loader2,
  Pause,
  Play,
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
  generateNoorAlBayanClientFallback,
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

interface SlideArabicAudioBarProps {
  workspace: ComplexWorkspaceData;
  currentUserId: string;
  selectedTarget: SlideAudioTarget | null;
  slideBlocks: PresentationInteractiveBlock[];
  onSelectTarget: (target: SlideAudioTarget) => void;
  compact?: boolean;
}

type AudioMode = 'noor_albayan' | 'normal' | 'sheikh';

export const SlideArabicAudioBar: React.FC<SlideArabicAudioBarProps> = ({
  workspace,
  currentUserId,
  selectedTarget,
  slideBlocks,
  onSelectTarget,
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

  // Strict sequential reading over interactive blocks/words on the slide
  const [seqMode, setSeqMode] = useState<'noor_albayan' | 'normal'>('noor_albayan');
  const [seqPlaying, setSeqPlaying] = useState(false);
  const [seqIndex, setSeqIndex] = useState<number>(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeObjectUrlRef = useRef<string | null>(null);
  const runTokenRef = useRef<number>(0);
  const requestTokenRef = useRef<number>(0);
  const seqTokenRef = useRef<number>(0);

  const detachAndStopAudio = useCallback(() => {
    runTokenRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.onloadedmetadata = null;
      audio.ontimeupdate = null;
      audio.onplay = null;
      audio.onpause = null;
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current);
      activeObjectUrlRef.current = null;
    }
    setAudioPlaying(false);
    setActiveAudioMode(null);
  }, []);

  const stopAllAudio = useCallback(() => {
    seqTokenRef.current += 1;
    requestTokenRef.current += 1;
    setSeqPlaying(false);
    setAudioLoadingMode(null);
    setNoorLoading(false);
    detachAndStopAudio();
  }, [detachAndStopAudio]);

  useEffect(() => {
    return () => {
      stopAllAudio();
    };
  }, [stopAllAudio]);

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
        if (isCancelled()) {
          if (isObjectUrl) URL.revokeObjectURL(url);
          resolve('cancelled');
          return;
        }
        detachAndStopAudio();
        const runToken = ++runTokenRef.current;
        if (!audioRef.current) {
          audioRef.current = new Audio();
        }
        const audio = audioRef.current;
        if (isObjectUrl) {
          activeObjectUrlRef.current = url;
        }

        let settled = false;
        let startedPlaying = false;
        let guardId: number | null = null;
        let watchdogId: number | null = null;

        const finish = (outcome: 'ended' | 'error' | 'cancelled') => {
          if (settled) return;
          settled = true;
          if (guardId !== null) window.clearInterval(guardId);
          if (watchdogId !== null) window.clearTimeout(watchdogId);
          resolve(outcome);
        };

        audio.preload = 'auto';
        audio.src = url;
        audio.currentTime = 0;

        audio.onplay = () => {
          if (runTokenRef.current !== runToken) return;
          startedPlaying = true;
          setAudioPlaying(true);
        };
        audio.ontimeupdate = () => {
          if (runTokenRef.current !== runToken) return;
          startedPlaying = true;
        };
        audio.onpause = () => {
          if (runTokenRef.current !== runToken) return;
          setAudioPlaying(false);
        };
        audio.onended = () => {
          if (runTokenRef.current !== runToken) return;
          setAudioPlaying(false);
          finish('ended');
        };
        audio.onerror = () => {
          if (runTokenRef.current !== runToken) return;
          setAudioPlaying(false);
          if (badCacheKey) void deleteCachedAudioEntry(badCacheKey);
          finish('error');
        };

        watchdogId = window.setTimeout(() => {
          if (runTokenRef.current === runToken && !startedPlaying && audio.paused) {
            if (badCacheKey) void deleteCachedAudioEntry(badCacheKey);
            finish('error');
          }
        }, 8500);

        // Enforce completion only after audio genuinely reaches ended state
        let lastTime = -1;
        let stalledSince = 0;
        guardId = window.setInterval(() => {
          if (settled) return;
          if (isCancelled() || runTokenRef.current !== runToken) {
            finish('cancelled');
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
          if (stalledSince === 0) {
            stalledSince = Date.now();
          } else if (Date.now() - stalledSince > 18000) {
            finish('error');
          }
        }, 400);

        setAudioError(null);
        setActiveAudioMode(mode);
        audio.play().catch(() => {
          finish('error');
        });
      });
    },
    [detachAndStopAudio]
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
    }> => {
      const clean = text.trim().replace(/\s+/g, ' ');
      const cacheKey = `${mode === 'noor_albayan' ? 'fath_v4' : 'normal_v2'}_${clean}`;

      // 1. Browser IndexedDB cache
      const local = await getCachedAudioEntry(cacheKey).catch(() => null);
      if (local && local.base64Wav && local.base64Wav.length > 120) {
        if (showUi && mode === 'noor_albayan') {
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
        };
      }

      // 2. Complex Library DB cache
      const dbRec = await lookupWordAudioAcrossLibrary(workspace, mode, clean).catch(() => null);
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
        if (showUi && mode === 'noor_albayan') {
          setNoorDiacritizedWord(dbRec.diacritizedWord || clean);
          setNoorSteps(dbRec.steps || []);
          setNoorFullReading(dbRec.fullReading || clean);
          setWordStatusNote('تم جلب الصوت من قاعدة المكتبة');
        }
        return {
          cacheKey,
          audioBase64: dbRec.audioBase64,
          mimeType: dbRec.mimeType || 'audio/wav',
          diacritizedWord: dbRec.diacritizedWord,
          steps: dbRec.steps || [],
          fullReading: dbRec.fullReading,
        };
      }

      // 3. Server generation (Al-Fath Al-Rabbani + Gemini TTS, no browser fallback)
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
        if (showUi) {
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
        });
        if (showUi) {
          setWordStatusNote('تم توليد الصوت وحفظه في قاعدة المكتبة');
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
      };
    },
    [workspace, currentUserId]
  );

  const playSingleWithRetry = useCallback(
    async (mode: 'noor_albayan' | 'normal', target: SlideAudioTarget) => {
      stopAllAudio();
      const callToken = ++requestTokenRef.current;
      const isCancelled = () => requestTokenRef.current !== callToken;

      setAudioError(null);
      setAudioLoadingMode(mode);
      if (mode === 'noor_albayan') setNoorLoading(true);

      try {
        for (let attempt = 1; attempt <= 6; attempt++) {
          if (isCancelled()) return;
          const resolved = await resolveAudioClip(
            target.text,
            mode,
            target.surahName,
            true
          );
          if (isCancelled()) return;

          if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
            setAudioLoadingMode(null);
            setNoorLoading(false);
            const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
            const outcome = await playAudioStrict(mode, url, true, resolved.cacheKey, isCancelled);
            if (outcome === 'error' && !isCancelled()) {
              setAudioError('تعذّر تشغيل الصوت حالياً؛ يرجى الانتظار ثم إعادة المحاولة.');
            }
            return;
          }

          if (attempt >= 6) {
            setAudioError(
              resolved.ttsError ||
                'هناك ضغط مؤقت على محرك الصوت؛ يرجى الانتظار لحظات ثم إعادة المحاولة.'
            );
            return;
          }

          const waitMs = Math.max(4000, Math.min(20000, resolved.ttsRetryAfterMs || 8000));
          const ok = await waitWithCancellation(waitMs, isCancelled, (rem) => {
            setAudioError(
              `هناك ضغط مؤقت على محرك الصوت حالياً؛ يرجى الانتظار لحين استعادة القراءة تلقائياً (المحاولة ${toArabicIndicDigits(attempt)} — إعادة خلال ${toArabicIndicDigits(rem)} ث)...`
            );
          });
          if (!ok) return;
        }
      } finally {
        if (requestTokenRef.current === callToken) {
          setAudioLoadingMode(null);
          setNoorLoading(false);
        }
      }
    },
    [playAudioStrict, resolveAudioClip, stopAllAudio, waitWithCancellation]
  );

  const playSheikhAyah = useCallback(async () => {
    if (!selectedTarget?.surahNumber || !selectedTarget?.ayahNumber) return;
    stopAllAudio();
    const callToken = ++requestTokenRef.current;
    const isCancelled = () => requestTokenRef.current !== callToken;
    const reciter =
      QURAN_RECITERS.find((r) => r.id === selectedReciterId) || QURAN_RECITERS[0];
    const url = getReciterAyahAudioUrl(
      reciter.everyAyahFolder,
      selectedTarget.surahNumber,
      selectedTarget.ayahNumber
    );
    setAudioLoadingMode('sheikh');
    try {
      const outcome = await playAudioStrict('sheikh', url, false, undefined, isCancelled);
      if (outcome === 'error' && !isCancelled()) {
        setAudioError('تعذّر جلب تلاوة الشيخ لهذه الآية حالياً.');
      }
    } finally {
      if (requestTokenRef.current === callToken) {
        setAudioLoadingMode(null);
      }
    }
  }, [playAudioStrict, selectedReciterId, selectedTarget, stopAllAudio]);

  const playableBlocks = useMemo(
    () => slideBlocks.filter((b) => b.arabicText && b.arabicText.trim().length > 0),
    [slideBlocks]
  );

  const handleStartSequentialSlideRead = async () => {
    if (playableBlocks.length === 0) return;
    stopAllAudio();
    const token = ++seqTokenRef.current;
    const isCancelled = () => seqTokenRef.current !== token;
    setSeqPlaying(true);

    try {
      for (let i = 0; i < playableBlocks.length; i++) {
        if (isCancelled()) return;
        const blk = playableBlocks[i];
        setSeqIndex(i);
        onSelectTarget({
          text: blk.arabicText,
          type: blk.type,
          surahNumber: blk.surahNumber,
          ayahNumber: blk.ayahNumber,
          surahName: blk.surahName,
          label: blk.label,
        });

        let finished = false;
        for (let attempt = 1; attempt <= 6; attempt++) {
          if (isCancelled()) return;
          setAudioLoadingMode(seqMode);
          const resolved = await resolveAudioClip(blk.arabicText, seqMode, blk.surahName, true);
          if (isCancelled()) return;

          if (resolved.audioBase64 && resolved.audioBase64.length > 120) {
            setAudioLoadingMode(null);
            setAudioError(null);
            const url = base64AudioToObjectUrl(resolved.audioBase64, resolved.mimeType);
            const outcome = await playAudioStrict(seqMode, url, true, resolved.cacheKey, isCancelled);
            if (outcome === 'cancelled') return;
            finished = true;
            break;
          }

          if (attempt >= 6) {
            setAudioError('هناك ضغط مؤقت على محرك الصوت؛ توقفت القراءة التتابعية مؤقتاً.');
            return;
          }
          const waitMs = Math.max(4000, Math.min(20000, resolved.ttsRetryAfterMs || 8000));
          const ok = await waitWithCancellation(waitMs, isCancelled, (rem) => {
            setAudioError(
              `انتظار استعادة الصوت للعنصر ${toArabicIndicDigits(i + 1)} (${toArabicIndicDigits(rem)} ث)...`
            );
          });
          if (!ok) return;
        }
        if (!finished || isCancelled()) return;
      }
    } finally {
      if (seqTokenRef.current === token) {
        setSeqPlaying(false);
        setAudioLoadingMode(null);
      }
    }
  };

  const handleTogglePause = () => {
    const audio = audioRef.current;
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
            <p className="font-display font-extrabold text-xs sm:text-sm text-[#4A220D] truncate">
              {selectedTarget
                ? selectedTarget.text
                : 'اضغط على أي كلمة أو آية في الشريحة لسماع تهجيها أو تلاوتها'}
            </p>
            <p className="text-[11px] font-bold text-[#7D4E35] truncate">
              {hasAyahCoords
                ? `آية قرآنية · سورة ${selectedTarget?.surahName || toArabicIndicDigits(selectedTarget!.surahNumber!)} (آية ${toArabicIndicDigits(selectedTarget!.ayahNumber!)})`
                : wordStatusNote || 'يدعم تهجي الفتح الرباني والقراءة المضبوطة وتلاوة المشايخ'}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!selectedTarget || audioLoadingMode !== null}
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
            <span>تهجي الفتح الرباني</span>
          </button>

          <button
            type="button"
            disabled={!selectedTarget || audioLoadingMode !== null}
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
            <span>قراءة عادية</span>
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
                disabled={audioLoadingMode !== null}
                onClick={() => void playSheikhAyah()}
                className="duo-btn-green min-h-[38px] px-3 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>تلاوة الشيخ</span>
              </button>
            </div>
          )}

          {playableBlocks.length > 0 && (
            <div className="inline-flex items-center gap-1 bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-0.5">
              <select
                value={seqMode}
                onChange={(e) => setSeqMode(e.target.value as 'noor_albayan' | 'normal')}
                aria-label="نمط القراءة التتابعية للشريحة"
                className="min-h-[34px] px-2 rounded-lg bg-white text-[11px] font-bold text-[#4A220D] cursor-pointer"
              >
                <option value="noor_albayan">تتابعي: تهجي</option>
                <option value="normal">تتابعي: قراءة</option>
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

          {(audioPlaying || activeAudioMode !== null) && (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={handleTogglePause}
                aria-label={audioPlaying ? 'إيقاف مؤقت' : 'استئناف'}
                className="w-9 h-9 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-[#4A220D] flex items-center justify-center cursor-pointer"
              >
                {audioPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
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

      {/* Tahajji Visual Steps Pill Ribbon */}
      {selectedTarget && (noorLoading || noorSteps.length > 0) && (
        <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-[#7D4E35]">
            <span>تفصيل التهجي (منهج الفتح الرباني):</span>
            {noorDiacritizedWord && (
              <span className="font-display font-extrabold text-sm text-[#4A220D]">
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
