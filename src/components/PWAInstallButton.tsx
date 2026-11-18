import React, { useState } from 'react';
import { Check, Copy, Download, Laptop, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'compact' | 'full';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'compact' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      setInstalling(true);
      try {
        const accepted = await install();
        if (!accepted) {
          setShowGuide(true);
        }
      } finally {
        setInstalling(false);
      }
      return;
    }
    setShowGuide(true);
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
        <span>{installing ? 'جاري التثبيت...' : 'تنزيل التطبيق'}</span>
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
                  تنزيل تطبيق براعم عمران
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
              {isIOS ? (
                <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                  <p className="font-display font-bold flex items-center gap-2">
                    <Share className="w-4 h-4 text-[#F56900] shrink-0" />
                    <span>على أجهزة iPhone و iPad (Safari):</span>
                  </p>
                  <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                    <li>اضغط على زر <strong>المشاركة</strong> أسفل متصفح Safari.</li>
                    <li>اختر <strong>إضافة إلى الصفحة الرئيسية (Add to Home Screen)</strong>.</li>
                    <li>اضغط <strong>إضافة</strong> ليظهر التطبيق على شاشتك مباشرة.</li>
                  </ol>
                </div>
              ) : (
                <>
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                    <p className="font-display font-bold flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span>على هواتف Android (Chrome):</span>
                    </p>
                    <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                      <li>افتح المنصة في متصفح <strong>Chrome</strong> مباشرة.</li>
                      <li>اضغط قائمة النقاط الثلاث أعلى المتصفح واختر <strong>تثبيت التطبيق</strong> أو <strong>الإضافة للشاشة الرئيسية</strong>.</li>
                    </ol>
                  </div>

                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 space-y-2">
                    <p className="font-display font-bold flex items-center gap-2">
                      <Laptop className="w-4 h-4 text-[#F56900] shrink-0" />
                      <span>على الكمبيوتر (Chrome / Edge):</span>
                    </p>
                    <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
                      اضغط أيقونة التثبيت في شريط العنوان أعلى المتصفح، أو انسخ الرابط وافتحه في نافذة مستقلة لتظهر نافذة التثبيت التلقائية.
                    </p>
                  </div>
                </>
              )}

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
