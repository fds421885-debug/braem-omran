import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookMarked,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  GraduationCap,
  Users,
} from 'lucide-react';
import {
  listCurriculaInComplex,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  WEEK_DAYS,
  type CurriculumRecord,
  type TeacherRoleContext,
} from '../types/platform';
import { AttendanceSection } from './AttendanceSection';
import { ModernLoader } from './ModernLoader';
import { NotificationPermissionButton } from './NotificationPermissionButton';
import { PWAInstallButton } from './PWAInstallButton';

interface TeacherDashboardViewProps {
  workspace: ComplexWorkspaceData;
  context: TeacherRoleContext;
  currentUserId: string;
  currentUserName: string;
  onReturnToSupervisor: () => void;
}

type TeacherViewTab = 'overview' | 'attendance' | 'curricula' | 'students';

export const TeacherDashboardView: React.FC<TeacherDashboardViewProps> = ({
  workspace,
  context,
  currentUserId,
  currentUserName,
  onReturnToSupervisor,
}) => {
  const [tab, setTab] = useState<TeacherViewTab>('overview');
  const [curricula, setCurricula] = useState<CurriculumRecord[]>([]);
  const [loadingCurricula, setLoadingCurricula] = useState(true);

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

  const navItems: { id: TeacherViewTab; label: string; icon: typeof Users }[] = [
    { id: 'overview', label: 'الرئيسية للمعلم', icon: BookOpen },
    { id: 'attendance', label: 'تحضير الحلقة', icon: ClipboardCheck },
    { id: 'curricula', label: 'المقررات', icon: BookMarked },
    { id: 'students', label: `الطلاب (${halaqaStudents.length})`, icon: GraduationCap },
  ];

  return (
    <div className="min-h-screen bg-[#FDF6EE] text-[#4A220D] flex flex-col pb-8">
      {/* Top Bar with Prominent Return to Supervisor Button */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-16 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-0">
            <p className="text-xs font-extrabold text-[#F56900]">
              وضع المعلم · {context.mosqueName}
            </p>
            <h1 className="font-display text-base sm:text-xl font-extrabold text-[#4A220D] truncate">
              {context.halaqaName}
            </h1>
          </div>

          <nav className="flex items-center gap-1.5 bg-[#FDF6EE] p-1 rounded-2xl border border-[#EADBC8] overflow-x-auto max-w-full">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
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
              className="duo-btn-green min-h-[42px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap"
            >
              <ArrowRight className="w-4 h-4" />
              <span>العودة لدور المشرف</span>
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
                  <span>عرض مقررات الحلقة</span>
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
                  {halaqaCurricula.length}
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

        {tab === 'curricula' && (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
            <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
              مقررات حلقة {context.halaqaName}
            </h2>
            {loadingCurricula ? (
              <ModernLoader label="جاري تحميل مقررات الحلقة..." />
            ) : halaqaCurricula.length === 0 ? (
              <p className="text-sm text-[#7D4E35] py-4">
                لا توجد مقررات مضافة لهذه الحلقة حتى الآن.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {halaqaCurricula.map((cur) => {
                  const dayLabels = WEEK_DAYS.filter((d) => cur.days.includes(d.key)).map(
                    (d) => d.label
                  );
                  return (
                    <div
                      key={cur.id}
                      className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <BookOpen className="w-5 h-5 text-[#F56900]" />
                        <h3 className="font-display font-extrabold text-base text-[#4A220D]">
                          {cur.bookTitle}
                        </h3>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
                        <CalendarDays className="w-4 h-4 text-[#46A302]" />
                        {dayLabels.map((lbl) => (
                          <span
                            key={lbl}
                            className="px-2.5 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#46A302]"
                          >
                            {lbl}
                          </span>
                        ))}
                      </div>
                      {cur.scheduleNote && (
                        <p className="text-xs text-[#7D4E35] bg-white border border-[#EADBC8] rounded-xl px-3 py-1.5">
                          {cur.scheduleNote}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

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
                      {idx + 1}
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
