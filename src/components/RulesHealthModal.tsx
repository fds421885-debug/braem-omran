import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { EXTERNAL_DB_RECOMMENDED_RULES } from '../services/multiDb';
import type {
  DatabaseRulesAuditResult,
  PlatformRulesAuditReport,
} from '../services/rulesAuditService';

interface RulesHealthModalProps {
  report: PlatformRulesAuditReport;
  rechecking: boolean;
  onRecheck: () => Promise<void>;
  onClose: () => void;
}

export const RulesHealthModal: React.FC<RulesHealthModalProps> = ({
  report,
  rechecking,
  onRecheck,
  onClose,
}) => {
  const [copyStatus, setCopyStatus] = useState<
    Record<string, 'copied' | 'manual'>
  >({});
  const [expandedCodeKeys, setExpandedCodeKeys] = useState<Record<string, boolean>>({});
  const modalBoxRef = useRef<HTMLDivElement | null>(null);
  const previewTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const toggleCodePreview = (dbKey: string) => {
    setExpandedCodeKeys((prev) => ({ ...prev, [dbKey]: !prev[dbKey] }));
  };

  const getEffectiveRulesText = (item: DatabaseRulesAuditResult): string =>
    item.isPrimary ? item.recommendedRules : EXTERNAL_DB_RECOMMENDED_RULES;

  const tryReliableCopy = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback to in-modal focusable textarea below
    }

    try {
      const container = modalBoxRef.current || document.body;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.top = '16px';
      ta.style.left = '16px';
      ta.style.width = '24px';
      ta.style.height = '24px';
      ta.style.opacity = '0.01';
      ta.style.zIndex = '200';
      container.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      container.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const handleCopyText = async (key: string, text: string, dbKeyForExpand?: string) => {
    const ok = await tryReliableCopy(text);
    if (ok) {
      setCopyStatus((prev) => ({ ...prev, [key]: 'copied' }));
      window.setTimeout(() => {
        setCopyStatus((prev) => {
          const next = { ...prev };
          if (next[key] === 'copied') delete next[key];
          return next;
        });
      }, 2600);
      return;
    }

    // Clipboard blocked by Android Chrome / iFrame policy: reveal & select the visible textarea
    const targetKey = dbKeyForExpand || key;
    setExpandedCodeKeys((prev) => ({ ...prev, [targetKey]: true }));
    setCopyStatus((prev) => ({ ...prev, [key]: 'manual' }));
    window.setTimeout(() => {
      const ta = previewTextareaRefs.current[targetKey];
      if (ta) {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
      }
    }, 60);
  };

  const modalNode = (
    <div
      dir="rtl"
      className="fixed inset-0 z-[105] flex items-end sm:items-center justify-center bg-[#4A220D]/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rules-health-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !rechecking) onClose();
      }}
    >
      <div
        ref={modalBoxRef}
        className="w-full sm:max-w-3xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92dvh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div
          className={`px-5 sm:px-6 py-4 border-b-2 border-[#EADBC8] flex items-center justify-between gap-3 shrink-0 ${
            report.allHealthy
              ? 'bg-gradient-to-l from-[#E9FAD8] via-[#F4FDE9] to-white'
              : 'bg-gradient-to-l from-[#FFF2E2] via-[#FDF6EE] to-white'
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-11 h-11 rounded-2xl text-white border-b-4 flex items-center justify-center shrink-0 ${
                report.allHealthy
                  ? 'bg-[#58CC02] border-[#46A302]'
                  : 'bg-[#F56900] border-[#C95200]'
              }`}
            >
              {report.allHealthy ? (
                <ShieldCheck className="w-6 h-6" />
              ) : (
                <ShieldAlert className="w-6 h-6" />
              )}
            </div>
            <div className="min-w-0">
              <h2
                id="rules-health-title"
                className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] truncate"
              >
                {report.allHealthy
                  ? 'جميع قواعد الحماية محدّثة وتعمل بنجاح!'
                  : `تنبيه ذكي: توجد (${report.unhealthyDatabases.length}) قاعدة تحتاج تحديث Rules`}
              </h2>
              <p className="text-xs font-bold text-[#7D4E35]">
                تم فحص {report.totalDatabases} قاعدة بيانات · {report.healthyCount} سليمة ·{' '}
                {report.unhealthyDatabases.length} تحتاج لصق القواعد المحدّثة
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-white cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-5 sm:p-6 space-y-4">
          {report.allHealthy ? (
            <div className="bg-[#58CC02]/10 border-2 border-[#58CC02] rounded-2xl p-5 text-center space-y-2">
              <CheckCircle2 className="w-10 h-10 text-[#46A302] mx-auto" />
              <p className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                ممتاز! جميع قواعد Firebase Rules متوافقة ١٠٠٪ مع آخر تحديثات المنصة.
              </p>
              <p className="text-xs sm:text-sm text-[#7D4E35]">
                تم التحقق من صلاحيات القراءة والكتابة وتعدد قواعد التبويبات والصوتيات والإشعارات وخطط الكتب في كل القواعد المرتبطة.
              </p>
            </div>
          ) : (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 text-xs sm:text-sm text-[#4A220D] leading-relaxed space-y-1.5">
                <p>
                  انسخ <strong>كود Rules كاملاً</strong>، ثم افتح <strong>Rules</strong> في Firebase، وحدد الكود القديم بالكامل واحذفه تماماً قبل اللصق، ثم اضغط <strong>Publish (نشر)</strong>.
                </p>
                <p className="text-xs font-bold text-[#7D4E35]">
                  ملاحظة مهمة: في القواعد المنفصلة يمكنك أيضاً نسخ الجزء المفقود فقط وإضافته قبل آخر قوسين <span dir="ltr">{'} }'}</span> في نهاية القواعد ثم الضغط على <strong>Publish</strong>.
                </p>
              </div>

              {report.unhealthyDatabases.map((dbItem) => {
                const effectiveRules = getEffectiveRulesText(dbItem);
                const fullCopyState = copyStatus[dbItem.dbKey];
                const isCopied = fullCopyState === 'copied';
                const isManualCopy = fullCopyState === 'manual';
                const isExpanded = !!expandedCodeKeys[dbItem.dbKey] || isManualCopy;
                const missingSnippets = Array.from(
                  new Set(
                    dbItem.issues
                      .map((iss) => iss.ruleSnippet)
                      .filter((s): s is string => Boolean(s && s.trim()))
                  )
                ).join('\n');
                const snippetKey = `${dbItem.dbKey}__snippet`;
                const isSnippetCopied = copyStatus[snippetKey] === 'copied';

                return (
                  <div
                    key={dbItem.dbKey}
                    className="bg-white border-2 border-[#F56900]/40 rounded-3xl p-4 sm:p-5 space-y-3.5"
                  >
                    {/* Database Identity Row */}
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
                          <Database className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-display text-base font-extrabold text-[#4A220D] truncate">
                            {dbItem.dbLabel}
                          </h3>
                          <p className="text-xs font-bold text-[#7D4E35] break-all">
                            المشروع: <span dir="ltr">{dbItem.projectId}</span> · القاعدة:{' '}
                            <span dir="ltr">{dbItem.firestoreDatabaseId}</span>
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2 w-full sm:w-auto shrink-0">
                        <a
                          href={dbItem.consoleRulesUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold inline-flex items-center justify-center gap-1.5"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
                          <span>فتح Rules في Firebase</span>
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            void handleCopyText(dbItem.dbKey, effectiveRules, dbItem.dbKey)
                          }
                          className={`min-h-[40px] px-3.5 py-1.5 rounded-xl font-display text-xs font-extrabold inline-flex items-center justify-center gap-1.5 cursor-pointer ${
                            isCopied ? 'duo-btn-green' : 'duo-btn-orange'
                          }`}
                        >
                          {isCopied ? (
                            <>
                              <Check className="w-4 h-4 shrink-0" />
                              <span>تم نسخ الكود كاملاً</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4 shrink-0" />
                              <span>نسخ كود Rules كاملاً</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {isManualCopy && (
                      <div className="bg-[#FFA900]/15 border border-[#FFA900] rounded-2xl p-3 text-xs font-bold text-[#4A220D]">
                        تعذّر النسخ التلقائي من هذا المتصفح؛ تم فتح الكود الكامل وتحديده في المربع أدناه — اضغط مطولاً واختر <strong>نسخ</strong> ثم استبدل كل الكود في Firebase.
                      </div>
                    )}

                    {/* Specific Failing Items */}
                    <div className="bg-[#D95338]/8 border border-[#D95338]/30 rounded-2xl p-3.5 space-y-2">
                      <p className="font-display text-xs font-extrabold text-[#D95338] flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>التعديلات المطلوبة في قواعد هذه القاعدة ({dbItem.issues.length}):</span>
                      </p>
                      <ul className="space-y-1.5 text-xs text-[#4A220D]">
                        {dbItem.issues.map((iss) => (
                          <li key={iss.key} className="leading-relaxed">
                            <strong className="text-[#D95338]">• {iss.title}:</strong> {iss.detail}
                          </li>
                        ))}
                      </ul>

                      {missingSnippets && (
                        <div className="pt-2 border-t border-[#D95338]/20 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[11px] font-extrabold text-[#4A220D]">
                              الجزء المطلوب إضافته قبل آخر قوسين {'} }'} (أو انسخ الكود كاملاً):
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyText(snippetKey, missingSnippets, dbItem.dbKey)
                              }
                              className={`min-h-[34px] px-3 rounded-xl font-display text-[11px] font-extrabold inline-flex items-center gap-1 cursor-pointer ${
                                isSnippetCopied
                                  ? 'bg-[#58CC02] text-white'
                                  : 'bg-white border border-[#D95338] text-[#D95338]'
                              }`}
                            >
                              {isSnippetCopied ? (
                                <>
                                  <Check className="w-3.5 h-3.5" />
                                  <span>تم نسخ الجزء المفقود</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  <span>نسخ الجزء المفقود فقط</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre
                            dir="ltr"
                            className="bg-[#4A220D] text-[#FDF6EE] rounded-xl p-3 text-[11px] leading-relaxed overflow-x-auto text-left select-all"
                          >
                            {missingSnippets}
                          </pre>
                        </div>
                      )}
                    </div>

                    {/* Expand / Collapse Complete Rules Preview */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => toggleCodePreview(dbItem.dbKey)}
                          className="text-xs font-display font-bold text-[#7D4E35] hover:text-[#4A220D] inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="w-4 h-4" />
                              <span>إخفاء كود Rules الكامل</span>
                            </>
                          ) : (
                            <>
                              <ChevronDown className="w-4 h-4" />
                              <span>معاينة أو تحديد كود Rules الكامل يدوياً</span>
                            </>
                          )}
                        </button>

                        {isExpanded && (
                          <button
                            type="button"
                            onClick={() => {
                              const ta = previewTextareaRefs.current[dbItem.dbKey];
                              if (ta) {
                                ta.focus();
                                ta.select();
                                ta.setSelectionRange(0, ta.value.length);
                              }
                            }}
                            className="text-[11px] font-extrabold text-[#F56900] hover:underline cursor-pointer"
                          >
                            تحديد الكود بالكامل للنسخ اليدوي
                          </button>
                        )}
                      </div>

                      {isExpanded && (
                        <textarea
                          ref={(el) => {
                            previewTextareaRefs.current[dbItem.dbKey] = el;
                          }}
                          readOnly
                          dir="ltr"
                          rows={12}
                          value={effectiveRules}
                          onFocus={(e) => {
                            e.currentTarget.select();
                          }}
                          className="w-full bg-[#4A220D] text-[#FDF6EE] rounded-2xl p-4 font-mono text-[11px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#F56900] resize-y"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* Unreachable Databases Warning */}
          {report.allResults.some((r) => r.status === 'unreachable') && (
            <div className="bg-[#FFA900]/12 border border-[#FFA900]/60 rounded-2xl p-3.5 space-y-2">
              <p className="font-display text-xs font-extrabold text-[#9A5B00] flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  قواعد تعذّر التحقق منها ({report.allResults.filter((r) => r.status === 'unreachable').length}):
                </span>
              </p>
              <div className="space-y-1.5">
                {report.allResults
                  .filter((r) => r.status === 'unreachable')
                  .map((r) => (
                    <div
                      key={r.dbKey}
                      className="text-xs font-bold text-[#4A220D] bg-white border border-[#FFA900]/40 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="break-all">
                        {r.dbLabel} (<span dir="ltr">{r.projectId} / {r.firestoreDatabaseId}</span>)
                      </span>
                      <span className="text-[11px] text-[#9A5B00]">
                        {r.isPrimary
                          ? 'تحقق من تسجيل الدخول بحساب جوجل لإكمال فحص القاعدة الأساسية'
                          : 'تعذّر الاتصال بالقاعدة عبر الشبكة'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Healthy Databases Summary */}
          {report.healthyCount > 0 && !report.allHealthy && (
            <div className="bg-[#58CC02]/8 border border-[#58CC02]/30 rounded-2xl p-3.5 space-y-1.5">
              <p className="font-display text-xs font-extrabold text-[#46A302]">
                قواعد سليمة ومحدّثة ({report.healthyCount}):
              </p>
              <div className="flex flex-wrap gap-2">
                {report.allResults
                  .filter((r) => r.status === 'ok')
                  .map((r) => (
                    <span
                      key={r.dbKey}
                      className="text-xs font-bold text-[#46A302] bg-white border border-[#58CC02]/40 rounded-xl px-2.5 py-1 inline-flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>{r.dbLabel}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 sm:px-6 py-4 pb-safe border-t-2 border-[#F7EBDD] bg-[#FDF6EE]/60 flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="duo-btn-cream min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-bold text-sm cursor-pointer"
          >
            {report.allHealthy ? 'تم' : 'تذكيري لاحقاً'}
          </button>

          <button
            type="button"
            disabled={rechecking}
            onClick={() => void onRecheck()}
            className="duo-btn-green sm:flex-1 min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${rechecking ? 'animate-spin' : ''}`} />
            <span>
              {rechecking
                ? 'جاري فحص القواعد (مع انتظار انتشار التحديث من Firebase)...'
                : 'إعادة فحص القواعد الآن'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalNode, document.body)
    : modalNode;
};
