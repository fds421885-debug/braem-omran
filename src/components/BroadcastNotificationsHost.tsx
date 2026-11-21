import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BellRing, Check, Megaphone } from 'lucide-react';
import { getFirestoreForConfig } from '../services/multiDb';
import {
  fetchBroadcastById,
  getDismissedBroadcastIds,
  getNotificationPermissionState,
  getOsNotifiedBroadcastIds,
  isBroadcastDue,
  markBroadcastDismissed,
  markBroadcastOsNotified,
  playBroadcastChime,
  showSystemBroadcastNotification,
  subscribeToBroadcastsForSession,
} from '../services/notificationService';
import {
  BROADCAST_ROLE_LABELS,
  ROLE_LABELS,
  type ActiveSession,
  type BroadcastMessageRecord,
} from '../types/platform';
import { MascotImage } from './MascotImage';

interface BroadcastNotificationsHostProps {
  session: ActiveSession;
}

const BASE_URL = import.meta.env.BASE_URL;
const WAVING_FOX_PATH = `${BASE_URL}src/assets/images/fox_welcome_wave_1794991801893.jpg`;

function formatArabicDateTime(ms: number): string {
  if (!ms) return 'الآن';
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

export const BroadcastNotificationsHost: React.FC<BroadcastNotificationsHostProps> = ({
  session,
}) => {
  const accountId = session.account.id || session.account.uid;
  const [liveMessages, setLiveMessages] = useState<BroadcastMessageRecord[]>([]);
  const [forcedMessage, setForcedMessage] = useState<BroadcastMessageRecord | null>(null);
  const [dismissedIds, setDismissedIds] = useState<string[]>(() =>
    getDismissedBroadcastIds(accountId)
  );
  const initialSnapshotDoneRef = useRef(false);
  const chimePlayedIdsRef = useRef<Set<string>>(new Set());

  // Sync dismissed list if user switches accounts
  useEffect(() => {
    setDismissedIds(getDismissedBroadcastIds(accountId));
    initialSnapshotDoneRef.current = false;
    chimePlayedIdsRef.current = new Set();
  }, [accountId]);

  const openSpecificBroadcastById = async (broadcastId: string) => {
    if (!broadcastId) return;
    const inLive = liveMessages.find((m) => m.id === broadcastId);
    if (inLive && isBroadcastDue(inLive)) {
      setForcedMessage(inLive);
      return;
    }
    const sessionDb = session.authConfig
      ? getFirestoreForConfig(session.authConfig)
      : null;
    const fetched = await fetchBroadcastById(broadcastId, sessionDb);
    if (fetched && isBroadcastDue(fetched)) {
      setForcedMessage(fetched);
    }
  };

  // Subscribe to real-time Firestore broadcasts (no refresh needed!)
  useEffect(() => {
    const role = session.account.role;
    if (role !== 'supervisor' && role !== 'teacher' && role !== 'student') {
      return;
    }

    const unsubscribe = subscribeToBroadcastsForSession(session, (filtered) => {
      setLiveMessages(filtered);

      const dismissedSet = new Set(getDismissedBroadcastIds(accountId));
      const osNotifiedSet = getOsNotifiedBroadcastIds(accountId);
      const unread = filtered.filter((m) => !dismissedSet.has(m.id));

      for (const msg of unread) {
        if (
          !osNotifiedSet.has(msg.id) &&
          getNotificationPermissionState() === 'granted'
        ) {
          markBroadcastOsNotified(accountId, msg.id);
          void showSystemBroadcastNotification(msg);
        }

        if (initialSnapshotDoneRef.current && !chimePlayedIdsRef.current.has(msg.id)) {
          chimePlayedIdsRef.current.add(msg.id);
          playBroadcastChime();
        } else {
          chimePlayedIdsRef.current.add(msg.id);
        }
      }

      initialSnapshotDoneRef.current = true;
    });

    return () => unsubscribe();
  }, [session, accountId]);

  // Handle ?msg=<id> deep link on open from external OS notification click
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const msgId = params.get('msg')?.trim();
    if (msgId && msgId !== 'welcome_enabled') {
      void openSpecificBroadcastById(msgId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Listen to Service Worker click messages and fallback window events
  useEffect(() => {
    const handleSwMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; broadcastId?: string } | undefined;
      if (payload?.type === 'OPEN_BROADCAST_MESSAGE' && payload.broadcastId) {
        if (payload.broadcastId !== 'welcome_enabled') {
          void openSpecificBroadcastById(payload.broadcastId);
        }
      }
    };

    const handleCustomEvent = (event: Event) => {
      const custom = event as CustomEvent<{ broadcastId?: string }>;
      if (custom.detail?.broadcastId && custom.detail.broadcastId !== 'welcome_enabled') {
        void openSpecificBroadcastById(custom.detail.broadcastId);
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }
    window.addEventListener('braem-open-broadcast', handleCustomEvent);

    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
      window.removeEventListener('braem-open-broadcast', handleCustomEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMessages, session.authConfig]);

  const unreadQueue = liveMessages.filter((m) => !dismissedIds.includes(m.id));
  const activeMessage = forcedMessage || unreadQueue[0] || null;

  if (!activeMessage || typeof document === 'undefined') {
    return null;
  }

  const handleDismiss = () => {
    const next = markBroadcastDismissed(accountId, activeMessage.id);
    setDismissedIds(next);

    if (forcedMessage?.id === activeMessage.id) {
      setForcedMessage(null);
    }

    // Remove ?msg= query param cleanly while preserving ?quick= / ?invite= / ?cpx= / ?msq=
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('msg')) {
        url.searchParams.delete('msg');
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // Ignore history API error
    }
  };

  const targetRolesLabel = activeMessage.targetRoles
    .map((r) => BROADCAST_ROLE_LABELS[r] || ROLE_LABELS[r])
    .join(' · ');

  return createPortal(
    <div
      dir="rtl"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-[#4A220D]/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="broadcast-modal-title"
    >
      <div className="w-full max-w-lg bg-white border-2 border-[#EADBC8] rounded-3xl overflow-hidden shadow-2xl">
        {/* Duolingo Mascot + Speech Bubble Banner */}
        <div className="bg-gradient-to-l from-[#FFF4E6] via-[#FDF6EE] to-[#FFFFFF] px-5 sm:px-6 pt-5 pb-4 border-b-2 border-[#EADBC8] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-16 h-16 rounded-2xl bg-white border-2 border-[#EADBC8] p-1 shrink-0 flex items-center justify-center">
              <MascotImage
                src={WAVING_FOX_PATH}
                alt="براعم عمران"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="inline-flex items-center gap-1.5 bg-[#F56900] text-white px-3 py-1 rounded-xl border-b-2 border-[#C95200] text-xs font-display font-extrabold">
                <Megaphone className="w-3.5 h-3.5 shrink-0" />
                <span>رسالة من إدارة المنصة</span>
              </div>
              <p className="text-xs font-bold text-[#7D4E35] truncate">
                {activeMessage.senderName} · {formatArabicDateTime(activeMessage.createdAtMs)}
              </p>
            </div>
          </div>

          {!forcedMessage && unreadQueue.length > 1 && (
            <div className="shrink-0 bg-[#58CC02]/15 border border-[#58CC02] text-[#46A302] rounded-xl px-2.5 py-1 font-display text-xs font-extrabold tabular-nums">
              1 / {unreadQueue.length}
            </div>
          )}
        </div>

        {/* Full Readable Message Content */}
        <div className="p-5 sm:p-6 space-y-4">
          <div className="space-y-1.5">
            <h2
              id="broadcast-modal-title"
              className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D] leading-snug"
            >
              {activeMessage.title}
            </h2>
            <p className="text-xs font-bold text-[#F56900]">
              موجهة إلى: {targetRolesLabel}
              {activeMessage.targetComplexName && activeMessage.targetComplexId !== 'all'
                ? ` · ${activeMessage.targetComplexName}`
                : ''}
            </p>
          </div>

          <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 sm:p-5 max-h-[45vh] overflow-y-auto">
            <p className="text-sm sm:text-base font-medium text-[#4A220D] leading-relaxed whitespace-pre-wrap break-words">
              {activeMessage.body}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-[#7D4E35]">
            <span className="inline-flex items-center gap-1.5">
              <BellRing className="w-3.5 h-3.5 text-[#58CC02] shrink-0" />
              <span>اضغط «تم» بعد قراءة الرسالة لإغلاقها</span>
            </span>
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            className="duo-btn-green w-full min-h-[52px] px-6 py-3 rounded-2xl font-display font-extrabold text-base sm:text-lg inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <Check className="w-5 h-5 shrink-0" />
            <span>تم</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
