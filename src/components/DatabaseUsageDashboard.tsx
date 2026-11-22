import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  HardDrive,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { toArabicIndicDigits } from '../services/mushafService';
import {
  inspectAllDatabasesUsage,
  type DiscoveredComplex,
} from '../services/platformService';
import type {
  DatabaseUsageDashboardReport,
  PhysicalDatabaseUsageSummary,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';

interface DatabaseUsageDashboardProps {
  complexes: DiscoveredComplex[];
}

function formatBytesReadable(bytes: number): string {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (safe < 1024) return `${safe.toLocaleString('en-US')} بايت`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(2)} كيلوبايت`;
  if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(2)} ميجابايت`;
  return `${(safe / (1024 * 1024 * 1024)).toFixed(3)} جيجابايت`;
}

function formatLimitGbLabel(limitBytes: number): string {
  const gb = limitBytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(gb >= 1 ? 0 : 2)} جيجابايت (${Math.round(limitBytes / (1024 * 1024)).toLocaleString('en-US')} MB)`;
}

const TAB_BAR_COLORS: Record<string, string> = {
  mosques_halaqat: '#F56900',
  accounts_invites: '#58CC02',
  attendance: '#FFA900',
  library: '#2B8A3E',
  curricula: '#C95200',
  core_broadcasts: '#7D4E35',
};

export const DatabaseUsageDashboard: React.FC<DatabaseUsageDashboardProps> = ({
  complexes,
}) => {
  const [selectedComplexId, setSelectedComplexId] = useState<string>('all');
  const [report, setReport] = useState<DatabaseUsageDashboardReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDbKeys, setExpandedDbKeys] = useState<Record<string, boolean>>({});

  const fetchUsage = useCallback(
    async (isBackground = false) => {
      if (isBackground) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await inspectAllDatabasesUsage({
          complexes,
          selectedComplexId,
        });
        setReport(res);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'تعذّر قراءة إحصائيات قواعد البيانات.'
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [complexes, selectedComplexId]
  );

  useEffect(() => {
    void fetchUsage(false);
  }, [fetchUsage]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void fetchUsage(true);
    }, 15000);
    return () => window.clearInterval(id);
  }, [autoRefresh, fetchUsage]);

  const maxTabBytes = useMemo(() => {
    if (!report || report.byTabSummary.length === 0) return 1;
    return Math.max(1, ...report.byTabSummary.map((t) => t.usedBytes));
  }, [report]);

  const totalUsagePercent = useMemo(() => {
    if (!report || report.totalLimitBytes <= 0) return 0;
    return Math.min(
      100,
      Number(((report.totalUsedBytes / report.totalLimitBytes) * 100).toFixed(4))
    );
  }, [report]);

  const lastCheckedTimeLabel = useMemo(() => {
    if (!report) return '';
    return new Date(report.checkedAtMs).toLocaleTimeString('ar-EG', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, [report]);

  const toggleExpandDb = (dbKey: string) => {
    setExpandedDbKeys((prev) => ({
      ...prev,
      [dbKey]: prev[dbKey] === undefined ? false : !prev[dbKey],
    }));
  };

  return (
    <div className="space-y-6">
      {/* Header & Filter Bar */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-display font-extrabold text-[#F56900]">
              <Database className="w-4 h-4" />
              <span>مراقبة البنية التحتية السحابية المباشرة</span>
            </div>
            <h1 className="font-display text-2xl font-extrabold text-[#4A220D] mt-0.5">
              إحصائيات قواعد البيانات والحدود
            </h1>
            <p className="text-xs sm:text-sm text-[#7D4E35] mt-1">
              قياس مباشر لحجم التخزين المستهلك وعدد المستندات والمتبقي قبل بلوغ حد القاعدة في القاعدة الأساسية وكل قاعدة مرتبطة بالمجمعات والشرائح.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {lastCheckedTimeLabel && (
              <span className="px-3 py-1.5 rounded-xl bg-[#FDF6EE] border border-[#EADBC8] text-xs font-bold text-[#7D4E35] tabular-nums">
                آخر قراءة: {lastCheckedTimeLabel}
              </span>
            )}

            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`min-h-[42px] px-3.5 py-2 rounded-xl border-2 font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                autoRefresh
                  ? 'bg-[#58CC02]/12 border-[#58CC02] text-[#357A02]'
                  : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#F56900]'
              }`}
            >
              <Activity className="w-4 h-4" />
              <span>{autoRefresh ? 'تحديث تلقائي: مفعّل (١٥ ث)' : 'تحديث تلقائي'}</span>
            </button>

            <button
              type="button"
              disabled={loading || refreshing}
              onClick={() => void fetchUsage(true)}
              className="duo-btn-orange min-h-[42px] px-4 py-2 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              <span>{refreshing ? 'جاري الفحص...' : 'تحديث مباشر'}</span>
            </button>
          </div>
        </div>

        {/* Complex Scope Selector */}
        <div className="pt-3 border-t border-[#EADBC8] flex flex-wrap items-center gap-3">
          <label
            htmlFor="db-usage-scope-select"
            className="text-xs sm:text-sm font-display font-extrabold text-[#4A220D]"
          >
            نطاق الفحص:
          </label>
          <select
            id="db-usage-scope-select"
            value={selectedComplexId}
            onChange={(e) => setSelectedComplexId(e.target.value)}
            className="min-h-[44px] px-3.5 py-2 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE] font-display font-bold text-xs sm:text-sm text-[#4A220D] cursor-pointer min-w-[240px]"
          >
            <option value="all">جميع القواعد والمجمعات (شامل القاعدة الأساسية)</option>
            <option value="primary">القاعدة الأساسية للموقع فقط</option>
            {complexes.map((comp) => (
              <option key={comp.id} value={comp.id}>
                مجمع: {comp.name} ({comp.isExternal ? comp.ownerDbLabel : 'القاعدة الأساسية'})
              </option>
            ))}
          </select>
        </div>
      </section>

      {loading && !report ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
          <ModernLoader label="جاري فحص جميع المجموعات وحساب المساحات الفعلية..." />
        </div>
      ) : error ? (
        <div className="bg-white border-2 border-[#D95338] rounded-3xl p-6 text-center space-y-3">
          <p className="font-display font-extrabold text-[#D95338]">{error}</p>
          <button
            type="button"
            onClick={() => void fetchUsage(false)}
            className="duo-btn-orange min-h-[44px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
          >
            إعادة الفحص
          </button>
        </div>
      ) : report ? (
        <>
          {/* 4 Summary KPI Cards */}
          <section
            aria-label="ملخص استهلاك قواعد البيانات"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
          >
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[#7D4E35]">عدد القواعد المفحوصة</p>
                <p className="font-display text-3xl font-extrabold text-[#4A220D] tabular-nums mt-1">
                  {toArabicIndicDigits(report.totalDatabasesCount)}
                </p>
                <p className="text-[11px] font-semibold text-[#7D4E35] mt-1 tabular-nums">
                  متصلة:{' '}
                  {toArabicIndicDigits(report.databases.filter((d) => d.reachable).length)}
                </p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                <Database className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[#7D4E35]">إجمالي السجلات (المستندات)</p>
                <p className="font-display text-3xl font-extrabold text-[#4A220D] tabular-nums mt-1">
                  {report.totalDocsCount.toLocaleString('en-US')}
                </p>
                <p className="text-[11px] font-semibold text-[#7D4E35] mt-1">
                  عبر جميع المجموعات
                </p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-[#FFA900]/15 text-[#D98A00] flex items-center justify-center shrink-0">
                <Layers className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[#7D4E35]">المساحة المستهلكة</p>
                <p className="font-display text-xl sm:text-2xl font-extrabold text-[#F56900] tabular-nums mt-1">
                  {formatBytesReadable(report.totalUsedBytes)}
                </p>
                <p className="text-[11px] font-semibold text-[#7D4E35] mt-1 tabular-nums">
                  نسبة الإشغال: {totalUsagePercent.toFixed(4)}%
                </p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                <HardDrive className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-[#7D4E35]">كم باقي على الحدود</p>
                <p className="font-display text-xl sm:text-2xl font-extrabold text-[#46A302] tabular-nums mt-1">
                  {formatBytesReadable(report.totalRemainingBytes)}
                </p>
                <p className="text-[11px] font-semibold text-[#7D4E35] mt-1 tabular-nums">
                  الحد المجمع: {formatLimitGbLabel(report.totalLimitBytes)}
                </p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-[#58CC02]/15 text-[#46A302] flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
            </div>
          </section>

          {/* Charts Section */}
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* SVG Bar Chart: Consumption by Feature Tab */}
            <div className="lg:col-span-7 bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg font-extrabold text-[#4A220D] flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-[#F56900]" />
                  <span>توزيع الاستهلاك حسب أقسام المنصة</span>
                </h2>
                <span className="text-xs font-bold text-[#7D4E35]">بالبايت وعدد السجلات</span>
              </div>

              <div className="space-y-3">
                {report.byTabSummary.map((tabStat) => {
                  const pct = Math.max(
                    tabStat.usedBytes > 0 ? 3 : 0,
                    Math.round((tabStat.usedBytes / maxTabBytes) * 100)
                  );
                  const fillColor = TAB_BAR_COLORS[tabStat.tabKey] || '#F56900';
                  return (
                    <div key={tabStat.tabKey} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs font-bold">
                        <span className="text-[#4A220D]">{tabStat.label}</span>
                        <span className="text-[#7D4E35] tabular-nums">
                          {formatBytesReadable(tabStat.usedBytes)} ·{' '}
                          {tabStat.docsCount.toLocaleString('en-US')} سجل
                        </span>
                      </div>
                      <div className="w-full h-3.5 rounded-full bg-[#FDF6EE] border border-[#EADBC8] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: fillColor,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* SVG Column Chart comparing DBs */}
            <div className="lg:col-span-5 bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-col justify-between gap-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
                  مقارنة حجم القواعد (ميجابايت)
                </h2>
                <span className="text-xs font-bold text-[#7D4E35] tabular-nums">
                  أعلى {Math.min(6, report.databases.length)} قواعد
                </span>
              </div>

              {(() => {
                const topDbs = report.databases.slice(0, 6);
                const maxDbBytes = Math.max(1024, ...topDbs.map((d) => d.usedBytes));
                const svgWidth = 420;
                const svgHeight = 200;
                const barWidth = Math.max(24, Math.floor((svgWidth - 40) / Math.max(1, topDbs.length)) - 14);

                return (
                  <div className="w-full overflow-x-auto">
                    <svg
                      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                      className="w-full h-48 select-none"
                      role="img"
                      aria-label="رسم بياني لمقارنة استهلاك قواعد البيانات"
                    >
                      {/* Baseline */}
                      <line
                        x1="12"
                        y1={svgHeight - 36}
                        x2={svgWidth - 12}
                        y2={svgHeight - 36}
                        stroke="#EADBC8"
                        strokeWidth="2"
                      />
                      {topDbs.map((dbItem, idx) => {
                        const usableHeight = svgHeight - 62;
                        const barH = Math.max(
                          6,
                          Math.round((dbItem.usedBytes / maxDbBytes) * usableHeight)
                        );
                        const step = (svgWidth - 32) / Math.max(1, topDbs.length);
                        const x = 16 + idx * step + (step - barWidth) / 2;
                        const y = svgHeight - 36 - barH;
                        const fill = dbItem.isPrimary ? '#F56900' : '#58CC02';
                        const kbOrMb =
                          dbItem.usedBytes < 1024 * 1024
                            ? `${(dbItem.usedBytes / 1024).toFixed(1)}K`
                            : `${(dbItem.usedBytes / (1024 * 1024)).toFixed(2)}M`;

                        return (
                          <g key={dbItem.dbKey}>
                            <rect
                              x={x}
                              y={y}
                              width={barWidth}
                              height={barH}
                              rx={8}
                              fill={fill}
                              opacity={dbItem.reachable ? 0.92 : 0.35}
                            />
                            <text
                              x={x + barWidth / 2}
                              y={y - 6}
                              textAnchor="middle"
                              fontSize="10"
                              fontWeight="700"
                              fill="#4A220D"
                            >
                              {kbOrMb}
                            </text>
                            <text
                              x={x + barWidth / 2}
                              y={svgHeight - 16}
                              textAnchor="middle"
                              fontSize="10"
                              fontWeight="700"
                              fill="#7D4E35"
                            >
                              {dbItem.isPrimary ? 'الأساسية' : `#${idx + 1}`}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                );
              })()}

              <div className="flex items-center justify-center gap-4 text-xs font-bold text-[#7D4E35]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-xs bg-[#F56900]" />
                  <span>القاعدة الأساسية</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-xs bg-[#58CC02]" />
                  <span>القواعد المربوطة والشرائح</span>
                </span>
              </div>
            </div>
          </section>

          {/* Per-Database Cards with Exact Collections Breakdown */}
          <section className="space-y-4">
            <h2 className="font-display text-lg font-extrabold text-[#4A220D]">
              التفاصيل الدقيقة لكل قاعدة بيانات ({toArabicIndicDigits(report.databases.length)})
            </h2>

            {report.databases.map((dbItem: PhysicalDatabaseUsageSummary) => {
              const isExpanded = expandedDbKeys[dbItem.dbKey] ?? true;
              const isNearLimit = dbItem.usagePercent >= 80;
              const barColor = isNearLimit
                ? '#D95338'
                : dbItem.isPrimary
                ? '#F56900'
                : '#58CC02';

              return (
                <article
                  key={dbItem.dbKey}
                  className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
                >
                  {/* Top Row */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-2.5 py-0.5 rounded-lg text-xs font-display font-extrabold ${
                            dbItem.isPrimary
                              ? 'bg-[#F56900] text-white'
                              : 'bg-[#58CC02]/15 text-[#357A02]'
                          }`}
                        >
                          {dbItem.isPrimary ? 'القاعدة الأساسية' : 'قاعدة خارجية / شريحة'}
                        </span>
                        <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                          {dbItem.dbLabel}
                        </h3>
                      </div>

                      <p className="text-xs font-mono text-[#7D4E35]" dir="ltr">
                        {dbItem.projectId} / {dbItem.firestoreDatabaseId}
                      </p>

                      {dbItem.roleTags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {dbItem.roleTags.map((tag, i) => (
                            <span
                              key={i}
                              className="px-2.5 py-0.5 rounded-lg bg-[#FDF6EE] border border-[#EADBC8] text-[11px] font-bold text-[#4A220D]"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {dbItem.reachable ? (
                        <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#58CC02]/12 border border-[#58CC02]/50 text-[#357A02] text-xs font-extrabold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>متصلة ومستجيبة</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#D95338]/12 border border-[#D95338]/50 text-[#D95338] text-xs font-extrabold">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>{dbItem.errorMessage || 'غير متاحة'}</span>
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={() => toggleExpandDb(dbItem.dbKey)}
                        className="min-h-[36px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] cursor-pointer"
                      >
                        {isExpanded ? 'إخفاء المجموعات' : 'عرض المجموعات'}
                      </button>
                    </div>
                  </div>

                  {/* Storage Progress & Remaining Quota */}
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm font-bold">
                      <span className="text-[#4A220D] tabular-nums">
                        المستخدم الفعلي:{' '}
                        <strong className="text-[#F56900]">
                          {formatBytesReadable(dbItem.usedBytes)}
                        </strong>{' '}
                        ({dbItem.totalDocs.toLocaleString('en-US')} مستند)
                      </span>
                      <span className="text-[#357A02] tabular-nums">
                        باقي على الحدود:{' '}
                        <strong>{formatBytesReadable(dbItem.remainingBytes)}</strong>{' '}
                        من {formatLimitGbLabel(dbItem.limitBytes)}
                      </span>
                    </div>

                    <div className="w-full h-3.5 rounded-full bg-white border border-[#EADBC8] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.max(dbItem.usedBytes > 0 ? 1.5 : 0, dbItem.usagePercent)}%`,
                          backgroundColor: barColor,
                        }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] font-bold text-[#7D4E35] tabular-nums">
                      <span>نسبة الاستهلاك الحالية: {dbItem.usagePercent.toFixed(4)}%</span>
                      <span>السعة الآمنة المتاحة: {(100 - dbItem.usagePercent).toFixed(4)}%</span>
                    </div>
                  </div>

                  {/* Per-Collection Breakdown Table */}
                  {isExpanded && dbItem.collections.length > 0 && (
                    <div className="overflow-x-auto border border-[#EADBC8] rounded-2xl">
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead className="bg-[#FDF6EE] text-[#7D4E35] font-display font-extrabold">
                          <tr>
                            <th className="py-2.5 px-3.5 border-b border-[#EADBC8]">المجموعة</th>
                            <th className="py-2.5 px-3.5 border-b border-[#EADBC8]">اسم المجموعة البرمجي</th>
                            <th className="py-2.5 px-3.5 border-b border-[#EADBC8]">عدد السجلات</th>
                            <th className="py-2.5 px-3.5 border-b border-[#EADBC8]">المساحة</th>
                            <th className="py-2.5 px-3.5 border-b border-[#EADBC8]">الحصة</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dbItem.collections.map((colItem) => {
                            const colPct =
                              dbItem.usedBytes > 0
                                ? ((colItem.usedBytes / dbItem.usedBytes) * 100).toFixed(1)
                                : '0.0';
                            return (
                              <tr
                                key={colItem.collection}
                                className="border-b border-[#F7EBDD] last:border-b-0 hover:bg-[#FDF6EE]/60"
                              >
                                <td className="py-2.5 px-3.5 font-bold text-[#4A220D]">
                                  {colItem.label}
                                </td>
                                <td className="py-2.5 px-3.5 font-mono text-xs text-[#7D4E35]" dir="ltr">
                                  {colItem.collection}
                                </td>
                                <td className="py-2.5 px-3.5 font-bold text-[#4A220D] tabular-nums">
                                  {colItem.docsCount.toLocaleString('en-US')}
                                </td>
                                <td className="py-2.5 px-3.5 font-bold text-[#F56900] tabular-nums">
                                  {formatBytesReadable(colItem.usedBytes)}
                                </td>
                                <td className="py-2.5 px-3.5 font-bold text-[#7D4E35] tabular-nums">
                                  {colPct}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        </>
      ) : null}
    </div>
  );
};
