import { registerSW } from 'virtual:pwa-register';
import { saveNotificationSystemVersion } from './notificationService';

const BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
const FORCED_RELOAD_BUILD_KEY = 'braem_last_forced_reload_build_v1';

export interface AppUpdateState {
  swNeedRefresh: boolean;
  remoteBuildMismatch: string | null;
  updateRequired: boolean;
  checking: boolean;
}

let swNeedRefresh = false;
let remoteBuildMismatch: string | null = null;
let checking = false;
let initialized = false;
let swRegistration: ServiceWorkerRegistration | null = null;
let updateSWRunner: ((reloadPage?: boolean) => Promise<void>) | null = null;

const listeners = new Set<(state: AppUpdateState) => void>();

export function getAppUpdateState(): AppUpdateState {
  return {
    swNeedRefresh,
    remoteBuildMismatch,
    updateRequired: swNeedRefresh || Boolean(remoteBuildMismatch),
    checking,
  };
}

function emitUpdateState(): void {
  const snapshot = getAppUpdateState();
  listeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch {
      // Ignore listener errors
    }
  });
}

export function subscribeToAppUpdateState(cb: (state: AppUpdateState) => void): () => void {
  listeners.add(cb);
  cb(getAppUpdateState());
  return () => {
    listeners.delete(cb);
  };
}

async function checkRemoteVersionJson(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const currentBuild = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : '';
  if (!currentBuild) return;

  try {
    const res = await fetch(`${BASE_URL}version.json?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const data = (await res.json()) as { buildId?: unknown };
    const remoteBuild = typeof data.buildId === 'string' ? data.buildId.trim() : '';
    if (!remoteBuild || remoteBuild === currentBuild) {
      if (remoteBuildMismatch !== null) {
        remoteBuildMismatch = null;
        emitUpdateState();
      }
      return;
    }

    let lastAttempted = '';
    try {
      lastAttempted = window.sessionStorage.getItem(FORCED_RELOAD_BUILD_KEY) || '';
    } catch {
      // Ignore sessionStorage restrictions
    }
    if (lastAttempted === remoteBuild) {
      return;
    }

    if (remoteBuildMismatch !== remoteBuild) {
      remoteBuildMismatch = remoteBuild;
      emitUpdateState();
    }
  } catch {
    // Offline or network transient error; do not block offline usage
  }
}

export async function checkForPlatformUpdatesNow(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  checking = true;
  emitUpdateState();

  try {
    if ('serviceWorker' in navigator) {
      const reg = swRegistration || (await navigator.serviceWorker.getRegistration().catch(() => null));
      if (reg) {
        swRegistration = reg;
        if (reg.waiting && !swNeedRefresh) {
          swNeedRefresh = true;
        }
        await reg.update().catch(() => {});
        if (reg.waiting && !swNeedRefresh) {
          swNeedRefresh = true;
        }
      }
    }
    await checkRemoteVersionJson();
  } finally {
    checking = false;
    emitUpdateState();
  }
}

export async function applyPendingAppUpdate(): Promise<void> {
  if (typeof window === 'undefined') return;

  const reloadMarker = remoteBuildMismatch || 'sw_refresh';
  try {
    window.sessionStorage.setItem(FORCED_RELOAD_BUILD_KEY, reloadMarker);
  } catch {
    // Ignore storage error
  }

  saveNotificationSystemVersion();

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    } catch {
      // Non-fatal
    }
  }

  if (updateSWRunner && swNeedRefresh) {
    try {
      await Promise.race([
        updateSWRunner(true),
        new Promise<void>((resolve) => window.setTimeout(resolve, 2500)),
      ]);
    } catch {
      // Fallback reload below
    }
  } else if ('serviceWorker' in navigator) {
    try {
      const reg = swRegistration || (await navigator.serviceWorker.getRegistration().catch(() => null));
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
      }
    } catch {
      // Fallback reload below
    }
  }

  window.location.reload();
}

export function initPwaAndNotificationUpdater(): void {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;

  try {
    updateSWRunner = registerSW({
      immediate: true,
      onNeedRefresh() {
        swNeedRefresh = true;
        emitUpdateState();
      },
      onRegisteredSW(_swUrl, registration) {
        if (registration) {
          swRegistration = registration;
          if (registration.waiting) {
            swNeedRefresh = true;
            emitUpdateState();
          }
          if (typeof navigator === 'undefined' || navigator.onLine !== false) {
            void registration.update().catch(() => {});
          }
        }
      },
    });
  } catch {
    // Service Worker unavailable in restricted environments
  }

  void checkForPlatformUpdatesNow();

  const handleResumeCheck = () => {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      void checkForPlatformUpdatesNow();
    }
  };

  window.addEventListener('online', handleResumeCheck);
  window.addEventListener('focus', handleResumeCheck);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleResumeCheck();
    }
  });
}
