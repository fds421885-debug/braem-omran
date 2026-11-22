import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDocFromServer,
  initializeFirestore,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import { auth as primaryAuth, db as primaryDb } from '../firebase';
import type { ExternalFirebaseConfig } from '../types/platform';

const externalAppCache = new Map<string, FirebaseApp>();
const externalAuthCache = new Map<string, Auth>();
const externalDbCache = new Map<string, Firestore>();

export const EXTERNAL_DB_RECOMMENDED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
    match /healthcheck/{docId} {
      allow read, write: if true;
    }
    match /complexes/{id} {
      allow read, write: if true;
    }
    match /mosques/{id} {
      allow read, write: if true;
    }
    match /halaqat/{id} {
      allow read, write: if true;
    }
    match /accounts/{id} {
      allow read, write: if true;
    }
    match /nameIndex/{id} {
      allow read, write: if true;
    }
    match /inviteLinks/{id} {
      allow read, write: if true;
    }
    match /quickLinks/{id} {
      allow read, write: if true;
    }
    match /stats/{id} {
      allow read, write: if true;
    }
    match /books/{id} {
      allow read, write: if true;
    }
    match /bookPages/{id} {
      allow read, write: if true;
    }
    match /attendance/{id} {
      allow read, write: if true;
    }
    match /curricula/{id} {
      allow read, write: if true;
    }
    match /wordAudio/{id} {
      allow read, write: if true;
    }
    match /broadcasts/{id} {
      allow read, write: if true;
    }
    match /studentQuranPlans/{id} {
      allow read, write: if true;
    }
    match /studentMushafMistakes/{id} {
      allow read, write: if true;
    }
  }
}`;

export interface ExternalDbDiagnosticCheck {
  id: 'config' | 'database' | 'rules' | 'auth';
  title: string;
  passed: boolean;
  detail: string;
}

export interface ExternalDbVerificationResult {
  approved: boolean;
  config: ExternalFirebaseConfig | null;
  checks: ExternalDbDiagnosticCheck[];
  needsRulesHelp: boolean;
  summary: string;
}

export function parseFirebaseConfigInput(
  rawInput: string,
  customDatabaseId?: string
): {
  config: ExternalFirebaseConfig | null;
  error?: string;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { config: null, error: 'يرجى لصق كود تهيئة Firebase Config.' };
  }

  // Strip full-line comments and block comments safely without breaking https:// inside quotes
  const withoutComments = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');

  // Prefer the object assigned to firebaseConfig, or find any {...} block containing apiKey + projectId
  let objectBlock: string | null = null;
  const namedMatch = withoutComments.match(
    /(?:firebaseConfig|config)\s*=\s*(\{[\s\S]*?\})/i
  );
  if (namedMatch && namedMatch[1]) {
    objectBlock = namedMatch[1];
  } else {
    const allBraces = withoutComments.match(/\{[^{}]*\}/g) || [];
    const matchedBlock = allBraces.find(
      (blk) => blk.includes('apiKey') && blk.includes('projectId')
    );
    if (matchedBlock) {
      objectBlock = matchedBlock;
    }
  }

  if (!objectBlock) {
    return {
      config: null,
      error:
        'لم يتم العثور على كائن firebaseConfig. ألصق كود التهيئة الكامل من Firebase أو كائن { apiKey, projectId, appId }.',
    };
  }

  // Convert JS object literal syntax to valid JSON
  const normalizedJson = objectBlock
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  try {
    const parsed = JSON.parse(normalizedJson) as Partial<ExternalFirebaseConfig>;
    if (!parsed.apiKey || !parsed.projectId || !parsed.appId) {
      return {
        config: null,
        error: 'الكود ناقص؛ يجب أن يتضمن apiKey و projectId و appId على الأقل.',
      };
    }

    const dbName = (customDatabaseId ?? parsed.firestoreDatabaseId ?? '').trim();
    const normalizedDbId =
      dbName && dbName !== '(default)' && dbName !== 'default' ? dbName : undefined;

    return {
      config: {
        apiKey: String(parsed.apiKey).trim(),
        authDomain: parsed.authDomain
          ? String(parsed.authDomain).trim()
          : `${String(parsed.projectId).trim()}.firebaseapp.com`,
        projectId: String(parsed.projectId).trim(),
        storageBucket: parsed.storageBucket
          ? String(parsed.storageBucket).trim()
          : undefined,
        messagingSenderId: parsed.messagingSenderId
          ? String(parsed.messagingSenderId).trim()
          : undefined,
        appId: String(parsed.appId).trim(),
        measurementId: parsed.measurementId
          ? String(parsed.measurementId).trim()
          : undefined,
        firestoreDatabaseId: normalizedDbId,
      },
    };
  } catch {
    return {
      config: null,
      error:
        'تعذّر تحليل كود Firebase Config. تأكد من نسخ كائن firebaseConfig كاملاً مع الأقواس.',
    };
  }
}

export function getAppForConfig(config: ExternalFirebaseConfig): FirebaseApp {
  const appKey = `${config.projectId}__${config.appId}`;
  let app = externalAppCache.get(appKey);
  if (!app) {
    app = initializeApp(
      {
        apiKey: config.apiKey,
        authDomain: config.authDomain || `${config.projectId}.firebaseapp.com`,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId,
      },
      `ext_${appKey.replace(/[^a-zA-Z0-9_]/g, '_')}`
    );
    externalAppCache.set(appKey, app);
  }
  return app;
}

export function getAuthForConfig(config?: ExternalFirebaseConfig | null): Auth {
  if (!config || !config.projectId || !config.apiKey) {
    return primaryAuth;
  }

  const appKey = `${config.projectId}__${config.appId}`;
  const cachedAuth = externalAuthCache.get(appKey);
  if (cachedAuth) {
    return cachedAuth;
  }

  const app = getAppForConfig(config);
  const extAuth = getAuth(app);
  externalAuthCache.set(appKey, extAuth);
  return extAuth;
}

export function createGoogleAuthProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: 'select_account',
  });
  return provider;
}

export function getFirestoreForConfig(config?: ExternalFirebaseConfig | null): Firestore {
  if (!config || !config.projectId || !config.apiKey) {
    return primaryDb;
  }

  const dbId = config.firestoreDatabaseId || '(default)';
  const cacheKey = `${config.projectId}__${config.appId}__${dbId}`;

  const cachedDb = externalDbCache.get(cacheKey);
  if (cachedDb) {
    return cachedDb;
  }

  const app = getAppForConfig(config);

  const targetDbName =
    config.firestoreDatabaseId && config.firestoreDatabaseId !== '(default)'
      ? config.firestoreDatabaseId
      : undefined;

  const extDb = initializeFirestore(
    app,
    { experimentalAutoDetectLongPolling: true },
    targetDbName
  );

  externalDbCache.set(cacheKey, extDb);
  return extDb;
}

export function buildDbConnectionId(config: ExternalFirebaseConfig): string {
  const safeProject = config.projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeDb = (config.firestoreDatabaseId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `db_${safeProject}_${safeDb}`.slice(0, 120);
}

export function getDbDisplayLabel(config?: ExternalFirebaseConfig | null): string {
  if (!config) return 'القاعدة الأساسية';
  const dbPart = config.firestoreDatabaseId ? ` / ${config.firestoreDatabaseId}` : '';
  return `${config.projectId}${dbPart}`;
}

export async function verifyExternalFirebaseSetup(
  rawInput: string,
  customDatabaseId?: string
): Promise<ExternalDbVerificationResult> {
  const checks: ExternalDbDiagnosticCheck[] = [];

  // 1. Parse Config
  const parsed = parseFirebaseConfigInput(rawInput, customDatabaseId);
  if (!parsed.config) {
    checks.push({
      id: 'config',
      title: 'قراءة كود تهيئة Firebase',
      passed: false,
      detail: parsed.error || 'كود التهيئة غير صالح.',
    });
    return {
      approved: false,
      config: null,
      checks,
      needsRulesHelp: false,
      summary: 'تعذّر التعرف على كود Firebase Config.',
    };
  }

  const config = parsed.config;
  const dbLabel = config.firestoreDatabaseId || '(default)';
  checks.push({
    id: 'config',
    title: 'قراءة كود تهيئة Firebase',
    passed: true,
    detail: `المشروع: ${config.projectId} · القاعدة: ${dbLabel}`,
  });

  // 2. Check Firestore Database existence & API activation directly via Firestore REST API
  let dbEnabled = false;
  let rulesWorking = false;
  let needsRulesHelp = false;

  try {
    const restUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      config.projectId
    )}/databases/${encodeURIComponent(dbLabel)}/documents/healthcheck/ping?key=${encodeURIComponent(
      config.apiKey
    )}`;
    const restRes = await fetch(restUrl);
    const restJson = (await restRes.json().catch(() => ({}))) as {
      name?: string;
      error?: { code?: number; message?: string; status?: string };
    };
    const errMsg = (restJson.error?.message || '').toLowerCase();
    const errStatus = (restJson.error?.status || '').toUpperCase();

    if (restRes.ok) {
      dbEnabled = true;
      checks.push({
        id: 'database',
        title: 'تفعيل قاعدة Firestore والاتصال بها',
        passed: true,
        detail: `قاعدة "${dbLabel}" مفعّلة وتستجيب بنجاح.`,
      });
    } else if (
      errStatus === 'PERMISSION_DENIED' &&
      !errMsg.includes('has not been used') &&
      !errMsg.includes('is disabled') &&
      !errMsg.includes('not enabled')
    ) {
      // PERMISSION_DENIED on a valid collection means the database EXISTS and responded!
      dbEnabled = true;
      checks.push({
        id: 'database',
        title: 'تفعيل قاعدة Firestore والاتصال بها',
        passed: true,
        detail: `قاعدة "${dbLabel}" مفعّلة وتستجيب، وسيتم التحقق من القواعد في الخطوة التالية.`,
      });
    } else if (
      errStatus === 'NOT_FOUND' &&
      errMsg.includes('document') &&
      !errMsg.includes('database')
    ) {
      // Document not found (empty healthcheck doc) proves DB exists and reads are open!
      dbEnabled = true;
      checks.push({
        id: 'database',
        title: 'تفعيل قاعدة Firestore والاتصال بها',
        passed: true,
        detail: `قاعدة "${dbLabel}" مفعّلة وتستجيب بنجاح.`,
      });
    } else if (
      errMsg.includes('database') &&
      (errMsg.includes('does not exist') || errMsg.includes('not found'))
    ) {
      dbEnabled = false;
      checks.push({
        id: 'database',
        title: 'تفعيل قاعدة Firestore والاتصال بها',
        passed: false,
        detail: `قاعدة "${dbLabel}" غير منشأة في مشروع ${config.projectId}، أو اسم القاعدة غير مطابق.`,
      });
    } else if (
      errMsg.includes('has not been used') ||
      errMsg.includes('disabled') ||
      errMsg.includes('not enabled')
    ) {
      dbEnabled = false;
      checks.push({
        id: 'database',
        title: 'تفعيل قاعدة Firestore والاتصال بها',
        passed: false,
        detail: `خدمة Cloud Firestore API غير مفعّلة في مشروع ${config.projectId}.`,
      });
    } else {
      dbEnabled = false;
      checks.push({
        id: 'database',
        title: 'تفعيل قاعدة Firestore والاتصال بها',
        passed: false,
        detail: `تعذّر الوصول لقاعدة "${dbLabel}": ${restJson.error?.message || `HTTP ${restRes.status}`}`,
      });
    }
  } catch {
    dbEnabled = false;
    checks.push({
      id: 'database',
      title: 'تفعيل قاعدة Firestore والاتصال بها',
      passed: false,
      detail: `تعذّر الاتصال بخدمة Firestore لقاعدة "${dbLabel}"، تأكد من توفر الإنترنت.`,
    });
  }

  // 3. Check Firestore Rules via isolated probe app (Real Write + Read + Delete on non-reserved 'healthcheck' collection)
  if (!dbEnabled) {
    checks.push({
      id: 'rules',
      title: 'فحص صلاحيات القواعد (Rules)',
      passed: false,
      detail: 'بانتظار التأكد من تفعيل قاعدة Firestore أولاً.',
    });
  } else {
    const probeAppName = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const probeApp = initializeApp(
      {
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId,
      },
      probeAppName
    );
    const probeDb = initializeFirestore(
      probeApp,
      { experimentalAutoDetectLongPolling: true },
      config.firestoreDatabaseId && config.firestoreDatabaseId !== '(default)'
        ? config.firestoreDatabaseId
        : undefined
    );

    try {
      const writeProbeRef = doc(probeDb, 'healthcheck', `probe_${Date.now()}`);
      await setDoc(writeProbeRef, {
        ok: true,
        ts: serverTimestamp(),
      });
      await getDocFromServer(writeProbeRef);
      await deleteDoc(writeProbeRef).catch(() => {});
      rulesWorking = true;
      checks.push({
        id: 'rules',
        title: 'فحص صلاحيات القواعد (Rules)',
        passed: true,
        detail: 'صلاحيات القراءة والكتابة في Rules تعمل ١٠٠٪.',
      });
    } catch (ruleErr: unknown) {
      const errCode = ((ruleErr as { code?: string })?.code || '').toLowerCase();
      const msg =
        ruleErr instanceof Error ? ruleErr.message.toLowerCase() : String(ruleErr).toLowerCase();
      const isPermErr =
        errCode.includes('permission') ||
        msg.includes('permission') ||
        msg.includes('insufficient');
      needsRulesHelp = isPermErr;
      checks.push({
        id: 'rules',
        title: 'فحص صلاحيات القواعد (Rules)',
        passed: false,
        detail: isPermErr
          ? 'قواعد Firestore (Rules) تمنع القراءة أو الكتابة حالياً. انسخ القواعد الموصى بها وانشرها في Firebase ثم أعد الفحص.'
          : `تعذّر اختبار الكتابة في القاعدة (${errCode || 'خطأ اتصال'}): ${
              ruleErr instanceof Error ? ruleErr.message : String(ruleErr)
            }`,
      });
    } finally {
      await deleteApp(probeApp).catch(() => {});
    }
  }

  // 4. Check Firebase Auth + Google Sign-In Configuration via Identity Toolkit API
  try {
    const authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${encodeURIComponent(
        config.apiKey
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'probe@gmail.com',
          continueUri: window.location.origin,
          providerId: 'google.com',
        }),
      }
    );
    const authData = (await authRes.json()) as {
      authUri?: string;
      error?: { message?: string };
    };

    if (authRes.ok && authData.authUri) {
      checks.push({
        id: 'auth',
        title: 'إعدادات تسجيل الدخول (Google Auth)',
        passed: true,
        detail: 'مصادقة جوجل مفعّلة والنطاق مصرح به للعمل.',
      });
    } else {
      const errCode = (authData?.error?.message || '').toUpperCase();
      let detail = 'تأكد من تفعيل Authentication وإضافة موفّر Google في Firebase Console.';
      if (errCode.includes('CONFIGURATION_NOT_FOUND')) {
        detail = 'خدمة Authentication غير مفعّلة بعد في هذا المشروع.';
      } else if (errCode.includes('OPERATION_NOT_ALLOWED') || errCode.includes('INVALID_PROVIDER')) {
        detail = 'تسجيل الدخول بحساب Google غير مفعّل في Sign-in method.';
      } else if (errCode.includes('UNAUTHORIZED_DOMAIN')) {
        detail = `أضف النطاق (${window.location.hostname}) إلى Authorized domains في Authentication.`;
      } else if (errCode.includes('API_KEY_INVALID')) {
        detail = 'مفتاح apiKey غير صالح.';
      }
      checks.push({
        id: 'auth',
        title: 'إعدادات تسجيل الدخول (Google Auth)',
        passed: false,
        detail,
      });
    }
  } catch {
    checks.push({
      id: 'auth',
      title: 'إعدادات تسجيل الدخول (Google Auth)',
      passed: false,
      detail: 'تعذّر الاتصال بخدمة التحقق من إعدادات تسجيل الدخول.',
    });
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    approved: allPassed && dbEnabled && rulesWorking,
    config,
    checks,
    needsRulesHelp,
    summary: allPassed
      ? 'تمت الموافقة: قاعدة البيانات مفعّلة وشغالة ١٠٠٪ ومهيأة بالكامل للربط!'
      : 'توجد إعدادات ناقصة في المشروع الخارجي؛ يرجى استكمالها ثم إعادة الفحص للموافقة.',
  };
}

export function normalizeArabicSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function validateQuadrupleArabicName(rawName: string): {
  valid: boolean;
  normalized: string;
  wordCount: number;
  error?: string;
} {
  const normalized = normalizeArabicSpaces(rawName);
  const words = normalized ? normalized.split(' ') : [];

  if (normalized.length < 3) {
    return {
      valid: false,
      normalized,
      wordCount: words.length,
      error: 'يرجى كتابة الاسم الرباعي كاملاً.',
    };
  }

  if (normalized.length > 100) {
    return {
      valid: false,
      normalized: normalized.slice(0, 100),
      wordCount: words.length,
      error: 'الاسم الرباعي طويل جداً (الحد الأقصى ١٠٠ حرف).',
    };
  }

  if (words.length < 4) {
    return {
      valid: false,
      normalized,
      wordCount: words.length,
      error: `مرفوض: يجب كتابة الاسم الرباعي من ٤ مقاطع على الأقل (تم إدخال ${words.length} من ٤).`,
    };
  }

  return {
    valid: true,
    normalized,
    wordCount: words.length,
  };
}

export async function hashQuadrupleName(rawName: string): Promise<string> {
  const canonical = normalizeArabicSpaces(rawName)
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();

  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateValidId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${hex}`;
}

export function generateToken(length = 24): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

export function getTodayDateKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getReciterAyahAudioUrl(
  everyAyahFolder: string,
  surahNumber: number,
  ayahNumber: number
): string {
  const s = String(Math.max(1, Math.min(114, Math.floor(surahNumber)))).padStart(3, '0');
  const a = String(Math.max(1, Math.min(286, Math.floor(ayahNumber)))).padStart(3, '0');
  return `https://everyayah.com/data/${everyAyahFolder}/${s}${a}.mp3`;
}

export function normalizeArabicText(value: string): string {
  return value
    .trim()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
