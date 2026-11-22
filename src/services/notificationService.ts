import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { auth as primaryAuth, db as primaryDb } from '../firebase';
import { generateValidId, getFirestoreForConfig } from './multiDb';
import { getAllKnownDatabases } from './platformService';
import type {
  ActiveSession,
  BroadcastMessageRecord,
  BroadcastTargetRole,
  ExternalFirebaseConfig,
} from '../types/platform';

const BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

const DISMISSED_STORAGE_PREFIX = 'braem_dismissed_broadcasts_v1_';
const NOTIFIED_OS_STORAGE_PREFIX = 'braem_notified_broadcasts_v1_';
const OUTBOX_STORAGE_KEY = 'braem_broadcast_outbox_v1';
const CACHE_STORAGE_PREFIX = 'braem_cached_broadcasts_v1_';
const NOTIF_SYSTEM_VERSION_KEY = 'braem_notif_system_version_v1';
export const CURRENT_NOTIFICATION_SYSTEM_VERSION = '2026.11.22.1';
export const BROADCAST_OUTBOX_EVENT = 'braem-broadcast-outbox-changed';
export const NOTIFICATION_SYSTEM_UPGRADED_EVENT = 'braem-notification-system-upgraded';
const BROADCAST_WRITE_TIMEOUT_MS = 7000;

export interface PendingBroadcastOutboxItem {
  id: string;
  title: string;
  body: string;
  targetRoles: BroadcastTargetRole[];
  targetComplexId: string;
  targetComplexName: string;
  senderName: string;
  createdBy: string;
  createdAtMs: number;
  scopedComplexOnly: boolean;
  targetDbConfig: ExternalFirebaseConfig | null;
  mirrorDbConfigs: ExternalFirebaseConfig[];
  queuedAtMs: number;
}

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

let inMemoryNotifSystemVersion: string | null = null;

export function getSavedNotificationSystemVersion(): string | null {
  if (typeof window === 'undefined') return inMemoryNotifSystemVersion;
  try {
    return window.localStorage.getItem(NOTIF_SYSTEM_VERSION_KEY) || inMemoryNotifSystemVersion;
  } catch {
    return inMemoryNotifSystemVersion;
  }
}

export function saveNotificationSystemVersion(
  version = CURRENT_NOTIFICATION_SYSTEM_VERSION
): void {
  inMemoryNotifSystemVersion = version;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NOTIF_SYSTEM_VERSION_KEY, version);
  } catch {
    // Ignore storage quota / iframe restrictions; inMemoryNotifSystemVersion handles active session
  }
  try {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_SYSTEM_UPGRADED_EVENT));
  } catch {
    // Ignore event errors
  }
}

export function isNotificationSystemVersionOutdated(): boolean {
  if (typeof window === 'undefined') return false;
  if (getNotificationPermissionState() !== 'granted') return false;
  return getSavedNotificationSystemVersion() !== CURRENT_NOTIFICATION_SYSTEM_VERSION;
}

export async function requestAppNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      saveNotificationSystemVersion(CURRENT_NOTIFICATION_SYSTEM_VERSION);
      if ('serviceWorker' in navigator) {
        void navigator.serviceWorker
          .getRegistration()
          .then((reg) => reg?.update().catch(() => {}))
          .catch(() => {});
      }
      playBroadcastChime();
      await showSystemBroadcastNotification({
        id: 'welcome_enabled',
        title: 'براعم عمران · تم تفعيل الإشعارات',
        body: 'ستصلك الآن إشعارات المنصة والمجمع الفورية والمجدولة وحتى بعد عودة الإنترنت مباشرة.',
      });
    }
    return result as NotificationPermissionState;
  } catch {
    return getNotificationPermissionState();
  }
}

export async function upgradeNotificationSystem(): Promise<{ upgradedVersion: string }> {
  saveNotificationSystemVersion(CURRENT_NOTIFICATION_SYSTEM_VERSION);

  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await Promise.race([
          reg.update().catch(() => {}),
          new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
        ]);
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      }
    } catch {
      // Non-fatal if offline or no SW registered yet
    }
  }

  void flushPendingBroadcastOutbox().catch(() => {});

  if (getNotificationPermissionState() === 'granted') {
    playBroadcastChime();
    await Promise.race([
      showSystemBroadcastNotification({
        id: 'notif_system_upgraded',
        title: 'براعم عمران · تم تحديث نظام الإشعارات',
        body: 'أصبح جهازك مهيأً الآن لاستقبال الإشعارات المجدولة ورسائل المجمعات والتوصيل بعد عودة الإنترنت.',
      }).catch(() => false),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
    ]);
  }

  return { upgradedVersion: CURRENT_NOTIFICATION_SYSTEM_VERSION };
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

export function isBroadcastDue(
  item: Pick<BroadcastMessageRecord, 'active' | 'createdAtMs'>,
  nowMs = Date.now()
): boolean {
  if (!item.active) return false;
  return !item.createdAtMs || item.createdAtMs <= nowMs;
}

function matchesRecipientScope(
  item: BroadcastMessageRecord,
  recipient: { role: string; complexId?: string }
): boolean {
  if (
    recipient.role !== 'supervisor' &&
    recipient.role !== 'teacher' &&
    recipient.role !== 'student'
  ) {
    return false;
  }
  const role = recipient.role as BroadcastTargetRole;
  const userComplexId = recipient.complexId || '';
  if (!item.active) return false;
  if (!item.targetRoles.includes(role)) return false;
  if (!item.targetComplexId || item.targetComplexId === 'all') return true;
  if (!userComplexId) return true;
  return item.targetComplexId === userComplexId;
}

export function filterBroadcastsForRecipient(
  items: BroadcastMessageRecord[],
  recipient: {
    role: string;
    complexId?: string;
  },
  nowMs = Date.now()
): BroadcastMessageRecord[] {
  return items
    .filter((item) => matchesRecipientScope(item, recipient) && isBroadcastDue(item, nowMs))
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

export interface BroadcastScopeOptions {
  targetDb?: Firestore;
  targetDbConfig?: ExternalFirebaseConfig | null;
  mirrorDbs?: Firestore[];
  mirrorDbConfigs?: ExternalFirebaseConfig[];
  complexId?: string;
  scopedComplexOnly?: boolean;
  actorUid?: string;
}

function isNetworkOrTimeoutError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code || '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    code.includes('unavailable') ||
    code.includes('offline') ||
    code.includes('aborted') ||
    code.includes('deadline') ||
    msg.includes('offline') ||
    msg.includes('unavailable') ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('broadcast_write_timeout')
  );
}

async function writeDocWithTimeout(
  fn: () => Promise<void>,
  timeoutMs = BROADCAST_WRITE_TIMEOUT_MS
): Promise<void> {
  await Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      window.setTimeout(() => reject(new Error('broadcast_write_timeout')), timeoutMs)
    ),
  ]);
}

function readRawOutbox(): PendingBroadcastOutboxItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingBroadcastOutboxItem[]) : [];
  } catch {
    return [];
  }
}

function writeRawOutbox(items: PendingBroadcastOutboxItem[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(OUTBOX_STORAGE_KEY);
    } else {
      window.localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(items.slice(-50)));
    }
    window.dispatchEvent(new CustomEvent(BROADCAST_OUTBOX_EVENT));
  } catch {
    // Ignore storage quota errors
  }
}

export function getPendingBroadcastOutbox(filterComplexId?: string): PendingBroadcastOutboxItem[] {
  const all = readRawOutbox();
  if (!filterComplexId) return all;
  return all.filter((item) => item.targetComplexId === filterComplexId);
}

export function enqueueOfflineBroadcast(item: PendingBroadcastOutboxItem): void {
  const current = readRawOutbox().filter((existing) => existing.id !== item.id);
  current.push(item);
  writeRawOutbox(current);
  ensureBroadcastOfflineSyncListeners();
}

export function removeOfflineBroadcast(broadcastId: string): void {
  const next = readRawOutbox().filter((item) => item.id !== broadcastId);
  writeRawOutbox(next);
}

async function dispatchOutboxItemMirrors(
  item: PendingBroadcastOutboxItem,
  payload: Record<string, unknown>,
  primaryWriteDb: Firestore
): Promise<void> {
  if (item.scopedComplexOnly) {
    const mirrorTargets = (item.mirrorDbConfigs || [])
      .map((cfg) => getFirestoreForConfig(cfg))
      .filter((db) => db !== primaryWriteDb && !(primaryWriteDb !== primaryDb && db === primaryDb));
    await Promise.all(
      mirrorTargets.map((db) =>
        setDoc(doc(db, 'broadcasts', item.id), payload).catch(() => {})
      )
    );
    return;
  }

  try {
    const knownDbs = await getAllKnownDatabases();
    await Promise.all(
      knownDbs
        .filter((d) => !d.isPrimary && d.db !== primaryWriteDb)
        .map((d) =>
          setDoc(doc(d.db, 'broadcasts', item.id), payload).catch(() => {})
        )
    );
  } catch {
    // Non-fatal
  }
}

let activeOutboxFlushPromise: Promise<{ sentIds: string[]; remainingCount: number }> | null = null;
let offlineListenersAttached = false;

export async function flushPendingBroadcastOutbox(): Promise<{
  sentIds: string[];
  remainingCount: number;
}> {
  if (typeof window === 'undefined') return { sentIds: [], remainingCount: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { sentIds: [], remainingCount: readRawOutbox().length };
  }
  if (activeOutboxFlushPromise) {
    return activeOutboxFlushPromise;
  }

  activeOutboxFlushPromise = (async () => {
    const sentIds: string[] = [];
    const queue = readRawOutbox();
    if (queue.length === 0) return { sentIds, remainingCount: 0 };

    const remaining: PendingBroadcastOutboxItem[] = [];
    for (const item of queue) {
      const writeDb = item.targetDbConfig
        ? getFirestoreForConfig(item.targetDbConfig)
        : primaryDb;
      if (writeDb === primaryDb && !primaryAuth.currentUser) {
        remaining.push(item);
        continue;
      }
      const payload = {
        id: item.id,
        title: item.title,
        body: item.body,
        targetRoles: item.targetRoles,
        targetComplexId: item.targetComplexId,
        targetComplexName: item.targetComplexName,
        senderName: item.senderName,
        createdBy: item.createdBy,
        active: true,
        createdAtMs: item.createdAtMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      try {
        await writeDocWithTimeout(() => setDoc(doc(writeDb, 'broadcasts', item.id), payload));
        await dispatchOutboxItemMirrors(item, payload, writeDb);
        sentIds.push(item.id);
      } catch {
        // Keep in queue until connection or rules allow delivery
        remaining.push(item);
      }
    }

    if (sentIds.length > 0) {
      writeRawOutbox(remaining);
    }
    return { sentIds, remainingCount: remaining.length };
  })().finally(() => {
    activeOutboxFlushPromise = null;
  });

  return activeOutboxFlushPromise;
}

export function ensureBroadcastOfflineSyncListeners(): void {
  if (typeof window === 'undefined' || offlineListenersAttached) return;
  offlineListenersAttached = true;

  const tryFlushWithFollowUp = () => {
    if (readRawOutbox().length === 0) return;
    void flushPendingBroadcastOutbox();
    window.setTimeout(() => {
      if (readRawOutbox().length > 0) {
        void flushPendingBroadcastOutbox();
      }
    }, 2500);
  };

  window.addEventListener('online', tryFlushWithFollowUp);
  window.addEventListener('focus', tryFlushWithFollowUp);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tryFlushWithFollowUp();
    }
  });
}

function loadCachedRecipientBroadcasts(accountKey: string): BroadcastMessageRecord[] {
  if (typeof window === 'undefined' || !accountKey) return [];
  try {
    const raw = window.localStorage.getItem(`${CACHE_STORAGE_PREFIX}${accountKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => normalizeBroadcastDoc(String(item.id || ''), item));
  } catch {
    return [];
  }
}

function saveCachedRecipientBroadcasts(accountKey: string, list: BroadcastMessageRecord[]): void {
  if (typeof window === 'undefined' || !accountKey) return;
  try {
    const trimmed = list
      .filter((m) => m.active)
      .slice(0, 40)
      .map((m) => ({
        id: m.id,
        title: m.title,
        body: m.body,
        targetRoles: m.targetRoles,
        targetComplexId: m.targetComplexId,
        targetComplexName: m.targetComplexName,
        senderName: m.senderName,
        createdBy: m.createdBy,
        active: m.active,
        createdAtMs: m.createdAtMs,
      }));
    window.localStorage.setItem(`${CACHE_STORAGE_PREFIX}${accountKey}`, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors
  }
}

export async function sendBroadcastMessage(params: {
  title: string;
  body: string;
  targetRoles: BroadcastTargetRole[];
  targetComplexId: string;
  targetComplexName: string;
  senderName: string;
  createdBy: string;
  scheduledAtMs?: number;
  targetDb?: Firestore;
  targetDbConfig?: ExternalFirebaseConfig | null;
  mirrorDbs?: Firestore[];
  mirrorDbConfigs?: ExternalFirebaseConfig[];
  scopedComplexOnly?: boolean;
}): Promise<BroadcastMessageRecord> {
  ensureBroadcastOfflineSyncListeners();

  const cleanBody = params.body.trim();
  if (!cleanBody) {
    throw new Error('يرجى كتابة نص الرسالة قبل الإرسال.');
  }
  const roles = Array.from(new Set(params.targetRoles));
  if (roles.length === 0) {
    throw new Error('يرجى اختيار فئة مستهدفة واحدة على الأقل (مشرفين / معلمين / طلاب).');
  }

  if (params.scopedComplexOnly && (!params.targetComplexId || params.targetComplexId === 'all')) {
    throw new Error('صلاحية الإرسال مقتصرة على نطاق المجمع التابع لك فقط.');
  }

  const id = generateValidId('msg');
  const nowMs = Date.now();
  const publishAtMs =
    typeof params.scheduledAtMs === 'number' &&
    Number.isFinite(params.scheduledAtMs) &&
    params.scheduledAtMs > nowMs
      ? Math.round(params.scheduledAtMs)
      : nowMs;

  const defaultTitle = params.scopedComplexOnly
    ? 'رسالة من إدارة المجمع'
    : 'رسالة من إدارة المنصة';

  const normalizedTitle = (params.title.trim() || defaultTitle).slice(0, 160);
  const normalizedBody = cleanBody.slice(0, 4000);
  const normalizedComplexId = params.targetComplexId || 'all';
  const normalizedComplexName = params.targetComplexName || 'جميع المجمعات';
  const normalizedSenderName = (params.senderName.trim() || 'الإدارة').slice(0, 100);

  const outboxItem: PendingBroadcastOutboxItem = {
    id,
    title: normalizedTitle,
    body: normalizedBody,
    targetRoles: roles,
    targetComplexId: normalizedComplexId,
    targetComplexName: normalizedComplexName,
    senderName: normalizedSenderName,
    createdBy: params.createdBy,
    createdAtMs: publishAtMs,
    scopedComplexOnly: Boolean(params.scopedComplexOnly),
    targetDbConfig: params.targetDbConfig || null,
    mirrorDbConfigs: params.mirrorDbConfigs || [],
    queuedAtMs: nowMs,
  };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    enqueueOfflineBroadcast(outboxItem);
    return {
      ...normalizeBroadcastDoc(id, outboxItem as unknown as Record<string, unknown>),
      queuedOffline: true,
    };
  }

  const payload = {
    id,
    title: normalizedTitle,
    body: normalizedBody,
    targetRoles: roles,
    targetComplexId: normalizedComplexId,
    targetComplexName: normalizedComplexName,
    senderName: normalizedSenderName,
    createdBy: params.createdBy,
    active: true,
    createdAtMs: publishAtMs,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const primaryWriteDb =
    params.targetDb ||
    (params.targetDbConfig ? getFirestoreForConfig(params.targetDbConfig) : primaryDb);

  try {
    await writeDocWithTimeout(() => setDoc(doc(primaryWriteDb, 'broadcasts', id), payload));
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'permission-denied') {
      throw new BroadcastRulesPermissionError(
        params.scopedComplexOnly
          ? 'تعذّر حفظ الرسالة لأن قواعد الحماية في القاعدة الأساسية تحتاج تحديثاً للسماح لمشرفي المجمعات بالإرسال، أو أن الجلسة ليست مسجلة بحساب جوجل.'
          : 'تعذّر حفظ الرسالة في القاعدة الأساسية لأن قواعد الحماية تحتاج تحديثاً لإضافة مجموعة الرسائل (broadcasts).'
      );
    }
    if (isNetworkOrTimeoutError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      enqueueOfflineBroadcast(outboxItem);
      return {
        ...normalizeBroadcastDoc(id, outboxItem as unknown as Record<string, unknown>),
        queuedOffline: true,
      };
    }
    throw err;
  }

  if (params.scopedComplexOnly) {
    const mirrorSet = new Set<Firestore>(params.mirrorDbs || []);
    for (const cfg of params.mirrorDbConfigs || []) {
      mirrorSet.add(getFirestoreForConfig(cfg));
    }
    const mirrorTargets = Array.from(mirrorSet).filter(
      (db) => db !== primaryWriteDb && !(primaryWriteDb !== primaryDb && db === primaryDb)
    );
    await Promise.all(
      mirrorTargets.map((db) =>
        setDoc(doc(db, 'broadcasts', id), payload).catch(() => {})
      )
    );
  } else {
    // Platform admin global broadcast: mirror to connected external databases so complex-only links receive updates smoothly
    try {
      const knownDbs = await getAllKnownDatabases();
      await Promise.all(
        knownDbs
          .filter((d) => !d.isPrimary && d.db !== primaryWriteDb)
          .map((d) =>
            setDoc(doc(d.db, 'broadcasts', id), payload).catch(() => {
              // External project may not have updated rules yet; primary copy still works
            })
          )
      );
    } catch {
      // Non-fatal
    }
  }

  return normalizeBroadcastDoc(id, payload);
}

export async function listRecentBroadcasts(
  options?: BroadcastScopeOptions
): Promise<BroadcastMessageRecord[]> {
  try {
    const readDb = options?.targetDb || primaryDb;
    if (options?.scopedComplexOnly) {
      if (!options.complexId || options.complexId === 'all') return [];
      const q = query(
        collection(readDb, 'broadcasts'),
        where('targetComplexId', '==', options.complexId)
      );
      const snap = await getDocs(q);
      const list = snap.docs
        .map((d) => normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>))
        .filter((item) => item.targetComplexId === options.complexId);
      return list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    }

    const snap = await getDocs(collection(readDb, 'broadcasts'));
    const list = snap.docs.map((d) =>
      normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
    );
    return list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  } catch {
    return [];
  }
}

export async function deactivateBroadcastMessage(
  broadcastId: string,
  options?: BroadcastScopeOptions
): Promise<void> {
  const writeDb = options?.targetDb || primaryDb;
  await updateDoc(doc(writeDb, 'broadcasts', broadcastId), {
    active: false,
    updatedAt: serverTimestamp(),
  });

  if (options?.scopedComplexOnly) {
    const mirrorTargets = Array.from(new Set(options.mirrorDbs || [])).filter(
      (db) => db !== writeDb && !(writeDb !== primaryDb && db === primaryDb)
    );
    await Promise.all(
      mirrorTargets.map((db) =>
        updateDoc(doc(db, 'broadcasts', broadcastId), {
          active: false,
          updatedAt: serverTimestamp(),
        }).catch(() => {})
      )
    );
    return;
  }

  try {
    const knownDbs = await getAllKnownDatabases();
    await Promise.all(
      knownDbs
        .filter((d) => !d.isPrimary && d.db !== writeDb)
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

export async function deleteBroadcastMessage(
  broadcastId: string,
  options?: BroadcastScopeOptions
): Promise<void> {
  const writeDb = options?.targetDb || primaryDb;
  await deleteDoc(doc(writeDb, 'broadcasts', broadcastId));

  if (options?.scopedComplexOnly) {
    const mirrorTargets = Array.from(new Set(options.mirrorDbs || [])).filter(
      (db) => db !== writeDb && !(writeDb !== primaryDb && db === primaryDb)
    );
    await Promise.all(
      mirrorTargets.map((db) =>
        deleteDoc(doc(db, 'broadcasts', broadcastId)).catch(() =>
          updateDoc(doc(db, 'broadcasts', broadcastId), {
            active: false,
            updatedAt: serverTimestamp(),
          }).catch(() => {})
        )
      )
    );
    return;
  }

  try {
    const knownDbs = await getAllKnownDatabases();
    await Promise.all(
      knownDbs
        .filter((d) => !d.isPrimary && d.db !== writeDb)
        .map((d) =>
          deleteDoc(doc(d.db, 'broadcasts', broadcastId)).catch(() =>
            updateDoc(doc(d.db, 'broadcasts', broadcastId), {
              active: false,
              updatedAt: serverTimestamp(),
            }).catch(() => {})
          )
        )
    );
  } catch {
    // Non-fatal
  }
}

export async function rescheduleBroadcastMessage(
  existing: BroadcastMessageRecord,
  nextPublishAtMs: number,
  options?: BroadcastScopeOptions
): Promise<BroadcastMessageRecord> {
  const created = await sendBroadcastMessage({
    title: existing.title,
    body: existing.body,
    targetRoles: existing.targetRoles,
    targetComplexId: options?.complexId || existing.targetComplexId,
    targetComplexName: existing.targetComplexName,
    senderName: existing.senderName,
    createdBy: options?.actorUid || existing.createdBy,
    scheduledAtMs: nextPublishAtMs > Date.now() ? nextPublishAtMs : undefined,
    targetDb: options?.targetDb,
    targetDbConfig: options?.targetDbConfig,
    mirrorDbs: options?.mirrorDbs,
    mirrorDbConfigs: options?.mirrorDbConfigs,
    scopedComplexOnly: options?.scopedComplexOnly,
  });
  await deleteBroadcastMessage(existing.id, options).catch(() =>
    deactivateBroadcastMessage(existing.id, options).catch(() => {})
  );
  return created;
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
  ensureBroadcastOfflineSyncListeners();

  const role = session.account.role;
  const complexId = session.account.complexId || '';
  const accountKey = session.account.id || session.account.uid || role;
  const sessionDb = session.authConfig ? getFirestoreForConfig(session.authConfig) : primaryDb;
  const hasExternalDb = Boolean(sessionDb && sessionDb !== primaryDb);

  let primaryList: BroadcastMessageRecord[] = [];
  let externalList: BroadcastMessageRecord[] = [];
  let cachedList: BroadcastMessageRecord[] = loadCachedRecipientBroadcasts(accountKey);
  let dueTimerId: number | null = null;
  let onlineRetryTimerId: number | null = null;
  let unsubPrimary: (() => void) | null = null;
  let unsubExternal: (() => void) | null = null;
  let primaryListenerErrored = false;
  let externalListenerErrored = false;
  let disposed = false;

  const scheduleNextDueTrigger = (merged: BroadcastMessageRecord[], nowMs: number) => {
    if (dueTimerId !== null) {
      window.clearTimeout(dueTimerId);
      dueTimerId = null;
    }
    if (disposed) return;

    const upcomingTimes = merged
      .filter(
        (item) =>
          matchesRecipientScope(item, { role, complexId }) &&
          item.createdAtMs > nowMs
      )
      .map((item) => item.createdAtMs);

    if (upcomingTimes.length === 0) return;
    const earliestMs = Math.min(...upcomingTimes);
    const delayMs = Math.max(250, Math.min(earliestMs - nowMs + 250, 2147483647));
    dueTimerId = window.setTimeout(() => {
      if (!disposed) {
        emitCombined();
      }
    }, delayMs);
  };

  const emitCombined = () => {
    if (disposed) return;
    const nowMs = Date.now();
    // Once live snapshots arrive, prefer live data while preserving due/scheduled items during offline fallback
    const hasLiveSnapshot = primaryList.length > 0 || externalList.length > 0;
    const merged = hasLiveSnapshot
      ? mergeBroadcastSources(primaryList, externalList)
      : mergeBroadcastSources(primaryList, externalList, cachedList);
    if (hasLiveSnapshot) {
      saveCachedRecipientBroadcasts(accountKey, merged);
      cachedList = merged;
    }
    const filtered = filterBroadcastsForRecipient(merged, { role, complexId }, nowMs);
    onMessagesChange(filtered);
    scheduleNextDueTrigger(merged, nowMs);
  };

  const qPrimary = query(collection(primaryDb, 'broadcasts'), where('active', '==', true));
  const qExternal = hasExternalDb
    ? query(collection(sessionDb, 'broadcasts'), where('active', '==', true))
    : null;

  const attachPrimaryListener = () => {
    if (unsubPrimary) {
      unsubPrimary();
      unsubPrimary = null;
    }
    primaryListenerErrored = false;
    unsubPrimary = onSnapshot(
      qPrimary,
      (snap) => {
        primaryList = snap.docs.map((d) =>
          normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
        );
        emitCombined();
      },
      () => {
        primaryListenerErrored = true;
      }
    );
  };

  const attachExternalListener = () => {
    if (!qExternal) return;
    if (unsubExternal) {
      unsubExternal();
      unsubExternal = null;
    }
    externalListenerErrored = false;
    unsubExternal = onSnapshot(
      qExternal,
      (snap) => {
        externalList = snap.docs.map((d) =>
          normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
        );
        emitCombined();
      },
      () => {
        externalListenerErrored = true;
      }
    );
  };

  const refreshFromServer = async () => {
    if (disposed) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      emitCombined();
      return;
    }
    try {
      const snap = await getDocsFromServer(qPrimary);
      if (!disposed) {
        primaryList = snap.docs.map((d) =>
          normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
        );
      }
    } catch {
      // Offline or blocked
    }
    if (qExternal) {
      try {
        const snap = await getDocsFromServer(qExternal);
        if (!disposed) {
          externalList = snap.docs.map((d) =>
            normalizeBroadcastDoc(d.id, d.data() as Record<string, unknown>)
          );
        }
      } catch {
        // Offline or external DB without broadcasts rule
      }
    }
    emitCombined();
  };

  // Emit cached scheduled/unread items immediately in case app opens offline
  if (cachedList.length > 0) {
    emitCombined();
  }

  attachPrimaryListener();
  attachExternalListener();

  const handleReconnect = () => {
    if (disposed) return;
    if (primaryListenerErrored) attachPrimaryListener();
    if (externalListenerErrored) attachExternalListener();
    void flushPendingBroadcastOutbox();
    void refreshFromServer();
    if (onlineRetryTimerId !== null) {
      window.clearTimeout(onlineRetryTimerId);
    }
    onlineRetryTimerId = window.setTimeout(() => {
      if (!disposed) {
        if (primaryListenerErrored) attachPrimaryListener();
        if (externalListenerErrored) attachExternalListener();
        void flushPendingBroadcastOutbox();
        void refreshFromServer();
      }
    }, 2500);
  };

  const handleVisibilityOrFocus = () => {
    if (disposed) return;
    if (document.visibilityState === 'visible') {
      emitCombined();
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        if (primaryListenerErrored) attachPrimaryListener();
        if (externalListenerErrored) attachExternalListener();
        void refreshFromServer();
      }
    }
  };

  window.addEventListener('online', handleReconnect);
  window.addEventListener('focus', handleVisibilityOrFocus);
  document.addEventListener('visibilitychange', handleVisibilityOrFocus);

  return () => {
    disposed = true;
    if (dueTimerId !== null) {
      window.clearTimeout(dueTimerId);
      dueTimerId = null;
    }
    if (onlineRetryTimerId !== null) {
      window.clearTimeout(onlineRetryTimerId);
      onlineRetryTimerId = null;
    }
    window.removeEventListener('online', handleReconnect);
    window.removeEventListener('focus', handleVisibilityOrFocus);
    document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    if (unsubPrimary) unsubPrimary();
    if (unsubExternal) unsubExternal();
  };
}
