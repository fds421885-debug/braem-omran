/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthScreen } from './components/AuthScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ModernLoader } from './components/ModernLoader';
import { OfflineIndicator } from './components/OfflineIndicator';
import { RoleWelcomeView } from './components/RoleWelcomeView';
import { auth, db as primaryDb } from './firebase';
import {
  findExistingAccountForUser,
  resolveInviteLink,
  resolveQuickLinkSession,
} from './services/platformService';
import type { ActiveSession, InviteLinkRecord } from './types/platform';

interface InviteState {
  token: string;
  link: InviteLinkRecord | null;
  db: Firestore;
  dbLabel: string;
  complexName: string;
  mosqueNames: string[];
  halaqaNames: string[];
  status: 'valid' | 'not_found' | 'closed' | 'not_started' | 'expired';
}

function AppContent() {
  const [initializing, setInitializing] = useState(true);
  const [loadingLabel, setLoadingLabel] = useState('جاري تحميل منصة براعم عمران...');
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
    const params = new URLSearchParams(window.location.search);
    const quickToken = params.get('quick')?.trim() || null;
    const inviteToken = params.get('invite')?.trim() || null;
    const cpxParam = params.get('cpx')?.trim() || null;
    const msqParam = params.get('msq')?.trim() || null;

    let unsubscribeAuth: (() => void) | undefined;

    const bootstrap = async () => {
      // 1. Direct Quick Login Link flow (?quick=...)
      if (quickToken) {
        setLoadingLabel('جاري فتح رابط الدخول السريع...');
        try {
          const quickSession = await resolveQuickLinkSession(quickToken, cpxParam, msqParam);
          if (quickSession) {
            setActiveSession(quickSession);
            setInitializing(false);
            return;
          }
          setQuickLinkError('رابط الدخول السريع غير صالح أو تم إيقافه.');
        } catch {
          setQuickLinkError('تعذّر فتح رابط الدخول السريع.');
        }
      }

      // 2. Invite Registration Link resolution (?invite=...)
      let latestInviteStatus: InviteState['status'] | null = null;
      if (inviteToken) {
        setLoadingLabel('جاري التحقق من رابط التسجيل...');
        const resolved = await refreshInviteResolution(inviteToken, cpxParam, msqParam);
        latestInviteStatus = resolved.status;
      }

      // 3. Google Auth listener
      unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
        setFirebaseUser(user);
        if (!user) {
          setActiveSession(null);
          setInitializing(false);
          return;
        }

        setLoadingLabel('جاري البحث عن حسابك في القواعد المرتبطة...');
        setInitializing(true);
        try {
          const found = await findExistingAccountForUser(user);
          if (!found && inviteToken && latestInviteStatus === 'not_found') {
            const rechecked = await refreshInviteResolution(inviteToken, cpxParam, msqParam);
            latestInviteStatus = rechecked.status;
          }
          setActiveSession(found);
        } finally {
          setInitializing(false);
        }
      });
    };

    bootstrap();

    return () => {
      if (unsubscribeAuth) unsubscribeAuth();
    };
  }, []);

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

  return (
    <RoleWelcomeView
      session={activeSession}
      onExitQuickSession={() => {
        setActiveSession(null);
        const url = new URL(window.location.href);
        url.search = '';
        window.history.replaceState({}, '', url.toString());
      }}
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
      <OfflineIndicator />
    </ErrorBoundary>
  );
}
