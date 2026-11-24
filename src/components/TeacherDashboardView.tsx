import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookMarked,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  GraduationCap,
  LogOut,
  Users,
} from 'lucide-react';
import { getTodayDateKey } from '../services/multiDb';
import { toArabicIndicDigits } from '../services/mushafService';
import {
  listBooksInComplex,
  listCurriculaInComplex,
  loadHalaqaCurriculaStatusesForDate,
  type ComplexWorkspaceData,
  type HalaqaStudentCurriculaStatus,
} from '../services/platformService';
import {
  QURAN_MUSHAF_BOOK_ID,
  QURAN_MUSHAF_TITLE,
  WEEK_DAYS,
  type AccountRecord,
  type BookRecord,
  type CurriculumRecord,
  type TeacherRoleContext,
} from '../types/platform';
import { AttendanceSection } from './AttendanceSection';
import { KingFahdMushafReader } from './KingFahdMushafReader';
import { ModernLoader } from './ModernLoader';
import { NotificationPermissionButton } from './NotificationPermissionButton';
import { PWAInstallButton } from './PWAInstallButton';
import { TeacherBookReaderModal } from './TeacherBookReaderModal';
import { TeacherBookWorkspace } from './TeacherBookWorkspace';
import {
  BatchBookCorrectionModal,
  BatchQuranTasmeeModal,
  BookReachedPropagationModal,
  GroupBookHomeworkModal,
  GroupQuranPlanModal,
} from './TeacherCurriculaGroupModals';
import { TeacherMushafWorkspace } from './TeacherMushafWorkspace';

interface TeacherDashboardViewProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  currentUserId: string;
  currentUserName: string;
  onReturnToSupervisor: () => void;
  isStandaloneTeacher?: boolean;
  availableContexts?: TeacherRoleContext[];
  onSwitchContext?: (ctx: TeacherRoleContext) => void;
}

type TeacherViewTab = 'overview' | 'attendance' | 'curricula' | 'students';

export const TeacherDashboardView: React.FC<TeacherDashboardViewProps> = ({
  workspace,
  context,
  currentUserId,
  currentUserName,
  onReturnToSupervisor,
  isStandaloneTeacher = false,
  availableContexts,
  onSwitchContext,
}) => {
  const [tab, setTab] = useState<TeacherViewTab>('overview');
  const [curricula, setCurricula] = useState<CurriculumRecord[]>([]);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [loadingCurricula, setLoadingCurricula] = useState(true);

  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [activeQuranStudent, setActiveQuranStudent] = useState<{
    student: AccountRecord;
    studentNumber: number;
  } | null>(null);
  const [activeBookSession, setActiveBookSession] = useState<{
    student: AccountRecord;
    studentNumber: number;
    curriculum: CurriculumRecord;
    matchedBook: BookRecord | null;
  } | null>(null);

  // Batch student assignment status badges (for today's tomorrow-plans)
  const [studentStatuses, setStudentStatuses] = useState<
    Record<string, HalaqaStudentCurriculaStatus>
  >({});
  const [loadingStatuses, setLoadingStatuses] = useState(false);

  // General teacher bookmark state (persisted per halaqa so teacher stays on their stopped page)
  const [teacherMushafPage, setTeacherMushafPage] = useState<number>(1);
  const [teacherBookPages, setTeacherBookPages] = useState<Record<string, number>>({});

  // Teacher General Readers & Collective Assignment Modals
  const [generalMushafOpen, setGeneralMushafOpen] = useState(false);
  const [generalBookReader, setGeneralBookReader] = useState<{
    curriculum: CurriculumRecord;
    matchedBook: BookRecord | null;
    initialPage: number;
  } | null>(null);
  const [bookPropagationPrompt, setBookPropagationPrompt] = useState<{
    curriculum: CurriculumRecord;
    stoppedPage: number;
  } | null>(null);
  const [groupBookHomeworkModal, setGroupBookHomeworkModal] = useState<{
    curriculum: CurriculumRecord;
    matchedBook: BookRecord | null;
  } | null>(null);
  const [groupQuranModalOpen, setGroupQuranModalOpen] = useState(false);
  const [batchQuranTasmeeOpen, setBatchQuranTasmeeOpen] = useState(false);
  const [batchBookCorrectionBookId, setBatchBookCorrectionBookId] = useState<string | null>(null);
  const [groupFeedback, setGroupFeedback] = useState<string | null>(null);

  const halaqaStudents = useMemo(
    () =>
      workspace.accounts
        .filter((a) => a.role === 'student' && a.halaqaIds.includes(context.halaqaId))
        .sort((a, b) => a.quadrupleName.localeCompare(b.quadrupleName, 'ar')),
    [workspace.accounts, context.halaqaId]
  );

  const halaqaCurricula = useMemo(
    () => curricula.filter((c) => c.halaqaIds.includes(context.halaqaId)),
    [curricula, context.halaqaId]
  );

  // Load saved teacher general stopped pages for current halaqa
  useEffect(() => {
    try {
      const mRaw = window.localStorage.getItem(
        `braem_teacher_general_mushaf_${context.halaqaId}`
      );
      const mPage = Number(mRaw);
      setTeacherMushafPage(
        Number.isFinite(mPage) && mPage >= 1 && mPage <= 604 ? Math.floor(mPage) : 1
      );

      const bRaw = window.localStorage.getItem(
        `braem_teacher_general_books_${context.halaqaId}`
      );
      if (bRaw) {
        const parsed = JSON.parse(bRaw) as Record<string, number>;
        setTeacherBookPages(parsed && typeof parsed === 'object' ? parsed : {});
      } else {
        setTeacherBookPages({});
      }
    } catch {
      setTeacherMushafPage(1);
      setTeacherBookPages({});
    }
  }, [context.halaqaId]);

  const saveTeacherMushafBookmark = useCallback(
    (pageNum: number) => {
      const clean = Math.max(1, Math.min(604, Math.floor(pageNum || 1)));
      setTeacherMushafPage(clean);
      try {
        window.localStorage.setItem(
          `braem_teacher_general_mushaf_${context.halaqaId}`,
          String(clean)
        );
      } catch {
        // Ignore storage quota errors
      }
    },
    [context.halaqaId]
  );

  const saveTeacherBookBookmark = useCallback(
    (bookId: string, pageNum: number) => {
      const clean = Math.max(1, Math.min(2000, Math.floor(pageNum || 1)));
      setTeacherBookPages((prev) => {
        const next = { ...prev, [bookId]: clean };
        try {
          window.localStorage.setItem(
            `braem_teacher_general_books_${context.halaqaId}`,
            JSON.stringify(next)
          );
        } catch {
          // Ignore storage quota errors
        }
        return next;
      });
    },
    [context.halaqaId]
  );

  // Clear selected student when switching halaqa context
  useEffect(() => {
    setSelectedStudentId(null);
    setActiveQuranStudent(null);
    setActiveBookSession(null);
    setGeneralMushafOpen(false);
    setGeneralBookReader(null);
    setBookPropagationPrompt(null);
    setGroupBookHomeworkModal(null);
    setGroupQuranModalOpen(false);
    setGroupFeedback(null);
  }, [context.halaqaId]);

  const loadCurricula = useCallback(async () => {
    setLoadingCurricula(true);
    try {
      const [list, bookList] = await Promise.all([
        listCurriculaInComplex(workspace),
        listBooksInComplex(workspace).catch(() => []),
      ]);
      setCurricula(list);
      setBooks(bookList);
    } finally {
      setLoadingCurricula(false);
    }
  }, [workspace]);

  const refreshStudentStatuses = useCallback(async () => {
    if (halaqaStudents.length === 0) {
      setStudentStatuses({});
      return;
    }
    setLoadingStatuses(true);
    try {
      const map = await loadHalaqaCurriculaStatusesForDate({
        workspace,
        studentIds: halaqaStudents.map((s) => s.id),
        dateKey: getTodayDateKey(),
      });
      setStudentStatuses(map);
    } catch {
      // Keep previous status snapshot
    } finally {
      setLoadingStatuses(false);
    }
  }, [workspace, halaqaStudents]);

  useEffect(() => {
    void loadCurricula();
  }, [loadCurricula]);

  useEffect(() => {
    if (tab === 'curricula') {
      void refreshStudentStatuses();
    }
  }, [tab, refreshStudentStatuses]);

  const selectedStudentEntry = useMemo(() => {
    if (!selectedStudentId) return null;
    const idx = halaqaStudents.findIndex((s) => s.id === selectedStudentId);
    if (idx === -1) return null;
    return { student: halaqaStudents[idx], studentNumber: idx + 1 };
  }, [selectedStudentId, halaqaStudents]);

  const quranCurriculumRecord = useMemo(
    () =>
      halaqaCurricula.find(
        (c) => c.bookId === QURAN_MUSHAF_BOOK_ID || c.bookTitle.includes('المصحف')
      ) || null,
    [halaqaCurricula]
  );

  const otherCurricula = useMemo(
    () =>
      halaqaCurricula.filter(
        (c) => c.bookId !== QURAN_MUSHAF_BOOK_ID && !c.bookTitle.includes('المصحف')
      ),
    [halaqaCurricula]
  );

  const navItems: { id: TeacherViewTab; label: string; mobileLabel: string; icon: typeof Users }[] = [
    { id: 'overview', label: 'الرئيسية للمعلم', mobileLabel: 'الرئيسية', icon: BookOpen },
    { id: 'attendance', label: 'تحضير الحلقة', mobileLabel: 'التحضير', icon: ClipboardCheck },
    { id: 'curricula', label: 'المقررات', mobileLabel: 'المقررات', icon: BookMarked },
    { id: 'students', label: `الطلاب (${halaqaStudents.length})`, mobileLabel: 'الطلاب', icon: GraduationCap },
  ];

  return (
    <div className="min-h-screen bg-[#FDF6EE] text-[#4A220D] flex flex-col pb-24 md:pb-8" dir="rtl">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8]">
        {/* Row 1: Halaqa Identity + Primary Actions */}
        <div className="max-w-7xl mx-auto px-3 sm:px-6 min-h-14 sm:min-h-16 py-2 flex items-center justify-between gap-2 sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] sm:text-xs font-extrabold text-[#F56900] truncate">
              وضع المعلم · {context.mosqueName}
            </p>
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <h1 className="font-display text-sm sm:text-lg xl:text-xl font-extrabold text-[#4A220D] truncate">
                {context.halaqaName}
              </h1>
              {availableContexts && availableContexts.length > 1 && onSwitchContext && (
                <select
                  value={context.halaqaId}
                  onChange={(e) => {
                    const next = availableContexts.find(
                      (c) => c.halaqaId === e.target.value
                    );
                    if (next) onSwitchContext(next);
                  }}
                  aria-label="تبديل الحلقة"
                  className="min-h-[34px] max-w-[115px] sm:max-w-[200px] px-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-[11px] sm:text-xs font-bold text-[#4A220D] cursor-pointer truncate shrink-0"
                >
                  {availableContexts.map((ctx) => (
                    <option key={ctx.halaqaId} value={ctx.halaqaId}>
                      {ctx.halaqaName} ({ctx.mosqueName})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <NotificationPermissionButton variant="compact" responsiveLabel="md" />
            <PWAInstallButton variant="compact" responsiveLabel="md" />
            <button
              type="button"
              onClick={onReturnToSupervisor}
              className={`${
                isStandaloneTeacher
                  ? 'min-h-[40px] min-w-[40px] px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#7D4E35] hover:text-[#4A220D] font-display font-bold text-xs sm:text-sm'
                  : 'duo-btn-green min-h-[40px] px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl sm:rounded-2xl font-display font-extrabold text-xs sm:text-sm'
              } inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0`}
              aria-label={isStandaloneTeacher ? 'تسجيل الخروج' : 'العودة لدور المشرف'}
            >
              {isStandaloneTeacher ? (
                <>
                  <LogOut className="w-4 h-4 shrink-0" />
                  <span className="hidden md:inline">تسجيل الخروج</span>
                  <span className="hidden sm:inline md:hidden">خروج</span>
                </>
              ) : (
                <>
                  <ArrowRight className="w-4 h-4 shrink-0" />
                  <span className="hidden md:inline">العودة لدور المشرف</span>
                  <span className="md:hidden">المشرف</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Row 2: Dedicated Tablet & Laptop Navigation Tabs */}
        <div className="hidden md:block border-t border-[#EADBC8]/70 bg-[#FDF6EE]/70">
          <nav
            aria-label="أقسام المعلم"
            className="max-w-7xl mx-auto px-4 sm:px-6 py-1.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setTab(item.id);
                    if (item.id !== 'curricula') {
                      setActiveQuranStudent(null);
                      setActiveBookSession(null);
                    }
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 rounded-xl font-display text-xs lg:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-[#F56900] text-white'
                      : 'text-[#7D4E35] hover:text-[#4A220D] hover:bg-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-8 space-y-5 sm:space-y-6">
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold text-[#F56900]">أهلاً بك يا معلم الحلقة</p>
                <h2 className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D] mt-0.5">
                  {currentUserName}
                </h2>
                <p className="text-xs sm:text-sm text-[#7D4E35] mt-1">
                  الحلقة المختارة: <strong>{context.halaqaName}</strong> · المسجد:{' '}
                  <strong>{context.mosqueName}</strong>
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-none lg:flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setTab('attendance')}
                  className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ClipboardCheck className="w-4 h-4 shrink-0" />
                  <span>تحضير طلاب الحلقة</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('curricula')}
                  className="duo-btn-cream min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <BookMarked className="w-4 h-4 text-[#F56900] shrink-0" />
                  <span>مقررات الطلاب والمصحف</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                <p className="text-xs font-bold text-[#7D4E35]">عدد طلاب الحلقة</p>
                <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#F56900] mt-1.5 sm:mt-2 tabular-nums">
                  {halaqaStudents.length}
                </p>
              </div>
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                <p className="text-xs font-bold text-[#7D4E35]">المقررات المسندة للحلقة</p>
                <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#46A302] mt-1.5 sm:mt-2 tabular-nums">
                  {Math.max(1, halaqaCurricula.length)}
                </p>
              </div>
              <div className="col-span-2 sm:col-span-1 bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                <p className="text-xs font-bold text-[#7D4E35]">المسجد التابع له</p>
                <p className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] mt-1.5 sm:mt-2 truncate">
                  {context.mosqueName}
                </p>
              </div>
            </div>
          </div>
        )}

        {tab === 'attendance' && (
          <AttendanceSection
            workspace={workspace}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            fixedMosqueId={context.mosqueId}
            fixedHalaqaId={context.halaqaId}
          />
        )}

        {tab === 'curricula' &&
          (activeQuranStudent ? (
            <TeacherMushafWorkspace
              workspace={workspace}
              context={context}
              student={activeQuranStudent.student}
              studentNumber={activeQuranStudent.studentNumber}
              currentUserId={currentUserId}
              currentUserName={currentUserName}
              onBack={() => {
                setActiveQuranStudent(null);
                void refreshStudentStatuses();
              }}
            />
          ) : activeBookSession ? (
            <TeacherBookWorkspace
              workspace={workspace}
              context={context}
              student={activeBookSession.student}
              studentNumber={activeBookSession.studentNumber}
              curriculum={activeBookSession.curriculum}
              matchedBook={activeBookSession.matchedBook}
              currentUserId={currentUserId}
              currentUserName={currentUserName}
              onBack={() => {
                setActiveBookSession(null);
                void refreshStudentStatuses();
              }}
            />
          ) : (
            <div className="space-y-5">
              {/* General Daily Curricula Section for the Teacher (Top Section Above Students List) */}
              <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-6 space-y-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base sm:text-xl font-extrabold text-[#4A220D]">
                      مقررات اليوم العامة للمعلم
                    </h2>
                    <p className="text-xs sm:text-sm text-[#7D4E35] mt-0.5">
                      اقرأ واشرح من المصحف أو الكتب، أو نفّذ التسميع الجماعي وتصحيح الواجبات الجماعي وتعيين الغد لكل الطلاب بسرعة.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2">
                    {loadingStatuses && (
                      <span className="text-xs font-bold text-[#F56900]">
                        جاري تحديث حالة الطلاب...
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={halaqaStudents.length === 0}
                      onClick={() => setBatchQuranTasmeeOpen(true)}
                      className="duo-btn-green min-h-[42px] px-3.5 py-2 rounded-xl font-display font-extrabold text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>التسميع الجماعي لليوم</span>
                    </button>
                    {otherCurricula.length > 0 && (
                      <button
                        type="button"
                        disabled={halaqaStudents.length === 0}
                        onClick={() =>
                          setBatchBookCorrectionBookId(otherCurricula[0]?.bookId || null)
                        }
                        className="duo-btn-orange min-h-[42px] px-3.5 py-2 rounded-xl font-display font-extrabold text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        <ClipboardCheck className="w-4 h-4 shrink-0" />
                        <span>التصحيح الجماعي للواجبات</span>
                      </button>
                    )}
                  </div>
                </div>

                {groupFeedback && (
                  <div className="bg-[#58CC02]/12 border-2 border-[#58CC02]/50 rounded-2xl px-4 py-2.5 text-xs sm:text-sm font-extrabold text-[#46A302] flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>{groupFeedback}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setGroupFeedback(null)}
                      className="text-xs font-bold underline cursor-pointer shrink-0"
                    >
                      إخفاء
                    </button>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {/* Teacher General Quran Card */}
                  <div className="bg-[#FDF6EE] border-2 border-[#58CC02]/60 rounded-2xl p-4 flex flex-col justify-between gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-10 h-10 rounded-xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
                          <BookOpen className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="font-display font-extrabold text-base text-[#4A220D]">
                            {quranCurriculumRecord?.bookTitle || QURAN_MUSHAF_TITLE}
                          </h3>
                          <p className="text-xs font-bold text-[#46A302]">
                            توقف المعلم: صفحة {toArabicIndicDigits(teacherMushafPage)} من ٦٠٤
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setGeneralMushafOpen(true)}
                        className="duo-btn-orange col-span-2 sm:flex-1 min-h-[42px] px-3 py-2 rounded-xl font-display font-extrabold text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <BookOpen className="w-4 h-4 shrink-0" />
                        <span>فتح المصحف للشرح</span>
                      </button>

                      <button
                        type="button"
                        disabled={halaqaStudents.length === 0}
                        onClick={() => setBatchQuranTasmeeOpen(true)}
                        className="duo-btn-cream sm:flex-1 min-h-[42px] px-2.5 sm:px-3 py-2 rounded-xl font-display font-extrabold text-[11px] sm:text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-4 h-4 text-[#46A302] shrink-0" />
                        <span>التسميع الجماعي</span>
                      </button>

                      <button
                        type="button"
                        disabled={halaqaStudents.length === 0}
                        onClick={() => setGroupQuranModalOpen(true)}
                        className="duo-btn-green sm:flex-1 min-h-[42px] px-2.5 sm:px-3 py-2 rounded-xl font-display font-extrabold text-[11px] sm:text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
                      >
                        <Users className="w-4 h-4 shrink-0" />
                        <span>حفظ الغد جماعياً</span>
                      </button>
                    </div>
                  </div>

                  {/* Teacher General Assigned Books Cards */}
                  {otherCurricula.map((cur) => {
                    const matchedBook = books.find((b) => b.id === cur.bookId) || null;
                    const stoppedPage = teacherBookPages[cur.bookId] || 1;
                    return (
                      <div
                        key={`general_${cur.id}`}
                        className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 flex flex-col justify-between gap-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-10 h-10 rounded-xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                              <BookMarked className="w-5 h-5" />
                            </div>
                            <div className="min-w-0">
                              <h3 className="font-display font-extrabold text-base text-[#4A220D] truncate">
                                {cur.bookTitle}
                              </h3>
                              <p className="text-xs font-bold text-[#7D4E35]">
                                توقف المعلم: صفحة {toArabicIndicDigits(stoppedPage)}
                                {matchedBook
                                  ? ` من ${toArabicIndicDigits(matchedBook.totalPages)}`
                                  : ''}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setGeneralBookReader({
                                curriculum: cur,
                                matchedBook,
                                initialPage: stoppedPage,
                              })
                            }
                            className="duo-btn-orange col-span-2 sm:flex-1 min-h-[42px] px-3 py-2 rounded-xl font-display font-extrabold text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
                          >
                            <BookOpen className="w-4 h-4 shrink-0" />
                            <span>فتح الكتاب للشرح</span>
                          </button>

                          <button
                            type="button"
                            disabled={halaqaStudents.length === 0}
                            onClick={() => setBatchBookCorrectionBookId(cur.bookId)}
                            className="duo-btn-cream sm:flex-1 min-h-[42px] px-2.5 sm:px-3 py-2 rounded-xl font-display font-extrabold text-[11px] sm:text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
                          >
                            <ClipboardCheck className="w-4 h-4 text-[#F56900] shrink-0" />
                            <span>التصحيح الجماعي</span>
                          </button>

                          <button
                            type="button"
                            disabled={halaqaStudents.length === 0}
                            onClick={() =>
                              setGroupBookHomeworkModal({
                                curriculum: cur,
                                matchedBook,
                              })
                            }
                            className="duo-btn-green sm:flex-1 min-h-[42px] px-2.5 sm:px-3 py-2 rounded-xl font-display font-extrabold text-[11px] sm:text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
                          >
                            <Users className="w-4 h-4 shrink-0" />
                            <span>واجب غد جماعياً</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Step 1: Numbered Student List */}
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
                      طلاب حلقة {context.halaqaName} — اختر طالباً لفتح مقرراته
                    </h2>
                    <p className="text-xs sm:text-sm text-[#7D4E35]">
                      اضغط على اسم أي طالب لعرض مقررات اليوم الخاصة به وفتح مصحفه المستقل للتسميع والمتابعة.
                    </p>
                  </div>
                  <span className="px-3 py-1.5 rounded-xl bg-[#FDF6EE] border border-[#EADBC8] text-xs font-extrabold text-[#4A220D] tabular-nums">
                    إجمالي الطلاب: {toArabicIndicDigits(halaqaStudents.length)}
                  </span>
                </div>

                {loadingCurricula ? (
                  <ModernLoader label="جاري تحميل طلاب الحلقة ومقرراتها..." />
                ) : halaqaStudents.length === 0 ? (
                  <p className="text-sm text-[#7D4E35] py-4">
                    لا يوجد طلاب مسجلون في هذه الحلقة حتى الآن.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {halaqaStudents.map((st, idx) => {
                      const isSelected = selectedStudentId === st.id;
                      const num = idx + 1;
                      const quranDays = quranCurriculumRecord
                        ? WEEK_DAYS.filter((d) =>
                            quranCurriculumRecord.days.includes(d.key)
                          ).map((d) => d.label)
                        : [];
                      const stStatus = studentStatuses[st.id];
                      const quranAssigned = Boolean(stStatus?.quranTomorrowAssigned);

                      return (
                        <div
                          key={st.id}
                          className={`rounded-2xl border-2 transition-colors ${
                            isSelected
                              ? 'border-[#F56900] bg-[#FDF6EE]'
                              : 'border-[#EADBC8] bg-white hover:border-[#F56900]/60'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedStudentId((prev) =>
                                prev === st.id ? null : st.id
                              )
                            }
                            className="w-full min-h-[60px] px-3 sm:px-4 py-3 flex items-center justify-between gap-2 sm:gap-3 text-right cursor-pointer"
                          >
                            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                              <span
                                className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center justify-center shrink-0 tabular-nums ${
                                  isSelected
                                    ? 'bg-[#F56900] text-white'
                                    : 'bg-[#FDF6EE] border border-[#EADBC8] text-[#4A220D]'
                                }`}
                              >
                                {toArabicIndicDigits(num)}
                              </span>
                              <div className="min-w-0 space-y-1">
                                {/* Status Badges directly above Student Name */}
                                <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
                                  <span
                                    className={`px-2 py-0.5 rounded-lg border text-[10px] sm:text-[11px] font-extrabold ${
                                      quranAssigned
                                        ? 'bg-[#58CC02]/15 border-[#58CC02]/60 text-[#46A302]'
                                        : 'bg-[#FDF6EE] border-[#EADBC8] text-[#7D4E35]'
                                    }`}
                                  >
                                    {quranAssigned ? '✓ تم تحديد الحفظ' : 'لم يتم تعيين الحفظ'}
                                  </span>

                                  {otherCurricula.length === 1 && (() => {
                                    const bId = otherCurricula[0].bookId;
                                    const bStat = stStatus?.books?.[bId];
                                    const hwAssigned = Boolean(bStat?.tomorrowHomeworkAssigned);
                                    return (
                                      <>
                                        <span
                                          className={`px-2 py-0.5 rounded-lg border text-[10px] sm:text-[11px] font-extrabold ${
                                            hwAssigned
                                              ? 'bg-[#58CC02]/15 border-[#58CC02]/60 text-[#46A302]'
                                              : 'bg-[#FDF6EE] border-[#EADBC8] text-[#7D4E35]'
                                          }`}
                                        >
                                          {hwAssigned
                                            ? '✓ تم تعيين الواجب'
                                            : 'لم يتم تعيين الواجب'}
                                        </span>
                                        {bStat && bStat.whereWeReachedPage > 1 && (
                                          <span className="px-2 py-0.5 rounded-lg border border-[#EADBC8] bg-white text-[10px] sm:text-[11px] font-bold text-[#F56900] tabular-nums">
                                            وصل: ص {toArabicIndicDigits(bStat.whereWeReachedPage)}
                                          </span>
                                        )}
                                      </>
                                    );
                                  })()}

                                  {otherCurricula.length > 1 &&
                                    otherCurricula.map((cur) => {
                                      const bStat = stStatus?.books?.[cur.bookId];
                                      const hwAssigned = Boolean(
                                        bStat?.tomorrowHomeworkAssigned
                                      );
                                      return (
                                        <span
                                          key={`st_badge_${st.id}_${cur.bookId}`}
                                          className={`px-2 py-0.5 rounded-lg border text-[10px] sm:text-[11px] font-extrabold ${
                                            hwAssigned
                                              ? 'bg-[#58CC02]/15 border-[#58CC02]/60 text-[#46A302]'
                                              : 'bg-[#FDF6EE] border-[#EADBC8] text-[#7D4E35]'
                                          }`}
                                        >
                                          {hwAssigned
                                            ? `✓ واجب ${cur.bookTitle}`
                                            : `لم يُعيّن واجب ${cur.bookTitle}`}
                                        </span>
                                      );
                                    })}
                                </div>

                                <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                                  {st.quadrupleName}
                                </p>
                                <p className="text-[11px] sm:text-xs text-[#7D4E35]">
                                  {isSelected
                                    ? 'مقررات اليوم مفتوحة أسفل الطالب'
                                    : 'اضغط لعرض مقررات اليوم'}
                                </p>
                              </div>
                            </div>

                            <span
                              className={`px-2.5 sm:px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1 shrink-0 ${
                                isSelected
                                  ? 'bg-[#F56900] text-white'
                                  : 'bg-[#FDF6EE] text-[#7D4E35]'
                              }`}
                            >
                              <span className="hidden sm:inline">{isSelected ? 'إخفاء' : 'عرض المقررات'}</span>
                              <ChevronLeft
                                className={`w-4 h-4 transition-transform ${
                                  isSelected ? '-rotate-90' : ''
                                }`}
                              />
                            </span>
                          </button>

                          {/* Expanded Daily Curricula Directly Under Selected Student */}
                          {isSelected && (
                            <div className="px-4 pb-4 pt-2 border-t border-[#EADBC8] space-y-3">
                              <p className="text-xs font-extrabold text-[#F56900]">
                                مقررات اليوم للطالب ({st.quadrupleName}):
                              </p>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {/* Primary Featured Card: المصحف الشريف */}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setActiveQuranStudent({
                                      student: st,
                                      studentNumber: num,
                                    })
                                  }
                                  className="text-right bg-white border-2 border-[#58CC02] hover:border-[#F56900] rounded-2xl p-4 space-y-2.5 transition-colors cursor-pointer group"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2.5">
                                      <div className="w-10 h-10 rounded-xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
                                        <BookOpen className="w-5 h-5" />
                                      </div>
                                      <div>
                                        <h3 className="font-display font-extrabold text-base text-[#4A220D] group-hover:text-[#F56900]">
                                          {quranCurriculumRecord?.bookTitle ||
                                            QURAN_MUSHAF_TITLE}
                                        </h3>
                                        <p className="text-xs font-bold text-[#46A302]">
                                          مصحف الملك فهد · الحفظ الجديد والمراجعة والأخطاء
                                        </p>
                                      </div>
                                    </div>
                                    <ChevronLeft className="w-5 h-5 text-[#F56900] shrink-0" />
                                  </div>

                                  {quranDays.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
                                      <CalendarDays className="w-3.5 h-3.5 text-[#46A302]" />
                                      {quranDays.map((lbl) => (
                                        <span
                                          key={lbl}
                                          className="px-2 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#46A302]"
                                        >
                                          {lbl}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  {quranCurriculumRecord?.scheduleNote && (
                                    <p className="text-xs text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-1.5">
                                      {quranCurriculumRecord.scheduleNote}
                                    </p>
                                  )}
                                </button>

                                {/* Other Assigned Curricula Books */}
                                {otherCurricula.map((cur) => {
                                  const dayLabels = WEEK_DAYS.filter((d) =>
                                    cur.days.includes(d.key)
                                  ).map((d) => d.label);
                                  const matchedBook =
                                    books.find((b) => b.id === cur.bookId) || null;
                                  return (
                                    <button
                                      key={cur.id}
                                      type="button"
                                      onClick={() =>
                                        setActiveBookSession({
                                          student: st,
                                          studentNumber: num,
                                          curriculum: cur,
                                          matchedBook,
                                        })
                                      }
                                      className="text-right bg-white border-2 border-[#EADBC8] hover:border-[#F56900] rounded-2xl p-4 space-y-2.5 transition-colors cursor-pointer group"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2.5 min-w-0">
                                          <div className="w-10 h-10 rounded-xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                                            <BookMarked className="w-5 h-5" />
                                          </div>
                                          <div className="min-w-0">
                                            <h3 className="font-display font-extrabold text-base text-[#4A220D] group-hover:text-[#F56900] truncate">
                                              {cur.bookTitle}
                                            </h3>
                                            <p className="text-xs font-bold text-[#7D4E35]">
                                              أين وصلنا · واجبات اليوم وواجبات غد
                                              {matchedBook
                                                ? ` · ${toArabicIndicDigits(matchedBook.totalPages)} صفحة`
                                                : ''}
                                            </p>
                                          </div>
                                        </div>
                                        <ChevronLeft className="w-5 h-5 text-[#F56900] shrink-0" />
                                      </div>

                                      {dayLabels.length > 0 && (
                                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
                                          <CalendarDays className="w-3.5 h-3.5 text-[#46A302]" />
                                          {dayLabels.map((lbl) => (
                                            <span
                                              key={lbl}
                                              className="px-2 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#46A302]"
                                            >
                                              {lbl}
                                            </span>
                                          ))}
                                        </div>
                                      )}

                                      {cur.scheduleNote && (
                                        <p className="text-xs text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-1.5">
                                          {cur.scheduleNote}
                                        </p>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

            {selectedStudentEntry && (
              <p className="text-xs font-bold text-[#7D4E35]">
                الطالب المحدد حالياً: {toArabicIndicDigits(selectedStudentEntry.studentNumber)}.{' '}
                {selectedStudentEntry.student.quadrupleName}
              </p>
            )}
          </div>
        </div>
      ))}

      {tab === 'students' && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
          <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
            طلاب حلقة {context.halaqaName} ({halaqaStudents.length})
          </h2>
          {halaqaStudents.length === 0 ? (
            <p className="text-sm text-[#7D4E35]">لا يوجد طلاب مسجلون في هذه الحلقة.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {halaqaStudents.map((st, idx) => (
                <div
                  key={st.id}
                  className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 flex items-center gap-3"
                >
                  <span className="w-8 h-8 rounded-xl bg-white border border-[#EADBC8] font-display font-extrabold text-xs text-[#7D4E35] inline-flex items-center justify-center shrink-0 tabular-nums">
                    {toArabicIndicDigits(idx + 1)}
                  </span>
                  <div className="min-w-0">
                    <p className="font-display font-extrabold text-sm text-[#4A220D] truncate">
                      {st.quadrupleName}
                    </p>
                    <p className="text-xs text-[#7D4E35] truncate">
                      {st.email || 'مسجل بالدخول السريع'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>

      {/* Mobile Fixed Bottom Navigation Bar */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t-2 border-[#EADBC8] px-2 pt-1.5 pb-safe"
        aria-label="تنقل المعلم"
      >
        <div className="max-w-lg mx-auto grid grid-cols-4 gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  if (item.id !== 'curricula') {
                    setActiveQuranStudent(null);
                    setActiveBookSession(null);
                  }
                }}
                className={`min-h-[48px] px-1 py-1 rounded-xl flex flex-col items-center justify-center gap-0.5 font-display text-[11px] font-extrabold transition-colors cursor-pointer ${
                  active ? 'text-[#F56900] bg-[#FDF6EE]' : 'text-[#7D4E35]'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="truncate max-w-full">{item.mobileLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>

    {/* General Teacher Mushaf Modal */}
    {generalMushafOpen && (
      <KingFahdMushafReader
        studentName="الشرح العام للمعلم"
        headerSubtitle={`مصحف الملك فهد · القراءة والشرح العام لحلقة ${context.halaqaName}`}
        readOnlyMistakes
        initialPage={teacherMushafPage}
        highlightRanges={[]}
        mistakes={{}}
        onMistakesChange={() => {}}
        onCloseWithPage={(p) => saveTeacherMushafBookmark(p)}
        onClose={() => setGeneralMushafOpen(false)}
      />
    )}

    {/* General Teacher Interactive Book Reader Modal */}
    {generalBookReader && (
      <TeacherBookReaderModal
        workspace={workspace}
        bookId={generalBookReader.curriculum.bookId}
        bookTitle={generalBookReader.curriculum.bookTitle}
        studentName="الشرح العام للمعلم"
        totalPagesHint={generalBookReader.matchedBook?.totalPages || 1}
        initialPage={generalBookReader.initialPage}
        mode="read"
        currentUserId={currentUserId}
        onStoppedAtPage={(stoppedPage) => {
          saveTeacherBookBookmark(generalBookReader.curriculum.bookId, stoppedPage);
          if (halaqaStudents.length > 0) {
            setBookPropagationPrompt({
              curriculum: generalBookReader.curriculum,
              stoppedPage,
            });
          } else {
            setGroupFeedback(
              `تم حفظ موضع توقف المعلم عند صفحة ${toArabicIndicDigits(stoppedPage)}.`
            );
          }
        }}
        onClose={() => setGeneralBookReader(null)}
      />
    )}

    {/* Prompt: Propagate Reached Book Page to Checked Students */}
    {bookPropagationPrompt && (
      <BookReachedPropagationModal
        workspace={workspace}
        context={context}
        curriculum={bookPropagationPrompt.curriculum}
        stoppedPage={bookPropagationPrompt.stoppedPage}
        students={halaqaStudents}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        onSuccess={(msg) => {
          setGroupFeedback(msg);
          void refreshStudentStatuses();
        }}
        onClose={() => setBookPropagationPrompt(null)}
      />
    )}

    {/* Group Book Tomorrow Homework Modal */}
    {groupBookHomeworkModal && (
      <GroupBookHomeworkModal
        workspace={workspace}
        context={context}
        curriculum={groupBookHomeworkModal.curriculum}
        totalPagesHint={groupBookHomeworkModal.matchedBook?.totalPages || 1}
        defaultPage={teacherBookPages[groupBookHomeworkModal.curriculum.bookId] || 1}
        students={halaqaStudents}
        statuses={studentStatuses}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        onSuccess={(msg) => {
          setGroupFeedback(msg);
          void refreshStudentStatuses();
        }}
        onClose={() => setGroupBookHomeworkModal(null)}
      />
    )}

    {/* Group Quran Tomorrow Hifz & Reviews Modal */}
    {groupQuranModalOpen && (
      <GroupQuranPlanModal
        workspace={workspace}
        context={context}
        students={halaqaStudents}
        statuses={studentStatuses}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        onSuccess={(msg) => {
          setGroupFeedback(msg);
          void refreshStudentStatuses();
        }}
        onClose={() => setGroupQuranModalOpen(false)}
      />
    )}

    {/* Batch Quran Today Tasmee Modal */}
    {batchQuranTasmeeOpen && (
      <BatchQuranTasmeeModal
        workspace={workspace}
        context={context}
        students={halaqaStudents}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        onSuccess={(msg) => {
          setGroupFeedback(msg);
          void refreshStudentStatuses();
        }}
        onClose={() => setBatchQuranTasmeeOpen(false)}
      />
    )}

    {/* Batch Book Today Homework Correction Modal */}
    {batchBookCorrectionBookId && otherCurricula.length > 0 && (
      <BatchBookCorrectionModal
        workspace={workspace}
        context={context}
        curricula={otherCurricula}
        initialBookId={batchBookCorrectionBookId}
        students={halaqaStudents}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        onSuccess={(msg) => {
          setGroupFeedback(msg);
          void refreshStudentStatuses();
        }}
        onClose={() => setBatchBookCorrectionBookId(null)}
      />
    )}
  </div>
  );
};

