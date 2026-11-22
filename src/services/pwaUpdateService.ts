import { registerSW } from 'virtual:pwa-register';
import { saveNotificationSystemVersion } from './notificationService';

const BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
const IS_DEV = Boolean(typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV);
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

function getCurrentEmbeddedBuildId(): string {
  try {
    const fromEnv =
      typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_APP_BUILD_ID;
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
      return fromEnv.trim();
    }
  } catch {
    // Ignore
  }
  return '';
}

function stripCacheBustQueryParam(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('_v')) {
      url.searchParams.delete('_v');
      window.history.replaceState(null, '', url.toString());
    }
  } catch {
    // Ignore URL/history restrictions
  }
}

async function cleanupLegacyDevServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      const urls = [reg.active?.scriptURL, reg.waiting?.scriptURL, reg.installing?.scriptURL].filter(
        Boolean
      ) as string[];
      if (urls.some((u) => u.includes('dev-sw.js'))) {
        await reg.unregister().catch(() => {});
      }
    }
    const existing = await navigator.serviceWorker.getRegistration();
    if (!existing) {
      swRegistration = await navigator.serviceWorker
        .register(`${BASE_URL}sw-notifications.js`, { scope: BASE_URL })
        .catch(() => null);
    } else {
      swRegistration = existing;
    }
  } catch {
    // Non-fatal in dev
  }
}

async function waitForControllerChange(timeoutMs = 1500): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(changed);
    };
    const onChange = () => finish(true);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    window.setTimeout(() => finish(false), timeoutMs);
  });
}

async function checkRemoteVersionJson(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const currentBuild = getCurrentEmbeddedBuildId();
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
    if (!IS_DEV && 'serviceWorker' in navigator) {
      const reg = swRegistration || (await navigator.serviceWorker.getRegistration().catch(() => null));
      if (reg) {
        swRegistration = reg;
        await reg.update().catch(() => {});
        if (reg.waiting) {
          // Try immediate activation; only prompt if it stays waiting
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          await waitForControllerChange(600);
          if (reg.waiting && !swNeedRefresh) {
            swNeedRefresh = true;
          } else if (!reg.waiting && swNeedRefresh) {
            swNeedRefresh = false;
          }
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
  swNeedRefresh = false;
  remoteBuildMismatch = null;
  emitUpdateState();

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    } catch {
      // Non-fatal
    }
  }

  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        if (reg.waiting) {
          const controllerChanged = waitForControllerChange(1200);
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          await controllerChanged;
          if (reg.waiting) {
            // Force-clear stubborn waiting Service Workers so reload never loops
            await reg.unregister().catch(() => {});
          }
        } else if (IS_DEV && reg.active?.scriptURL.includes('dev-sw.js')) {
          await reg.unregister().catch(() => {});
        }
      }
    } catch {
      // Non-fatal
    }
  }

  if (updateSWRunner && !IS_DEV) {
    try {
      await Promise.race([
        updateSWRunner(false),
        new Promise<void>((resolve) => window.setTimeout(resolve, 600)),
      ]);
    } catch {
      // Non-fatal
    }
  }

  try {
    const rootUrl = new URL(BASE_URL, window.location.origin).toString();
    await Promise.race([
      fetch(rootUrl, { cache: 'reload' }).catch(() => {}),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1200)),
    ]);
  } catch {
    // Non-fatal
  }

  try {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('_v', String(Date.now()));
    window.location.replace(nextUrl.toString());
  } catch {
    window.location.reload();
  }
}

export function initPwaAndNotificationUpdater(): void {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;

  stripCacheBustQueryParam();

  if (IS_DEV) {
    void cleanupLegacyDevServiceWorker();
  } else {
    try {
      updateSWRunner = registerSW({
        immediate: true,
        onNeedRefresh() {
          if (swRegistration?.waiting) {
            swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        },
        onRegisteredSW(_swUrl, registration) {
          if (registration) {
            swRegistration = registration;
            if (registration.waiting) {
              registration.waiting.postMessage({ type: 'SKIP_WAITING' });
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
