import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookMarked,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ClipboardCheck,
  GraduationCap,
  LogOut,
  Users,
} from 'lucide-react';
import { toArabicIndicDigits } from '../services/mushafService';
import {
  listCurriculaInComplex,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  QURAN_MUSHAF_BOOK_ID,
  QURAN_MUSHAF_TITLE,
  WEEK_DAYS,
  type AccountRecord,
  type CurriculumRecord,
  type TeacherRoleContext,
} from '../types/platform';
import { AttendanceSection } from './AttendanceSection';
import { ModernLoader } from './ModernLoader';
import { NotificationPermissionButton } from './NotificationPermissionButton';
import { PWAInstallButton } from './PWAInstallButton';
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
  const [loadingCurricula, setLoadingCurricula] = useState(true);

  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [activeQuranStudent, setActiveQuranStudent] = useState<{
    student: AccountRecord;
    studentNumber: number;
  } | null>(null);

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

  // Clear selected student when switching halaqa context
  useEffect(() => {
    setSelectedStudentId(null);
    setActiveQuranStudent(null);
  }, [context.halaqaId]);

  const loadCurricula = useCallback(async () => {
    setLoadingCurricula(true);
    try {
      const list = await listCurriculaInComplex(workspace);
      setCurricula(list);
    } finally {
      setLoadingCurricula(false);
    }
  }, [workspace]);

  useEffect(() => {
    void loadCurricula();
  }, [loadCurricula]);

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

  const navItems: { id: TeacherViewTab; label: string; icon: typeof Users }[] = [
    { id: 'overview', label: 'الرئيسية للمعلم', icon: BookOpen },
    { id: 'attendance', label: 'تحضير الحلقة', icon: ClipboardCheck },
    { id: 'curricula', label: 'المقررات', icon: BookMarked },
    { id: 'students', label: `الطلاب (${halaqaStudents.length})`, icon: GraduationCap },
  ];

  return (
    <div className="min-h-screen bg-[#FDF6EE] text-[#4A220D] flex flex-col pb-8" dir="rtl">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-16 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-0">
            <p className="text-xs font-extrabold text-[#F56900]">
              وضع المعلم · {context.mosqueName}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-base sm:text-xl font-extrabold text-[#4A220D] truncate">
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
                  className="min-h-[34px] px-2.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-xs font-bold text-[#4A220D] cursor-pointer"
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

          <nav className="flex items-center gap-1.5 bg-[#FDF6EE] p-1 rounded-2xl border border-[#EADBC8] overflow-x-auto max-w-full">
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
                    }
                  }}
                  className={`min-h-[38px] px-3 py-1.5 rounded-xl font-display text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
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

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <NotificationPermissionButton variant="compact" />
            <PWAInstallButton variant="compact" />
            <button
              type="button"
              onClick={onReturnToSupervisor}
              className={`${
                isStandaloneTeacher
                  ? 'min-h-[42px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#7D4E35] hover:text-[#4A220D] font-display font-bold text-xs sm:text-sm'
                  : 'duo-btn-green min-h-[42px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm'
              } inline-flex items-center gap-2 cursor-pointer whitespace-nowrap`}
            >
              {isStandaloneTeacher ? (
                <>
                  <LogOut className="w-4 h-4" />
                  <span>تسجيل الخروج</span>
                </>
              ) : (
                <>
                  <ArrowRight className="w-4 h-4" />
                  <span>العودة لدور المشرف</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
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

              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => setTab('attendance')}
                  className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <ClipboardCheck className="w-4 h-4" />
                  <span>تحضير طلاب الحلقة</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('curricula')}
                  className="duo-btn-cream min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <BookMarked className="w-4 h-4 text-[#F56900]" />
                  <span>مقررات الطلاب والمصحف</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5">
                <p className="text-xs font-bold text-[#7D4E35]">عدد طلاب الحلقة</p>
                <p className="font-display text-3xl font-extrabold text-[#F56900] mt-2 tabular-nums">
                  {halaqaStudents.length}
                </p>
              </div>
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5">
                <p className="text-xs font-bold text-[#7D4E35]">المقررات المسندة للحلقة</p>
                <p className="font-display text-3xl font-extrabold text-[#46A302] mt-2 tabular-nums">
                  {Math.max(1, halaqaCurricula.length)}
                </p>
              </div>
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5">
                <p className="text-xs font-bold text-[#7D4E35]">المسجد التابع له</p>
                <p className="font-display text-lg font-extrabold text-[#4A220D] mt-2 truncate">
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
              onBack={() => setActiveQuranStudent(null)}
            />
          ) : (
            <div className="space-y-5">
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
                            className="w-full min-h-[60px] px-4 py-3 flex items-center justify-between gap-3 text-right cursor-pointer"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span
                                className={`w-9 h-9 rounded-xl font-display font-extrabold text-sm inline-flex items-center justify-center shrink-0 tabular-nums ${
                                  isSelected
                                    ? 'bg-[#F56900] text-white'
                                    : 'bg-[#FDF6EE] border border-[#EADBC8] text-[#4A220D]'
                                }`}
                              >
                                {toArabicIndicDigits(num)}
                              </span>
                              <div className="min-w-0">
                                <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                                  {st.quadrupleName}
                                </p>
                                <p className="text-xs text-[#7D4E35]">
                                  {isSelected
                                    ? 'مقررات اليوم مفتوحة أسفل الطالب'
                                    : 'اضغط لعرض مقررات اليوم'}
                                </p>
                              </div>
                            </div>

                            <span
                              className={`px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1 shrink-0 ${
                                isSelected
                                  ? 'bg-[#F56900] text-white'
                                  : 'bg-[#FDF6EE] text-[#7D4E35]'
                              }`}
                            >
                              <span>{isSelected ? 'إخفاء' : 'عرض المقررات'}</span>
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
                                  return (
                                    <div
                                      key={cur.id}
                                      className="bg-white border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2.5"
                                    >
                                      <div className="flex items-center gap-2.5">
                                        <div className="w-10 h-10 rounded-xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                                          <BookMarked className="w-5 h-5" />
                                        </div>
                                        <div>
                                          <h3 className="font-display font-extrabold text-base text-[#4A220D]">
                                            {cur.bookTitle}
                                          </h3>
                                          <p className="text-xs text-[#7D4E35]">مقرر الحلقة</p>
                                        </div>
                                      </div>
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
                                      {cur.scheduleNote && (
                                        <p className="text-xs text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-1.5">
                                          {cur.scheduleNote}
                                        </p>
                                      )}
                                    </div>
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
    </div>
  );
};

