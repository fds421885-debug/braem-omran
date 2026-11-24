import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import primaryFirestoreRulesRaw from '../../firestore.rules?raw';
import primaryFirebaseConfig from '../../firebase-applet-config.json';
import { auth as primaryAuth, db as primaryDb } from '../firebase';
import { ADMIN_QUADRUPLE_NAME } from '../types/platform';
import { EXTERNAL_DB_RECOMMENDED_RULES, getDbDisplayLabel, getFirestoreForConfig } from './multiDb';
import { getAllKnownDatabases, type ResolvedDbTarget } from './platformService';

export interface DatabaseRulesCheckIssue {
  key: string;
  title: string;
  detail: string;
  ruleSnippet?: string;
}

export interface DatabaseRulesAuditResult {
  dbKey: string;
  dbLabel: string;
  isPrimary: boolean;
  projectId: string;
  firestoreDatabaseId: string;
  consoleRulesUrl: string;
  status: 'ok' | 'needs_rules_update' | 'unreachable';
  issues: DatabaseRulesCheckIssue[];
  recommendedRules: string;
  checkedAtMs: number;
}

export interface PlatformRulesAuditReport {
  allHealthy: boolean;
  totalDatabases: number;
  healthyCount: number;
  unhealthyDatabases: DatabaseRulesAuditResult[];
  allResults: DatabaseRulesAuditResult[];
  checkedAtMs: number;
}

export interface RulesAuditOptions {
  waitForPropagation?: boolean;
}

interface PrimaryCollectionProbe {
  col: string;
  label: string;
  mode: 'list_unfiltered' | 'list_active_true' | 'get_global_doc';
}

const PRIMARY_READ_CHECK_COLLECTIONS: PrimaryCollectionProbe[] = [
  { col: 'complexes', label: 'المجمعات (complexes)', mode: 'list_active_true' },
  { col: 'mosques', label: 'المساجد (mosques)', mode: 'list_active_true' },
  { col: 'halaqat', label: 'الحلقات (halaqat)', mode: 'list_active_true' },
  { col: 'accounts', label: 'الحسابات (accounts)', mode: 'list_unfiltered' },
  { col: 'inviteLinks', label: 'روابط التسجيل (inviteLinks)', mode: 'list_unfiltered' },
  { col: 'quickLinks', label: 'روابط الدخول السريع (quickLinks)', mode: 'list_unfiltered' },
  { col: 'books', label: 'الكتب والملفات (books)', mode: 'list_unfiltered' },
  { col: 'bookPages', label: 'صفحات الكتب (bookPages)', mode: 'list_unfiltered' },
  { col: 'wordAudio', label: 'صوتيات القراءة والتهجي (wordAudio)', mode: 'list_unfiltered' },
  { col: 'attendance', label: 'الحضور والغياب (attendance)', mode: 'list_unfiltered' },
  { col: 'curricula', label: 'المقررات (curricula)', mode: 'list_unfiltered' },
  { col: 'studentQuranPlans', label: 'خطط حفظ ومراجعة الطلاب (studentQuranPlans)', mode: 'list_unfiltered' },
  { col: 'studentMushafMistakes', label: 'أخطاء تلاوة الطلاب بالمصحف (studentMushafMistakes)', mode: 'list_unfiltered' },
  { col: 'studentBookPlans', label: 'متابعة وواجبات الكتب (studentBookPlans)', mode: 'list_unfiltered' },
  { col: 'presentations', label: 'العروض التقديمية (presentations)', mode: 'list_unfiltered' },
  { col: 'broadcasts', label: 'الإشعارات والرسائل الفورية (broadcasts)', mode: 'list_unfiltered' },
  { col: 'dbRegistry', label: 'سجل ربط القواعد (dbRegistry)', mode: 'list_active_true' },
  { col: 'stats', label: 'الإحصائيات (stats)', mode: 'get_global_doc' },
];

const EXTERNAL_ALL_COLLECTIONS: { col: string; label: string }[] = [
  { col: 'healthcheck', label: 'فحص الاتصال (healthcheck)' },
  { col: 'complexes', label: 'المجمعات (complexes)' },
  { col: 'mosques', label: 'المساجد (mosques)' },
  { col: 'halaqat', label: 'الحلقات (halaqat)' },
  { col: 'accounts', label: 'الحسابات (accounts)' },
  { col: 'nameIndex', label: 'فهرس الأسماء (nameIndex)' },
  { col: 'inviteLinks', label: 'روابط التسجيل (inviteLinks)' },
  { col: 'quickLinks', label: 'روابط الدخول السريع (quickLinks)' },
  { col: 'stats', label: 'الإحصائيات (stats)' },
  { col: 'books', label: 'الكتب والملفات (books)' },
  { col: 'bookPages', label: 'صفحات الكتب (bookPages)' },
  { col: 'attendance', label: 'الحضور والغياب (attendance)' },
  { col: 'curricula', label: 'المقررات (curricula)' },
  { col: 'studentQuranPlans', label: 'خطط حفظ ومراجعة الطلاب (studentQuranPlans)' },
  { col: 'studentMushafMistakes', label: 'أخطاء تلاوة الطلاب بالمصحف (studentMushafMistakes)' },
  { col: 'studentBookPlans', label: 'متابعة وواجبات الكتب (studentBookPlans)' },
  { col: 'presentations', label: 'العروض التقديمية (presentations)' },
  { col: 'wordAudio', label: 'صوتيات القراءة والتهجي (wordAudio)' },
  { col: 'broadcasts', label: 'الإشعارات والرسائل الفورية (broadcasts)' },
];

export function buildFirebaseConsoleRulesUrl(
  projectId: string,
  firestoreDatabaseId?: string
): string {
  const dbSegment =
    firestoreDatabaseId && firestoreDatabaseId !== '(default)'
      ? encodeURIComponent(firestoreDatabaseId)
      : '-default-';
  return `https://console.firebase.google.com/project/${encodeURIComponent(
    projectId
  )}/firestore/databases/${dbSegment}/rules`;
}

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code || '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    code.includes('permission') ||
    msg.includes('permission-denied') ||
    msg.includes('missing or insufficient permissions')
  );
}

function isNetworkOrUnavailableError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code || '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    code.includes('unavailable') ||
    code.includes('offline') ||
    msg.includes('offline') ||
    msg.includes('network') ||
    msg.includes('failed to fetch')
  );
}

function createProbeSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ensurePrimaryAdminMarker(): Promise<void> {
  const authUser = primaryAuth.currentUser;
  if (!authUser || !authUser.emailVerified) return;
  try {
    const adminRef = doc(primaryDb, 'admins', authUser.uid);
    const snap = await getDocFromServer(adminRef);
    if (!snap.exists()) {
      await setDoc(adminRef, {
        uid: authUser.uid,
        quadrupleName: ADMIN_QUADRUPLE_NAME,
        email: (authUser.email || 'admin@braem-omran.app').trim().slice(0, 160),
        createdAt: serverTimestamp(),
      });
    }
  } catch {
    // Non-fatal; if blocked, probes below will detect permission state
  }
}

async function probePrimaryCollectionRead(
  item: PrimaryCollectionProbe
): Promise<'ok' | 'permission_denied' | 'network_error'> {
  try {
    if (item.mode === 'get_global_doc') {
      await getDocFromServer(doc(primaryDb, item.col, 'global'));
      return 'ok';
    }
    const q =
      item.mode === 'list_active_true'
        ? query(collection(primaryDb, item.col), where('active', '==', true), limit(1))
        : query(collection(primaryDb, item.col), limit(1));
    await getDocsFromServer(q);
    return 'ok';
  } catch (err) {
    if (isPermissionDeniedError(err)) return 'permission_denied';
    if (isNetworkOrUnavailableError(err)) return 'network_error';
    return 'network_error';
  }
}

async function probeExternalCollectionReadRest(
  projectId: string,
  dbSegment: string,
  apiKey: string,
  colName: string,
  confForSdkFallback?: ResolvedDbTarget['config']
): Promise<'ok' | 'permission_denied' | 'network_error'> {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/databases/${encodeURIComponent(dbSegment)}/documents/${encodeURIComponent(
      colName
    )}?pageSize=1&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) return 'ok';
    if (res.status === 403) {
      // Secondary live check via Firestore SDK to rule out any intermediary HTTP proxy staleness
      if (confForSdkFallback) {
        try {
          const extDb = getFirestoreForConfig(confForSdkFallback);
          await Promise.race([
            getDocsFromServer(query(collection(extDb, colName), limit(1))),
            new Promise<never>((_, reject) =>
              window.setTimeout(() => reject(new Error('timeout')), 4000)
            ),
          ]);
          return 'ok';
        } catch (sdkErr) {
          if (isPermissionDeniedError(sdkErr)) return 'permission_denied';
        }
      }
      return 'permission_denied';
    }
    return 'network_error';
  } catch {
    return 'network_error';
  }
}

async function probeExternalWriteAndDeleteRest(
  projectId: string,
  dbSegment: string,
  apiKey: string,
  colName: string,
  docId: string
): Promise<'ok' | 'permission_denied' | 'network_error'> {
  const createUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/${encodeURIComponent(dbSegment)}/documents/${encodeURIComponent(
    colName
  )}?documentId=${encodeURIComponent(docId)}&key=${encodeURIComponent(apiKey)}`;

  const deleteUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/${encodeURIComponent(dbSegment)}/documents/${encodeURIComponent(
    colName
  )}/${encodeURIComponent(docId)}?key=${encodeURIComponent(apiKey)}`;

  let created = false;
  try {
    const res = await fetch(createUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          id: { stringValue: docId },
          active: { booleanValue: false },
          ok: { booleanValue: true },
        },
      }),
    });
    if (res.status === 403) return 'permission_denied';
    if (!res.ok) return 'network_error';
    created = true;

    const delRes = await fetch(deleteUrl, { method: 'DELETE', cache: 'no-store' });
    if (delRes.status === 403) return 'permission_denied';
    return 'ok';
  } catch {
    return 'network_error';
  } finally {
    if (created) {
      await fetch(deleteUrl, { method: 'DELETE', cache: 'no-store' }).catch(() => {});
    }
  }
}

async function auditPrimaryDatabaseRules(adminUid: string): Promise<DatabaseRulesAuditResult> {
  const projectId = primaryFirebaseConfig.projectId;
  const firestoreDatabaseId = primaryFirebaseConfig.firestoreDatabaseId || '(default)';
  const issues: DatabaseRulesCheckIssue[] = [];
  let networkFailures = 0;

  await primaryAuth.authStateReady().catch(() => {});
  const authUser = primaryAuth.currentUser;
  const effectiveAdminUid = authUser?.uid || '';

  // Without an active Firebase Auth user (e.g., URL quick preview without Google Auth),
  // admin-only rules cannot pass and must not be reported as outdated Rules.
  if (!effectiveAdminUid) {
    return {
      dbKey: 'primary',
      dbLabel: 'القاعدة الأساسية للمنصة',
      isPrimary: true,
      projectId,
      firestoreDatabaseId,
      consoleRulesUrl: buildFirebaseConsoleRulesUrl(projectId, firestoreDatabaseId),
      status: 'unreachable',
      issues: [],
      recommendedRules: primaryFirestoreRulesRaw,
      checkedAtMs: Date.now(),
    };
  }

  await ensurePrimaryAdminMarker();

  // 1. Check read/list rule presence for every collection on Primary DB using accurate query patterns
  const readChecks = await Promise.all(
    PRIMARY_READ_CHECK_COLLECTIONS.map(async (item) => ({
      item,
      res: await probePrimaryCollectionRead(item),
    }))
  );

  for (const { item, res } of readChecks) {
    if (res === 'permission_denied') {
      issues.push({
        key: `read_${item.col}`,
        title: `قاعدة القراءة/الوصول لمجموعة ${item.label} غير محدّثة`,
        detail: `تم رفض الاستعلام لمجموعة ${item.col} في القاعدة الأساسية؛ يلزم لصق كود القواعد الكامل المحدّث.`,
      });
    } else if (res === 'network_error') {
      networkFailures++;
    }
  }

  // 2. Write + Delete probes with fresh unique IDs (active: false so invisible to users)
  const suffix = createProbeSuffix();
  const uidForWrite = effectiveAdminUid || adminUid;

  const broadcastProbeId = `msg_audit_${suffix}`;
  const broadcastProbeRef = doc(primaryDb, 'broadcasts', broadcastProbeId);
  try {
    await setDoc(broadcastProbeRef, {
      id: broadcastProbeId,
      title: 'فحص القواعد',
      body: 'فحص صلاحية الإشعارات',
      targetRoles: ['supervisor'],
      targetComplexId: 'all',
      targetComplexName: 'جميع المجمعات',
      senderName: 'فحص المنصة',
      createdBy: uidForWrite,
      active: false,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      issues.push({
        key: 'write_broadcasts',
        title: 'صلاحية إرسال الإشعارات والرسائل (broadcasts) مفقودة أو قديمة',
        detail: 'لا تسمح القواعد الحالية بإنشاء الرسائل الفورية للمستخدمين.',
      });
    }
  } finally {
    await deleteDoc(broadcastProbeRef).catch(() => {});
  }

  const audioProbeId = `aud_audit_${suffix}`;
  const audioProbeRef = doc(primaryDb, 'wordAudio', audioProbeId);
  try {
    await setDoc(audioProbeRef, {
      id: audioProbeId,
      complexId: 'cpx_rules_audit_probe',
      mode: 'noor_albayan',
      wordText: 'فحص',
      diacritizedWord: 'فَحْصٌ',
      wasAutoDiacritized: false,
      fullReading: 'فحص',
      steps: [],
      audioBase64: '',
      mimeType: 'audio/wav',
      byteSize: 0,
      createdBy: uidForWrite,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      issues.push({
        key: 'write_wordAudio',
        title: 'صلاحية حفظ صوتيات التهجي والكلمات (wordAudio) مفقودة أو قديمة',
        detail: 'تحتاج القواعد لإضافة صلاحيات مجموعة wordAudio لحفظ الصوتيات تلقائياً.',
      });
    }
  } finally {
    await deleteDoc(audioProbeRef).catch(() => {});
  }

  const shardLimitProbeId = `reg_shard_${suffix}`;
  const shardLimitProbeRef = doc(primaryDb, 'dbRegistry', shardLimitProbeId);
  const largeConfigJson = JSON.stringify({ pad: 'x'.repeat(9200) });
  try {
    await setDoc(shardLimitProbeRef, {
      id: shardLimitProbeId,
      name: 'فحص حد القواعد المتعددة',
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: largeConfigJson,
      active: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      issues.push({
        key: 'shard_limit_32000',
        title: 'حد تخزين تعدد القواعد للتبويب (dbRegistry) ما زال بالنسخة القديمة',
        detail:
          'يلزم تحديث حد mosqueConfigsJson في القواعد إلى 32000 ليتمكن المبرمج من ربط عدة قواعد بيانات لنفس التبويب.',
      });
    }
  } finally {
    await deleteDoc(shardLimitProbeRef).catch(() => {});
  }

  const unreachable =
    issues.length === 0 && networkFailures === PRIMARY_READ_CHECK_COLLECTIONS.length;

  return {
    dbKey: 'primary',
    dbLabel: 'القاعدة الأساسية للمنصة',
    isPrimary: true,
    projectId,
    firestoreDatabaseId,
    consoleRulesUrl: buildFirebaseConsoleRulesUrl(projectId, firestoreDatabaseId),
    status: unreachable ? 'unreachable' : issues.length > 0 ? 'needs_rules_update' : 'ok',
    issues,
    recommendedRules: primaryFirestoreRulesRaw,
    checkedAtMs: Date.now(),
  };
}

async function auditExternalDatabaseRules(
  target: ResolvedDbTarget
): Promise<DatabaseRulesAuditResult> {
  const conf = target.config;
  const projectId = conf?.projectId || 'unknown';
  const firestoreDatabaseId = conf?.firestoreDatabaseId || '(default)';
  const apiKey = conf?.apiKey || '';
  const issues: DatabaseRulesCheckIssue[] = [];
  let networkFailures = 0;

  if (!conf || !apiKey || projectId === 'unknown') {
    return {
      dbKey: target.key,
      dbLabel: target.label,
      isPrimary: false,
      projectId,
      firestoreDatabaseId,
      consoleRulesUrl: buildFirebaseConsoleRulesUrl(projectId, firestoreDatabaseId),
      status: 'unreachable',
      issues: [],
      recommendedRules: EXTERNAL_DB_RECOMMENDED_RULES,
      checkedAtMs: Date.now(),
    };
  }

  // Stateless REST probes (cache: 'no-store') + SDK fallback check avoid stale edge responses
  const readChecks = await Promise.all(
    EXTERNAL_ALL_COLLECTIONS.map(async (item) => ({
      item,
      res: await probeExternalCollectionReadRest(
        projectId,
        firestoreDatabaseId,
        apiKey,
        item.col,
        conf
      ),
    }))
  );

  for (const { item, res } of readChecks) {
    if (res === 'permission_denied') {
      const ruleSegment = item.col === 'healthcheck' ? '{docId}' : '{id}';
      issues.push({
        key: `ext_read_${item.col}`,
        title: `مجموعة ${item.label} مرفوضة أو مفقودة في القواعد`,
        detail: `القاعدة الخارجية لا تسمح بالوصول لمجموعة ${item.col}.`,
        ruleSnippet: `    match /${item.col}/${ruleSegment} {\n      allow read, write: if true;\n    }`,
      });
    } else if (res === 'network_error') {
      networkFailures++;
    }
  }

  const suffix = createProbeSuffix();
  const [hcWriteRes, msgWriteRes, audioWriteRes, bookPlanWriteRes] = await Promise.all([
    probeExternalWriteAndDeleteRest(
      projectId,
      firestoreDatabaseId,
      apiKey,
      'healthcheck',
      `audit_${suffix}`
    ),
    probeExternalWriteAndDeleteRest(
      projectId,
      firestoreDatabaseId,
      apiKey,
      'broadcasts',
      `msg_audit_${suffix}`
    ),
    probeExternalWriteAndDeleteRest(
      projectId,
      firestoreDatabaseId,
      apiKey,
      'wordAudio',
      `aud_audit_${suffix}`
    ),
    probeExternalWriteAndDeleteRest(
      projectId,
      firestoreDatabaseId,
      apiKey,
      'studentBookPlans',
      `bp_audit_${suffix}`
    ),
  ]);

  if (hcWriteRes === 'permission_denied') {
    issues.push({
      key: 'ext_write_healthcheck',
      title: 'صلاحية الكتابة في القاعدة الخارجية (healthcheck) مرفوضة',
      detail: 'قواعد الكتابة مغلقة في هذه القاعدة المنفصلة.',
      ruleSnippet: `    match /healthcheck/{docId} {\n      allow read, write: if true;\n    }`,
    });
  }

  if (msgWriteRes === 'permission_denied') {
    issues.push({
      key: 'ext_write_broadcasts',
      title: 'صلاحية الكتابة لمجموعة الإشعارات (broadcasts) مفقودة',
      detail: 'القاعدة الخارجية بحاجة لتحديث كود القواعد ليشمل broadcasts و wordAudio.',
      ruleSnippet: `    match /broadcasts/{id} {\n      allow read, write: if true;\n    }`,
    });
  }

  if (audioWriteRes === 'permission_denied') {
    issues.push({
      key: 'ext_write_wordAudio',
      title: 'صلاحية الكتابة لمجموعة الصوتيات (wordAudio) مفقودة',
      detail: 'القاعدة الخارجية بحاجة لتحديث كود القواعد ليشمل wordAudio.',
      ruleSnippet: `    match /wordAudio/{id} {\n      allow read, write: if true;\n    }`,
    });
  }

  if (
    bookPlanWriteRes === 'permission_denied' &&
    !issues.some((iss) => iss.key === 'ext_read_studentBookPlans')
  ) {
    issues.push({
      key: 'ext_write_studentBookPlans',
      title: 'صلاحية الكتابة لمجموعة متابعة الكتب (studentBookPlans) مرفوضة',
      detail: 'القراءة مسموحة لكن الكتابة مغلقة لمجموعة studentBookPlans؛ تأكد من وجود allow read, write: if true.',
      ruleSnippet: `    match /studentBookPlans/{id} {\n      allow read, write: if true;\n    }`,
    });
  }

  const unreachable =
    issues.length === 0 && networkFailures === EXTERNAL_ALL_COLLECTIONS.length;

  return {
    dbKey: target.key,
    dbLabel: conf ? `قاعدة منفصلة (${getDbDisplayLabel(conf)})` : target.label,
    isPrimary: false,
    projectId,
    firestoreDatabaseId,
    consoleRulesUrl: buildFirebaseConsoleRulesUrl(projectId, firestoreDatabaseId),
    status: unreachable ? 'unreachable' : issues.length > 0 ? 'needs_rules_update' : 'ok',
    issues,
    recommendedRules: EXTERNAL_DB_RECOMMENDED_RULES,
    checkedAtMs: Date.now(),
  };
}

export function summarizeRulesAuditResults(
  allResults: DatabaseRulesAuditResult[]
): PlatformRulesAuditReport {
  const unhealthyDatabases = allResults.filter((r) => r.status === 'needs_rules_update');
  const healthyCount = allResults.filter((r) => r.status === 'ok').length;
  return {
    allHealthy: unhealthyDatabases.length === 0,
    totalDatabases: allResults.length,
    healthyCount,
    unhealthyDatabases,
    allResults,
    checkedAtMs: Date.now(),
  };
}

async function runSingleAuditPass(adminUid: string): Promise<PlatformRulesAuditReport> {
  const primaryProjectId = primaryFirebaseConfig.projectId;
  const primaryDbId = primaryFirebaseConfig.firestoreDatabaseId || '(default)';
  const targets = await getAllKnownDatabases();
  const primaryResultPromise = auditPrimaryDatabaseRules(adminUid);
  const externalPromises = targets
    .filter(
      (t) =>
        !t.isPrimary &&
        t.config &&
        !(
          t.config.projectId === primaryProjectId &&
          (t.config.firestoreDatabaseId || '(default)') === primaryDbId
        )
    )
    .map((t) => auditExternalDatabaseRules(t));

  const allResults = await Promise.all([primaryResultPromise, ...externalPromises]);
  return summarizeRulesAuditResults(allResults);
}

export async function auditAllDatabasesRules(
  adminUid: string,
  options?: RulesAuditOptions
): Promise<PlatformRulesAuditReport> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return summarizeRulesAuditResults([]);
  }

  let report = await runSingleAuditPass(adminUid);

  // Firebase Security Rules propagation to edge API nodes typically takes 4-12s after Publish.
  // Retry cleanly with short delays when manually rechecking until all databases report healthy.
  if (options?.waitForPropagation && !report.allHealthy) {
    await new Promise((resolve) => window.setTimeout(resolve, 4000));
    report = await runSingleAuditPass(adminUid);
    if (!report.allHealthy) {
      await new Promise((resolve) => window.setTimeout(resolve, 5500));
      report = await runSingleAuditPass(adminUid);
    }
  }

  return report;
}
