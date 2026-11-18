import { useEffect, useState } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface Window {
    __pwaInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(() =>
    typeof window !== 'undefined' ? window.__pwaInstallPrompt ?? null : null
  );
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isEmbeddedOrInApp, setIsEmbeddedOrInApp] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    let inIframe = false;
    try {
      inIframe = window.self !== window.top;
    } catch {
      inIframe = true;
    }
    const inAppWebView =
      /wv|fbav|fban|instagram|line|snapchat|whatsapp|telegram|twitter|tiktok/i.test(ua);
    setIsEmbeddedOrInApp(inIframe || inAppWebView);

    if (window.__pwaInstallPrompt) {
      setDeferredPrompt(window.__pwaInstallPrompt);
    }

    const syncFromGlobal = () => {
      if (window.__pwaInstallPrompt) {
        setDeferredPrompt(window.__pwaInstallPrompt);
      }
    };

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      const promptEvent = e as BeforeInstallPromptEvent;
      window.__pwaInstallPrompt = promptEvent;
      setDeferredPrompt(promptEvent);
    };

    const handleAppInstalled = () => {
      window.__pwaInstallPrompt = null;
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('pwa-prompt-ready', syncFromGlobal);
    window.addEventListener('appinstalled', handleAppInstalled);
    window.addEventListener('pwa-app-installed', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('pwa-prompt-ready', syncFromGlobal);
      window.removeEventListener('appinstalled', handleAppInstalled);
      window.removeEventListener('pwa-app-installed', handleAppInstalled);
    };
  }, []);

  const install = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    let promptToUse = deferredPrompt || window.__pwaInstallPrompt || null;

    // On first visit, SW may still be finishing activation for a few hundred ms
    if (!promptToUse && !isIOS && !isEmbeddedOrInApp) {
      promptToUse = await new Promise<BeforeInstallPromptEvent | null>((resolve) => {
        if (window.__pwaInstallPrompt) {
          resolve(window.__pwaInstallPrompt);
          return;
        }
        const onReady = () => {
          clearTimeout(timer);
          window.removeEventListener('pwa-prompt-ready', onReady);
          resolve(window.__pwaInstallPrompt ?? null);
        };
        const timer = setTimeout(() => {
          window.removeEventListener('pwa-prompt-ready', onReady);
          resolve(window.__pwaInstallPrompt ?? null);
        }, 1200);
        window.addEventListener('pwa-prompt-ready', onReady);
      });
    }

    if (!promptToUse) {
      return 'unavailable';
    }

    await promptToUse.prompt();
    const { outcome } = await promptToUse.userChoice;
    if (outcome === 'accepted') {
      window.__pwaInstallPrompt = null;
      setIsInstalled(true);
      setDeferredPrompt(null);
      return 'accepted';
    }
    return 'dismissed';
  };

  return {
    isInstallable: !!deferredPrompt,
    isInstalled,
    isIOS,
    isEmbeddedOrInApp,
    install,
  };
}
