import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { signOut } from 'firebase/auth';
import {
  Award,
  BarChart3,
  BookOpen,
  Building2,
  GraduationCap,
  Home,
  Layers,
  LogOut,
  Medal,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react';
import { getAuthForConfig } from '../services/multiDb';
import {
  loadSupervisorDashboardAnalytics,
  loadSupervisorWorkspace,
  type ComplexWorkspaceData,
} from '../services/platformService';
import type {
  ActiveSession,
  DailyStatsRecord,
  HalaqaRankingItem,
  StudentRankingItem,
} from '../types/platform';
import { BookLibrarySection } from './BookLibrarySection';
import { ComplexWorkspace } from './ComplexWorkspace';
import { ModernLoader } from './ModernLoader';
import { PWAInstallButton } from './PWAInstallButton';

interface SupervisorDashboardProps {
  session: ActiveSession;
  onExitQuickSession: () => void;
}

type SupervisorTab = 'home' | 'accounts_mosques' | 'library';

const BASE_URL = import.meta.env.BASE_URL;

export const SupervisorDashboard: React.FC<SupervisorDashboardProps> = ({
  session,
  onExitQuickSession,
}) => {
  const [tab, setTab] = useState<SupervisorTab>('home');
  const [workspace, setWorkspace] = useState<ComplexWorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [todayStats, setTodayStats] = useState<DailyStatsRecord | null>(null);
  const [globalStats, setGlobalStats] = useState<DailyStatsRecord | null>(null);
  const [topHalaqat, setTopHalaqat] = useState<HalaqaRankingItem[]>([]);
  const [topStudents, setTopStudents] = useState<StudentRankingItem[]>([]);

  const restrictMosqueIds = useMemo(() => {
    const ids = session.account.mosqueIds?.length
      ? session.account.mosqueIds
      : session.account.mosqueId
      ? [session.account.mosqueId]
      : [];
    return ids;
  }, [session.account.mosqueId, session.account.mosqueIds]);

  const isComplexWide = restrictMosqueIds.length === 0;

  const loadAll = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const ws = await loadSupervisorWorkspace(session);
        setWorkspace(ws);
        const analytics = await loadSupervisorDashboardAnalytics(
          ws,
          restrictMosqueIds.length > 0 ? restrictMosqueIds : undefined
        );
        setTodayStats(analytics.todayStats);
        setGlobalStats(analytics.globalStats);
        setTopHalaqat(analytics.topHalaqat);
        setTopStudents(analytics.topStudents);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'تعذّر تحميل لوحة مشرف المجمع، يرجى المحاولة مجدداً.'
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [session, restrictMosqueIds]
  );

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  const handleLogout = async () => {
    if (session.mode === 'quick') {
      onExitQuickSession();
      return;
    }
    await signOut(getAuthForConfig(session.authConfig));
  };

  // Scoped metrics for Home Dashboard
  const scopedSummary = useMemo(() => {
    if (!workspace) {
      return {
        mosquesCount: 0,
        halaqatCount: 0,
        studentsCount: 0,
        teachersCount: 0,
        activeStudentsToday: 0,
        mosqueSeries: [] as { id: string; name: string; students: number; halaqat: number }[],
      };
    }
    const allowedSet = restrictMosqueIds.length > 0 ? new Set(restrictMosqueIds) : null;
    const mosques = allowedSet
      ? workspace.mosques.filter((m) => allowedSet.has(m.id))
      : workspace.mosques;
    const halaqat = allowedSet
      ? workspace.halaqat.filter((h) => allowedSet.has(h.mosqueId))
      : workspace.halaqat;
    const accounts = allowedSet
      ? workspace.accounts.filter(
          (a) =>
            allowedSet.has(a.mosqueId) ||
            a.mosqueIds.some((id) => allowedSet.has(id))
        )
      : workspace.accounts;

    const students = accounts.filter((a) => a.role === 'student');
    const teachers = accounts.filter((a) => a.role === 'teacher');
    const todayPrefix = todayStats?.dateKey.replace(/^daily_/, '') || '';
    const activeStudentsToday = students.filter(
      (s) => s.lastLoginDate === todayPrefix
    ).length;

    const mosqueSeries = mosques.slice(0, 6).map((m) => ({
      id: m.id,
      name: m.name,
      students: students.filter((s) => s.mosqueId === m.id).length,
      halaqat: halaqat.filter((h) => h.mosqueId === m.id).length,
    }));

    return {
      mosquesCount: mosques.length,
      halaqatCount: halaqat.length,
      studentsCount: students.length,
      teachersCount: teachers.length,
      activeStudentsToday,
      mosqueSeries,
    };
  }, [workspace, restrictMosqueIds, todayStats]);

  // SVG Donut math for Complex Engagement breakdown
  const donutMetrics = useMemo(() => {
    const s = scopedSummary.studentsCount;
    const t = scopedSummary.teachersCount;
    const h = scopedSummary.halaqatCount;
    const total = Math.max(1, s + t + h);
    const r = 44;
    const c = 2 * Math.PI * r;
    const studentsLen = (s / total) * c;
    const teachersLen = (t / total) * c;
    const halaqatLen = (h / total) * c;
    return { r, c, studentsLen, teachersLen, halaqatLen, rawTotal: s + t + h };
  }, [scopedSummary]);

  const maxMosqueBarValue = useMemo(() => {
    return Math.max(
      1,
      ...scopedSummary.mosqueSeries.map((m) => Math.max(m.students, m.halaqat))
    );
  }, [scopedSummary.mosqueSeries]);

  const navItems: { id: SupervisorTab; label: string; icon: typeof Home }[] = [
    { id: 'home', label: 'الرئيسية', icon: Home },
    { id: 'accounts_mosques', label: 'الحسابات والمساجد', icon: Building2 },
    { id: 'library', label: 'الملفات والكتب', icon: BookOpen },
  ];

  const rankMedals = [
    {
      label: 'المركز الأول',
      bg: 'bg-[#F56900]/10 border-[#F56900]',
      badge: 'bg-[#F56900] text-white',
    },
    {
      label: 'المركز الثاني',
      bg: 'bg-[#58CC02]/10 border-[#58CC02]',
      badge: 'bg-[#58CC02] text-white',
    },
    {
      label: 'المركز الثالث',
      bg: 'bg-[#FDF6EE] border-[#EADBC8]',
      badge: 'bg-[#4A220D] text-white',
    },
  ];

  return (
    <div className="min-h-screen bg-[#FDF6EE] text-[#4A220D] flex flex-col justify-between pb-20 md:pb-0">
      {/* Top Clean Navigation Header — Zero DB Details */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={`${BASE_URL}icon.svg`}
              alt="براعم عمران"
              className="w-9 h-9 rounded-xl border border-[#EADBC8] shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] whitespace-nowrap">
                  براعم عمران
                </span>
                <span className="hidden sm:inline text-xs font-bold text-[#F56900] whitespace-nowrap">
                  · {isComplexWide ? 'إشراف المجمع بالكامل' : 'إشراف المسجد'}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs font-bold text-[#7D4E35] truncate">
                {workspace?.complex.name || session.complexName || 'المجمع القرآني'}
              </p>
            </div>
          </div>

          {/* Desktop 3 Main Tabs */}
          <nav
            aria-label="أقسام لوحة المشرف"
            className="hidden md:flex items-center gap-1.5 bg-[#FDF6EE] p-1.5 rounded-2xl border border-[#EADBC8]"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`min-h-[40px] px-4 py-1.5 rounded-xl font-display text-sm font-bold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
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

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton variant="compact" />
            <button
              type="button"
              onClick={() => void loadAll(true)}
              disabled={refreshing || loading}
              aria-label="تحديث البيانات"
              className="min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#7D4E35] hover:text-[#4A220D] inline-flex items-center gap-1.5 font-display font-bold text-xs cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 text-[#F56900] ${refreshing ? 'animate-spin' : ''}`}
              />
              <span className="hidden lg:inline">تحديث</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="min-h-[42px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#7D4E35] hover:text-[#4A220D] font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">خروج</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {loading ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
            <ModernLoader label="جاري تحميل إحصائيات المجمع..." />
          </div>
        ) : error || !workspace ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8 text-center space-y-4 max-w-lg mx-auto">
            <h2 className="font-display text-xl font-extrabold text-[#4A220D]">
              تعذّر فتح لوحة المشرف
            </h2>
            <p className="text-sm text-[#7D4E35]">
              {error || 'تأكد من ارتباط الحساب بمجمع قرآني صالح ثم أعد المحاولة.'}
            </p>
            <button
              type="button"
              onClick={() => void loadAll(false)}
              className="duo-btn-orange min-h-[44px] px-6 rounded-2xl font-display font-bold text-sm cursor-pointer"
            >
              إعادة المحاولة
            </button>
          </div>
        ) : (
          <>
            {/* ==================== TAB 1: HOME ANALYTICS ==================== */}
            {tab === 'home' && (
              <div className="space-y-6">
                {/* Compact Supervisor Welcome Banner */}
                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold text-[#F56900]">
                      مرحباً أيها المشرف الفاضل
                    </p>
                    <h1 className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D] mt-0.5">
                      {session.account.quadrupleName}
                    </h1>
                    <p className="text-xs sm:text-sm text-[#7D4E35] mt-1">
                      لوحة متابعة الإنجاز اليومي والترتيب التنافسي في{' '}
                      <strong className="text-[#4A220D]">{workspace.complex.name}</strong>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setTab('accounts_mosques')}
                      className="duo-btn-cream min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Users className="w-4 h-4 text-[#F56900]" />
                      <span>الحسابات والمساجد</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab('library')}
                      className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <BookOpen className="w-4 h-4" />
                      <span>الملفات والكتب</span>
                    </button>
                  </div>
                </div>

                {/* 5 Core KPI Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
                  <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-bold text-[#7D4E35]">
                        الآيات المسمّعة اليوم
                      </span>
                      <Sparkles className="w-4 h-4 text-[#F56900] shrink-0" />
                    </div>
                    <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#F56900] tabular-nums">
                      {todayStats?.recitedAyahs || 0}
                    </p>
                    <p className="text-[11px] font-bold text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي الكلي: {globalStats?.recitedAyahs || 0} آية
                    </p>
                  </div>

                  <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-bold text-[#7D4E35]">
                        الأوجه المسمّعة اليوم
                      </span>
                      <BookOpen className="w-4 h-4 text-[#58CC02] shrink-0" />
                    </div>
                    <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#46A302] tabular-nums">
                      {todayStats?.recitedPages || 0}
                    </p>
                    <p className="text-[11px] font-bold text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي الكلي: {globalStats?.recitedPages || 0} وجه
                    </p>
                  </div>

                  <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-bold text-[#7D4E35]">عدد الطلاب</span>
                      <GraduationCap className="w-4 h-4 text-[#F56900] shrink-0" />
                    </div>
                    <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#4A220D] tabular-nums">
                      {scopedSummary.studentsCount}
                    </p>
                    <p className="text-[11px] font-bold text-[#46A302] mt-1 tabular-nums">
                      حضور اليوم: {scopedSummary.activeStudentsToday} طالب
                    </p>
                  </div>

                  <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-bold text-[#7D4E35]">عدد المعلمين</span>
                      <Users className="w-4 h-4 text-[#F56900] shrink-0" />
                    </div>
                    <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#4A220D] tabular-nums">
                      {scopedSummary.teachersCount}
                    </p>
                    <p className="text-[11px] font-bold text-[#7D4E35] mt-1 tabular-nums">
                      دخول المعلمين اليوم: {todayStats?.teacherLogins || 0}
                    </p>
                  </div>

                  <div className="col-span-2 lg:col-span-1 bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-bold text-[#7D4E35]">عدد الحلقات</span>
                      <Layers className="w-4 h-4 text-[#F56900] shrink-0" />
                    </div>
                    <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#4A220D] tabular-nums">
                      {scopedSummary.halaqatCount}
                    </p>
                    <p className="text-[11px] font-bold text-[#7D4E35] mt-1 tabular-nums">
                      في {scopedSummary.mosquesCount} مسجد
                    </p>
                  </div>
                </div>

                {/* Graphical Charts Row (SVG Visualizations) */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Chart A: Complex Mosques Bar Comparison */}
                  <div className="lg:col-span-7 bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <BarChart3 className="w-5 h-5 text-[#F56900]" />
                        <h2 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                          توزيع الطلاب والحلقات حسب المساجد
                        </h2>
                      </div>
                      <div className="flex items-center gap-4 text-xs font-bold text-[#7D4E35]">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded-sm bg-[#F56900] inline-block" />
                          الطلاب
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded-sm bg-[#58CC02] inline-block" />
                          الحلقات
                        </span>
                      </div>
                    </div>

                    {scopedSummary.mosqueSeries.length === 0 ? (
                      <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center text-sm text-[#7D4E35]">
                        لا توجد مساجد مضافة في النطاق الحالي لعرض الرسم البياني.
                      </div>
                    ) : (
                      <div className="space-y-3.5">
                        {scopedSummary.mosqueSeries.map((item) => {
                          const studentsPct = Math.max(
                            4,
                            Math.round((item.students / maxMosqueBarValue) * 100)
                          );
                          const halaqatPct = Math.max(
                            4,
                            Math.round((item.halaqat / maxMosqueBarValue) * 100)
                          );
                          return (
                            <div
                              key={item.id}
                              className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 space-y-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-display font-extrabold text-sm text-[#4A220D]">
                                  {item.name}
                                </span>
                                <span className="text-xs font-bold text-[#7D4E35] tabular-nums">
                                  {item.students} طالب · {item.halaqat} حلقة
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                <div className="w-full h-3 rounded-full bg-white border border-[#EADBC8] overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#F56900] transition-all duration-500"
                                    style={{ width: `${studentsPct}%` }}
                                  />
                                </div>
                                <div className="w-full h-2.5 rounded-full bg-white border border-[#EADBC8] overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#58CC02] transition-all duration-500"
                                    style={{ width: `${halaqatPct}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Chart B: SVG Donut Chart of Complex Composition & Recitation Summary */}
                  <div className="lg:col-span-5 bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-col justify-between gap-4">
                    <div>
                      <h2 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                        مؤشر قوى المجمع والتلاوة
                      </h2>
                      <p className="text-xs text-[#7D4E35]">
                        نسبة الطلاب والمعلمين والحلقات وإجمالي النشاط اليومي
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row lg:flex-col xl:flex-row items-center gap-6 py-2">
                      {/* Crisp SVG Donut */}
                      <div className="relative w-36 h-36 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                          <circle
                            cx="60"
                            cy="60"
                            r={donutMetrics.r}
                            fill="transparent"
                            stroke="#F7EBDD"
                            strokeWidth="16"
                          />
                          {donutMetrics.rawTotal > 0 && (
                            <>
                              <circle
                                cx="60"
                                cy="60"
                                r={donutMetrics.r}
                                fill="transparent"
                                stroke="#F56900"
                                strokeWidth="16"
                                strokeDasharray={`${donutMetrics.studentsLen} ${donutMetrics.c}`}
                                strokeDashoffset={0}
                              />
                              <circle
                                cx="60"
                                cy="60"
                                r={donutMetrics.r}
                                fill="transparent"
                                stroke="#58CC02"
                                strokeWidth="16"
                                strokeDasharray={`${donutMetrics.teachersLen} ${donutMetrics.c}`}
                                strokeDashoffset={-donutMetrics.studentsLen}
                              />
                              <circle
                                cx="60"
                                cy="60"
                                r={donutMetrics.r}
                                fill="transparent"
                                stroke="#4A220D"
                                strokeWidth="16"
                                strokeDasharray={`${donutMetrics.halaqatLen} ${donutMetrics.c}`}
                                strokeDashoffset={
                                  -(donutMetrics.studentsLen + donutMetrics.teachersLen)
                                }
                              />
                            </>
                          )}
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                          <span className="font-display text-2xl font-extrabold text-[#4A220D] tabular-nums">
                            {donutMetrics.rawTotal}
                          </span>
                          <span className="text-[11px] font-bold text-[#7D4E35]">
                            إجمالي الركائز
                          </span>
                        </div>
                      </div>

                      <div className="flex-1 w-full space-y-2.5 text-xs font-bold">
                        <div className="flex items-center justify-between bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-2">
                          <span className="inline-flex items-center gap-2 text-[#4A220D]">
                            <span className="w-3 h-3 rounded-sm bg-[#F56900]" />
                            الطلاب
                          </span>
                          <span className="tabular-nums text-[#F56900]">
                            {scopedSummary.studentsCount}
                          </span>
                        </div>
                        <div className="flex items-center justify-between bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-2">
                          <span className="inline-flex items-center gap-2 text-[#4A220D]">
                            <span className="w-3 h-3 rounded-sm bg-[#58CC02]" />
                            المعلمون
                          </span>
                          <span className="tabular-nums text-[#46A302]">
                            {scopedSummary.teachersCount}
                          </span>
                        </div>
                        <div className="flex items-center justify-between bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-2">
                          <span className="inline-flex items-center gap-2 text-[#4A220D]">
                            <span className="w-3 h-3 rounded-sm bg-[#4A220D]" />
                            الحلقات
                          </span>
                          <span className="tabular-nums text-[#4A220D]">
                            {scopedSummary.halaqatCount}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl px-4 py-3 flex items-center justify-between text-xs font-bold">
                      <span className="text-[#7D4E35]">زيارات المجمع اليوم:</span>
                      <span className="font-display text-base text-[#F56900] tabular-nums">
                        {todayStats?.totalVisits || 0} زيارة
                      </span>
                    </div>
                  </div>
                </div>

                {/* Top 3 Leaderboards: Best 3 Halaqat + Best Students */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Top 3 Halaqat */}
                  <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Award className="w-5 h-5 text-[#F56900]" />
                        <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
                          أفضل ٣ حلقات من ناحية الإنجاز
                        </h2>
                      </div>
                    </div>

                    {topHalaqat.length === 0 ? (
                      <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center space-y-2">
                        <p className="text-sm font-bold text-[#7D4E35]">
                          لا توجد حلقات مسجلة حتى الآن.
                        </p>
                        <button
                          type="button"
                          onClick={() => setTab('accounts_mosques')}
                          className="text-xs font-extrabold text-[#F56900] hover:underline cursor-pointer"
                        >
                          إضافة المساجد والحلقات الآن
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {topHalaqat.slice(0, 3).map((hlq, idx) => {
                          const style = rankMedals[idx] || rankMedals[2];
                          return (
                            <div
                              key={hlq.halaqaId}
                              className={`border-2 rounded-2xl p-4 flex items-center justify-between gap-3 ${style.bg}`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <span
                                  className={`w-10 h-10 rounded-xl font-display font-extrabold text-sm inline-flex items-center justify-center shrink-0 tabular-nums ${style.badge}`}
                                >
                                  #{idx + 1}
                                </span>
                                <div className="min-w-0">
                                  <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                                    {hlq.halaqaName}
                                  </p>
                                  <p className="text-xs text-[#7D4E35] truncate">
                                    {hlq.mosqueName} · {hlq.studentsCount} طالب ·{' '}
                                    {hlq.teachersCount} معلم
                                  </p>
                                </div>
                              </div>

                              <div className="text-left shrink-0">
                                <p className="font-display font-extrabold text-sm sm:text-base text-[#F56900] tabular-nums">
                                  {hlq.achievementScore} نقطة
                                </p>
                                <p className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
                                  {hlq.recitedAyahs} آية · {hlq.recitedPages} وجه
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Top Students */}
                  <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Medal className="w-5 h-5 text-[#58CC02]" />
                        <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
                          أفضل الطلاب من ناحية الإنجاز
                        </h2>
                      </div>
                    </div>

                    {topStudents.length === 0 ? (
                      <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center space-y-2">
                        <p className="text-sm font-bold text-[#7D4E35]">
                          لا يوجد طلاب مسجلون بعد في المجمع.
                        </p>
                        <button
                          type="button"
                          onClick={() => setTab('accounts_mosques')}
                          className="text-xs font-extrabold text-[#F56900] hover:underline cursor-pointer"
                        >
                          إنشاء رابط تسجيل للطلاب
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {topStudents.slice(0, 5).map((st, idx) => {
                          const style = rankMedals[idx] || rankMedals[2];
                          return (
                            <div
                              key={st.accountId}
                              className={`border-2 rounded-2xl p-4 flex items-center justify-between gap-3 ${style.bg}`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <span
                                  className={`w-10 h-10 rounded-xl font-display font-extrabold text-sm inline-flex items-center justify-center shrink-0 tabular-nums ${style.badge}`}
                                >
                                  #{idx + 1}
                                </span>
                                <div className="min-w-0">
                                  <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                                    {st.studentName}
                                  </p>
                                  <p className="text-xs text-[#7D4E35] truncate">
                                    {st.halaqaName} · {st.mosqueName}
                                  </p>
                                </div>
                              </div>

                              <div className="text-left shrink-0">
                                <p className="font-display font-extrabold text-sm sm:text-base text-[#46A302] tabular-nums">
                                  {st.achievementScore} نقطة
                                </p>
                                <p className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
                                  {st.recitedAyahs} آية · {st.recitedPages} وجه
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            )}

            {/* ==================== TAB 2: ACCOUNTS & MOSQUES (NO DB CONTROLS) ==================== */}
            {tab === 'accounts_mosques' && (
              <ComplexWorkspace
                discovered={workspace.discovered}
                connectedDbs={[]}
                onBack={() => setTab('home')}
                onComplexRelocated={async () => {}}
                supervisorMode
                initialWorkspace={workspace}
                restrictMosqueIds={restrictMosqueIds}
                onWorkspaceMutated={async () => {
                  await loadAll(true);
                }}
              />
            )}

            {/* ==================== TAB 3: LIBRARY & SMART BOOKS ==================== */}
            {tab === 'library' && (
              <BookLibrarySection
                workspace={workspace}
                currentUserId={session.account.uid || session.account.id}
              />
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav
        aria-label="التنقل السفلي للمشرف"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-md border-t-2 border-[#EADBC8] px-3 py-2 flex items-center justify-around gap-1"
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex-1 min-h-[46px] py-1.5 px-2 rounded-2xl flex flex-col items-center justify-center gap-0.5 font-display text-[11px] font-bold cursor-pointer transition-colors ${
                active ? 'bg-[#F56900] text-white' : 'text-[#7D4E35]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <footer className="hidden md:block py-4 px-4 text-center text-xs sm:text-sm font-medium text-[#7D4E35]">
        منصة براعم عمران · جميع الحقوق محفوظة لاستيديو expraiment
      </footer>
    </div>
  );
};
