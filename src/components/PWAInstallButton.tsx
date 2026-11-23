import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Laptop,
  MoreVertical,
  Share,
  X,
} from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'compact' | 'full';
}

const BASE_URL = import.meta.env.BASE_URL;

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'compact' }) => {
  const { isInstalled, isIOS, isEmbeddedOrInApp, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    setInstalling(true);
    try {
      const outcome = await install();
      if (outcome === 'unavailable') {
        setShowGuide(true);
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const modalNode = showGuide ? (
    <div
      dir="rtl"
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwa-install-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setShowGuide(false);
      }}
    >
      <div className="w-full sm:max-w-md bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 text-right shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4 pb-3 border-b-2 border-[#F7EBDD]">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={`${BASE_URL}icon.svg`}
              alt="شعار براعم عمران"
              className="w-11 h-11 rounded-2xl border border-[#EADBC8] shrink-0"
            />
            <div className="min-w-0">
              <h3
                id="pwa-install-title"
                className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] truncate"
              >
                تثبيت تطبيق براعم عمران
              </h3>
              <p className="text-xs font-medium text-[#7D4E35]">
                يعمل كتطبيق مستقل على هاتفك وحاسوبك
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowGuide(false)}
            aria-label="إغلاق"
            className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-[#FDF6EE] shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3 text-sm text-[#4A220D]">
          {isEmbeddedOrInApp ? (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2">
                <p className="font-display font-bold text-[#4A220D]">
                  أنت تتصفح الآن من داخل إطار معاينة أو متصفح داخلي لتطبيق آخر:
                </p>
                <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                  المعاينات المضمّنة لا تسمح بتثبيت التطبيقات مباشرة؛ افتح المنصة في تبويب مستقل بمتصفح <strong>Chrome</strong> أو <strong>Safari</strong> وسيتم التثبيت فوراً.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="duo-btn-green min-h-[46px] px-4 py-2.5 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2"
                >
                  <ExternalLink className="w-4 h-4 shrink-0" />
                  <span>فتح في المتصفح</span>
                </a>

                <button
                  type="button"
                  onClick={handleCopyUrl}
                  className="duo-btn-cream min-h-[46px] px-4 py-2.5 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-[#58CC02] shrink-0" />
                      <span>تم نسخ الرابط</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span>نسخ الرابط</span>
                    </>
                  )}
                </button>
              </div>
            </>
          ) : isIOS ? (
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2">
              <p className="font-display font-bold flex items-center gap-2">
                <Share className="w-4 h-4 text-[#F56900] shrink-0" />
                <span>التثبيت على iPhone و iPad (Safari):</span>
              </p>
              <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                <li>اضغط على زر <strong>المشاركة (Share)</strong> أسفل شاشة Safari.</li>
                <li>اختر <strong>إضافة إلى الصفحة الرئيسية (Add to Home Screen)</strong>.</li>
                <li>اضغط <strong>إضافة</strong> ليظهر تطبيق براعم عمران على شاشتك.</li>
              </ol>
            </div>
          ) : (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2">
                <p className="font-display font-bold flex items-center gap-2">
                  <MoreVertical className="w-4 h-4 text-[#F56900] shrink-0" />
                  <span>على الجوال (Chrome / Android):</span>
                </p>
                <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                  <li>اضغط قائمة النقاط الثلاث <strong>(⋮)</strong> أعلى المتصفح.</li>
                  <li>اختر <strong>تثبيت التطبيق</strong> أو <strong>الإضافة إلى الشاشة الرئيسية</strong>.</li>
                </ol>
              </div>

              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2">
                <p className="font-display font-bold flex items-center gap-2">
                  <Laptop className="w-4 h-4 text-[#F56900] shrink-0" />
                  <span>على الكمبيوتر (Chrome / Edge):</span>
                </p>
                <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                  اضغط أيقونة التثبيت في شريط العنوان بالأعلى، أو اختر من قائمة المتصفح <strong>تثبيت براعم عمران</strong>.
                </p>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowGuide(false)}
          className="duo-btn-orange mt-5 w-full min-h-[48px] rounded-2xl font-display font-bold text-base cursor-pointer"
        >
          حسناً
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={installing}
        aria-label={installing ? 'جاري التحضير للتثبيت' : 'تنزيل التطبيق'}
        title="تنزيل التطبيق"
        className={
          variant === 'full'
            ? 'duo-btn-cream w-full min-h-[48px] px-5 py-3 rounded-2xl font-display font-bold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap'
            : 'duo-btn-cream min-h-[40px] min-w-[40px] sm:min-h-[42px] px-2.5 md:px-3.5 py-2 rounded-xl sm:rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0'
        }
      >
        <Download className="w-4 h-4 text-[#F56900] shrink-0" />
        <span className={variant === 'full' ? '' : 'hidden md:inline'}>
          {installing ? 'جاري التحضير للتثبيت...' : 'تنزيل التطبيق'}
        </span>
      </button>

      {typeof document !== 'undefined' && modalNode
        ? createPortal(modalNode, document.body)
        : null}
    </>
  );
};
