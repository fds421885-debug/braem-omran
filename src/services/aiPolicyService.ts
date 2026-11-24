import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db as primaryDb } from '../firebase';
import { getDocFresh } from './platformService';
import type {
  AccountAiPolicy,
  AiComplexSubscriptionTier,
  AiDiagnosticErrorEntry,
  AiDiagnosticsReport,
  AiFeaturePermissions,
  AiModelProbeResult,
  AiPolicyConfigStore,
  AiServerKeySlotId,
  ComplexAiPolicy,
} from '../types/platform';

const AI_POLICY_COMPLEXES_DOC_ID = 'ai_policy_complexes_v1';
const AI_POLICY_ACCOUNTS_DOC_ID = 'ai_policy_accounts_v1';
const CACHE_TTL_MS = 25_000;

export const AI_SERVER_SLOT_LABELS: Record<AiServerKeySlotId, string> = {
  default: 'المسار الافتراضي للخادم (GEMINI_API_KEY)',
  slot_1: 'مفتاح الخادم 1 (GEMINI_API_KEY_1)',
  slot_2: 'مفتاح الخادم 2 (GEMINI_API_KEY_2)',
  slot_3: 'مفتاح الخادم 3 (GEMINI_API_KEY_3)',
  slot_4: 'مفتاح الخادم 4 (GEMINI_API_KEY_4)',
  slot_5: 'مفتاح الخادم 5 (GEMINI_API_KEY_5)',
};

export const AI_TIER_LABELS: Record<AiComplexSubscriptionTier, string> = {
  subscribed: 'مشترك (مفعّل)',
  trial: 'تجريبي / محدود',
  disabled: 'غير مشترك / موقوف',
};

export const DEFAULT_AI_FEATURES: AiFeaturePermissions = {
  ocr: true,
  tahajji: true,
  tts: true,
  presentations: true,
};

let activeSessionContext: { complexId?: string; accountId?: string } | null = null;
let cachedPolicyStore: AiPolicyConfigStore | null = null;
let cachedAtMs = 0;

export function setActiveAiSessionContext(
  ctx: { complexId?: string; accountId?: string } | null
): void {
  activeSessionContext = ctx;
}

export function getActiveAiSessionContext(): { complexId?: string; accountId?: string } | null {
  return activeSessionContext;
}

function createEmptyStore(): AiPolicyConfigStore {
  return {
    complexes: {},
    accounts: {},
    updatedAtMs: Date.now(),
  };
}

function sanitizeSlotId(val: unknown): AiServerKeySlotId {
  if (
    val === 'slot_1' ||
    val === 'slot_2' ||
    val === 'slot_3' ||
    val === 'slot_4' ||
    val === 'slot_5'
  ) {
    return val;
  }
  return 'default';
}

function normalizeComplexPolicy(complexId: string, raw: Partial<ComplexAiPolicy>): ComplexAiPolicy {
  const tier: AiComplexSubscriptionTier =
    raw.tier === 'disabled' || raw.tier === 'trial' ? raw.tier : 'subscribed';
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : tier !== 'disabled';
  return {
    complexId,
    enabled,
    tier,
    serverKeySlot: sanitizeSlotId(raw.serverKeySlot),
    dailyLimit: Math.max(0, Math.round(Number(raw.dailyLimit) || 0)),
    features: {
      ocr: raw.features?.ocr !== false,
      tahajji: raw.features?.tahajji !== false,
      tts: raw.features?.tts !== false,
      presentations: raw.features?.presentations !== false,
    },
    note: String(raw.note || '').trim().slice(0, 160),
    updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
  };
}

function normalizeAccountPolicy(accountId: string, raw: Partial<AccountAiPolicy>): AccountAiPolicy {
  const mode =
    raw.mode === 'enabled' || raw.mode === 'disabled' ? raw.mode : 'inherit';
  const serverKeySlot: 'inherit' | AiServerKeySlotId =
    raw.serverKeySlot && raw.serverKeySlot !== 'inherit'
      ? sanitizeSlotId(raw.serverKeySlot)
      : 'inherit';
  return {
    accountId,
    mode,
    serverKeySlot,
    tierLabel: String(raw.tierLabel || '').trim().slice(0, 60),
    note: String(raw.note || '').trim().slice(0, 160),
    updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
  };
}

export async function loadAiPolicyStore(forceFresh = false): Promise<AiPolicyConfigStore> {
  if (!forceFresh && cachedPolicyStore && Date.now() - cachedAtMs < CACHE_TTL_MS) {
    return cachedPolicyStore;
  }

  const store = createEmptyStore();
  try {
    const [cSnap, aSnap] = await Promise.all([
      getDocFresh(doc(primaryDb, 'dbRegistry', AI_POLICY_COMPLEXES_DOC_ID)).catch(() => null),
      getDocFresh(doc(primaryDb, 'dbRegistry', AI_POLICY_ACCOUNTS_DOC_ID)).catch(() => null),
    ]);

    if (cSnap?.exists()) {
      const jsonStr = String((cSnap.data() as { mosqueConfigsJson?: string })?.mosqueConfigsJson || '');
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr) as { complexes?: Record<string, Partial<ComplexAiPolicy>> };
        if (parsed.complexes && typeof parsed.complexes === 'object') {
          for (const [cid, item] of Object.entries(parsed.complexes)) {
            if (item) {
              store.complexes[cid] = normalizeComplexPolicy(cid, item);
            }
          }
        }
      }
    }

    if (aSnap?.exists()) {
      const jsonStr = String((aSnap.data() as { mosqueConfigsJson?: string })?.mosqueConfigsJson || '');
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr) as { accounts?: Record<string, Partial<AccountAiPolicy>> };
        if (parsed.accounts && typeof parsed.accounts === 'object') {
          for (const [aid, item] of Object.entries(parsed.accounts)) {
            if (item) {
              store.accounts[aid] = normalizeAccountPolicy(aid, item);
            }
          }
        }
      }
    }
  } catch {
    // Graceful fallback to open default policies
  }

  cachedPolicyStore = store;
  cachedAtMs = Date.now();
  return store;
}

async function writePolicyRegistryDoc(
  docId: string,
  title: string,
  payloadJson: string
): Promise<void> {
  if (payloadJson.length > 31500) {
    throw new Error('تجاوزت إعدادات سياسات الذكاء الاصطناعي الحد الأقصى للحجم المسموح (31KB).');
  }
  const ref = doc(primaryDb, 'dbRegistry', docId);
  const existing = await getDocFresh(ref).catch(() => null);
  if (existing?.exists()) {
    await updateDoc(ref, {
      name: title.slice(0, 120),
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: payloadJson,
      active: false,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(ref, {
      id: docId,
      name: title.slice(0, 120),
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: payloadJson,
      active: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}

export async function saveComplexAiPolicy(
  policy: ComplexAiPolicy
): Promise<AiPolicyConfigStore> {
  const current = await loadAiPolicyStore(true);
  const nextComplexes = {
    ...current.complexes,
    [policy.complexId]: normalizeComplexPolicy(policy.complexId, {
      ...policy,
      updatedAtMs: Date.now(),
    }),
  };
  await writePolicyRegistryDoc(
    AI_POLICY_COMPLEXES_DOC_ID,
    'سياسات الذكاء الاصطناعي للمجمعات',
    JSON.stringify({ complexes: nextComplexes })
  );
  const nextStore: AiPolicyConfigStore = {
    complexes: nextComplexes,
    accounts: current.accounts,
    updatedAtMs: Date.now(),
  };
  cachedPolicyStore = nextStore;
  cachedAtMs = Date.now();
  return nextStore;
}

export async function deleteComplexAiPolicy(complexId: string): Promise<AiPolicyConfigStore> {
  const current = await loadAiPolicyStore(true);
  const nextComplexes = { ...current.complexes };
  delete nextComplexes[complexId];
  if (Object.keys(nextComplexes).length === 0) {
    await deleteDoc(doc(primaryDb, 'dbRegistry', AI_POLICY_COMPLEXES_DOC_ID)).catch(() => {});
  } else {
    await writePolicyRegistryDoc(
      AI_POLICY_COMPLEXES_DOC_ID,
      'سياسات الذكاء الاصطناعي للمجمعات',
      JSON.stringify({ complexes: nextComplexes })
    );
  }
  const nextStore: AiPolicyConfigStore = {
    complexes: nextComplexes,
    accounts: current.accounts,
    updatedAtMs: Date.now(),
  };
  cachedPolicyStore = nextStore;
  cachedAtMs = Date.now();
  return nextStore;
}

export async function saveAccountAiPolicy(
  policy: AccountAiPolicy
): Promise<AiPolicyConfigStore> {
  const current = await loadAiPolicyStore(true);
  const nextAccounts = { ...current.accounts };
  if (policy.mode === 'inherit' && policy.serverKeySlot === 'inherit' && !policy.note.trim()) {
    delete nextAccounts[policy.accountId];
  } else {
    nextAccounts[policy.accountId] = normalizeAccountPolicy(policy.accountId, {
      ...policy,
      updatedAtMs: Date.now(),
    });
  }

  if (Object.keys(nextAccounts).length === 0) {
    await deleteDoc(doc(primaryDb, 'dbRegistry', AI_POLICY_ACCOUNTS_DOC_ID)).catch(() => {});
  } else {
    await writePolicyRegistryDoc(
      AI_POLICY_ACCOUNTS_DOC_ID,
      'سياسات الذكاء الاصطناعي للحسابات',
      JSON.stringify({ accounts: nextAccounts })
    );
  }

  const nextStore: AiPolicyConfigStore = {
    complexes: current.complexes,
    accounts: nextAccounts,
    updatedAtMs: Date.now(),
  };
  cachedPolicyStore = nextStore;
  cachedAtMs = Date.now();
  return nextStore;
}

export async function resolveEffectiveAiAccess(params?: {
  complexId?: string;
  accountId?: string;
  feature?: keyof AiFeaturePermissions;
}): Promise<{
  allowed: boolean;
  slotId: AiServerKeySlotId;
  complexId?: string;
  accountId?: string;
  reason?: string;
}> {
  const complexId = params?.complexId || activeSessionContext?.complexId || '';
  const accountId = params?.accountId || activeSessionContext?.accountId || '';
  const store = await loadAiPolicyStore(false);

  const complexPolicy = complexId ? store.complexes[complexId] : undefined;
  const accountPolicy = accountId ? store.accounts[accountId] : undefined;

  let slotId: AiServerKeySlotId = complexPolicy?.serverKeySlot || 'default';
  if (accountPolicy && accountPolicy.serverKeySlot !== 'inherit') {
    slotId = accountPolicy.serverKeySlot;
  }

  if (accountPolicy?.mode === 'disabled') {
    return {
      allowed: false,
      slotId,
      complexId,
      accountId,
      reason: 'تم إيقاف صلاحية الذكاء الاصطناعي لهذا الحساب من قِبل مشرف المنصة.',
    };
  }

  if (accountPolicy?.mode === 'enabled') {
    return {
      allowed: true,
      slotId,
      complexId,
      accountId,
    };
  }

  if (complexPolicy) {
    if (!complexPolicy.enabled || complexPolicy.tier === 'disabled') {
      return {
        allowed: false,
        slotId,
        complexId,
        accountId,
        reason: 'ميزة الذكاء الاصطناعي غير مفعّلة لهذا المجمع حالياً (غير مشترك) — تواصل مع إدارة المنصة.',
      };
    }
    if (params?.feature && complexPolicy.features[params.feature] === false) {
      return {
        allowed: false,
        slotId,
        complexId,
        accountId,
        reason: 'هذه الأداة من الذكاء الاصطناعي غير مشمولة في باقة المجمع الحالية.',
      };
    }
  }

  return {
    allowed: true,
    slotId,
    complexId,
    accountId,
  };
}

export async function fetchServerAiDiagnostics(): Promise<AiDiagnosticsReport> {
  const res = await fetch('/api/admin/ai-diagnostics', { cache: 'no-store' });
  const data = (await res.json().catch(() => null)) as AiDiagnosticsReport | null;
  if (!res.ok || !data) {
    throw new Error('تعذّر جلب حالة محرك الذكاء الاصطناعي من الخادم.');
  }
  return data;
}

export async function clearServerAiErrorLogs(): Promise<void> {
  await fetch('/api/admin/ai-diagnostics/logs', { method: 'DELETE' });
}

export async function runServerAiConnectivityTest(slotId: AiServerKeySlotId): Promise<{
  ok: boolean;
  slotId: AiServerKeySlotId;
  runtime: string;
  results: AiModelProbeResult[];
  error?: string;
  checkedAtMs: number;
}> {
  const res = await fetch('/api/admin/ai-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiSlotId: slotId }),
  });
  const data = (await res.json().catch(() => null)) as {
    ok: boolean;
    slotId: AiServerKeySlotId;
    runtime: string;
    results: AiModelProbeResult[];
    error?: string;
    checkedAtMs: number;
  } | null;
  if (!data) {
    throw new Error('تعذّر إجراء فحص الاتصال بنماذج الذكاء الاصطناعي.');
  }
  return data;
}

export function extractAiDiagnosticFromPayload(data: unknown): AiDiagnosticErrorEntry | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const diag = (data as { diagnostic?: AiDiagnosticErrorEntry }).diagnostic;
  if (!diag || typeof diag !== 'object') return undefined;
  return diag;
}
