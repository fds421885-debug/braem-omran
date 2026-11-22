import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  CURRENT_NOTIFICATION_SYSTEM_VERSION,
  NOTIFICATION_SYSTEM_UPGRADED_EVENT,
  getNotificationPermissionState,
  isNotificationSystemVersionOutdated,
  requestAppNotificationPermission,
  upgradeNotificationSystem,
  type NotificationPermissionState,
} from '../services/notificationService';
import {
  applyPendingAppUpdate,
  checkForPlatformUpdatesNow,
  getAppUpdateState,
  subscribeToAppUpdateState,
  type AppUpdateState,
} from '../services/pwaUpdateService';

const BASE_URL = import.meta.env.BASE_URL;

type GateMode = 'app_update' | 'permission_request' | 'permission_denied' | 'notif_upgrade' | null;

function isInsideEmbeddedFrame(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export const StartupNotificationGate: React.FC = () => {
  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    getNotificationPermissionState()
  );
  const [outdatedVersion, setOutdatedVersion] = useState<boolean>(() =>
    isNotificationSystemVersionOutdated()
  );
  const [updateState, setUpdateState] = useState<AppUpdateState>(() => getAppUpdateState());
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [iframeBypassed, setIframeBypassed] = useState(false);

  const inIframe = isInsideEmbeddedFrame();

  const syncLocalStates = () => {
    setPermission(getNotificationPermissionState());
    setOutdatedVersion(isNotificationSystemVersionOutdated());
  };

  useEffect(() => {
    const unsubUpdate = subscribeToAppUpdateState((next) => {
      setUpdateState(next);
    });

    const handleSync = () => {
      syncLocalStates();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncLocalStates();
      }
    };

    window.addEventListener('focus', handleSync);
    window.addEventListener('online', handleSync);
    window.addEventListener(NOTIFICATION_SYSTEM_UPGRADED_EVENT, handleSync);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unsubUpdate();
      window.removeEventListener('focus', handleSync);
      window.removeEventListener('online', handleSync);
      window.removeEventListener(NOTIFICATION_SYSTEM_UPGRADED_EVENT, handleSync);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  let gateMode: GateMode = null;
  if (updateState.updateRequired) {
    gateMode = 'app_update';
  } else if (permission === 'default' && !iframeBypassed) {
    gateMode = 'permission_request';
  } else if (permission === 'denied' && !iframeBypassed) {
    gateMode = 'permission_denied';
  } else if (permission === 'granted' && outdatedVersion) {
    gateMode = 'notif_upgrade';
  }

  if (!gateMode || typeof document === 'undefined') {
    return null;
  }

  const handleEnableNotifications = async () => {
    setBusy(true);
    setStatusError(null);
    try {
      const next = await requestAppNotificationPermission();
      syncLocalStates();
      if (next === 'denied') {
        setStatusError('تم رفض إذن الإشعارات في المتصفح؛ يرجى السماح به من إعدادات الموقع ثم الضغط على التحقق.');
      } else if (next === 'default') {
        setStatusError('يرجى اختيار "سماح" في نافذة المتصفح لتفعيل الإشعارات ومتابعة الاستخدام.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRecheckPermission = async () => {
    setBusy(true);
    setStatusError(null);
    try {
      await checkForPlatformUpdatesNow();
      const latest = getNotificationPermissionState();
      syncLocalStates();
      if (latest === 'granted') {
        await upgradeNotificationSystem();
        syncLocalStates();
      } else if (latest === 'default') {
        await handleEnableNotifications();
      } else {
        setStatusError('ما زالت الإشعارات محظورة في المتصفح. فعّلها من علامة القفل بجانب الرابط ثم أعد المحاولة.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleUpgradeSystem = async () => {
    setBusy(true);
    setStatusError(null);
    try {
      await checkForPlatformUpdatesNow();
      if (getAppUpdateState().updateRequired) {
        await applyPendingAppUpdate();
        return;
      }
      await upgradeNotificationSystem();
      syncLocalStates();
    } catch {
      setStatusError('حدث تعذّر مؤقت أثناء التحديث، حاول مجدداً.');
    } finally {
      setBusy(false);
    }
  };

  const handleApplyAppUpdate = async () => {
    setBusy(true);
    setStatusError(null);
    try {
      await applyPendingAppUpdate();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      dir="rtl"
      className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-[#4A220D]/65 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="startup-notif-gate-title"
    >
      <div className="w-full sm:max-w-md bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl">
        {/* Header with official App Logo */}
        <div className="bg-gradient-to-l from-[#FFF4E6] via-[#FDF6EE] to-white px-5 sm:px-6 py-5 border-b-2 border-[#EADBC8] flex items-center gap-3.5">
          <img
            src={`${BASE_URL}icon.svg`}
            alt="براعم عمران"
            referrerPolicy="no-referrer"
            className="w-14 h-14 rounded-2xl border border-[#EADBC8] shadow-sm shrink-0 select-none"
          />
          <div className="min-w-0 space-y-1">
            <h2
              id="startup-notif-gate-title"
              className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] leading-snug"
            >
              {gateMode === 'app_update'
                ? 'تحديث نظام الإشعارات والمنصة'
                : gateMode === 'notif_upgrade'
                  ? 'ترقية نظام الإشعارات مطلوب'
                  : gateMode === 'permission_denied'
                    ? 'يجب السماح بالإشعارات للمتابعة'
                    : 'تفعيل الإشعارات مطلوب'}
            </h2>
            <p className="text-xs font-bold text-[#F56900]">
              {gateMode === 'app_update' || gateMode === 'notif_upgrade'
                ? `الإصدار الحديث (${CURRENT_NOTIFICATION_SYSTEM_VERSION})`
                : 'منصة براعم عمران'}
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 sm:p-6 space-y-4">
          {gateMode === 'app_update' && (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2 text-sm text-[#4A220D] leading-relaxed">
                <p className="font-bold">
                  أنت تستخدم نسخة قديمة من المنصة ونظام الإشعارات.
                </p>
                <p className="text-xs sm:text-sm text-[#7D4E35]">
                  يجب التحديث الآن لتفعيل إشعارات الجدولة، وإشعارات المجمع، والتسليم التلقائي فور عودة الإنترنت.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleApplyAppUpdate()}
                className="duo-btn-orange w-full min-h-[52px] px-5 py-3 rounded-2xl font-display font-extrabold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-5 h-5 shrink-0 ${busy ? 'animate-spin' : ''}`} />
                <span>{busy ? 'جاري التحديث وإعادة التحميل...' : 'تحديث الآن'}</span>
              </button>
            </>
          )}

          {gateMode === 'notif_upgrade' && (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2 text-sm text-[#4A220D] leading-relaxed">
                <p className="font-bold">
                  الإشعارات مفعّلة على نسخة قديمة وتحتاج إلى تحديث.
                </p>
                <p className="text-xs sm:text-sm text-[#7D4E35]">
                  اضغط على الزر أدناه لترقية نظام الإشعارات على جهازك واستقبال الرسائل المجدولة ورسائل المجمعات حتى بعد انقطاع الإنترنت.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleUpgradeSystem()}
                className="duo-btn-green w-full min-h-[52px] px-5 py-3 rounded-2xl font-display font-extrabold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-5 h-5 shrink-0 ${busy ? 'animate-spin' : ''}`} />
                <span>{busy ? 'جاري التحديث...' : 'تحديث نظام الإشعارات الآن'}</span>
              </button>
            </>
          )}

          {gateMode === 'permission_request' && (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2.5 text-sm text-[#4A220D] leading-relaxed">
                <p className="font-bold">
                  يلزم تفعيل الإشعارات للدخول واستخدام منصة براعم عمران.
                </p>
                <ul className="space-y-1.5 text-xs sm:text-sm text-[#7D4E35]">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-[#58CC02] shrink-0 mt-0.5" />
                    <span>استلام رسائل المجمع والمنصة الفورية والمجدولة أعلى شاشة الهاتف.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-[#58CC02] shrink-0 mt-0.5" />
                    <span>وصول التنبيهات تلقائياً فور عودة الإنترنت بعد انقطاعه.</span>
                  </li>
                </ul>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleEnableNotifications()}
                className="duo-btn-orange w-full min-h-[52px] px-5 py-3 rounded-2xl font-display font-extrabold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Bell className="w-5 h-5 shrink-0" />
                <span>{busy ? 'جاري التفعيل...' : 'تفعيل الإشعارات الآن'}</span>
              </button>
            </>
          )}

          {gateMode === 'permission_denied' && (
            <>
              <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2 text-xs sm:text-sm text-[#4A220D]">
                <p className="font-bold flex items-center gap-1.5 text-[#D95338]">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>تم حظر الإشعارات مسبقاً في المتصفح:</span>
                </p>
                <ol className="list-decimal list-inside space-y-1.5 text-[#7D4E35]">
                  <li>اضغط أيقونة القفل أو الإعدادات بجانب عنوان الموقع أعلى المتصفح.</li>
                  <li>افتح <strong>الأذونات / الإشعارات (Notifications)</strong>.</li>
                  <li>اختر <strong>السماح (Allow)</strong> ثم اضغط الزر أدناه للتحقق.</li>
                </ol>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRecheckPermission()}
                className="duo-btn-green w-full min-h-[52px] px-5 py-3 rounded-2xl font-display font-extrabold text-sm sm:text-base inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 shrink-0 ${busy ? 'animate-spin' : ''}`} />
                <span>{busy ? 'جاري التحقق...' : 'تم السماح — تحقق الآن'}</span>
              </button>

              {inIframe && (
                <button
                  type="button"
                  onClick={() => setIframeBypassed(true)}
                  className="duo-btn-cream w-full min-h-[42px] px-4 py-2 rounded-xl font-display font-bold text-xs text-[#7D4E35] cursor-pointer"
                >
                  المتابعة داخل نافذة المعاينة فقط
                </button>
              )}
            </>
          )}

          {statusError && (
            <p
              role="alert"
              className="rounded-xl bg-[#D95338]/10 border border-[#D95338]/30 px-3.5 py-2.5 text-xs font-bold text-[#D95338]"
            >
              {statusError}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
