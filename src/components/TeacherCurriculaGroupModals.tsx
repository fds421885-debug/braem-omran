import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BookMarked,
  BookOpen,
  Calendar,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  Forward,
  Plus,
  Save,
  Trash2,
  Users,
  Volume2,
  X,
  XCircle,
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
  batchApplyBookWhereReachedForStudents,
  batchAssignTomorrowBookHomeworkForStudents,
  batchAssignTomorrowQuranPlanForStudents,
  loadHalaqaTodayBookPlans,
  loadHalaqaTodayQuranPlans,
  saveBatchBookCorrectionOutcomes,
  saveBatchQuranTasmeeOutcomes,
  type ComplexWorkspaceData,
  type HalaqaStudentCurriculaStatus,
  type HalaqaStudentTodayBookPlanEntry,
  type HalaqaStudentTodayQuranPlanEntry,
} from '../services/platformService';
import {
  BOOK_HOMEWORK_TYPE_LABELS,
  QURAN_RECITERS,
  QURAN_REVIEW_TYPE_LABELS,
  type AccountRecord,
  type BookHomeworkStatus,
  type BookHomeworkType,
  type CurriculumRecord,
  type QuranRangeRef,
  type QuranReviewType,
  type StudentBookHomeworkItem,
  type StudentQuranNewHifzItem,
  type StudentQuranReviewItem,
  type TeacherRoleContext,
} from '../types/platform';
import { KingFahdMushafReader } from './KingFahdMushafReader';
import { ModernLoader } from './ModernLoader';
import { TeacherBookReaderModal } from './TeacherBookReaderModal';

interface StudentChecklistDropdownProps {
  students: AccountRecord[];
  selectedIds: string[];
  onChange: (nextIds: string[]) => void;
  title?: string;
  renderBadge?: (studentId: string) => React.ReactNode;
}

export const StudentChecklistDropdown: React.FC<StudentChecklistDropdownProps> = ({
  students,
  selectedIds,
  onChange,
  title = 'الطلاب المشمولون بالتعيين',
  renderBadge,
}) => {
  const [open, setOpen] = useState(false);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = students.length > 0 && selectedIds.length === students.length;

  const toggleStudent = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((s) => s !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-extrabold text-[#4A220D] flex items-center gap-1.5">
          <Users className="w-4 h-4 text-[#F56900]" />
          <span>{title}</span>
        </span>
        <span className="text-[11px] font-bold text-[#7D4E35]">
          {allSelected
            ? 'جميع الطلاب محددون تلقائياً — افتح القائمة لاستثناء أي طالب'
            : `تم تحديد ${toArabicIndicDigits(selectedIds.length)} من ${toArabicIndicDigits(students.length)}`}
        </span>
      </div>

      {/* Dropdown Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] hover:border-[#F56900] bg-white flex items-center justify-between gap-2 text-right cursor-pointer transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-6 h-6 rounded-lg inline-flex items-center justify-center text-white text-xs font-bold shrink-0 ${
              selectedIds.length > 0 ? 'bg-[#58CC02]' : 'bg-[#D95338]'
            }`}
          >
            {selectedIds.length > 0 ? <Check className="w-3.5 h-3.5" /> : '٠'}
          </span>
          <span className="font-display font-extrabold text-xs sm:text-sm text-[#4A220D] truncate">
            {allSelected
              ? `جميع طلاب الحلقة (${toArabicIndicDigits(students.length)} طالب) ✓`
              : selectedIds.length === 0
              ? 'لم يتم تحديد أي طالب'
              : `محدد ${toArabicIndicDigits(selectedIds.length)} من أصل ${toArabicIndicDigits(students.length)} طالب`}
          </span>
        </div>

        <span className="inline-flex items-center gap-1 text-xs font-bold text-[#F56900] shrink-0">
          <span>{open ? 'إغلاق القائمة' : 'تعديل الاختيار'}</span>
          <ChevronDown
            className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {/* Dropdown Student Checklist */}
      {open && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-xl p-2.5 space-y-2 shadow-xs">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#F7EBDD]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChange(students.map((s) => s.id))}
                className="min-h-[32px] px-2.5 rounded-lg bg-[#58CC02]/15 text-[#46A302] hover:bg-[#58CC02]/25 font-display font-bold text-xs cursor-pointer"
              >
                تحديد الكل ✓
              </button>
              <button
                type="button"
                onClick={() => onChange([])}
                className="min-h-[32px] px-2.5 rounded-lg bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35] hover:border-[#D95338] hover:text-[#D95338] font-display font-bold text-xs cursor-pointer"
              >
                إلغاء الكل
              </button>
            </div>
            <span className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
              {toArabicIndicDigits(selectedIds.length)} / {toArabicIndicDigits(students.length)}
            </span>
          </div>

          <div className="max-h-56 overflow-y-auto space-y-1.5 pl-1">
            {students.map((st, idx) => {
              const checked = selectedSet.has(st.id);
              return (
                <label
                  key={st.id}
                  className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                    checked
                      ? 'bg-[#58CC02]/8 border-[#58CC02]/50'
                      : 'bg-[#FDF6EE]/50 border-[#EADBC8] hover:border-[#F56900]/50'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStudent(st.id)}
                      className="w-4 h-4 accent-[#58CC02] rounded shrink-0 cursor-pointer"
                    />
                    <span className="w-6 h-6 rounded-lg bg-white border border-[#EADBC8] font-display font-extrabold text-[11px] text-[#7D4E35] inline-flex items-center justify-center shrink-0 tabular-nums">
                      {toArabicIndicDigits(idx + 1)}
                    </span>
                    <span className="font-display font-bold text-xs sm:text-sm text-[#4A220D] truncate">
                      {st.quadrupleName}
                    </span>
                  </div>
                  {renderBadge && <div className="shrink-0">{renderBadge(st.id)}</div>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 1. Book Reached-Page Propagation Prompt Modal
 * ============================================================================ */

interface BookReachedPropagationModalProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  curriculum: CurriculumRecord;
  stoppedPage: number;
  students: AccountRecord[];
  currentUserId: string;
  currentUserName: string;
  onSuccess: (summaryMessage: string) => void;
  onClose: () => void;
}

export const BookReachedPropagationModal: React.FC<BookReachedPropagationModalProps> = ({
  workspace,
  context,
  curriculum,
  stoppedPage,
  students,
  currentUserId,
  currentUserName,
  onSuccess,
  onClose,
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>(() => students.map((s) => s.id));
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSaveForStudents = async () => {
    if (selectedIds.length === 0) {
      onSuccess(`تم حفظ توقف المعلم عند صفحة ${toArabicIndicDigits(stoppedPage)} دون تعديل الطلاب.`);
      onClose();
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      const targetStudents = students.filter((s) => selectedIds.includes(s.id));
      const res = await batchApplyBookWhereReachedForStudents({
        workspace,
        mosqueId: context.mosqueId,
        halaqaId: context.halaqaId,
        students: targetStudents,
        bookId: curriculum.bookId,
        bookTitle: curriculum.bookTitle,
        dateKey: getTodayDateKey(),
        pageNumber: stoppedPage,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });
      if (res.failedCount > 0 && res.savedCount === 0) {
        setErrorMsg('تعذّر حفظ موضع الوصول للطلاب في قاعدة البيانات.');
        return;
      }
      onSuccess(
        `تم حفظ موضع الوصول (صفحة ${toArabicIndicDigits(stoppedPage)}) للمعلم وعدد ${toArabicIndicDigits(res.savedCount)} طالب.`
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذّر حفظ موضع الوصول.');
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="حفظ الوصول للطلاب"
      className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl max-w-lg w-full p-4 sm:p-6 space-y-4 shadow-2xl max-h-[90dvh] pb-safe overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-11 h-11 rounded-2xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
              <BookOpen className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                هل تريد حفظ هذا الوصول للطلاب أيضاً؟
              </h3>
              <p className="text-xs font-bold text-[#7D4E35]">
                كتاب «{curriculum.bookTitle}» · الصفحة التي وصلت إليها:{' '}
                <strong className="text-[#F56900]">
                  صفحة {toArabicIndicDigits(stoppedPage)}
                </strong>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="w-9 h-9 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] text-[#4A220D] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <StudentChecklistDropdown
          students={students}
          selectedIds={selectedIds}
          onChange={setSelectedIds}
          title="الطلاب الذين سيُضبط عندهم «أين وصلنا» إلى هذه الصفحة"
        />

        {errorMsg && (
          <p className="text-xs font-bold text-[#D95338] bg-[#D95338]/10 border border-[#D95338]/30 rounded-xl px-3 py-2">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSaveForStudents()}
            className="duo-btn-green flex-1 min-h-[46px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {saving
                ? 'جاري الحفظ للطلاب...'
                : selectedIds.length > 0
                ? `حفظ للمعلم والطلاب المحددين (${toArabicIndicDigits(selectedIds.length)})`
                : 'حفظ للمعلم فقط'}
            </span>
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="duo-btn-cream min-h-[46px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm cursor-pointer disabled:opacity-50"
          >
            للمعلم فقط
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

/* ============================================================================
 * 2. Collective Book Tomorrow Homework Assignment Modal
 * ============================================================================ */

const HOMEWORK_TYPE_ORDER: BookHomeworkType[] = [
  'reading',
  'writing',
  'exercise',
  'page_solve',
  'other',
];

interface DraftBookHomework {
  localId: string;
  type: BookHomeworkType;
  customTypeLabel: string;
  pageNumber: number;
  note: string;
}

interface GroupBookHomeworkModalProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  curriculum: CurriculumRecord;
  totalPagesHint: number;
  defaultPage: number;
  students: AccountRecord[];
  statuses: Record<string, HalaqaStudentCurriculaStatus>;
  currentUserId: string;
  currentUserName: string;
  onSuccess: (summaryMessage: string) => void;
  onClose: () => void;
}

export const GroupBookHomeworkModal: React.FC<GroupBookHomeworkModalProps> = ({
  workspace,
  context,
  curriculum,
  totalPagesHint,
  defaultPage,
  students,
  statuses,
  currentUserId,
  currentUserName,
  onSuccess,
  onClose,
}) => {
  const [drafts, setDrafts] = useState<DraftBookHomework[]>([
    {
      localId: generateValidId('hw_draft'),
      type: 'reading',
      customTypeLabel: '',
      pageNumber: Math.max(1, defaultPage),
      note: '',
    },
  ]);
  const [pickingForDraftId, setPickingForDraftId] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => students.map((s) => s.id));
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleAddDraft = () => {
    const lastPage = drafts[drafts.length - 1]?.pageNumber || defaultPage || 1;
    setDrafts((prev) => [
      ...prev,
      {
        localId: generateValidId('hw_draft'),
        type: 'exercise',
        customTypeLabel: '',
        pageNumber: lastPage,
        note: '',
      },
    ]);
  };

  const handleSave = async () => {
    if (selectedIds.length === 0) {
      setErrorMsg('اختر طالباً واحداً على الأقل لتعيين الواجب.');
      return;
    }
    const invalidCustom = drafts.find((d) => d.type === 'other' && !d.customTypeLabel.trim());
    if (invalidCustom) {
      setErrorMsg('يرجى كتابة اسم نوع الواجب عند اختيار «أخرى».');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const targetStudents = students.filter((s) => selectedIds.includes(s.id));
      const payloadHomeworks: Omit<StudentBookHomeworkItem, 'id' | 'status'>[] = drafts.map(
        (d) => ({
          type: d.type,
          ...(d.type === 'other' ? { customTypeLabel: d.customTypeLabel.trim() } : {}),
          pageNumber: Math.max(1, Math.min(2000, Math.floor(Number(d.pageNumber) || 1))),
          ...(d.note.trim() ? { note: d.note.trim() } : {}),
        })
      );

      const res = await batchAssignTomorrowBookHomeworkForStudents({
        workspace,
        mosqueId: context.mosqueId,
        halaqaId: context.halaqaId,
        students: targetStudents,
        bookId: curriculum.bookId,
        bookTitle: curriculum.bookTitle,
        dateKey: getTodayDateKey(),
        homeworks: payloadHomeworks,
        replaceExisting,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });

      if (res.failedCount > 0 && res.savedCount === 0) {
        setErrorMsg('تعذّر حفظ واجب الغد للطلاب في قاعدة البيانات.');
        return;
      }
      onSuccess(
        `تم تعيين واجب غد لكتاب «${curriculum.bookTitle}» لعدد ${toArabicIndicDigits(res.savedCount)} طالب بنجاح.`
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذّر حفظ واجب الغد جماعياً.');
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  const pickingDraft = drafts.find((d) => d.localId === pickingForDraftId) || null;

  return createPortal(
    <div
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label={`تعيين واجب غد جماعياً - ${curriculum.bookTitle}`}
      className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl max-w-2xl w-full p-5 sm:p-6 space-y-4 shadow-2xl max-h-[92dvh] pb-safe overflow-y-auto">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-[#F7EBDD]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
              <BookMarked className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] truncate">
                تعيين واجب غد جماعياً — {curriculum.bookTitle}
              </h3>
              <p className="text-xs text-[#7D4E35]">
                اختر نوع الواجب والصفحة ثم عيّنه لجميع طلاب الحلقة أو من تحددهم
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="w-9 h-9 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] text-[#4A220D] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Homework Items Composer */}
        <div className="space-y-3">
          {drafts.map((draft, idx) => (
            <div
              key={draft.localId}
              className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-display font-extrabold text-xs text-[#F56900]">
                  واجب #{toArabicIndicDigits(idx + 1)}
                </span>
                {drafts.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setDrafts((prev) => prev.filter((item) => item.localId !== draft.localId))
                    }
                    className="text-xs font-bold text-[#D95338] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-[#7D4E35]">نوع الواجب:</label>
                  <select
                    value={draft.type}
                    onChange={(e) => {
                      const val = e.target.value as BookHomeworkType;
                      setDrafts((prev) =>
                        prev.map((d) =>
                          d.localId === draft.localId ? { ...d, type: val } : d
                        )
                      );
                    }}
                    className="w-full min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer"
                  >
                    {HOMEWORK_TYPE_ORDER.map((t) => (
                      <option key={t} value={t}>
                        {BOOK_HOMEWORK_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-[#7D4E35]">صفحة الواجب:</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      value={draft.pageNumber}
                      onChange={(e) => {
                        const page = Math.max(
                          1,
                          Math.min(2000, Math.floor(Number(e.target.value) || 1))
                        );
                        setDrafts((prev) =>
                          prev.map((d) =>
                            d.localId === draft.localId ? { ...d, pageNumber: page } : d
                          )
                        );
                      }}
                      className="w-24 min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-center font-display font-extrabold text-sm tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => setPickingForDraftId(draft.localId)}
                      className="flex-1 min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-extrabold text-[#4A220D] inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <BookOpen className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span>اختر من الكتاب</span>
                    </button>
                  </div>
                </div>
              </div>

              {draft.type === 'other' && (
                <div className="space-y-1">
                  <label className="text-xs font-bold text-[#7D4E35]">توضيح نوع الواجب:</label>
                  <input
                    type="text"
                    value={draft.customTypeLabel}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDrafts((prev) =>
                        prev.map((d) =>
                          d.localId === draft.localId ? { ...d, customTypeLabel: val } : d
                        )
                      );
                    }}
                    placeholder="مثلاً: حفظ حديث، تلخيص درس..."
                    className="w-full min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D]"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs font-bold text-[#7D4E35]">
                  ملاحظة للمعلم أو الطالب (اختياري):
                </label>
                <input
                  type="text"
                  value={draft.note}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDrafts((prev) =>
                      prev.map((d) =>
                        d.localId === draft.localId ? { ...d, note: val } : d
                      )
                    );
                  }}
                  placeholder="مثلاً: حل التمرين الأول والثاني فقط..."
                  className="w-full min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm font-bold text-[#4A220D]"
                />
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={handleAddDraft}
              className="duo-btn-cream min-h-[38px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-[#F56900]" />
              <span>أضف واجباً آخر للغد</span>
            </button>

            <label className="inline-flex items-center gap-1.5 text-xs font-bold text-[#7D4E35] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="w-4 h-4 accent-[#F56900] rounded cursor-pointer"
              />
              <span>استبدال أي واجبات غد مسجلة مسبقاً لهؤلاء الطلاب</span>
            </label>
          </div>
        </div>

        {/* All-Checked Student Dropdown Checklist */}
        <StudentChecklistDropdown
          students={students}
          selectedIds={selectedIds}
          onChange={setSelectedIds}
          title="الطلاب المشمولون بتعيين واجب الغد"
          renderBadge={(sid) => {
            const assigned = statuses[sid]?.books?.[curriculum.bookId]?.tomorrowHomeworkAssigned;
            return (
              <span
                className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold border ${
                  assigned
                    ? 'bg-[#58CC02]/15 border-[#58CC02]/60 text-[#46A302]'
                    : 'bg-[#FDF6EE] border-[#EADBC8] text-[#7D4E35]'
                }`}
              >
                {assigned ? 'تم تعيين الواجب' : 'لم يُعيّن بعد'}
              </span>
            );
          }}
        />

        {errorMsg && (
          <p className="text-xs font-bold text-[#D95338] bg-[#D95338]/10 border border-[#D95338]/30 rounded-xl px-3 py-2">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-[#F7EBDD]">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="duo-btn-cream min-h-[44px] px-5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm cursor-pointer disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="duo-btn-green min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>
              {saving
                ? 'جاري التعيين للطلاب...'
                : `اعتماد واجب الغد (${toArabicIndicDigits(selectedIds.length)} طالب)`}
            </span>
          </button>
        </div>
      </div>

      {pickingDraft && (
        <TeacherBookReaderModal
          workspace={workspace}
          bookId={curriculum.bookId}
          bookTitle={curriculum.bookTitle}
          studentName="تعيين جماعي"
          totalPagesHint={totalPagesHint}
          initialPage={pickingDraft.pageNumber}
          mode="pick_page"
          currentUserId={currentUserId}
          onPickPage={(pickedPage) => {
            setDrafts((prev) =>
              prev.map((d) =>
                d.localId === pickingDraft.localId ? { ...d, pageNumber: pickedPage } : d
              )
            );
          }}
          onClose={() => setPickingForDraftId(null)}
        />
      )}
    </div>,
    document.body
  );
};

/* ============================================================================
 * 3. Collective Quran Tomorrow Hifz & Reviews Assignment Modal
 * ============================================================================ */

const DEFAULT_QURAN_RANGE: QuranRangeRef = {
  startSurah: 1,
  startAyah: 1,
  endSurah: 1,
  endAyah: 7,
};

interface DraftQuranReview extends StudentQuranReviewItem {}

interface GroupQuranPlanModalProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  students: AccountRecord[];
  statuses: Record<string, HalaqaStudentCurriculaStatus>;
  currentUserId: string;
  currentUserName: string;
  onSuccess: (summaryMessage: string) => void;
  onClose: () => void;
}

export const GroupQuranPlanModal: React.FC<GroupQuranPlanModalProps> = ({
  workspace,
  context,
  students,
  statuses,
  currentUserId,
  currentUserName,
  onSuccess,
  onClose,
}) => {
  const [surahs, setSurahs] = useState<MushafSurahMeta[]>([]);
  const [includeNewHifz, setIncludeNewHifz] = useState(true);
  const [tomorrowNew, setTomorrowNew] = useState<StudentQuranNewHifzItem>(() => ({
    ...DEFAULT_QURAN_RANGE,
    reciterId: getSavedTeacherReciterId(),
    completed: false,
  }));
  const [tomorrowReviews, setTomorrowReviews] = useState<DraftQuranReview[]>([]);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => students.map((s) => s.id));
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [previewLaunch, setPreviewLaunch] = useState<{
    page: number;
    range: QuranRangeRef;
    kind: 'new_hifz' | 'review';
    label: string;
  } | null>(null);

  useEffect(() => {
    void getSurahsList()
      .then((list) => setSurahs(list))
      .catch(() => {});
  }, []);

  const startSurahMeta = useMemo(
    () => surahs.find((s) => s.n === tomorrowNew.startSurah) || surahs[0],
    [surahs, tomorrowNew.startSurah]
  );
  const endSurahMeta = useMemo(
    () => surahs.find((s) => s.n === tomorrowNew.endSurah) || surahs[0],
    [surahs, tomorrowNew.endSurah]
  );

  const reviewTypesList = Object.entries(QURAN_REVIEW_TYPE_LABELS) as [
    QuranReviewType,
    string,
  ][];

  const handleOpenPreview = async (
    range: QuranRangeRef,
    kind: 'new_hifz' | 'review',
    label: string
  ) => {
    const page = await getPageForAyah(range.startSurah, range.startAyah).catch(() => 1);
    setPreviewLaunch({ page, range, kind, label });
  };

  const handleSave = async () => {
    if (selectedIds.length === 0) {
      setErrorMsg('اختر طالباً واحداً على الأقل.');
      return;
    }
    if (!includeNewHifz && tomorrowReviews.length === 0) {
      setErrorMsg('فعّل الحفظ الجديد للغد أو أضف مراجعة للغد على الأقل.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const targetStudents = students.filter((s) => selectedIds.includes(s.id));
      const cleanReviews: Omit<StudentQuranReviewItem, 'id' | 'completed'>[] =
        tomorrowReviews.map(({ id: _id, completed: _comp, ...rest }) => rest);

      const res = await batchAssignTomorrowQuranPlanForStudents({
        workspace,
        mosqueId: context.mosqueId,
        halaqaId: context.halaqaId,
        students: targetStudents,
        dateKey: getTodayDateKey(),
        tomorrowNew: includeNewHifz ? tomorrowNew : null,
        tomorrowReviews: cleanReviews,
        replaceExisting,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });

      if (res.failedCount > 0 && res.savedCount === 0) {
        setErrorMsg('تعذّر حفظ خطة الغد للطلاب في قاعدة البيانات.');
        return;
      }

      onSuccess(
        `تم تعيين حفظ ومراجعة الغد جماعياً لعدد ${toArabicIndicDigits(res.savedCount)} طالب بنجاح.`
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذّر حفظ خطة الغد جماعياً.');
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="تعيين حفظ الغد في القرآن جماعياً"
      className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl max-w-3xl w-full p-5 sm:p-6 space-y-4 shadow-2xl max-h-[92dvh] pb-safe overflow-y-auto">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-[#F7EBDD]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
              <CalendarDays className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                تعيين حفظ ومراجعة الغد جماعياً (القرآن الكريم)
              </h3>
              <p className="text-xs text-[#7D4E35]">
                يظهر المقطع المحدد تلقائياً في «الحفظ الجديد» والمراجعة في جلسة الغد للطلاب المحددين
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="w-9 h-9 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] text-[#4A220D] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tomorrow New Hifz Section */}
        <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeNewHifz}
                onChange={(e) => setIncludeNewHifz(e.target.checked)}
                className="w-4 h-4 accent-[#58CC02] rounded cursor-pointer"
              />
              <span className="font-display font-extrabold text-sm text-[#4A220D]">
                الحفظ الجديد للغد
              </span>
            </label>

            {includeNewHifz && (
              <button
                type="button"
                onClick={() =>
                  void handleOpenPreview(tomorrowNew, 'new_hifz', 'حفظ الجديد للغد')
                }
                className="duo-btn-cream min-h-[36px] px-3 py-1 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5 text-[#F56900]" />
                <span>معاينة في المصحف</span>
              </button>
            )}
          </div>

          {includeNewHifz && surahs.length > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-extrabold text-[#46A302]">
                  {formatQuranRangeSummary(surahs, tomorrowNew)}
                </span>

                <div className="flex items-center gap-2 bg-white border border-[#EADBC8] rounded-xl px-2.5 py-1">
                  <Volume2 className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
                  <select
                    value={tomorrowNew.reciterId || getSavedTeacherReciterId()}
                    onChange={(e) =>
                      setTomorrowNew((prev) => ({ ...prev, reciterId: e.target.value }))
                    }
                    aria-label="الشيخ القارئ للاستماع"
                    className="bg-transparent text-xs font-bold text-[#4A220D] focus:outline-none cursor-pointer"
                  >
                    {QURAN_RECITERS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-white border border-[#EADBC8] rounded-xl p-3 space-y-2">
                  <p className="text-[11px] font-extrabold text-[#7D4E35]">موضع البداية (من)</p>
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={tomorrowNew.startSurah}
                      onChange={(e) => {
                        const sNum = Number(e.target.value);
                        const sMeta = surahs.find((s) => s.n === sNum);
                        const maxAyah = sMeta?.count || 7;
                        const clampedStart = Math.min(tomorrowNew.startAyah, maxAyah);
                        const nextEndSurah =
                          sNum > tomorrowNew.endSurah ? sNum : tomorrowNew.endSurah;
                        const eMeta = surahs.find((s) => s.n === nextEndSurah);
                        const nextEndAyah =
                          sNum > tomorrowNew.endSurah
                            ? Math.min(maxAyah, clampedStart + 5)
                            : Math.min(tomorrowNew.endAyah, eMeta?.count || 7);
                        setTomorrowNew((prev) => ({
                          ...prev,
                          startSurah: sNum,
                          startAyah: clampedStart,
                          endSurah: nextEndSurah,
                          endAyah: nextEndAyah,
                        }));
                      }}
                      className="col-span-2 min-h-[40px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D]"
                    >
                      {surahs.map((s) => (
                        <option key={s.n} value={s.n}>
                          {toArabicIndicDigits(s.n)}. {s.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={tomorrowNew.startAyah}
                      onChange={(e) =>
                        setTomorrowNew((prev) => ({
                          ...prev,
                          startAyah: Number(e.target.value),
                        }))
                      }
                      className="col-span-1 min-h-[40px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D] tabular-nums"
                    >
                      {Array.from(
                        { length: startSurahMeta?.count || 7 },
                        (_, i) => i + 1
                      ).map((n) => (
                        <option key={n} value={n}>
                          آية {toArabicIndicDigits(n)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="bg-white border border-[#EADBC8] rounded-xl p-3 space-y-2">
                  <p className="text-[11px] font-extrabold text-[#7D4E35]">موضع النهاية (إلى)</p>
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={tomorrowNew.endSurah}
                      onChange={(e) => {
                        const eNum = Number(e.target.value);
                        const eMeta = surahs.find((s) => s.n === eNum);
                        setTomorrowNew((prev) => ({
                          ...prev,
                          endSurah: eNum,
                          endAyah: Math.min(prev.endAyah, eMeta?.count || 7),
                        }));
                      }}
                      className="col-span-2 min-h-[40px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D]"
                    >
                      {surahs.map((s) => (
                        <option key={s.n} value={s.n}>
                          {toArabicIndicDigits(s.n)}. {s.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={tomorrowNew.endAyah}
                      onChange={(e) =>
                        setTomorrowNew((prev) => ({
                          ...prev,
                          endAyah: Number(e.target.value),
                        }))
                      }
                      className="col-span-1 min-h-[40px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/70 text-xs font-bold text-[#4A220D] tabular-nums"
                    >
                      {Array.from(
                        { length: endSurahMeta?.count || 7 },
                        (_, i) => i + 1
                      ).map((n) => (
                        <option key={n} value={n}>
                          آية {toArabicIndicDigits(n)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Tomorrow Reviews Section */}
        <div className="bg-white border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-display font-extrabold text-sm text-[#4A220D]">
              مراجعات الغد ({toArabicIndicDigits(tomorrowReviews.length)})
            </span>
            <button
              type="button"
              onClick={() =>
                setTomorrowReviews((prev) => [
                  ...prev,
                  {
                    id: generateValidId('rev_draft'),
                    reviewType: 'cumulative_review',
                    ...DEFAULT_QURAN_RANGE,
                    completed: false,
                  },
                ])
              }
              className="duo-btn-orange min-h-[38px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>أضف مراجعة للغد</span>
            </button>
          </div>

          {tomorrowReviews.map((rev, idx) => {
            const rStartMeta = surahs.find((s) => s.n === rev.startSurah) || surahs[0];
            const rEndMeta = surahs.find((s) => s.n === rev.endSurah) || surahs[0];
            return (
              <div
                key={rev.id}
                className="bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-3 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded-lg bg-[#FFA900]/20 text-[#995C00] text-xs font-extrabold">
                      مراجعة #{toArabicIndicDigits(idx + 1)}
                    </span>
                    <select
                      value={rev.reviewType}
                      onChange={(e) => {
                        const nextType = e.target.value as QuranReviewType;
                        setTomorrowReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id ? { ...item, reviewType: nextType } : item
                          )
                        );
                      }}
                      className="min-h-[36px] px-2.5 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
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
                              item.id === rev.id ? { ...item, customLabel: e.target.value } : item
                            )
                          )
                        }
                        placeholder="اكتب اسم المراجعة..."
                        className="min-h-[36px] px-2.5 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                      />
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setTomorrowReviews((prev) => prev.filter((item) => item.id !== rev.id))
                    }
                    className="text-xs font-bold text-[#D95338] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>إزالة</span>
                  </button>
                </div>

                {surahs.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <select
                      value={rev.startSurah}
                      onChange={(e) => {
                        const sNum = Number(e.target.value);
                        setTomorrowReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id
                              ? { ...item, startSurah: sNum, endSurah: Math.max(sNum, item.endSurah) }
                              : item
                          )
                        );
                      }}
                      className="min-h-[38px] px-2 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                    >
                      {surahs.map((s) => (
                        <option key={s.n} value={s.n}>
                          من: {s.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={rev.startAyah}
                      onChange={(e) => {
                        const a = Number(e.target.value);
                        setTomorrowReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id ? { ...item, startAyah: a } : item
                          )
                        );
                      }}
                      className="min-h-[38px] px-2 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D] tabular-nums"
                    >
                      {Array.from({ length: rStartMeta?.count || 7 }, (_, i) => i + 1).map(
                        (a) => (
                          <option key={a} value={a}>
                            آية {toArabicIndicDigits(a)}
                          </option>
                        )
                      )}
                    </select>

                    <select
                      value={rev.endSurah}
                      onChange={(e) => {
                        const sNum = Number(e.target.value);
                        setTomorrowReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id ? { ...item, endSurah: sNum } : item
                          )
                        );
                      }}
                      className="min-h-[38px] px-2 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                    >
                      {surahs.map((s) => (
                        <option key={s.n} value={s.n}>
                          إلى: {s.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={rev.endAyah}
                      onChange={(e) => {
                        const a = Number(e.target.value);
                        setTomorrowReviews((prev) =>
                          prev.map((item) =>
                            item.id === rev.id ? { ...item, endAyah: a } : item
                          )
                        );
                      }}
                      className="min-h-[38px] px-2 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D] tabular-nums"
                    >
                      {Array.from({ length: rEndMeta?.count || 7 }, (_, i) => i + 1).map(
                        (a) => (
                          <option key={a} value={a}>
                            آية {toArabicIndicDigits(a)}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                )}
              </div>
            );
          })}

          <label className="inline-flex items-center gap-1.5 text-xs font-bold text-[#7D4E35] cursor-pointer select-none pt-1">
            <input
              type="checkbox"
              checked={replaceExisting}
              onChange={(e) => setReplaceExisting(e.target.checked)}
              className="w-4 h-4 accent-[#F56900] rounded cursor-pointer"
            />
            <span>استبدال أي مراجعات غد مسجلة مسبقاً لهؤلاء الطلاب</span>
          </label>
        </div>

        {/* All-Checked Student Dropdown Checklist */}
        <StudentChecklistDropdown
          students={students}
          selectedIds={selectedIds}
          onChange={setSelectedIds}
          title="الطلاب المشمولون بتعيين حفظ ومراجعة الغد"
          renderBadge={(sid) => {
            const assigned = statuses[sid]?.quranTomorrowAssigned;
            return (
              <span
                className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold border ${
                  assigned
                    ? 'bg-[#58CC02]/15 border-[#58CC02]/60 text-[#46A302]'
                    : 'bg-[#FDF6EE] border-[#EADBC8] text-[#7D4E35]'
                }`}
              >
                {assigned ? 'تم تحديد الحفظ' : 'لم يُعيّن بعد'}
              </span>
            );
          }}
        />

        {errorMsg && (
          <p className="text-xs font-bold text-[#D95338] bg-[#D95338]/10 border border-[#D95338]/30 rounded-xl px-3 py-2">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-[#F7EBDD]">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="duo-btn-cream min-h-[44px] px-5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm cursor-pointer disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="duo-btn-green min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>
              {saving
                ? 'جاري الحفظ للطلاب...'
                : `اعتماد حفظ الغد (${toArabicIndicDigits(selectedIds.length)} طالب)`}
            </span>
          </button>
        </div>
      </div>

      {previewLaunch && (
        <KingFahdMushafReader
          studentName="معاينة التعيين الجماعي"
          headerSubtitle={`مصحف الملك فهد · ${previewLaunch.label}`}
          readOnlyMistakes
          initialPage={previewLaunch.page}
          highlightRanges={[
            {
              label: previewLaunch.label,
              kind: previewLaunch.kind,
              range: previewLaunch.range,
            },
          ]}
          focusTarget={{
            surah: previewLaunch.range.startSurah,
            ayah: previewLaunch.range.startAyah,
          }}
          mistakes={{}}
          onMistakesChange={() => {}}
          onClose={() => setPreviewLaunch(null)}
        />
      )}
    </div>,
    document.body
  );
};

// ============================================================================
// 5. Batch Quran Tasmee Modal (التسميع الجماعي لحفظ ومراجعات اليوم)
// ============================================================================

export interface BatchQuranTasmeeModalProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  students: AccountRecord[];
  currentUserId: string;
  currentUserName: string;
  onSuccess: (message: string) => void;
  onClose: () => void;
}

export const BatchQuranTasmeeModal: React.FC<BatchQuranTasmeeModalProps> = ({
  workspace,
  context,
  students,
  currentUserId,
  currentUserName,
  onSuccess,
  onClose,
}) => {
  const [dateKey, setDateKey] = useState<string>(() => getTodayDateKey());
  const [surahs, setSurahs] = useState<MushafSurahMeta[]>([]);
  const [entries, setEntries] = useState<Record<string, HalaqaStudentTodayQuranPlanEntry>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filterMode, setFilterMode] = useState<'with_plans' | 'all'>('with_plans');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    Promise.all([
      getSurahsList(),
      loadHalaqaTodayQuranPlans({
        workspace,
        studentIds: students.map((s) => s.id),
        dateKey,
      }),
    ])
      .then(([loadedSurahs, loadedEntries]) => {
        if (cancelled) return;
        setSurahs(loadedSurahs);
        setEntries(loadedEntries);
        const hasAny = Object.values(loadedEntries).some(
          (e) => e.todayNew !== null || e.todayReviews.length > 0
        );
        setFilterMode(hasAny ? 'with_plans' : 'all');
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(
            err instanceof Error ? err.message : 'تعذّر تحميل مقررات التسميع اليومية للطلاب.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, students, dateKey]);

  const studentsWithPlansCount = useMemo(
    () =>
      students.filter((st) => {
        const e = entries[st.id];
        return Boolean(e && (e.todayNew !== null || e.todayReviews.length > 0));
      }).length,
    [students, entries]
  );

  const unheardCount = useMemo(() => {
    let total = 0;
    for (const st of students) {
      const e = entries[st.id];
      if (!e) continue;
      if (e.todayNew && e.todayNew.completed === false) total++;
      for (const r of e.todayReviews) {
        if (r.completed === false) total++;
      }
    }
    return total;
  }, [students, entries]);

  const displayedStudents = useMemo(() => {
    if (filterMode === 'all') return students;
    return students.filter((st) => {
      const e = entries[st.id];
      return Boolean(e && (e.todayNew !== null || e.todayReviews.length > 0));
    });
  }, [students, entries, filterMode]);

  const setStudentNewHeard = (studentId: string, heard: boolean) => {
    setEntries((prev) => {
      const cur = prev[studentId];
      if (!cur || !cur.todayNew) return prev;
      return {
        ...prev,
        [studentId]: {
          ...cur,
          todayNew: { ...cur.todayNew, completed: heard },
        },
      };
    });
  };

  const setStudentReviewHeard = (studentId: string, reviewId: string, heard: boolean) => {
    setEntries((prev) => {
      const cur = prev[studentId];
      if (!cur) return prev;
      return {
        ...prev,
        [studentId]: {
          ...cur,
          todayReviews: cur.todayReviews.map((rev) =>
            rev.id === reviewId ? { ...rev, completed: heard } : rev
          ),
        },
      };
    });
  };

  const setAllStudentItemsHeard = (studentId: string, heard: boolean) => {
    setEntries((prev) => {
      const cur = prev[studentId];
      if (!cur) return prev;
      return {
        ...prev,
        [studentId]: {
          ...cur,
          todayNew: cur.todayNew ? { ...cur.todayNew, completed: heard } : null,
          todayReviews: cur.todayReviews.map((rev) => ({ ...rev, completed: heard })),
        },
      };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      const payload = students
        .map((st) => {
          const e = entries[st.id];
          if (!e) return null;
          return {
            student: st,
            todayNew: e.todayNew,
            todayReviews: e.todayReviews,
            tomorrowNew: e.tomorrowNew,
            tomorrowReviews: e.tomorrowReviews,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const { savedCount, failedCount } = await saveBatchQuranTasmeeOutcomes({
        workspace,
        mosqueId: context.mosqueId,
        halaqaId: context.halaqaId,
        dateKey,
        entries: payload,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });

      if (savedCount === 0 && failedCount > 0) {
        setErrorMsg('تعذّر حفظ التسميع الجماعي بسبب قيود الوصول.');
        setSaving(false);
        return;
      }

      onSuccess(
        `تم حفظ التسميع الجماعي لعدد ${toArabicIndicDigits(savedCount)} طالب${
          unheardCount > 0
            ? `، وتم تعيين ${toArabicIndicDigits(unheardCount)} مقطع لم يُسمّع لغد تلقائياً`
            : ''
        }${failedCount > 0 ? ` (تعذّر حفظ ${toArabicIndicDigits(failedCount)})` : ''}.`
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذّر حفظ التسميع الجماعي.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      dir="rtl"
      className="fixed inset-0 z-[80] bg-black/55 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
    >
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl max-w-4xl w-full p-5 sm:p-6 space-y-4 shadow-2xl my-auto max-h-[92dvh] pb-safe flex flex-col">
        {/* Modal Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 shrink-0">
          <div>
            <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-[#46A302]" />
              <span>التسميع الجماعي لحفظ ومراجعات اليوم</span>
            </h3>
            <p className="text-xs sm:text-sm text-[#7D4E35] mt-0.5">
              كل مقرر يُترك دون تغيير يُعتمد تلقائياً كـ «تم التسميع ✓»، وأي مقطع يُحدد كـ «لم يسمّع» يُعيّن لحفظ أو مراجعة غد تلقائياً.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="w-9 h-9 rounded-xl bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35] hover:text-[#4A220D] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Date & Filter Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-white border border-[#EADBC8] rounded-xl px-2.5 py-1.5">
              <Calendar className="w-4 h-4 text-[#F56900]" />
              <input
                type="date"
                value={dateKey}
                onChange={(e) => {
                  if (e.target.value) setDateKey(e.target.value);
                }}
                aria-label="تاريخ التسميع الجماعي"
                className="bg-transparent text-xs font-bold text-[#4A220D] focus:outline-none cursor-pointer tabular-nums"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-white border border-[#EADBC8] rounded-xl">
              <button
                type="button"
                onClick={() => setFilterMode('with_plans')}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold cursor-pointer transition-colors ${
                  filterMode === 'with_plans'
                    ? 'bg-[#F56900] text-white'
                    : 'text-[#7D4E35] hover:text-[#4A220D]'
                }`}
              >
                لديهم مقررات اليوم ({toArabicIndicDigits(studentsWithPlansCount)})
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('all')}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold cursor-pointer transition-colors ${
                  filterMode === 'all'
                    ? 'bg-[#F56900] text-white'
                    : 'text-[#7D4E35] hover:text-[#4A220D]'
                }`}
              >
                جميع الطلاب ({toArabicIndicDigits(students.length)})
              </button>
            </div>
          </div>

          <div className="text-xs font-bold text-[#7D4E35] tabular-nums">
            <span>المرحل لغد: </span>
            <strong className={unheardCount > 0 ? 'text-[#D95338]' : 'text-[#46A302]'}>
              {toArabicIndicDigits(unheardCount)} مقطع
            </strong>
          </div>
        </div>

        {/* Scrollable Students Tasmee List */}
        <div className="flex-1 overflow-y-auto space-y-3 pl-1">
          {loading ? (
            <div className="py-10">
              <ModernLoader label="جاري تحميل حفظ ومراجعات اليوم لطلاب الحلقة..." />
            </div>
          ) : displayedStudents.length === 0 ? (
            <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center space-y-2">
              <p className="text-sm font-bold text-[#4A220D]">
                لا يوجد طلاب لديهم حفظ أو مراجعة محددة لتاريخ {dateKey}.
              </p>
              <p className="text-xs text-[#7D4E35]">
                يمكنك تعيين حفظ ومراجعة غد جماعياً أو فتح خطة كل طالب على حدة.
              </p>
            </div>
          ) : (
            displayedStudents.map((student) => {
              const studentIdx = students.findIndex((s) => s.id === student.id);
              const entry = entries[student.id];
              const hasItems =
                Boolean(entry?.todayNew) || Boolean(entry && entry.todayReviews.length > 0);
              const allMarkedUnheard =
                hasItems &&
                (!entry.todayNew || entry.todayNew.completed === false) &&
                entry.todayReviews.every((r) => r.completed === false);

              return (
                <div
                  key={student.id}
                  className="bg-[#FDF6EE]/70 border-2 border-[#EADBC8] rounded-2xl p-3.5 sm:p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-8 h-8 rounded-xl bg-white border border-[#EADBC8] text-[#F56900] font-display font-extrabold text-xs inline-flex items-center justify-center shrink-0 tabular-nums">
                        {toArabicIndicDigits(studentIdx + 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                          {student.quadrupleName}
                        </p>
                        {entry?.carriedFromDate && (
                          <p className="text-[11px] font-bold text-[#46A302]">
                            مجهز تلقائياً من خطة {entry.carriedFromDate}
                          </p>
                        )}
                      </div>
                    </div>

                    {hasItems && (
                      <button
                        type="button"
                        onClick={() => setAllStudentItemsHeard(student.id, allMarkedUnheard)}
                        className={`min-h-[32px] px-3 py-1 rounded-xl border text-[11px] font-extrabold cursor-pointer transition-colors ${
                          allMarkedUnheard
                            ? 'bg-[#58CC02]/15 border-[#58CC02] text-[#46A302]'
                            : 'bg-white border-[#EADBC8] hover:border-[#D95338] text-[#D95338]'
                        }`}
                      >
                        {allMarkedUnheard ? 'إرجاع الكل لتم التسميع' : 'تحديد الكل: لم يسمّع'}
                      </button>
                    )}
                  </div>

                  {!hasItems ? (
                    <p className="text-xs font-bold text-[#7D4E35] bg-white border border-[#EADBC8] rounded-xl px-3 py-2">
                      لا يوجد حفظ أو مراجعة مسجلة لهذا اليوم.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {/* Today's New Hifz Row */}
                      {entry.todayNew && (
                        <div className="bg-white border border-[#EADBC8] rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="px-2 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#357A02] text-[11px] font-extrabold">
                                الحفظ الجديد
                              </span>
                              <span className="text-xs sm:text-sm font-extrabold text-[#4A220D]">
                                {formatQuranRangeSummary(surahs, entry.todayNew)}
                              </span>
                            </div>
                            {entry.todayNew.completed === false && (
                              <p className="text-[11px] font-bold text-[#D95338]">
                                سيُعيّن تلقائياً كحفظ جديد لغد
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => setStudentNewHeard(student.id, true)}
                              className={`min-h-[34px] px-3 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                entry.todayNew.completed !== false
                                  ? 'bg-[#58CC02] border-[#46A302] text-white'
                                  : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#58CC02]'
                              }`}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>تم التسميع ✓</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setStudentNewHeard(student.id, false)}
                              className={`min-h-[34px] px-3 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                entry.todayNew.completed === false
                                  ? 'bg-[#D95338] border-[#B43D25] text-white'
                                  : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#D95338]'
                              }`}
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>لم يسمّع</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Today's Reviews Rows */}
                      {entry.todayReviews.map((rev, rIdx) => (
                        <div
                          key={rev.id}
                          className="bg-white border border-[#EADBC8] rounded-xl p-3 flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="px-2 py-0.5 rounded-lg bg-[#FFA900]/20 text-[#995C00] text-[11px] font-extrabold">
                                {rev.reviewType === 'custom' && rev.customLabel?.trim()
                                  ? rev.customLabel.trim()
                                  : QURAN_REVIEW_TYPE_LABELS[rev.reviewType]}{' '}
                                #{toArabicIndicDigits(rIdx + 1)}
                              </span>
                              <span className="text-xs sm:text-sm font-extrabold text-[#4A220D]">
                                {formatQuranRangeSummary(surahs, rev)}
                              </span>
                            </div>
                            {rev.completed === false && (
                              <p className="text-[11px] font-bold text-[#D95338]">
                                سيُرحّل تلقائياً إلى مراجعات غد
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => setStudentReviewHeard(student.id, rev.id, true)}
                              className={`min-h-[34px] px-3 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                rev.completed !== false
                                  ? 'bg-[#58CC02] border-[#46A302] text-white'
                                  : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#58CC02]'
                              }`}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>تم التسميع ✓</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setStudentReviewHeard(student.id, rev.id, false)}
                              className={`min-h-[34px] px-3 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                rev.completed === false
                                  ? 'bg-[#D95338] border-[#B43D25] text-white'
                                  : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#D95338]'
                              }`}
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>لم يسمّع</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {errorMsg && (
          <p className="text-xs font-bold text-[#D95338] bg-[#D95338]/10 border border-[#D95338]/30 rounded-xl px-3 py-2 shrink-0">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-[#F7EBDD] shrink-0">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="duo-btn-cream min-h-[44px] px-5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm cursor-pointer disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            disabled={saving || loading || studentsWithPlansCount === 0}
            onClick={() => void handleSave()}
            className="duo-btn-green min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>
              {saving
                ? 'جاري الحفظ...'
                : `حفظ التسميع الجماعي (${toArabicIndicDigits(studentsWithPlansCount)} طالب)`}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ============================================================================
// 6. Batch Book Correction Modal (التصحيح الجماعي لواجبات الكتب)
// ============================================================================

export interface BatchBookCorrectionModalProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  curricula: CurriculumRecord[];
  initialBookId?: string;
  students: AccountRecord[];
  currentUserId: string;
  currentUserName: string;
  onSuccess: (message: string) => void;
  onClose: () => void;
}

export const BatchBookCorrectionModal: React.FC<BatchBookCorrectionModalProps> = ({
  workspace,
  context,
  curricula,
  initialBookId,
  students,
  currentUserId,
  currentUserName,
  onSuccess,
  onClose,
}) => {
  const [dateKey, setDateKey] = useState<string>(() => getTodayDateKey());
  const [activeBookId, setActiveBookId] = useState<string>(
    () => initialBookId || curricula[0]?.bookId || ''
  );
  const [entriesByCacheKey, setEntriesByCacheKey] = useState<
    Record<string, Record<string, HalaqaStudentTodayBookPlanEntry>>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filterMode, setFilterMode] = useState<'with_hw' | 'all'>('with_hw');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeCurriculum = useMemo(
    () => curricula.find((c) => c.bookId === activeBookId) || curricula[0] || null,
    [curricula, activeBookId]
  );

  const cacheKey = `${activeBookId}::${dateKey}`;
  const currentEntries = entriesByCacheKey[cacheKey] || {};

  useEffect(() => {
    if (!activeBookId) return;
    if (entriesByCacheKey[cacheKey]) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    loadHalaqaTodayBookPlans({
      workspace,
      studentIds: students.map((s) => s.id),
      bookId: activeBookId,
      dateKey,
    })
      .then((loaded) => {
        if (cancelled) return;
        setEntriesByCacheKey((prev) => ({
          ...prev,
          [cacheKey]: loaded,
        }));
        const hasAny = Object.values(loaded).some((e) => e.todayHomeworks.length > 0);
        setFilterMode(hasAny ? 'with_hw' : 'all');
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'تعذّر تحميل واجبات الكتاب للطلاب.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace, students, activeBookId, dateKey, cacheKey, entriesByCacheKey]);

  const studentsWithHwCount = useMemo(
    () =>
      students.filter((st) => {
        const e = currentEntries[st.id];
        return Boolean(e && e.todayHomeworks.length > 0);
      }).length,
    [students, currentEntries]
  );

  const deferredCount = useMemo(() => {
    let total = 0;
    for (const st of students) {
      const e = currentEntries[st.id];
      if (!e) continue;
      for (const hw of e.todayHomeworks) {
        if (hw.status === 'deferred') total++;
      }
    }
    return total;
  }, [students, currentEntries]);

  const displayedStudents = useMemo(() => {
    if (filterMode === 'all') return students;
    return students.filter((st) => {
      const e = currentEntries[st.id];
      return Boolean(e && e.todayHomeworks.length > 0);
    });
  }, [students, currentEntries, filterMode]);

  const setHomeworkStatus = (
    studentId: string,
    homeworkId: string,
    nextStatus: BookHomeworkStatus
  ) => {
    setEntriesByCacheKey((prev) => {
      const bookMap = prev[cacheKey];
      const cur = bookMap?.[studentId];
      if (!bookMap || !cur) return prev;
      return {
        ...prev,
        [cacheKey]: {
          ...bookMap,
          [studentId]: {
            ...cur,
            todayHomeworks: cur.todayHomeworks.map((hw) =>
              hw.id === homeworkId ? { ...hw, status: nextStatus } : hw
            ),
          },
        },
      };
    });
  };

  const handleSave = async () => {
    if (!activeCurriculum) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const payload = students
        .map((st) => {
          const e = currentEntries[st.id];
          if (!e) return null;
          return {
            student: st,
            whereWeReachedPage: e.whereWeReachedPage,
            todayHomeworks: e.todayHomeworks,
            tomorrowHomeworks: e.tomorrowHomeworks,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const { savedCount, failedCount } = await saveBatchBookCorrectionOutcomes({
        workspace,
        mosqueId: context.mosqueId,
        halaqaId: context.halaqaId,
        bookId: activeCurriculum.bookId,
        bookTitle: activeCurriculum.bookTitle,
        dateKey,
        entries: payload,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });

      if (savedCount === 0 && failedCount > 0) {
        setErrorMsg('تعذّر حفظ التصحيح الجماعي للواجبات.');
        setSaving(false);
        return;
      }

      onSuccess(
        `تم حفظ التصحيح الجماعي لكتاب «${activeCurriculum.bookTitle}» (${toArabicIndicDigits(savedCount)} طالب)${
          deferredCount > 0
            ? `، وتم ترحيل ${toArabicIndicDigits(deferredCount)} واجب لغد تلقائياً`
            : ''
        }${failedCount > 0 ? ` (تعذّر حفظ ${toArabicIndicDigits(failedCount)})` : ''}.`
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذّر حفظ التصحيح الجماعي للواجبات.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      dir="rtl"
      className="fixed inset-0 z-[80] bg-black/55 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
    >
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl max-w-4xl w-full p-5 sm:p-6 space-y-4 shadow-2xl my-auto max-h-[92dvh] pb-safe flex flex-col">
        {/* Modal Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 shrink-0">
          <div>
            <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] flex items-center gap-2">
              <BookMarked className="w-5 h-5 text-[#F56900]" />
              <span>التصحيح الجماعي لواجبات اليوم</span>
            </h3>
            <p className="text-xs sm:text-sm text-[#7D4E35] mt-0.5">
              أي واجب يُترك دون تغيير يُعتمد تلقائياً كـ «تم الحل ✓»، وما يُحدد كـ «لم يحل (لغد)» يُرحّل لواجب غد.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="w-9 h-9 rounded-xl bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35] hover:text-[#4A220D] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Book Tabs (if > 1 book assigned) */}
        {curricula.length > 1 && (
          <div className="flex flex-wrap gap-1.5 shrink-0">
            {curricula.map((cur) => {
              const active = cur.bookId === activeBookId;
              return (
                <button
                  key={cur.id}
                  type="button"
                  onClick={() => setActiveBookId(cur.bookId)}
                  className={`min-h-[38px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#F56900] border-[#C95200] text-white'
                      : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                  }`}
                >
                  <BookMarked className="w-3.5 h-3.5" />
                  <span>{cur.bookTitle}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Date & Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-white border border-[#EADBC8] rounded-xl px-2.5 py-1.5">
              <Calendar className="w-4 h-4 text-[#F56900]" />
              <input
                type="date"
                value={dateKey}
                onChange={(e) => {
                  if (e.target.value) setDateKey(e.target.value);
                }}
                aria-label="تاريخ التصحيح الجماعي"
                className="bg-transparent text-xs font-bold text-[#4A220D] focus:outline-none cursor-pointer tabular-nums"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-white border border-[#EADBC8] rounded-xl">
              <button
                type="button"
                onClick={() => setFilterMode('with_hw')}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold cursor-pointer transition-colors ${
                  filterMode === 'with_hw'
                    ? 'bg-[#F56900] text-white'
                    : 'text-[#7D4E35] hover:text-[#4A220D]'
                }`}
              >
                لديهم واجبات اليوم ({toArabicIndicDigits(studentsWithHwCount)})
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('all')}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold cursor-pointer transition-colors ${
                  filterMode === 'all'
                    ? 'bg-[#F56900] text-white'
                    : 'text-[#7D4E35] hover:text-[#4A220D]'
                }`}
              >
                جميع الطلاب ({toArabicIndicDigits(students.length)})
              </button>
            </div>
          </div>

          <div className="text-xs font-bold text-[#7D4E35] tabular-nums">
            <span>المرحل لغد: </span>
            <strong className={deferredCount > 0 ? 'text-[#D98A00]' : 'text-[#46A302]'}>
              {toArabicIndicDigits(deferredCount)} واجب
            </strong>
          </div>
        </div>

        {/* Scrollable Students Homeworks List */}
        <div className="flex-1 overflow-y-auto space-y-3 pl-1">
          {loading ? (
            <div className="py-10">
              <ModernLoader label="جاري تحميل واجبات اليوم لطلاب الحلقة..." />
            </div>
          ) : displayedStudents.length === 0 ? (
            <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center space-y-2">
              <p className="text-sm font-bold text-[#4A220D]">
                لا توجد واجبات مسجلة لهذا الكتاب بتاريخ {dateKey}.
              </p>
              <p className="text-xs text-[#7D4E35]">
                يمكنك تعيين واجبات غد جماعياً للطلاب من بطاقة الكتاب ثم تصحيحها في اليوم التالي.
              </p>
            </div>
          ) : (
            displayedStudents.map((student) => {
              const studentIdx = students.findIndex((s) => s.id === student.id);
              const entry = currentEntries[student.id];
              const homeworks = entry?.todayHomeworks || [];

              return (
                <div
                  key={student.id}
                  className="bg-[#FDF6EE]/70 border-2 border-[#EADBC8] rounded-2xl p-3.5 sm:p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-8 h-8 rounded-xl bg-white border border-[#EADBC8] text-[#F56900] font-display font-extrabold text-xs inline-flex items-center justify-center shrink-0 tabular-nums">
                        {toArabicIndicDigits(studentIdx + 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                          {student.quadrupleName}
                        </p>
                        <p className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
                          موضع الوصول: صفحة {toArabicIndicDigits(entry?.whereWeReachedPage || 1)}
                          {entry?.carriedFromDate
                            ? ` · مجهز من واجب ${entry.carriedFromDate}`
                            : ''}
                        </p>
                      </div>
                    </div>
                  </div>

                  {homeworks.length === 0 ? (
                    <p className="text-xs font-bold text-[#7D4E35] bg-white border border-[#EADBC8] rounded-xl px-3 py-2">
                      لا توجد واجبات مسجلة لهذا اليوم.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {homeworks.map((hw, hIdx) => {
                        const typeLabel =
                          hw.type === 'other' && hw.customTypeLabel?.trim()
                            ? hw.customTypeLabel.trim()
                            : BOOK_HOMEWORK_TYPE_LABELS[hw.type] || 'واجب';
                        const isSolved = hw.status === 'completed' || hw.status === 'pending';
                        const isDeferred = hw.status === 'deferred';
                        const isCancelled = hw.status === 'cancelled';

                        return (
                          <div
                            key={hw.id}
                            className="bg-white border border-[#EADBC8] rounded-xl p-3 flex flex-wrap items-center justify-between gap-2"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="px-2 py-0.5 rounded-lg bg-[#F56900]/15 text-[#F56900] text-[11px] font-extrabold">
                                  {typeLabel} #{toArabicIndicDigits(hIdx + 1)}
                                </span>
                                <span className="text-xs sm:text-sm font-extrabold text-[#4A220D] tabular-nums">
                                  صفحة {toArabicIndicDigits(hw.pageNumber)}
                                </span>
                              </div>
                              {hw.note && (
                                <p className="text-[11px] text-[#7D4E35]">{hw.note}</p>
                              )}
                              {isDeferred && (
                                <p className="text-[11px] font-bold text-[#D98A00]">
                                  سيُرحّل تلقائياً إلى واجبات غد
                                </p>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() =>
                                  setHomeworkStatus(student.id, hw.id, 'completed')
                                }
                                className={`min-h-[34px] px-3 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                  isSolved
                                    ? 'bg-[#58CC02] border-[#46A302] text-white'
                                    : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#58CC02]'
                                }`}
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>تم الحل ✓</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setHomeworkStatus(student.id, hw.id, 'deferred')
                                }
                                className={`min-h-[34px] px-3 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                  isDeferred
                                    ? 'bg-[#FFA900] border-[#D98A00] text-white'
                                    : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#FFA900]'
                                }`}
                              >
                                <Forward className="w-3.5 h-3.5" />
                                <span>لم يحل (لغد)</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setHomeworkStatus(student.id, hw.id, 'cancelled')
                                }
                                className={`min-h-[34px] px-2.5 py-1 rounded-xl border-2 font-display font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                  isCancelled
                                    ? 'bg-[#D95338] border-[#B43D25] text-white'
                                    : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#D95338]'
                                }`}
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                <span>إلغاء</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {errorMsg && (
          <p className="text-xs font-bold text-[#D95338] bg-[#D95338]/10 border border-[#D95338]/30 rounded-xl px-3 py-2 shrink-0">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-[#F7EBDD] shrink-0">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="duo-btn-cream min-h-[44px] px-5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm cursor-pointer disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            disabled={saving || loading || studentsWithHwCount === 0}
            onClick={() => void handleSave()}
            className="duo-btn-green min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>
              {saving
                ? 'جاري الحفظ...'
                : `حفظ التصحيح الجماعي (${toArabicIndicDigits(studentsWithHwCount)} طالب)`}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
