import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Cpu,
  KeyRound,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserCheck,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  AI_SERVER_SLOT_LABELS,
  AI_TIER_LABELS,
  DEFAULT_AI_FEATURES,
  clearServerAiErrorLogs,
  fetchServerAiDiagnostics,
  loadAiPolicyStore,
  runServerAiConnectivityTest,
  saveAccountAiPolicy,
  saveComplexAiPolicy,
} from '../services/aiPolicyService';
import {
  listAllPlatformAccountsDirectory,
  type DiscoveredComplex,
  type PlatformAccountDirectoryEntry,
} from '../services/platformService';
import {
  ROLE_LABELS,
  type AccountAiPolicy,
  type AiComplexSubscriptionTier,
  type AiDiagnosticsReport,
  type AiFeaturePermissions,
  type AiModelProbeResult,
  type AiPolicyConfigStore,
  type AiServerKeySlotId,
  type ComplexAiPolicy,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';

interface AdminAiSectionProps {
  complexes: DiscoveredComplex[];
}

const ALL_SLOT_IDS: AiServerKeySlotId[] = [
  'default',
  'slot_1',
  'slot_2',
  'slot_3',
  'slot_4',
  'slot_5',
];

function formatDateTimeShort(ms: number): string {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      month: 'short',
      day: 'numeric',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export const AdminAiSection: React.FC<AdminAiSectionProps> = ({ complexes }) => {
  const [loading, setLoading] = useState(true);
  const [diagnostics, setDiagnostics] = useState<AiDiagnosticsReport | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const [testSlot, setTestSlot] = useState<AiServerKeySlotId>('default');
  const [testingModels, setTestingModels] = useState(false);
  const [probeResults, setProbeResults] = useState<AiModelProbeResult[] | null>(null);
  const [probeCheckedAtMs, setProbeCheckedAtMs] = useState<number>(0);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [policyStore, setPolicyStore] = useState<AiPolicyConfigStore>({
    complexes: {},
    accounts: {},
    updatedAtMs: 0,
  });

  const [accounts, setAccounts] = useState<PlatformAccountDirectoryEntry[]>([]);
  const [accountSearch, setAccountSearch] = useState('');
  const [accountComplexFilter, setAccountComplexFilter] = useState<string>('all');

  // Local editable drafts per complex
  const [complexDrafts, setComplexDrafts] = useState<Record<string, ComplexAiPolicy>>({});
  const [savingComplexId, setSavingComplexId] = useState<string | null>(null);

  // Local editable drafts per account
  const [accountDrafts, setAccountDrafts] = useState<Record<string, AccountAiPolicy>>({});
  const [savingAccountId, setSavingAccountId] = useState<string | null>(null);

  const [saveFeedback, setSaveFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  const syncDraftsFromStore = useCallback(
    (store: AiPolicyConfigStore, cpxList: DiscoveredComplex[], accList: PlatformAccountDirectoryEntry[]) => {
      const nextComplexDrafts: Record<string, ComplexAiPolicy> = {};
      for (const c of cpxList) {
        nextComplexDrafts[c.id] = store.complexes[c.id] || {
          complexId: c.id,
          enabled: true,
          tier: 'subscribed',
          serverKeySlot: 'default',
          dailyLimit: 0,
          features: { ...DEFAULT_AI_FEATURES },
          note: '',
          updatedAtMs: 0,
        };
      }
      setComplexDrafts(nextComplexDrafts);

      const nextAccDrafts: Record<string, AccountAiPolicy> = {};
      for (const entry of accList) {
        const aid = entry.account.id;
        nextAccDrafts[aid] = store.accounts[aid] || {
          accountId: aid,
          mode: 'inherit',
          serverKeySlot: 'inherit',
          tierLabel: '',
          note: '',
          updatedAtMs: 0,
        };
      }
      setAccountDrafts(nextAccDrafts);
    },
    []
  );

  const loadAllAiData = useCallback(async () => {
    setLoading(true);
    setDiagError(null);
    try {
      const [diagRes, storeRes, dirRes] = await Promise.all([
        fetchServerAiDiagnostics().catch((e) => {
          setDiagError(e instanceof Error ? e.message : 'تعذّر جلب تشخيص الخادم.');
          return null;
        }),
        loadAiPolicyStore(true),
        listAllPlatformAccountsDirectory(),
      ]);

      if (diagRes) setDiagnostics(diagRes);
      setPolicyStore(storeRes);
      const nonAdminAccounts = dirRes.entries.filter(
        (e) => e.account.role !== 'platform_admin'
      );
      setAccounts(nonAdminAccounts);
      syncDraftsFromStore(storeRes, complexes, nonAdminAccounts);
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'تعذّر تحميل بيانات إدارة الذكاء الاصطناعي.');
    } finally {
      setLoading(false);
    }
  }, [complexes, syncDraftsFromStore]);

  useEffect(() => {
    void loadAllAiData();
  }, [loadAllAiData]);

  const refreshDiagnosticsOnly = async () => {
    setDiagError(null);
    try {
      const diag = await fetchServerAiDiagnostics();
      setDiagnostics(diag);
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'تعذّر تحديث التشخيص.');
    }
  };

  const handleRunConnectivityTest = async () => {
    setTestingModels(true);
    setProbeError(null);
    try {
      const res = await runServerAiConnectivityTest(testSlot);
      setProbeResults(res.results);
      setProbeCheckedAtMs(res.checkedAtMs);
      if (res.error) setProbeError(res.error);
      await refreshDiagnosticsOnly();
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'فشل اختبار الاتصال.');
    } finally {
      setTestingModels(false);
    }
  };

  const handleClearErrorLogs = async () => {
    await clearServerAiErrorLogs();
    await refreshDiagnosticsOnly();
  };

  const updateComplexDraft = (
    complexId: string,
    patch: Partial<ComplexAiPolicy>
  ) => {
    setComplexDrafts((prev) => {
      const current = prev[complexId] || {
        complexId,
        enabled: true,
        tier: 'subscribed' as AiComplexSubscriptionTier,
        serverKeySlot: 'default' as AiServerKeySlotId,
        dailyLimit: 0,
        features: { ...DEFAULT_AI_FEATURES },
        note: '',
        updatedAtMs: 0,
      };
      return {
        ...prev,
        [complexId]: {
          ...current,
          ...patch,
        },
      };
    });
  };

  const toggleComplexFeature = (
    complexId: string,
    featureKey: keyof AiFeaturePermissions
  ) => {
    setComplexDrafts((prev) => {
      const current = prev[complexId];
      if (!current) return prev;
      return {
        ...prev,
        [complexId]: {
          ...current,
          features: {
            ...current.features,
            [featureKey]: !current.features[featureKey],
          },
        },
      };
    });
  };

  const handleSaveComplexPolicy = async (complexId: string) => {
    const draft = complexDrafts[complexId];
    if (!draft) return;
    setSavingComplexId(complexId);
    setSaveFeedback(null);
    try {
      const updated = await saveComplexAiPolicy(draft);
      setPolicyStore(updated);
      setSaveFeedback({ type: 'ok', text: 'تم حفظ إعدادات الذكاء الاصطناعي للمجمع بنجاح.' });
    } catch (err) {
      setSaveFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حفظ سياسة المجمع.',
      });
    } finally {
      setSavingComplexId(null);
    }
  };

  const updateAccountDraft = (
    accountId: string,
    patch: Partial<AccountAiPolicy>
  ) => {
    setAccountDrafts((prev) => {
      const current = prev[accountId] || {
        accountId,
        mode: 'inherit' as const,
        serverKeySlot: 'inherit' as const,
        tierLabel: '',
        note: '',
        updatedAtMs: 0,
      };
      return {
        ...prev,
        [accountId]: {
          ...current,
          ...patch,
        },
      };
    });
  };

  const handleSaveAccountPolicy = async (accountId: string) => {
    const draft = accountDrafts[accountId];
    if (!draft) return;
    setSavingAccountId(accountId);
    setSaveFeedback(null);
    try {
      const updated = await saveAccountAiPolicy(draft);
      setPolicyStore(updated);
      setSaveFeedback({ type: 'ok', text: 'تم حفظ إعدادات الـ AI للحساب بنجاح.' });
    } catch (err) {
      setSaveFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حفظ سياسة الحساب.',
      });
    } finally {
      setSavingAccountId(null);
    }
  };

  const slotStatusMap = useMemo(() => {
    const map = new Map<AiServerKeySlotId, boolean>();
    for (const s of diagnostics?.keySlots || []) {
      map.set(s.slotId, s.configured);
    }
    return map;
  }, [diagnostics]);

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    return accounts.filter((entry) => {
      if (accountComplexFilter !== 'all') {
        if (accountComplexFilter === 'unassigned') {
          if (entry.account.complexId) return false;
        } else if (entry.account.complexId !== accountComplexFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        entry.account.quadrupleName.toLowerCase().includes(q) ||
        (entry.account.email || '').toLowerCase().includes(q) ||
        entry.complexName.toLowerCase().includes(q)
      );
    });
  }, [accounts, accountSearch, accountComplexFilter]);

  if (loading) {
    return (
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
        <ModernLoader label="جاري تحميل تشخيص الذكاء الاصطناعي وسياسات المجمعات والحسابات..." />
      </div>
    );
  }

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header Banner */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 bg-[#F56900]/10 border border-[#F56900]/30 rounded-xl px-3 py-1 text-xs font-display font-extrabold text-[#C95200]">
            <Cpu className="w-4 h-4" />
            <span>إدارة وتشخيص الذكاء الاصطناعي (AI)</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D]">
            توزيع باقات ومسارات AI للمجمعات والحسابات + تتبع الأخطاء المباشر
          </h1>
          <p className="text-xs sm:text-sm text-[#7D4E35]">
            راقب حالة اتصال نماذج Gemini والأخطاء الحية لحظياً، وعيّن الاشتراك ومسار مفتاح الخادم لكل مجمع ولكل حساب.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAllAiData()}
          className="duo-btn-cream min-h-[46px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer shrink-0"
        >
          <RefreshCw className="w-4 h-4 text-[#F56900]" />
          <span>تحديث شامل</span>
        </button>
      </section>

      {saveFeedback && (
        <div
          className={`rounded-2xl border-2 px-4 py-3 text-xs sm:text-sm font-bold flex items-center justify-between gap-3 ${
            saveFeedback.type === 'ok'
              ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#2F6F02]'
              : 'bg-[#D95338]/10 border-[#D95338] text-[#B92B14]'
          }`}
        >
          <span className="flex items-center gap-2">
            {saveFeedback.type === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            <span>{saveFeedback.text}</span>
          </span>
          <button
            type="button"
            onClick={() => setSaveFeedback(null)}
            className="text-xs underline cursor-pointer"
          >
            إخفاء
          </button>
        </div>
      )}

      {/* 1. Live Server Key Slots & Connectivity Test */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-extrabold text-[#4A220D] flex items-center gap-2">
              <Server className="w-5 h-5 text-[#F56900]" />
              <span>حالة مفاتيح الخادم واختبار النماذج الحية</span>
            </h2>
            <p className="text-xs text-[#7D4E35]">
              تُدار المفاتيح السرية حصراً على الخادم في <strong className="text-[#4A220D]">Settings &gt; Secrets</strong> أو <strong className="text-[#4A220D]">Render &gt; Environment</strong> (أسماء المتغيرات: <code className="px-1 bg-[#FDF6EE] rounded">GEMINI_API_KEY</code> و <code className="px-1 bg-[#FDF6EE] rounded">GEMINI_API_KEY_1..5</code>) ولا تُخزّن داخل المتصفح أو قاعدة البيانات حمايةً لها.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <select
              value={testSlot}
              onChange={(e) => setTestSlot(e.target.value as AiServerKeySlotId)}
              aria-label="اختيار مسار المفتاح للاختبار"
              className="min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-xs font-bold text-[#4A220D]"
            >
              {ALL_SLOT_IDS.map((sid) => (
                <option key={sid} value={sid}>
                  {AI_SERVER_SLOT_LABELS[sid]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={testingModels}
              onClick={() => void handleRunConnectivityTest()}
              className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {testingModels ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              <span>{testingModels ? 'جاري فحص النماذج...' : 'فحص اتصال النماذج الآن'}</span>
            </button>
          </div>
        </div>

        {diagError && (
          <div className="rounded-2xl border border-[#D95338] bg-[#D95338]/10 px-4 py-3 text-xs font-bold text-[#B92B14]">
            {diagError}
          </div>
        )}

        {/* Server Environment Key Slots Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(diagnostics?.keySlots || []).map((slot) => (
            <div
              key={slot.slotId}
              className={`rounded-2xl border-2 p-3.5 flex items-center justify-between gap-2 ${
                slot.configured
                  ? 'border-[#58CC02]/50 bg-[#58CC02]/8'
                  : 'border-[#EADBC8] bg-[#FDF6EE]/70'
              }`}
            >
              <div className="min-w-0">
                <p className="font-display font-extrabold text-xs sm:text-sm text-[#4A220D] truncate">
                  {slot.envVarName}
                </p>
                <p className="text-[11px] text-[#7D4E35] truncate">{slot.label}</p>
              </div>
              <span
                className={`px-2.5 py-1 rounded-xl text-[11px] font-extrabold whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                  slot.configured
                    ? 'bg-[#58CC02]/15 text-[#2F6F02]'
                    : 'bg-white border border-[#EADBC8] text-[#7D4E35]'
                }`}
              >
                {slot.configured ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>مضبوط</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>غير مضاف</span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>

        {probeError && (
          <div className="rounded-2xl border border-[#D95338] bg-[#D95338]/10 px-4 py-3 text-xs font-bold text-[#B92B14]">
            {probeError}
          </div>
        )}

        {/* Connectivity Probe Results */}
        {probeResults && (
          <div className="space-y-2.5 pt-2 border-t border-[#EADBC8]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-display font-extrabold text-sm text-[#4A220D] flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#F56900]" />
                <span>نتيجة فحص النماذج المباشر ({AI_SERVER_SLOT_LABELS[testSlot]})</span>
              </p>
              {probeCheckedAtMs > 0 && (
                <span className="text-[11px] font-bold text-[#7D4E35]">
                  وقت الفحص: {formatDateTimeShort(probeCheckedAtMs)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {probeResults.map((item) => (
                <div
                  key={item.model}
                  dir="ltr"
                  className={`rounded-2xl border p-3 text-left space-y-1 ${
                    item.ok
                      ? 'border-[#58CC02]/50 bg-[#58CC02]/8'
                      : 'border-[#D95338]/40 bg-[#D95338]/6'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-xs text-[#4A220D]">
                      {item.model}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-lg font-mono text-[11px] font-bold ${
                        item.ok
                          ? 'bg-[#58CC02]/20 text-[#2F6F02]'
                          : 'bg-[#D95338]/15 text-[#B92B14]'
                      }`}
                    >
                      {item.ok ? `OK 200 · ${item.latencyMs}ms` : `ERR ${item.status} · ${item.latencyMs}ms`}
                    </span>
                  </div>
                  {item.ok ? (
                    <p className="text-[11px] font-bold text-[#2F6F02]" dir="rtl">
                      الاستجابة: {item.sampleText}
                    </p>
                  ) : (
                    <p className="text-[11px] font-mono text-[#911F0D] break-words">
                      {item.rawError}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 2. Live AI Error Log Console */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-extrabold text-[#4A220D] flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-[#D95338]" />
              <span>سجل أخطاء الـ AI التفصيلي ({diagnostics?.recentErrors.length || 0})</span>
            </h2>
            <p className="text-xs text-[#7D4E35]">
              يعرض كل خطأ فعلي حدث في الخادم مع المسار والنماذج التي تمت تجربتها ورمز الخطأ الدقيق لتحديد السبب فوراً.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshDiagnosticsOnly()}
              className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#F56900]" />
              <span>تحديث السجل</span>
            </button>
            {(diagnostics?.recentErrors.length || 0) > 0 && (
              <button
                type="button"
                onClick={() => void handleClearErrorLogs()}
                className="min-h-[40px] px-3 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>مسح السجل</span>
              </button>
            )}
          </div>
        </div>

        {!diagnostics || diagnostics.recentErrors.length === 0 ? (
          <div className="rounded-2xl border border-[#EADBC8] bg-[#FDF6EE]/70 p-6 text-center space-y-1.5">
            <CheckCircle2 className="w-7 h-7 mx-auto text-[#46A302]" />
            <p className="font-display font-bold text-sm text-[#4A220D]">
              لا توجد أخطاء مسجّلة في هذه الجلسة حتى الآن
            </p>
            <p className="text-xs text-[#7D4E35]">
              عند حدوث أي تعثّر في المساعد الذكي أو التهجي أو الصوتيات أو العروض التقديمية سيظهر تفصيله هنا تلقائياً.
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[440px] overflow-y-auto pr-1">
            {diagnostics.recentErrors.map((errLog) => (
              <div
                key={errLog.id}
                className="rounded-2xl border-2 border-[#D95338]/35 bg-[#D95338]/5 p-4 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                    <span className="px-2 py-0.5 rounded-lg bg-[#D95338] text-white font-mono">
                      HTTP {errLog.finalStatus}
                    </span>
                    <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] font-mono text-[#4A220D]">
                      {errLog.endpoint}
                    </span>
                    <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] text-[#7D4E35]">
                      المسار: {errLog.keySlot}
                    </span>
                    {errLog.complexId && (
                      <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] text-[#4A220D]">
                        المجمع: {errLog.complexId}
                      </span>
                    )}
                    {errLog.accountId && (
                      <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] text-[#4A220D]">
                        الحساب: {errLog.accountId}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-bold text-[#7D4E35]">
                    {formatDateTimeShort(errLog.timestampMs)}
                  </span>
                </div>

                <p className="text-xs sm:text-sm font-bold text-[#B92B14]">
                  {errLog.friendlyMessage}
                </p>

                {errLog.attempts.length > 0 ? (
                  <div dir="ltr" className="space-y-1 text-left">
                    {errLog.attempts.map((att, idx) => (
                      <div
                        key={`${errLog.id}_${att.model}_${idx}`}
                        className="rounded-xl bg-white border border-[#D95338]/25 px-3 py-1.5 text-[11px] font-mono text-[#4A220D] break-words"
                      >
                        <span className="font-bold text-[#B92B14]">
                          [{att.model}] status={att.status || 'ERR'} ({att.latencyMs}ms):
                        </span>{' '}
                        <span>{att.rawError}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    dir="ltr"
                    className="rounded-xl bg-white border border-[#D95338]/25 px-3 py-1.5 text-[11px] font-mono text-[#4A220D] break-words text-left"
                  >
                    {errLog.rawError}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Per-Complex AI Subscription & Slot Assignment */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-extrabold text-[#4A220D] flex items-center gap-2">
            <Building2 className="w-5 h-5 text-[#F56900]" />
            <span>تعيين اشتراك ومسار الذكاء الاصطناعي لكل مجمع ({complexes.length})</span>
          </h2>
          <p className="text-xs text-[#7D4E35]">
            فعّل أو عطّل الذكاء الاصطناعي لكل مجمع حسب اشتراكه، واختر مسار مفتاح الخادم الخاص به والميزات المسموحة داخله.
          </p>
        </div>

        {complexes.length === 0 ? (
          <div className="rounded-2xl border border-[#EADBC8] bg-[#FDF6EE] p-6 text-center text-sm font-bold text-[#7D4E35]">
            لا توجد مجمعات مسجّلة حالياً.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {complexes.map((comp) => {
              const draft = complexDrafts[comp.id] || {
                complexId: comp.id,
                enabled: true,
                tier: 'subscribed' as AiComplexSubscriptionTier,
                serverKeySlot: 'default' as AiServerKeySlotId,
                dailyLimit: 0,
                features: { ...DEFAULT_AI_FEATURES },
                note: '',
                updatedAtMs: 0,
              };
              const slotConfigured = slotStatusMap.get(draft.serverKeySlot);
              const savedPolicy = policyStore.complexes[comp.id];

              return (
                <div
                  key={comp.id}
                  className={`rounded-3xl border-2 p-4 sm:p-5 space-y-4 ${
                    draft.enabled && draft.tier !== 'disabled'
                      ? 'border-[#EADBC8] bg-[#FDF6EE]/45'
                      : 'border-[#D95338]/40 bg-[#D95338]/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] truncate">
                        {comp.name}
                      </h3>
                      <p className="text-[11px] font-bold text-[#7D4E35] truncate">
                        {comp.ownerDbLabel} · <span className="font-mono">{comp.id}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        updateComplexDraft(comp.id, {
                          enabled: !draft.enabled,
                          tier: !draft.enabled ? 'subscribed' : 'disabled',
                        })
                      }
                      className={`min-h-[38px] px-3 py-1 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer shrink-0 ${
                        draft.enabled && draft.tier !== 'disabled'
                          ? 'bg-[#58CC02] text-white'
                          : 'bg-[#D95338] text-white'
                      }`}
                    >
                      {draft.enabled && draft.tier !== 'disabled' ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>AI مفعّل</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-3.5 h-3.5" />
                          <span>AI موقوف</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1 block">
                      <span className="text-[11px] font-extrabold text-[#7D4E35]">حالة الاشتراك</span>
                      <select
                        value={draft.tier}
                        onChange={(e) => {
                          const nextTier = e.target.value as AiComplexSubscriptionTier;
                          updateComplexDraft(comp.id, {
                            tier: nextTier,
                            enabled: nextTier !== 'disabled',
                          });
                        }}
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                      >
                        <option value="subscribed">{AI_TIER_LABELS.subscribed}</option>
                        <option value="trial">{AI_TIER_LABELS.trial}</option>
                        <option value="disabled">{AI_TIER_LABELS.disabled}</option>
                      </select>
                    </label>

                    <label className="space-y-1 block">
                      <span className="text-[11px] font-extrabold text-[#7D4E35] flex items-center justify-between gap-1">
                        <span>مسار مفتاح الخادم</span>
                        {slotConfigured === false && (
                          <span className="text-[#D95338] text-[10px]">غير مضاف في الخادم</span>
                        )}
                      </span>
                      <select
                        value={draft.serverKeySlot}
                        onChange={(e) =>
                          updateComplexDraft(comp.id, {
                            serverKeySlot: e.target.value as AiServerKeySlotId,
                          })
                        }
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                      >
                        {ALL_SLOT_IDS.map((sid) => {
                          const configured = slotStatusMap.get(sid);
                          return (
                            <option key={sid} value={sid}>
                              {AI_SERVER_SLOT_LABELS[sid]}
                              {configured === true ? ' ✓' : configured === false ? ' (فارغ)' : ''}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </div>

                  {/* Feature Checkboxes */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-extrabold text-[#7D4E35]">
                      أدوات الذكاء الاصطناعي المسموحة للمجمع:
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {(
                        [
                          { key: 'ocr', label: 'تحليل الكتب' },
                          { key: 'tahajji', label: 'تهجي الفتح' },
                          { key: 'tts', label: 'الصوت TTS' },
                          { key: 'presentations', label: 'العروض AI' },
                        ] as { key: keyof AiFeaturePermissions; label: string }[]
                      ).map((f) => {
                        const active = draft.features[f.key];
                        return (
                          <button
                            key={f.key}
                            type="button"
                            onClick={() => toggleComplexFeature(comp.id, f.key)}
                            className={`min-h-[38px] px-2.5 py-1.5 rounded-xl border text-[11px] font-bold transition-colors cursor-pointer ${
                              active
                                ? 'bg-white border-[#58CC02] text-[#2F6F02]'
                                : 'bg-white/60 border-[#EADBC8] text-[#7D4E35] line-through opacity-75'
                            }`}
                          >
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                    <label className="sm:col-span-8 space-y-1 block">
                      <span className="text-[11px] font-extrabold text-[#7D4E35]">
                        ملاحظة الاشتراك / سبب التخصيص
                      </span>
                      <input
                        type="text"
                        value={draft.note}
                        onChange={(e) => updateComplexDraft(comp.id, { note: e.target.value })}
                        placeholder="مثال: اشتراك سنوي · مفتاح مستقل للمجمع"
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-xs text-[#4A220D]"
                      />
                    </label>
                    <div className="sm:col-span-4">
                      <button
                        type="button"
                        disabled={savingComplexId === comp.id}
                        onClick={() => void handleSaveComplexPolicy(comp.id)}
                        className="duo-btn-orange w-full min-h-[42px] px-3 py-2 rounded-xl font-display font-extrabold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>{savingComplexId === comp.id ? 'جاري الحفظ...' : 'حفظ المجمع'}</span>
                      </button>
                    </div>
                  </div>

                  {savedPolicy?.updatedAtMs ? (
                    <p className="text-[10px] font-bold text-[#7D4E35]">
                      آخر تحديث محفوظ: {formatDateTimeShort(savedPolicy.updatedAtMs)}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4. Per-Account AI Override & Slot Routing */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-extrabold text-[#4A220D] flex items-center gap-2">
              <Users className="w-5 h-5 text-[#F56900]" />
              <span>تعيين صلاحية ومسار الـ AI لكل حساب ({accounts.length})</span>
            </h2>
            <p className="text-xs text-[#7D4E35]">
              يمكنك منح حساب معيّن مفتاح خادم مخصص أو تفعيل/تعطيل الـ AI له بشكل مستقل عن إعدادات مجمعه.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-7 relative">
            <Search className="w-4 h-4 text-[#7D4E35] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              placeholder="ابحث بالاسم الرباعي أو البريد أو اسم المجمع..."
              className="w-full min-h-[44px] pr-10 pl-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-xs sm:text-sm text-[#4A220D]"
            />
          </div>
          <select
            value={accountComplexFilter}
            onChange={(e) => setAccountComplexFilter(e.target.value)}
            aria-label="تصفية الحسابات حسب المجمع"
            className="sm:col-span-5 min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-xs sm:text-sm font-bold text-[#4A220D]"
          >
            <option value="all">جميع المجمعات ({accounts.length})</option>
            <option value="unassigned">حسابات غير منضمة لمجمع</option>
            {complexes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {filteredAccounts.length === 0 ? (
          <div className="rounded-2xl border border-[#EADBC8] bg-[#FDF6EE]/70 p-8 text-center text-sm font-bold text-[#7D4E35]">
            لا توجد حسابات مطابقة للبحث الحالي.
          </div>
        ) : (
          <div className="space-y-3 max-h-[560px] overflow-y-auto pr-1">
            {filteredAccounts.slice(0, 80).map((entry) => {
              const acc = entry.account;
              const draft = accountDrafts[acc.id] || {
                accountId: acc.id,
                mode: 'inherit' as const,
                serverKeySlot: 'inherit' as const,
                tierLabel: '',
                note: '',
                updatedAtMs: 0,
              };
              const isCustom = draft.mode !== 'inherit' || draft.serverKeySlot !== 'inherit';

              return (
                <div
                  key={acc.id}
                  className={`rounded-2xl border-2 p-4 space-y-3 ${
                    draft.mode === 'disabled'
                      ? 'border-[#D95338]/40 bg-[#D95338]/5'
                      : isCustom
                      ? 'border-[#F56900]/45 bg-[#FDF6EE]/70'
                      : 'border-[#EADBC8] bg-white'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-display font-extrabold text-sm text-[#4A220D]">
                          {acc.quadrupleName}
                        </span>
                        <span className="px-2 py-0.5 rounded-lg bg-[#FDF6EE] border border-[#EADBC8] text-[11px] font-bold text-[#7D4E35]">
                          {ROLE_LABELS[acc.role]}
                        </span>
                        {entry.complexName && (
                          <span className="px-2 py-0.5 rounded-lg bg-[#58CC02]/10 border border-[#58CC02]/30 text-[11px] font-bold text-[#2F6F02]">
                            {entry.complexName}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[#7D4E35] mt-0.5">
                        {acc.email || 'بدون بريد مرتبط'} · <span className="font-mono">{acc.id}</span>
                      </p>
                    </div>

                    {isCustom && (
                      <span className="px-2.5 py-1 rounded-xl bg-[#F56900]/12 text-[#C95200] text-[11px] font-extrabold inline-flex items-center gap-1">
                        <UserCheck className="w-3.5 h-3.5" />
                        <span>إعداد مخصص</span>
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                    <label className="sm:col-span-3 space-y-1 block">
                      <span className="text-[11px] font-extrabold text-[#7D4E35]">حالة الحساب</span>
                      <select
                        value={draft.mode}
                        onChange={(e) =>
                          updateAccountDraft(acc.id, {
                            mode: e.target.value as AccountAiPolicy['mode'],
                          })
                        }
                        className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                      >
                        <option value="inherit">يرث إعداد المجمع</option>
                        <option value="enabled">مفعّل مخصص</option>
                        <option value="disabled">موقوف لهذا الحساب</option>
                      </select>
                    </label>

                    <label className="sm:col-span-4 space-y-1 block">
                      <span className="text-[11px] font-extrabold text-[#7D4E35]">مسار المفتاح</span>
                      <select
                        value={draft.serverKeySlot}
                        onChange={(e) =>
                          updateAccountDraft(acc.id, {
                            serverKeySlot: e.target.value as AccountAiPolicy['serverKeySlot'],
                          })
                        }
                        className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D]"
                      >
                        <option value="inherit">يرث مسار المجمع</option>
                        {ALL_SLOT_IDS.map((sid) => {
                          const configured = slotStatusMap.get(sid);
                          return (
                            <option key={sid} value={sid}>
                              {AI_SERVER_SLOT_LABELS[sid]}
                              {configured === true ? ' ✓' : configured === false ? ' (فارغ)' : ''}
                            </option>
                          );
                        })}
                      </select>
                    </label>

                    <label className="sm:col-span-3 space-y-1 block">
                      <span className="text-[11px] font-extrabold text-[#7D4E35]">ملاحظة</span>
                      <input
                        type="text"
                        value={draft.note}
                        onChange={(e) => updateAccountDraft(acc.id, { note: e.target.value })}
                        placeholder="باقة خاصة / سبب"
                        className="w-full min-h-[40px] px-2.5 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white text-xs text-[#4A220D]"
                      />
                    </label>

                    <div className="sm:col-span-2">
                      <button
                        type="button"
                        disabled={savingAccountId === acc.id}
                        onClick={() => void handleSaveAccountPolicy(acc.id)}
                        className="duo-btn-orange w-full min-h-[40px] px-3 py-1.5 rounded-xl font-display font-extrabold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>{savingAccountId === acc.id ? 'حفظ...' : 'حفظ'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
