import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  BookMarked,
  BookOpen,
  Calendar,
  CalendarDays,
  CheckCircle2,
  Eye,
  Forward,
  History,
  Plus,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react';
import { generateValidId, getTodayDateKey } from '../services/multiDb';
import { toArabicIndicDigits } from '../services/mushafService';
import {
  applyBookCorrectionOutcomesToPlan,
  loadStudentBookPlanForDate,
  saveStudentBookPlan,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  BOOK_HOMEWORK_TYPE_LABELS,
  type AccountRecord,
  type BookHomeworkType,
  type BookRecord,
  type CurriculumRecord,
  type StudentBookHomeworkItem,
  type StudentBookPlanRecord,
  type TeacherRoleContext,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';
import { TeacherBookReaderModal, type BookReaderMode } from './TeacherBookReaderModal';

interface TeacherBookWorkspaceProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  student: AccountRecord;
  studentNumber: number;
  curriculum: CurriculumRecord;
  matchedBook: BookRecord | null;
  currentUserId: string;
  currentUserName: string;
  onBack: () => void;
}

const HOMEWORK_TYPE_ORDER: BookHomeworkType[] = [
  'reading',
  'writing',
  'exercise',
  'page_solve',
  'other',
];

function getHomeworkDisplayType(hw: StudentBookHomeworkItem): string {
  if (hw.type === 'other' && hw.customTypeLabel?.trim()) {
    return hw.customTypeLabel.trim();
  }
  return BOOK_HOMEWORK_TYPE_LABELS[hw.type] || 'واجب';
}

export const TeacherBookWorkspace: React.FC<TeacherBookWorkspaceProps> = ({
  workspace,
  context,
  student,
  studentNumber,
  curriculum,
  matchedBook,
  currentUserId,
  currentUserName,
  onBack,
}) => {
  const [dateKey, setDateKey] = useState<string>(() => getTodayDateKey());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const [historyRecords, setHistoryRecords] = useState<StudentBookPlanRecord[]>([]);
  const [carriedFromDate, setCarriedFromDate] = useState<string | null>(null);

  // Core Plan State
  const [whereWeReachedPage, setWhereWeReachedPage] = useState<number>(1);
  const [todayHomeworks, setTodayHomeworks] = useState<StudentBookHomeworkItem[]>([]);
  const [tomorrowHomeworks, setTomorrowHomeworks] = useState<StudentBookHomeworkItem[]>([]);

  // Unsolved prompt state per today homework item
  const [unsolvedMenuId, setUnsolvedMenuId] = useState<string | null>(null);

  // Add Tomorrow Homework Inline Form
  const [addingTomorrow, setAddingTomorrow] = useState(false);
  const [newHwType, setNewHwType] = useState<BookHomeworkType>('reading');
  const [newHwCustomLabel, setNewHwCustomLabel] = useState('');
  const [newHwPage, setNewHwPage] = useState<number>(1);
  const [newHwNote, setNewHwNote] = useState('');

  // Fullscreen Reader Launch State
  const [readerState, setReaderState] = useState<{
    mode: BookReaderMode;
    initialPage: number;
    homeworkId?: string;
    homeworkLabel?: string;
  } | null>(null);

  const loadPlanForDate = useCallback(
    async (targetDateKey: string) => {
      setLoading(true);
      setFeedback(null);
      setUnsolvedMenuId(null);
      try {
        const res = await loadStudentBookPlanForDate({
          workspace,
          studentId: student.id,
          bookId: curriculum.bookId,
          dateKey: targetDateKey,
        });
        setHistoryRecords(res.historyRecords);
        setCarriedFromDate(res.carriedFromDate);
        setWhereWeReachedPage(res.effectiveWhereReachedPage);
        setNewHwPage(res.effectiveWhereReachedPage);
        setTodayHomeworks(res.effectiveTodayHomeworks);
        setTomorrowHomeworks(res.effectiveTomorrowHomeworks);
      } catch (err) {
        setFeedback({
          type: 'error',
          text: err instanceof Error ? err.message : 'تعذّر تحميل بيانات الكتاب للطالب.',
        });
      } finally {
        setLoading(false);
      }
    },
    [workspace, student.id, curriculum.bookId]
  );

  useEffect(() => {
    void loadPlanForDate(dateKey);
  }, [dateKey, loadPlanForDate]);

  const persistPlan = useCallback(
    async (
      nextState: {
        wherePage?: number;
        today?: StudentBookHomeworkItem[];
        tomorrow?: StudentBookHomeworkItem[];
      },
      successMessage?: string,
      options?: { finalizePending?: boolean }
    ) => {
      const targetWhere = nextState.wherePage ?? whereWeReachedPage;
      let targetToday = nextState.today ?? todayHomeworks;
      let targetTomorrow = nextState.tomorrow ?? tomorrowHomeworks;

      if (options?.finalizePending) {
        const normalized = applyBookCorrectionOutcomesToPlan({
          dateKey,
          todayHomeworks: targetToday,
          tomorrowHomeworks: targetTomorrow,
        });
        targetToday = normalized.finalTodayHomeworks;
        targetTomorrow = normalized.finalTomorrowHomeworks;
      }

      setSaving(true);
      setFeedback(null);
      try {
        const saved = await saveStudentBookPlan({
          workspace,
          mosqueId: context.mosqueId,
          halaqaId: context.halaqaId,
          studentId: student.id,
          studentName: student.quadrupleName,
          bookId: curriculum.bookId,
          bookTitle: curriculum.bookTitle,
          dateKey,
          whereWeReachedPage: targetWhere,
          todayHomeworks: targetToday,
          tomorrowHomeworks: targetTomorrow,
          recordedBy: currentUserId,
          recordedByName: currentUserName,
        });
        setTodayHomeworks(saved.todayHomeworks || []);
        setTomorrowHomeworks(saved.tomorrowHomeworks || []);
        setHistoryRecords((prev) => {
          const rest = prev.filter((r) => r.dateKey !== saved.dateKey);
          return [saved, ...rest].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
        });
        setCarriedFromDate(null);
        if (successMessage) {
          setFeedback({ type: 'success', text: successMessage });
        }
      } catch (err) {
        setFeedback({
          type: 'error',
          text: err instanceof Error ? err.message : 'تعذّر حفظ خطة الكتاب في القاعدة.',
        });
      } finally {
        setSaving(false);
      }
    },
    [
      whereWeReachedPage,
      todayHomeworks,
      tomorrowHomeworks,
      workspace,
      context.mosqueId,
      context.halaqaId,
      student.id,
      student.quadrupleName,
      curriculum.bookId,
      curriculum.bookTitle,
      dateKey,
      currentUserId,
      currentUserName,
    ]
  );

  const handleStoppedAtPage = (stoppedPage: number) => {
    const clean = Math.max(1, Math.min(2000, Math.floor(stoppedPage || 1)));
    setWhereWeReachedPage(clean);
    void persistPlan(
      { wherePage: clean },
      `تم حفظ موضع التوقف تلقائياً عند صفحة ${toArabicIndicDigits(clean)}.`
    );
  };

  const handleMarkTodayCompleted = (hwId: string) => {
    const nextToday = todayHomeworks.map((item) =>
      item.id === hwId ? { ...item, status: 'completed' as const } : item
    );
    setTodayHomeworks(nextToday);
    setUnsolvedMenuId(null);
    void persistPlan({ today: nextToday }, 'تم تصحيح الواجب كـ «تم الحل».');
  };

  const handleCancelTodayHomework = (hwId: string) => {
    const nextToday = todayHomeworks.map((item) =>
      item.id === hwId ? { ...item, status: 'cancelled' as const } : item
    );
    setTodayHomeworks(nextToday);
    setUnsolvedMenuId(null);
    void persistPlan({ today: nextToday }, 'تم إلغاء الواجب من سجل اليوم.');
  };

  const handleDeferTodayHomework = (hw: StudentBookHomeworkItem) => {
    const nextToday = todayHomeworks.map((item) =>
      item.id === hw.id ? { ...item, status: 'deferred' as const } : item
    );
    const { finalTomorrowHomeworks } = applyBookCorrectionOutcomesToPlan({
      dateKey,
      todayHomeworks: nextToday,
      tomorrowHomeworks,
    });
    setTodayHomeworks(nextToday);
    setTomorrowHomeworks(finalTomorrowHomeworks);
    setUnsolvedMenuId(null);
    void persistPlan(
      { today: nextToday, tomorrow: finalTomorrowHomeworks },
      'تم ترحيل الواجب إلى واجبات غد تلقائياً.'
    );
  };

  const handleAddTomorrowHomework = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPage = Math.max(1, Math.min(2000, Math.floor(Number(newHwPage) || 1)));
    const newItem: StudentBookHomeworkItem = {
      id: generateValidId('hw'),
      type: newHwType,
      ...(newHwType === 'other' && newHwCustomLabel.trim()
        ? { customTypeLabel: newHwCustomLabel.trim().slice(0, 60) }
        : {}),
      pageNumber: cleanPage,
      ...(newHwNote.trim() ? { note: newHwNote.trim().slice(0, 200) } : {}),
      status: 'pending',
    };
    const nextTomorrow = [...tomorrowHomeworks, newItem];
    setTomorrowHomeworks(nextTomorrow);
    setNewHwCustomLabel('');
    setNewHwNote('');
    setAddingTomorrow(false);
    void persistPlan({ tomorrow: nextTomorrow }, 'تمت إضافة الواجب إلى واجبات غد.');
  };

  const handleRemoveTomorrowHomework = (hwId: string) => {
    const nextTomorrow = tomorrowHomeworks.filter((item) => item.id !== hwId);
    setTomorrowHomeworks(nextTomorrow);
    void persistPlan({ tomorrow: nextTomorrow }, 'تم حذف الواجب من واجبات غد.');
  };

  const totalBookPagesHint = matchedBook?.totalPages || Math.max(whereWeReachedPage, 1);

  return (
    <div className="space-y-5" dir="rtl">
      {/* Top Student & Date Control Card */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="duo-btn-cream min-h-[42px] px-3.5 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <ArrowRight className="w-4 h-4" />
              <span>قائمة الطلاب</span>
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2.5 py-0.5 rounded-lg bg-[#F56900]/15 text-[#F56900] font-display font-extrabold text-xs tabular-nums">
                  طالب #{toArabicIndicDigits(studentNumber)}
                </span>
                <span className="px-2.5 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#46A302] font-display font-extrabold text-xs inline-flex items-center gap-1">
                  <BookMarked className="w-3.5 h-3.5" />
                  <span>{curriculum.bookTitle}</span>
                </span>
              </div>
              <h2 className="font-display text-lg sm:text-2xl font-extrabold text-[#4A220D] truncate mt-1">
                {student.quadrupleName}
              </h2>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-xl px-3 py-1.5">
              <Calendar className="w-4 h-4 text-[#F56900]" />
              <input
                type="date"
                value={dateKey}
                onChange={(e) => {
                  if (e.target.value) setDateKey(e.target.value);
                }}
                aria-label="تاريخ المتابعة"
                className="bg-transparent text-xs sm:text-sm font-bold text-[#4A220D] focus:outline-none cursor-pointer"
              />
            </div>

            <button
              type="button"
              onClick={() =>
                void persistPlan(
                  {},
                  'تم حفظ خطة اليوم واعتماد تصحيح الواجبات بنجاح.',
                  { finalizePending: true }
                )
              }
              disabled={saving || loading}
              className="duo-btn-green min-h-[42px] px-4 py-2 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'جاري الحفظ...' : 'حفظ الخطة'}</span>
            </button>
          </div>
        </div>

        {/* Recorded History Chips */}
        {historyRecords.length > 0 && (
          <div className="pt-2 border-t border-[#EADBC8] flex flex-wrap items-center gap-2">
            <span className="text-xs font-extrabold text-[#7D4E35] inline-flex items-center gap-1">
              <History className="w-3.5 h-3.5 text-[#F56900]" />
              <span>سجلات سابقة:</span>
            </span>
            {historyRecords.slice(0, 10).map((rec) => {
              const active = rec.dateKey === dateKey;
              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => setDateKey(rec.dateKey)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold border transition-colors cursor-pointer tabular-nums ${
                    active
                      ? 'bg-[#F56900] border-[#C95200] text-white'
                      : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                  }`}
                >
                  {rec.dateKey} (ص {toArabicIndicDigits(rec.whereWeReachedPage)})
                </button>
              );
            })}
          </div>
        )}
      </div>

      {feedback && (
        <div
          className={`px-4 py-3 rounded-2xl border-2 text-xs sm:text-sm font-bold flex items-center justify-between gap-2 ${
            feedback.type === 'success'
              ? 'bg-[#58CC02]/15 border-[#58CC02] text-[#46A302]'
              : 'bg-[#D95338]/12 border-[#D95338] text-[#D95338]'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs underline cursor-pointer"
          >
            إخفاء
          </button>
        </div>
      )}

      {loading ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
          <ModernLoader label="جاري تحميل موضع الكتاب وواجبات الطالب..." />
        </div>
      ) : (
        <div className="space-y-5">
          {/* 1. Where We Reached Section (أين وصلنا) */}
          <section className="bg-white border-2 border-[#58CC02] rounded-3xl p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] flex items-center gap-2">
                  <BookOpen className="w-5 h-5 text-[#46A302]" />
                  <span>أين وصلنا في الكتاب</span>
                </h3>
                <p className="text-xs sm:text-sm text-[#7D4E35] mt-0.5">
                  يُضبط تلقائياً على الصفحة الأولى، وأي صفحة تتوقف عندها وتغلق الكتاب تُحفظ تلقائياً لتفتح عليها لاحقاً.
                </p>
              </div>

              <div className="px-4 py-2 rounded-2xl bg-[#58CC02]/15 border border-[#58CC02] text-center">
                <span className="block text-[11px] font-bold text-[#46A302]">الصفحة الحالية</span>
                <span className="font-display text-2xl font-extrabold text-[#4A220D] tabular-nums">
                  {toArabicIndicDigits(whereWeReachedPage)}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  setReaderState({
                    mode: 'read',
                    initialPage: whereWeReachedPage,
                  })
                }
                className="duo-btn-green min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer"
              >
                <BookOpen className="w-5 h-5" />
                <span>فتح الكتاب عند صفحة {toArabicIndicDigits(whereWeReachedPage)}</span>
              </button>

              {matchedBook && (
                <span className="text-xs font-bold text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] px-3 py-2 rounded-xl tabular-nums">
                  إجمالي صفحات الكتاب: {toArabicIndicDigits(matchedBook.totalPages)}
                </span>
              )}
            </div>
          </section>

          {/* 2. Today's Homeworks Section (واجبات اليوم) */}
          <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] flex items-center gap-2">
                  <CalendarDays className="w-5 h-5 text-[#F56900]" />
                  <span>واجبات اليوم</span>
                </h3>
                <p className="text-xs sm:text-sm text-[#7D4E35]">
                  تظهر هنا واجبات الأمس تلقائياً لتصحيحها؛ أي واجب يُترك دون تعديل يُعتمد تلقائياً كـ «تم الحل ✓» عند الضغط على «حفظ الخطة»، وما يُحدد كـ «لم يحل» يُلغى أو يُرحّل تلقائياً لواجبات غد.
                </p>
              </div>

              {carriedFromDate && (
                <span className="px-3 py-1 rounded-xl bg-[#FFA900]/15 border border-[#FFA900] text-xs font-extrabold text-[#D98A00]">
                  مرصودة تلقائياً من تاريخ {carriedFromDate}
                </span>
              )}
            </div>

            {todayHomeworks.length === 0 ? (
              <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-5 text-center text-xs sm:text-sm font-bold text-[#7D4E35]">
                لا توجد واجبات مقررة لليوم حتى الآن.
              </div>
            ) : (
              <div className="space-y-3">
                {todayHomeworks.map((hw, idx) => {
                  const typeLabel = getHomeworkDisplayType(hw);
                  const showUnsolvedChoices = unsolvedMenuId === hw.id;
                  return (
                    <div
                      key={hw.id}
                      className={`rounded-2xl border-2 p-4 space-y-3 transition-colors ${
                        hw.status === 'completed'
                          ? 'bg-[#58CC02]/10 border-[#58CC02]'
                          : hw.status === 'cancelled'
                          ? 'bg-[#FDF6EE]/70 border-[#EADBC8] opacity-75'
                          : hw.status === 'deferred'
                          ? 'bg-[#FFA900]/10 border-[#FFA900]'
                          : 'bg-[#FDF6EE]/60 border-[#EADBC8]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="w-7 h-7 rounded-lg bg-white border border-[#EADBC8] font-display font-extrabold text-xs inline-flex items-center justify-center tabular-nums">
                            {toArabicIndicDigits(idx + 1)}
                          </span>
                          <span className="px-2.5 py-1 rounded-xl bg-[#F56900]/15 text-[#F56900] font-display font-extrabold text-xs">
                            {typeLabel}
                          </span>
                          <span className="px-2.5 py-1 rounded-xl bg-white border border-[#EADBC8] font-display font-extrabold text-xs text-[#4A220D] tabular-nums">
                            صفحة {toArabicIndicDigits(hw.pageNumber)}
                          </span>
                          {hw.deferredFromDate && (
                            <span className="px-2 py-0.5 rounded-lg bg-[#FFA900]/20 text-[#D98A00] text-[11px] font-bold">
                              مرحّل من {hw.deferredFromDate}
                            </span>
                          )}
                        </div>

                        {/* Status Badge */}
                        <span
                          className={`px-2.5 py-1 rounded-xl text-xs font-extrabold ${
                            hw.status === 'completed'
                              ? 'bg-[#58CC02] text-white'
                              : hw.status === 'cancelled'
                              ? 'bg-[#D95338]/15 text-[#D95338]'
                              : hw.status === 'deferred'
                              ? 'bg-[#FFA900] text-white'
                              : 'bg-[#58CC02]/15 border border-[#58CC02]/45 text-[#46A302]'
                          }`}
                        >
                          {hw.status === 'completed'
                            ? 'تم الحل ✓'
                            : hw.status === 'cancelled'
                            ? 'تم الإلغاء'
                            : hw.status === 'deferred'
                            ? 'مُرحّل لبكرة'
                            : 'تم الحل (تلقائي عند الحفظ)'}
                        </span>
                      </div>

                      {hw.note && (
                        <p className="text-xs text-[#7D4E35] bg-white border border-[#EADBC8] rounded-xl px-3 py-1.5">
                          {hw.note}
                        </p>
                      )}

                      {/* Homework Actions */}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() =>
                            setReaderState({
                              mode: 'homework_review',
                              initialPage: hw.pageNumber,
                              homeworkId: hw.id,
                              homeworkLabel: `${typeLabel} — صفحة ${toArabicIndicDigits(hw.pageNumber)}`,
                            })
                          }
                          className="duo-btn-cream min-h-[38px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 text-[#F56900]" />
                          <span>عرض الصفحة وتصحيحها</span>
                        </button>

                        {hw.status !== 'completed' && (
                          <button
                            type="button"
                            onClick={() => handleMarkTodayCompleted(hw.id)}
                            className="duo-btn-green min-h-[38px] px-3.5 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>تم الحل</span>
                          </button>
                        )}

                        {hw.status !== 'cancelled' && hw.status !== 'deferred' && (
                          <button
                            type="button"
                            onClick={() =>
                              setUnsolvedMenuId((prev) => (prev === hw.id ? null : hw.id))
                            }
                            className="min-h-[38px] px-3 py-1.5 rounded-xl border-2 border-[#D95338]/50 bg-white hover:bg-[#D95338]/10 text-[#D95338] font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>لم يحل</span>
                          </button>
                        )}
                      </div>

                      {/* Unsolved Options: Cancel vs Defer to Tomorrow */}
                      {showUnsolvedChoices && (
                        <div className="bg-white border-2 border-[#FFA900] rounded-2xl p-3 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-extrabold text-[#4A220D]">
                            اختر الإجراء لعدم حل الواجب:
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleCancelTodayHomework(hw.id)}
                              className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#D95338] text-white font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>إلغاء الواجب من عليه</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeferTodayHomework(hw)}
                              className="duo-btn-orange min-h-[36px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Forward className="w-3.5 h-3.5" />
                              <span>ترحيله لبكرة (مع واجبات بكرة)</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 3. Tomorrow's Homeworks Section (واجبات غد) */}
          <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] flex items-center gap-2">
                  <Plus className="w-5 h-5 text-[#F56900]" />
                  <span>واجبات غد</span>
                </h3>
                <p className="text-xs sm:text-sm text-[#7D4E35]">
                  أضف أي عدد من الواجبات للغد وحدد صفحتها من الكتاب؛ وستظهر تلقائياً في واجبات اليوم غداً.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setNewHwPage(whereWeReachedPage);
                  setAddingTomorrow((v) => !v);
                }}
                className="duo-btn-orange min-h-[42px] px-4 py-2 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{addingTomorrow ? 'إخفاء النموذج' : 'أضف واجب'}</span>
              </button>
            </div>

            {/* Inline Add Homework Form */}
            {addingTomorrow && (
              <form
                onSubmit={handleAddTomorrowHomework}
                className="bg-[#FDF6EE] border-2 border-[#F56900] rounded-2xl p-4 space-y-4"
              >
                <div className="space-y-2">
                  <label className="text-xs font-extrabold text-[#4A220D] block">نوع الواجب</label>
                  <div className="flex flex-wrap gap-2">
                    {HOMEWORK_TYPE_ORDER.map((tKey) => (
                      <button
                        key={tKey}
                        type="button"
                        onClick={() => setNewHwType(tKey)}
                        className={`min-h-[38px] px-3.5 py-1.5 rounded-xl border-2 font-display font-bold text-xs cursor-pointer transition-colors ${
                          newHwType === tKey
                            ? 'bg-[#F56900] border-[#C95200] text-white'
                            : 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                        }`}
                      >
                        {BOOK_HOMEWORK_TYPE_LABELS[tKey]}
                      </button>
                    ))}
                  </div>
                </div>

                {newHwType === 'other' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-extrabold text-[#4A220D] block">
                      تحديد نوع الواجب
                    </label>
                    <input
                      type="text"
                      value={newHwCustomLabel}
                      onChange={(e) => setNewHwCustomLabel(e.target.value)}
                      placeholder="مثال: حفظ قاعدة / تلخيص"
                      required
                      className="w-full min-h-[42px] px-3.5 rounded-xl border-2 border-[#EADBC8] bg-white text-sm text-[#4A220D]"
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                  <div className="space-y-1.5">
                    <label className="text-xs font-extrabold text-[#4A220D] block">
                      صفحة الواجب في الكتاب
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={2000}
                        value={newHwPage}
                        onChange={(e) =>
                          setNewHwPage(
                            Math.max(1, Math.min(2000, Math.floor(Number(e.target.value) || 1)))
                          )
                        }
                        className="w-28 min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-center font-display font-extrabold text-sm tabular-nums"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setReaderState({
                            mode: 'pick_page',
                            initialPage: newHwPage,
                          })
                        }
                        className="duo-btn-cream flex-1 min-h-[42px] px-3 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <BookOpen className="w-4 h-4 text-[#F56900]" />
                        <span>فتح الكتاب وتحديد الصفحة</span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-extrabold text-[#4A220D] block">
                      ملاحظة إضافية (اختياري)
                    </label>
                    <input
                      type="text"
                      value={newHwNote}
                      onChange={(e) => setNewHwNote(e.target.value)}
                      placeholder="مثال: التمرين رقم ٢ و ٣"
                      className="w-full min-h-[42px] px-3.5 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm text-[#4A220D]"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    className="duo-btn-green min-h-[42px] px-5 rounded-xl font-display font-extrabold text-xs sm:text-sm cursor-pointer"
                  >
                    إضافة الواجب لقائمة غد
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingTomorrow(false)}
                    className="duo-btn-cream min-h-[42px] px-4 rounded-xl font-display font-bold text-xs sm:text-sm cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              </form>
            )}

            {tomorrowHomeworks.length === 0 ? (
              <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-5 text-center text-xs sm:text-sm font-bold text-[#7D4E35]">
                قائمة واجبات غد فارغة حالياً. اضغط «أضف واجب» لتحديد واجب من الكتاب.
              </div>
            ) : (
              <div className="space-y-2.5">
                {tomorrowHomeworks.map((hw, idx) => (
                  <div
                    key={hw.id}
                    className="bg-[#FDF6EE]/70 border-2 border-[#EADBC8] rounded-2xl p-3.5 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="w-6 h-6 rounded-lg bg-white border border-[#EADBC8] font-display font-extrabold text-xs inline-flex items-center justify-center tabular-nums">
                          {toArabicIndicDigits(idx + 1)}
                        </span>
                        <span className="px-2.5 py-0.5 rounded-lg bg-[#F56900]/15 text-[#F56900] font-display font-extrabold text-xs">
                          {getHomeworkDisplayType(hw)}
                        </span>
                        <span className="px-2.5 py-0.5 rounded-lg bg-white border border-[#EADBC8] font-display font-extrabold text-xs text-[#4A220D] tabular-nums">
                          صفحة {toArabicIndicDigits(hw.pageNumber)}
                        </span>
                        {hw.deferredFromDate && (
                          <span className="px-2 py-0.5 rounded-lg bg-[#FFA900]/20 text-[#D98A00] text-[11px] font-bold">
                            مرحّل من {hw.deferredFromDate}
                          </span>
                        )}
                      </div>
                      {hw.note && <p className="text-xs text-[#7D4E35] pr-1">{hw.note}</p>}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setReaderState({
                            mode: 'read',
                            initialPage: hw.pageNumber,
                          })
                        }
                        className="min-h-[36px] px-3 rounded-xl border border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#4A220D] inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5 text-[#F56900]" />
                        <span>معاينة</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveTomorrowHomework(hw.id)}
                        aria-label="حذف الواجب"
                        className="min-h-[36px] min-w-[36px] rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] inline-flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Fullscreen Book Reader Portal */}
      {readerState && (
        <TeacherBookReaderModal
          workspace={workspace}
          bookId={curriculum.bookId}
          bookTitle={curriculum.bookTitle}
          studentName={student.quadrupleName}
          totalPagesHint={totalBookPagesHint}
          initialPage={readerState.initialPage}
          mode={readerState.mode}
          homeworkLabel={readerState.homeworkLabel}
          currentUserId={currentUserId}
          onStoppedAtPage={handleStoppedAtPage}
          onConfirmHomeworkDone={() => {
            if (readerState.homeworkId) {
              handleMarkTodayCompleted(readerState.homeworkId);
            }
          }}
          onPickPage={(picked) => {
            setNewHwPage(picked);
          }}
          onClose={() => setReaderState(null)}
        />
      )}
    </div>
  );
};
