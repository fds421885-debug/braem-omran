import React, { useState } from 'react';
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedCodeKeys, setExpandedCodeKeys] = useState<Record<string, boolean>>({});

  const toggleCodePreview = (dbKey: string) => {
    setExpandedCodeKeys((prev) => ({ ...prev, [dbKey]: !prev[dbKey] }));
  };

  const handleCopyRules = async (item: DatabaseRulesAuditResult) => {
    try {
      await navigator.clipboard.writeText(item.recommendedRules);
      setCopiedKey(item.dbKey);
      window.setTimeout(() => setCopiedKey(null), 2600);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = item.recommendedRules;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedKey(item.dbKey);
        window.setTimeout(() => setCopiedKey(null), 2600);
      } catch {
        setCopiedKey(null);
      }
    }
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
      <div className="w-full sm:max-w-3xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
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
                تم التحقق من صلاحيات القراءة والكتابة وتعدد قواعد التبويبات والصوتيات والإشعارات في كل القواعد المرتبطة.
              </p>
            </div>
          ) : (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 text-xs sm:text-sm text-[#4A220D] leading-relaxed">
                لضمان عمل جميع مميزات المنصة دون أخطاء، انسخ <strong>كود Rules كاملاً</strong> لكل قاعدة ظاهرة أدناه والصقه في تبويب <strong>Rules</strong> بداخل Firestore في مشروعها ثم اضغط <strong>Publish</strong>، وبعد بضع ثوانٍ لاكتمال النشر في Firebase اضغط <strong>«إعادة فحص القواعد الآن»</strong>.
              </div>

              {report.unhealthyDatabases.map((dbItem) => {
                const isCopied = copiedKey === dbItem.dbKey;
                const isExpanded = !!expandedCodeKeys[dbItem.dbKey];
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
                          <p className="text-xs font-bold text-[#7D4E35]">
                            المشروع: <span dir="ltr">{dbItem.projectId}</span> · القاعدة:{' '}
                            <span dir="ltr">{dbItem.firestoreDatabaseId}</span>
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <a
                          href={dbItem.consoleRulesUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display text-xs font-bold inline-flex items-center gap-1.5"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
                          <span>فتح Rules في Firebase</span>
                        </a>
                        <button
                          type="button"
                          onClick={() => void handleCopyRules(dbItem)}
                          className={`min-h-[40px] px-3.5 py-1.5 rounded-xl font-display text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer ${
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
                    </div>

                    {/* Expand / Collapse Complete Rules Preview */}
                    <div>
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
                            <span>معاينة كود Rules الكامل قبل اللصق</span>
                          </>
                        )}
                      </button>

                      {isExpanded && (
                        <pre
                          dir="ltr"
                          className="mt-2 bg-[#4A220D] text-[#FDF6EE] rounded-2xl p-4 text-[11px] leading-relaxed overflow-x-auto max-h-64 text-left select-all"
                        >
                          {dbItem.recommendedRules}
                        </pre>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
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
        <div className="px-5 sm:px-6 py-4 border-t-2 border-[#F7EBDD] bg-[#FDF6EE]/60 flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            disabled={rechecking}
            onClick={() => void onRecheck()}
            className="duo-btn-green flex-1 min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${rechecking ? 'animate-spin' : ''}`} />
            <span>
              {rechecking ? 'جاري إعادة فحص جميع القواعد...' : 'إعادة فحص القواعد الآن'}
            </span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="duo-btn-cream min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-bold text-sm cursor-pointer"
          >
            {report.allHealthy ? 'تم' : 'تذكيري لاحقاً'}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalNode, document.body)
    : modalNode;
};
