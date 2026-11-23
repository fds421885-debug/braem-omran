import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import { getReciterAyahAudioUrl } from '../services/multiDb';
import {
  getMushafPage,
  getNextAyahCoords,
  getPageForAyah,
  getSavedTeacherReciterId,
  getSurahsList,
  isAyahInRange,
  playPageTurnSound,
  saveTeacherReciterId,
  toArabicIndicDigits,
  type MushafPageData,
  type MushafSurahMeta,
  type MushafWordToken,
} from '../services/mushafService';
import { QURAN_RECITERS, type QuranRangeRef } from '../types/platform';
import { ModernLoader } from './ModernLoader';

export interface MushafHighlightRange {
  label: string;
  kind: 'new_hifz' | 'review';
  range: QuranRangeRef;
}

interface KingFahdMushafReaderProps {
  studentName: string;
  headerSubtitle?: string;
  readOnlyMistakes?: boolean;
  initialPage?: number;
  highlightRanges: MushafHighlightRange[];
  focusTarget?: { surah: number; ayah: number } | null;
  mistakes: Record<string, number>;
  onMistakesChange: (nextMistakes: Record<string, number>) => void;
  onCloseWithPage?: (pageNumber: number) => void;
  onClose: () => void;
}

interface AyahLineGroup {
  surah: number;
  ayah: number;
  tokens: MushafWordToken[];
}

function groupLineTokensByAyah(tokens: MushafWordToken[]): AyahLineGroup[] {
  const groups: AyahLineGroup[] = [];
  for (const tok of tokens) {
    const last = groups[groups.length - 1];
    if (last && last.surah === tok.s && last.ayah === tok.a) {
      last.tokens.push(tok);
    } else {
      groups.push({
        surah: tok.s,
        ayah: tok.a,
        tokens: [tok],
      });
    }
  }
  return groups;
}

export const KingFahdMushafReader: React.FC<KingFahdMushafReaderProps> = ({
  studentName,
  headerSubtitle,
  readOnlyMistakes = false,
  initialPage = 1,
  highlightRanges,
  focusTarget,
  mistakes,
  onMistakesChange,
  onCloseWithPage,
  onClose,
}) => {
  const [pageNumber, setPageNumber] = useState<number>(() =>
    Math.max(1, Math.min(604, Math.floor(initialPage)))
  );
  const [pageData, setPageData] = useState<MushafPageData | null>(null);
  const [surahs, setSurahs] = useState<MushafSurahMeta[]>([]);
  const [loadingPage, setLoadingPage] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState<string>(String(initialPage));

  const [flipDirection, setFlipDirection] = useState<'next' | 'prev' | null>(null);
  const [flipAnimCounter, setFlipAnimCounter] = useState<number>(0);

  // Reciter & continuous playback state
  const [reciterId, setReciterId] = useState<string>(() => getSavedTeacherReciterId());
  const [activeAyah, setActiveAyah] = useState<{ surah: number; ayah: number } | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<'idle' | 'playing' | 'paused' | 'loading'>(
    'idle'
  );
  const [audioError, setAudioError] = useState<string | null>(null);

  // 2-second hold progress feedback
  const [holdingAyahKey, setHoldingAyahKey] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrolledFocusKeyRef = useRef<string | null>(null);

  // Gesture refs
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdFeedbackTimerRef = useRef<number | null>(null);
  const holdStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef<boolean>(false);
  const lastTapRef = useRef<{ key: string; time: number } | null>(null);

  // Latest state refs for audio onEnded callback
  const activeAyahRef = useRef(activeAyah);
  activeAyahRef.current = activeAyah;
  const reciterIdRef = useRef(reciterId);
  reciterIdRef.current = reciterId;
  const surahsRef = useRef(surahs);
  surahsRef.current = surahs;
  const pageNumberRef = useRef(pageNumber);
  pageNumberRef.current = pageNumber;

  useEffect(() => {
    void getSurahsList()
      .then((list) => setSurahs(list))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingPage(true);
    setLoadError(null);
    setPageInput(String(pageNumber));

    getMushafPage(pageNumber)
      .then((data) => {
        if (!cancelled) {
          setPageData(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'تعذّر تحميل صفحة المصحف.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPage(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pageNumber]);

  const navigateToPage = useCallback(
    (targetPage: number, directionHint?: 'next' | 'prev') => {
      const clamped = Math.max(1, Math.min(604, Math.floor(targetPage)));
      if (clamped === pageNumberRef.current) return;
      const dir =
        directionHint || (clamped > pageNumberRef.current ? 'next' : 'prev');
      setFlipDirection(dir);
      setFlipAnimCounter((c) => c + 1);
      playPageTurnSound();
      setPageNumber(clamped);
    },
    []
  );

  // Auto-scroll to the focus target ayah when page loads so teacher never has to search for it
  useEffect(() => {
    if (loadingPage || !pageData || !focusTarget) return;
    const key = `${focusTarget.surah}:${focusTarget.ayah}`;
    const focusPageMatchKey = `${pageData.p}:${key}`;
    if (scrolledFocusKeyRef.current === focusPageMatchKey) return;

    const timer = window.setTimeout(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const el = container.querySelector(`[data-ayah-key="${key}"]`) as HTMLElement | null;
      if (el) {
        scrolledFocusKeyRef.current = focusPageMatchKey;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 90);

    return () => window.clearTimeout(timer);
  }, [loadingPage, pageData, focusTarget]);

  const stopAudioCompletely = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        audioRef.current.load();
      } catch {
        // Non-fatal
      }
    }
    setActiveAyah(null);
    setPlaybackStatus('idle');
    setAudioError(null);
  }, []);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
      }
      if (holdFeedbackTimerRef.current !== null) {
        window.clearTimeout(holdFeedbackTimerRef.current);
      }
      if (audioRef.current) {
        try {
          audioRef.current.pause();
        } catch {
          // Non-fatal
        }
      }
    };
  }, []);

  const playAyahFromStart = useCallback(
    async (surahNum: number, ayahNum: number, chosenReciterId?: string) => {
      const targetReciterId = chosenReciterId || reciterIdRef.current;
      const reciter =
        QURAN_RECITERS.find((r) => r.id === targetReciterId) || QURAN_RECITERS[0];
      const url = getReciterAyahAudioUrl(reciter.everyAyahFolder, surahNum, ayahNum);

      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      const audio = audioRef.current;
      setAudioError(null);
      setActiveAyah({ surah: surahNum, ayah: ayahNum });
      setPlaybackStatus('loading');

      audio.onended = () => {
        const current = activeAyahRef.current;
        if (!current) return;
        const next = getNextAyahCoords(current.surah, current.ayah, surahsRef.current);
        if (!next) {
          setActiveAyah(null);
          setPlaybackStatus('idle');
          return;
        }
        void getPageForAyah(next.surah, next.ayah).then((nextPage) => {
          if (nextPage !== pageNumberRef.current) {
            navigateToPage(nextPage, 'next');
          }
          void playAyahFromStart(next.surah, next.ayah);
        });
      };

      audio.onerror = () => {
        setPlaybackStatus('paused');
        setAudioError('تعذّر تشغيل تلاوة هذه الآية، تأكد من الاتصال بالإنترنت.');
      };

      try {
        audio.pause();
        audio.src = url;
        audio.currentTime = 0;
        await audio.play();
        setPlaybackStatus('playing');
      } catch {
        setPlaybackStatus('paused');
        setAudioError('اضغط «كمّل» لبدء الصوت.');
      }
    },
    [navigateToPage]
  );

  const handlePauseAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setPlaybackStatus('paused');
  };

  const handleResumeAudio = async () => {
    if (!audioRef.current || !activeAyah) return;
    setAudioError(null);
    try {
      await audioRef.current.play();
      setPlaybackStatus('playing');
    } catch {
      setAudioError('تعذّر استئناف التلاوة تلقائياً.');
    }
  };

  const handleReciterChange = (newReciterId: string) => {
    setReciterId(newReciterId);
    saveTeacherReciterId(newReciterId);
    if (activeAyah) {
      if (playbackStatus === 'playing') {
        void playAyahFromStart(activeAyah.surah, activeAyah.ayah, newReciterId);
      } else if (playbackStatus === 'paused' && audioRef.current) {
        const reciter = QURAN_RECITERS.find((r) => r.id === newReciterId) || QURAN_RECITERS[0];
        const savedTime = audioRef.current.currentTime;
        audioRef.current.src = getReciterAyahAudioUrl(
          reciter.everyAyahFolder,
          activeAyah.surah,
          activeAyah.ayah
        );
        const seekOnMeta = () => {
          if (audioRef.current && savedTime > 0 && Number.isFinite(audioRef.current.duration)) {
            audioRef.current.currentTime = Math.min(savedTime, audioRef.current.duration);
          }
          audioRef.current?.removeEventListener('loadedmetadata', seekOnMeta);
        };
        audioRef.current.addEventListener('loadedmetadata', seekOnMeta);
      }
    }
  };

  // Keyboard arrows support (In RTL book: ArrowLeft -> Next Page, ArrowRight -> Prev Page)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        if (pageNumberRef.current < 604) {
          navigateToPage(pageNumberRef.current + 1, 'next');
        }
      } else if (e.key === 'ArrowRight') {
        if (pageNumberRef.current > 1) {
          navigateToPage(pageNumberRef.current - 1, 'prev');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigateToPage, onClose]);

  const cancelHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdFeedbackTimerRef.current !== null) {
      window.clearTimeout(holdFeedbackTimerRef.current);
      holdFeedbackTimerRef.current = null;
    }
    holdStartPosRef.current = null;
    setHoldingAyahKey(null);
  };

  const handleAyahPointerDown = (
    e: React.PointerEvent<HTMLSpanElement>,
    surahNum: number,
    ayahNum: number
  ) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    cancelHoldTimer();
    longPressTriggeredRef.current = false;
    const key = `${surahNum}:${ayahNum}`;
    holdStartPosRef.current = { x: e.clientX, y: e.clientY };

    // Delay visual hold banner/ring past the double-tap window (420ms) so tapping twice never flickers
    holdFeedbackTimerRef.current = window.setTimeout(() => {
      holdFeedbackTimerRef.current = null;
      setHoldingAyahKey(key);
    }, 420);

    holdTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      if (holdFeedbackTimerRef.current !== null) {
        window.clearTimeout(holdFeedbackTimerRef.current);
        holdFeedbackTimerRef.current = null;
      }
      setHoldingAyahKey(null);
      holdTimerRef.current = null;
      void playAyahFromStart(surahNum, ayahNum);
    }, 2000);
  };

  const handleAyahPointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!holdStartPosRef.current) return;
    const dx = Math.abs(e.clientX - holdStartPosRef.current.x);
    const dy = Math.abs(e.clientY - holdStartPosRef.current.y);
    if (dx > 12 || dy > 12) {
      cancelHoldTimer();
    }
  };

  const handleAyahPointerUp = (surahNum: number, ayahNum: number) => {
    cancelHoldTimer();
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    if (readOnlyMistakes) return;
    const key = `${surahNum}:${ayahNum}`;
    const now = Date.now();
    const prev = lastTapRef.current;
    if (prev && prev.key === key && now - prev.time <= 360) {
      lastTapRef.current = null;
      const nextMistakes = {
        ...mistakes,
        [key]: (mistakes[key] || 0) + 1,
      };
      onMistakesChange(nextMistakes);
    } else {
      lastTapRef.current = { key, time: now };
    }
  };

  const handleClearAyahMistake = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    e.preventDefault();
    cancelHoldTimer();
    lastTapRef.current = null;
    const nextMistakes = { ...mistakes };
    delete nextMistakes[key];
    onMistakesChange(nextMistakes);
  };

  // Touch swipe RTL page turning:
  // Swipe RIGHT (deltaX > 48) -> turn forward to page + 1
  // Swipe LEFT (deltaX < -48) -> turn backward to page - 1
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return;
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const deltaX = endX - touchStartRef.current.x;
    const deltaY = endY - touchStartRef.current.y;
    touchStartRef.current = null;

    if (Math.abs(deltaX) > 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25) {
      cancelHoldTimer();
      if (deltaX > 0 && pageNumber < 604) {
        navigateToPage(pageNumber + 1, 'next');
      } else if (deltaX < 0 && pageNumber > 1) {
        navigateToPage(pageNumber - 1, 'prev');
      }
    }
  };

  // Current Surah(s) appearing on page
  const pageSurahsSummary = useMemo(() => {
    if (!pageData || surahs.length === 0) return 'المصحف الشريف';
    const seenSurahs = new Set<number>();
    for (const tokens of Object.values(pageData.lines)) {
      for (const tok of tokens) {
        seenSurahs.add(tok.s);
      }
    }
    const names = Array.from(seenSurahs)
      .sort((a, b) => a - b)
      .map((sNum) => surahs.find((s) => s.n === sNum)?.name)
      .filter(Boolean);
    return names.length > 0 ? names.map((n) => `سورة ${n}`).join(' · ') : 'المصحف الشريف';
  }, [pageData, surahs]);

  const currentPrimarySurahNum = useMemo(() => {
    if (!pageData) return 1;
    const firstLine = Object.values(pageData.lines).find((l) => l.length > 0);
    return firstLine?.[0]?.s || 1;
  }, [pageData]);

  const pageLinesNumbers = useMemo(() => {
    if (!pageData) return [];
    if (pageData.p <= 2) return [1, 2, 3, 4, 5, 6, 7, 8];
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  }, [pageData]);

  const totalPageMistakes = useMemo(() => {
    if (!pageData) return 0;
    const seenAyahs = new Set<string>();
    for (const tokens of Object.values(pageData.lines)) {
      for (const tok of tokens) {
        seenAyahs.add(`${tok.s}:${tok.a}`);
      }
    }
    let count = 0;
    for (const key of seenAyahs) {
      count += mistakes[key] || 0;
    }
    return count;
  }, [pageData, mistakes]);

  const activeSurahName = useMemo(() => {
    if (!activeAyah) return '';
    return surahs.find((s) => s.n === activeAyah.surah)?.name || String(activeAyah.surah);
  }, [activeAyah, surahs]);

  const handlePageJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(pageInput);
    if (Number.isFinite(parsed)) {
      navigateToPage(parsed);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      dir="rtl"
      className="fixed inset-0 z-[80] bg-[#FDF6EE] text-[#4A220D] flex flex-col overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label={`مصحف الطالب ${studentName}`}
    >
      {/* Top Bar */}
      <header className="bg-white border-b-2 border-[#EADBC8] px-3 sm:px-5 py-2.5 shrink-0">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                stopAudioCompletely();
                onCloseWithPage?.(pageNumberRef.current);
                onClose();
              }}
              aria-label="إغلاق المصحف"
              className="min-h-[42px] min-w-[42px] rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-[#4A220D] inline-flex items-center justify-center cursor-pointer shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <p className="text-[11px] font-extrabold text-[#F56900] truncate">
                {headerSubtitle || `مصحف الملك فهد · مصحف الطالب: ${studentName}`}
              </p>
              <h2 className="font-display text-sm sm:text-base font-extrabold text-[#4A220D] truncate">
                {pageSurahsSummary}
              </h2>
            </div>
          </div>

          {/* Controls: Surah Picker, Page Jump, Sheikh Reciter Selector */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-xl px-2.5 py-1 min-h-[42px]">
              <Volume2 className="w-4 h-4 text-[#F56900] shrink-0" />
              <select
                value={reciterId}
                onChange={(e) => handleReciterChange(e.target.value)}
                aria-label="اختيار القارئ"
                className="bg-transparent text-xs sm:text-sm font-bold text-[#4A220D] focus:outline-none cursor-pointer max-w-[165px] sm:max-w-none"
              >
                {QURAN_RECITERS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.style})
                  </option>
                ))}
              </select>
            </div>

            {surahs.length > 0 && (
              <select
                value={currentPrimarySurahNum}
                onChange={(e) => {
                  const s = surahs.find((item) => item.n === Number(e.target.value));
                  if (s) navigateToPage(s.startPage);
                }}
                aria-label="الانتقال إلى سورة"
                className="min-h-[42px] px-2.5 py-1 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer"
              >
                {surahs.map((s) => (
                  <option key={s.n} value={s.n}>
                    {toArabicIndicDigits(s.n)}. سورة {s.name}
                  </option>
                ))}
              </select>
            )}

            <form onSubmit={handlePageJumpSubmit} className="flex items-center gap-1">
              <label htmlFor="mushaf-page-input" className="text-xs font-bold text-[#7D4E35]">
                صفحة
              </label>
              <input
                id="mushaf-page-input"
                type="number"
                min={1}
                max={604}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                className="w-16 min-h-[42px] px-2 text-center rounded-xl border-2 border-[#EADBC8] bg-white font-display font-extrabold text-sm tabular-nums"
              />
            </form>
          </div>
        </div>

        {/* Interactive Legend + Hold Progress + Audio Player Controls */}
        <div className="max-w-5xl mx-auto mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 sm:gap-2 text-[#7D4E35] font-semibold overflow-x-auto no-scrollbar max-w-full pb-0.5">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[#FDF6EE] border border-[#EADBC8] shrink-0 whitespace-nowrap text-[11px] sm:text-xs">
              <Mic className="w-3.5 h-3.5 text-[#F56900]" />
              <span>ضغط مطوّل ٢ث للتلاوة المتواصلة</span>
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[#D95338]/10 text-[#9A2510] shrink-0 whitespace-nowrap text-[11px] sm:text-xs">
              <span>ضغطتان للخطأ ({toArabicIndicDigits(totalPageMistakes)})</span>
            </span>
            {highlightRanges.map((hr, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg font-bold shrink-0 whitespace-nowrap text-[11px] sm:text-xs ${
                  hr.kind === 'new_hifz'
                    ? 'bg-[#58CC02]/15 text-[#357A02]'
                    : 'bg-[#FFA900]/20 text-[#995C00]'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>{hr.label}</span>
              </span>
            ))}
          </div>

          {/* Continuous Playback Floating Bar */}
          {activeAyah && (
            <div className="flex flex-wrap items-center gap-2 bg-[#4A220D] text-white px-3 py-1.5 rounded-xl">
              <span className="font-display font-bold text-xs">
                {playbackStatus === 'loading'
                  ? `جاري تشغيل سورة ${activeSurahName} (${toArabicIndicDigits(activeAyah.ayah)})...`
                  : playbackStatus === 'playing'
                  ? `يتلو: سورة ${activeSurahName} · آية ${toArabicIndicDigits(activeAyah.ayah)}`
                  : `متوقف عند: سورة ${activeSurahName} · آية ${toArabicIndicDigits(activeAyah.ayah)}`}
              </span>
              {playbackStatus === 'playing' ? (
                <button
                  type="button"
                  onClick={handlePauseAudio}
                  className="min-h-[32px] px-3 rounded-lg bg-[#FFA900] text-[#4A220D] font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <Pause className="w-3.5 h-3.5" />
                  <span>توقف</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleResumeAudio()}
                  className="min-h-[32px] px-3 rounded-lg bg-[#58CC02] text-white font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>كمّل</span>
                </button>
              )}
              <button
                type="button"
                onClick={stopAudioCompletely}
                aria-label="إيقاف نهائي"
                className="min-h-[32px] px-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-bold inline-flex items-center gap-1 cursor-pointer"
              >
                <Square className="w-3 h-3" />
                <span>إيقاف</span>
              </button>
            </div>
          )}
        </div>

        {audioError && (
          <div className="max-w-5xl mx-auto mt-1.5 bg-[#D95338]/12 border border-[#D95338]/40 rounded-xl px-3 py-1 text-xs font-bold text-[#D95338]">
            {audioError}
          </div>
        )}
      </header>

      {/* Main Mushaf Page Body (Touch Swipe Enabled + Floating Non-Shifting Hold Indicator) */}
      <div
        ref={scrollContainerRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="relative flex-1 overflow-y-auto px-2 sm:px-6 py-4 flex flex-col items-center justify-start mushaf-no-callout"
      >
        {holdingAyahKey && (
          <div
            aria-live="polite"
            className="pointer-events-none fixed top-24 left-1/2 -translate-x-1/2 z-[85] bg-[#4A220D] text-white border-2 border-[#F56900] rounded-2xl px-4 py-2 shadow-lg flex items-center gap-2 text-xs font-display font-bold whitespace-nowrap"
          >
            <Mic className="w-3.5 h-3.5 text-[#FFA900] animate-pulse shrink-0" />
            <span>استمر بالضغط لمدة ثانيتين لبدء التلاوة المتواصلة...</span>
          </div>
        )}
        {loadingPage ? (
          <div className="my-auto py-16">
            <ModernLoader label={`جاري فتح صفحة ${toArabicIndicDigits(pageNumber)}...`} />
          </div>
        ) : loadError || !pageData ? (
          <div className="my-auto max-w-md w-full bg-white border-2 border-[#D95338] rounded-3xl p-6 text-center space-y-3">
            <p className="font-display font-extrabold text-[#D95338]">
              {loadError || 'تعذّر عرض صفحة المصحف.'}
            </p>
            <button
              type="button"
              onClick={() => navigateToPage(pageNumber)}
              className="duo-btn-orange min-h-[44px] px-5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>إعادة المحاولة</span>
            </button>
          </div>
        ) : (
          <div
            key={`${pageData.p}_${flipAnimCounter}`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className={`w-full max-w-[660px] bg-[#FFFDF7] border-2 border-[#C95200]/45 rounded-[28px] p-2 sm:p-4 shadow-sm mushaf-no-callout ${
              flipDirection === 'next'
                ? 'animate-mushaf-next'
                : flipDirection === 'prev'
                ? 'animate-mushaf-prev'
                : ''
            }`}
          >
            {/* Inner King Fahd Complex Ornamental Frame */}
            <div className="border-2 border-[#EADBC8] rounded-[22px] bg-[#FFFDF7] px-2.5 sm:px-7 py-3.5 sm:py-6 flex flex-col justify-between min-h-[430px] sm:min-h-[540px]">
              {/* Top Running Header (Surah on right, Juz/Hizb on left) */}
              <div className="flex items-center justify-between gap-2 pb-2.5 mb-3 border-b border-[#EADBC8] text-xs font-display font-bold text-[#7D4E35]">
                <span className="truncate">{pageSurahsSummary}</span>
                <span className="shrink-0 tabular-nums">
                  الجزء {toArabicIndicDigits(pageData.j)} · الحزب {toArabicIndicDigits(pageData.h)}
                </span>
              </div>

              {/* Exact King Fahd 15 Lines (or 8 Lines on Pages 1 & 2) */}
              <div
                className={`flex-1 flex flex-col ${
                  pageData.p <= 2 ? 'justify-center gap-2.5 py-4' : 'justify-between gap-1.5'
                }`}
              >
                {pageLinesNumbers.map((lineNum) => {
                  const bannerHeader = pageData.headers.find(
                    (h) => h.bannerLine === lineNum
                  );
                  const bismillahHeader = pageData.headers.find(
                    (h) => h.bismillahLine === lineNum
                  );
                  const lineTokens = pageData.lines[String(lineNum)] || [];

                  if (bannerHeader) {
                    const headerSurah = surahs.find((s) => s.n === bannerHeader.s);
                    return (
                      <div
                        key={`banner_${lineNum}_${bannerHeader.s}`}
                        className="my-1 py-2 px-4 rounded-xl bg-gradient-to-l from-[#F56900]/12 via-[#FFA900]/18 to-[#F56900]/12 border-2 border-[#C95200]/40 text-center flex items-center justify-between gap-2"
                      >
                        <span className="text-[11px] font-bold text-[#7D4E35]">
                          {headerSurah?.rev || ''}
                        </span>
                        <h3 className="font-quran text-xl sm:text-2xl font-bold text-[#4A220D]">
                          سُورَةُ {headerSurah?.name || bannerHeader.s}
                        </h3>
                        <span className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
                          {headerSurah ? `${toArabicIndicDigits(headerSurah.count)} آية` : ''}
                        </span>
                      </div>
                    );
                  }

                  if (bismillahHeader) {
                    return (
                      <div
                        key={`bismillah_${lineNum}_${bismillahHeader.s}`}
                        className="py-1 text-center font-quran text-xl sm:text-2xl text-[#4A220D] tracking-normal"
                      >
                        بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ
                      </div>
                    );
                  }

                  if (lineTokens.length === 0) {
                    return (
                      <div
                        key={`empty_${lineNum}`}
                        className="min-h-[28px]"
                        aria-hidden="true"
                      />
                    );
                  }

                  const groups = groupLineTokensByAyah(lineTokens);

                  return (
                    <div
                      key={`line_${lineNum}`}
                      className={`font-quran text-[22px] sm:text-[27px] leading-[1.95] sm:leading-[2.05] text-[#2A1408] text-center select-none flex flex-wrap items-baseline justify-center gap-x-1.5 ${
                        pageData.p <= 2 ? 'sm:text-[29px]' : ''
                      }`}
                    >
                      {groups.map((grp, gIdx) => {
                        const key = `${grp.surah}:${grp.ayah}`;
                        const mistakeCount = mistakes[key] || 0;
                        const isPlaying =
                          activeAyah?.surah === grp.surah &&
                          activeAyah?.ayah === grp.ayah;
                        const isHolding = holdingAyahKey === key;

                        const matchedRangeKinds = highlightRanges
                          .filter((hr) =>
                            isAyahInRange(grp.surah, grp.ayah, hr.range)
                          )
                          .map((hr) => hr.kind);
                        const isNewHifz = matchedRangeKinds.includes('new_hifz');
                        const isReview =
                          !isNewHifz && matchedRangeKinds.includes('review');

                        const hasEndToken = grp.tokens.some((t) => t.e === 1);

                        let spanClasses =
                          'inline-flex flex-wrap items-baseline gap-x-1.5 px-1 rounded-lg transition-colors cursor-pointer mushaf-no-callout ';
                        if (mistakeCount > 0) {
                          spanClasses +=
                            'bg-[#D95338]/18 text-[#8C1D09] underline decoration-[#D95338] decoration-2 underline-offset-4 ';
                        } else if (isPlaying) {
                          spanClasses +=
                            'bg-[#F56900]/22 text-[#4A220D] ring-2 ring-[#F56900]/65 ';
                        } else if (isHolding) {
                          spanClasses += 'bg-[#F56900]/15 ring-1 ring-[#F56900]/50 ';
                        } else if (isNewHifz) {
                          spanClasses +=
                            'bg-[#58CC02]/16 text-[#235400] border-b-2 border-[#58CC02]/60 ';
                        } else if (isReview) {
                          spanClasses +=
                            'bg-[#FFA900]/18 text-[#593400] border-b-2 border-[#FFA900]/65 ';
                        } else {
                          spanClasses += 'hover:bg-[#F7EBDD]/60 ';
                        }

                        return (
                          <span
                            key={`${key}_${gIdx}`}
                            data-ayah-key={key}
                            draggable={false}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onPointerDown={(e) =>
                              handleAyahPointerDown(e, grp.surah, grp.ayah)
                            }
                            onPointerMove={handleAyahPointerMove}
                            onPointerUp={() =>
                              handleAyahPointerUp(grp.surah, grp.ayah)
                            }
                            onPointerCancel={cancelHoldTimer}
                            onPointerLeave={cancelHoldTimer}
                            className={spanClasses}
                          >
                            {grp.tokens.map((tok, tIdx) =>
                              tok.e === 1 ? (
                                <span
                                  key={`end_${tIdx}`}
                                  className="inline-flex items-center gap-1 mx-0.5 align-middle"
                                >
                                  <span className="font-quran text-[19px] sm:text-[22px] text-[#C95200]">
                                    ﴿{tok.t}﴾
                                  </span>
                                  {mistakeCount > 0 && (
                                    <button
                                      type="button"
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onPointerUp={(e) => e.stopPropagation()}
                                      onClick={(e) => handleClearAyahMistake(e, key)}
                                      title="اضغط على العداد عند تصحيح الطالب لهذه الآية"
                                      className="font-display inline-flex items-center justify-center min-h-[24px] px-1.5 rounded-md bg-[#D95338] hover:bg-[#46A302] text-white text-[11px] font-extrabold tabular-nums shadow-xs cursor-pointer transition-colors"
                                    >
                                      {toArabicIndicDigits(mistakeCount)} ×
                                    </button>
                                  )}
                                </span>
                              ) : (
                                <span key={`w_${tIdx}`}>{tok.t}</span>
                              )
                            )}
                            {/* If mistake is on a partial split line without end token and it's the only occurrence on page or last chunk of line */}
                            {mistakeCount > 0 && !hasEndToken && lineNum === 15 && gIdx === groups.length - 1 && (
                              <button
                                type="button"
                                onPointerDown={(e) => e.stopPropagation()}
                                onPointerUp={(e) => e.stopPropagation()}
                                onClick={(e) => handleClearAyahMistake(e, key)}
                                title="اضغط لتصحيح الخطأ"
                                className="font-display inline-flex items-center justify-center min-h-[24px] px-1.5 rounded-md bg-[#D95338] hover:bg-[#46A302] text-white text-[11px] font-extrabold tabular-nums cursor-pointer"
                              >
                                {toArabicIndicDigits(mistakeCount)} ×
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* Bottom Page Number Footer */}
              <div className="pt-3 mt-3 border-t border-[#EADBC8] flex items-center justify-center">
                <span className="px-4 py-1 rounded-full bg-[#FDF6EE] border border-[#EADBC8] font-display font-extrabold text-sm text-[#4A220D] tabular-nums">
                  {toArabicIndicDigits(pageData.p)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom RTL Page Navigation Bar */}
      <footer className="bg-white border-t-2 border-[#EADBC8] px-3 sm:px-4 pt-2 pb-safe shrink-0">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-2 sm:gap-3">
          <button
            type="button"
            disabled={pageNumber <= 1}
            onClick={() => navigateToPage(pageNumber - 1, 'prev')}
            className="duo-btn-cream min-h-[44px] px-3 sm:px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40 shrink-0"
          >
            <ChevronRight className="w-4 h-4" />
            <span className="hidden sm:inline">الصفحة السابقة</span>
            <span className="sm:hidden">السابقة</span>
          </button>

          <p className="text-[11px] sm:text-xs font-bold text-[#7D4E35] text-center tabular-nums">
            <span className="hidden sm:inline">
              اسحب يميناً للصفحة التالية · اسحب يساراً للسابقة ({toArabicIndicDigits(pageNumber)} / ٦٠٤)
            </span>
            <span className="sm:hidden">
              صفحة {toArabicIndicDigits(pageNumber)} / ٦٠٤
            </span>
          </p>

          <button
            type="button"
            disabled={pageNumber >= 604}
            onClick={() => navigateToPage(pageNumber + 1, 'next')}
            className="duo-btn-orange min-h-[44px] px-3 sm:px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40 shrink-0"
          >
            <span className="hidden sm:inline">الصفحة التالية</span>
            <span className="sm:hidden">التالية</span>
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </footer>
    </div>,
    document.body
  );
};
