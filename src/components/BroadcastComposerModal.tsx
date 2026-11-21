import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Megaphone,
  Send,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  BroadcastRulesPermissionError,
  deactivateBroadcastMessage,
  listRecentBroadcasts,
  sendBroadcastMessage,
} from '../services/notificationService';
import type { DiscoveredComplex } from '../services/platformService';
import {
  BROADCAST_ROLE_LABELS,
  type BroadcastMessageRecord,
  type BroadcastTargetRole,
} from '../types/platform';

interface BroadcastComposerModalProps {
  senderName: string;
  createdBy: string;
  complexes: DiscoveredComplex[];
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
        isPlatformAdmin() || (resource != null && resource.data.active == true)
      );
      allow list: if isPlatformAdmin() || resource.data.active == true;
      allow create: if isPlatformAdmin()
        && isValidId(broadcastId)
        && isValidBroadcast(incoming(), broadcastId)
        && incoming().createdBy == request.auth.uid
        && incoming().createdAt == request.time
        && incoming().updatedAt == request.time;
      allow update: if isPlatformAdmin()
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
      allow delete: if isPlatformAdmin() && isValidId(broadcastId);
    }`;

export const BroadcastComposerModal: React.FC<BroadcastComposerModalProps> = ({
  senderName,
  createdBy,
  complexes,
  onClose,
}) => {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<BroadcastTargetRole[]>([
    'supervisor',
    'teacher',
    'student',
  ]);
  const [targetComplexId, setTargetComplexId] = useState('all');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRulesHelp, setNeedsRulesHelp] = useState(false);
  const [copiedRules, setCopiedRules] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [history, setHistory] = useState<BroadcastMessageRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const items = await listRecentBroadcasts();
      setHistory(items.filter((m) => m.active).slice(0, 10));
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

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

  const handleCopyRulesSnippet = async () => {
    try {
      await navigator.clipboard.writeText(BROADCAST_RULES_SNIPPET);
      setCopiedRules(true);
      window.setTimeout(() => setCopiedRules(false), 2500);
    } catch {
      setCopiedRules(false);
    }
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

    const pickedComplex = complexes.find((c) => c.id === targetComplexId);
    const targetComplexName =
      targetComplexId === 'all' ? 'جميع المجمعات' : pickedComplex?.name || 'المجمع المحدد';

    setSending(true);
    try {
      await sendBroadcastMessage({
        title: title.trim() || 'رسالة من إدارة المنصة',
        body: body.trim(),
        targetRoles: selectedRoles,
        targetComplexId,
        targetComplexName,
        senderName,
        createdBy,
      });

      setBody('');
      setTitle('');
      setSuccessMsg(
        'تم إرسال الرسالة بنجاح! ستظهر الآن فوراً داخل التطبيق وفوق شاشة الهاتف لدى جميع المستهدفين.'
      );
      await loadHistory();
    } catch (err: unknown) {
      if (err instanceof BroadcastRulesPermissionError) {
        setNeedsRulesHelp(true);
      }
      setError(
        err instanceof Error ? err.message : 'تعذّر إرسال الرسالة، حاول مرة أخرى.'
      );
    } finally {
      setSending(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await deactivateBroadcastMessage(id);
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch {
      setError('تعذّر إيقاف الرسالة.');
    }
  };

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
                إرسال رسالة وإشعار فوري
              </h2>
              <p className="text-xs font-bold text-[#7D4E35]">
                تصل فوراً بدون تحديث للصفحة وكإشعار أعلى الهاتف عند التفعيل
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
          <form onSubmit={handleSend} className="space-y-4">
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
                  className={`min-h-[36px] px-3 py-1 rounded-xl font-display text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer transition-colors border-2 ${
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
                      className={`min-h-[48px] px-3 py-2 rounded-2xl border-2 font-display text-xs sm:text-sm font-extrabold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
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

            {/* Target Complex Scope */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="broadcast-complex"
                  className="block font-display text-xs font-extrabold text-[#4A220D] mb-1.5"
                >
                  نطاق المجمعات
                </label>
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
                  placeholder="رسالة من إدارة المنصة"
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
                <Send className="w-4 h-4 shrink-0" />
                <span>{sending ? 'جاري الإرسال...' : 'أرسل'}</span>
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

          {/* Active Sent Broadcasts */}
          <div className="pt-4 border-t-2 border-[#F7EBDD] space-y-3">
            <h3 className="font-display text-sm font-extrabold text-[#4A220D]">
              الرسائل النشطة حالياً ({history.length})
            </h3>

            {loadingHistory ? (
              <p className="text-xs text-[#7D4E35]">جاري تحميل الرسائل المرسلة...</p>
            ) : history.length === 0 ? (
              <p className="text-xs text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 text-center">
                لا توجد رسائل نشطة مرسلة بعد.
              </p>
            ) : (
              <div className="space-y-2.5 max-h-56 overflow-y-auto">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D] truncate">
                        {item.title}
                      </p>
                      <p className="text-xs text-[#7D4E35] line-clamp-2">{item.body}</p>
                      <p className="text-[11px] font-bold text-[#F56900]">
                        {item.targetRoles.map((r) => BROADCAST_ROLE_LABELS[r]).join(' · ')} ·{' '}
                        {item.targetComplexName}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleDeactivate(item.id)}
                      title="إيقاف عرض هذه الرسالة"
                      className="min-w-[38px] min-h-[38px] rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-[#D95338] flex items-center justify-center shrink-0 cursor-pointer"
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
