/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthScreen } from './components/AuthScreen';
import { BroadcastNotificationsHost } from './components/BroadcastNotificationsHost';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ModernLoader } from './components/ModernLoader';
import { OfflineIndicator } from './components/OfflineIndicator';
import { RoleWelcomeView } from './components/RoleWelcomeView';
import { StartupNotificationGate } from './components/StartupNotificationGate';
import { SupervisorDashboard } from './components/SupervisorDashboard';
import { TeacherSessionHost } from './components/TeacherSessionHost';
import { auth as primaryAuth, db as primaryDb } from './firebase';
import { getAuthForConfig } from './services/multiDb';
import {
  ensureBroadcastOfflineSyncListeners,
  flushPendingBroadcastOutbox,
} from './services/notificationService';
import {
  findExistingAccountForInvite,
  findExistingAccountForUser,
  getAllKnownDatabases,
  resolveInviteLink,
  resolveQuickLinkSession,
  type ResolvedDbTarget,
} from './services/platformService';
import type {
  ActiveSession,
  ExternalFirebaseConfig,
  InviteLinkRecord,
} from './types/platform';

export interface InviteState {
  token: string;
  link: InviteLinkRecord | null;
  db: Firestore;
  dbLabel: string;
  targetConfig: ExternalFirebaseConfig | null;
  complexName: string;
  mosqueNames: string[];
  halaqaNames: string[];
  status: 'valid' | 'not_found' | 'closed' | 'not_started' | 'expired';
}

function AppContent() {
  const [initializing, setInitializing] = useState(true);
  const [loadingLabel, setLoadingLabel] = useState('جاري تحميل منصة براعم عمران...');
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const [hasQuickSession, setHasQuickSession] = useState(false);
  const [inviteTokenParam, setInviteTokenParam] = useState<string | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [inviteState, setInviteState] = useState<InviteState | null>(null);
  const [quickLinkError, setQuickLinkError] = useState<string | null>(null);

  const refreshInviteResolution = async (
    inviteToken: string,
    cpxParam: string | null,
    msqParam: string | null
  ): Promise<InviteState> => {
    try {
      const resolved = await resolveInviteLink(inviteToken, cpxParam, msqParam);
      const nextState: InviteState = {
        token: inviteToken,
        link: resolved.link,
        db: resolved.db || primaryDb,
        dbLabel: resolved.dbLabel,
        targetConfig: resolved.targetConfig,
        complexName: resolved.complexName,
        mosqueNames: resolved.mosqueNames,
        halaqaNames: resolved.halaqaNames,
        status: resolved.status,
      };
      setInviteState(nextState);
      return nextState;
    } catch {
      const fallbackState: InviteState = {
        token: inviteToken,
        link: null,
        db: primaryDb,
        dbLabel: 'القاعدة الأساسية',
        targetConfig: null,
        complexName: '',
        mosqueNames: [],
        halaqaNames: [],
        status: 'not_found',
      };
      setInviteState(fallbackState);
      return fallbackState;
    }
  };

  useEffect(() => {
    if (activeSession) {
      void flushPendingBroadcastOutbox();
    }
  }, [activeSession]);

  useEffect(() => {
    ensureBroadcastOfflineSyncListeners();
    void flushPendingBroadcastOutbox();

    const params = new URLSearchParams(window.location.search);
    const quickToken = params.get('quick')?.trim() || null;
    const inviteToken = params.get('invite')?.trim() || null;
    const cpxParam = params.get('cpx')?.trim() || null;
    const msqParam = params.get('msq')?.trim() || null;
    setInviteTokenParam(inviteToken);

    const bootstrap = async () => {
      // 1. Direct Quick Login Link flow (?quick=...)
      if (quickToken) {
        setLoadingLabel('جاري فتح رابط الدخول السريع...');
        try {
          const quickSession = await resolveQuickLinkSession(quickToken, cpxParam, msqParam);
          if (quickSession) {
            setActiveSession(quickSession);
            setHasQuickSession(true);
            setInitializing(false);
            setBootstrapDone(true);
            return;
          }
          setQuickLinkError('رابط الدخول السريع غير صالح أو تم إيقافه.');
        } catch {
          setQuickLinkError('تعذّر فتح رابط الدخول السريع.');
        }
      }

      // 2. Invite Registration Link resolution (?invite=...)
      if (inviteToken) {
        setLoadingLabel('جاري التحقق من رابط التسجيل...');
        await refreshInviteResolution(inviteToken, cpxParam, msqParam);
      }

      setBootstrapDone(true);
    };

    bootstrap();
  }, []);

  const inviteConfigKey = inviteState?.targetConfig
    ? `${inviteState.targetConfig.projectId}__${inviteState.targetConfig.appId}__${
        inviteState.targetConfig.firestoreDatabaseId || '(default)'
      }`
    : 'primary';
  const inviteStatusKey = inviteState?.status || 'none';

  useEffect(() => {
    if (!bootstrapDone || hasQuickSession) return;

    let cancelled = false;
    let resolutionSeq = 0;
    const unsubscribers: Array<() => void> = [];

    // Case A: Invite Link flow -> bind Auth strictly to the invite target's Firebase Auth
    if (inviteTokenParam) {
      if (!inviteState || inviteState.status !== 'valid') {
        setFirebaseUser(null);
        setActiveSession(null);
        setInitializing(false);
        return;
      }

      const targetAuth = getAuthForConfig(inviteState.targetConfig);
      const unsub = onAuthStateChanged(targetAuth, async (user) => {
        const seq = ++resolutionSeq;
        if (cancelled) return;
        setFirebaseUser(user);
        if (!user) {
          setActiveSession(null);
          setInitializing(false);
          return;
        }

        setLoadingLabel('جاري التحقق من حسابك في قاعدة المجمع...');
        setInitializing(true);
        try {
          const found = await findExistingAccountForInvite(
            user,
            inviteState.db,
            inviteState.dbLabel,
            inviteState.targetConfig
          );
          if (!cancelled && seq === resolutionSeq) {
            setActiveSession(found);
          }
        } finally {
          if (!cancelled && seq === resolutionSeq) {
            setInitializing(false);
          }
        }
      });

      return () => {
        cancelled = true;
        unsub();
      };
    }

    // Case B: Normal launch -> listen to Primary Auth + all connected External DB Auths
    const setupMultiAuthListeners = async () => {
      const targets = await getAllKnownDatabases();
      if (cancelled) return;

      type AuthBucket = {
        user: User | null;
        targets: ResolvedDbTarget[];
        ready: boolean;
      };

      const buckets = new Map<string, AuthBucket>();
      buckets.set('primary', { user: null, targets: [], ready: false });

      const externalTargetsByAuthKey = new Map<string, ResolvedDbTarget[]>();
      for (const t of targets) {
        if (t.isPrimary || !t.config) continue;
        const authKey = `${t.config.projectId}__${t.config.appId}`;
        const existing = externalTargetsByAuthKey.get(authKey) || [];
        existing.push(t);
        externalTargetsByAuthKey.set(authKey, existing);
        buckets.set(authKey, { user: null, targets: existing, ready: false });
      }

      const evaluateAuthStates = async () => {
        const allReady = Array.from(buckets.values()).every((b) => b.ready);
        if (!allReady) return;

        const seq = ++resolutionSeq;
        const primaryBucket = buckets.get('primary');
        const primaryUser = primaryBucket?.user || null;

        if (primaryUser) {
          setLoadingLabel('جاري البحث عن حسابك في القواعد المرتبطة...');
          setInitializing(true);
          try {
            const found = await findExistingAccountForUser(primaryUser, null);
            if (cancelled || seq !== resolutionSeq) return;
            if (found) {
              setFirebaseUser(primaryUser);
              setActiveSession(found);
              setInitializing(false);
              return;
            }
          } catch {
            // Fall through to check external buckets or prompt Step 2
          }
        }

        // Check external Auth instances (e.g. student signed in directly on complex's Firebase project)
        for (const [key, bucket] of buckets.entries()) {
          if (key === 'primary' || !bucket.user || bucket.targets.length === 0) continue;
          for (const target of bucket.targets) {
            setLoadingLabel('جاري تحميل حسابك من قاعدة المجمع...');
            setInitializing(true);
            try {
              const found = await findExistingAccountForInvite(
                bucket.user,
                target.db,
                target.label,
                target.config
              );
              if (cancelled || seq !== resolutionSeq) return;
              if (found) {
                setFirebaseUser(bucket.user);
                setActiveSession(found);
                setInitializing(false);
                return;
              }
            } catch {
              // Continue checking remaining targets
            }
          }
        }

        if (cancelled || seq !== resolutionSeq) return;
        setFirebaseUser(primaryUser);
        setActiveSession(null);
        setInitializing(false);
      };

      unsubscribers.push(
        onAuthStateChanged(primaryAuth, (user) => {
          const bucket = buckets.get('primary');
          if (bucket) {
            bucket.user = user;
            bucket.ready = true;
          }
          void evaluateAuthStates();
        })
      );

      for (const [authKey, authTargets] of externalTargetsByAuthKey.entries()) {
        const extAuth = getAuthForConfig(authTargets[0]?.config);
        unsubscribers.push(
          onAuthStateChanged(extAuth, (user) => {
            const bucket = buckets.get(authKey);
            if (bucket) {
              bucket.user = user;
              bucket.ready = true;
            }
            void evaluateAuthStates();
          })
        );
      }
    };

    void setupMultiAuthListeners();

    return () => {
      cancelled = true;
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, [bootstrapDone, hasQuickSession, inviteTokenParam, inviteConfigKey, inviteStatusKey]);

  if (initializing) {
    return <ModernLoader fullScreen label={loadingLabel} />;
  }

  if (quickLinkError && !activeSession) {
    return (
      <div className="min-h-screen bg-[#FDF6EE] flex items-center justify-center p-4" dir="rtl">
        <div className="max-w-md w-full bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4">
          <h1 className="font-display text-xl font-extrabold text-[#4A220D]">
            رابط الدخول غير صالح
          </h1>
          <p className="text-sm text-[#7D4E35]">{quickLinkError}</p>
          <button
            type="button"
            onClick={() => {
              const url = new URL(window.location.href);
              url.search = '';
              window.location.href = url.toString();
            }}
            className="duo-btn-orange w-full min-h-[48px] rounded-2xl font-display font-bold text-sm cursor-pointer"
          >
            الذهاب لصفحة تسجيل الدخول
          </button>
        </div>
      </div>
    );
  }

  if (!activeSession) {
    return (
      <AuthScreen
        pendingGoogleUser={firebaseUser}
        inviteState={inviteState}
        onRetryInvite={
          inviteState
            ? async () => {
                const params = new URLSearchParams(window.location.search);
                const cpxParam = params.get('cpx')?.trim() || null;
                const msqParam = params.get('msq')?.trim() || null;
                await refreshInviteResolution(inviteState.token, cpxParam, msqParam);
              }
            : undefined
        }
        onSessionReady={(session) => {
          setActiveSession(session);
        }}
      />
    );
  }

  if (activeSession.account.role === 'platform_admin') {
    return <AdminDashboard session={activeSession} />;
  }

  const exitQuickSession = () => {
    setActiveSession(null);
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState({}, '', url.toString());
  };

  if (activeSession.account.role === 'supervisor') {
    return (
      <>
        <SupervisorDashboard
          session={activeSession}
          onExitQuickSession={exitQuickSession}
        />
        <BroadcastNotificationsHost session={activeSession} />
      </>
    );
  }

  if (activeSession.account.role === 'teacher') {
    return (
      <>
        <TeacherSessionHost
          session={activeSession}
          onExitQuickSession={exitQuickSession}
        />
        <BroadcastNotificationsHost session={activeSession} />
      </>
    );
  }

  return (
    <>
      <RoleWelcomeView
        session={activeSession}
        onExitQuickSession={exitQuickSession}
      />
      <BroadcastNotificationsHost session={activeSession} />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
      <StartupNotificationGate />
      <OfflineIndicator />
    </ErrorBoundary>
  );
}
