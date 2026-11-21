import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { db as primaryDb } from '../firebase';
import { generateValidId, getFirestoreForConfig } from './multiDb';
import { getAllKnownDatabases } from './platformService';
import type {
  ActiveSession,
  BroadcastMessageRecord,
  BroadcastTargetRole,
} from '../types/platform';

const BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

const DISMISSED_STORAGE_PREFIX = 'braem_dismissed_broadcasts_v1_';
const NOTIFIED_OS_STORAGE_PREFIX = 'braem_notified_broadcasts_v1_';

export class BroadcastRulesPermissionError extends Error {
  code = 'PRIMARY_RULES_NEED_UPDATE';
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastRulesPermissionError';
  }
}

export function getNotificationPermissionState(): NotificationPermissionState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission as NotificationPermissionState;
}

export function buildBroadcastNotificationUrl(currentHref: string, broadcastId: string): string {
  try {
    const url = new URL(currentHref);
    url.searchParams.set('msg', broadcastId);
    return url.toString();
  } catch {
    return `${BASE_URL}?msg=${encodeURIComponent(broadcastId)}`;
  }
}

export function getDismissedBroadcastIds(accountId: string): string[] {
  if (typeof window === 'undefined' || !accountId) return [];
  try {
    const raw = window.localStorage.getItem(`${DISMISSED_STORAGE_PREFIX}${accountId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markBroadcastDismissed(accountId: string, broadcastId: string): string[] {
  if (typeof window === 'undefined' || !accountId || !broadcastId) return [];
  const current = new Set(getDismissedBroadcastIds(accountId));
  current.add(broadcastId);
  const next = Array.from(current).slice(-200);
  try {
    window.localStorage.setItem(`${DISMISSED_STORAGE_PREFIX}${accountId}`, JSON.stringify(next));
  } catch {
    // Ignore quota errors
  }
  return next;
}

export function getOsNotifiedBroadcastIds(accountId: string): Set<string> {
  if (typeof window === 'undefined' || !accountId) return new Set();
  try {
    const raw = window.localStorage.getItem(`${NOTIFIED_OS_STORAGE_PREFIX}${accountId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function markBroadcastOsNotified(accountId: string, broadcastId: string): void {
  if (typeof window === 'undefined' || !accountId || !broadcastId) return;
  const current = getOsNotifiedBroadcastIds(accountId);
  current.add(broadcastId);
  const next = Array.from(current).slice(-200);
  try {
    window.localStorage.setItem(`${NOTIFIED_OS_STORAGE_PREFIX}${accountId}`, JSON.stringify(next));
  } catch {
    // Ignore quota errors
  }
}

export function playBroadcastChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const playNote = (freq: number, startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.11, now + startOffset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    // Cheerful two-note ascending chime
    playNote(587.33, 0, 0.14); // D5
    playNote(880.0, 0.12, 0.22); // A5
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 600);
  } catch {
    // Ignore autoplay restriction errors
  }
}

export async function showSystemBroadcastNotification(msg: {
  id: string;
  title: string;
  body: string;
  senderName?: string;
}): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  const targetUrl = buildBroadcastNotificationUrl(window.location.href, msg.id);
  const iconUrl = `${BASE_URL}pwa-192x192.png`;
  const cleanBody =
    msg.body.length > 180 ? `${msg.body.slice(0, 177).trim()}...` : msg.body;

  const notifOptions: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: cleanBody,
    icon: iconUrl,
    badge: iconUrl,
    dir: 'rtl',
    lang: 'ar',
    tag: `braem-msg-${msg.id}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [180, 80, 180],
    data: {
      broadcastId: msg.id,
      targetUrl,
    },
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race<ServiceWorkerRegistration | null>([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500)),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(msg.title || 'رسالة من منصة براعم عمران', notifOptions);
        return true;
      }
    }
  } catch {
    // Fallback to Notification constructor below on desktop browsers
  }

  try {
    const n = new Notification(msg.title || 'رسالة من منصة براعم عمران', notifOptions);
    n.onclick = () => {
      try {
        window.focus();
        window.dispatchEvent(
          new CustomEvent('braem-open-broadcast', { detail: { broadcastId: msg.id } })
        );
      } catch {
        // Ignore focus restriction
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

export async function requestAppNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      playBroadcastChime();
      await showSystemBroadcastNotification({
        id: 'welcome_enabled',
        title: 'براعم عمران · تم تفعيل الإشعارات',
        body: 'ستصلك الآن إشعارات المنصة ورسائل الإدارة مباشرة على جهازك.',
      });
    }
    return result as NotificationPermissionState;
  } catch {
    return getNotificationPermissionState();
  }
}

function normalizeBroadcastDoc(id: string, raw: Record<string, unknown>): BroadcastMessageRecord {
  const rawRoles = Array.isArray(raw.targetRoles) ? raw.targetRoles : [];
  const targetRoles = rawRoles.filter(
    (r): r is BroadcastTargetRole =>
      r === 'supervisor' || r === 'teacher' || r === 'student'
  );
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'رسالة من إدارة المنصة',
    body: typeof raw.body === 'string' ? raw.body : '',
    targetRoles,
    targetComplexId:
      typeof raw.targetComplexId === 'string' && raw.targetComplexId
        ? raw.targetComplexId
        : 'all',
    targetComplexName:
      typeof raw.targetComplexName === 'string' && raw.targetComplexName
        ? raw.targetComplexName
        : 'جميع المجمعات',
    senderName:
      typeof raw.senderName === 'string' && raw.senderName
        ? raw.senderName
        : 'إدارة المنصة',
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    active: raw.active !== false,
    createdAtMs: typeof raw.createdAtMs === 'number' ? raw.createdAtMs : 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function mergeBroadcastSources(
  ...lists: BroadcastMessageRecord[][]
): BroadcastMessageRecord[] {
  const map = new Map<string, BroadcastMessageRecord>();
  for (const list of lists) {
    for (const item of list) {
      if (!item || !item.id) continue;
      const existing = map.get(item.id);
      if (!existing || (item.createdAtMs || 0) >= (existing.createdAtMs || 0)) {
        map.set(item.id, item);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

export function filterBroadcastsForRecipient(
  items: BroadcastMessageRecord[],
  recipient: {
    role: string;
    complexId?: string;
  }
): BroadcastMessageRecord[] {
  if (
    recipient.role !== 'supervisor' &&
    recipient.role !== 'teacher' &&
    recipient.role !== 'student'
  ) {
    return [];
  }
  const role = recipient.role as BroadcastTargetRole;
  const userComplexId = recipient.complexId || '';

  return items
    .filter((item) => {
      if (!item.active) return false;
      if (!item.targetRoles.includes(role)) return false;
      if (!item.targetComplexId || item.targetComplexId === 'all') return true;
      if (!userComplexId) return true;
      return item.targetComplexId === userComplexId;
    })
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

export async function sendBroadcastMessage(params: {
  title: string;
  body: string;
  targetRoles: BroadcastTargetRole[];
  targetComplexId: string;
  targetComplexName: string;
  senderName: string;
  createdBy: string;
}): Promise<BroadcastMessageRecord> {
  const cleanBody = params.body.trim();
  if (!cleanBody) {
    throw new Error('يرجى كتابة نص الرسالة قبل الإرسال.');
  }
  const roles = Array.from(new Set(params.targetRoles));
  if (roles.length === 0) {
    throw new Error('يرجى اختيار فئة مستهدفة واحدة على الأقل (مشرفين / معلمين / طلاب).');
  }

  const id = generateValidId('msg');
  const nowMs = Date.now();
  const payload = {
    id,
    title: (params.title.trim() || 'رسالة من إدارة المنصة').slice(0, 160),
    body: cleanBody.slice(0, 4000),
    targetRoles: roles,
    targetComplexId: params.targetComplexId || 'all',
    targetComplexName: params.targetComplexName || 'جميع المجمعات',
    senderName: (params.senderName.trim() || 'المبرمج').slice(0, 100),
    createdBy: params.createdBy,
    active: true,
    createdAtMs: nowMs,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(primaryDb, 'broadcasts', id), payload);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'permission-denied') {
      throw new BroadcastRulesPermissionError(
        'تعذّر حفظ الرسالة في القاعدة الأساسية لأن قواعد الحماية تحتاج تحديثاً لإضافة مجموعة الرسائل (broadcasts).'
      );
    }
    throw err;
  }

  // Also mirror to connected external databases so complex-only links receive updates smoothly
  try {
    const knownDbs = await getAllKnownDatabases();
    await Promise.all(
      knownDbs
        .filter((d) => !d.isPrimary)
        .map((d) =>
          setDoc(doc(d.db, 'broadcasts', id), payload).catch(() => {
            // External project may not have updated rules yet; primary copy still works
          })
        )
    );
  } catch {
    // Non-fatal
  }

  return normalizeBroadcastDoc(id, payload);
}

export async function listRecentBroadcasts(): Promise<BroadcastMessageRecord[]> {
  try {
    const snap = await getDocs(collection(primaryDb, 'broadcasts'));
    const list = snap.docs.map((d) =>
      normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
    );
    return list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  } catch {
    return [];
  }
}

export async function deactivateBroadcastMessage(broadcastId: string): Promise<void> {
  await updateDoc(doc(primaryDb, 'broadcasts', broadcastId), {
    active: false,
    updatedAt: serverTimestamp(),
  });
  try {
    const knownDbs = await getAllKnownDatabases();
    await Promise.all(
      knownDbs
        .filter((d) => !d.isPrimary)
        .map((d) =>
          updateDoc(doc(d.db, 'broadcasts', broadcastId), {
            active: false,
            updatedAt: serverTimestamp(),
          }).catch(() => {})
        )
    );
  } catch {
    // Non-fatal
  }
}

export async function fetchBroadcastById(
  broadcastId: string,
  sessionDb?: Firestore | null
): Promise<BroadcastMessageRecord | null> {
  if (!broadcastId) return null;
  try {
    const snap = await getDoc(doc(primaryDb, 'broadcasts', broadcastId));
    if (snap.exists()) {
      return normalizeBroadcastDoc(snap.id, snap.data() as Record<string, unknown>);
    }
  } catch {
    // Try session external db below
  }

  if (sessionDb && sessionDb !== primaryDb) {
    try {
      const snap = await getDoc(doc(sessionDb, 'broadcasts', broadcastId));
      if (snap.exists()) {
        return normalizeBroadcastDoc(snap.id, snap.data() as Record<string, unknown>);
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

export function subscribeToBroadcastsForSession(
  session: ActiveSession,
  onMessagesChange: (messages: BroadcastMessageRecord[]) => void
): () => void {
  const role = session.account.role;
  const complexId = session.account.complexId || '';
  const sessionDb = session.authConfig ? getFirestoreForConfig(session.authConfig) : primaryDb;

  let primaryList: BroadcastMessageRecord[] = [];
  let externalList: BroadcastMessageRecord[] = [];

  const emitCombined = () => {
    const merged = mergeBroadcastSources(primaryList, externalList);
    const filtered = filterBroadcastsForRecipient(merged, { role, complexId });
    onMessagesChange(filtered);
  };

  const qPrimary = query(collection(primaryDb, 'broadcasts'), where('active', '==', true));
  const unsubPrimary = onSnapshot(
    qPrimary,
    (snap) => {
      primaryList = snap.docs.map((d) =>
        normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
      );
      emitCombined();
    },
    () => {
      // Ignore transient listener errors while offline
    }
  );

  let unsubExternal: (() => void) | null = null;
  if (sessionDb && sessionDb !== primaryDb) {
    const qExternal = query(collection(sessionDb, 'broadcasts'), where('active', '==', true));
    unsubExternal = onSnapshot(
      qExternal,
      (snap) => {
        externalList = snap.docs.map((d) =>
          normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
        );
        emitCombined();
      },
      () => {
        // External DB might not have broadcasts rule yet
      }
    );
  }

  return () => {
    unsubPrimary();
    if (unsubExternal) unsubExternal();
  };
}
