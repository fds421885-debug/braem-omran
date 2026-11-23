import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react';
import { playPageTurnSound, toArabicIndicDigits } from '../services/mushafService';
import {
  loadBookPages,
  type ComplexWorkspaceData,
} from '../services/platformService';
import type { BookPageRecord } from '../types/platform';
import { InteractiveBookPageReader } from './InteractiveBookPageReader';
import { ModernLoader } from './ModernLoader';

export type BookReaderMode = 'read' | 'homework_review' | 'pick_page';

interface TeacherBookReaderModalProps {
  workspace: ComplexWorkspaceData;
  bookId: string;
  bookTitle: string;
  studentName: string;
  totalPagesHint?: number;
  initialPage?: number;
  mode: BookReaderMode;
  homeworkLabel?: string;
  currentUserId?: string;
  onStoppedAtPage?: (pageNumber: number) => void;
  onConfirmHomeworkDone?: () => void;
  onPickPage?: (pageNumber: number) => void;
  onClose: () => void;
}

export const TeacherBookReaderModal: React.FC<TeacherBookReaderModalProps> = ({
  workspace,
  bookId,
  bookTitle,
  studentName,
  totalPagesHint = 1,
  initialPage = 1,
  mode,
  homeworkLabel,
  currentUserId,
  onStoppedAtPage,
  onConfirmHomeworkDone,
  onPickPage,
  onClose,
}) => {
  const [pages, setPages] = useState<BookPageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(() =>
    Math.max(1, Math.floor(initialPage || 1))
  );
  const [pageInput, setPageInput] = useState<string>(() =>
    String(Math.max(1, Math.floor(initialPage || 1)))
  );
  const [flipDirection, setFlipDirection] = useState<'next' | 'prev' | null>(null);
  const [flipSeq, setFlipSeq] = useState(0);
  const [manualNavSeq, setManualNavSeq] = useState(0);
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [showTextPanel, setShowTextPanel] = useState(false);

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadBookPages(workspace, bookId)
      .then((loaded) => {
        if (cancelled) return;
        const sorted = [...loaded].sort((a, b) => a.pageNumber - b.pageNumber);
        setPages(sorted);
        const maxAvail = Math.max(sorted.length, totalPagesHint, 1);
        const clamped = Math.max(1, Math.min(maxAvail, Math.floor(initialPage || 1)));
        setCurrentPage(clamped);
        setPageInput(String(clamped));
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'تعذّر تحميل صفحات الكتاب.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace, bookId, initialPage, totalPagesHint]);

  const maxPage = useMemo(() => {
    const highestPageNum = pages.reduce((m, p) => Math.max(m, p.pageNumber), 0);
    return Math.max(highestPageNum, pages.length, totalPagesHint, 1);
  }, [pages, totalPagesHint]);

  const navigateToPage = useCallback(
    (targetPage: number, hint?: 'next' | 'prev', isManual = true) => {
      const clamped = Math.max(1, Math.min(maxPage, Math.floor(targetPage || 1)));
      if (clamped === currentPageRef.current) return;
      const dir = hint || (clamped > currentPageRef.current ? 'next' : 'prev');
      if (isManual) {
        setManualNavSeq((n) => n + 1);
      }
      setFlipDirection(dir);
      setFlipSeq((s) => s + 1);
      playPageTurnSound();
      setCurrentPage(clamped);
      setPageInput(String(clamped));
    },
    [maxPage]
  );

  const handleReaderPageIndexChange = useCallback(
    (nextIndex: number, isContinuousAutoAdvance?: boolean) => {
      const targetPageNum = pages[nextIndex]?.pageNumber ?? nextIndex + 1;
      const dir = targetPageNum >= currentPageRef.current ? 'next' : 'prev';
      navigateToPage(targetPageNum, dir, !isContinuousAutoAdvance);
    },
    [navigateToPage, pages]
  );

  const handleCloseWithAction = useCallback(() => {
    if (mode === 'read' && onStoppedAtPage) {
      onStoppedAtPage(currentPageRef.current);
    }
    onClose();
  }, [mode, onStoppedAtPage, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseWithAction();
      } else if (e.key === 'ArrowLeft') {
        if (currentPageRef.current < maxPage) {
          navigateToPage(currentPageRef.current + 1, 'next');
        }
      } else if (e.key === 'ArrowRight') {
        if (currentPageRef.current > 1) {
          navigateToPage(currentPageRef.current - 1, 'prev');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseWithAction, maxPage, navigateToPage]);

  const activePageIndex = useMemo(() => {
    const exactIdx = pages.findIndex((p) => p.pageNumber === currentPage);
    if (exactIdx >= 0) return exactIdx;
    return pages[currentPage - 1] ? currentPage - 1 : -1;
  }, [pages, currentPage]);

  const activePageRecord = useMemo(
    () => (activePageIndex >= 0 ? pages[activePageIndex] || null : null),
    [pages, activePageIndex]
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label={`قارئ كتاب ${bookTitle}`}
      className="fixed inset-0 z-[85] bg-[#FDF6EE] text-[#4A220D] flex flex-col overflow-hidden"
    >
      {/* Top Reader Toolbar */}
      <header className="bg-white border-b-2 border-[#EADBC8] px-3 sm:px-5 py-2.5 flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={handleCloseWithAction}
            aria-label="إغلاق الكتاب"
            className="w-10 h-10 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-[#4A220D] flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h2 className="font-display text-sm sm:text-base font-extrabold text-[#4A220D] truncate">
              {bookTitle} · <span className="text-[#F56900]">{studentName}</span>
            </h2>
            <p className="text-[11px] font-bold text-[#7D4E35] truncate">
              {mode === 'read'
                ? 'أين وصلنا — عند الإغلاق يُحفظ موضع التوقف تلقائياً'
                : mode === 'homework_review'
                ? `مراجعة الواجب: ${homeworkLabel || ''}`
                : 'تصفّح الكتاب واختر صفحة الواجب المطلوبة'}
            </p>
          </div>
        </div>

        {/* Page Jump + Zoom + Extracted Text Toggle */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = Number(pageInput);
              if (Number.isFinite(parsed)) {
                navigateToPage(parsed);
              }
            }}
            className="flex items-center gap-1 bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-2 py-1"
          >
            <span className="text-[11px] sm:text-xs font-bold text-[#7D4E35]">ص</span>
            <input
              type="number"
              min={1}
              max={maxPage}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => {
                const parsed = Number(pageInput);
                if (Number.isFinite(parsed) && parsed >= 1) {
                  navigateToPage(parsed);
                } else {
                  setPageInput(String(currentPage));
                }
              }}
              aria-label="رقم الصفحة"
              className="w-12 sm:w-14 text-center font-display font-extrabold text-xs sm:text-sm bg-white border border-[#EADBC8] rounded-lg py-0.5 tabular-nums"
            />
            <span className="text-[11px] sm:text-xs font-bold text-[#7D4E35] tabular-nums">
              / {toArabicIndicDigits(maxPage)}
            </span>
          </form>

          <div className="flex items-center gap-0.5 sm:gap-1 bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-1">
            <button
              type="button"
              onClick={() => setZoomPercent((z) => Math.max(60, z - 15))}
              aria-label="تصغير"
              className="w-7 h-7 rounded-lg hover:bg-white flex items-center justify-center text-[#4A220D] cursor-pointer"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-[11px] sm:text-xs font-bold px-1 tabular-nums">{zoomPercent}%</span>
            <button
              type="button"
              onClick={() => setZoomPercent((z) => Math.min(180, z + 15))}
              aria-label="تكبير"
              className="w-7 h-7 rounded-lg hover:bg-white flex items-center justify-center text-[#4A220D] cursor-pointer"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          {activePageRecord?.fullText && (
            <button
              type="button"
              onClick={() => setShowTextPanel((v) => !v)}
              className={`min-h-[36px] px-2.5 sm:px-3 rounded-xl border text-xs font-display font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                showTextPanel
                  ? 'bg-[#F56900] border-[#C95200] text-white'
                  : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
              }`}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">النص المستخرج</span>
              <span className="sm:hidden">النص</span>
            </button>
          )}
        </div>
      </header>

      {/* Mode Specific Action Ribbon */}
      {mode === 'homework_review' && (
        <div className="bg-[#58CC02]/15 border-b border-[#58CC02]/40 px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <p className="text-xs sm:text-sm font-extrabold text-[#46A302]">
            معاينة صفحة الواجب ({toArabicIndicDigits(currentPage)}) · يمكنك تأكيد الإنجاز مباشرة من هنا
          </p>
          <button
            type="button"
            onClick={() => {
              onConfirmHomeworkDone?.();
              onClose();
            }}
            className="duo-btn-green min-h-[40px] px-4 py-1.5 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>تم الحل ✓</span>
          </button>
        </div>
      )}

      {mode === 'pick_page' && (
        <div className="bg-[#F56900]/12 border-b border-[#F56900]/40 px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <p className="text-xs sm:text-sm font-extrabold text-[#4A220D]">
            تصفّح الكتاب وحدد الصفحة المطلوبة للواجب ثم اضغط اعتماد:
          </p>
          <button
            type="button"
            onClick={() => {
              onPickPage?.(currentPage);
              onClose();
            }}
            className="duo-btn-orange min-h-[40px] px-4 py-1.5 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>اعتماد صفحة {toArabicIndicDigits(currentPage)} كواجب</span>
          </button>
        </div>
      )}

      {/* Main Book Page Viewport */}
      <div
        className="flex-1 overflow-auto p-3 sm:p-6 flex flex-col items-center justify-start"
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (t) {
            touchStartRef.current = { x: t.clientX, y: t.clientY };
          }
        }}
        onTouchEnd={(e) => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          if (!start) return;
          const t = e.changedTouches[0];
          if (!t) return;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (zoomPercent <= 100 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25) {
            // RTL Swipe right -> next page; swipe left -> prev page
            if (dx > 0 && currentPage < maxPage) {
              navigateToPage(currentPage + 1, 'next');
            } else if (dx < 0 && currentPage > 1) {
              navigateToPage(currentPage - 1, 'prev');
            }
          }
        }}
      >
        {loading ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10 my-auto">
            <ModernLoader label="جاري تحميل صفحات الكتاب..." />
          </div>
        ) : loadError ? (
          <div className="max-w-md bg-white border-2 border-[#D95338] rounded-3xl p-6 text-center space-y-3 my-auto">
            <AlertCircle className="w-10 h-10 text-[#D95338] mx-auto" />
            <p className="font-display font-extrabold text-base text-[#D95338]">{loadError}</p>
            <button
              type="button"
              onClick={handleCloseWithAction}
              className="duo-btn-cream px-5 py-2 rounded-2xl font-display font-bold text-sm cursor-pointer"
            >
              إغلاق
            </button>
          </div>
        ) : activePageIndex < 0 || !activePageRecord ? (
          <div className="max-w-lg w-full bg-white border-2 border-[#EADBC8] rounded-3xl p-6 sm:p-8 text-center space-y-4 my-auto">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-[#FDF6EE] border border-[#EADBC8] text-[#F56900] flex items-center justify-center">
              <BookOpen className="w-7 h-7" />
            </div>
            <h3 className="font-display font-extrabold text-lg text-[#4A220D]">
              صفحة {toArabicIndicDigits(currentPage)} (غير مرفوعة كصورة بعد)
            </h3>
            <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
              لا توجد صورة مرفوعة لهذه الصفحة في مكتبة الكتاب حالياً، لكن يمكنك ضبط رقم الصفحة يدوياً وحفظه كـ «أين وصلنا» أو كرقم صفحة الواجب دون أي عائق.
            </p>
            <div className="flex items-center justify-center gap-2 pt-2">
              <label className="text-xs font-extrabold text-[#4A220D]">تحديد رقم الصفحة:</label>
              <input
                type="number"
                min={1}
                max={2000}
                value={currentPage}
                onChange={(e) => {
                  const val = Math.max(1, Math.min(2000, Math.floor(Number(e.target.value) || 1)));
                  setCurrentPage(val);
                  setPageInput(String(val));
                }}
                className="w-24 min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-center font-display font-extrabold text-base tabular-nums"
              />
            </div>
          </div>
        ) : (
          <div className="w-full max-w-7xl flex flex-col items-center gap-4">
            <InteractiveBookPageReader
              workspace={workspace}
              bookTitle={bookTitle}
              pages={pages}
              currentPageIndex={activePageIndex}
              onChangePageIndex={handleReaderPageIndexChange}
              manualNavigationSeq={manualNavSeq}
              currentUserId={currentUserId}
              zoomPercent={zoomPercent}
              flipSeq={flipSeq}
              flipDirection={flipDirection}
              rememberTeacherReciter
            />

            {showTextPanel && activePageRecord.fullText && (
              <div className="w-full max-w-4xl bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-2">
                <p className="font-display font-extrabold text-xs sm:text-sm text-[#F56900]">
                  النص المستخرج من الصفحة {toArabicIndicDigits(currentPage)}:
                </p>
                <p className="text-xs sm:text-sm text-[#4A220D] leading-loose whitespace-pre-wrap">
                  {activePageRecord.fullText}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Navigation Footer */}
      <footer className="bg-white border-t-2 border-[#EADBC8] px-3 sm:px-4 pt-2 pb-safe flex items-center justify-between gap-2 sm:gap-3 shrink-0">
        <button
          type="button"
          disabled={currentPage <= 1}
          onClick={() => navigateToPage(currentPage - 1, 'prev')}
          className="duo-btn-cream min-h-[42px] px-3 sm:px-4 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1 cursor-pointer disabled:opacity-40 shrink-0"
        >
          <ChevronRight className="w-4 h-4" />
          <span>السابقة</span>
        </button>

        {mode === 'read' ? (
          <button
            type="button"
            onClick={handleCloseWithAction}
            className="duo-btn-green min-h-[42px] px-3 sm:px-5 rounded-xl font-display font-extrabold text-[11px] sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer min-w-0"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">
              حفظ التوقف عند صفحة {toArabicIndicDigits(currentPage)} وإغلاق
            </span>
            <span className="sm:hidden truncate">
              حفظ (ص {toArabicIndicDigits(currentPage)}) وإغلاق
            </span>
          </button>
        ) : (
          <span className="text-xs font-extrabold text-[#7D4E35] tabular-nums text-center">
            صفحة {toArabicIndicDigits(currentPage)} / {toArabicIndicDigits(maxPage)}
          </span>
        )}

        <button
          type="button"
          disabled={currentPage >= maxPage}
          onClick={() => navigateToPage(currentPage + 1, 'next')}
          className="duo-btn-orange min-h-[42px] px-3 sm:px-4 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1 cursor-pointer disabled:opacity-40 shrink-0"
        >
          <span>التالية</span>
          <ChevronLeft className="w-4 h-4" />
        </button>
      </footer>
    </div>,
    document.body
  );
};
