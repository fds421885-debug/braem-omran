import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  Bot,
  Database,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { PlatformRulesAuditReport } from '../services/rulesAuditService';
import {
  gatherProgrammerAiPlatformSnapshot,
  type DiscoveredComplex,
} from '../services/platformService';
import type { ConnectedDatabaseInfo } from '../types/platform';

interface ProgrammerAiAssistantProps {
  complexes: DiscoveredComplex[];
  connectedDbs: ConnectedDatabaseInfo[];
  rulesAuditReport: PlatformRulesAuditReport | null;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestampMs: number;
  tokensUsed?: number;
  latencyMs?: number;
  usingCustomKey?: boolean;
  isError?: boolean;
}

interface SnapshotSummary {
  databasesCount: number;
  complexesCount: number;
  issuesCount: number;
  weaknessesCount: number;
  totalDocsCount: number;
  totalUsedBytes: number;
}

const SESSION_KEY_STORAGE = 'braem_admin_ai_custom_key';
const SESSION_LIMIT_TOKENS = 1_000_000;

function formatCompactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderInlineBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-extrabold text-[#4A220D]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function renderFormattedMessage(text: string): React.ReactNode {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-xs sm:text-[13px] leading-relaxed">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={i} className="h-1" />;
        }
        if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
          return (
            <div key={i} className="flex items-start gap-2 pr-1">
              <span className="text-[#F56900] font-black mt-0.5 shrink-0">•</span>
              <span>{renderInlineBold(trimmed.slice(2))}</span>
            </div>
          );
        }
        if (trimmed.startsWith('### ') || trimmed.startsWith('## ')) {
          const clean = trimmed.replace(/^#{2,3}\s+/, '');
          return (
            <p key={i} className="font-display font-extrabold text-[#F56900] pt-1">
              {clean}
            </p>
          );
        }
        return <p key={i}>{renderInlineBold(line)}</p>;
      })}
    </div>
  );
}

const QUICK_PROMPTS: string[] = [
  'أين تُخزَّن كل بيانات المجمعات والتبويبات حالياً؟',
  'ما نقاط الضعف والمشاكل أو الأخطاء المكتشفة في القواعد الآن؟',
  'أي قاعدة بيانات اقتربت من الامتلاء وكم تبقى على حدودها؟',
  'لخّص حالة الحسابات والكتب والمقررات مع توصيات سريعة',
];

export const ProgrammerAiAssistant: React.FC<ProgrammerAiAssistantProps> = ({
  complexes,
  connectedDbs,
  rulesAuditReport,
}) => {
  const [open, setOpen] = useState(false);

  // Temporary custom API key (stored strictly in sessionStorage — never in Firestore)
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    try {
      return typeof window !== 'undefined'
        ? window.sessionStorage.getItem(SESSION_KEY_STORAGE) || ''
        : '';
    } catch {
      return '';
    }
  });
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState(customApiKey);
  const [showKeyText, setShowKeyText] = useState(false);

  // Live snapshot telemetry
  const [snapshotText, setSnapshotText] = useState<string>('');
  const [snapshotSummary, setSnapshotSummary] = useState<SnapshotSummary | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  // Conversation & Limits counter
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [requestsCount, setRequestsCount] = useState(0);
  const [totalTokensUsed, setTotalTokensUsed] = useState(0);
  const [lastUsage, setLastUsage] = useState<{
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    latencyMs: number;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const snapshotPromiseRef = useRef<Promise<string> | null>(null);

  const buildQuickInstantContext = useCallback(() => {
    return JSON.stringify(
      {
        note: 'ملخص فوري أثناء استكمال المسح العميق للقواعد',
        connectedDatabases: connectedDbs.map((d) => ({
          label: d.label,
          projectId: d.config?.projectId || 'primary',
          firestoreDatabaseId: d.config?.firestoreDatabaseId || '(default)',
          isPrimary: d.isPrimary,
        })),
        complexes: complexes.map((c) => ({
          id: c.id,
          name: c.name,
          storageLocation: c.isExternal ? c.ownerDbLabel : 'القاعدة الأساسية',
        })),
        rulesHealthAudit: rulesAuditReport
          ? {
              allHealthy: rulesAuditReport.allHealthy,
              totalDatabases: rulesAuditReport.totalDatabases,
              healthyCount: rulesAuditReport.healthyCount,
              unhealthyDatabases: rulesAuditReport.unhealthyDatabases.map((u) => ({
                dbLabel: u.dbLabel,
                projectId: u.projectId,
                issues: u.issues.map((i) => i.title),
              })),
            }
          : null,
      },
      null,
      2
    );
  }, [complexes, connectedDbs, rulesAuditReport]);

  const refreshSnapshot = useCallback(async (): Promise<string> => {
    if (snapshotPromiseRef.current) {
      return snapshotPromiseRef.current;
    }
    setLoadingSnapshot(true);
    const run = gatherProgrammerAiPlatformSnapshot({
      complexes,
      connectedDbs,
      rulesAuditReport,
    })
      .then((res) => {
        setSnapshotText(res.snapshotText);
        setSnapshotSummary(res.summary);
        return res.snapshotText;
      })
      .catch(() => snapshotText || buildQuickInstantContext())
      .finally(() => {
        snapshotPromiseRef.current = null;
        setLoadingSnapshot(false);
      });
    snapshotPromiseRef.current = run;
    return run;
  }, [complexes, connectedDbs, rulesAuditReport, snapshotText, buildQuickInstantContext]);

  useEffect(() => {
    if (open && !snapshotText && !snapshotPromiseRef.current) {
      void refreshSnapshot();
    }
  }, [open, snapshotText, refreshSnapshot]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSaveCustomKey = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyDraft.trim();
    setCustomApiKey(trimmed);
    try {
      if (trimmed) {
        window.sessionStorage.setItem(SESSION_KEY_STORAGE, trimmed);
      } else {
        window.sessionStorage.removeItem(SESSION_KEY_STORAGE);
      }
    } catch {
      // Non-fatal
    }
    setKeyEditorOpen(false);
  };

  const handleClearCustomKey = () => {
    setKeyDraft('');
    setCustomApiKey('');
    try {
      window.sessionStorage.removeItem(SESSION_KEY_STORAGE);
    } catch {
      // Non-fatal
    }
    setKeyEditorOpen(false);
  };

  const sendMessageText = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || sending) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestampMs: Date.now(),
    };

    const historyForApi = messages
      .filter((m) => !m.isError)
      .slice(-12)
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    try {
      let currentContext = snapshotText;
      if (!currentContext) {
        const snapshotPromise = refreshSnapshot();
        const budgetPromise = new Promise<string>((resolve) => {
          window.setTimeout(() => resolve(''), 1800);
        });
        currentContext = (await Promise.race([snapshotPromise, budgetPromise])) || buildQuickInstantContext();
      }

      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), 22000);
      let resp: Response;
      try {
        resp = await fetch('/api/admin/ai-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            message: trimmed,
            history: historyForApi,
            systemContext: currentContext,
            customApiKey: customApiKey.trim() || undefined,
          }),
        });
      } finally {
        window.clearTimeout(abortTimer);
      }

      const data = (await resp.json().catch(() => null)) as {
        reply?: string;
        error?: string;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
        latencyMs?: number;
        usingCustomKey?: boolean;
      } | null;

      if (!resp.ok || !data?.reply) {
        throw new Error(data?.error || 'تعذّر الحصول على استجابة من المساعد الذكي.');
      }

      const promptTok = Number(data.usageMetadata?.promptTokenCount || 0);
      const candTok = Number(data.usageMetadata?.candidatesTokenCount || 0);
      const totalTok = Number(data.usageMetadata?.totalTokenCount || promptTok + candTok);
      const latency = Number(data.latencyMs || 0);

      setRequestsCount((prev) => prev + 1);
      setTotalTokensUsed((prev) => prev + totalTok);
      setLastUsage({
        promptTokenCount: promptTok,
        candidatesTokenCount: candTok,
        totalTokenCount: totalTok,
        latencyMs: latency,
      });

      const botMsg: ChatMessage = {
        id: `m_${Date.now()}`,
        role: 'model',
        text: data.reply,
        timestampMs: Date.now(),
        tokensUsed: totalTok,
        latencyMs: latency,
        usingCustomKey: Boolean(data.usingCustomKey),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      const isAbort =
        err instanceof DOMException && err.name === 'AbortError';
      const errorText = isAbort
        ? 'انتهت مهلة انتظار الرد؛ أعد المحاولة مرة أخرى.'
        : err instanceof Error
        ? err.message
        : 'حدث خطأ غير متوقع أثناء الاتصال بالذكاء الاصطناعي.';
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: 'model',
          text: errorText,
          timestampMs: Date.now(),
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessageText(input);
  };

  const tokenUsagePercent = useMemo(
    () => Math.min(100, Number(((totalTokensUsed / SESSION_LIMIT_TOKENS) * 100).toFixed(2))),
    [totalTokensUsed]
  );

  const detectedAlertCount =
    (rulesAuditReport && !rulesAuditReport.allHealthy
      ? rulesAuditReport.unhealthyDatabases.length
      : 0) + (snapshotSummary?.weaknessesCount || 0);

  return (
    <>
      {/* Floating Toggle Button */}
      <AnimatePresence>
        {!open && (
          <motion.button
            key="ai-fab"
            type="button"
            initial={{ scale: 0.7, opacity: 0, y: 24 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.65, opacity: 0, y: 24 }}
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 420, damping: 24 }}
            onClick={() => setOpen(true)}
            aria-label="فتح مساعد المبرمج الذكي"
            className="fixed bottom-20 md:bottom-6 left-4 sm:left-6 z-50 duo-btn-orange min-h-[54px] px-4 py-3 rounded-2xl shadow-xl inline-flex items-center gap-2.5 cursor-pointer"
          >
            <span className="relative w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-white" />
              {detectedAlertCount > 0 && (
                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[#58CC02] border-2 border-white animate-pulse" />
              )}
            </span>
            <div className="text-right leading-tight">
              <span className="block font-display font-extrabold text-xs sm:text-sm text-white">
                مساعد المبرمج AI
              </span>
              <span className="block text-[10px] font-bold text-white/90">
                فحص شامل · ذكي وسريع
              </span>
            </div>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Spring-Animated Floating Chat Window */}
      <AnimatePresence>
        {open && (
          <motion.section
            key="ai-panel"
            dir="rtl"
            role="dialog"
            aria-label="مساعد المبرمج الذكي لتحليل المنصة والقواعد"
            initial={{ opacity: 0, scale: 0.78, y: 40, transformOrigin: 'bottom left' }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.76, y: 36 }}
            transition={{ type: 'spring', stiffness: 360, damping: 26 }}
            className="fixed bottom-3 left-3 right-3 sm:right-auto sm:left-6 sm:bottom-6 sm:w-[465px] h-[82vh] max-h-[680px] z-[75] bg-white border-2 border-[#EADBC8] rounded-3xl shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Top Header */}
            <div className="bg-gradient-to-l from-[#F56900] to-[#FF851B] text-white px-4 py-3 flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
                  <Bot className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h2 className="font-display font-extrabold text-sm sm:text-base truncate">
                      مساعد المبرمج الذكي
                    </h2>
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-white/20 text-[10px] font-extrabold whitespace-nowrap">
                      <Zap className="w-3 h-3" />
                      سريع
                    </span>
                  </div>
                  <p className="text-[11px] font-bold text-white/90 truncate">
                    {customApiKey ? 'يعمل بمفتاح API مخصص للجلسة' : 'يعمل بمفتاح الخادم الافتراضي'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setKeyDraft(customApiKey);
                    setKeyEditorOpen((v) => !v);
                  }}
                  title="تعيين أو تعديل مفتاح API المخصص"
                  aria-label="تعديل مفتاح API"
                  className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                    keyEditorOpen || customApiKey
                      ? 'bg-white text-[#F56900]'
                      : 'bg-white/20 hover:bg-white/30 text-white'
                  }`}
                >
                  <Edit3 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void refreshSnapshot()}
                  disabled={loadingSnapshot}
                  title="تحديث القراءة المباشرة لكل القواعد والبيانات"
                  aria-label="تحديث البيانات الحية"
                  className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 text-white flex items-center justify-center cursor-pointer disabled:opacity-60"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingSnapshot ? 'animate-spin' : ''}`} />
                </button>
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMessages([])}
                    title="مسح المحادثة"
                    aria-label="مسح المحادثة"
                    className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 text-white flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="إخفاء المساعد"
                  aria-label="إغلاق مساعد المبرمج"
                  className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 text-white flex items-center justify-center cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Collapsible Custom API Key Editor (Pencil Button) */}
            <AnimatePresence>
              {keyEditorOpen && (
                <motion.form
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  onSubmit={handleSaveCustomKey}
                  className="overflow-hidden bg-[#FFF9F2] border-b-2 border-[#EADBC8] shrink-0"
                >
                  <div className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-extrabold text-[#4A220D] flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5 text-[#F56900]" />
                        <span>مفتاح Gemini API مخصص لهذه الجلسة (بدل الافتراضي)</span>
                      </label>
                      {customApiKey && (
                        <button
                          type="button"
                          onClick={handleClearCustomKey}
                          className="text-[11px] font-bold text-[#D95338] hover:underline cursor-pointer"
                        >
                          رجوع للافتراضي
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showKeyText ? 'text' : 'password'}
                          value={keyDraft}
                          onChange={(e) => setKeyDraft(e.target.value)}
                          placeholder="AIzaSy... (اتركه فارغاً للافتراضي)"
                          dir="ltr"
                          className="w-full min-h-[38px] pl-9 pr-3 rounded-xl border-2 border-[#EADBC8] bg-white text-xs font-mono text-[#4A220D] focus:outline-none focus:border-[#F56900]"
                        />
                        <button
                          type="button"
                          onClick={() => setShowKeyText((v) => !v)}
                          aria-label={showKeyText ? 'إخفاء المفتاح' : 'إظهار المفتاح'}
                          className="absolute left-2 top-1/2 -translate-y-1/2 text-[#7D4E35] hover:text-[#4A220D] cursor-pointer"
                        >
                          {showKeyText ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      <button
                        type="submit"
                        className="duo-btn-green min-h-[38px] px-3 rounded-xl font-display font-bold text-xs cursor-pointer shrink-0"
                      >
                        تطبيق
                      </button>
                    </div>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>

            {/* Limits Counter & Telemetry Strip */}
            <div className="bg-[#FDF6EE] border-b border-[#EADBC8] px-3.5 py-2 space-y-1.5 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-[#4A220D]">
                <span className="inline-flex items-center gap-1">
                  <Activity className="w-3.5 h-3.5 text-[#F56900]" />
                  <span>عداد الحدود:</span>
                  <strong className="tabular-nums text-[#F56900]">{requestsCount}</strong>
                  <span className="text-[#7D4E35]">طلب</span>
                  <span>·</span>
                  <strong className="tabular-nums text-[#46A302]">
                    {totalTokensUsed.toLocaleString('en-US')}
                  </strong>
                  <span className="text-[#7D4E35]">/ 1M توكن</span>
                </span>
                {lastUsage && (
                  <span className="text-[10px] font-bold text-[#7D4E35] tabular-nums">
                    آخر رد: {lastUsage.latencyMs}ms · ({lastUsage.promptTokenCount}+
                    {lastUsage.candidatesTokenCount})
                  </span>
                )}
              </div>

              <div className="w-full h-1.5 rounded-full bg-[#EADBC8] overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    tokenUsagePercent >= 80
                      ? 'bg-[#D95338]'
                      : tokenUsagePercent >= 45
                      ? 'bg-[#FFA900]'
                      : 'bg-[#58CC02]'
                  }`}
                  style={{ width: `${Math.max(tokenUsagePercent > 0 ? 3 : 0, tokenUsagePercent)}%` }}
                />
              </div>

              {/* Live Platform Context Chips */}
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[10px] font-extrabold">
                {loadingSnapshot ? (
                  <span className="text-[#7D4E35]">جاري مسح جميع القواعد والمجمعات...</span>
                ) : snapshotSummary ? (
                  <>
                    <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] text-[#4A220D] inline-flex items-center gap-1 tabular-nums">
                      <Database className="w-3 h-3 text-[#F56900]" />
                      قواعد: {snapshotSummary.databasesCount}
                    </span>
                    <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] text-[#4A220D] tabular-nums">
                      مجمعات: {snapshotSummary.complexesCount}
                    </span>
                    <span className="px-2 py-0.5 rounded-lg bg-white border border-[#EADBC8] text-[#4A220D] tabular-nums">
                      وثائق: {snapshotSummary.totalDocsCount} (
                      {formatCompactBytes(snapshotSummary.totalUsedBytes)})
                    </span>
                    {(snapshotSummary.issuesCount > 0 || snapshotSummary.weaknessesCount > 0) && (
                      <span className="px-2 py-0.5 rounded-lg bg-[#D95338]/10 border border-[#D95338]/40 text-[#D95338] inline-flex items-center gap-1 tabular-nums">
                        <ShieldAlert className="w-3 h-3" />
                        تنبيهات: {snapshotSummary.issuesCount + snapshotSummary.weaknessesCount}
                      </span>
                    )}
                  </>
                ) : null}
              </div>
            </div>

            {/* Messages Thread */}
            <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3 bg-white">
              {messages.length === 0 ? (
                <div className="space-y-3 py-2">
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 space-y-1.5">
                    <p className="font-display font-extrabold text-sm text-[#4A220D] flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-[#F56900]" />
                      <span>أهلاً بك أيها المبرمج!</span>
                    </p>
                    <p className="text-xs text-[#7D4E35] leading-relaxed">
                      لدي وصول كامل للقراءة المباشرة على جميع القواعد والمجمعات، الشرائح (Shards)، استهلاك التخزين المتبقي، وأخطاء Rules ونقاط الضعف. اسألني عن أي تفصيل:
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-[11px] font-extrabold text-[#7D4E35]">أسئلة تشخيص سريعة:</p>
                    <div className="flex flex-col gap-1.5">
                      {QUICK_PROMPTS.map((qp) => (
                        <button
                          key={qp}
                          type="button"
                          disabled={sending}
                          onClick={() => void sendMessageText(qp)}
                          className="text-right px-3 py-2 rounded-xl border border-[#EADBC8] bg-[#FDF6EE]/70 hover:bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] transition-colors cursor-pointer"
                        >
                          {qp}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      msg.role === 'user' ? 'items-start' : 'items-end'
                    }`}
                  >
                    <div
                      className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 ${
                        msg.role === 'user'
                          ? 'bg-[#F56900] text-white rounded-tr-sm'
                          : msg.isError
                          ? 'bg-[#D95338]/10 border border-[#D95338] text-[#D95338] rounded-tl-sm'
                          : 'bg-[#FDF6EE] border border-[#EADBC8] text-[#4A220D] rounded-tl-sm'
                      }`}
                    >
                      {msg.role === 'user' ? (
                        <p className="text-xs sm:text-[13px] font-bold whitespace-pre-wrap leading-relaxed">
                          {msg.text}
                        </p>
                      ) : (
                        renderFormattedMessage(msg.text)
                      )}
                    </div>
                    {msg.role === 'model' && !msg.isError && (
                      <span className="text-[10px] font-bold text-[#7D4E35] mt-1 px-1 tabular-nums">
                        {msg.latencyMs ? `${msg.latencyMs}ms` : ''}
                        {msg.tokensUsed ? ` · ${msg.tokensUsed} توكن` : ''}
                        {msg.usingCustomKey ? ' · مفتاح مخصص' : ''}
                      </span>
                    )}
                  </div>
                ))
              )}

              {sending && (
                <div className="flex justify-end">
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl rounded-tl-sm px-3.5 py-2.5 inline-flex items-center gap-2 text-xs font-bold text-[#7D4E35]">
                    <span className="w-2 h-2 rounded-full bg-[#F56900] animate-bounce" />
                    <span className="w-2 h-2 rounded-full bg-[#F56900] animate-bounce [animation-delay:120ms]" />
                    <span className="w-2 h-2 rounded-full bg-[#F56900] animate-bounce [animation-delay:240ms]" />
                    <span>جاري التحليل السريع...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <form
              onSubmit={handleSubmit}
              className="p-3 border-t-2 border-[#EADBC8] bg-[#FDF6EE]/60 flex items-end gap-2 shrink-0"
            >
              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessageText(input);
                  }
                }}
                placeholder="اسأل عن تخزين أي بيان، أخطاء Rules، أو الحدود..."
                className="flex-1 min-h-[42px] max-h-28 px-3.5 py-2.5 rounded-2xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm text-[#4A220D] focus:outline-none focus:border-[#F56900] resize-none"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                aria-label="إرسال الرسالة"
                className="duo-btn-orange w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </motion.section>
        )}
      </AnimatePresence>
    </>
  );
};
