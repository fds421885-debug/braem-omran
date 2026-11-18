import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookMarked,
  BookOpen,
  CalendarDays,
  Check,
  CheckCircle2,
  Edit3,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  deleteCurriculumRecord,
  listBooksInComplex,
  listCurriculaInComplex,
  saveCurriculumRecord,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  QURAN_MUSHAF_BOOK_ID,
  QURAN_MUSHAF_TITLE,
  WEEK_DAYS,
  type BookRecord,
  type CurriculumRecord,
  type WeekDayKey,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';

interface CurriculaSectionProps {
  workspace: ComplexWorkspaceData;
  currentUserId: string;
  restrictMosqueIds?: string[];
}

export const CurriculaSection: React.FC<CurriculaSectionProps> = ({
  workspace,
  currentUserId,
  restrictMosqueIds,
}) => {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [curricula, setCurricula] = useState<CurriculumRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Add / Edit Form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [selectedBookId, setSelectedBookId] = useState<string>(QURAN_MUSHAF_BOOK_ID);
  const [mosqueFilter, setMosqueFilter] = useState<string>('all');
  const [selectedHalaqaIds, setSelectedHalaqaIds] = useState<string[]>([]);
  const [selectedDays, setSelectedDays] = useState<WeekDayKey[]>(['sun', 'tue', 'thu']);
  const [scheduleNote, setScheduleNote] = useState('');

  const [deletingCurriculum, setDeletingCurriculum] = useState<CurriculumRecord | null>(null);

  const allowedMosqueSet = useMemo(() => {
    if (!restrictMosqueIds || restrictMosqueIds.length === 0) return null;
    return new Set(restrictMosqueIds);
  }, [restrictMosqueIds]);

  const visibleMosques = useMemo(
    () =>
      allowedMosqueSet
        ? workspace.mosques.filter((m) => allowedMosqueSet.has(m.id))
        : workspace.mosques,
    [workspace.mosques, allowedMosqueSet]
  );

  const visibleHalaqat = useMemo(
    () =>
      allowedMosqueSet
        ? workspace.halaqat.filter((h) => allowedMosqueSet.has(h.mosqueId))
        : workspace.halaqat,
    [workspace.halaqat, allowedMosqueSet]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [bookList, curList] = await Promise.all([
        listBooksInComplex(workspace),
        listCurriculaInComplex(workspace),
      ]);
      setBooks(bookList);
      setCurricula(curList);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // First book option is ALWAYS المصحف الشريف, followed by uploaded library books
  const bookOptions = useMemo(() => {
    const libraryItems = books.map((b) => ({
      id: b.id,
      title: b.title,
      isQuran: false,
      subtitle: `${b.totalPages} صفحة`,
    }));
    return [
      {
        id: QURAN_MUSHAF_BOOK_ID,
        title: QURAN_MUSHAF_TITLE,
        isQuran: true,
        subtitle: 'القرآن الكريم كاملاً — المقرر الأساسي',
      },
      ...libraryItems,
    ];
  }, [books]);

  const resetForm = () => {
    setEditingId(undefined);
    setSelectedBookId(QURAN_MUSHAF_BOOK_ID);
    setMosqueFilter('all');
    setSelectedHalaqaIds([]);
    setSelectedDays(['sun', 'tue', 'thu']);
    setScheduleNote('');
    setShowForm(false);
  };

  const openEditForm = (cur: CurriculumRecord) => {
    setEditingId(cur.id);
    setSelectedBookId(cur.bookId);
    setSelectedHalaqaIds(cur.halaqaIds);
    setSelectedDays(cur.days);
    setScheduleNote(cur.scheduleNote || '');
    setMosqueFilter('all');
    setShowForm(true);
  };

  const toggleHalaqa = (halaqaId: string) => {
    setSelectedHalaqaIds((prev) =>
      prev.includes(halaqaId) ? prev.filter((id) => id !== halaqaId) : [...prev, halaqaId]
    );
  };

  const toggleMosqueHalaqat = (mosqueId: string) => {
    const mHalaqaIds = visibleHalaqat.filter((h) => h.mosqueId === mosqueId).map((h) => h.id);
    const allSelected = mHalaqaIds.length > 0 && mHalaqaIds.every((id) => selectedHalaqaIds.includes(id));
    if (allSelected) {
      setSelectedHalaqaIds((prev) => prev.filter((id) => !mHalaqaIds.includes(id)));
    } else {
      setSelectedHalaqaIds((prev) => Array.from(new Set([...prev, ...mHalaqaIds])));
    }
  };

  const toggleDay = (day: WeekDayKey) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const handleSaveCurriculum = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const chosenBook = bookOptions.find((b) => b.id === selectedBookId);
    if (!chosenBook) {
      setFeedback({ type: 'err', text: 'يرجى اختيار الكتاب أو المصحف الشريف.' });
      return;
    }

    const derivedMosqueIds = Array.from(
      new Set(
        selectedHalaqaIds
          .map((hId) => visibleHalaqat.find((h) => h.id === hId)?.mosqueId || '')
          .filter(Boolean)
      )
    );

    setSaving(true);
    try {
      await saveCurriculumRecord({
        workspace,
        id: editingId,
        bookId: chosenBook.id,
        bookTitle: chosenBook.title,
        halaqaIds: selectedHalaqaIds,
        mosqueIds: derivedMosqueIds,
        days: selectedDays,
        scheduleNote,
        createdBy: currentUserId,
      });
      resetForm();
      await loadData();
      setFeedback({
        type: 'ok',
        text: editingId
          ? `تم تحديث مقرر "${chosenBook.title}" بنجاح.`
          : `تمت إضافة مقرر "${chosenBook.title}" وتوزيعه على الحلقات المختارة بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حفظ المقرر.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingCurriculum) return;
    try {
      await deleteCurriculumRecord(workspace, deletingCurriculum.id);
      setDeletingCurriculum(null);
      await loadData();
      setFeedback({ type: 'ok', text: 'تم حذف المقرر بنجاح.' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حذف المقرر.',
      });
    }
  };

  const filteredMosquesForPicker = useMemo(
    () =>
      mosqueFilter === 'all'
        ? visibleMosques
        : visibleMosques.filter((m) => m.id === mosqueFilter),
    [visibleMosques, mosqueFilter]
  );

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BookMarked className="w-6 h-6 text-[#F56900]" />
          <div>
            <h2 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
              قسم المقررات الدراسية
            </h2>
            <p className="text-xs sm:text-sm text-[#7D4E35]">
              إسناد المصحف الشريف أو كتب المكتبة للحلقات عبر مسجد واحد أو عدة مساجد وتحديد أيام دراستها في الأسبوع.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            if (showForm) {
              resetForm();
            } else {
              setEditingId(undefined);
              setShowForm(true);
            }
          }}
          className="duo-btn-orange min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          <span>{showForm ? 'إغلاق النموذج' : 'إضافة مقرر جديد'}</span>
        </button>
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

      {/* Add / Edit Curriculum Form */}
      {showForm && (
        <form
          onSubmit={handleSaveCurriculum}
          className="bg-white border-2 border-[#F56900] rounded-3xl p-5 sm:p-6 space-y-5"
        >
          <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
            {editingId ? 'تعديل المقرر وأيامه' : 'إضافة مقرر جديد للحلقات'}
          </h3>

          {/* Step 1: Select Book (Mushaf First + Uploaded Library Books) */}
          <div className="space-y-2.5">
            <label className="block font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
              ١. اختر الكتاب المقرر (يظهر المصحف الشريف أولاً يليه كتب المكتبة):
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {bookOptions.map((opt) => {
                const isSelected = selectedBookId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSelectedBookId(opt.id)}
                    className={`text-right rounded-2xl border-2 p-3.5 transition-colors cursor-pointer flex items-start gap-2.5 ${
                      isSelected
                        ? 'bg-[#F56900]/10 border-[#F56900]'
                        : 'bg-[#FDF6EE] border-[#EADBC8] hover:border-[#F56900]/60'
                    }`}
                  >
                    <BookOpen
                      className={`w-5 h-5 shrink-0 mt-0.5 ${
                        isSelected ? 'text-[#F56900]' : 'text-[#7D4E35]'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-display font-extrabold text-sm text-[#4A220D] truncate">
                        {opt.title}
                      </p>
                      <p className="text-[11px] font-bold text-[#7D4E35] truncate">
                        {opt.subtitle}
                      </p>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-[#F56900] shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Step 2: Select Halaqat Across Any Mosque(s) */}
          <div className="space-y-3 pt-2 border-t-2 border-[#F7EBDD]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                ٢. اختر الحلقات المكلّفة بهذا المقرر (من مسجد واحد أو عدة مساجد معاً):
              </label>
              <select
                value={mosqueFilter}
                onChange={(e) => setMosqueFilter(e.target.value)}
                className="min-h-[38px] px-3 py-1 rounded-xl border-2 border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
              >
                <option value="all">عرض كل المساجد ({visibleMosques.length})</option>
                {visibleMosques.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            {visibleMosques.length === 0 ? (
              <p className="text-xs text-[#7D4E35]">لا توجد مساجد أو حلقات في النطاق الحالي.</p>
            ) : (
              <div className="space-y-3">
                {filteredMosquesForPicker.map((mosque) => {
                  const mHalaqat = visibleHalaqat.filter((h) => h.mosqueId === mosque.id);
                  if (mHalaqat.length === 0) return null;
                  const selectedInMosque = mHalaqat.filter((h) =>
                    selectedHalaqaIds.includes(h.id)
                  ).length;

                  return (
                    <div
                      key={mosque.id}
                      className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display font-extrabold text-xs sm:text-sm text-[#4A220D]">
                          {mosque.name} ({selectedInMosque}/{mHalaqat.length})
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleMosqueHalaqat(mosque.id)}
                          className="text-xs font-extrabold text-[#F56900] hover:underline cursor-pointer"
                        >
                          {selectedInMosque === mHalaqat.length
                            ? 'إلغاء تحديد الكل'
                            : 'تحديد جميع حلقات المسجد'}
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {mHalaqat.map((h) => {
                          const active = selectedHalaqaIds.includes(h.id);
                          return (
                            <button
                              key={h.id}
                              type="button"
                              onClick={() => toggleHalaqa(h.id)}
                              className={`min-h-[38px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer inline-flex items-center gap-1.5 ${
                                active
                                  ? 'bg-[#F56900] border-[#C95200] text-white'
                                  : 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                              }`}
                            >
                              {active && <Check className="w-3.5 h-3.5" />}
                              <span>{h.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 3: Weekly Schedule Days */}
          <div className="space-y-2.5 pt-2 border-t-2 border-[#F7EBDD]">
            <label className="block font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
              ٣. حدّد أيام دراسة هذا الكتاب في الأسبوع (من متى لمتى):
            </label>
            <div className="flex flex-wrap gap-2">
              {WEEK_DAYS.map((day) => {
                const active = selectedDays.includes(day.key);
                return (
                  <button
                    key={day.key}
                    type="button"
                    onClick={() => toggleDay(day.key)}
                    className={`min-h-[42px] px-4 py-1.5 rounded-xl border-2 font-display text-xs sm:text-sm font-bold cursor-pointer inline-flex items-center gap-1.5 ${
                      active
                        ? 'bg-[#58CC02] border-[#46A302] text-white'
                        : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                    }`}
                  >
                    {active && <Check className="w-3.5 h-3.5" />}
                    <span>{day.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block font-display text-xs font-bold text-[#7D4E35] mb-1">
              ملاحظة أو مقدار الحصة (اختياري)
            </label>
            <input
              type="text"
              value={scheduleNote}
              onChange={(e) => setScheduleNote(e.target.value)}
              placeholder="مثال: وجهان يومياً أو من صفحة ١٠ إلى ٢٠"
              maxLength={240}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm text-[#4A220D] focus:outline-none focus:border-[#F56900]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="duo-btn-orange min-h-[46px] px-7 py-2 rounded-2xl font-display font-extrabold text-sm cursor-pointer disabled:opacity-60"
            >
              {saving ? 'جاري الحفظ...' : editingId ? 'حفظ التعديلات' : 'أضف المقرر'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="duo-btn-cream min-h-[46px] px-5 py-2 rounded-2xl font-display font-bold text-sm cursor-pointer"
            >
              إلغاء
            </button>
          </div>
        </form>
      )}

      {/* Curricula List */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
          المقررات المعتمدة حالياً ({curricula.length})
        </h3>

        {loading ? (
          <ModernLoader label="جاري تحميل المقررات..." />
        ) : curricula.length === 0 ? (
          <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center space-y-2">
            <p className="text-sm font-bold text-[#7D4E35]">
              لم تتم إضافة أي مقررات بعد. اضغط «إضافة مقرر جديد» لإسناد المصحف الشريف أو الكتب للحلقات.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {curricula.map((cur) => {
              const halaqaLabels = cur.halaqaIds.map((hId) => {
                const h = workspace.halaqat.find((item) => item.id === hId);
                if (!h) return '';
                const mName = workspace.mosques.find((m) => m.id === h.mosqueId)?.name || '';
                return mName ? `${h.name} (${mName})` : h.name;
              }).filter(Boolean);

              const dayLabels = WEEK_DAYS.filter((d) => cur.days.includes(d.key)).map((d) => d.label);

              return (
                <div
                  key={cur.id}
                  className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3 flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <BookOpen className="w-5 h-5 text-[#F56900] shrink-0" />
                        <h4 className="font-display font-extrabold text-base text-[#4A220D] truncate">
                          {cur.bookTitle}
                        </h4>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openEditForm(cur)}
                          aria-label="تعديل المقرر"
                          className="p-2 rounded-xl bg-white border border-[#EADBC8] text-[#7D4E35] hover:text-[#F56900] cursor-pointer"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingCurriculum(cur)}
                          aria-label="حذف المقرر"
                          className="p-2 rounded-xl bg-white border border-[#EADBC8] text-[#D95338] hover:bg-[#D95338]/10 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
                      <CalendarDays className="w-4 h-4 text-[#46A302] shrink-0" />
                      {dayLabels.map((lbl) => (
                        <span
                          key={lbl}
                          className="px-2.5 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#46A302]"
                        >
                          {lbl}
                        </span>
                      ))}
                    </div>

                    <div className="text-xs text-[#7D4E35] leading-relaxed">
                      <span className="font-bold text-[#4A220D]">الحلقات ({halaqaLabels.length}): </span>
                      <span>{halaqaLabels.join('، ') || 'غير محدد'}</span>
                    </div>

                    {cur.scheduleNote && (
                      <p className="text-xs font-medium text-[#7D4E35] bg-white border border-[#EADBC8] rounded-xl px-3 py-1.5">
                        {cur.scheduleNote}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deletingCurriculum && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4 shadow-xl">
            <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
              حذف مقرر «{deletingCurriculum.bookTitle}»؟
            </h3>
            <p className="text-sm text-[#7D4E35]">
              سيتم إلغاء ارتباط هذا المقرر بالحلقات المحددة له ولن يظهر في جدولها.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="flex-1 min-h-[44px] rounded-2xl bg-[#D95338] text-white font-display font-bold text-sm cursor-pointer"
              >
                تأكيد الحذف
              </button>
              <button
                type="button"
                onClick={() => setDeletingCurriculum(null)}
                className="duo-btn-cream flex-1 min-h-[44px] rounded-2xl font-display font-bold text-sm cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
