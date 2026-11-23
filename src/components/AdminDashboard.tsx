import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { signOut } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import {
  BookOpen,
  Building2,
  CheckCircle2,
  Database,
  Edit3,
  Eye,
  GraduationCap,
  Home,
  LogOut,
  Megaphone,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { auth } from '../firebase';
import {
  auditAllDatabasesRules,
  type PlatformRulesAuditReport,
} from '../services/rulesAuditService';
import {
  deleteDiscoveredComplex,
  getPlatformDashboardStats,
  listAllComplexesAcrossDatabases,
  listConnectedDatabasesInfo,
  loadComplexWorkspace,
  removeExternalDatabaseConnection,
  updateRecitationStats,
  type ComplexWorkspaceData,
  type DiscoveredComplex,
} from '../services/platformService';
import type {
  ActiveSession,
  ConnectedDatabaseInfo,
  DailyStatsRecord,
  ExternalFirebaseConfig,
  HalaqaRecord,
  MosqueRecord,
} from '../types/platform';
import { BroadcastComposerModal } from './BroadcastComposerModal';
import { ComplexEditorModal } from './ComplexEditorModal';
import { ComplexWorkspace } from './ComplexWorkspace';
import { DatabaseUsageDashboard } from './DatabaseUsageDashboard';
import { ExternalDbModal } from './ExternalDbModal';
import { MascotImage } from './MascotImage';
import { ModernLoader } from './ModernLoader';
import { PWAInstallButton } from './PWAInstallButton';
import { ProgrammerAiAssistant } from './ProgrammerAiAssistant';
import { RulesHealthModal } from './RulesHealthModal';

interface AdminDashboardProps {
  session: ActiveSession;
}

type AdminPage = 'home' | 'complexes' | 'databases';

const BASE_URL = import.meta.env.BASE_URL;
const WAVING_FOX_PATH = `${BASE_URL}src/assets/images/fox_welcome_wave_1794991801893.jpg`;

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ session }) => {
  const [page, setPage] = useState<AdminPage>('home');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [statsData, setStatsData] = useState<{
    today: DailyStatsRecord;
    global: DailyStatsRecord;
    totalComplexes: number;
    totalMosques: number;
    totalHalaqat: number;
    totalAccounts: number;
  } | null>(null);

  const [connectedDbs, setConnectedDbs] = useState<ConnectedDatabaseInfo[]>([]);
  const [complexes, setComplexes] = useState<DiscoveredComplex[]>([]);
  const [selectedComplex, setSelectedComplex] = useState<DiscoveredComplex | null>(null);

  const [addDbModalOpen, setAddDbModalOpen] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);

  const [rulesAuditReport, setRulesAuditReport] =
    useState<PlatformRulesAuditReport | null>(null);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [auditingRules, setAuditingRules] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingComplex, setEditingComplex] = useState<DiscoveredComplex | null>(null);
  const [editingWorkspace, setEditingWorkspace] = useState<ComplexWorkspaceData | null>(null);
  const [editingMosques, setEditingMosques] = useState<MosqueRecord[]>([]);
  const [editingHalaqat, setEditingHalaqat] = useState<HalaqaRecord[]>([]);
  const [editingMosqueDbMap, setEditingMosqueDbMap] = useState<Record<string, Firestore>>({});
  const [editingMosqueConfigMap, setEditingMosqueConfigMap] = useState<
    Record<string, ExternalFirebaseConfig | null>
  >({});

  const [confirmDeleteComplex, setConfirmDeleteComplex] =
    useState<DiscoveredComplex | null>(null);

  const [ayahsInput, setAyahsInput] = useState('');
  const [pagesInput, setPagesInput] = useState('');
  const [savingRecitation, setSavingRecitation] = useState(false);

  const loadAll = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [statsRes, dbsRes, complexesRes] = await Promise.all([
        getPlatformDashboardStats(),
        listConnectedDatabasesInfo(),
        listAllComplexesAcrossDatabases(),
      ]);
      setStatsData(statsRes);
      setConnectedDbs(dbsRes);
      setComplexes(complexesRes);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const runRulesAudit = useCallback(
    async (openEvenIfHealthy = false) => {
      setAuditingRules(true);
      try {
        const report = await auditAllDatabasesRules(
          session.account.uid || session.account.id,
          { waitForPropagation: openEvenIfHealthy }
        );
        setRulesAuditReport(report);
        if (!report.allHealthy || openEvenIfHealthy) {
          setRulesModalOpen(true);
        }
      } finally {
        setAuditingRules(false);
      }
    },
    [session.account.uid, session.account.id]
  );

  useEffect(() => {
    void loadAll();
    void runRulesAudit(false);
  }, [loadAll, runRulesAudit]);

  const handleOpenEditComplex = async (comp: DiscoveredComplex) => {
    setRefreshing(true);
    try {
      const ws = await loadComplexWorkspace(comp);
      setEditingComplex(comp);
      setEditingWorkspace(ws);
      setEditingMosques(ws.mosques);
      setEditingHalaqat(ws.halaqat);
      setEditingMosqueDbMap(ws.mosqueDbMap);
      setEditingMosqueConfigMap(ws.mosqueConfigMap);
      setEditorOpen(true);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDeleteComplex = async () => {
    if (!confirmDeleteComplex) return;
    setRefreshing(true);
    try {
      await deleteDiscoveredComplex(confirmDeleteComplex);
      setConfirmDeleteComplex(null);
      await loadAll(true);
    } finally {
      setRefreshing(false);
    }
  };

  const handleRemoveExternalDb = async (dbInfo: ConnectedDatabaseInfo) => {
    if (dbInfo.isPrimary) return;
    setRefreshing(true);
    try {
      await removeExternalDatabaseConnection(dbInfo.id);
      await loadAll(true);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveRecitation = async (e: React.FormEvent) => {
    e.preventDefault();
    const ayahs = Number(ayahsInput || 0);
    const pages = Number(pagesInput || 0);
    if (ayahs <= 0 && pages <= 0) return;
    setSavingRecitation(true);
    try {
      await updateRecitationStats({ ayahsToAdd: ayahs, pagesToAdd: pages });
      setAyahsInput('');
      setPagesInput('');
      await loadAll(true);
    } finally {
      setSavingRecitation(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const externalOnlyDbs = connectedDbs.filter((d) => !d.isPrimary);

  return (
    <div className="min-h-screen bg-[#FDF6EE] text-[#4A220D] flex flex-col pb-24 md:pb-0">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-16 py-2 flex flex-wrap items-center justify-between gap-2.5 md:gap-6">
          <button
            type="button"
            onClick={() => {
              setSelectedComplex(null);
              setPage('home');
            }}
            className="flex items-center gap-2.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <img
              src={`${BASE_URL}icon.svg`}
              alt="براعم عمران"
              className="w-9 h-9 rounded-xl border border-[#EADBC8]"
            />
            <span className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
              براعم عمران
            </span>
          </button>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-6" aria-label="التنقل الرئيسي">
            <button
              type="button"
              onClick={() => {
                setSelectedComplex(null);
                setPage('home');
              }}
              className={`min-h-[44px] px-3 font-display text-sm font-bold whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                page === 'home' && !selectedComplex
                  ? 'border-[#F56900] text-[#F56900]'
                  : 'border-transparent text-[#7D4E35] hover:text-[#4A220D]'
              }`}
            >
              الرئيسية
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedComplex(null);
                setPage('complexes');
              }}
              className={`min-h-[44px] px-3 font-display text-sm font-bold whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                page === 'complexes' || selectedComplex
                  ? 'border-[#F56900] text-[#F56900]'
                  : 'border-transparent text-[#7D4E35] hover:text-[#4A220D]'
              }`}
            >
              المجمعات
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedComplex(null);
                setPage('databases');
              }}
              className={`min-h-[44px] px-3 font-display text-sm font-bold whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                page === 'databases' && !selectedComplex
                  ? 'border-[#F56900] text-[#F56900]'
                  : 'border-transparent text-[#7D4E35] hover:text-[#4A220D]'
              }`}
            >
              قواعد البيانات
            </button>
          </nav>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 shrink-0">
            {auditingRules ? (
              <span className="min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-[#7D4E35] font-display font-bold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#F56900] shrink-0" />
                <span>فحص Rules...</span>
              </span>
            ) : rulesAuditReport && !rulesAuditReport.allHealthy ? (
              <button
                type="button"
                onClick={() => setRulesModalOpen(true)}
                className="min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#D95338] bg-[#D95338]/10 hover:bg-[#D95338]/18 text-[#D95338] font-display font-extrabold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>تحديث Rules ({rulesAuditReport.unhealthyDatabases.length})</span>
              </button>
            ) : rulesAuditReport &&
              rulesAuditReport.allResults.some((r) => r.status === 'unreachable') ? (
              <button
                type="button"
                onClick={() => setRulesModalOpen(true)}
                title="تعذّر الوصول لبعض القواعد أثناء الفحص — اضغط للتفاصيل وإعادة الفحص"
                className="min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#FFA900]/70 bg-[#FFA900]/12 hover:bg-[#FFA900]/20 text-[#9A5B00] font-display font-extrabold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>Rules ({rulesAuditReport.healthyCount}/{rulesAuditReport.totalDatabases})</span>
              </button>
            ) : rulesAuditReport ? (
              <button
                type="button"
                onClick={() => setRulesModalOpen(true)}
                title="تم التحقق التلقائي من جميع قواعد البيانات — اضغط لإعادة الفحص"
                className="min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#58CC02]/50 bg-[#58CC02]/10 hover:bg-[#58CC02]/18 text-[#46A302] font-display font-extrabold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>Rules سليمة ({rulesAuditReport.healthyCount}/{rulesAuditReport.totalDatabases})</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setMessageModalOpen(true)}
              className="duo-btn-orange min-h-[42px] px-3.5 py-2 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Megaphone className="w-4 h-4 shrink-0" />
              <span>رسالة</span>
            </button>
            <PWAInstallButton variant="compact" />
            <button
              type="button"
              onClick={handleLogout}
              className="min-h-[42px] px-3 sm:px-4 py-2 rounded-xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#7D4E35] hover:text-[#4A220D] font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">تسجيل الخروج</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {loading ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
            <ModernLoader label="جاري تحميل إحصائيات وبيانات المنصة..." />
          </div>
        ) : refreshing ? (
          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-6">
            <ModernLoader label="جاري التحديث..." />
          </div>
        ) : null}

        {!loading && selectedComplex ? (
          <ComplexWorkspace
            discovered={selectedComplex}
            connectedDbs={connectedDbs}
            onBack={() => {
              setSelectedComplex(null);
              loadAll(true);
            }}
            onComplexRelocated={async (complexId) => {
              const refreshedComplexes = await listAllComplexesAcrossDatabases();
              setComplexes(refreshedComplexes);
              const relocated = refreshedComplexes.find((c) => c.id === complexId) || null;
              setSelectedComplex(relocated);
              await loadAll(true);
              void runRulesAudit(false);
            }}
          />
        ) : !loading && page === 'home' && statsData ? (
          <div className="space-y-6">
            {/* Programmer Admin Welcome Banner */}
            <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-8">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
                <div className="lg:col-span-4 flex flex-col items-center text-center">
                  <div className="relative bg-[#F56900] text-white rounded-2xl px-5 py-2.5 mb-3 border-b-4 border-[#C95200]">
                    <p className="font-display text-base font-extrabold">
                      مرحباً أيها المشرف
                    </p>
                    <span
                      aria-hidden="true"
                      className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-[#F56900] border-b-4 border-r-4 border-[#C95200] rotate-45"
                    />
                  </div>
                  <div className="w-40 h-40 sm:w-44 sm:h-44 flex items-center justify-center">
                    <MascotImage
                      src={WAVING_FOX_PATH}
                      alt="شخصية براعم عمران"
                      className="w-full h-full animate-fox-float"
                    />
                  </div>
                </div>

                <div className="lg:col-span-8 space-y-4 text-center lg:text-right">
                  <div className="inline-flex items-center gap-2 bg-[#58CC02]/10 border border-[#58CC02] rounded-xl px-3.5 py-1.5 text-xs font-display font-extrabold text-[#46A302]">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>تم تسجيل الدخول · المشرف المبرمج للمنصة</span>
                  </div>
                  <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[#4A220D]">
                    {session.account.quadrupleName}
                  </h1>
                  <p className="text-sm sm:text-base text-[#7D4E35] leading-relaxed">
                    لوحة الإحصائيات اليومية وإدارة المجمعات القرآنية والمساجد والحلقات والحسابات عبر جميع القواعد المرتبطة.
                  </p>
                  <div className="flex flex-wrap items-center justify-center lg:justify-start gap-3">
                    <button
                      type="button"
                      onClick={() => setPage('complexes')}
                      className="duo-btn-orange min-h-[46px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer"
                    >
                      <Building2 className="w-4 h-4" />
                      <span>إدارة المجمعات ({statsData.totalComplexes})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMessageModalOpen(true)}
                      className="duo-btn-green min-h-[46px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer"
                    >
                      <Megaphone className="w-4 h-4" />
                      <span>إرسال رسالة</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => loadAll(true)}
                      className="duo-btn-cream min-h-[46px] px-4 py-2.5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
                    >
                      <RefreshCw className="w-4 h-4 text-[#F56900]" />
                      <span>تحديث الإحصائيات</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* 6 Core Requested Stats Cards */}
            <section aria-label="إحصائيات اليوم والإجمالي">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">دخول الطلاب اليوم</p>
                    <p className="font-display text-3xl font-extrabold text-[#4A220D] tabular-nums mt-1">
                      {statsData.today.studentLogins}
                    </p>
                    <p className="text-xs text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي: {statsData.global.studentLogins}
                    </p>
                  </div>
                  <div className="w-14 h-14 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                    <GraduationCap className="w-7 h-7" />
                  </div>
                </div>

                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">دخول المعلمين اليوم</p>
                    <p className="font-display text-3xl font-extrabold text-[#4A220D] tabular-nums mt-1">
                      {statsData.today.teacherLogins}
                    </p>
                    <p className="text-xs text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي: {statsData.global.teacherLogins}
                    </p>
                  </div>
                  <div className="w-14 h-14 rounded-2xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
                    <Users className="w-7 h-7" />
                  </div>
                </div>

                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">دخول المشرفين اليوم</p>
                    <p className="font-display text-3xl font-extrabold text-[#4A220D] tabular-nums mt-1">
                      {statsData.today.supervisorLogins}
                    </p>
                    <p className="text-xs text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي: {statsData.global.supervisorLogins}
                    </p>
                  </div>
                  <div className="w-14 h-14 rounded-2xl bg-[#FFA900]/15 text-[#D98A00] flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-7 h-7" />
                  </div>
                </div>

                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">الزيارات اليوم</p>
                    <p className="font-display text-3xl font-extrabold text-[#4A220D] tabular-nums mt-1">
                      {statsData.today.totalVisits}
                    </p>
                    <p className="text-xs text-[#7D4E35] mt-1 tabular-nums">
                      إجمالي الزيارات: {statsData.global.totalVisits}
                    </p>
                  </div>
                  <div className="w-14 h-14 rounded-2xl bg-[#FDF6EE] border border-[#EADBC8] text-[#4A220D] flex items-center justify-center shrink-0">
                    <Eye className="w-7 h-7" />
                  </div>
                </div>

                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">عدد الآيات المسمّعة</p>
                    <p className="font-display text-3xl font-extrabold text-[#F56900] tabular-nums mt-1">
                      {statsData.today.recitedAyahs}
                    </p>
                    <p className="text-xs text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي: {statsData.global.recitedAyahs} آية
                    </p>
                  </div>
                  <div className="w-14 h-14 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                    <BookOpen className="w-7 h-7" />
                  </div>
                </div>

                <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">عدد الأوجه المسمّعة</p>
                    <p className="font-display text-3xl font-extrabold text-[#46A302] tabular-nums mt-1">
                      {statsData.today.recitedPages}
                    </p>
                    <p className="text-xs text-[#7D4E35] mt-1 tabular-nums">
                      الإجمالي: {statsData.global.recitedPages} وجه
                    </p>
                  </div>
                  <div className="w-14 h-14 rounded-2xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
                    <BookOpen className="w-7 h-7" />
                  </div>
                </div>
              </div>
            </section>

            {/* Infrastructure Overview + Quick Recitation Update */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <section className="lg:col-span-6 bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
                <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
                  نظرة عامة على المنظومة
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'المجمعات', val: statsData.totalComplexes },
                    { label: 'المساجد', val: statsData.totalMosques },
                    { label: 'الحلقات', val: statsData.totalHalaqat },
                    { label: 'الأعضاء', val: statsData.totalAccounts },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 text-center"
                    >
                      <p className="font-display text-2xl font-extrabold text-[#4A220D] tabular-nums">
                        {item.val}
                      </p>
                      <p className="text-xs font-bold text-[#7D4E35]">{item.label}</p>
                    </div>
                  ))}
                </div>
              </section>

              <form
                onSubmit={handleSaveRecitation}
                className="lg:col-span-6 bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
              >
                <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
                  تحديث رصيد التسميع اليومي
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="number"
                    min={0}
                    value={ayahsInput}
                    onChange={(e) => setAyahsInput(e.target.value)}
                    placeholder="إضافة آيات مسمّعة"
                    className="min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                  />
                  <input
                    type="number"
                    min={0}
                    value={pagesInput}
                    onChange={(e) => setPagesInput(e.target.value)}
                    placeholder="إضافة أوجه مسمّعة"
                    className="min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={savingRecitation}
                  className="duo-btn-orange min-h-[46px] px-5 py-2 rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {savingRecitation ? 'جاري التحديث...' : 'إضافة لإحصائيات التسميع'}
                </button>
              </form>
            </div>
          </div>
        ) : !loading && page === 'complexes' ? (
          <div className="space-y-6">
            {/* Complexes Top Header */}
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-extrabold text-[#4A220D]">
                  المجمعات القرآنية
                </h1>
                <p className="text-sm text-[#7D4E35]">
                  تُجلب المجمعات مباشرة من القاعدة الأساسية ومن كل قاعدة منفصلة مضافة، مع عزل تام للمجمعات المرتبطة بقواعد مستقلة.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setAddDbModalOpen(true)}
                  className="duo-btn-cream min-h-[46px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer"
                >
                  <Database className="w-4 h-4 text-[#F56900]" />
                  <span>إضافة قاعدة بيانات</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingComplex(null);
                    setEditingWorkspace(null);
                    setEditingMosques([]);
                    setEditingHalaqat([]);
                    setEditingMosqueDbMap({});
                    setEditingMosqueConfigMap({});
                    setEditorOpen(true);
                  }}
                  className="duo-btn-orange min-h-[46px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="w-5 h-5" />
                  <span>إنشاء مجمع جديد</span>
                </button>
              </div>
            </div>

            {/* Connected Databases Discovery Bar */}
            <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-sm sm:text-base font-extrabold text-[#4A220D] flex items-center gap-2">
                  <Database className="w-4 h-4 text-[#F56900]" />
                  <span>قواعد البيانات المقروء منها ({connectedDbs.length})</span>
                </h2>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={auditingRules}
                    onClick={() => void runRulesAudit(true)}
                    className="text-xs font-bold text-[#46A302] hover:underline inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{auditingRules ? 'جاري فحص القواعد...' : 'فحص القواعد'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => loadAll(true)}
                    className="text-xs font-bold text-[#F56900] hover:underline inline-flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>تحديث الجلب</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {connectedDbs.map((dbInfo) => (
                  <div
                    key={dbInfo.key}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold ${
                      dbInfo.isPrimary
                        ? 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                        : 'bg-[#58CC02]/10 border-[#58CC02]/40 text-[#46A302]'
                    }`}
                  >
                    <span>{dbInfo.label}</span>
                    {!dbInfo.isPrimary && (
                      <button
                        type="button"
                        onClick={() => handleRemoveExternalDb(dbInfo)}
                        aria-label={`فصل ${dbInfo.label}`}
                        title="فصل القاعدة من القائمة"
                        className="text-[#D95338] hover:bg-[#D95338]/10 rounded-md p-0.5 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* Discovered Complexes Grid */}
            {complexes.length === 0 ? (
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10 text-center space-y-4">
                <div className="w-16 h-16 mx-auto rounded-2xl bg-[#FDF6EE] border border-[#EADBC8] text-[#F56900] flex items-center justify-center">
                  <Building2 className="w-8 h-8" />
                </div>
                <h2 className="font-display text-xl font-extrabold text-[#4A220D]">
                  لا توجد مجمعات في القواعد المرتبطة بعد
                </h2>
                <p className="text-sm text-[#7D4E35] max-w-md mx-auto">
                  أنشئ مجمعاً جديداً على القاعدة الأساسية أو على قاعدة بيانات منفصلة، أو أضف قاعدة خارجية لجلب مجمعاتها تلقائياً.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEditingComplex(null);
                    setEditingWorkspace(null);
                    setEditingMosques([]);
                    setEditingHalaqat([]);
                    setEditingMosqueDbMap({});
                    setEditingMosqueConfigMap({});
                    setEditorOpen(true);
                  }}
                  className="duo-btn-orange min-h-[48px] px-6 py-2.5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>إنشاء أول مجمع</span>
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {complexes.map((comp) => (
                  <div
                    key={comp.id}
                    className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex flex-col justify-between gap-4 hover:border-[#F56900] transition-colors"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
                          {comp.name}
                        </h2>
                        <Database
                          className={`w-5 h-5 shrink-0 ${
                            comp.isExternal ? 'text-[#58CC02]' : 'text-[#F56900]'
                          }`}
                        />
                      </div>
                      <p className="text-xs font-medium text-[#7D4E35]">
                        {comp.ownerDbLabel}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 pt-2 border-t border-[#F7EBDD]">
                      <button
                        type="button"
                        onClick={() => setSelectedComplex(comp)}
                        className="duo-btn-orange flex-1 min-h-[42px] px-4 rounded-xl font-display font-bold text-xs sm:text-sm cursor-pointer"
                      >
                        فتح المجمع
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenEditComplex(comp)}
                        aria-label="تعديل المجمع"
                        className="min-h-[42px] min-w-[42px] rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] flex items-center justify-center text-[#4A220D] cursor-pointer"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteComplex(comp)}
                        aria-label="حذف المجمع"
                        className="min-h-[42px] min-w-[42px] rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#D95338] flex items-center justify-center text-[#D95338] cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : !loading && page === 'databases' ? (
          <DatabaseUsageDashboard complexes={complexes} />
        ) : null}
      </main>

      {/* Mobile Bottom Nav */}
      <nav
        aria-label="تنقل المشرف للهاتف"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t-2 border-[#EADBC8] h-16 px-4 grid grid-cols-3 items-center"
      >
        <button
          type="button"
          onClick={() => {
            setSelectedComplex(null);
            setPage('home');
          }}
          className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            page === 'home' && !selectedComplex ? 'text-[#F56900]' : 'text-[#7D4E35]'
          }`}
        >
          <Home className="w-5 h-5" />
          <span className="font-display text-xs font-bold">الرئيسية</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setSelectedComplex(null);
            setPage('complexes');
          }}
          className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            page === 'complexes' || selectedComplex ? 'text-[#F56900]' : 'text-[#7D4E35]'
          }`}
        >
          <Building2 className="w-5 h-5" />
          <span className="font-display text-xs font-bold">المجمعات</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setSelectedComplex(null);
            setPage('databases');
          }}
          className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            page === 'databases' && !selectedComplex ? 'text-[#F56900]' : 'text-[#7D4E35]'
          }`}
        >
          <Database className="w-5 h-5" />
          <span className="font-display text-xs font-bold">قواعد البيانات</span>
        </button>
      </nav>

      {/* Footer */}
      <footer className="py-4 px-4 text-center text-xs sm:text-sm font-medium text-[#7D4E35]">
        منصة براعم عمران · جميع الحقوق محفوظة لاستيديو expraiment
      </footer>

      {/* Standalone External Database Connection Modal */}
      {addDbModalOpen && (
        <ExternalDbModal
          onClose={() => setAddDbModalOpen(false)}
          onAdded={() => {
            setAddDbModalOpen(false);
            void loadAll(true);
            void runRulesAudit(false);
          }}
        />
      )}

      {/* Complex Create / Edit Modal */}
      {editorOpen && (
        <ComplexEditorModal
          adminUid={session.account.uid || session.account.id}
          connectedExternalDbs={externalOnlyDbs}
          editingComplex={editingComplex}
          existingWorkspace={editingWorkspace}
          existingMosques={editingMosques}
          existingHalaqat={editingHalaqat}
          existingMosqueDbMap={editingMosqueDbMap}
          existingMosqueConfigMap={editingMosqueConfigMap}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            void loadAll(true);
            void runRulesAudit(false);
          }}
        />
      )}

      {/* Programmer Broadcast Message Modal */}
      {messageModalOpen && (
        <BroadcastComposerModal
          senderName={session.account.quadrupleName}
          createdBy={auth.currentUser?.uid || session.account.uid || session.account.id}
          complexes={complexes}
          onClose={() => setMessageModalOpen(false)}
        />
      )}

      {/* Smart Firestore Rules Health Modal */}
      {rulesModalOpen && rulesAuditReport && (
        <RulesHealthModal
          report={rulesAuditReport}
          rechecking={auditingRules}
          onRecheck={() => runRulesAudit(true)}
          onClose={() => setRulesModalOpen(false)}
        />
      )}

      {/* Delete Complex Confirmation Dialog */}
      {confirmDeleteComplex &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
            role="dialog"
            aria-modal="true"
          >
            <div
              dir="rtl"
              className="w-full max-w-sm bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4 shadow-xl"
            >
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                حذف مجمع {confirmDeleteComplex.name}؟
              </h3>
              <p className="text-sm text-[#7D4E35]">
                سيتم حذف المجمع وبياناته من قاعدته ({confirmDeleteComplex.ownerDbLabel}).
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleDeleteComplex}
                  className="flex-1 min-h-[46px] rounded-2xl bg-[#D95338] text-white font-display font-bold text-sm cursor-pointer"
                >
                  تأكيد الحذف
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteComplex(null)}
                  className="duo-btn-cream flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      {/* Floating Smart AI Assistant for Programmer Admin */}
      <ProgrammerAiAssistant
        complexes={complexes}
        connectedDbs={connectedDbs}
        rulesAuditReport={rulesAuditReport}
      />
    </div>
  );
};
