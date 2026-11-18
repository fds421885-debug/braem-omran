import React, { useState } from 'react';
import { Check, Copy, Download, Laptop, MoreVertical, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'compact' | 'full';
}

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

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={installing}
        className={
          variant === 'full'
            ? 'duo-btn-cream w-full min-h-[48px] px-5 py-3 rounded-2xl font-display font-bold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap'
            : 'duo-btn-cream min-h-[44px] px-3 sm:px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap shrink-0'
        }
      >
        <Download className="w-4 h-4 text-[#F56900] shrink-0" />
        <span>{installing ? 'جاري التحضير للتثبيت...' : 'تنزيل التطبيق'}</span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
        >
          <div className="w-full sm:max-w-md bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 text-right shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-[#FDF6EE] border border-[#EADBC8] flex items-center justify-center text-[#F56900] shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <h3 id="pwa-install-title" className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                  تثبيت تطبيق براعم عمران
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="إغلاق"
                className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-sm text-[#4A220D]">
              {isEmbeddedOrInApp ? (
                <>
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                    <p className="font-display font-bold text-[#4A220D]">
                      أنت تفتح المنصة حالياً داخل نافذة مضمّنة أو متصفح داخلي لتطبيق آخر:
                    </p>
                    <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                      يمنع النظام نافذة التثبيت التلقائية هنا؛ انسخ الرابط وافتحه مباشرة في متصفح <strong>Chrome</strong> أو <strong>Safari</strong> ليظهر زر التثبيت الفوري.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="w-full min-h-[46px] px-4 py-2.5 rounded-2xl bg-white border-2 border-[#EADBC8] text-[#4A220D] font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 hover:border-[#F56900] cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4 text-[#58CC02]" />
                        <span>تم نسخ رابط التطبيق بنجاح</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4 text-[#F56900]" />
                        <span>نسخ رابط التطبيق لفتحه في المتصفح</span>
                      </>
                    )}
                  </button>
                </>
              ) : isIOS ? (
                <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                  <p className="font-display font-bold flex items-center gap-2">
                    <Share className="w-4 h-4 text-[#F56900] shrink-0" />
                    <span>على أجهزة iPhone و iPad (Safari):</span>
                  </p>
                  <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                    <li>اضغط على زر <strong>المشاركة (Share)</strong> في شريط متصفح Safari بالأسفل.</li>
                    <li>مرّر واختر <strong>إضافة إلى الصفحة الرئيسية (Add to Home Screen)</strong>.</li>
                    <li>اضغط <strong>إضافة</strong> ليتم تثبيت التطبيق على جهازك فوراً.</li>
                  </ol>
                </div>
              ) : (
                <>
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                    <p className="font-display font-bold flex items-center gap-2">
                      <MoreVertical className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span>التثبيت مباشرة من متصفحك الحالي (Android / Chrome):</span>
                    </p>
                    <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                      <li>اضغط قائمة النقاط الثلاث <strong>(⋮)</strong> في أعلى متصفحك.</li>
                      <li>اختر <strong>تثبيت التطبيق (Install app)</strong> أو <strong>الإضافة إلى الشاشة الرئيسية</strong>.</li>
                      <li>إذا لم يظهر الخيار بعد أو كان التطبيق مثبتاً مسبقاً، حدّث الصفحة مرة واحدة ثم اضغط القائمة.</li>
                    </ol>
                  </div>

                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                    <p className="font-display font-bold flex items-center gap-2">
                      <Laptop className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span>على الكمبيوتر (Chrome / Edge):</span>
                    </p>
                    <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                      اضغط على أيقونة التثبيت الموجودة يمين أو يسار شريط العنوان بالأعلى، أو من قائمة المتصفح اختر <strong>تثبيت براعم عمران</strong>.
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
      )}
    </>
  );
};
