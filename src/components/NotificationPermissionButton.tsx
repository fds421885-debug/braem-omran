import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellRing, CheckCircle2, Info, X } from 'lucide-react';
import {
  getNotificationPermissionState,
  requestAppNotificationPermission,
  type NotificationPermissionState,
} from '../services/notificationService';

interface NotificationPermissionButtonProps {
  variant?: 'compact' | 'banner';
}

export const NotificationPermissionButton: React.FC<NotificationPermissionButtonProps> = ({
  variant = 'compact',
}) => {
  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    getNotificationPermissionState()
  );
  const [requesting, setRequesting] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  useEffect(() => {
    const sync = () => setPermission(getNotificationPermissionState());
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  if (permission === 'unsupported') {
    return null;
  }

  const handleClick = async () => {
    const current = getNotificationPermissionState();
    setPermission(current);

    if (current === 'denied') {
      setShowHelpModal(true);
      return;
    }

    if (current === 'granted') {
      setShowHelpModal(true);
      return;
    }

    setRequesting(true);
    try {
      const next = await requestAppNotificationPermission();
      setPermission(next);
      if (next === 'denied') {
        setShowHelpModal(true);
      }
    } finally {
      setRequesting(false);
    }
  };

  const helpModal =
    showHelpModal && typeof document !== 'undefined'
      ? createPortal(
          <div
            dir="rtl"
            className="fixed inset-0 z-[105] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-sm p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowHelpModal(false);
            }}
          >
            <div className="w-full sm:max-w-md bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between gap-2 pb-3 border-b-2 border-[#F7EBDD]">
                <div className="flex items-center gap-2">
                  {permission === 'granted' ? (
                    <CheckCircle2 className="w-5 h-5 text-[#58CC02]" />
                  ) : (
                    <Info className="w-5 h-5 text-[#F56900]" />
                  )}
                  <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                    {permission === 'granted'
                      ? 'إشعارات براعم عمران مفعّلة'
                      : 'السماح بالإشعارات من إعدادات المتصفح'}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowHelpModal(false)}
                  aria-label="إغلاق"
                  className="min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {permission === 'granted' ? (
                <p className="text-sm text-[#7D4E35] leading-relaxed">
                  إشعارات الجهاز مفعّلة بنجاح؛ ستصلك تنبيهات ورسائل إدارة المنصة أعلى الهاتف حتى عندما يكون التطبيق مغلقاً أو في الخلفية، وعند الضغط عليها ستُفتح لك الرسالة مباشرة.
                </p>
              ) : (
                <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2 text-xs sm:text-sm text-[#4A220D]">
                  <p className="font-bold">تم حظر الإشعارات مسبقاً من المتصفح، ولتفعيلها:</p>
                  <ol className="list-decimal list-inside space-y-1.5 text-[#7D4E35]">
                    <li>اضغط أيقونة القفل أو الإعدادات بجانب عنوان الموقع أعلى المتصفح.</li>
                    <li>اختر <strong>الأذونات / الإشعارات (Notifications)</strong>.</li>
                    <li>غيّر الخيار إلى <strong>السماح (Allow)</strong> ثم أعد تحميل الصفحة.</li>
                  </ol>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowHelpModal(false)}
                className="duo-btn-green w-full min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer"
              >
                حسناً
              </button>
            </div>
          </div>,
          document.body
        )
      : null;

  if (variant === 'banner') {
    if (permission === 'granted') {
      return (
        <>
          <div className="bg-[#58CC02]/10 border-2 border-[#58CC02]/40 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 text-right">
            <div className="flex items-center gap-2.5 min-w-0">
              <BellRing className="w-5 h-5 text-[#46A302] shrink-0" />
              <div className="min-w-0">
                <p className="font-display text-sm font-extrabold text-[#4A220D]">
                  إشعارات الهاتف مفعّلة
                </p>
                <p className="text-xs text-[#7D4E35]">
                  ستصلك الرسائل والتنبيهات المهمة أعلى شاشة هاتفك فوراً.
                </p>
              </div>
            </div>
            <CheckCircle2 className="w-5 h-5 text-[#46A302] shrink-0" />
          </div>
          {helpModal}
        </>
      );
    }

    return (
      <>
        <div className="bg-[#F56900]/10 border-2 border-[#F56900]/40 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-right">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-[#F56900] text-white flex items-center justify-center shrink-0">
              <Bell className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="font-display text-sm sm:text-base font-extrabold text-[#4A220D]">
                تفعيل إشعارات المنصة على الهاتف
              </p>
              <p className="text-xs text-[#7D4E35]">
                لتصلك التنبيهات والرسائل أعلى هاتفك فور إرسالها حتى خارج التطبيق.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClick}
            disabled={requesting}
            className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <Bell className="w-4 h-4 shrink-0" />
            <span>{requesting ? 'جاري التفعيل...' : 'تفعيل الإشعارات'}</span>
          </button>
        </div>
        {helpModal}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={requesting}
        title={
          permission === 'granted'
            ? 'إشعارات الهاتف مفعّلة'
            : 'تفعيل الإشعارات الفورية على الهاتف'
        }
        className={`min-h-[42px] px-3 py-2 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
          permission === 'granted'
            ? 'bg-[#58CC02]/12 border-2 border-[#58CC02]/50 text-[#46A302] hover:bg-[#58CC02]/20'
            : 'duo-btn-cream'
        }`}
      >
        {permission === 'granted' ? (
          <>
            <BellRing className="w-4 h-4 text-[#46A302] shrink-0" />
            <span className="hidden sm:inline">الإشعارات مفعّلة</span>
          </>
        ) : (
          <>
            <Bell className="w-4 h-4 text-[#F56900] shrink-0" />
            <span>{requesting ? 'تفعيل...' : 'تفعيل الإشعارات'}</span>
          </>
        )}
      </button>
      {helpModal}
    </>
  );
};
