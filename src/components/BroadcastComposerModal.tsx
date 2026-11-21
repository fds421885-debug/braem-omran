import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Firestore } from 'firebase/firestore';
import {
  AlertCircle,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  Megaphone,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import {
  BROADCAST_OUTBOX_EVENT,
  BroadcastRulesPermissionError,
  deactivateBroadcastMessage,
  deleteBroadcastMessage,
  flushPendingBroadcastOutbox,
  getPendingBroadcastOutbox,
  listRecentBroadcasts,
  removeOfflineBroadcast,
  rescheduleBroadcastMessage,
  sendBroadcastMessage,
  type BroadcastScopeOptions,
  type PendingBroadcastOutboxItem,
} from '../services/notificationService';
import type { DiscoveredComplex } from '../services/platformService';
import {
  BROADCAST_ROLE_LABELS,
  type BroadcastMessageRecord,
  type BroadcastTargetRole,
  type ExternalFirebaseConfig,
} from '../types/platform';

interface BroadcastComposerModalProps {
  senderName: string;
  createdBy: string;
  complexes: DiscoveredComplex[];
  lockedComplex?: { id: string; name: string };
  targetDb?: Firestore;
  targetDbConfig?: ExternalFirebaseConfig | null;
  mirrorDbs?: Firestore[];
  mirrorDbConfigs?: ExternalFirebaseConfig[];
  isSupervisorView?: boolean;
  isQuickSession?: boolean;
  isExternalComplex?: boolean;
  onClose: () => void;
}

const ALL_TARGET_ROLES: BroadcastTargetRole[] = ['supervisor', 'teacher', 'student'];

const BROADCAST_RULES_SNIPPET = `    function isValidBroadcast(data, broadcastId) {
      return data.keys().hasAll([
          'id', 'title', 'body', 'targetRoles', 'targetComplexId',
          'targetComplexName', 'senderName', 'createdBy', 'active',
          'createdAtMs', 'createdAt', 'updatedAt'
        ])
        && data.keys().hasOnly([
          'id', 'title', 'body', 'targetRoles', 'targetComplexId',
          'targetComplexName', 'senderName', 'createdBy', 'active',
          'createdAtMs', 'createdAt', 'updatedAt'
        ])
        && data.id is string && data.id == broadcastId && isValidId(data.id)
        && data.title is string && data.title.size() >= 1 && data.title.size() <= 160
        && data.body is string && data.body.size() >= 1 && data.body.size() <= 4000
        && data.targetRoles is list
        && data.targetRoles.size() >= 1 && data.targetRoles.size() <= 3
        && data.targetRoles.hasOnly(['supervisor', 'teacher', 'student'])
        && data.targetComplexId is string && data.targetComplexId.size() >= 1 && data.targetComplexId.size() <= 128
        && data.targetComplexName is string && data.targetComplexName.size() <= 160
        && data.senderName is string && data.senderName.size() >= 1 && data.senderName.size() <= 120
        && data.createdBy is string && data.createdBy.size() >= 1 && data.createdBy.size() <= 128
        && data.active is bool
        && data.createdAtMs is int && data.createdAtMs >= 0
        && data.createdAt is timestamp
        && data.updatedAt is timestamp;
    }

    match /broadcasts/{broadcastId} {
      allow get: if isValidId(broadcastId) && (
        isPlatformAdmin()
        || (resource != null && resource.data.active == true)
        || (
          resource != null
          && resource.data.targetComplexId is string
          && resource.data.targetComplexId != 'all'
          && isComplexSupervisor(resource.data.targetComplexId)
        )
      );
      allow list: if isPlatformAdmin()
        || resource.data.active == true
        || (
          resource.data.targetComplexId is string
          && resource.data.targetComplexId != 'all'
          && isComplexSupervisor(resource.data.targetComplexId)
        );
      allow create: if (
          isPlatformAdmin()
          || (
            incoming().targetComplexId != 'all'
            && isComplexSupervisor(incoming().targetComplexId)
          )
        )
        && isValidId(broadcastId)
        && isValidBroadcast(incoming(), broadcastId)
        && incoming().createdBy == request.auth.uid
        && incoming().createdAt == request.time
        && incoming().updatedAt == request.time;
      allow update: if (
          isPlatformAdmin()
          || (
            existing().targetComplexId != 'all'
            && isComplexSupervisor(existing().targetComplexId)
            && incoming().targetComplexId == existing().targetComplexId
          )
        )
        && isValidId(broadcastId)
        && isValidBroadcast(incoming(), broadcastId)
        && incoming().id == existing().id
        && incoming().createdBy == existing().createdBy
        && incoming().createdAt == existing().createdAt
        && incoming().updatedAt == request.time
        && incoming().diff(existing()).affectedKeys().hasOnly([
          'title', 'body', 'targetRoles', 'targetComplexId', 'targetComplexName',
          'active', 'updatedAt'
        ]);
      allow delete: if isValidId(broadcastId) && (
        isPlatformAdmin()
        || (
          existing().targetComplexId is string
          && existing().targetComplexId != 'all'
          && isComplexSupervisor(existing().targetComplexId)
        )
      );
    }`;

function toLocalDateInput(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalTimeInput(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function combineDateAndTimeToMs(dateStr: string, timeStr: string): number | null {
  if (!dateStr || !timeStr) return null;
  const parsed = new Date(`${dateStr}T${timeStr}`);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatArabicScheduleLabel(ms: number): string {
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString('ar-SA');
  }
}

function formatRemainingDelay(targetMs: number, nowMs: number): string {
  const diffMin = Math.max(1, Math.round((targetMs - nowMs) / 60000));
  if (diffMin < 60) return `بعد ${diffMin} دقيقة`;
  const hours = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (hours < 24) {
    return remMin > 0 ? `بعد ${hours} س و${remMin} د` : `بعد ${hours} ساعة`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `بعد ${days} يوم و${remHours} س` : `بعد ${days} يوم`;
}

export const BroadcastComposerModal: React.FC<BroadcastComposerModalProps> = ({
  senderName,
  createdBy,
  complexes,
  lockedComplex,
  targetDb,
  targetDbConfig = null,
  mirrorDbs,
  mirrorDbConfigs,
  isSupervisorView = false,
  isQuickSession = false,
  isExternalComplex = false,
  onClose,
}) => {
  const scopedComplexOnly = Boolean(lockedComplex);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<BroadcastTargetRole[]>([
    'supervisor',
    'teacher',
    'student',
  ]);
  const [targetComplexId, setTargetComplexId] = useState(lockedComplex?.id || 'all');

  const [deliveryMode, setDeliveryMode] = useState<'now' | 'scheduled'>('now');
  const [scheduleDate, setScheduleDate] = useState(() =>
    toLocalDateInput(Date.now() + 60 * 60 * 1000)
  );
  const [scheduleTime, setScheduleTime] = useState(() =>
    toLocalTimeInput(Date.now() + 60 * 60 * 1000)
  );
  const [editingScheduledId, setEditingScheduledId] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [flushingOutbox, setFlushingOutbox] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsRulesHelp, setNeedsRulesHelp] = useState(false);
  const [copiedRules, setCopiedRules] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [history, setHistory] = useState<BroadcastMessageRecord[]>([]);
  const [outboxItems, setOutboxItems] = useState<PendingBroadcastOutboxItem[]>(() =>
    getPendingBroadcastOutbox(lockedComplex?.id)
  );
  const [isOffline, setIsOffline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine === false : false
  );
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const scopeOptions: BroadcastScopeOptions = useMemo(
    () => ({
      targetDb,
      targetDbConfig,
      mirrorDbs,
      mirrorDbConfigs,
      complexId: lockedComplex?.id,
      scopedComplexOnly,
      actorUid: createdBy,
    }),
    [targetDb, targetDbConfig, mirrorDbs, mirrorDbConfigs, lockedComplex?.id, scopedComplexOnly, createdBy]
  );

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const items = await listRecentBroadcasts(scopeOptions);
      setHistory(items.filter((m) => m.active));
      setNowMs(Date.now());
    } finally {
      setLoadingHistory(false);
    }
  }, [scopeOptions]);

  useEffect(() => {
    void loadHistory();
    const timer = window.setInterval(() => setNowMs(Date.now()), 20000);

    const syncOutboxAndNet = () => {
      setIsOffline(typeof navigator !== 'undefined' ? navigator.onLine === false : false);
      setOutboxItems(getPendingBroadcastOutbox(lockedComplex?.id));
    };

    const handleOutboxChanged = () => {
      setOutboxItems(getPendingBroadcastOutbox(lockedComplex?.id));
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        void loadHistory();
      }
    };

    window.addEventListener('online', syncOutboxAndNet);
    window.addEventListener('offline', syncOutboxAndNet);
    window.addEventListener(BROADCAST_OUTBOX_EVENT, handleOutboxChanged);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', syncOutboxAndNet);
      window.removeEventListener('offline', syncOutboxAndNet);
      window.removeEventListener(BROADCAST_OUTBOX_EVENT, handleOutboxChanged);
    };
  }, [loadHistory, lockedComplex?.id]);

  const scheduledMessages = useMemo(
    () =>
      history
        .filter((m) => m.active && m.createdAtMs > nowMs)
        .sort((a, b) => a.createdAtMs - b.createdAtMs),
    [history, nowMs]
  );

  const sentActiveMessages = useMemo(
    () =>
      history
        .filter((m) => m.active && m.createdAtMs <= nowMs)
        .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
        .slice(0, 10),
    [history, nowMs]
  );

  const scheduledTimestampMs = useMemo(
    () => combineDateAndTimeToMs(scheduleDate, scheduleTime),
    [scheduleDate, scheduleTime]
  );

  const allSelected = ALL_TARGET_ROLES.every((r) => selectedRoles.includes(r));

  const toggleRole = (role: BroadcastTargetRole) => {
    setError(null);
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleToggleAll = () => {
    setError(null);
    if (allSelected) {
      setSelectedRoles([]);
    } else {
      setSelectedRoles([...ALL_TARGET_ROLES]);
    }
  };

  const applySchedulePreset = (targetMs: number) => {
    setError(null);
    setDeliveryMode('scheduled');
    setScheduleDate(toLocalDateInput(targetMs));
    setScheduleTime(toLocalTimeInput(targetMs));
  };

  const handleTomorrowAt = (hour24: number) => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(hour24, 0, 0, 0);
    applySchedulePreset(d.getTime());
  };

  const handleCopyRulesSnippet = async () => {
    try {
      await navigator.clipboard.writeText(BROADCAST_RULES_SNIPPET);
      setCopiedRules(true);
      window.setTimeout(() => setCopiedRules(false), 2500);
    } catch {
      setCopiedRules(false);
    }
  };

  const resetComposer = () => {
    setTitle('');
    setBody('');
    setEditingScheduledId(null);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setNeedsRulesHelp(false);

    if (selectedRoles.length === 0) {
      setError('اختر فئة مستهدفة واحدة على الأقل (المشرفين أو المعلمين أو الطلاب أو الكل).');
      return;
    }
    if (!body.trim()) {
      setError('يرجى كتابة نص الرسالة قبل الإرسال.');
      return;
    }

    let publishAtMs: number | undefined;
    if (deliveryMode === 'scheduled') {
      if (!scheduledTimestampMs || scheduledTimestampMs <= Date.now() + 30 * 1000) {
        setError('يرجى اختيار تاريخ ووقت مستقبلي صحيح للرسالة المجدولة (بعد دقيقة على الأقل).');
        return;
      }
      publishAtMs = scheduledTimestampMs;
    }

    const effectiveComplexId = lockedComplex ? lockedComplex.id : targetComplexId;
    const pickedComplex = complexes.find((c) => c.id === effectiveComplexId);
    const targetComplexName = lockedComplex
      ? lockedComplex.name
      : effectiveComplexId === 'all'
        ? 'جميع المجمعات'
        : pickedComplex?.name || 'المجمع المحدد';

    setSending(true);
    try {
      const sentRecord = await sendBroadcastMessage({
        title: title.trim() || (lockedComplex ? 'رسالة من إدارة المجمع' : 'رسالة من إدارة المنصة'),
        body: body.trim(),
        targetRoles: selectedRoles,
        targetComplexId: effectiveComplexId,
        targetComplexName,
        senderName,
        createdBy,
        scheduledAtMs: publishAtMs,
        targetDb,
        targetDbConfig,
        mirrorDbs,
        mirrorDbConfigs,
        scopedComplexOnly,
      });

      if (editingScheduledId) {
        await deleteBroadcastMessage(editingScheduledId, scopeOptions).catch(() =>
          deactivateBroadcastMessage(editingScheduledId, scopeOptions).catch(() => {})
        );
      }

      const wasEditing = Boolean(editingScheduledId);
      resetComposer();

      if (sentRecord.queuedOffline) {
        setOutboxItems(getPendingBroadcastOutbox(lockedComplex?.id));
        setSuccessMsg(
          publishAtMs
            ? 'لا يوجد اتصال بالإنترنت حالياً — تم حفظ الرسالة المجدولة في قائمة الانتظار وستُرسل تلقائياً فور عودة الإنترنت لتصل في موعدها.'
            : 'لا يوجد اتصال بالإنترنت حالياً — تم حفظ الرسالة وستُرسل وتصل للمستلمين تلقائياً فور عودة الإنترنت.'
        );
      } else if (publishAtMs) {
        setSuccessMsg(
          wasEditing
            ? `تم تحديث جدولة الرسالة بنجاح! ستصل تلقائياً في موعدها (${formatArabicScheduleLabel(
                publishAtMs
              )}).`
            : `تمت جدولة الرسالة بنجاح! ستظهر وتُرسل إشعاراتها تلقائياً في ${formatArabicScheduleLabel(
                publishAtMs
              )} دون الحاجة لتحديث الصفحة.`
        );
      } else {
        setSuccessMsg(
          'تم إرسال الرسالة بنجاح! ستظهر الآن فوراً داخل التطبيق وفوق شاشة الهاتف لدى جميع المستهدفين.'
        );
      }

      if (!sentRecord.queuedOffline) {
        await loadHistory();
      }
    } catch (err: unknown) {
      if (err instanceof BroadcastRulesPermissionError && !isQuickSession) {
        setNeedsRulesHelp(true);
      }
      setError(
        err instanceof Error ? err.message : 'تعذّر إرسال الرسالة، حاول مرة أخرى.'
      );
    } finally {
      setSending(false);
    }
  };

  const handleLoadScheduledForEdit = (item: BroadcastMessageRecord) => {
    setError(null);
    setSuccessMsg(null);
    setEditingScheduledId(item.id);
    setTitle(item.title);
    setBody(item.body);
    setSelectedRoles(item.targetRoles.length > 0 ? [...item.targetRoles] : [...ALL_TARGET_ROLES]);
    setTargetComplexId(lockedComplex ? lockedComplex.id : item.targetComplexId || 'all');
    setDeliveryMode('scheduled');
    const targetMs = item.createdAtMs > Date.now() ? item.createdAtMs : Date.now() + 3600000;
    setScheduleDate(toLocalDateInput(targetMs));
    setScheduleTime(toLocalTimeInput(targetMs));
  };

  const handleSendScheduledNow = async (item: BroadcastMessageRecord) => {
    setError(null);
    setSuccessMsg(null);
    setBusyActionId(item.id);
    try {
      const updated = await rescheduleBroadcastMessage(item, Date.now(), scopeOptions);
      if (editingScheduledId === item.id) {
        resetComposer();
      }
      if (updated.queuedOffline) {
        setOutboxItems(getPendingBroadcastOutbox(lockedComplex?.id));
        setSuccessMsg('لا يوجد اتصال بالإنترنت حالياً — تم حفظ الإرسال الفوري وسيُنفذ تلقائياً فور عودة الإنترنت.');
      } else {
        setSuccessMsg('تم إرسال الرسالة المجدولة فوراً إلى جميع المستهدفين!');
        await loadHistory();
      }
    } catch {
      setError('تعذّر إرسال الرسالة المجدولة الآن.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleCancelScheduled = async (id: string) => {
    setBusyActionId(id);
    try {
      await deleteBroadcastMessage(id, scopeOptions).catch(() =>
        deactivateBroadcastMessage(id, scopeOptions)
      );
      if (editingScheduledId === id) {
        resetComposer();
      }
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch {
      setError('تعذّر إلغاء الرسالة المجدولة.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleDeactivate = async (id: string) => {
    setBusyActionId(id);
    try {
      await deactivateBroadcastMessage(id, scopeOptions);
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch {
      setError('تعذّر إيقاف الرسالة.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleFlushOutboxNow = async () => {
    setFlushingOutbox(true);
    setError(null);
    try {
      const res = await flushPendingBroadcastOutbox();
      setOutboxItems(getPendingBroadcastOutbox(lockedComplex?.id));
      if (res.sentIds.length > 0) {
        setSuccessMsg(`تم إرسال ${res.sentIds.length} رسالة معلّقة بنجاح بعد استعادة الاتصال!`);
        await loadHistory();
      } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setError('لا يزال الجهاز غير متصل بالإنترنت، سيتم الإرسال تلقائياً فور عودة الشبكة.');
      }
    } finally {
      setFlushingOutbox(false);
    }
  };

  const minDateStr = toLocalDateInput(Date.now());

  const modalNode = (
    <div
      dir="rtl"
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="programmer-message-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-l from-[#FFF4E6] via-[#FDF6EE] to-white px-5 sm:px-6 py-4 border-b-2 border-[#EADBC8] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-[#F56900] text-white border-b-4 border-[#C95200] flex items-center justify-center shrink-0">
              <Megaphone className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="programmer-message-title"
                className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] truncate"
              >
                إرسال وجدولة الرسائل والإشعارات
              </h2>
              <p className="text-xs font-bold text-[#7D4E35]">
                إرسال فوري أو جدولة لوقت محدد تصل تلقائياً داخل المنصة وفوق شاشة الهاتف
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-5 sm:p-6 space-y-6">
          {isOffline && (
            <div className="rounded-2xl bg-[#FFA900]/12 border-2 border-[#FFA900] px-4 py-3 text-xs sm:text-sm font-bold text-[#7D4E35] flex items-center gap-2.5">
              <WifiOff className="w-4 h-4 text-[#D98A00] shrink-0" />
              <span>
                أنت غير متصل بالإنترنت حالياً — يمكنك كتابة الرسالة وإرسالها أو جدولتها الآن، وسيتم إرسالها وإيصالها للمستلمين تلقائياً فور عودة الإنترنت.
              </span>
            </div>
          )}

          {isSupervisorView && isQuickSession && !isExternalComplex && (
            <div className="rounded-2xl bg-[#FFA900]/12 border-2 border-[#FFA900] px-4 py-3 text-xs sm:text-sm font-bold text-[#7D4E35] flex items-center gap-2.5">
              <ShieldAlert className="w-4 h-4 text-[#D98A00] shrink-0" />
              <span>
                أنت تتصفح الآن عبر رابط دخول سريع. لإرسال الرسائل على القاعدة الأساسية يُفضّل الدخول بحساب جوجل المرتبط بحساب المشرف.
              </span>
            </div>
          )}

          <form onSubmit={handleSend} className="space-y-4">
            {editingScheduledId && (
              <div className="rounded-2xl bg-[#FFF4E6] border-2 border-[#F56900] px-4 py-3 flex items-center justify-between gap-3">
                <span className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                  جاري تعديل رسالة مجدولة
                </span>
                <button
                  type="button"
                  onClick={() => {
                    resetComposer();
                    setDeliveryMode('now');
                  }}
                  className="duo-btn-cream min-h-[36px] px-3 py-1 rounded-xl font-display text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  إلغاء التعديل
                </button>
              </div>
            )}

            {/* Multi-role selector + All toggle */}
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="font-display text-sm font-extrabold text-[#4A220D] flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-[#F56900]" />
                  <span>الفئات المستهدفة (اختيار متعدد):</span>
                </label>

                <button
                  type="button"
                  onClick={handleToggleAll}
                  className={`min-h-[36px] px-3 py-1 rounded-xl font-display text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer transition-colors border-2 whitespace-nowrap shrink-0 ${
                    allSelected
                      ? 'bg-[#58CC02] border-[#46A302] text-white'
                      : 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                  }`}
                >
                  {allSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
                  <span>الكل</span>
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                {ALL_TARGET_ROLES.map((roleKey) => {
                  const active = selectedRoles.includes(roleKey);
                  return (
                    <button
                      key={roleKey}
                      type="button"
                      onClick={() => toggleRole(roleKey)}
                      aria-pressed={active}
                      className={`min-h-[48px] px-3 py-2 rounded-2xl border-2 font-display text-xs sm:text-sm font-extrabold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-all whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-[#F56900] border-[#C95200] text-white border-b-4'
                          : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#F56900] hover:text-[#4A220D]'
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${
                          active
                            ? 'bg-white border-white text-[#F56900]'
                            : 'border-[#EADBC8] bg-[#FDF6EE]'
                        }`}
                      >
                        {active && <Check className="w-3 h-3 stroke-[3]" />}
                      </span>
                      <span>{BROADCAST_ROLE_LABELS[roleKey]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target Complex Scope & Title */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor={lockedComplex ? undefined : 'broadcast-complex'}
                  className="block font-display text-xs font-extrabold text-[#4A220D] mb-1.5"
                >
                  {lockedComplex ? 'نطاق الإرسال' : 'نطاق المجمعات'}
                </label>
                {lockedComplex ? (
                  <div className="w-full min-h-[46px] px-3.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-sm font-extrabold text-[#4A220D] flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <Building2 className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span className="truncate">{lockedComplex.name}</span>
                    </span>
                    <span className="text-[11px] font-bold text-[#F56900] whitespace-nowrap shrink-0">
                      في حدود المجمع
                    </span>
                  </div>
                ) : (
                  <select
                    id="broadcast-complex"
                    value={targetComplexId}
                    onChange={(e) => setTargetComplexId(e.target.value)}
                    className="w-full min-h-[46px] px-3.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm font-bold text-[#4A220D] focus:outline-none focus:border-[#F56900] focus:bg-white"
                  >
                    <option value="all">جميع المجمعات في المنصة</option>
                    {complexes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label
                  htmlFor="broadcast-title"
                  className="block font-display text-xs font-extrabold text-[#4A220D] mb-1.5"
                >
                  عنوان الرسالة (اختياري)
                </label>
                <input
                  id="broadcast-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={140}
                  placeholder={lockedComplex ? 'رسالة من إدارة المجمع' : 'رسالة من إدارة المنصة'}
                  className="w-full min-h-[46px] px-3.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm font-bold text-[#4A220D] focus:outline-none focus:border-[#F56900] focus:bg-white"
                />
              </div>
            </div>

            {/* Full Message Textarea */}
            <div>
              <label
                htmlFor="broadcast-body"
                className="block font-display text-xs font-extrabold text-[#4A220D] mb-1.5"
              >
                نص الرسالة
              </label>
              <textarea
                id="broadcast-body"
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={3500}
                required
                placeholder="اكتب هنا الرسالة التي ستظهر للمستخدمين في الإشعار وفي نافذة القراءة الكاملة..."
                className="w-full p-4 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm sm:text-base font-medium text-[#4A220D] leading-relaxed focus:outline-none focus:border-[#F56900] focus:bg-white"
              />
            </div>

            {/* Delivery Mode & Schedule Picker */}
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setDeliveryMode('now');
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded-xl border-2 font-display text-xs sm:text-sm font-extrabold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-all whitespace-nowrap ${
                    deliveryMode === 'now'
                      ? 'bg-[#58CC02] border-[#46A302] text-white border-b-4'
                      : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#F56900] hover:text-[#4A220D]'
                  }`}
                >
                  <Send className="w-4 h-4 shrink-0" />
                  <span>إرسال فوري الآن</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setDeliveryMode('scheduled');
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded-xl border-2 font-display text-xs sm:text-sm font-extrabold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-all whitespace-nowrap ${
                    deliveryMode === 'scheduled'
                      ? 'bg-[#F56900] border-[#C95200] text-white border-b-4'
                      : 'bg-white border-[#EADBC8] text-[#7D4E35] hover:border-[#F56900] hover:text-[#4A220D]'
                  }`}
                >
                  <CalendarClock className="w-4 h-4 shrink-0" />
                  <span>جدولة لوقت محدد</span>
                </button>
              </div>

              {deliveryMode === 'scheduled' && (
                <div className="space-y-3 pt-1">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => applySchedulePreset(Date.now() + 60 * 60 * 1000)}
                      className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      بعد ساعة
                    </button>
                    <button
                      type="button"
                      onClick={() => applySchedulePreset(Date.now() + 3 * 60 * 60 * 1000)}
                      className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      بعد ٣ ساعات
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTomorrowAt(8)}
                      className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      غداً ٨:٠٠ ص
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTomorrowAt(16)}
                      className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      غداً ٤:٠٠ م
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="broadcast-schedule-date"
                        className="block font-display text-xs font-extrabold text-[#4A220D] mb-1.5"
                      >
                        تاريخ الإرسال
                      </label>
                      <input
                        id="broadcast-schedule-date"
                        type="date"
                        dir="ltr"
                        min={minDateStr}
                        value={scheduleDate}
                        onChange={(e) => setScheduleDate(e.target.value)}
                        required={deliveryMode === 'scheduled'}
                        className="w-full min-h-[46px] px-3.5 rounded-2xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D] tabular-nums focus:outline-none focus:border-[#F56900]"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="broadcast-schedule-time"
                        className="block font-display text-xs font-extrabold text-[#4A220D] mb-1.5"
                      >
                        وقت الإرسال
                      </label>
                      <input
                        id="broadcast-schedule-time"
                        type="time"
                        dir="ltr"
                        value={scheduleTime}
                        onChange={(e) => setScheduleTime(e.target.value)}
                        required={deliveryMode === 'scheduled'}
                        className="w-full min-h-[46px] px-3.5 rounded-2xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D] tabular-nums focus:outline-none focus:border-[#F56900]"
                      />
                    </div>
                  </div>

                  {scheduledTimestampMs && (
                    <p className="text-xs font-bold text-[#7D4E35] tabular-nums">
                      موعد النشر التلقائي: {formatArabicScheduleLabel(scheduledTimestampMs)}
                      {scheduledTimestampMs > nowMs
                        ? ` · ${formatRemainingDelay(scheduledTimestampMs, nowMs)}`
                        : ' · الوقت المحدد في الماضي، اختر وقتاً قادماً'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-3 text-xs sm:text-sm font-bold text-[#D95338] flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {needsRulesHelp && (
              <div className="rounded-2xl bg-[#FFA900]/10 border-2 border-[#FFA900] p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D] flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-[#D98A00]" />
                    <span>أضف قاعدة مجموعة broadcasts في قواعد الحماية ثم أعد الإرسال:</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyRulesSnippet}
                    className="duo-btn-cream min-h-[36px] px-3 py-1 rounded-xl font-display text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    {copiedRules ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[#58CC02]" />
                        <span>تم النسخ</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-[#F56900]" />
                        <span>نسخ المقطع</span>
                      </>
                    )}
                  </button>
                </div>
                <pre
                  dir="ltr"
                  className="text-[11px] bg-white border border-[#EADBC8] rounded-xl p-3 overflow-x-auto max-h-40 text-left text-[#4A220D]"
                >
                  {BROADCAST_RULES_SNIPPET}
                </pre>
              </div>
            )}

            {successMsg && (
              <div
                role="status"
                className="rounded-2xl bg-[#58CC02]/12 border-2 border-[#58CC02] px-4 py-3 text-xs sm:text-sm font-bold text-[#46A302] flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={sending}
                className="duo-btn-orange flex-1 min-h-[50px] px-6 rounded-2xl font-display font-extrabold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                {deliveryMode === 'scheduled' ? (
                  <>
                    <CalendarClock className="w-4 h-4 shrink-0" />
                    <span>
                      {sending
                        ? 'جاري الجدولة...'
                        : editingScheduledId
                          ? 'حفظ تعديل الجدولة'
                          : 'جدولة الرسالة'}
                    </span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 shrink-0" />
                    <span>{sending ? 'جاري الإرسال...' : 'أرسل'}</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="duo-btn-cream min-h-[50px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </form>

          {/* Pending Offline Outbox */}
          {outboxItems.length > 0 && (
            <div className="pt-4 border-t-2 border-[#F7EBDD] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-sm font-extrabold text-[#4A220D] flex items-center gap-2">
                  <WifiOff className="w-4 h-4 text-[#D98A00]" />
                  <span>رسائل بانتظار عودة الإنترنت ({outboxItems.length})</span>
                </h3>
                <button
                  type="button"
                  disabled={flushingOutbox}
                  onClick={() => void handleFlushOutboxNow()}
                  className="duo-btn-cream min-h-[38px] px-3 py-1 rounded-xl font-display text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-[#F56900] ${flushingOutbox ? 'animate-spin' : ''}`} />
                  <span>مزامنة الآن</span>
                </button>
              </div>

              <div className="space-y-2.5 max-h-52 overflow-y-auto">
                {outboxItems.map((item) => (
                  <div
                    key={item.id}
                    className="bg-[#FFF9E6] border-2 border-[#FFA900]/45 rounded-2xl p-3 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D] truncate">
                        {item.title}
                      </p>
                      <p className="text-xs text-[#7D4E35] line-clamp-2">{item.body}</p>
                      <p className="text-xs font-bold text-[#D98A00]">
                        ستُرسل تلقائياً فور عودة الاتصال ·{' '}
                        {item.targetRoles.map((r) => BROADCAST_ROLE_LABELS[r]).join(' · ')}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeOfflineBroadcast(item.id)}
                      title="إلغاء الرسالة المعلّقة"
                      className="min-w-[40px] min-h-[40px] rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] flex items-center justify-center shrink-0 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Scheduled Queue */}
          {scheduledMessages.length > 0 && (
            <div className="pt-4 border-t-2 border-[#F7EBDD] space-y-3">
              <h3 className="font-display text-sm font-extrabold text-[#4A220D] flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-[#F56900]" />
                <span>الرسائل المجدولة بانتظار موعدها ({scheduledMessages.length})</span>
              </h3>

              <div className="space-y-2.5 max-h-64 overflow-y-auto">
                {scheduledMessages.map((item) => {
                  const isBusy = busyActionId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="bg-[#FFF9F2] border-2 border-[#F56900]/35 rounded-2xl p-3.5 space-y-2.5"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D] truncate">
                          {item.title}
                        </p>
                        <p className="text-xs text-[#7D4E35] line-clamp-2">{item.body}</p>
                        <p className="text-xs font-bold text-[#F56900] tabular-nums flex flex-wrap items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                          <span>{formatArabicScheduleLabel(item.createdAtMs)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatRemainingDelay(item.createdAtMs, nowMs)}</span>
                        </p>
                        <p className="text-xs text-[#7D4E35]">
                          {item.targetRoles.map((r) => BROADCAST_ROLE_LABELS[r]).join(' · ')} ·{' '}
                          {item.targetComplexName}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleSendScheduledNow(item)}
                          className="duo-btn-green min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          <Send className="w-3.5 h-3.5 shrink-0" />
                          <span>إرسال الآن</span>
                        </button>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleLoadScheduledForEdit(item)}
                          className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
                          <span>تعديل الموعد</span>
                        </button>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleCancelScheduled(item.id)}
                          title="إلغاء الجدولة وحذف الرسالة"
                          className="min-h-[40px] px-3 py-1.5 rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] font-display text-xs font-bold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                        >
                          <Trash2 className="w-3.5 h-3.5 shrink-0" />
                          <span>إلغاء</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Active Sent Broadcasts */}
          <div className="pt-4 border-t-2 border-[#F7EBDD] space-y-3">
            <h3 className="font-display text-sm font-extrabold text-[#4A220D]">
              الرسائل المرسلة والنشطة حالياً ({sentActiveMessages.length})
            </h3>

            {loadingHistory ? (
              <p className="text-xs text-[#7D4E35]">جاري تحميل الرسائل المرسلة...</p>
            ) : sentActiveMessages.length === 0 ? (
              <p className="text-xs text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 text-center">
                لا توجد رسائل نشطة مرسلة بعد.
              </p>
            ) : (
              <div className="space-y-2.5 max-h-56 overflow-y-auto">
                {sentActiveMessages.map((item) => (
                  <div
                    key={item.id}
                    className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D] truncate">
                        {item.title}
                      </p>
                      <p className="text-xs text-[#7D4E35] line-clamp-2">{item.body}</p>
                      <p className="text-xs font-bold text-[#F56900] tabular-nums">
                        {item.targetRoles.map((r) => BROADCAST_ROLE_LABELS[r]).join(' · ')} ·{' '}
                        {item.targetComplexName} · {formatArabicScheduleLabel(item.createdAtMs)}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={busyActionId === item.id}
                      onClick={() => void handleDeactivate(item.id)}
                      title="إيقاف عرض هذه الرسالة"
                      className="min-w-[40px] min-h-[40px] rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-60"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalNode, document.body)
    : modalNode;
};
