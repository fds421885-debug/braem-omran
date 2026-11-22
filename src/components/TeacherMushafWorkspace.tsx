import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Calendar,
  CalendarDays,
  CheckCircle2,
  Eye,
  History,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Volume2,
} from 'lucide-react';
import { generateValidId, getTodayDateKey } from '../services/multiDb';
import {
  formatQuranRangeSummary,
  getPageForAyah,
  getSavedTeacherReciterId,
  getSurahsList,
  toArabicIndicDigits,
  type MushafSurahMeta,
} from '../services/mushafService';
import {
  loadStudentMushafMistakes,
  loadStudentQuranPlanForDate,
  saveStudentMushafMistakes,
  saveStudentQuranPlan,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  QURAN_RECITERS,
  QURAN_REVIEW_TYPE_LABELS,
  type AccountRecord,
  type QuranRangeRef,
  type QuranReviewType,
  type StudentQuranNewHifzItem,
  type StudentQuranPlanRecord,
  type StudentQuranReviewItem,
  type TeacherRoleContext,
} from '../types/platform';
import {
  KingFahdMushafReader,
  type MushafHighlightRange,
} from './KingFahdMushafReader';
import { ModernLoader } from './ModernLoader';

interface TeacherMushafWorkspaceProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  student: AccountRecord;
  studentNumber: number;
  currentUserId: string;
  currentUserName: string;
  onBack: () => void;
}

interface MushafLaunchState {
  initialPage: number;
  focusTarget: { surah: number; ayah: number } | null;
  highlightRanges: MushafHighlightRange[];
}

interface RangeEditorProps {
  surahs: MushafSurahMeta[];
  value: QuranRangeRef;
  onChange: (next: QuranRangeRef) => void;
}

const RangeSelectorRow: React.FC<RangeEditorProps> = ({ surahs, value, onChange }) => {
  const startSurahMeta = useMemo(
    () => surahs.find((s) => s.n === value.startSurah) || surahs[0],
    [surahs, value.startSurah]
  );
  const endSurahMeta = useMemo(
    () => surahs.find((s) => s.n === value.endSurah) || surahs[0],
    [surahs, value.endSurah]
  );

  const startAyahOptions = useMemo(() => {
    const max = startSurahMeta?.count || 7;
    return Array.from({ length: max }, (_, i) => i + 1);
  }, [startSurahMeta]);

  const endAyahOptions = useMemo(() => {
    const max = endSurahMeta?.count || 7;
    return Array.from({ length: max }, (_, i) => i + 1);
  }, [endSurahMeta]);

  const handleStartSurahChange = (newStartSurah: number) => {
    const sMeta = surahs.find((s) => s.n === newStartSurah);
    const maxAyah = sMeta?.count || 7;
    const clampedStartAyah = Math.min(value.startAyah, maxAyah);

    // Keep end sensible if user shifts start forward past old end
    let nextEndSurah = value.endSurah;
    let nextEndAyah = value.endAyah;
    if (newStartSurah > nextEndSurah) {
      nextEndSurah = newStartSurah;
      nextEndAyah = Math.min(maxAyah, Math.max(clampedStartAyah, Math.min(clampedStartAyah + 5, maxAyah)));
    }
    onChange({
      startSurah: newStartSurah,
      startAyah: clampedStartAyah,
      endSurah: nextEndSurah,
      endAyah: nextEndAyah,
    });
  };

  const handleEndSurahChange = (newEndSurah: number) => {
    const eMeta = surahs.find((s) => s.n === newEndSurah);
    const maxAyah = eMeta?.count || 7;
    const clampedEndAyah = Math.min(value.endAyah, maxAyah);
    onChange({
      ...value,
      endSurah: newEndSurah,
      endAyah: clampedEndAyah,
    });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* Start Position */}
      <div className="bg-white border border-[#EADBC8] rounded-2xl p-3 space-y-2">
        <p className="text-xs font-extrabold text-[#7D4E35]">موضع البداية (من)</p>
        <div className="grid grid-cols-3 gap-2">
          <select
            value={value.startSurah}
            onChange={(e) => handleStartSurahChange(Number(e.target.value))}
            aria-label="سورة البداية"
            className="col-span-2 min-h-[42px] px-2.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer"
          >
            {surahs.map((s) => (
              <option key={s.n} value={s.n}>
                {toArabicIndicDigits(s.n)}. {s.name}
              </option>
            ))}
          </select>
          <select
            value={value.startAyah}
            onChange={(e) =>
              onChange({
                ...value,
                startAyah: Number(e.target.value),
              })
            }
            aria-label="آية البداية"
            className="col-span-1 min-h-[42px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs sm:text-sm font-bold text-[#4A220D] tabular-nums cursor-pointer"
          >
            {startAyahOptions.map((aNum) => (
              <option key={aNum} value={aNum}>
                آية {toArabicIndicDigits(aNum)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* End Position */}
      <div className="bg-white border border-[#EADBC8] rounded-2xl p-3 space-y-2">
        <p className="text-xs font-extrabold text-[#7D4E35]">موضع النهاية (إلى)</p>
        <div className="grid grid-cols-3 gap-2">
          <select
            value={value.endSurah}
            onChange={(e) => handleEndSurahChange(Number(e.target.value))}
            aria-label="سورة النهاية"
            className="col-span-2 min-h-[42px] px-2.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer"
          >
            {surahs.map((s) => (
              <option key={s.n} value={s.n}>
                {toArabicIndicDigits(s.n)}. {s.name}
              </option>
            ))}
          </select>
          <select
            value={value.endAyah}
            onChange={(e) =>
              onChange({
                ...value,
                endAyah: Number(e.target.value),
              })
            }
            aria-label="آية النهاية"
            className="col-span-1 min-h-[42px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs sm:text-sm font-bold text-[#4A220D] tabular-nums cursor-pointer"
          >
            {endAyahOptions.map((aNum) => (
              <option key={aNum} value={aNum}>
                آية {toArabicIndicDigits(aNum)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
};

export const TeacherMushafWorkspace: React.FC<TeacherMushafWorkspaceProps> = ({
  workspace,
  context,
  student,
  studentNumber,
  currentUserId,
  currentUserName,
  onBack,
}) => {
  const [dateKey, setDateKey] = useState<string>(() => getTodayDateKey());
  const [surahs, setSurahs] = useState<MushafSurahMeta[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [savingPlan, setSavingPlan] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const [historyRecords, setHistoryRecords] = useState<StudentQuranPlanRecord[]>([]);
  const [carriedFromDate, setCarriedFromDate] = useState<string | null>(null);

  // Plan Sections State (empty by default unless saved or carried over from yesterday's tomorrow)
  const [todayNew, setTodayNew] = useState<StudentQuranNewHifzItem | null>(null);
  const [todayReviews, setTodayReviews] = useState<StudentQuranReviewItem[]>([]);
  const [tomorrowNew, setTomorrowNew] = useState<StudentQuranNewHifzItem | null>(null);
  const [tomorrowReviews, setTomorrowReviews] = useState<StudentQuranReviewItem[]>([]);

  // Per-student persistent Mushaf mistakes
  const [mistakes, setMistakes] = useState<Record<string, number>>({});
  const [mushafLaunch, setMushafLaunch] = useState<MushafLaunchState | null>(null);
  const mistakeSaveSeqRef = useRef(0);

  const loadAllForDate = useCallback(
    async (targetDateKey: string) => {
      setLoading(true);
      setFeedback(null);
      try {
        const [surahList, planRes, studentMistakes] = await Promise.all([
          getSurahsList(),
          loadStudentQuranPlanForDate({
            workspace,
            studentId: student.id,
            dateKey: targetDateKey,
          }),
          loadStudentMushafMistakes(workspace, student.id),
        ]);

        setSurahs(surahList);
        setHistoryRecords(planRes.historyRecords);
        setCarriedFromDate(planRes.carriedFromDate);
        setTodayNew(planRes.effectiveTodayNew);
        setTodayReviews(planRes.effectiveTodayReviews);
        setTomorrowNew(planRes.effectiveTomorrowNew);
        setTomorrowReviews(planRes.effectiveTomorrowReviews);
        setMistakes(studentMistakes);
      } catch (err) {
        setFeedback({
          type: 'error',
          text:
            err instanceof Error
              ? err.message
              : 'تعذّر تحميل بيانات المصحف والخطة للطالب.',
        });
      } finally {
        setLoading(false);
      }
    },
    [workspace, student.id]
  );

  useEffect(() => {
    void loadAllForDate(dateKey);
  }, [loadAllForDate, dateKey]);

  const handleMistakesChange = useCallback(
    async (nextMistakes: Record<string, number>) => {
      setMistakes(nextMistakes);
      const seq = ++mistakeSaveSeqRef.current;
      try {
        await saveStudentMushafMistakes({
          workspace,
          studentId: student.id,
          studentName: student.quadrupleName,
          mistakes: nextMistakes,
          updatedBy: currentUserId,
        });
      } catch (err) {
        if (seq === mistakeSaveSeqRef.current) {
          setFeedback({
            type: 'error',
            text:
              err instanceof Error
                ? err.message
                : 'تعذّر حفظ تعديل أخطاء الطالب في قاعدة البيانات.',
          });
        }
      }
    },
    [workspace, student.id, student.quadrupleName, currentUserId]
  );

  const buildDefaultRange = (): QuranRangeRef => {
    const first = surahs[0] || { n: 1, count: 7 };
    return {
      startSurah: first.n,
      startAyah: 1,
      endSurah: first.n,
      endAyah: first.count,
    };
  };

  const handleOpenMushafRange = async (
    targetRange: QuranRangeRef | null,
    scope: 'today' | 'tomorrow'
  ) => {
    const highlightRanges: MushafHighlightRange[] = [];

    if (scope === 'today') {
      if (todayNew) {
        highlightRanges.push({
          label: `الحفظ الجديد: ${formatQuranRangeSummary(surahs, todayNew)}`,
          kind: 'new_hifz',
          range: todayNew,
        });
      }
      for (const rev of todayReviews) {
        const revLabel =
          rev.reviewType === 'custom' && rev.customLabel
            ? rev.customLabel
            : QURAN_REVIEW_TYPE_LABELS[rev.reviewType];
        highlightRanges.push({
          label: `${revLabel}: ${formatQuranRangeSummary(surahs, rev)}`,
          kind: 'review',
          range: rev,
        });
      }
    } else {
      if (tomorrowNew) {
        highlightRanges.push({
          label: `حفظ الغد الجديد: ${formatQuranRangeSummary(surahs, tomorrowNew)}`,
          kind: 'new_hifz',
          range: tomorrowNew,
        });
      }
      for (const rev of tomorrowReviews) {
        const revLabel =
          rev.reviewType === 'custom' && rev.customLabel
            ? rev.customLabel
            : QURAN_REVIEW_TYPE_LABELS[rev.reviewType];
        highlightRanges.push({
          label: `مراجعة الغد (${revLabel}): ${formatQuranRangeSummary(surahs, rev)}`,
          kind: 'review',
          range: rev,
        });
      }
    }

    const effectiveTarget = targetRange || todayNew || todayReviews[0] || null;
    const initialPage = effectiveTarget
      ? await getPageForAyah(effectiveTarget.startSurah, effectiveTarget.startAyah)
      : 1;

    setMushafLaunch({
      initialPage,
      focusTarget: effectiveTarget
        ? { surah: effectiveTarget.startSurah, ayah: effectiveTarget.startAyah }
        : null,
      highlightRanges,
    });
  };

  const handleSavePlan = async () => {
    setSavingPlan(true);
    setFeedback(null);
    try {
      const saved = await saveStudentQuranPlan({
        workspace,
        mosqueId: context.mosqueId,
        halaqaId: context.halaqaId,
        studentId: student.id,
        studentName: student.quadrupleName,
        dateKey,
        todayNew,
        todayReviews,
        tomorrowNew,
        tomorrowReviews,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });

      setHistoryRecords((prev) => {
        const filtered = prev.filter((item) => item.dateKey !== saved.dateKey);
        return [saved, ...filtered].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
      });
      setCarriedFromDate(null);
      setFeedback({
        type: 'success',
        text: `تم حفظ خطة الحفظ والمراجعة للطالب بتاريخ ${dateKey} بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'تعذّر حفظ خطة الطالب.',
      });
    } finally {
      setSavingPlan(false);
    }
  };

  const handleAddTodayReview = () => {
    const def = buildDefaultRange();
    setTodayReviews((prev) => [
      ...prev,
      {
        id: generateValidId('rev'),
        reviewType: 'surah_review',
        ...def,
      },
    ]);
  };

  const handleAddTomorrowReview = () => {
    const def = buildDefaultRange();
    setTomorrowReviews((prev) => [
      ...prev,
      {
        id: generateValidId('rev'),
        reviewType: 'surah_review',
        ...def,
      },
    ]);
  };

  const totalMistakesCount = useMemo(
    () => Object.values(mistakes).reduce((sum, v) => sum + v, 0),
    [mistakes]
  );

  const reviewTypesList = Object.entries(QURAN_REVIEW_TYPE_LABELS) as [
    QuranReviewType,
    string,
  ][];

  return (
    <div className="space-y-5">
      {/* Top Student Header + Date Navigation */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="duo-btn-cream min-h-[42px] px-3.5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <ArrowRight className="w-4 h-4" />
              <span>رجوع</span>
            </button>

            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 rounded-xl bg-[#F56900] text-white font-display font-extrabold text-sm inline-flex items-center justify-center shrink-0 tabular-nums">
                {toArabicIndicDigits(studentNumber)}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold text-[#F56900]">
                  مقرر المصحف الشريف · {context.halaqaName}
                </p>
                <h2 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] truncate">
                  {student.quadrupleName}
                </h2>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1.5 rounded-xl bg-[#D95338]/10 text-[#9A2510] text-xs font-extrabold tabular-nums">
              أخطاء المصحف المسجلة: {toArabicIndicDigits(totalMistakesCount)}
            </span>
            <button
              type="button"
              onClick={() => void handleOpenMushafRange(null, 'today')}
              className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer"
            >
              <BookOpen className="w-4 h-4" />
              <span>فتح المصحف للطالب</span>
            </button>
          </div>
        </div>

        {/* Date Picker + Past Recorded Dates History */}
        <div className="pt-3 border-t border-[#EADBC8] flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Calendar className="w-4 h-4 text-[#F56900]" />
              <label
                htmlFor="quran-plan-date"
                className="text-xs sm:text-sm font-display font-extrabold text-[#4A220D]"
              >
                تاريخ التسميع والخطة:
              </label>
              <input
                id="quran-plan-date"
                type="date"
                value={dateKey}
                onChange={(e) => {
                  if (e.target.value) setDateKey(e.target.value);
                }}
                className="min-h-[40px] px-3 py-1 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] font-display font-bold text-xs sm:text-sm tabular-nums"
              />
              {dateKey !== getTodayDateKey() && (
                <button
                  type="button"
                  onClick={() => setDateKey(getTodayDateKey())}
                  className="min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#F56900] cursor-pointer"
                >
                  العودة لتاريخ اليوم
                </button>
              )}
            </div>

            <button
              type="button"
              disabled={savingPlan || loading}
              onClick={() => void handleSavePlan()}
              className="duo-btn-green min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{savingPlan ? 'جاري الحفظ...' : 'حفظ خطة اليوم والغد'}</span>
            </button>
          </div>

          {/* Clickable Historical Sessions Bar */}
          {historyRecords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs font-bold text-[#7D4E35] ml-1">
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
                    className={`min-h-[34px] px-2.5 py-1 rounded-xl border text-xs font-bold tabular-nums cursor-pointer transition-colors ${
                      active
                        ? 'bg-[#F56900] border-[#C95200] text-white'
                        : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                    }`}
                  >
                    {rec.dateKey}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Auto-carry-over notice from previous day */}
        {carriedFromDate && (
          <div className="bg-[#58CC02]/10 border-2 border-[#58CC02]/45 rounded-2xl px-4 py-3 flex items-center gap-2.5 text-xs sm:text-sm font-bold text-[#2F6F00]">
            <Sparkles className="w-5 h-5 shrink-0 text-[#46A302]" />
            <span>
              تم تجهيز «الحفظ الجديد» و«المراجعة» لهذا اليوم تلقائياً من خطة الغد المسجلة بتاريخ{' '}
              <strong className="tabular-nums">{carriedFromDate}</strong> — يمكنك تعديلها أو حفظها مباشرة.
            </span>
          </div>
        )}

        {feedback && (
          <div
            className={`rounded-2xl px-4 py-3 text-xs sm:text-sm font-bold border-2 flex items-center gap-2 ${
              feedback.type === 'success'
                ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#2F6F00]'
                : 'bg-[#D95338]/10 border-[#D95338] text-[#9A2510]'
            }`}
          >
            {feedback.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0" />}
            <span>{feedback.text}</span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
          <ModernLoader label="جاري تحميل خطة الطالب من المصحف..." />
        </div>
      ) : (
        <div className="space-y-5">
          {/* 1. الحفظ الجديد (اليوم) */}
          <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-[#58CC02]" />
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  الحفظ الجديد (اليوم)
                </h3>
              </div>

              {!todayNew ? (
                <button
                  type="button"
                  onClick={() => setTodayNew(buildDefaultRange())}
                  className="duo-btn-green min-h-[42px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تحديد الحفظ الجديد</span>
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleOpenMushafRange(todayNew, 'today')}
                    className="duo-btn-orange min-h-[42px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <BookOpen className="w-4 h-4" />
                    <span>قراءة في المصحف</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTodayNew(null)}
                    aria-label="إزالة الحفظ الجديد"
                    className="min-h-[42px] px-3 rounded-2xl border-2 border-[#EADBC8] hover:border-[#D95338] text-[#D95338] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>إزالة</span>
                  </button>
                </div>
              )}
            </div>

            {!todayNew ? (
              <p className="text-xs sm:text-sm text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4">
                لا يوجد حفظ جديد محدد لهذا اليوم حتى الآن. اضغط «تحديد الحفظ الجديد» لاختيار السورة والآيات.
              </p>
            ) : (
              <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-extrabold text-[#357A02]">
                  <span>المقطع المحدد: {formatQuranRangeSummary(surahs, todayNew)}</span>
                </div>
                <RangeSelectorRow
                  surahs={surahs}
                  value={todayNew}
                  onChange={(next) =>
                    setTodayNew((prev) => ({ ...(prev || {}), ...next }))
                  }
                />
              </div>
            )}
          </section>

          {/* 2. المراجعة (اليوم) */}
          <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-[#FFA900]" />
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  المراجعة ({toArabicIndicDigits(todayReviews.length)})
                </h3>
              </div>
              <button
                type="button"
                onClick={handleAddTodayReview}
                className="duo-btn-orange min-h-[42px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>أضف مراجعة</span>
              </button>
            </div>

            {todayReviews.length === 0 ? (
              <p className="text-xs sm:text-sm text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4">
                قسم المراجعة فارغ تلقائياً. اضغط «أضف مراجعة» لتحديد نوع المراجعة والسورة والآيات.
              </p>
            ) : (
              <div className="space-y-3">
                {todayReviews.map((rev, idx) => (
                  <div
                    key={rev.id}
                    className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2.5 py-1 rounded-lg bg-[#FFA900]/20 text-[#995C00] font-display font-extrabold text-xs">
                          مراجعة #{toArabicIndicDigits(idx + 1)}
                        </span>
                        <select
                          value={rev.reviewType}
                          onChange={(e) => {
                            const nextType = e.target.value as QuranReviewType;
                            setTodayReviews((prev) =>
                              prev.map((item) =>
                                item.id === rev.id
                                  ? { ...item, reviewType: nextType }
                                  : item
                              )
                            );
                          }}
                          aria-label="نوع المراجعة"
                          className="min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer"
                        >
                          {reviewTypesList.map(([val, lbl]) => (
                            <option key={val} value={val}>
                              {lbl}
                            </option>
                          ))}
                        </select>

                        {rev.reviewType === 'custom' && (
                          <input
                            type="text"
                            value={rev.customLabel || ''}
                            onChange={(e) =>
                              setTodayReviews((prev) =>
                                prev.map((item) =>
                                  item.id === rev.id
                                    ? { ...item, customLabel: e.target.value }
                                    : item
                                )
                              )
                            }
                            placeholder="اكتب اسم المراجعة..."
                            className="min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D]"
                          />
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOpenMushafRange(rev, 'today')}
                          className="duo-btn-orange min-h-[40px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <BookOpen className="w-4 h-4" />
                          <span>قراءة في المصحف</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setTodayReviews((prev) =>
                              prev.filter((item) => item.id !== rev.id)
                            )
                          }
                          aria-label="حذف المراجعة"
                          className="min-h-[40px] px-2.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <p className="text-xs font-bold text-[#7D4E35]">
                      {formatQuranRangeSummary(surahs, rev)}
                    </p>

                    <RangeSelectorRow
                      surahs={surahs}
                      value={rev}
                      onChange={(next) =>
                        setTodayReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id ? { ...item, ...next } : item
                          )
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 3. حفظ الجديد بتاع بكرة (مع تحديد القارئ للطالب) */}
          <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-[#F56900]" />
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  حفظ الجديد بتاع بكرة
                </h3>
              </div>

              {!tomorrowNew ? (
                <button
                  type="button"
                  onClick={() =>
                    setTomorrowNew({
                      ...buildDefaultRange(),
                      reciterId: getSavedTeacherReciterId(),
                    })
                  }
                  className="duo-btn-green min-h-[42px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تحديد حفظ الغد</span>
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleOpenMushafRange(tomorrowNew, 'tomorrow')}
                    className="duo-btn-cream min-h-[42px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Eye className="w-4 h-4 text-[#F56900]" />
                    <span>معاينة في المصحف</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTomorrowNew(null)}
                    aria-label="إزالة حفظ الغد"
                    className="min-h-[42px] px-3 rounded-2xl border-2 border-[#EADBC8] hover:border-[#D95338] text-[#D95338] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>إزالة</span>
                  </button>
                </div>
              )}
            </div>

            {!tomorrowNew ? (
              <p className="text-xs sm:text-sm text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4">
                عند تسجيل حفظ الغد هنا، سينتقل تلقائياً غداً إلى خانة «الحفظ الجديد» للطالب.
              </p>
            ) : (
              <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-[#46A302]">
                    {formatQuranRangeSummary(surahs, tomorrowNew)}
                  </span>

                  <div className="flex items-center gap-2 bg-white border border-[#EADBC8] rounded-xl px-3 py-1.5">
                    <Volume2 className="w-4 h-4 text-[#F56900] shrink-0" />
                    <label
                      htmlFor="tomorrow-student-reciter"
                      className="text-xs font-bold text-[#7D4E35] whitespace-nowrap"
                    >
                      قارئ الطالب في واجهته:
                    </label>
                    <select
                      id="tomorrow-student-reciter"
                      value={tomorrowNew.reciterId || getSavedTeacherReciterId()}
                      onChange={(e) =>
                        setTomorrowNew((prev) =>
                          prev ? { ...prev, reciterId: e.target.value } : null
                        )
                      }
                      className="bg-transparent text-xs sm:text-sm font-bold text-[#4A220D] focus:outline-none cursor-pointer"
                    >
                      {QURAN_RECITERS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <RangeSelectorRow
                  surahs={surahs}
                  value={tomorrowNew}
                  onChange={(next) =>
                    setTomorrowNew((prev) => ({ ...(prev || {}), ...next }))
                  }
                />
              </div>
            )}
          </section>

          {/* 4. مراجعات بكرة */}
          <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-[#FFA900]" />
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  مراجعات بكرة ({toArabicIndicDigits(tomorrowReviews.length)})
                </h3>
              </div>
              <button
                type="button"
                onClick={handleAddTomorrowReview}
                className="duo-btn-orange min-h-[42px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>أضف مراجعة للغد</span>
              </button>
            </div>

            {tomorrowReviews.length === 0 ? (
              <p className="text-xs sm:text-sm text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4">
                أضف مراجعات للغد ليتم ترحيلها تلقائياً إلى قسم مراجعات الطالب في جلسة الغد، مع إمكانية تعديلها أو حذفها في أي وقت.
              </p>
            ) : (
              <div className="space-y-3">
                {tomorrowReviews.map((rev, idx) => (
                  <div
                    key={rev.id}
                    className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2.5 py-1 rounded-lg bg-[#FFA900]/20 text-[#995C00] font-display font-extrabold text-xs">
                          مراجعة غد #{toArabicIndicDigits(idx + 1)}
                        </span>
                        <select
                          value={rev.reviewType}
                          onChange={(e) => {
                            const nextType = e.target.value as QuranReviewType;
                            setTomorrowReviews((prev) =>
                              prev.map((item) =>
                                item.id === rev.id
                                  ? { ...item, reviewType: nextType }
                                  : item
                              )
                            );
                          }}
                          aria-label="نوع مراجعة الغد"
                          className="min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer"
                        >
                          {reviewTypesList.map(([val, lbl]) => (
                            <option key={val} value={val}>
                              {lbl}
                            </option>
                          ))}
                        </select>

                        {rev.reviewType === 'custom' && (
                          <input
                            type="text"
                            value={rev.customLabel || ''}
                            onChange={(e) =>
                              setTomorrowReviews((prev) =>
                                prev.map((item) =>
                                  item.id === rev.id
                                    ? { ...item, customLabel: e.target.value }
                                    : item
                                )
                              )
                            }
                            placeholder="اكتب اسم المراجعة..."
                            className="min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D]"
                          />
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOpenMushafRange(rev, 'tomorrow')}
                          className="duo-btn-cream min-h-[40px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Eye className="w-4 h-4 text-[#F56900]" />
                          <span>معاينة في المصحف</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setTomorrowReviews((prev) =>
                              prev.filter((item) => item.id !== rev.id)
                            )
                          }
                          aria-label="حذف مراجعة الغد"
                          className="min-h-[40px] px-2.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <p className="text-xs font-bold text-[#7D4E35]">
                      {formatQuranRangeSummary(surahs, rev)}
                    </p>

                    <RangeSelectorRow
                      surahs={surahs}
                      value={rev}
                      onChange={(next) =>
                        setTomorrowReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id ? { ...item, ...next } : item
                          )
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Bottom Save CTA */}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={savingPlan || loading}
              onClick={() => void handleSavePlan()}
              className="duo-btn-green min-h-[48px] px-6 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{savingPlan ? 'جاري حفظ الخطة...' : 'حفظ الخطة الكاملة للتاريخ المحدد'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Full King Fahd Mushaf Modal */}
      {mushafLaunch && (
        <KingFahdMushafReader
          studentName={student.quadrupleName}
          initialPage={mushafLaunch.initialPage}
          highlightRanges={mushafLaunch.highlightRanges}
          focusTarget={mushafLaunch.focusTarget}
          mistakes={mistakes}
          onMistakesChange={(next) => void handleMistakesChange(next)}
          onClose={() => setMushafLaunch(null)}
        />
      )}
    </div>
  );
};
