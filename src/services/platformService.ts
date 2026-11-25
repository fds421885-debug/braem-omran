import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type QuerySnapshot,
} from 'firebase/firestore';
import { auth, db as primaryDb, handleFirestoreError, OperationType } from '../firebase';
import primaryFirebaseConfig from '../../firebase-applet-config.json';
import {
  ADMIN_QUADRUPLE_NAME,
  BOOK_HOMEWORK_TYPE_LABELS,
  COMPLEX_FEATURE_TAB_LABELS,
  QURAN_REVIEW_TYPE_LABELS,
  SPARK_FREE_TIER_BYTES,
  TAB_SHARD_MAX_BYTES,
  type AccountRecord,
  type ActiveSession,
  type AttendanceEntry,
  type AttendanceRecord,
  type AttendanceStatus,
  type AudioStorageQuotaSummary,
  type BookHomeworkStatus,
  type BookHomeworkType,
  type BookPageRecord,
  type BookRecord,
  type BookTextSegment,
  type BookWordAudioRecord,
  type CollectionUsageStat,
  type ComplexFeatureTabKey,
  type ComplexRecord,
  type ConnectedDatabaseInfo,
  type CurriculumRecord,
  type DailyStatsRecord,
  type DatabaseUsageDashboardReport,
  type DbRegistryEntry,
  type ExternalFirebaseConfig,
  type HalaqaRankingItem,
  type HalaqaRecord,
  type InviteLinkRecord,
  type MosqueRecord,
  type PhysicalDatabaseUsageSummary,
  type QuickLinkRecord,
  type QuranReviewType,
  type SavedWordAudioBrowserItem,
  type StudentBookHomeworkItem,
  type StudentBookPlanRecord,
  type StudentMushafMistakesRecord,
  type StudentQuranNewHifzItem,
  type StudentQuranPlanRecord,
  type StudentQuranReviewItem,
  type StudentRankingItem,
  type TabDbPoolMap,
  type TabDbShard,
  type UserRole,
  type WeekDayKey,
} from '../types/platform';
import type { PlatformRulesAuditReport } from './rulesAuditService';
import { shrinkWavBase64ForDb } from './bookStorage';
import {
  buildDbConnectionId,
  generateToken,
  generateValidId,
  getAuthForConfig,
  getDbDisplayLabel,
  getFirestoreForConfig,
  getTodayDateKey,
  hashQuadrupleName,
  parseFirebaseConfigInput,
  validateQuadrupleArabicName,
} from './multiDb';

export interface ResolvedDbTarget {
  id: string;
  key: string;
  label: string;
  isPrimary: boolean;
  db: Firestore;
  config: ExternalFirebaseConfig | null;
}

export interface DiscoveredComplex {
  id: string;
  name: string;
  usesExternalDb: boolean;
  isExternal: boolean;
  ownerDb: Firestore;
  ownerDbKey: string;
  ownerDbLabel: string;
  ownerConfig: ExternalFirebaseConfig | null;
  complex: ComplexRecord;
}

export interface MosqueDraft {
  id: string;
  name: string;
  usesExternalDb: boolean;
  externalConfigRaw: string;
  externalDatabaseId?: string;
  parsedConfig: ExternalFirebaseConfig | null;
  halaqat: { id: string; name: string }[];
}

export interface ComplexWorkspaceData {
  discovered: DiscoveredComplex;
  complex: ComplexRecord;
  mosques: MosqueRecord[];
  halaqat: HalaqaRecord[];
  accounts: AccountRecord[];
  inviteLinks: InviteLinkRecord[];
  quickLinks: QuickLinkRecord[];
  mosqueDbMap: Record<string, Firestore>;
  mosqueConfigMap: Record<string, ExternalFirebaseConfig | null>;
  halaqaDbMap: Record<string, Firestore>;
  halaqaConfigMap: Record<string, ExternalFirebaseConfig | null>;
  tabDbMap: Partial<Record<ComplexFeatureTabKey, Firestore>>;
  tabConfigMap: Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig | null>>;
  tabPools: TabDbPoolMap;
  complexDb: Firestore;
}

export type DbTransferScope = 'complex' | 'mosque' | 'halaqa';
export type DbTransferMode = 'migrate' | 'delete_old';

export interface DatabaseBackupBundle {
  exportedAt: string;
  platform: string;
  scope: DbTransferScope;
  targetId: string;
  targetName: string;
  sourceDbLabel: string;
  complex: ComplexRecord | null;
  mosques: MosqueRecord[];
  halaqat: HalaqaRecord[];
  accounts: AccountRecord[];
  inviteLinks: InviteLinkRecord[];
  quickLinks: QuickLinkRecord[];
}

function safeParseConfigJson(raw: string): ExternalFirebaseConfig | null {
  if (!raw || !raw.trim()) return null;
  try {
    const obj = JSON.parse(raw) as ExternalFirebaseConfig;
    if (obj && obj.apiKey && obj.projectId && obj.appId) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

function safeParseMosqueConfigs(raw: string): Record<string, ExternalFirebaseConfig> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ExternalFirebaseConfig>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function dbKeyFromConfig(config: ExternalFirebaseConfig): string {
  return `${config.projectId}__${config.firestoreDatabaseId || '(default)'}`;
}

/**
 * Registers ONLY the Firebase connection details for an external database in primaryDb/dbRegistry.
 * Zero complex/mosque/account data is ever written to primaryDb by this helper.
 */
export async function registerExternalDatabaseConnection(
  config: ExternalFirebaseConfig
): Promise<string> {
  const dbId = buildDbConnectionId(config);
  const label = getDbDisplayLabel(config).slice(0, 120);
  const regRef = doc(primaryDb, 'dbRegistry', dbId);
  const existingSnap = await getDoc(regRef).catch(() => null);

  if (existingSnap?.exists()) {
    await updateDoc(regRef, {
      name: label,
      hasExternalDb: true,
      firebaseConfigJson: JSON.stringify(config),
      mosqueConfigsJson: '{}',
      active: true,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(regRef, {
      id: dbId,
      name: label,
      hasExternalDb: true,
      firebaseConfigJson: JSON.stringify(config),
      mosqueConfigsJson: '{}',
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  return dbId;
}

export async function removeExternalDatabaseConnection(registryDocId: string): Promise<void> {
  if (!registryDocId || registryDocId === 'primary') return;
  await deleteDoc(doc(primaryDb, 'dbRegistry', registryDocId));
}

export async function getDocFresh(
  ref: DocumentReference<DocumentData>
): Promise<DocumentSnapshot<DocumentData>> {
  try {
    return await getDocFromServer(ref);
  } catch {
    return await getDoc(ref);
  }
}

export async function getDocsFresh(
  q: Query<DocumentData>
): Promise<QuerySnapshot<DocumentData>> {
  try {
    return await getDocsFromServer(q);
  } catch {
    return await getDocs(q);
  }
}

export async function getAllKnownDatabases(
  fallbackComplexId?: string | null
): Promise<ResolvedDbTarget[]> {
  const targets: ResolvedDbTarget[] = [
    {
      id: 'primary',
      key: 'primary',
      label: 'القاعدة الأساسية',
      isPrimary: true,
      db: primaryDb,
      config: null,
    },
  ];

  const primaryCompositeKey = dbKeyFromConfig({
    apiKey: primaryFirebaseConfig.apiKey,
    authDomain: primaryFirebaseConfig.authDomain,
    projectId: primaryFirebaseConfig.projectId,
    appId: primaryFirebaseConfig.appId,
    firestoreDatabaseId: primaryFirebaseConfig.firestoreDatabaseId,
  });
  const seenKeys = new Set<string>(['primary', primaryCompositeKey]);

  const appendEntry = (entry: DbRegistryEntry) => {
    if (entry.hasExternalDb) {
      const conf = safeParseConfigJson(entry.firebaseConfigJson);
      if (conf) {
        const key = dbKeyFromConfig(conf);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          targets.push({
            id: entry.id,
            key,
            label: `قاعدة منفصلة (${getDbDisplayLabel(conf)})`,
            isPrimary: false,
            db: getFirestoreForConfig(conf),
            config: conf,
          });
        }
      }
    }

    // Backwards compatibility for legacy per-mosque configs, per-tab routes, AND multi-shard pools
    const rawMap = safeParseMosqueConfigs(entry.mosqueConfigsJson) as Record<string, unknown>;
    const candidateConfigs: ExternalFirebaseConfig[] = [];
    if (Array.isArray(rawMap?.shards)) {
      for (const sh of rawMap.shards as Array<{ config?: ExternalFirebaseConfig }>) {
        if (sh && sh.config && typeof sh.config === 'object') {
          candidateConfigs.push(sh.config);
        }
      }
    } else if (
      rawMap &&
      typeof rawMap.tabConfigs === 'object' &&
      rawMap.tabConfigs !== null
    ) {
      for (const tc of Object.values(rawMap.tabConfigs as Record<string, unknown>)) {
        if (tc && typeof tc === 'object') {
          candidateConfigs.push(tc as ExternalFirebaseConfig);
        }
      }
    } else {
      for (const v of Object.values(rawMap)) {
        if (v && typeof v === 'object') {
          candidateConfigs.push(v as ExternalFirebaseConfig);
        }
      }
    }

    for (const mConf of candidateConfigs) {
      if (!mConf || !mConf.projectId || !mConf.apiKey) continue;
      const mKey = dbKeyFromConfig(mConf);
      if (!seenKeys.has(mKey)) {
        seenKeys.add(mKey);
        targets.push({
          id: entry.id,
          key: mKey,
          label: `قاعدة منفصلة (${getDbDisplayLabel(mConf)})`,
          isPrimary: false,
          db: getFirestoreForConfig(mConf),
          config: mConf,
        });
      }
    }
  };

  try {
    const snap = await getDocsFresh(
      query(collection(primaryDb, 'dbRegistry'), where('active', '==', true))
    );

    snap.forEach((docSnap) => {
      appendEntry(docSnap.data() as DbRegistryEntry);
    });
  } catch {
    // Fallback below if fallbackComplexId is provided
  }

  if (fallbackComplexId) {
    try {
      const directSnap = await getDocFresh(
        doc(primaryDb, 'dbRegistry', fallbackComplexId)
      );
      if (directSnap.exists()) {
        const entry = directSnap.data() as DbRegistryEntry;
        if (entry.active !== false) {
          appendEntry(entry);
        }
      }
    } catch {
      // Ignore missing or restricted direct registry pointer
    }
  }

  return targets;
}

export async function listConnectedDatabasesInfo(): Promise<ConnectedDatabaseInfo[]> {
  const targets = await getAllKnownDatabases();
  return targets.map((t) => ({
    id: t.id,
    key: t.key,
    label: t.label,
    isPrimary: t.isPrimary,
    config: t.config,
  }));
}

/**
 * Discovers ALL complexes directly by querying `complexes` inside Primary DB AND every
 * connected External DB. If a complex belongs to an External DB, it is read exclusively from
 * that External DB.
 */
export async function listAllComplexesAcrossDatabases(): Promise<DiscoveredComplex[]> {
  const targets = await getAllKnownDatabases();
  const discoveredMap = new Map<string, DiscoveredComplex>();

  // Read external DBs first so if any complex lives on an external DB it ALWAYS owns the complex
  const ordered = [
    ...targets.filter((t) => !t.isPrimary),
    ...targets.filter((t) => t.isPrimary),
  ];

  for (const target of ordered) {
    try {
      const snap = await getDocs(
        query(collection(target.db, 'complexes'), where('active', '==', true))
      );
      snap.forEach((d) => {
        const c = d.data() as ComplexRecord;
        // Strict isolation: if an external complex is already discovered on an external DB,
        // never let a stale primaryDb copy override it.
        if (target.isPrimary && discoveredMap.has(c.id)) {
          return;
        }
        discoveredMap.set(c.id, {
          id: c.id,
          name: c.name,
          usesExternalDb: !target.isPrimary || c.usesExternalDb,
          isExternal: !target.isPrimary,
          ownerDb: target.db,
          ownerDbKey: target.key,
          ownerDbLabel: target.label,
          ownerConfig: target.config,
          complex: c,
        });
      });
    } catch {
      // Skip inaccessible external DB
    }
  }

  return Array.from(discoveredMap.values());
}

export async function isQuadrupleNameUniqueGlobally(
  quadrupleName: string,
  priorityDb?: Firestore
): Promise<{
  unique: boolean;
  nameHash: string;
}> {
  const nameHash = await hashQuadrupleName(quadrupleName);
  if (priorityDb) {
    try {
      const idxSnap = await getDocFresh(doc(priorityDb, 'nameIndex', nameHash));
      if (idxSnap.exists()) {
        return { unique: false, nameHash };
      }
    } catch {
      // Ignore if unreadable
    }
  }

  const targets = await getAllKnownDatabases();
  for (const target of targets) {
    if (priorityDb && target.db === priorityDb) continue;
    try {
      const idxSnap = await getDoc(doc(target.db, 'nameIndex', nameHash));
      if (idxSnap.exists()) {
        return { unique: false, nameHash };
      }
    } catch {
      // Skip restricted DBs
    }
  }

  return { unique: true, nameHash };
}

async function enrichSessionLabels(
  account: AccountRecord,
  db: Firestore,
  dbLabel: string,
  allowPrimaryLookup: boolean,
  authConfig: ExternalFirebaseConfig | null = null
): Promise<ActiveSession> {
  let complexName = '';
  let mosqueName = '';
  const mosqueNames: string[] = [];
  const halaqaNames: string[] = [];

  const allTargets = await getAllKnownDatabases();
  const searchPool = allowPrimaryLookup
    ? [db, ...allTargets.map((t) => t.db).filter((d) => d !== db)]
    : [db, ...allTargets.filter((t) => !t.isPrimary).map((t) => t.db).filter((d) => d !== db)];

  try {
    if (account.complexId) {
      for (const candidateDb of searchPool) {
        const cSnap = await getDoc(doc(candidateDb, 'complexes', account.complexId)).catch(
          () => null
        );
        if (cSnap?.exists()) {
          complexName = (cSnap.data() as ComplexRecord).name;
          break;
        }
      }
    }

    if (account.mosqueId) {
      for (const candidateDb of searchPool) {
        const mSnap = await getDoc(doc(candidateDb, 'mosques', account.mosqueId)).catch(
          () => null
        );
        if (mSnap?.exists()) {
          mosqueName = (mSnap.data() as MosqueRecord).name;
          break;
        }
      }
    }

    for (const mId of account.mosqueIds || []) {
      for (const candidateDb of searchPool) {
        const mSnap = await getDoc(doc(candidateDb, 'mosques', mId)).catch(() => null);
        if (mSnap?.exists()) {
          mosqueNames.push((mSnap.data() as MosqueRecord).name);
          break;
        }
      }
    }

    for (const hId of account.halaqaIds || []) {
      for (const candidateDb of searchPool) {
        const hSnap = await getDoc(doc(candidateDb, 'halaqat', hId)).catch(() => null);
        if (hSnap?.exists()) {
          halaqaNames.push((hSnap.data() as HalaqaRecord).name);
          break;
        }
      }
    }
  } catch {
    // Non-fatal label enrichment
  }

  return {
    mode: 'google',
    account,
    complexName,
    mosqueName,
    mosqueNames,
    halaqaNames,
    dbSourceLabel: dbLabel,
    authConfig,
  };
}

async function findAccountInDatabase(params: {
  user: User;
  targetDb: Firestore;
  dbLabel: string;
  isPrimary: boolean;
  authConfig: ExternalFirebaseConfig | null;
}): Promise<ActiveSession | null> {
  const { user, targetDb, dbLabel, isPrimary, authConfig } = params;
  const today = getTodayDateKey();

  // 1. Direct UID lookup
  const uidSnap = await getDocsFresh(
    query(collection(targetDb, 'accounts'), where('uid', '==', user.uid))
  );
  if (!uidSnap.empty) {
    const account = uidSnap.docs[0].data() as AccountRecord;
    const shouldCountDaily = account.lastLoginDate !== today;
    try {
      await updateDoc(doc(targetDb, 'accounts', account.id), {
        photoURL: (user.photoURL || account.photoURL || '').slice(0, 500),
        lastLoginDate: today,
        updatedAt: serverTimestamp(),
      });
    } catch {
      // Non-fatal timestamp update
    }
    // Ensure admins/{uid} exists for platform_admin across any verified admin email
    if (isPrimary && account.role === 'platform_admin' && account.quadrupleName === ADMIN_QUADRUPLE_NAME) {
      try {
        const adminRef = doc(primaryDb, 'admins', user.uid);
        const adminSnap = await getDoc(adminRef);
        if (!adminSnap.exists()) {
          await setDoc(adminRef, {
            uid: user.uid,
            quadrupleName: ADMIN_QUADRUPLE_NAME,
            email: (user.email || account.email || 'admin@braem-omran.app').trim().slice(0, 160),
            createdAt: serverTimestamp(),
          });
        }
      } catch {
        // Non-fatal; rulesAuditService will surface if admins/{uid} creation or rules are blocked
      }
    }
    // Record stats strictly on targetDb (never writes to primaryDb for external DB accounts!)
    await recordLoginVisit(account.role, shouldCountDaily, targetDb);
    return enrichSessionLabels(
      { ...account, lastLoginDate: today },
      targetDb,
      dbLabel,
      isPrimary,
      authConfig
    );
  }

  // 2. Email lookup for pre-added accounts or cross-auth logins
  if (user.email) {
    const emailSnap = await getDocsFresh(
      query(collection(targetDb, 'accounts'), where('email', '==', user.email.trim()))
    );
    if (!emailSnap.empty) {
      const account = emailSnap.docs[0].data() as AccountRecord;
      const shouldCountDaily = account.lastLoginDate !== today;
      const nextUid = account.uid || user.uid;
      try {
        await updateDoc(doc(targetDb, 'accounts', account.id), {
          ...(account.uid ? {} : { uid: user.uid }),
          photoURL: (user.photoURL || account.photoURL || '').slice(0, 500),
          lastLoginDate: today,
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Non-fatal timestamp/UID update
      }
      await recordLoginVisit(account.role, shouldCountDaily, targetDb);
      return enrichSessionLabels(
        { ...account, uid: nextUid, lastLoginDate: today },
        targetDb,
        dbLabel,
        isPrimary,
        authConfig
      );
    }
  }

  return null;
}

export async function findExistingAccountForInvite(
  user: User,
  targetDb: Firestore,
  dbLabel: string,
  targetConfig: ExternalFirebaseConfig | null
): Promise<ActiveSession | null> {
  try {
    return await findAccountInDatabase({
      user,
      targetDb,
      dbLabel,
      isPrimary: targetDb === primaryDb && !targetConfig,
      authConfig: targetConfig,
    });
  } catch {
    return null;
  }
}

export async function findExistingAccountForUser(
  user: User,
  authConfig: ExternalFirebaseConfig | null = null
): Promise<ActiveSession | null> {
  const targets = await getAllKnownDatabases();
  // Check External DBs first so external accounts are always resolved from their dedicated DB
  const ordered = [
    ...targets.filter((t) => !t.isPrimary),
    ...targets.filter((t) => t.isPrimary),
  ];

  for (const target of ordered) {
    try {
      const session = await findAccountInDatabase({
        user,
        targetDb: target.db,
        dbLabel: target.label,
        isPrimary: target.isPrimary,
        authConfig,
      });
      if (session) return session;
    } catch {
      // Continue searching remaining DBs
    }
  }

  return null;
}

export async function resolveInviteLink(
  rawToken: string,
  complexIdParam?: string | null,
  _mosqueIdParam?: string | null
): Promise<{
  link: InviteLinkRecord | null;
  db: Firestore;
  dbLabel: string;
  targetConfig: ExternalFirebaseConfig | null;
  isExternal: boolean;
  complexName: string;
  mosqueNames: string[];
  halaqaNames: string[];
  status: 'valid' | 'not_found' | 'closed' | 'not_started' | 'expired';
}> {
  const token = rawToken.trim();
  if (!token) {
    return {
      link: null,
      db: primaryDb,
      dbLabel: 'القاعدة الأساسية',
      targetConfig: null,
      isExternal: false,
      complexName: '',
      mosqueNames: [],
      halaqaNames: [],
      status: 'not_found',
    };
  }

  const allTargets = await getAllKnownDatabases(complexIdParam);
  // Search external DBs first so external complexes/mosques/halaqat resolve strictly from their own DB
  const externalTargets = allTargets.filter((t) => !t.isPrimary);

  let foundSnap: DocumentSnapshot<DocumentData> | null = null;
  let activeTarget: ResolvedDbTarget | null = null;

  for (const t of externalTargets) {
    try {
      const candidate = await getDocFresh(doc(t.db, 'inviteLinks', token));
      if (candidate.exists()) {
        foundSnap = candidate;
        activeTarget = t;
        break;
      }
    } catch {
      // Ignore unreachable external DB
    }
  }

  if (!foundSnap) {
    const primaryTarget = allTargets.find((t) => t.isPrimary);
    if (primaryTarget) {
      const candidate = await getDocFresh(
        doc(primaryTarget.db, 'inviteLinks', token)
      ).catch(() => null);
      if (candidate?.exists()) {
        foundSnap = candidate;
        activeTarget = primaryTarget;
      }
    }
  }

  if (!foundSnap || !activeTarget) {
    return {
      link: null,
      db: primaryDb,
      dbLabel: 'القاعدة الأساسية',
      targetConfig: null,
      isExternal: false,
      complexName: '',
      mosqueNames: [],
      halaqaNames: [],
      status: 'not_found',
    };
  }

  const rawLink = foundSnap.data() as InviteLinkRecord;
  const link: InviteLinkRecord = {
    ...rawLink,
    mosqueIds: Array.isArray(rawLink.mosqueIds) ? rawLink.mosqueIds : [],
    halaqaIds: Array.isArray(rawLink.halaqaIds) ? rawLink.halaqaIds : [],
    startsAtMs: Number(rawLink.startsAtMs) || 0,
    endsAtMs: Number(rawLink.endsAtMs) || 0,
    active: rawLink.active !== false,
  };

  const now = Date.now();
  let status: 'valid' | 'closed' | 'not_started' | 'expired' = 'valid';
  if (!link.active) {
    status = 'closed';
  } else if (link.startsAtMs > 0 && now < link.startsAtMs) {
    status = 'not_started';
  } else if (link.endsAtMs > 0 && now > link.endsAtMs) {
    status = 'expired';
  }

  let complexName = '';
  const mosqueNames: string[] = [];
  const halaqaNames: string[] = [];
  const metaPool = activeTarget.isPrimary
    ? allTargets
    : externalTargets;

  try {
    for (const src of metaPool) {
      const cSnap = await getDoc(doc(src.db, 'complexes', link.complexId)).catch(() => null);
      if (cSnap?.exists()) {
        complexName = (cSnap.data() as ComplexRecord).name;
        break;
      }
    }
    const mIds = link.mosqueIds.length > 0 ? link.mosqueIds : link.mosqueId ? [link.mosqueId] : [];
    for (const mId of mIds) {
      const mSnap = await getDoc(doc(activeTarget.db, 'mosques', mId)).catch(() => null);
      if (mSnap?.exists()) mosqueNames.push((mSnap.data() as MosqueRecord).name);
    }
    for (const hId of link.halaqaIds || []) {
      const hSnap = await getDoc(doc(activeTarget.db, 'halaqat', hId)).catch(() => null);
      if (hSnap?.exists()) halaqaNames.push((hSnap.data() as HalaqaRecord).name);
    }
  } catch {
    // Optional metadata
  }

  return {
    link,
    db: activeTarget.db,
    dbLabel: activeTarget.label,
    targetConfig: activeTarget.config,
    isExternal: !activeTarget.isPrimary,
    complexName,
    mosqueNames,
    halaqaNames,
    status,
  };
}

export async function registerNewUserAccount(params: {
  user: User;
  quadrupleName: string;
  inviteLink?: InviteLinkRecord | null;
  inviteTargetDb?: Firestore;
  inviteDbLabel?: string;
  inviteTargetConfig?: ExternalFirebaseConfig | null;
}): Promise<ActiveSession> {
  const {
    user,
    quadrupleName,
    inviteLink,
    inviteTargetDb,
    inviteDbLabel,
    inviteTargetConfig = null,
  } = params;
  const validation = validateQuadrupleArabicName(quadrupleName);
  if (!validation.valid) {
    throw new Error(validation.error || 'يرجى كتابة الاسم الرباعي كاملاً.');
  }

  const { unique, nameHash } = await isQuadrupleNameUniqueGlobally(
    validation.normalized,
    inviteTargetDb
  );
  if (!unique) {
    throw new Error('هذا الاسم الرباعي مسجل مسبقاً، لا يمكن تكرار الاسم الرباعي في أي مكان.');
  }

  const isProgrammerAdmin = validation.normalized === ADMIN_QUADRUPLE_NAME && !inviteLink;
  let role: UserRole = isProgrammerAdmin ? 'platform_admin' : 'student';
  let complexId = '';
  let mosqueId = '';
  let mosqueIds: string[] = [];
  let halaqaIds: string[] = [];
  let targetDb = primaryDb;
  let dbLabel = 'القاعدة الأساسية';
  let inviteToken = '';

  if (inviteLink && inviteTargetDb) {
    role = inviteLink.role;
    complexId = inviteLink.complexId;
    mosqueId = inviteLink.mosqueId;
    mosqueIds = inviteLink.mosqueIds;
    halaqaIds = inviteLink.halaqaIds;
    targetDb = inviteTargetDb;
    dbLabel = inviteDbLabel || 'قاعدة المجمع';
    inviteToken = inviteLink.token;
  }

  const activeAuth = getAuthForConfig(inviteTargetConfig);

  if (isProgrammerAdmin) {
    try {
      await setDoc(doc(primaryDb, 'admins', user.uid), {
        uid: user.uid,
        quadrupleName: ADMIN_QUADRUPLE_NAME,
        email: (user.email || '').trim().slice(0, 160),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `admins/${user.uid}`, activeAuth);
    }
  }

  const accountId = user.uid;
  const today = getTodayDateKey();
  const quickToken = generateToken(24);

  const accountPayload: AccountRecord = {
    id: accountId,
    uid: user.uid,
    quadrupleName: validation.normalized,
    nameHash,
    email: (user.email || '').trim().slice(0, 160),
    photoURL: (user.photoURL || '').trim().slice(0, 500),
    role,
    complexId,
    mosqueId,
    mosqueIds,
    halaqaIds,
    inviteToken,
    quickToken,
    lastLoginDate: today,
  };

  try {
    await setDoc(doc(targetDb, 'nameIndex', nameHash), {
      accountId,
      createdBy: user.uid,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `nameIndex/${nameHash}`, activeAuth);
  }

  try {
    await setDoc(doc(targetDb, 'accounts', accountId), {
      ...accountPayload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `accounts/${accountId}`, activeAuth);
  }

  await recordLoginVisit(role, true, targetDb);
  return enrichSessionLabels(
    accountPayload,
    targetDb,
    dbLabel,
    targetDb === primaryDb,
    inviteTargetConfig
  );
}

export async function resolveQuickLinkSession(
  rawToken: string,
  complexIdParam?: string | null,
  _mosqueIdParam?: string | null
): Promise<ActiveSession | null> {
  const token = rawToken.trim();
  if (!token) return null;

  const allTargets = await getAllKnownDatabases(complexIdParam);
  const externalTargets = allTargets.filter((t) => !t.isPrimary);

  let foundSnap: DocumentSnapshot<DocumentData> | null = null;
  let activeTarget: ResolvedDbTarget | null = null;

  for (const t of externalTargets) {
    try {
      const candidate = await getDocFresh(doc(t.db, 'quickLinks', token));
      if (candidate.exists()) {
        foundSnap = candidate;
        activeTarget = t;
        break;
      }
    } catch {
      // Ignore unreachable external DB
    }
  }

  if (!foundSnap) {
    const primaryTarget = allTargets.find((t) => t.isPrimary);
    if (primaryTarget) {
      const candidate = await getDocFresh(
        doc(primaryTarget.db, 'quickLinks', token)
      ).catch(() => null);
      if (candidate?.exists()) {
        foundSnap = candidate;
        activeTarget = primaryTarget;
      }
    }
  }

  if (!foundSnap || !activeTarget) return null;
  const quick = foundSnap.data() as QuickLinkRecord;
  if (quick.active === false) return null;

  const syntheticAccount: AccountRecord = {
    id: quick.accountId,
    uid: '',
    quadrupleName: quick.quadrupleName,
    nameHash: '',
    email: '',
    photoURL: '',
    role: quick.role,
    complexId: quick.complexId,
    mosqueId: quick.mosqueId,
    mosqueIds: quick.mosqueId ? [quick.mosqueId] : [],
    halaqaIds: [],
    inviteToken: '',
    quickToken: quick.token,
    lastLoginDate: getTodayDateKey(),
  };

  return {
    mode: 'quick',
    account: syntheticAccount,
    complexName: quick.complexName,
    mosqueName: quick.mosqueName,
    mosqueNames: quick.mosqueName ? [quick.mosqueName] : [],
    halaqaNames: quick.halaqaNames || [],
    dbSourceLabel: activeTarget.label,
    authConfig: activeTarget.config,
  };
}

export async function recordLoginVisit(
  role: UserRole,
  incrementRoleCounter: boolean,
  targetDb: Firestore = primaryDb
): Promise<void> {
  const todayKey = `daily_${getTodayDateKey()}`;
  const statIds = [todayKey, 'global'];

  for (const statId of statIds) {
    const statRef = doc(targetDb, 'stats', statId);
    try {
      const snap = await getDoc(statRef);
      const isStudent = incrementRoleCounter && role === 'student' ? 1 : 0;
      const isTeacher = incrementRoleCounter && role === 'teacher' ? 1 : 0;
      const isSupervisor =
        incrementRoleCounter && (role === 'supervisor' || role === 'platform_admin') ? 1 : 0;

      if (!snap.exists()) {
        await setDoc(statRef, {
          dateKey: statId,
          studentLogins: isStudent,
          teacherLogins: isTeacher,
          supervisorLogins: isSupervisor,
          totalVisits: 1,
          recitedAyahs: 0,
          recitedPages: 0,
          updatedAt: serverTimestamp(),
        });
      } else {
        const cur = snap.data() as DailyStatsRecord;
        await updateDoc(statRef, {
          studentLogins: cur.studentLogins + isStudent,
          teacherLogins: cur.teacherLogins + isTeacher,
          supervisorLogins: cur.supervisorLogins + isSupervisor,
          totalVisits: cur.totalVisits + 1,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // Non-fatal stats write
    }
  }
}

export async function getPlatformDashboardStats(): Promise<{
  today: DailyStatsRecord;
  global: DailyStatsRecord;
  totalComplexes: number;
  totalMosques: number;
  totalHalaqat: number;
  totalAccounts: number;
}> {
  const todayKey = `daily_${getTodayDateKey()}`;
  const emptyStats = (dateKey: string): DailyStatsRecord => ({
    dateKey,
    studentLogins: 0,
    teacherLogins: 0,
    supervisorLogins: 0,
    totalVisits: 0,
    recitedAyahs: 0,
    recitedPages: 0,
  });

  const today = emptyStats(todayKey);
  const global = emptyStats('global');

  const targets = await getAllKnownDatabases();
  const discoveredComplexes = await listAllComplexesAcrossDatabases();

  let totalMosques = 0;
  let totalHalaqat = 0;
  let totalAccounts = 0;

  for (const target of targets) {
    try {
      const [todaySnap, globalSnap] = await Promise.all([
        getDoc(doc(target.db, 'stats', todayKey)).catch(() => null),
        getDoc(doc(target.db, 'stats', 'global')).catch(() => null),
      ]);

      if (todaySnap?.exists()) {
        const d = todaySnap.data() as DailyStatsRecord;
        today.studentLogins += d.studentLogins || 0;
        today.teacherLogins += d.teacherLogins || 0;
        today.supervisorLogins += d.supervisorLogins || 0;
        today.totalVisits += d.totalVisits || 0;
        today.recitedAyahs += d.recitedAyahs || 0;
        today.recitedPages += d.recitedPages || 0;
      }

      if (globalSnap?.exists()) {
        const g = globalSnap.data() as DailyStatsRecord;
        global.studentLogins += g.studentLogins || 0;
        global.teacherLogins += g.teacherLogins || 0;
        global.supervisorLogins += g.supervisorLogins || 0;
        global.totalVisits += g.totalVisits || 0;
        global.recitedAyahs += g.recitedAyahs || 0;
        global.recitedPages += g.recitedPages || 0;
      }

      const [mSnap, hSnap, aSnap] = await Promise.all([
        getDocs(query(collection(target.db, 'mosques'), where('active', '==', true))),
        getDocs(query(collection(target.db, 'halaqat'), where('active', '==', true))),
        getDocs(collection(target.db, 'accounts')),
      ]);
      totalMosques += mSnap.size;
      totalHalaqat += hSnap.size;
      totalAccounts += aSnap.size;
    } catch {
      // Skip restricted external DB
    }
  }

  return {
    today,
    global,
    totalComplexes: discoveredComplexes.length,
    totalMosques,
    totalHalaqat,
    totalAccounts,
  };
}

export async function updateRecitationStats(params: {
  ayahsToAdd: number;
  pagesToAdd: number;
}): Promise<void> {
  const ayahs = Math.max(0, Math.floor(params.ayahsToAdd));
  const pages = Math.max(0, Math.floor(params.pagesToAdd));
  if (ayahs === 0 && pages === 0) return;

  const todayKey = `daily_${getTodayDateKey()}`;
  for (const statId of [todayKey, 'global']) {
    const ref = doc(primaryDb, 'stats', statId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        dateKey: statId,
        studentLogins: 0,
        teacherLogins: 0,
        supervisorLogins: 0,
        totalVisits: 0,
        recitedAyahs: ayahs,
        recitedPages: pages,
        updatedAt: serverTimestamp(),
      });
    } else {
      const cur = snap.data() as DailyStatsRecord;
      await updateDoc(ref, {
        recitedAyahs: cur.recitedAyahs + ayahs,
        recitedPages: cur.recitedPages + pages,
        updatedAt: serverTimestamp(),
      });
    }
  }
}

async function upsertNameIndexSafe(
  targetDb: Firestore,
  nameHash: string,
  accountId: string
): Promise<void> {
  if (!nameHash) return;
  const ref = doc(targetDb, 'nameIndex', nameHash);
  const existing = await getDoc(ref).catch(() => null);
  if (!existing?.exists()) {
    await setDoc(ref, {
      accountId,
      createdBy: auth.currentUser?.uid || 'admin',
      createdAt: serverTimestamp(),
    });
  }
}

async function upsertTransferredDoc(
  targetDb: Firestore,
  colName: string,
  docId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const ref = doc(targetDb, colName, docId);
  const snap = await getDoc(ref).catch(() => null);
  if (snap?.exists()) {
    const updateFields = { ...fields };
    delete updateFields.createdBy;
    await updateDoc(ref, {
      ...updateFields,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(ref, {
      ...fields,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}

async function migrateMosqueScopedRecords(params: {
  sourceDb: Firestore;
  destDb: Firestore;
  mosqueId: string;
}): Promise<void> {
  const { sourceDb, destDb, mosqueId } = params;
  if (sourceDb === destDb) return;

  try {
    const hSnap = await getDocs(
      query(collection(sourceDb, 'halaqat'), where('mosqueId', '==', mosqueId))
    );
    for (const d of hSnap.docs) {
      const h = d.data() as HalaqaRecord;
      await upsertTransferredDoc(destDb, 'halaqat', h.id, {
        id: h.id,
        complexId: h.complexId,
        mosqueId: h.mosqueId,
        name: h.name,
        active: h.active,
      });
      await deleteDoc(doc(sourceDb, 'halaqat', h.id));
    }

    const aSnap = await getDocs(
      query(collection(sourceDb, 'accounts'), where('mosqueId', '==', mosqueId))
    );
    for (const d of aSnap.docs) {
      const a = d.data() as AccountRecord;
      if (a.nameHash) {
        await upsertNameIndexSafe(destDb, a.nameHash, a.id);
        await deleteDoc(doc(sourceDb, 'nameIndex', a.nameHash)).catch(() => {});
      }
      await upsertTransferredDoc(destDb, 'accounts', a.id, {
        id: a.id,
        uid: a.uid || '',
        quadrupleName: a.quadrupleName,
        nameHash: a.nameHash,
        email: a.email || '',
        photoURL: a.photoURL || '',
        role: a.role,
        complexId: a.complexId || '',
        mosqueId: a.mosqueId || '',
        mosqueIds: a.mosqueIds || [],
        halaqaIds: a.halaqaIds || [],
        inviteToken: a.inviteToken || '',
        quickToken: a.quickToken || '',
        lastLoginDate: a.lastLoginDate || '',
      });
      await deleteDoc(doc(sourceDb, 'accounts', a.id));
    }

    const iSnap = await getDocs(
      query(collection(sourceDb, 'inviteLinks'), where('mosqueId', '==', mosqueId))
    );
    for (const d of iSnap.docs) {
      const inv = d.data() as InviteLinkRecord;
      await upsertTransferredDoc(destDb, 'inviteLinks', inv.token, {
        token: inv.token,
        title: inv.title,
        complexId: inv.complexId,
        role: inv.role,
        mosqueId: inv.mosqueId || '',
        mosqueIds: inv.mosqueIds || [],
        halaqaIds: inv.halaqaIds || [],
        startsAtMs: inv.startsAtMs || 0,
        endsAtMs: inv.endsAtMs || 0,
        active: inv.active,
      });
      await deleteDoc(doc(sourceDb, 'inviteLinks', inv.token));
    }

    const qSnap = await getDocs(
      query(collection(sourceDb, 'quickLinks'), where('mosqueId', '==', mosqueId))
    );
    for (const d of qSnap.docs) {
      const ql = d.data() as QuickLinkRecord;
      await upsertTransferredDoc(destDb, 'quickLinks', ql.token, {
        token: ql.token,
        accountId: ql.accountId,
        quadrupleName: ql.quadrupleName,
        role: ql.role,
        complexId: ql.complexId || '',
        complexName: ql.complexName || '',
        mosqueId: ql.mosqueId || '',
        mosqueName: ql.mosqueName || '',
        halaqaNames: ql.halaqaNames || [],
        active: ql.active,
      });
      await deleteDoc(doc(sourceDb, 'quickLinks', ql.token));
    }

    await deleteDoc(doc(sourceDb, 'mosques', mosqueId)).catch(() => {});
  } catch {
    // Non-fatal if source DB has partial records
  }
}

async function migrateComplexScopedRecords(params: {
  sourceDb: Firestore;
  destDb: Firestore;
  complexId: string;
}): Promise<void> {
  const { sourceDb, destDb, complexId } = params;
  if (sourceDb === destDb) return;

  try {
    const aSnap = await getDocs(
      query(collection(sourceDb, 'accounts'), where('complexId', '==', complexId))
    );
    for (const d of aSnap.docs) {
      const a = d.data() as AccountRecord;
      if (a.nameHash) {
        await upsertNameIndexSafe(destDb, a.nameHash, a.id);
        await deleteDoc(doc(sourceDb, 'nameIndex', a.nameHash)).catch(() => {});
      }
      await upsertTransferredDoc(destDb, 'accounts', a.id, {
        id: a.id,
        uid: a.uid || '',
        quadrupleName: a.quadrupleName,
        nameHash: a.nameHash,
        email: a.email || '',
        photoURL: a.photoURL || '',
        role: a.role,
        complexId: a.complexId || '',
        mosqueId: a.mosqueId || '',
        mosqueIds: a.mosqueIds || [],
        halaqaIds: a.halaqaIds || [],
        inviteToken: a.inviteToken || '',
        quickToken: a.quickToken || '',
        lastLoginDate: a.lastLoginDate || '',
      });
      await deleteDoc(doc(sourceDb, 'accounts', a.id));
    }

    const iSnap = await getDocs(
      query(collection(sourceDb, 'inviteLinks'), where('complexId', '==', complexId))
    );
    for (const d of iSnap.docs) {
      const inv = d.data() as InviteLinkRecord;
      await upsertTransferredDoc(destDb, 'inviteLinks', inv.token, {
        token: inv.token,
        title: inv.title,
        complexId: inv.complexId,
        role: inv.role,
        mosqueId: inv.mosqueId || '',
        mosqueIds: inv.mosqueIds || [],
        halaqaIds: inv.halaqaIds || [],
        startsAtMs: inv.startsAtMs || 0,
        endsAtMs: inv.endsAtMs || 0,
        active: inv.active,
      });
      await deleteDoc(doc(sourceDb, 'inviteLinks', inv.token));
    }

    const qSnap = await getDocs(
      query(collection(sourceDb, 'quickLinks'), where('complexId', '==', complexId))
    );
    for (const d of qSnap.docs) {
      const ql = d.data() as QuickLinkRecord;
      await upsertTransferredDoc(destDb, 'quickLinks', ql.token, {
        token: ql.token,
        accountId: ql.accountId,
        quadrupleName: ql.quadrupleName,
        role: ql.role,
        complexId: ql.complexId || '',
        complexName: ql.complexName || '',
        mosqueId: ql.mosqueId || '',
        mosqueName: ql.mosqueName || '',
        halaqaNames: ql.halaqaNames || [],
        active: ql.active,
      });
      await deleteDoc(doc(sourceDb, 'quickLinks', ql.token));
    }

    await deleteDoc(doc(sourceDb, 'complexes', complexId)).catch(() => {});
  } catch {
    // Non-fatal
  }
}

async function purgeMosqueScopedRecords(sourceDb: Firestore, mosqueId: string): Promise<void> {
  try {
    const hSnap = await getDocs(
      query(collection(sourceDb, 'halaqat'), where('mosqueId', '==', mosqueId))
    );
    for (const d of hSnap.docs) {
      await deleteDoc(doc(sourceDb, 'halaqat', d.id)).catch(() => {});
    }
    const aSnap = await getDocs(
      query(collection(sourceDb, 'accounts'), where('mosqueId', '==', mosqueId))
    );
    for (const d of aSnap.docs) {
      const a = d.data() as AccountRecord;
      if (a.nameHash) {
        await deleteDoc(doc(sourceDb, 'nameIndex', a.nameHash)).catch(() => {});
      }
      await deleteDoc(doc(sourceDb, 'accounts', a.id)).catch(() => {});
    }
    const iSnap = await getDocs(
      query(collection(sourceDb, 'inviteLinks'), where('mosqueId', '==', mosqueId))
    );
    for (const d of iSnap.docs) {
      await deleteDoc(doc(sourceDb, 'inviteLinks', d.id)).catch(() => {});
    }
    const qSnap = await getDocs(
      query(collection(sourceDb, 'quickLinks'), where('mosqueId', '==', mosqueId))
    );
    for (const d of qSnap.docs) {
      await deleteDoc(doc(sourceDb, 'quickLinks', d.id)).catch(() => {});
    }
    await deleteDoc(doc(sourceDb, 'mosques', mosqueId)).catch(() => {});
  } catch {
    // Non-fatal
  }
}

async function purgeComplexScopedRecords(sourceDb: Firestore, complexId: string): Promise<void> {
  try {
    const mSnap = await getDocs(
      query(collection(sourceDb, 'mosques'), where('complexId', '==', complexId))
    );
    for (const d of mSnap.docs) {
      await deleteDoc(doc(sourceDb, 'mosques', d.id)).catch(() => {});
    }
    const hSnap = await getDocs(
      query(collection(sourceDb, 'halaqat'), where('complexId', '==', complexId))
    );
    for (const d of hSnap.docs) {
      await deleteDoc(doc(sourceDb, 'halaqat', d.id)).catch(() => {});
    }
    const aSnap = await getDocs(
      query(collection(sourceDb, 'accounts'), where('complexId', '==', complexId))
    );
    for (const d of aSnap.docs) {
      const a = d.data() as AccountRecord;
      if (a.nameHash) {
        await deleteDoc(doc(sourceDb, 'nameIndex', a.nameHash)).catch(() => {});
      }
      await deleteDoc(doc(sourceDb, 'accounts', a.id)).catch(() => {});
    }
    const iSnap = await getDocs(
      query(collection(sourceDb, 'inviteLinks'), where('complexId', '==', complexId))
    );
    for (const d of iSnap.docs) {
      await deleteDoc(doc(sourceDb, 'inviteLinks', d.id)).catch(() => {});
    }
    const qSnap = await getDocs(
      query(collection(sourceDb, 'quickLinks'), where('complexId', '==', complexId))
    );
    for (const d of qSnap.docs) {
      await deleteDoc(doc(sourceDb, 'quickLinks', d.id)).catch(() => {});
    }
    await deleteDoc(doc(sourceDb, 'complexes', complexId)).catch(() => {});
  } catch {
    // Non-fatal
  }
}

/**
 * Saves Complex, Mosques, and Halaqat with STRICT DB ISOLATION:
 * - Any Complex or Mosque bound to an External DB is stored 100% exclusively on that External DB.
 * - Zero complex/mosque/halaqa/account documents are written to primaryDb when bound externally.
 * - Supports either migrating data ('migrate') or deleting old data ('delete_old') when DB changes.
 */
export async function saveComplexWithStructure(params: {
  adminUid: string;
  complexId?: string;
  name: string;
  usesExternalDb: boolean;
  externalConfigRaw: string;
  complexDatabaseId?: string;
  mosques: MosqueDraft[];
  previousOwnerDb?: Firestore | null;
  previousMosqueDbMap?: Record<string, Firestore>;
  complexMigrationMode?: DbTransferMode;
  mosqueMigrationModes?: Record<string, DbTransferMode>;
}): Promise<string> {
  const complexName = params.name.trim().slice(0, 120);
  if (complexName.length < 2) {
    throw new Error('يرجى إدخال اسم المجمع القرآني (حرفان على الأقل).');
  }

  let parsedComplexConfig: ExternalFirebaseConfig | null = null;
  if (params.usesExternalDb) {
    const parsed = parseFirebaseConfigInput(
      params.externalConfigRaw,
      params.complexDatabaseId
    );
    if (!parsed.config) {
      throw new Error(parsed.error || 'كود Firebase Config للمجمع غير صالح.');
    }
    parsedComplexConfig = parsed.config;
    // Register ONLY the database connection details in primaryDb/dbRegistry
    await registerExternalDatabaseConnection(parsedComplexConfig);
  }

  const mosqueConfigsMap: Record<string, ExternalFirebaseConfig> = {};
  for (const m of params.mosques) {
    if (!m.name.trim() || m.name.trim().length < 2) {
      throw new Error('يرجى إدخال اسم صحيح لكل مسجد مضاف.');
    }
    if (m.usesExternalDb) {
      const parsedM = parseFirebaseConfigInput(
        m.externalConfigRaw,
        m.externalDatabaseId
      );
      if (!parsedM.config) {
        throw new Error(`مسجد "${m.name}": ${parsedM.error || 'كود Firebase Config غير صالح.'}`);
      }
      mosqueConfigsMap[m.id] = parsedM.config;
      // Register ONLY the database connection details in primaryDb/dbRegistry
      await registerExternalDatabaseConnection(parsedM.config);
    }
  }

  const complexId = params.complexId || generateValidId('cpx');
  const complexTargetDb = parsedComplexConfig
    ? getFirestoreForConfig(parsedComplexConfig)
    : primaryDb;

  // Guard: If this Complex is external, clean up any legacy per-complex entry from primaryDb/dbRegistry
  if (complexTargetDb !== primaryDb) {
    await deleteDoc(doc(primaryDb, 'dbRegistry', complexId)).catch(() => {});
  }

  // Write Complex document STRICTLY on complexTargetDb ONLY
  const complexRef = doc(complexTargetDb, 'complexes', complexId);
  const complexSnap = await getDoc(complexRef).catch(() => null);
  if (complexSnap?.exists()) {
    await updateDoc(complexRef, {
      name: complexName,
      usesExternalDb: !!parsedComplexConfig,
      active: true,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(complexRef, {
      id: complexId,
      name: complexName,
      usesExternalDb: !!parsedComplexConfig,
      active: true,
      createdBy: params.adminUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Write Mosques and Halaqat STRICTLY on their target DB (Mosque External DB > Complex DB)
  for (const m of params.mosques) {
    const mConfig = mosqueConfigsMap[m.id] || null;
    const mosqueTargetDb = mConfig ? getFirestoreForConfig(mConfig) : complexTargetDb;

    const prevMosqueDb = params.previousMosqueDbMap?.[m.id] || params.previousOwnerDb || null;
    if (prevMosqueDb && prevMosqueDb !== mosqueTargetDb) {
      const mMode =
        params.mosqueMigrationModes?.[m.id] || params.complexMigrationMode || 'migrate';
      if (mMode === 'delete_old') {
        await purgeMosqueScopedRecords(prevMosqueDb, m.id);
      } else {
        await migrateMosqueScopedRecords({
          sourceDb: prevMosqueDb,
          destDb: mosqueTargetDb,
          mosqueId: m.id,
        });
      }
    }

    const mosqueRef = doc(mosqueTargetDb, 'mosques', m.id);
    const mosqueSnap = await getDoc(mosqueRef).catch(() => null);
    if (mosqueSnap?.exists()) {
      await updateDoc(mosqueRef, {
        complexId,
        name: m.name.trim().slice(0, 120),
        usesExternalDb: !!mConfig,
        active: true,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(mosqueRef, {
        id: m.id,
        complexId,
        name: m.name.trim().slice(0, 120),
        usesExternalDb: !!mConfig,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const skipHalaqatOnDeleteOld =
      prevMosqueDb &&
      prevMosqueDb !== mosqueTargetDb &&
      (params.mosqueMigrationModes?.[m.id] || params.complexMigrationMode) === 'delete_old';

    if (!skipHalaqatOnDeleteOld) {
      for (const h of m.halaqat) {
        if (!h.name.trim()) continue;
        const halaqaRef = doc(mosqueTargetDb, 'halaqat', h.id);
        const halaqaSnap = await getDoc(halaqaRef).catch(() => null);
        if (halaqaSnap?.exists()) {
          await updateDoc(halaqaRef, {
            complexId,
            mosqueId: m.id,
            name: h.name.trim().slice(0, 120),
            active: true,
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(halaqaRef, {
            id: h.id,
            complexId,
            mosqueId: m.id,
            name: h.name.trim().slice(0, 120),
            active: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
    }
  }

  // If Complex moved from an old DB, either migrate remaining complex records OR purge old DB completely
  if (params.previousOwnerDb && params.previousOwnerDb !== complexTargetDb) {
    if (params.complexMigrationMode === 'delete_old') {
      await purgeComplexScopedRecords(params.previousOwnerDb, complexId);
    } else {
      await migrateComplexScopedRecords({
        sourceDb: params.previousOwnerDb,
        destDb: complexTargetDb,
        complexId,
      });
    }
  }

  return complexId;
}

export async function deleteDiscoveredComplex(discovered: DiscoveredComplex): Promise<void> {
  const ws = await loadComplexWorkspace(discovered);

  // Delete from owning DB(s) only — NEVER touches primaryDb if discovered.isExternal!
  const dbsInvolved = Array.from(
    new Set<Firestore>([discovered.ownerDb, ...Object.values(ws.mosqueDbMap)])
  );

  for (const targetDb of dbsInvolved) {
    if (discovered.isExternal && targetDb === primaryDb) continue;
    try {
      for (const qLink of ws.quickLinks) {
        await deleteDoc(doc(targetDb, 'quickLinks', qLink.token)).catch(() => {});
      }
      for (const inv of ws.inviteLinks) {
        await deleteDoc(doc(targetDb, 'inviteLinks', inv.token)).catch(() => {});
      }
      for (const acc of ws.accounts) {
        if (acc.nameHash) {
          await deleteDoc(doc(targetDb, 'nameIndex', acc.nameHash)).catch(() => {});
        }
        await deleteDoc(doc(targetDb, 'accounts', acc.id)).catch(() => {});
      }
      for (const hlq of ws.halaqat) {
        await deleteDoc(doc(targetDb, 'halaqat', hlq.id)).catch(() => {});
      }
      for (const msq of ws.mosques) {
        await deleteDoc(doc(targetDb, 'mosques', msq.id)).catch(() => {});
      }
      await deleteDoc(doc(targetDb, 'complexes', discovered.id)).catch(() => {});
    } catch {
      // Non-fatal
    }
  }

  // Clean up any legacy per-complex registry doc, per-tab routes pointer, or multi-shard pool docs
  await deleteDoc(doc(primaryDb, 'dbRegistry', discovered.id)).catch(() => {});
  await deleteDoc(doc(primaryDb, 'dbRegistry', `${TAB_ROUTE_DOC_PREFIX}${discovered.id}`)).catch(() => {});
  for (const tk of ALL_FEATURE_TAB_KEYS) {
    await deleteDoc(doc(primaryDb, 'dbRegistry', buildTabPoolDocId(discovered.id, tk))).catch(() => {});
  }
}

const TAB_ROUTE_DOC_PREFIX = 'tabroutes_';
const TAB_POOL_DOC_PREFIX = 'tabpool_';
const ALL_FEATURE_TAB_KEYS: ComplexFeatureTabKey[] = [
  'attendance',
  'library',
  'curricula',
  'presentations',
  'accounts_invites',
  'mosques_halaqat',
];

function buildTabPoolDocId(complexId: string, tabKey: ComplexFeatureTabKey): string {
  return `${TAB_POOL_DOC_PREFIX}${complexId}_${tabKey}`.slice(0, 128);
}

function getLocalShardMirrorKey(complexId: string, tabKey: ComplexFeatureTabKey): string {
  return `braem_tabpool_stats_${complexId}_${tabKey}`;
}

function readLocalShardMirror(
  complexId: string,
  tabKey: ComplexFeatureTabKey
): Record<string, { usedBytes: number; docsCount: number; status: TabDbShard['status'] }> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(getLocalShardMirrorKey(complexId, tabKey));
    if (!raw) return {};
    return JSON.parse(raw) as Record<
      string,
      { usedBytes: number; docsCount: number; status: TabDbShard['status'] }
    >;
  } catch {
    return {};
  }
}

function writeLocalShardMirror(
  complexId: string,
  tabKey: ComplexFeatureTabKey,
  shards: TabDbShard[]
): void {
  if (typeof window === 'undefined') return;
  try {
    const map: Record<
      string,
      { usedBytes: number; docsCount: number; status: TabDbShard['status'] }
    > = {};
    for (const sh of shards) {
      map[sh.id] = {
        usedBytes: sh.usedBytes,
        docsCount: sh.docsCount,
        status: sh.status,
      };
    }
    window.localStorage.setItem(getLocalShardMirrorKey(complexId, tabKey), JSON.stringify(map));
  } catch {
    // Non-fatal storage full / private mode
  }
}

export function estimateRecordBytes(payload: unknown): number {
  try {
    const str = JSON.stringify(payload);
    const bytes =
      typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(str).length : str.length * 2;
    return bytes + 128; // Include Firestore index & timestamp metadata overhead
  } catch {
    return 1024;
  }
}

function normalizeShardPoolInvariants(shards: TabDbShard[]): TabDbShard[] {
  const cleaned = shards
    .filter((s) => Boolean(s && s.config && s.config.projectId && s.config.apiKey && s.config.appId))
    .map((s) => {
      const maxBytes = Number(s.maxBytes) > 0 ? Number(s.maxBytes) : TAB_SHARD_MAX_BYTES;
      const usedBytes = Math.max(0, Number(s.usedBytes) || 0);
      const docsCount = Math.max(0, Number(s.docsCount) || 0);
      const status: TabDbShard['status'] =
        usedBytes >= maxBytes
          ? 'full'
          : s.status === 'full' || s.status === 'active' || s.status === 'standby'
          ? s.status
          : 'standby';
      return {
        ...s,
        id: s.id || buildDbConnectionId(s.config),
        label: s.label || getDbDisplayLabel(s.config),
        usedBytes,
        maxBytes,
        docsCount,
        status,
        createdAtMs: Number(s.createdAtMs) || Date.now(),
      };
    });

  // Ensure strictly at most ONE non-full shard is 'active'
  let activeAssigned = false;
  for (const sh of cleaned) {
    if (sh.status === 'full') continue;
    if (sh.status === 'active' && !activeAssigned) {
      activeAssigned = true;
    } else {
      sh.status = 'standby';
    }
  }
  if (!activeAssigned) {
    const firstAvailable = cleaned.find((s) => s.status !== 'full');
    if (firstAvailable) {
      firstAvailable.status = 'active';
    }
  }
  return cleaned;
}

function isQuotaOrFullError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code || '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    code.includes('resource-exhausted') ||
    msg.includes('resource-exhausted') ||
    msg.includes('quota')
  );
}

export async function loadComplexTabRoutes(
  complexId: string
): Promise<Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig>>> {
  const cleanId = `${TAB_ROUTE_DOC_PREFIX}${complexId}`.slice(0, 128);
  try {
    const snap = await getDocFresh(doc(primaryDb, 'dbRegistry', cleanId));
    if (!snap.exists()) return {};
    const data = snap.data() as DbRegistryEntry;
    if (!data.mosqueConfigsJson) return {};
    const parsed = JSON.parse(data.mosqueConfigsJson) as {
      tabConfigs?: Record<string, ExternalFirebaseConfig>;
    };
    if (!parsed || typeof parsed.tabConfigs !== 'object' || !parsed.tabConfigs) {
      return {};
    }
    const cleanRoutes: Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig>> = {};
    for (const [k, conf] of Object.entries(parsed.tabConfigs)) {
      if (conf && conf.apiKey && conf.projectId && conf.appId) {
        cleanRoutes[k as ComplexFeatureTabKey] = conf;
      }
    }
    return cleanRoutes;
  } catch {
    return {};
  }
}

export async function loadComplexTabPools(complexId: string): Promise<TabDbPoolMap> {
  const pools: TabDbPoolMap = {};
  const [legacyRoutes, ...poolSnaps] = await Promise.all([
    loadComplexTabRoutes(complexId),
    ...ALL_FEATURE_TAB_KEYS.map((tk) =>
      getDocFresh(doc(primaryDb, 'dbRegistry', buildTabPoolDocId(complexId, tk))).catch(() => null)
    ),
  ]);

  ALL_FEATURE_TAB_KEYS.forEach((tk, idx) => {
    const snap = poolSnaps[idx];
    let shards: TabDbShard[] = [];
    if (snap?.exists()) {
      try {
        const data = snap.data() as DbRegistryEntry;
        if (data.mosqueConfigsJson) {
          const parsed = JSON.parse(data.mosqueConfigsJson) as { shards?: TabDbShard[] };
          if (Array.isArray(parsed.shards)) {
            shards = parsed.shards;
          }
        }
      } catch {
        // Fallback below
      }
    }

    if (shards.length === 0 && legacyRoutes[tk]) {
      const legacyConf = legacyRoutes[tk]!;
      shards = [
        {
          id: buildDbConnectionId(legacyConf),
          label: getDbDisplayLabel(legacyConf),
          config: legacyConf,
          usedBytes: 0,
          maxBytes: TAB_SHARD_MAX_BYTES,
          docsCount: 0,
          status: 'active',
          createdAtMs: Date.now(),
        },
      ];
    }

    if (shards.length > 0) {
      // Merge local usage ledger (keeps rollover accuracy across supervisor/teacher sessions)
      const localMirror = readLocalShardMirror(complexId, tk);
      const merged = shards.map((sh) => {
        const sid = sh.id || buildDbConnectionId(sh.config);
        const loc = localMirror[sid];
        if (!loc) return sh;
        const bestUsed = Math.max(Number(sh.usedBytes) || 0, Number(loc.usedBytes) || 0);
        const bestDocs = Math.max(Number(sh.docsCount) || 0, Number(loc.docsCount) || 0);
        const bestStatus: TabDbShard['status'] =
          bestUsed >= (sh.maxBytes || TAB_SHARD_MAX_BYTES)
            ? 'full'
            : sh.status === 'full' || loc.status === 'full'
            ? 'full'
            : sh.status;
        return {
          ...sh,
          id: sid,
          usedBytes: bestUsed,
          docsCount: bestDocs,
          status: bestStatus,
        };
      });
      pools[tk] = normalizeShardPoolInvariants(merged);
    }
  });

  return pools;
}

export async function saveComplexTabPool(
  complexId: string,
  tabKey: ComplexFeatureTabKey,
  shards: TabDbShard[]
): Promise<TabDbShard[]> {
  const normalized = normalizeShardPoolInvariants(shards);
  const docId = buildTabPoolDocId(complexId, tabKey);
  const regRef = doc(primaryDb, 'dbRegistry', docId);
  writeLocalShardMirror(complexId, tabKey, normalized);

  if (normalized.length === 0) {
    await deleteDoc(regRef).catch(() => {});
    return [];
  }

  // Strip optional empty fields cleanly to maximize how many shards fit in one registry entry
  const compactShards = normalized.map((s) => ({
    ...s,
    config: {
      apiKey: s.config.apiKey,
      projectId: s.config.projectId,
      appId: s.config.appId,
      ...(s.config.authDomain ? { authDomain: s.config.authDomain } : {}),
      ...(s.config.storageBucket ? { storageBucket: s.config.storageBucket } : {}),
      ...(s.config.messagingSenderId ? { messagingSenderId: s.config.messagingSenderId } : {}),
      ...(s.config.firestoreDatabaseId
        ? { firestoreDatabaseId: s.config.firestoreDatabaseId }
        : {}),
    },
  }));

  const serialized = JSON.stringify({ shards: compactShards });
  if (serialized.length > 31500) {
    throw new Error('عدد قواعد البيانات لهذا التبويب تجاوز الحد الأقصى المسموح في الفهرس.');
  }

  const existingSnap = await getDocFresh(regRef).catch(() => null);
  if (existingSnap?.exists()) {
    await updateDoc(regRef, {
      name: `سلسلة قواعد ${COMPLEX_FEATURE_TAB_LABELS[tabKey]}`.slice(0, 120),
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: serialized,
      active: true,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(regRef, {
      id: docId,
      name: `سلسلة قواعد ${COMPLEX_FEATURE_TAB_LABELS[tabKey]}`.slice(0, 120),
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: serialized,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  return normalized;
}

export async function saveComplexTabRoutes(
  complexId: string,
  tabConfigs: Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig>>
): Promise<void> {
  const cleanId = `${TAB_ROUTE_DOC_PREFIX}${complexId}`.slice(0, 128);
  const entries = Object.entries(tabConfigs).filter(
    ([, conf]) => Boolean(conf && conf.apiKey && conf.projectId && conf.appId)
  );
  const regRef = doc(primaryDb, 'dbRegistry', cleanId);

  if (entries.length === 0) {
    await deleteDoc(regRef).catch(() => {});
    return;
  }

  const normalizedObj: Record<string, ExternalFirebaseConfig> = {};
  for (const [k, conf] of entries) {
    if (conf) normalizedObj[k] = conf;
  }
  const serialized = JSON.stringify({ tabConfigs: normalizedObj });
  if (serialized.length > 31500) {
    throw new Error('حجم إعدادات قواعد التبويبات تجاوز الحد المسموح.');
  }

  const existingSnap = await getDocFresh(regRef).catch(() => null);
  if (existingSnap?.exists()) {
    await updateDoc(regRef, {
      name: `توجيه تبويبات المجمع`,
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: serialized,
      active: true,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(regRef, {
      id: cleanId,
      name: `توجيه تبويبات المجمع`,
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: serialized,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}

export function getActiveShardFromPool(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): TabDbShard | null {
  const pool = workspace.tabPools?.[tabKey];
  if (!pool || pool.length === 0) return null;
  return (
    pool.find((s) => s.status === 'active') ||
    pool.find((s) => s.status !== 'full') ||
    pool[pool.length - 1]
  );
}

/**
 * Returns ALL Firestore instances assigned to this tab (active shard first, then all others)
 * so historical data written before a 4 GB rollover stays seamlessly readable.
 */
export function getReadDbsForComplexTab(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): Firestore[] {
  const pool = workspace.tabPools?.[tabKey];
  if (pool && pool.length > 0) {
    const active = pool.filter((s) => s.status === 'active');
    const rest = pool.filter((s) => s.status !== 'active');
    const ordered = [...active, ...rest];
    const dbs: Firestore[] = [];
    for (const sh of ordered) {
      const dbInst = getFirestoreForConfig(sh.config);
      if (dbInst === primaryDb) {
        throw new Error(
          `حماية العزل: تبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" مرتبط بقواعد خارجية ولا يمكن القراءة من القاعدة الأم.`
        );
      }
      if (!dbs.includes(dbInst)) {
        dbs.push(dbInst);
      }
    }
    if (dbs.length > 0) return dbs;
  }

  const extConfig = workspace.tabConfigMap?.[tabKey];
  if (extConfig && extConfig.projectId && extConfig.apiKey) {
    const extDb = workspace.tabDbMap?.[tabKey] || getFirestoreForConfig(extConfig);
    if (extDb === primaryDb) {
      throw new Error(
        `حماية العزل: تبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" مرتبط بقاعدة خارجية ولا يمكن القراءة أو الكتابة في القاعدة الأم.`
      );
    }
    return [extDb];
  }

  return [workspace.complexDb];
}

export function getDbForComplexTab(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): Firestore {
  const activeShard = getActiveShardFromPool(workspace, tabKey);
  if (activeShard) {
    const dbInst = getFirestoreForConfig(activeShard.config);
    if (dbInst === primaryDb) {
      throw new Error(
        `حماية العزل: تبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" مرتبط بقواعد خارجية ولا يمكن القراءة أو الكتابة في القاعدة الأم.`
      );
    }
    return dbInst;
  }

  const extConfig = workspace.tabConfigMap?.[tabKey];
  if (extConfig && extConfig.projectId && extConfig.apiKey) {
    const extDb = workspace.tabDbMap?.[tabKey] || getFirestoreForConfig(extConfig);
    if (extDb === primaryDb) {
      throw new Error(
        `حماية العزل: تبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" مرتبط بقاعدة خارجية ولا يمكن القراءة أو الكتابة في القاعدة الأم.`
      );
    }
    return extDb;
  }
  return workspace.complexDb;
}

function syncWorkspaceTabPointers(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey,
  shards: TabDbShard[]
): void {
  const normalized = normalizeShardPoolInvariants(shards);
  workspace.tabPools = {
    ...(workspace.tabPools || {}),
    [tabKey]: normalized,
  };
  writeLocalShardMirror(workspace.complex.id, tabKey, normalized);
  const activeShard =
    normalized.find((s) => s.status === 'active') ||
    normalized.find((s) => s.status !== 'full') ||
    normalized[normalized.length - 1] ||
    null;
  if (activeShard) {
    workspace.tabConfigMap[tabKey] = activeShard.config;
    workspace.tabDbMap[tabKey] = getFirestoreForConfig(activeShard.config);
  } else {
    delete workspace.tabConfigMap[tabKey];
    delete workspace.tabDbMap[tabKey];
  }
}

async function resolveWriteShardForTab(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey,
  incomingBytes: number
): Promise<{ db: Firestore; shard: TabDbShard | null }> {
  const pool = workspace.tabPools?.[tabKey];
  if (!pool || pool.length === 0) {
    return { db: getDbForComplexTab(workspace, tabKey), shard: null };
  }

  const workingPool = pool.map((s) => ({ ...s }));
  let current =
    workingPool.find((s) => s.status === 'active') ||
    workingPool.find((s) => s.status !== 'full') ||
    null;

  if (!current || current.status === 'full' || current.usedBytes + incomingBytes > current.maxBytes) {
    if (current) {
      current.status = 'full';
    }
    const candidate = workingPool.find(
      (s) => s.id !== current?.id && s.status !== 'full' && s.usedBytes + incomingBytes <= s.maxBytes
    );
    if (!candidate) {
      syncWorkspaceTabPointers(workspace, tabKey, workingPool);
      saveComplexTabPool(workspace.complex.id, tabKey, workingPool).catch(() => {});
      throw new Error(
        `امتلأت جميع قواعد البيانات المخصصة لتبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" (حد 4 جيجابايت لكل قاعدة). يرجى إضافة قاعدة جديدة في السلسلة.`
      );
    }
    candidate.status = 'active';
    current = candidate;
    syncWorkspaceTabPointers(workspace, tabKey, workingPool);
    saveComplexTabPool(workspace.complex.id, tabKey, workingPool).catch(() => {});
  }

  const writeDb = getFirestoreForConfig(current.config);
  if (writeDb === primaryDb) {
    throw new Error(
      `حماية العزل: لا يمكن الكتابة في القاعدة الأم لتبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}".`
    );
  }
  return { db: writeDb, shard: current };
}

function recordShardWriteUsage(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey,
  shard: TabDbShard | null,
  addedBytes: number,
  addedDocs: number
): void {
  if (!shard || !workspace.tabPools?.[tabKey]) return;
  const pool = workspace.tabPools[tabKey]!.map((s) => {
    if (s.id !== shard.id) return { ...s };
    const nextUsed = Math.max(0, s.usedBytes + addedBytes);
    const isNowFull = nextUsed >= s.maxBytes;
    return {
      ...s,
      usedBytes: nextUsed,
      docsCount: Math.max(0, s.docsCount + addedDocs),
      status: isNowFull ? ('full' as const) : s.status,
    };
  });

  // If the current shard just hit 4 GB after this write, automatically open the next standby shard!
  const updatedCurrent = pool.find((s) => s.id === shard.id);
  if (updatedCurrent && updatedCurrent.status === 'full') {
    const nextStandby = pool.find((s) => s.id !== shard.id && s.status !== 'full');
    if (nextStandby) {
      nextStandby.status = 'active';
    }
  }

  syncWorkspaceTabPointers(workspace, tabKey, pool);
  saveComplexTabPool(workspace.complex.id, tabKey, pool).catch(() => {});
}

export async function executeTabWriteWithRollover<T>(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey,
  incomingBytes: number,
  isNewDoc: boolean,
  writeFn: (targetDb: Firestore, shard: TabDbShard | null) => Promise<T>
): Promise<T> {
  const first = await resolveWriteShardForTab(workspace, tabKey, incomingBytes);
  try {
    const result = await writeFn(first.db, first.shard);
    recordShardWriteUsage(workspace, tabKey, first.shard, incomingBytes, isNewDoc ? 1 : 0);
    return result;
  } catch (err) {
    if (first.shard && isQuotaOrFullError(err) && workspace.tabPools?.[tabKey]) {
      // Mark failing shard full and auto-rollover immediately to next shard in chain
      const rolledPool = workspace.tabPools[tabKey]!.map((s) =>
        s.id === first.shard!.id ? { ...s, usedBytes: s.maxBytes, status: 'full' as const } : s
      );
      syncWorkspaceTabPointers(workspace, tabKey, rolledPool);
      const next = await resolveWriteShardForTab(workspace, tabKey, incomingBytes);
      const retryResult = await writeFn(next.db, next.shard);
      recordShardWriteUsage(workspace, tabKey, next.shard, incomingBytes, isNewDoc ? 1 : 0);
      return retryResult;
    }
    throw err;
  }
}

export async function findExistingDocInTabPool(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey,
  colName: string,
  docId: string
): Promise<{ db: Firestore; shard: TabDbShard | null; exists: boolean }> {
  const pool = workspace.tabPools?.[tabKey];
  if (pool && pool.length > 0) {
    const activeFirst = [...pool.filter((s) => s.status === 'active'), ...pool.filter((s) => s.status !== 'active')];
    for (const sh of activeFirst) {
      const candidateDb = getFirestoreForConfig(sh.config);
      const snap = await getDocFresh(doc(candidateDb, colName, docId)).catch(() => null);
      if (snap?.exists()) {
        return { db: candidateDb, shard: sh, exists: true };
      }
    }
    const writeTarget = await resolveWriteShardForTab(workspace, tabKey, 512);
    return { db: writeTarget.db, shard: writeTarget.shard, exists: false };
  }

  const singleDb = getDbForComplexTab(workspace, tabKey);
  const snap = await getDocFresh(doc(singleDb, colName, docId)).catch(() => null);
  return { db: singleDb, shard: null, exists: Boolean(snap?.exists()) };
}

export function getDbLabelForComplexTab(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): string {
  const pool = workspace.tabPools?.[tabKey];
  if (pool && pool.length > 0) {
    const active = getActiveShardFromPool(workspace, tabKey);
    if (pool.length === 1 && active) {
      return `قاعدة منفصلة (${active.label})`;
    }
    const availableCount = pool.filter((s) => s.status !== 'full').length;
    return active
      ? `سلسلة من ${pool.length} قواعد (النشطة الآن: ${active.label} · المتاح: ${availableCount})`
      : `سلسلة من ${pool.length} قواعد (جميعها ممتلئة 4 GB)`;
  }

  const extConfig = workspace.tabConfigMap?.[tabKey];
  if (extConfig && extConfig.projectId) {
    return `قاعدة منفصلة (${getDbDisplayLabel(extConfig)})`;
  }
  return workspace.discovered.ownerDbLabel;
}

export async function loadComplexWorkspace(
  discovered: DiscoveredComplex
): Promise<ComplexWorkspaceData> {
  const complexDb = discovered.ownerDb;
  const mosqueDbMap: Record<string, Firestore> = {};
  const mosqueConfigMap: Record<string, ExternalFirebaseConfig | null> = {};
  const halaqaDbMap: Record<string, Firestore> = {};
  const halaqaConfigMap: Record<string, ExternalFirebaseConfig | null> = {};

  const tabPools = await loadComplexTabPools(discovered.id);
  const tabDbMap: Partial<Record<ComplexFeatureTabKey, Firestore>> = {};
  const tabConfigMap: Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig | null>> = {};

  for (const [k, pool] of Object.entries(tabPools)) {
    if (pool && pool.length > 0) {
      const tabKey = k as ComplexFeatureTabKey;
      const active =
        pool.find((s) => s.status === 'active') ||
        pool.find((s) => s.status !== 'full') ||
        pool[pool.length - 1];
      if (active) {
        tabConfigMap[tabKey] = active.config;
        tabDbMap[tabKey] = getFirestoreForConfig(active.config);
      }
    }
  }

  let complex: ComplexRecord = discovered.complex;
  try {
    const cSnap = await getDoc(doc(complexDb, 'complexes', discovered.id));
    if (cSnap.exists()) {
      complex = cSnap.data() as ComplexRecord;
    }
  } catch {
    // Keep discovered snapshot
  }

  const mosquesMap = new Map<string, MosqueRecord>();
  const halaqatMap = new Map<string, HalaqaRecord>();
  const accountsMap = new Map<string, AccountRecord>();
  const inviteMap = new Map<string, InviteLinkRecord>();
  const quickMap = new Map<string, QuickLinkRecord>();

  const allTargets = await getAllKnownDatabases(`${TAB_ROUTE_DOC_PREFIX}${discovered.id}`);
  // STRICT ISOLATION:
  // If this complex lives on an External DB, NEVER read from primaryDb for this complex!
  const sourcesToRead = discovered.isExternal
    ? allTargets.filter((t) => !t.isPrimary)
    : allTargets;

  // Ensure ownerDb is first
  const orderedSources = [
    ...sourcesToRead.filter((t) => t.db === complexDb),
    ...sourcesToRead.filter((t) => t.db !== complexDb),
  ];

  const mosquesShardList = tabPools.mosques_halaqat || [];
  const accountsShardList = tabPools.accounts_invites || [];
  const hasIsolatedMosques = mosquesShardList.length > 0 || Boolean(tabDbMap.mosques_halaqat);
  const hasIsolatedAccounts = accountsShardList.length > 0 || Boolean(tabDbMap.accounts_invites);

  if (hasIsolatedMosques) {
    const shardsToRead =
      mosquesShardList.length > 0
        ? mosquesShardList
        : tabDbMap.mosques_halaqat && tabConfigMap.mosques_halaqat
        ? [
            {
              id: 'legacy',
              label: '',
              config: tabConfigMap.mosques_halaqat,
              usedBytes: 0,
              maxBytes: TAB_SHARD_MAX_BYTES,
              docsCount: 0,
              status: 'active' as const,
              createdAtMs: 0,
            },
          ]
        : [];
    for (const sh of shardsToRead) {
      const sDb = getFirestoreForConfig(sh.config);
      try {
        const [mSnap, hSnap] = await Promise.all([
          getDocsFresh(query(collection(sDb, 'mosques'), where('complexId', '==', discovered.id))),
          getDocsFresh(query(collection(sDb, 'halaqat'), where('complexId', '==', discovered.id))),
        ]);
        mSnap.forEach((d) => {
          const m = d.data() as MosqueRecord;
          if (m.active) {
            mosquesMap.set(m.id, m);
            mosqueDbMap[m.id] = sDb;
            mosqueConfigMap[m.id] = sh.config;
          }
        });
        hSnap.forEach((d) => {
          const h = d.data() as HalaqaRecord;
          if (h.active) {
            halaqatMap.set(h.id, h);
            halaqaDbMap[h.id] = sDb;
            halaqaConfigMap[h.id] = sh.config;
          }
        });
      } catch {
        // Skip unreachable isolated tab shard
      }
    }
  }

  if (hasIsolatedAccounts) {
    const shardsToRead =
      accountsShardList.length > 0
        ? accountsShardList
        : tabConfigMap.accounts_invites
        ? [
            {
              id: 'legacy',
              label: '',
              config: tabConfigMap.accounts_invites,
              usedBytes: 0,
              maxBytes: TAB_SHARD_MAX_BYTES,
              docsCount: 0,
              status: 'active' as const,
              createdAtMs: 0,
            },
          ]
        : [];
    for (const sh of shardsToRead) {
      const sDb = getFirestoreForConfig(sh.config);
      try {
        const [aSnap, iSnap, qSnap] = await Promise.all([
          getDocsFresh(query(collection(sDb, 'accounts'), where('complexId', '==', discovered.id))),
          getDocsFresh(query(collection(sDb, 'inviteLinks'), where('complexId', '==', discovered.id))),
          getDocsFresh(query(collection(sDb, 'quickLinks'), where('complexId', '==', discovered.id))),
        ]);
        aSnap.forEach((d) => {
          const a = d.data() as AccountRecord;
          accountsMap.set(a.id, a);
        });
        iSnap.forEach((d) => {
          const inv = d.data() as InviteLinkRecord;
          inviteMap.set(inv.token, inv);
        });
        qSnap.forEach((d) => {
          const ql = d.data() as QuickLinkRecord;
          quickMap.set(ql.token, ql);
        });
      } catch {
        // Skip unreachable isolated tab shard
      }
    }
  }

  for (const source of orderedSources) {
    try {
      if (!hasIsolatedMosques) {
        const mSnap = await getDocs(
          query(collection(source.db, 'mosques'), where('complexId', '==', discovered.id))
        );
        mSnap.forEach((d) => {
          const m = d.data() as MosqueRecord;
          if (m.active) {
            mosquesMap.set(m.id, m);
            mosqueDbMap[m.id] = source.db;
            mosqueConfigMap[m.id] = source.config;
          }
        });

        const hSnap = await getDocs(
          query(collection(source.db, 'halaqat'), where('complexId', '==', discovered.id))
        );
        hSnap.forEach((d) => {
          const h = d.data() as HalaqaRecord;
          if (h.active) {
            halaqatMap.set(h.id, h);
            halaqaDbMap[h.id] = source.db;
            halaqaConfigMap[h.id] = source.config;
          }
        });
      }

      if (!hasIsolatedAccounts) {
        const aSnap = await getDocs(
          query(collection(source.db, 'accounts'), where('complexId', '==', discovered.id))
        );
        aSnap.forEach((d) => {
          const a = d.data() as AccountRecord;
          accountsMap.set(a.id, a);
        });

        const iSnap = await getDocs(
          query(collection(source.db, 'inviteLinks'), where('complexId', '==', discovered.id))
        );
        iSnap.forEach((d) => {
          const inv = d.data() as InviteLinkRecord;
          inviteMap.set(inv.token, inv);
        });

        const qSnap = await getDocs(
          query(collection(source.db, 'quickLinks'), where('complexId', '==', discovered.id))
        );
        qSnap.forEach((d) => {
          const ql = d.data() as QuickLinkRecord;
          quickMap.set(ql.token, ql);
        });
      }
    } catch {
      // Skip inaccessible external DB
    }
  }

  return {
    discovered,
    complex,
    mosques: Array.from(mosquesMap.values()),
    halaqat: Array.from(halaqatMap.values()),
    accounts: Array.from(accountsMap.values()),
    inviteLinks: Array.from(inviteMap.values()),
    quickLinks: Array.from(quickMap.values()),
    mosqueDbMap,
    mosqueConfigMap,
    halaqaDbMap,
    halaqaConfigMap,
    tabDbMap,
    tabConfigMap,
    tabPools,
    complexDb,
  };
}

export function resolveTargetDbForEntity(
  workspace: ComplexWorkspaceData,
  mosqueId: string,
  halaqaIds?: string[]
): Firestore {
  if (
    workspace.tabPools?.accounts_invites?.length ||
    workspace.tabConfigMap?.accounts_invites
  ) {
    return getDbForComplexTab(workspace, 'accounts_invites');
  }
  if (halaqaIds && halaqaIds.length === 1 && workspace.halaqaDbMap[halaqaIds[0]]) {
    return workspace.halaqaDbMap[halaqaIds[0]];
  }
  return workspace.mosqueDbMap[mosqueId] || workspace.complexDb;
}

export async function addAccountToWorkspace(params: {
  workspace: ComplexWorkspaceData;
  quadrupleName: string;
  role: Exclude<UserRole, 'platform_admin'>;
  email?: string;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
}): Promise<AccountRecord> {
  const validation = validateQuadrupleArabicName(params.quadrupleName);
  if (!validation.valid) {
    throw new Error(validation.error || 'الاسم الرباعي غير مكتمل.');
  }

  const { unique, nameHash } = await isQuadrupleNameUniqueGlobally(validation.normalized);
  if (!unique) {
    throw new Error(`الاسم "${validation.normalized}" مسجل مسبقاً، لا يمكن تكرار الاسم الرباعي.`);
  }

  const targetDb = resolveTargetDbForEntity(
    params.workspace,
    params.mosqueId,
    params.halaqaIds
  );
  const accountId = generateValidId('acc');
  const quickToken = generateToken(24);
  const complexId = params.workspace.discovered.id;

  const accountPayload: AccountRecord = {
    id: accountId,
    uid: '',
    quadrupleName: validation.normalized,
    nameHash,
    email: (params.email || '').trim().slice(0, 160),
    photoURL: '',
    role: params.role,
    complexId,
    mosqueId: params.mosqueId,
    mosqueIds:
      params.mosqueIds.length > 0 ? params.mosqueIds : params.mosqueId ? [params.mosqueId] : [],
    halaqaIds: params.halaqaIds,
    inviteToken: '',
    quickToken,
    lastLoginDate: '',
  };

  await upsertNameIndexSafe(targetDb, nameHash, accountId);

  await setDoc(doc(targetDb, 'accounts', accountId), {
    ...accountPayload,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await syncQuickLinkForAccount(params.workspace, accountPayload, targetDb);

  return accountPayload;
}

export async function bulkImportAccountsToWorkspace(params: {
  workspace: ComplexWorkspaceData;
  rawLines: string;
  role: Exclude<UserRole, 'platform_admin'>;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
}): Promise<{
  addedCount: number;
  skippedErrors: string[];
}> {
  const lines = params.rawLines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('يرجى كتابة اسم رباعي واحد على الأقل.');
  }

  const skippedErrors: string[] = [];
  let addedCount = 0;
  const seenInBatch = new Set<string>();

  for (const line of lines) {
    const validation = validateQuadrupleArabicName(line);
    if (!validation.valid) {
      skippedErrors.push(`"${line}": ${validation.error}`);
      continue;
    }

    const nameHash = await hashQuadrupleName(validation.normalized);
    if (seenInBatch.has(nameHash)) {
      skippedErrors.push(`"${validation.normalized}": مكرر داخل القائمة نفسها.`);
      continue;
    }
    seenInBatch.add(nameHash);

    try {
      await addAccountToWorkspace({
        workspace: params.workspace,
        quadrupleName: validation.normalized,
        role: params.role,
        mosqueId: params.mosqueId,
        mosqueIds: params.mosqueIds,
        halaqaIds: params.halaqaIds,
      });
      addedCount++;
    } catch (err) {
      skippedErrors.push(
        `"${validation.normalized}": ${err instanceof Error ? err.message : 'تعذرت الإضافة'}`
      );
    }
  }

  return { addedCount, skippedErrors };
}

export async function saveInviteLinkToWorkspace(params: {
  workspace: ComplexWorkspaceData;
  existingToken?: string;
  title: string;
  role: Exclude<UserRole, 'platform_admin'>;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
  startsAtMs: number;
  endsAtMs: number;
  active: boolean;
}): Promise<InviteLinkRecord> {
  const token = params.existingToken || generateToken(20);
  const targetDb = resolveTargetDbForEntity(
    params.workspace,
    params.mosqueId,
    params.halaqaIds
  );

  const payload: InviteLinkRecord = {
    token,
    title: params.title.trim().slice(0, 140),
    complexId: params.workspace.discovered.id,
    role: params.role,
    mosqueId: params.mosqueId,
    mosqueIds: params.mosqueIds,
    halaqaIds: params.halaqaIds,
    startsAtMs: Number.isFinite(params.startsAtMs) ? Math.max(0, Math.round(params.startsAtMs)) : 0,
    endsAtMs: Number.isFinite(params.endsAtMs) ? Math.max(0, Math.round(params.endsAtMs)) : 0,
    active: Boolean(params.active),
  };

  if (params.existingToken) {
    const targetRef = doc(targetDb, 'inviteLinks', token);
    const targetSnap = await getDocFresh(targetRef).catch(() => null);
    if (targetSnap?.exists()) {
      await updateDoc(targetRef, {
        title: payload.title,
        role: payload.role,
        mosqueId: payload.mosqueId,
        mosqueIds: payload.mosqueIds,
        halaqaIds: payload.halaqaIds,
        startsAtMs: payload.startsAtMs,
        endsAtMs: payload.endsAtMs,
        active: payload.active,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(targetRef, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    // Ensure no stale copy remains on another DB in the workspace
    const candidateDbs = new Set<Firestore>([
      params.workspace.complexDb,
      ...Object.values(params.workspace.mosqueDbMap),
      ...Object.values(params.workspace.halaqaDbMap),
    ]);
    for (const dbInstance of candidateDbs) {
      if (dbInstance === targetDb) continue;
      await deleteDoc(doc(dbInstance, 'inviteLinks', token)).catch(() => {});
    }
  } else {
    await setDoc(doc(targetDb, 'inviteLinks', token), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  return payload;
}

export async function toggleInviteLinkActiveState(
  workspace: ComplexWorkspaceData,
  link: InviteLinkRecord,
  active: boolean
): Promise<InviteLinkRecord> {
  return saveInviteLinkToWorkspace({
    workspace,
    existingToken: link.token,
    title: link.title,
    role: link.role,
    mosqueId: link.mosqueId,
    mosqueIds: link.mosqueIds,
    halaqaIds: link.halaqaIds,
    startsAtMs: link.startsAtMs,
    endsAtMs: link.endsAtMs,
    active,
  });
}

export async function deleteInviteLinkFromWorkspace(
  workspace: ComplexWorkspaceData,
  link: InviteLinkRecord
): Promise<void> {
  const candidateDbs = new Set<Firestore>([
    resolveTargetDbForEntity(workspace, link.mosqueId, link.halaqaIds),
    workspace.complexDb,
    ...Object.values(workspace.mosqueDbMap),
    ...Object.values(workspace.halaqaDbMap),
  ]);
  for (const targetDb of candidateDbs) {
    await deleteDoc(doc(targetDb, 'inviteLinks', link.token)).catch(() => {});
  }
}

export async function syncQuickLinkForAccount(
  workspace: ComplexWorkspaceData,
  account: AccountRecord,
  explicitDb?: Firestore
): Promise<QuickLinkRecord> {
  if (account.role === 'platform_admin') {
    throw new Error('لا تنشئ رابط دخول سريع للمشرف الأساسي.');
  }
  const targetDb =
    explicitDb ||
    resolveTargetDbForEntity(workspace, account.mosqueId, account.halaqaIds);
  const token = account.quickToken || generateToken(24);
  const mosqueObj = workspace.mosques.find((m) => m.id === account.mosqueId);
  const halaqaNames = (account.halaqaIds || [])
    .map((hId) => workspace.halaqat.find((h) => h.id === hId)?.name || '')
    .filter(Boolean);

  const quickPayload: QuickLinkRecord = {
    token,
    accountId: account.id,
    quadrupleName: account.quadrupleName,
    role: account.role,
    complexId: workspace.discovered.id,
    complexName: workspace.complex.name,
    mosqueId: account.mosqueId,
    mosqueName: mosqueObj?.name || '',
    halaqaNames,
    active: true,
  };

  const qlRef = doc(targetDb, 'quickLinks', token);
  const existingQlSnap = await getDocFresh(qlRef).catch(() => null);
  if (existingQlSnap?.exists()) {
    await updateDoc(qlRef, {
      ...quickPayload,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(qlRef, {
      ...quickPayload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  if (!account.quickToken) {
    await updateDoc(doc(targetDb, 'accounts', account.id), {
      quickToken: token,
      updatedAt: serverTimestamp(),
    });
  }

  return quickPayload;
}

export async function addOrRenameMosqueInWorkspace(params: {
  workspace: ComplexWorkspaceData;
  mosqueId?: string;
  name: string;
}): Promise<void> {
  const mosqueId = params.mosqueId || generateValidId('msq');
  const hasMosquesPool = Boolean(
    params.workspace.tabPools?.mosques_halaqat?.length ||
      params.workspace.tabConfigMap?.mosques_halaqat
  );
  const targetDb = hasMosquesPool
    ? getDbForComplexTab(params.workspace, 'mosques_halaqat')
    : params.workspace.mosqueDbMap[mosqueId] || params.workspace.complexDb;

  if (params.mosqueId) {
    const existingDb = params.workspace.mosqueDbMap[mosqueId] || targetDb;
    await updateDoc(doc(existingDb, 'mosques', mosqueId), {
      name: params.name.trim().slice(0, 120),
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id: mosqueId,
      complexId: params.workspace.discovered.id,
      name: params.name.trim().slice(0, 120),
      usesExternalDb: false,
      active: true,
    };
    await executeTabWriteWithRollover(
      params.workspace,
      'mosques_halaqat',
      estimateRecordBytes(payload),
      true,
      async (writeDb) => {
        await setDoc(doc(writeDb, 'mosques', mosqueId), {
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    );
  }
}

export async function addOrRenameHalaqaInWorkspace(params: {
  workspace: ComplexWorkspaceData;
  halaqaId?: string;
  mosqueId: string;
  name: string;
}): Promise<void> {
  const halaqaId = params.halaqaId || generateValidId('hlq');
  const hasMosquesPool = Boolean(
    params.workspace.tabPools?.mosques_halaqat?.length ||
      params.workspace.tabConfigMap?.mosques_halaqat
  );
  const fallbackDb = params.halaqaId
    ? params.workspace.halaqaDbMap[params.halaqaId] ||
      params.workspace.mosqueDbMap[params.mosqueId] ||
      params.workspace.complexDb
    : params.workspace.mosqueDbMap[params.mosqueId] || params.workspace.complexDb;

  if (params.halaqaId) {
    let editDb = fallbackDb;
    if (hasMosquesPool) {
      const existing = await findExistingDocInTabPool(
        params.workspace,
        'mosques_halaqat',
        'halaqat',
        halaqaId
      );
      if (existing.exists) editDb = existing.db;
    }
    await updateDoc(doc(editDb, 'halaqat', halaqaId), {
      name: params.name.trim().slice(0, 120),
      mosqueId: params.mosqueId,
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id: halaqaId,
      complexId: params.workspace.discovered.id,
      mosqueId: params.mosqueId,
      name: params.name.trim().slice(0, 120),
      active: true,
    };
    if (hasMosquesPool) {
      await executeTabWriteWithRollover(
        params.workspace,
        'mosques_halaqat',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await setDoc(doc(writeDb, 'halaqat', halaqaId), {
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      );
    } else {
      await setDoc(doc(fallbackDb, 'halaqat', halaqaId), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }
}

export async function transferEntireHalaqa(params: {
  workspace: ComplexWorkspaceData;
  halaqa: HalaqaRecord;
  destinationMosqueId: string;
}): Promise<void> {
  const { workspace, halaqa, destinationMosqueId } = params;
  if (halaqa.mosqueId === destinationMosqueId) return;

  const sourceDb =
    workspace.halaqaDbMap[halaqa.id] ||
    workspace.mosqueDbMap[halaqa.mosqueId] ||
    workspace.complexDb;
  const destDb = workspace.mosqueDbMap[destinationMosqueId] || workspace.complexDb;

  if (sourceDb === destDb) {
    await updateDoc(doc(sourceDb, 'halaqat', halaqa.id), {
      mosqueId: destinationMosqueId,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(doc(destDb, 'halaqat', halaqa.id), {
      ...halaqa,
      mosqueId: destinationMosqueId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await deleteDoc(doc(sourceDb, 'halaqat', halaqa.id));
  }

  const affectedAccounts = workspace.accounts.filter((a) =>
    a.halaqaIds.includes(halaqa.id)
  );
  for (const acc of affectedAccounts) {
    await transferAccountAssignment({
      workspace,
      account: acc,
      newMosqueId: destinationMosqueId,
      newMosqueIds: [destinationMosqueId],
      newHalaqaIds: acc.halaqaIds,
    });
  }
}

export async function transferAccountAssignment(params: {
  workspace: ComplexWorkspaceData;
  account: AccountRecord;
  newMosqueId: string;
  newMosqueIds: string[];
  newHalaqaIds: string[];
}): Promise<void> {
  const { workspace, account, newMosqueId, newMosqueIds, newHalaqaIds } = params;
  const sourceDb = resolveTargetDbForEntity(
    workspace,
    account.mosqueId,
    account.halaqaIds
  );
  const destDb = resolveTargetDbForEntity(workspace, newMosqueId, newHalaqaIds);

  const updatedAccount: AccountRecord = {
    ...account,
    mosqueId: newMosqueId,
    mosqueIds: newMosqueIds.length > 0 ? newMosqueIds : newMosqueId ? [newMosqueId] : [],
    halaqaIds: newHalaqaIds,
  };

  if (sourceDb === destDb) {
    await updateDoc(doc(sourceDb, 'accounts', account.id), {
      mosqueId: updatedAccount.mosqueId,
      mosqueIds: updatedAccount.mosqueIds,
      halaqaIds: updatedAccount.halaqaIds,
      updatedAt: serverTimestamp(),
    });
  } else {
    if (account.nameHash) {
      await upsertNameIndexSafe(destDb, account.nameHash, account.id);
      await deleteDoc(doc(sourceDb, 'nameIndex', account.nameHash)).catch(() => {});
    }
    await upsertTransferredDoc(destDb, 'accounts', account.id, {
      id: updatedAccount.id,
      uid: updatedAccount.uid || '',
      quadrupleName: updatedAccount.quadrupleName,
      nameHash: updatedAccount.nameHash,
      email: updatedAccount.email || '',
      photoURL: updatedAccount.photoURL || '',
      role: updatedAccount.role,
      complexId: updatedAccount.complexId || '',
      mosqueId: updatedAccount.mosqueId || '',
      mosqueIds: updatedAccount.mosqueIds || [],
      halaqaIds: updatedAccount.halaqaIds || [],
      inviteToken: updatedAccount.inviteToken || '',
      quickToken: updatedAccount.quickToken || '',
      lastLoginDate: updatedAccount.lastLoginDate || '',
    });
    await deleteDoc(doc(sourceDb, 'accounts', account.id));
  }

  if (updatedAccount.role !== 'platform_admin') {
    await syncQuickLinkForAccount(workspace, updatedAccount, destDb);
  }
}

export async function updateMemberAccountInWorkspace(params: {
  workspace: ComplexWorkspaceData;
  account: AccountRecord;
  quadrupleName: string;
  role: Exclude<UserRole, 'platform_admin'>;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
}): Promise<AccountRecord> {
  const { workspace, account, quadrupleName, role, mosqueId, mosqueIds, halaqaIds } = params;
  if (account.role === 'platform_admin') {
    throw new Error('لا يمكن تعديل حساب المشرف المبرمج من هنا.');
  }

  const validation = validateQuadrupleArabicName(quadrupleName);
  if (!validation.valid) {
    throw new Error(validation.error || 'يرجى كتابة الاسم الرباعي كاملاً.');
  }

  const newNameHash = await hashQuadrupleName(validation.normalized);
  const resolvedSourceDb = resolveTargetDbForEntity(
    workspace,
    account.mosqueId,
    account.halaqaIds
  );
  const destDb = resolveTargetDbForEntity(workspace, mosqueId, halaqaIds);

  // Locate the actual DB containing this account doc in case it resided elsewhere in the workspace
  let actualSourceDb = resolvedSourceDb;
  const candidateDbs = Array.from(
    new Set<Firestore>([
      resolvedSourceDb,
      workspace.complexDb,
      ...Object.values(workspace.mosqueDbMap),
      ...Object.values(workspace.halaqaDbMap),
    ])
  );
  for (const cand of candidateDbs) {
    const snap = await getDocFresh(doc(cand, 'accounts', account.id)).catch(() => null);
    if (snap?.exists()) {
      actualSourceDb = cand;
      break;
    }
  }

  if (newNameHash !== account.nameHash) {
    const { unique } = await isQuadrupleNameUniqueGlobally(validation.normalized, destDb);
    if (!unique) {
      throw new Error('هذا الاسم الرباعي مسجل مسبقاً، لا يمكن تكرار الاسم الرباعي.');
    }
    await upsertNameIndexSafe(destDb, newNameHash, account.id);
    if (account.nameHash) {
      await deleteDoc(doc(actualSourceDb, 'nameIndex', account.nameHash)).catch(() => {});
      if (destDb !== actualSourceDb) {
        await deleteDoc(doc(destDb, 'nameIndex', account.nameHash)).catch(() => {});
      }
    }
  } else if (actualSourceDb !== destDb && newNameHash) {
    await upsertNameIndexSafe(destDb, newNameHash, account.id);
    await deleteDoc(doc(actualSourceDb, 'nameIndex', account.nameHash)).catch(() => {});
  }

  const normalizedMosqueIds = (
    role === 'supervisor'
      ? mosqueIds
      : mosqueIds.length > 0
      ? mosqueIds
      : mosqueId
      ? [mosqueId]
      : []
  ).slice(0, 50);
  const normalizedPrimaryMosque = role === 'supervisor' ? normalizedMosqueIds[0] || '' : mosqueId;
  const normalizedHalaqaIds = (role === 'supervisor' ? [] : halaqaIds).slice(0, 50);
  const quickToken = account.quickToken || generateToken(24);

  const updatedAccount: AccountRecord = {
    ...account,
    quadrupleName: validation.normalized,
    nameHash: newNameHash,
    role,
    mosqueId: normalizedPrimaryMosque,
    mosqueIds: normalizedMosqueIds,
    halaqaIds: normalizedHalaqaIds,
    quickToken,
  };

  if (actualSourceDb === destDb) {
    await updateDoc(doc(destDb, 'accounts', account.id), {
      quadrupleName: updatedAccount.quadrupleName,
      nameHash: updatedAccount.nameHash,
      role: updatedAccount.role,
      mosqueId: updatedAccount.mosqueId,
      mosqueIds: updatedAccount.mosqueIds,
      halaqaIds: updatedAccount.halaqaIds,
      quickToken: updatedAccount.quickToken,
      updatedAt: serverTimestamp(),
    });
  } else {
    await upsertTransferredDoc(destDb, 'accounts', account.id, {
      id: updatedAccount.id,
      uid: updatedAccount.uid || '',
      quadrupleName: updatedAccount.quadrupleName,
      nameHash: updatedAccount.nameHash,
      email: updatedAccount.email || '',
      photoURL: updatedAccount.photoURL || '',
      role: updatedAccount.role,
      complexId: updatedAccount.complexId || '',
      mosqueId: updatedAccount.mosqueId || '',
      mosqueIds: updatedAccount.mosqueIds || [],
      halaqaIds: updatedAccount.halaqaIds || [],
      inviteToken: updatedAccount.inviteToken || '',
      quickToken: updatedAccount.quickToken || '',
      lastLoginDate: updatedAccount.lastLoginDate || '',
    });
    await deleteDoc(doc(actualSourceDb, 'accounts', account.id)).catch(() => {});
    if (account.quickToken) {
      await deleteDoc(doc(actualSourceDb, 'quickLinks', account.quickToken)).catch(() => {});
    }
  }

  await syncQuickLinkForAccount(workspace, updatedAccount, destDb);
  return updatedAccount;
}

export async function deleteMemberAccountFromWorkspace(
  workspace: ComplexWorkspaceData,
  account: AccountRecord,
  currentActor?: { accountId?: string; uid?: string }
): Promise<void> {
  if (account.role === 'platform_admin') {
    throw new Error('لا يمكن حذف حساب المشرف المبرمج.');
  }
  const activeUid = currentActor?.uid || auth.currentUser?.uid || '';
  if (
    (currentActor?.accountId && account.id === currentActor.accountId) ||
    (activeUid && (account.uid === activeUid || account.id === activeUid))
  ) {
    throw new Error('لا يمكن لمشرف المجمع حذف حسابه الشخصي.');
  }

  const candidateDbs = Array.from(
    new Set<Firestore>([
      resolveTargetDbForEntity(workspace, account.mosqueId, account.halaqaIds),
      workspace.complexDb,
      ...Object.values(workspace.mosqueDbMap),
      ...Object.values(workspace.halaqaDbMap),
    ])
  );

  for (const targetDb of candidateDbs) {
    await deleteDoc(doc(targetDb, 'accounts', account.id)).catch(() => {});
    if (account.nameHash) {
      await deleteDoc(doc(targetDb, 'nameIndex', account.nameHash)).catch(() => {});
    }
    if (account.quickToken) {
      await deleteDoc(doc(targetDb, 'quickLinks', account.quickToken)).catch(() => {});
    }
    try {
      const qSnap = await getDocs(
        query(collection(targetDb, 'quickLinks'), where('accountId', '==', account.id))
      );
      for (const qDoc of qSnap.docs) {
        await deleteDoc(doc(targetDb, 'quickLinks', qDoc.id)).catch(() => {});
      }
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Builds a complete JSON backup bundle for a Complex, Mosque, or Halaqa before changing/migrating DB.
 */
export function buildDatabaseBackupBundle(params: {
  workspace: ComplexWorkspaceData;
  scope: DbTransferScope;
  targetId: string;
}): DatabaseBackupBundle {
  const { workspace, scope, targetId } = params;

  if (scope === 'complex') {
    return {
      exportedAt: new Date().toISOString(),
      platform: 'براعم عمران',
      scope: 'complex',
      targetId: workspace.discovered.id,
      targetName: workspace.complex.name,
      sourceDbLabel: workspace.discovered.ownerDbLabel,
      complex: workspace.complex,
      mosques: workspace.mosques,
      halaqat: workspace.halaqat,
      accounts: workspace.accounts,
      inviteLinks: workspace.inviteLinks,
      quickLinks: workspace.quickLinks,
    };
  }

  if (scope === 'mosque') {
    const mosque = workspace.mosques.find((m) => m.id === targetId) || null;
    const mHalaqat = workspace.halaqat.filter((h) => h.mosqueId === targetId);
    const mAccounts = workspace.accounts.filter((a) => a.mosqueId === targetId);
    const mAccIds = new Set(mAccounts.map((a) => a.id));
    const mInvites = workspace.inviteLinks.filter((i) => i.mosqueId === targetId);
    const mQuicks = workspace.quickLinks.filter(
      (q) => q.mosqueId === targetId || mAccIds.has(q.accountId)
    );
    const mConf = workspace.mosqueConfigMap[targetId];
    return {
      exportedAt: new Date().toISOString(),
      platform: 'براعم عمران',
      scope: 'mosque',
      targetId,
      targetName: mosque?.name || 'مسجد',
      sourceDbLabel: mConf ? getDbDisplayLabel(mConf) : workspace.discovered.ownerDbLabel,
      complex: null,
      mosques: mosque ? [mosque] : [],
      halaqat: mHalaqat,
      accounts: mAccounts,
      inviteLinks: mInvites,
      quickLinks: mQuicks,
    };
  }

  // scope === 'halaqa'
  const halaqa = workspace.halaqat.find((h) => h.id === targetId) || null;
  const hAccounts = workspace.accounts.filter((a) => a.halaqaIds.includes(targetId));
  const hAccIds = new Set(hAccounts.map((a) => a.id));
  const hInvites = workspace.inviteLinks.filter((i) => i.halaqaIds.includes(targetId));
  const hQuicks = workspace.quickLinks.filter((q) => hAccIds.has(q.accountId));
  const hConf = workspace.halaqaConfigMap[targetId];

  return {
    exportedAt: new Date().toISOString(),
    platform: 'براعم عمران',
    scope: 'halaqa',
    targetId,
    targetName: halaqa?.name || 'حلقة',
    sourceDbLabel: hConf ? getDbDisplayLabel(hConf) : workspace.discovered.ownerDbLabel,
    complex: null,
    mosques: [],
    halaqat: halaqa ? [halaqa] : [],
    accounts: hAccounts,
    inviteLinks: hInvites,
    quickLinks: hQuicks,
  };
}

/**
 * Transfers or re-initializes a Complex, Mosque, or Halaqa onto a target database (Primary or External).
 * - If mode === 'migrate': copies all scoped records to destDb and removes them from old DB(s).
 * - If mode === 'delete_old': purges all old scoped records from old DB(s) and writes only a fresh clean shell on destDb.
 */
export async function executeDatabaseTransfer(params: {
  workspace: ComplexWorkspaceData;
  scope: DbTransferScope;
  targetId: string;
  targetConfig: ExternalFirebaseConfig | null; // null => Primary DB
  mode: DbTransferMode;
}): Promise<void> {
  const { workspace, scope, targetId, targetConfig, mode } = params;

  if (targetConfig) {
    await registerExternalDatabaseConnection(targetConfig);
  }
  const destDb = targetConfig ? getFirestoreForConfig(targetConfig) : primaryDb;
  const bundle = buildDatabaseBackupBundle({ workspace, scope, targetId });

  if (scope === 'complex') {
    const complexId = workspace.discovered.id;
    const allInvolvedSourceDbs = Array.from(
      new Set<Firestore>([
        workspace.complexDb,
        ...Object.values(workspace.mosqueDbMap),
        ...Object.values(workspace.halaqaDbMap),
      ])
    ).filter((d) => !(workspace.discovered.isExternal && d === primaryDb));

    await upsertTransferredDoc(destDb, 'complexes', complexId, {
      id: complexId,
      name: workspace.complex.name,
      usesExternalDb: !!targetConfig,
      active: true,
      createdBy: auth.currentUser?.uid || workspace.complex.createdBy || 'admin',
    });

    if (mode === 'migrate') {
      for (const m of bundle.mosques) {
        await upsertTransferredDoc(destDb, 'mosques', m.id, {
          id: m.id,
          complexId: m.complexId,
          name: m.name,
          usesExternalDb: false,
          active: true,
        });
      }
      for (const h of bundle.halaqat) {
        await upsertTransferredDoc(destDb, 'halaqat', h.id, {
          id: h.id,
          complexId: h.complexId,
          mosqueId: h.mosqueId,
          name: h.name,
          active: true,
        });
      }
      for (const acc of bundle.accounts) {
        if (acc.nameHash) {
          await upsertNameIndexSafe(destDb, acc.nameHash, acc.id);
        }
        await upsertTransferredDoc(destDb, 'accounts', acc.id, {
          id: acc.id,
          uid: acc.uid || '',
          quadrupleName: acc.quadrupleName,
          nameHash: acc.nameHash,
          email: acc.email || '',
          photoURL: acc.photoURL || '',
          role: acc.role,
          complexId: acc.complexId || '',
          mosqueId: acc.mosqueId || '',
          mosqueIds: acc.mosqueIds || [],
          halaqaIds: acc.halaqaIds || [],
          inviteToken: acc.inviteToken || '',
          quickToken: acc.quickToken || '',
          lastLoginDate: acc.lastLoginDate || '',
        });
      }
      for (const inv of bundle.inviteLinks) {
        await upsertTransferredDoc(destDb, 'inviteLinks', inv.token, {
          token: inv.token,
          title: inv.title,
          complexId: inv.complexId,
          role: inv.role,
          mosqueId: inv.mosqueId || '',
          mosqueIds: inv.mosqueIds || [],
          halaqaIds: inv.halaqaIds || [],
          startsAtMs: inv.startsAtMs || 0,
          endsAtMs: inv.endsAtMs || 0,
          active: inv.active,
        });
      }
      for (const ql of bundle.quickLinks) {
        await upsertTransferredDoc(destDb, 'quickLinks', ql.token, {
          token: ql.token,
          accountId: ql.accountId,
          quadrupleName: ql.quadrupleName,
          role: ql.role,
          complexId: ql.complexId || '',
          complexName: ql.complexName || '',
          mosqueId: ql.mosqueId || '',
          mosqueName: ql.mosqueName || '',
          halaqaNames: ql.halaqaNames || [],
          active: ql.active,
        });
      }
    }

    // Delete old records from all old DBs that differ from destDb
    for (const oldDb of allInvolvedSourceDbs) {
      if (oldDb === destDb) continue;
      await purgeComplexScopedRecords(oldDb, complexId);
    }
    if (destDb !== primaryDb) {
      await deleteDoc(doc(primaryDb, 'dbRegistry', complexId)).catch(() => {});
    }
    return;
  }

  if (scope === 'mosque') {
    const mosque = bundle.mosques[0];
    if (!mosque) throw new Error('لم يتم العثور على المسجد المطلوب.');

    const sourceDbs = Array.from(
      new Set<Firestore>([
        workspace.mosqueDbMap[targetId] || workspace.complexDb,
        ...bundle.halaqat.map((h) => workspace.halaqaDbMap[h.id]).filter(Boolean),
      ])
    );

    const mosqueUsesExt = !!targetConfig && destDb !== workspace.complexDb;
    await upsertTransferredDoc(destDb, 'mosques', mosque.id, {
      id: mosque.id,
      complexId: mosque.complexId,
      name: mosque.name,
      usesExternalDb: mosqueUsesExt,
      active: true,
    });

    if (mode === 'migrate') {
      for (const h of bundle.halaqat) {
        await upsertTransferredDoc(destDb, 'halaqat', h.id, {
          id: h.id,
          complexId: h.complexId,
          mosqueId: h.mosqueId,
          name: h.name,
          active: true,
        });
      }
      for (const acc of bundle.accounts) {
        if (acc.nameHash) {
          await upsertNameIndexSafe(destDb, acc.nameHash, acc.id);
        }
        await upsertTransferredDoc(destDb, 'accounts', acc.id, {
          id: acc.id,
          uid: acc.uid || '',
          quadrupleName: acc.quadrupleName,
          nameHash: acc.nameHash,
          email: acc.email || '',
          photoURL: acc.photoURL || '',
          role: acc.role,
          complexId: acc.complexId || '',
          mosqueId: acc.mosqueId || '',
          mosqueIds: acc.mosqueIds || [],
          halaqaIds: acc.halaqaIds || [],
          inviteToken: acc.inviteToken || '',
          quickToken: acc.quickToken || '',
          lastLoginDate: acc.lastLoginDate || '',
        });
      }
      for (const inv of bundle.inviteLinks) {
        await upsertTransferredDoc(destDb, 'inviteLinks', inv.token, {
          token: inv.token,
          title: inv.title,
          complexId: inv.complexId,
          role: inv.role,
          mosqueId: inv.mosqueId || '',
          mosqueIds: inv.mosqueIds || [],
          halaqaIds: inv.halaqaIds || [],
          startsAtMs: inv.startsAtMs || 0,
          endsAtMs: inv.endsAtMs || 0,
          active: inv.active,
        });
      }
      for (const ql of bundle.quickLinks) {
        await upsertTransferredDoc(destDb, 'quickLinks', ql.token, {
          token: ql.token,
          accountId: ql.accountId,
          quadrupleName: ql.quadrupleName,
          role: ql.role,
          complexId: ql.complexId || '',
          complexName: ql.complexName || '',
          mosqueId: ql.mosqueId || '',
          mosqueName: ql.mosqueName || '',
          halaqaNames: ql.halaqaNames || [],
          active: ql.active,
        });
      }
    }

    for (const oldDb of sourceDbs) {
      if (oldDb === destDb) continue;
      await purgeMosqueScopedRecords(oldDb, targetId);
    }
    return;
  }

  // scope === 'halaqa'
  const halaqa = bundle.halaqat[0];
  if (!halaqa) throw new Error('لم يتم العثور على الحلقة المطلوبة.');
  const sourceDb =
    workspace.halaqaDbMap[halaqa.id] ||
    workspace.mosqueDbMap[halaqa.mosqueId] ||
    workspace.complexDb;

  if (sourceDb === destDb) {
    throw new Error('الحلقة مرتبطة بهذه القاعدة بالفعل؛ اختر قاعدة أخرى للنقل.');
  }

  // Create/keep the Halaqa on destDb
  await upsertTransferredDoc(destDb, 'halaqat', halaqa.id, {
    id: halaqa.id,
    complexId: halaqa.complexId,
    mosqueId: halaqa.mosqueId,
    name: halaqa.name,
    active: true,
  });

  if (mode === 'migrate') {
    for (const acc of bundle.accounts) {
      if (acc.nameHash) {
        await upsertNameIndexSafe(destDb, acc.nameHash, acc.id);
      }
      await upsertTransferredDoc(destDb, 'accounts', acc.id, {
        id: acc.id,
        uid: acc.uid || '',
        quadrupleName: acc.quadrupleName,
        nameHash: acc.nameHash,
        email: acc.email || '',
        photoURL: acc.photoURL || '',
        role: acc.role,
        complexId: acc.complexId || '',
        mosqueId: acc.mosqueId || '',
        mosqueIds: acc.mosqueIds || [],
        halaqaIds: acc.halaqaIds || [],
        inviteToken: acc.inviteToken || '',
        quickToken: acc.quickToken || '',
        lastLoginDate: acc.lastLoginDate || '',
      });
    }
    for (const inv of bundle.inviteLinks) {
      await upsertTransferredDoc(destDb, 'inviteLinks', inv.token, {
        token: inv.token,
        title: inv.title,
        complexId: inv.complexId,
        role: inv.role,
        mosqueId: inv.mosqueId || '',
        mosqueIds: inv.mosqueIds || [],
        halaqaIds: inv.halaqaIds || [],
        startsAtMs: inv.startsAtMs || 0,
        endsAtMs: inv.endsAtMs || 0,
        active: inv.active,
      });
    }
    for (const ql of bundle.quickLinks) {
      await upsertTransferredDoc(destDb, 'quickLinks', ql.token, {
        token: ql.token,
        accountId: ql.accountId,
        quadrupleName: ql.quadrupleName,
        role: ql.role,
        complexId: ql.complexId || '',
        complexName: ql.complexName || '',
        mosqueId: ql.mosqueId || '',
        mosqueName: ql.mosqueName || '',
        halaqaNames: ql.halaqaNames || [],
        active: ql.active,
      });
    }
  }

  // Delete old Halaqa & its dedicated records from sourceDb
  for (const acc of bundle.accounts) {
    if (acc.halaqaIds.length <= 1) {
      if (acc.nameHash) {
        await deleteDoc(doc(sourceDb, 'nameIndex', acc.nameHash)).catch(() => {});
      }
      await deleteDoc(doc(sourceDb, 'accounts', acc.id)).catch(() => {});
    } else {
      await updateDoc(doc(sourceDb, 'accounts', acc.id), {
        halaqaIds: acc.halaqaIds.filter((id) => id !== halaqa.id),
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    }
  }
  for (const inv of bundle.inviteLinks) {
    if (inv.halaqaIds.length <= 1) {
      await deleteDoc(doc(sourceDb, 'inviteLinks', inv.token)).catch(() => {});
    } else {
      await updateDoc(doc(sourceDb, 'inviteLinks', inv.token), {
        halaqaIds: inv.halaqaIds.filter((id) => id !== halaqa.id),
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    }
  }
  for (const ql of bundle.quickLinks) {
    const ownerAcc = bundle.accounts.find((a) => a.id === ql.accountId);
    if (!ownerAcc || ownerAcc.halaqaIds.length <= 1) {
      await deleteDoc(doc(sourceDb, 'quickLinks', ql.token)).catch(() => {});
    }
  }
  await deleteDoc(doc(sourceDb, 'halaqat', halaqa.id)).catch(() => {});
}

export async function loadSupervisorWorkspace(
  session: ActiveSession
): Promise<ComplexWorkspaceData> {
  const complexId = session.account.complexId;
  if (!complexId) {
    throw new Error('حساب المشرف غير مرتبط بمجمع قرآني حالياً.');
  }

  let discovered: DiscoveredComplex | undefined;
  const allComplexes = await listAllComplexesAcrossDatabases();
  discovered = allComplexes.find((c) => c.id === complexId);

  if (!discovered && session.authConfig) {
    const extDb = getFirestoreForConfig(session.authConfig);
    const snap = await getDocFresh(doc(extDb, 'complexes', complexId)).catch(() => null);
    if (snap?.exists()) {
      const c = snap.data() as ComplexRecord;
      discovered = {
        id: c.id,
        name: c.name,
        usesExternalDb: true,
        isExternal: true,
        ownerDb: extDb,
        ownerDbKey: dbKeyFromConfig(session.authConfig),
        ownerDbLabel: getDbDisplayLabel(session.authConfig),
        ownerConfig: session.authConfig,
        complex: c,
      };
    }
  }

  if (!discovered) {
    throw new Error('تعذّر العثور على بيانات المجمع المرتبط بهذا الحساب.');
  }

  return loadComplexWorkspace(discovered);
}

export async function loadSupervisorDashboardAnalytics(
  workspace: ComplexWorkspaceData,
  restrictMosqueIds?: string[]
): Promise<{
  todayStats: DailyStatsRecord;
  globalStats: DailyStatsRecord;
  topHalaqat: HalaqaRankingItem[];
  topStudents: StudentRankingItem[];
}> {
  const todayKey = getTodayDateKey();
  const dailyDocId = `daily_${todayKey}`;
  const emptyStats = (dateKey: string): DailyStatsRecord => ({
    dateKey,
    studentLogins: 0,
    teacherLogins: 0,
    supervisorLogins: 0,
    totalVisits: 0,
    recitedAyahs: 0,
    recitedPages: 0,
  });

  const todayStats = emptyStats(dailyDocId);
  const globalStats = emptyStats('global');

  const uniqueDbs = Array.from(
    new Set<Firestore>([
      workspace.complexDb,
      ...Object.values(workspace.mosqueDbMap),
      ...Object.values(workspace.halaqaDbMap),
    ])
  ).filter((d) => !(workspace.discovered.isExternal && d === primaryDb));

  for (const targetDb of uniqueDbs) {
    try {
      const [todaySnap, globalSnap] = await Promise.all([
        getDocFresh(doc(targetDb, 'stats', dailyDocId)).catch(() => null),
        getDocFresh(doc(targetDb, 'stats', 'global')).catch(() => null),
      ]);
      if (todaySnap?.exists()) {
        const d = todaySnap.data() as DailyStatsRecord;
        todayStats.studentLogins += d.studentLogins || 0;
        todayStats.teacherLogins += d.teacherLogins || 0;
        todayStats.supervisorLogins += d.supervisorLogins || 0;
        todayStats.totalVisits += d.totalVisits || 0;
        todayStats.recitedAyahs += d.recitedAyahs || 0;
        todayStats.recitedPages += d.recitedPages || 0;
      }
      if (globalSnap?.exists()) {
        const g = globalSnap.data() as DailyStatsRecord;
        globalStats.studentLogins += g.studentLogins || 0;
        globalStats.teacherLogins += g.teacherLogins || 0;
        globalStats.supervisorLogins += g.supervisorLogins || 0;
        globalStats.totalVisits += g.totalVisits || 0;
        globalStats.recitedAyahs += g.recitedAyahs || 0;
        globalStats.recitedPages += g.recitedPages || 0;
      }
    } catch {
      // Non-fatal stats aggregation failure
    }
  }

  const allowedSet =
    restrictMosqueIds && restrictMosqueIds.length > 0 ? new Set(restrictMosqueIds) : null;

  const scopedHalaqat = workspace.halaqat.filter(
    (h) => !allowedSet || allowedSet.has(h.mosqueId)
  );
  const scopedAccounts = workspace.accounts.filter((a) => {
    if (!allowedSet) return true;
    return allowedSet.has(a.mosqueId) || a.mosqueIds.some((id) => allowedSet.has(id));
  });

  const topHalaqat: HalaqaRankingItem[] = scopedHalaqat
    .map((h) => {
      const mosqueName =
        workspace.mosques.find((m) => m.id === h.mosqueId)?.name || 'مسجد';
      const hStudents = scopedAccounts.filter(
        (a) => a.role === 'student' && a.halaqaIds.includes(h.id)
      );
      const hTeachers = scopedAccounts.filter(
        (a) => a.role === 'teacher' && a.halaqaIds.includes(h.id)
      );
      const activeTodayCount = hStudents.filter(
        (s) => s.lastLoginDate === todayKey
      ).length;

      let recitedAyahs = 0;
      let recitedPages = 0;
      for (const s of hStudents) {
        const ext = s as AccountRecord & { recitedAyahs?: number; recitedPages?: number };
        recitedAyahs += Number(ext.recitedAyahs) || 0;
        recitedPages += Number(ext.recitedPages) || 0;
      }

      const achievementScore =
        recitedAyahs * 2 +
        recitedPages * 20 +
        activeTodayCount * 15 +
        hStudents.length * 5 +
        hTeachers.length * 3;

      return {
        halaqaId: h.id,
        halaqaName: h.name,
        mosqueName,
        studentsCount: hStudents.length,
        teachersCount: hTeachers.length,
        recitedAyahs,
        recitedPages,
        achievementScore,
      };
    })
    .sort(
      (a, b) =>
        b.achievementScore - a.achievementScore ||
        b.studentsCount - a.studentsCount ||
        a.halaqaName.localeCompare(b.halaqaName, 'ar')
    );

  const topStudents: StudentRankingItem[] = scopedAccounts
    .filter((a) => a.role === 'student')
    .map((s) => {
      const ext = s as AccountRecord & { recitedAyahs?: number; recitedPages?: number };
      const recitedAyahs = Number(ext.recitedAyahs) || 0;
      const recitedPages = Number(ext.recitedPages) || 0;
      const attendanceActive = s.lastLoginDate === todayKey;
      const mosqueName =
        workspace.mosques.find((m) => m.id === s.mosqueId)?.name || 'غير محدد';
      const halaqaNames = s.halaqaIds
        .map((id) => workspace.halaqat.find((h) => h.id === id)?.name)
        .filter(Boolean);
      const halaqaName = halaqaNames.join('، ') || 'غير معيّنة';

      const achievementScore =
        recitedAyahs * 2 +
        recitedPages * 20 +
        (attendanceActive ? 25 : 0) +
        (s.uid ? 10 : 0);

      return {
        accountId: s.id,
        studentName: s.quadrupleName,
        mosqueName,
        halaqaName,
        recitedAyahs,
        recitedPages,
        attendanceActive,
        achievementScore,
      };
    })
    .sort(
      (a, b) =>
        b.achievementScore - a.achievementScore ||
        (b.attendanceActive ? 1 : 0) - (a.attendanceActive ? 1 : 0) ||
        a.studentName.localeCompare(b.studentName, 'ar')
    );

  return {
    todayStats,
    globalStats,
    topHalaqat,
    topStudents,
  };
}

function sanitizeBookSegments(segments: BookTextSegment[]): BookTextSegment[] {
  return segments.slice(0, 500).map((seg, idx) => {
    const clean: BookTextSegment = {
      id: String(seg.id || `seg_${idx}`).slice(0, 64),
      text: String(seg.text || '').slice(0, 1200),
      plainText: String(seg.plainText || seg.text || '').slice(0, 1200),
      kind: seg.kind === 'ayah' ? 'ayah' : 'word',
      box: [
        Math.max(0, Math.min(1000, Math.round(Number(seg.box?.[0] ?? 0)))),
        Math.max(0, Math.min(1000, Math.round(Number(seg.box?.[1] ?? 0)))),
        Math.max(0, Math.min(1000, Math.round(Number(seg.box?.[2] ?? 0)))),
        Math.max(0, Math.min(1000, Math.round(Number(seg.box?.[3] ?? 0)))),
      ],
    };
    if (
      clean.kind === 'ayah' &&
      typeof seg.surahNumber === 'number' &&
      seg.surahNumber >= 1 &&
      seg.surahNumber <= 114
    ) {
      clean.surahNumber = Math.round(seg.surahNumber);
    }
    if (
      clean.kind === 'ayah' &&
      typeof seg.ayahNumber === 'number' &&
      seg.ayahNumber >= 1 &&
      seg.ayahNumber <= 286
    ) {
      clean.ayahNumber = Math.round(seg.ayahNumber);
    }
    if (clean.kind === 'ayah' && seg.surahName) {
      clean.surahName = String(seg.surahName).trim().slice(0, 80);
    }
    return clean;
  });
}

export async function listBooksInComplex(
  workspace: ComplexWorkspaceData
): Promise<BookRecord[]> {
  try {
    const readDbs = getReadDbsForComplexTab(workspace, 'library');
    const byId = new Map<string, BookRecord>();
    await Promise.all(
      readDbs.map(async (libDb) => {
        const snap = await getDocsFresh(
          query(collection(libDb, 'books'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null);
        snap?.forEach((d) => {
          const item = d.data() as BookRecord;
          if (item && item.id) byId.set(item.id, item);
        });
      })
    );
    return Array.from(byId.values()).sort((a, b) => {
      const aSec = (a.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
      const bSec = (b.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
      return bSec - aSec;
    });
  } catch {
    return [];
  }
}

export async function loadBookPages(
  workspace: ComplexWorkspaceData,
  bookId: string
): Promise<BookPageRecord[]> {
  const readDbs = getReadDbsForComplexTab(workspace, 'library');
  const byId = new Map<string, BookPageRecord>();
  await Promise.all(
    readDbs.map(async (libDb) => {
      const snap = await getDocsFresh(
        query(collection(libDb, 'bookPages'), where('bookId', '==', bookId))
      ).catch(() => null);
      snap?.forEach((d) => {
        const p = d.data() as BookPageRecord;
        if (p && p.id) byId.set(p.id, p);
      });
    })
  );
  return Array.from(byId.values()).sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function upsertBookRecord(
  workspace: ComplexWorkspaceData,
  book: BookRecord
): Promise<void> {
  const title = book.title.trim().slice(0, 160) || 'كتاب بدون عنوان';
  const totalPages = Math.max(1, Math.min(2000, Math.round(book.totalPages)));
  const uploadedPages = Math.max(0, Math.min(totalPages, Math.round(book.uploadedPages)));
  const recognizedPages = Math.max(0, Math.min(totalPages, Math.round(book.recognizedPages)));

  const located = await findExistingDocInTabPool(workspace, 'library', 'books', book.id);
  if (located.exists) {
    await updateDoc(doc(located.db, 'books', book.id), {
      title,
      totalPages,
      uploadedPages,
      recognizedPages,
      status: book.status,
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const payload = {
    id: book.id,
    complexId: workspace.complex.id,
    title,
    fileName: book.fileName.trim().slice(0, 200) || 'book.pdf',
    fileType: book.fileType,
    totalPages,
    uploadedPages,
    recognizedPages,
    status: book.status,
    createdBy: book.createdBy || auth.currentUser?.uid || 'supervisor',
  };
  const byteSize = estimateRecordBytes(payload);

  await executeTabWriteWithRollover(workspace, 'library', byteSize, true, async (targetDb) => {
    await setDoc(doc(targetDb, 'books', book.id), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function upsertBookPageRecord(
  workspace: ComplexWorkspaceData,
  page: BookPageRecord
): Promise<void> {
  const cleanSegments = sanitizeBookSegments(page.segments);
  const cleanFullText = String(page.fullText || '').slice(0, 25000);
  const cleanWidth = Math.max(1, Math.min(10000, Math.round(page.width)));
  const cleanHeight = Math.max(1, Math.min(10000, Math.round(page.height)));

  const located = await findExistingDocInTabPool(workspace, 'library', 'bookPages', page.id);
  if (located.exists) {
    await updateDoc(doc(located.db, 'bookPages', page.id), {
      imageDataUrl: page.imageDataUrl,
      width: cleanWidth,
      height: cleanHeight,
      recognized: Boolean(page.recognized),
      fullText: cleanFullText,
      segments: cleanSegments,
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const payload = {
    id: page.id,
    bookId: page.bookId,
    complexId: workspace.complex.id,
    pageNumber: Math.max(1, Math.min(2000, Math.round(page.pageNumber))),
    imageDataUrl: page.imageDataUrl,
    width: cleanWidth,
    height: cleanHeight,
    recognized: Boolean(page.recognized),
    fullText: cleanFullText,
    segments: cleanSegments,
  };
  const byteSize = estimateRecordBytes(payload);

  await executeTabWriteWithRollover(workspace, 'library', byteSize, true, async (targetDb) => {
    await setDoc(doc(targetDb, 'bookPages', page.id), {
      ...payload,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function renameBookInWorkspace(
  workspace: ComplexWorkspaceData,
  bookId: string,
  newTitle: string
): Promise<void> {
  const clean = newTitle.trim().slice(0, 160);
  if (!clean) {
    throw new Error('يرجى إدخال عنوان صالح للكتاب.');
  }
  const located = await findExistingDocInTabPool(workspace, 'library', 'books', bookId);
  await updateDoc(doc(located.db, 'books', bookId), {
    title: clean,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteBookFromWorkspace(
  workspace: ComplexWorkspaceData,
  bookId: string
): Promise<void> {
  const readDbs = getReadDbsForComplexTab(workspace, 'library');
  for (const libDb of readDbs) {
    const pagesSnap = await getDocs(
      query(collection(libDb, 'bookPages'), where('bookId', '==', bookId))
    ).catch(() => null);
    if (pagesSnap) {
      for (const p of pagesSnap.docs) {
        await deleteDoc(doc(libDb, 'bookPages', p.id)).catch(() => {});
      }
    }
    await deleteDoc(doc(libDb, 'books', bookId)).catch(() => {});
  }
}

// ============================================================================
// BOOK WORD AUDIO CACHE IN ACTIVE LIBRARY TAB SHARD POOL
// ============================================================================

function fnv1aHex(input: string, seedOffset: number): string {
  let hash = 0x811c9dc5 ^ seedOffset;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const GLOBAL_AUDIO_POOL_DOC_ID = 'global_audio_db_pool_v1';
const LOCAL_GLOBAL_AUDIO_MIRROR_KEY = 'braem_global_audio_pool_v1';
let cachedGlobalAudioPool: TabDbShard[] | null = null;
let cachedGlobalAudioPoolAtMs = 0;

/**
 * Canonicalizes an Arabic word/phrase strictly for audio deduplication:
 * - Removes tatweel, zero-width control chars, punctuation, and verse-end markers
 * - Normalizes Unicode NFC and orders Shaddah before vowels so identical words share 1 clip
 * - STRICTLY preserves all letters, prefixes (e.g. الله vs تالله), and harakat/shaddah/sukun!
 */
export function canonicalizeArabicForAudioKey(input: string): string {
  return String(input || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[۝۞،؛:.!?؟«»"'()[\]{}<>\u06DD\u06DE]/g, ' ')
    .replace(/([\u064B-\u0650\u0652-\u065F\u0670])\u0651/g, '\u0651$1')
    .trim()
    .replace(/\s+/g, ' ');
}

export function buildGlobalWordAudioDocId(
  mode: 'noor_albayan' | 'normal',
  wordText: string,
  contextSuffix = ''
): string {
  const normalized = canonicalizeArabicForAudioKey(wordText) || wordText.trim().replace(/\s+/g, ' ');
  const cleanCtx =
    mode === 'noor_albayan'
      ? contextSuffix.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 12)
      : '';
  const modeTag = mode === 'noor_albayan' ? `fr4${cleanCtx}` : 'nm';
  const h1 = fnv1aHex(normalized, 0);
  const h2 = fnv1aHex(normalized.split('').reverse().join(''), 0x9e3779b9);
  return `gwa_${modeTag}_${h1}${h2}`.slice(0, 128);
}

export function buildWordAudioDocId(
  complexId: string,
  mode: 'noor_albayan' | 'normal',
  wordText: string,
  contextSuffix = ''
): string {
  const normalized = canonicalizeArabicForAudioKey(wordText) || wordText.trim().replace(/\s+/g, ' ');
  const cleanComplex = complexId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'cpx';
  const cleanCtx =
    mode === 'noor_albayan'
      ? contextSuffix.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 12)
      : '';
  const modeTag = mode === 'noor_albayan' ? `fr4${cleanCtx}` : 'nm';
  const h1 = fnv1aHex(normalized, 0);
  const h2 = fnv1aHex(normalized.split('').reverse().join(''), 0x9e3779b9);
  return `wa_${cleanComplex}_${modeTag}_${h1}${h2}`.slice(0, 128);
}

function readLocalGlobalAudioMirror(): Record<
  string,
  { usedBytes: number; docsCount: number; status: TabDbShard['status'] }
> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_GLOBAL_AUDIO_MIRROR_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<
      string,
      { usedBytes: number; docsCount: number; status: TabDbShard['status'] }
    >;
  } catch {
    return {};
  }
}

function writeLocalGlobalAudioMirror(shards: TabDbShard[]): void {
  if (typeof window === 'undefined') return;
  try {
    const map: Record<
      string,
      { usedBytes: number; docsCount: number; status: TabDbShard['status'] }
    > = {};
    for (const sh of shards) {
      map[sh.id] = {
        usedBytes: sh.usedBytes,
        docsCount: sh.docsCount,
        status: sh.status,
      };
    }
    window.localStorage.setItem(LOCAL_GLOBAL_AUDIO_MIRROR_KEY, JSON.stringify(map));
  } catch {
    // Non-fatal
  }
}

export async function loadGlobalAudioDbPool(forceFresh = false): Promise<TabDbShard[]> {
  if (!forceFresh && cachedGlobalAudioPool && Date.now() - cachedGlobalAudioPoolAtMs < 20_000) {
    return cachedGlobalAudioPool;
  }

  try {
    const snap = await getDocFresh(doc(primaryDb, 'dbRegistry', GLOBAL_AUDIO_POOL_DOC_ID));
    if (!snap.exists()) {
      cachedGlobalAudioPool = [];
      cachedGlobalAudioPoolAtMs = Date.now();
      return [];
    }
    const data = snap.data() as DbRegistryEntry;
    const parsed = data.mosqueConfigsJson
      ? (JSON.parse(data.mosqueConfigsJson) as { shards?: TabDbShard[] })
      : { shards: [] };
    const rawShards = Array.isArray(parsed?.shards) ? parsed.shards : [];
    const localMirror = readLocalGlobalAudioMirror();
    const merged = rawShards.map((sh) => {
      const sid = sh.id || buildDbConnectionId(sh.config);
      const loc = localMirror[sid];
      if (!loc) return sh;
      const bestUsed = Math.max(Number(sh.usedBytes) || 0, Number(loc.usedBytes) || 0);
      const bestDocs = Math.max(Number(sh.docsCount) || 0, Number(loc.docsCount) || 0);
      const maxB = Number(sh.maxBytes) || TAB_SHARD_MAX_BYTES;
      const bestStatus: TabDbShard['status'] =
        bestUsed >= maxB
          ? 'full'
          : sh.status === 'full' || loc.status === 'full'
          ? 'full'
          : sh.status;
      return {
        ...sh,
        id: sid,
        usedBytes: bestUsed,
        docsCount: bestDocs,
        status: bestStatus,
      };
    });
    const normalized = normalizeShardPoolInvariants(merged);
    cachedGlobalAudioPool = normalized;
    cachedGlobalAudioPoolAtMs = Date.now();
    return normalized;
  } catch {
    return cachedGlobalAudioPool || [];
  }
}

export async function saveGlobalAudioDbPool(shards: TabDbShard[]): Promise<TabDbShard[]> {
  const normalized = normalizeShardPoolInvariants(shards);
  const regRef = doc(primaryDb, 'dbRegistry', GLOBAL_AUDIO_POOL_DOC_ID);
  writeLocalGlobalAudioMirror(normalized);
  cachedGlobalAudioPool = normalized;
  cachedGlobalAudioPoolAtMs = Date.now();

  if (normalized.length === 0) {
    await deleteDoc(regRef).catch(() => {});
    return [];
  }

  const compactShards = normalized.map((s) => ({
    ...s,
    config: {
      apiKey: s.config.apiKey,
      projectId: s.config.projectId,
      appId: s.config.appId,
      ...(s.config.authDomain ? { authDomain: s.config.authDomain } : {}),
      ...(s.config.storageBucket ? { storageBucket: s.config.storageBucket } : {}),
      ...(s.config.messagingSenderId ? { messagingSenderId: s.config.messagingSenderId } : {}),
      ...(s.config.firestoreDatabaseId
        ? { firestoreDatabaseId: s.config.firestoreDatabaseId }
        : {}),
    },
  }));

  const serialized = JSON.stringify({ shards: compactShards });
  if (serialized.length > 31500) {
    throw new Error('عدد قواعد بيانات الأصوات تجاوز الحد الأقصى المسموح في الفهرس.');
  }

  const existingSnap = await getDocFresh(regRef).catch(() => null);
  if (existingSnap?.exists()) {
    await updateDoc(regRef, {
      name: 'سلسلة قواعد الصوتيات العامة',
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: serialized,
      active: false,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(regRef, {
      id: GLOBAL_AUDIO_POOL_DOC_ID,
      name: 'سلسلة قواعد الصوتيات العامة',
      hasExternalDb: false,
      firebaseConfigJson: '',
      mosqueConfigsJson: serialized,
      active: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  return normalized;
}

async function measureAudioDbUsage(db: Firestore): Promise<{ usedBytes: number; docsCount: number }> {
  let usedBytes = 0;
  let docsCount = 0;
  const snap = await getDocsFresh(collection(db, 'wordAudio')).catch(() => null);
  if (snap) {
    snap.forEach((d) => {
      docsCount++;
      usedBytes += estimateRecordBytes(d.data());
    });
  }
  return { usedBytes, docsCount };
}

export async function addDbToGlobalAudioPool(params: {
  config: ExternalFirebaseConfig;
  maxBytes?: number;
}): Promise<{ pool: TabDbShard[] }> {
  const { config, maxBytes = SPARK_FREE_TIER_BYTES } = params;
  const candidateDb = getFirestoreForConfig(config);
  if (candidateDb === primaryDb) {
    throw new Error('لا يمكن وضع القاعدة الأساسية ضمن قواعد الصوتيات المخصصة؛ يرجى اختيار قاعدة خارجية مستقلة.');
  }

  const candidateId = buildDbConnectionId(config);
  const existingPool = await loadGlobalAudioDbPool(true);
  if (
    existingPool.some(
      (s) => s.id === candidateId || buildDbConnectionId(s.config) === candidateId
    )
  ) {
    throw new Error('قاعدة البيانات هذه مضافة بالفعل إلى قواعد الصوتيات.');
  }

  await registerExternalDatabaseConnection(config);
  const stats = await measureAudioDbUsage(candidateDb);
  const hasAvailableActive = existingPool.some((s) => s.status === 'active');

  const newShard: TabDbShard = {
    id: candidateId,
    label: getDbDisplayLabel(config),
    config,
    usedBytes: stats.usedBytes,
    maxBytes,
    docsCount: stats.docsCount,
    status: stats.usedBytes >= maxBytes ? 'full' : hasAvailableActive ? 'standby' : 'active',
    createdAtMs: Date.now(),
  };

  const saved = await saveGlobalAudioDbPool([...existingPool, newShard]);
  return { pool: saved };
}

export async function activateGlobalAudioShard(shardId: string): Promise<TabDbShard[]> {
  const existingPool = await loadGlobalAudioDbPool(true);
  const target = existingPool.find((s) => s.id === shardId);
  if (!target) {
    throw new Error('لم يتم العثور على قاعدة الأصوات المطلوبة.');
  }
  if (target.status === 'full' || target.usedBytes >= target.maxBytes) {
    throw new Error('هذه القاعدة وصلت للحد الأقصى ولا يمكن الكتابة عليها مجدداً.');
  }
  const updated = existingPool.map((s) => ({
    ...s,
    status:
      s.status === 'full'
        ? ('full' as const)
        : s.id === shardId
        ? ('active' as const)
        : ('standby' as const),
  }));
  return saveGlobalAudioDbPool(updated);
}

export async function removeShardFromGlobalAudioPool(shardId: string): Promise<TabDbShard[]> {
  const existingPool = await loadGlobalAudioDbPool(true);
  const filtered = existingPool.filter((s) => s.id !== shardId);
  return saveGlobalAudioDbPool(filtered);
}

export async function recalculateGlobalAudioPoolUsage(): Promise<TabDbShard[]> {
  const existingPool = await loadGlobalAudioDbPool(true);
  if (existingPool.length === 0) return [];
  const recalculated: TabDbShard[] = [];
  for (const sh of existingPool) {
    const sDb = getFirestoreForConfig(sh.config);
    const stats = await measureAudioDbUsage(sDb);
    const isFull = stats.usedBytes >= sh.maxBytes;
    recalculated.push({
      ...sh,
      usedBytes: stats.usedBytes,
      docsCount: stats.docsCount,
      status: isFull ? 'full' : sh.status === 'full' ? 'standby' : sh.status,
    });
  }
  return saveGlobalAudioDbPool(recalculated);
}

export async function migrateGlobalAudioShard(params: {
  sourceShardId: string;
  destConfig: ExternalFirebaseConfig;
  removeSourceAfterMigration?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<{ movedDocsCount: number; pool: TabDbShard[] }> {
  const { sourceShardId, destConfig, removeSourceAfterMigration = true, onProgress } = params;
  const existingPool = await loadGlobalAudioDbPool(true);
  const sourceShard = existingPool.find((s) => s.id === sourceShardId);
  if (!sourceShard) {
    throw new Error('القاعدة المصدر غير موجودة في سلسلة قواعد الصوتيات.');
  }
  const destId = buildDbConnectionId(destConfig);
  if (destId === sourceShard.id) {
    throw new Error('القاعدة البديلة مطابقة تماماً للقاعدة المصدر.');
  }
  const sourceDb = getFirestoreForConfig(sourceShard.config);
  const destDb = getFirestoreForConfig(destConfig);
  if (destDb === primaryDb) {
    throw new Error('لا يمكن نقل قواعد الصوتيات إلى القاعدة الأساسية.');
  }

  await registerExternalDatabaseConnection(destConfig);
  let movedDocsCount = 0;
  onProgress?.('جاري قراءة مقاطع الصوت من القاعدة المصدر...');
  const snap = await getDocsFresh(collection(sourceDb, 'wordAudio')).catch(() => null);
  if (snap) {
    let idx = 0;
    for (const d of snap.docs) {
      idx++;
      if (idx % 10 === 0) {
        onProgress?.(`جاري نقل الصوتيات (${idx}/${snap.size})...`);
      }
      const data = d.data() as Record<string, unknown>;
      await copyDocWithTimestamp(destDb, 'wordAudio', d.id, data);
      await deleteDoc(doc(sourceDb, 'wordAudio', d.id)).catch(() => {});
      movedDocsCount++;
    }
  }

  const destStats = await measureAudioDbUsage(destDb);
  const srcWasActive = sourceShard.status === 'active';
  const existingDestIdx = existingPool.findIndex(
    (s) => s.id === destId || buildDbConnectionId(s.config) === destId
  );

  let nextPool: TabDbShard[];
  if (existingDestIdx >= 0) {
    nextPool = existingPool
      .map((s) => {
        if (s.id === existingPool[existingDestIdx].id) {
          return {
            ...s,
            usedBytes: destStats.usedBytes,
            docsCount: destStats.docsCount,
            status:
              destStats.usedBytes >= s.maxBytes
                ? ('full' as const)
                : srcWasActive
                ? ('active' as const)
                : s.status,
          };
        }
        if (s.id === sourceShardId && !removeSourceAfterMigration) {
          return { ...s, usedBytes: 0, docsCount: 0, status: 'standby' as const };
        }
        return s;
      })
      .filter((s) => !(removeSourceAfterMigration && s.id === sourceShardId));
  } else {
    const replacementShard: TabDbShard = {
      id: destId,
      label: getDbDisplayLabel(destConfig),
      config: destConfig,
      usedBytes: destStats.usedBytes,
      maxBytes: sourceShard.maxBytes || SPARK_FREE_TIER_BYTES,
      docsCount: destStats.docsCount,
      status:
        destStats.usedBytes >= (sourceShard.maxBytes || SPARK_FREE_TIER_BYTES)
          ? 'full'
          : srcWasActive
          ? 'active'
          : 'standby',
      createdAtMs: Date.now(),
    };
    nextPool = removeSourceAfterMigration
      ? existingPool.map((s) => (s.id === sourceShardId ? replacementShard : s))
      : [
          ...existingPool.map((s) =>
            s.id === sourceShardId ? { ...s, usedBytes: 0, docsCount: 0, status: 'standby' as const } : s
          ),
          replacementShard,
        ];
  }

  const saved = await saveGlobalAudioDbPool(nextPool);
  return { movedDocsCount, pool: saved };
}

export async function migrateLegacyWordAudioToGlobalPool(
  onProgress?: (msg: string) => void
): Promise<{ movedCount: number }> {
  const globalPool = await loadGlobalAudioDbPool(true);
  if (globalPool.length === 0) {
    throw new Error('يرجى ربط قاعدة بيانات واحدة على الأقل في قسم «قواعد الأصوات» أولاً.');
  }
  const globalDbKeys = new Set(globalPool.map((s) => dbKeyFromConfig(s.config)));
  const targets = await getAllKnownDatabases();
  let movedCount = 0;

  for (const t of targets) {
    if (globalDbKeys.has(t.key)) continue;
    onProgress?.(`فحص الصوتيات السابقة في ${t.label}...`);
    const snap = await getDocsFresh(collection(t.db, 'wordAudio')).catch(() => null);
    if (!snap || snap.empty) continue;
    for (const d of snap.docs) {
      const rec = d.data() as BookWordAudioRecord;
      if (!rec || !rec.wordText) continue;
      const gId = buildGlobalWordAudioDocId(
        rec.mode === 'normal' ? 'normal' : 'noor_albayan',
        rec.wordText
      );
      const payload = { ...rec, id: gId };
      const bytes = estimateRecordBytes(payload);
      await executeGlobalAudioWriteWithRollover(bytes, true, async (destDb) => {
        await copyDocWithTimestamp(destDb, 'wordAudio', gId, payload as unknown as Record<string, unknown>);
      });
      await deleteDoc(doc(t.db, 'wordAudio', d.id)).catch(() => {});
      movedCount++;
    }
  }
  await recalculateGlobalAudioPoolUsage();
  return { movedCount };
}

async function resolveWriteShardForGlobalAudio(
  incomingBytes: number
): Promise<{ db: Firestore; shard: TabDbShard }> {
  const pool = await loadGlobalAudioDbPool();
  const workingPool = pool.map((s) => ({ ...s }));
  let current =
    workingPool.find((s) => s.status === 'active') ||
    workingPool.find((s) => s.status !== 'full') ||
    null;

  if (
    !current ||
    current.status === 'full' ||
    current.usedBytes + incomingBytes > current.maxBytes
  ) {
    if (current) {
      current.status = 'full';
    }
    const candidate = workingPool.find(
      (s) => s.id !== current?.id && s.status !== 'full' && s.usedBytes + incomingBytes <= s.maxBytes
    );
    if (!candidate) {
      await saveGlobalAudioDbPool(workingPool).catch(() => {});
      throw new Error(
        'امتلأت جميع قواعد البيانات المخصصة للصوتيات. يرجى ربط قاعدة أصوات جديدة في لوحة المبرمج.'
      );
    }
    candidate.status = 'active';
    current = candidate;
    await saveGlobalAudioDbPool(workingPool).catch(() => {});
  }

  const writeDb = getFirestoreForConfig(current.config);
  if (writeDb === primaryDb) {
    throw new Error('حماية العزل: لا يمكن حفظ الصوتيات المخصصة داخل القاعدة الأساسية.');
  }
  return { db: writeDb, shard: current };
}

async function executeGlobalAudioWriteWithRollover<T>(
  incomingBytes: number,
  isNewDoc: boolean,
  writeFn: (targetDb: Firestore, shard: TabDbShard) => Promise<T>
): Promise<T> {
  const first = await resolveWriteShardForGlobalAudio(incomingBytes);
  try {
    const res = await writeFn(first.db, first.shard);
    const pool = (await loadGlobalAudioDbPool()).map((s) => {
      if (s.id !== first.shard.id) return s;
      const nextUsed = Math.max(0, s.usedBytes + incomingBytes);
      const isNowFull = nextUsed >= s.maxBytes;
      return {
        ...s,
        usedBytes: nextUsed,
        docsCount: Math.max(0, s.docsCount + (isNewDoc ? 1 : 0)),
        status: isNowFull ? ('full' as const) : s.status,
      };
    });
    const curAfter = pool.find((s) => s.id === first.shard.id);
    if (curAfter && curAfter.status === 'full') {
      const nextStandby = pool.find((s) => s.id !== curAfter.id && s.status !== 'full');
      if (nextStandby) nextStandby.status = 'active';
    }
    await saveGlobalAudioDbPool(pool).catch(() => {});
    return res;
  } catch (err) {
    if (isQuotaOrFullError(err)) {
      const rolledPool = (await loadGlobalAudioDbPool()).map((s) =>
        s.id === first.shard.id ? { ...s, usedBytes: s.maxBytes, status: 'full' as const } : s
      );
      await saveGlobalAudioDbPool(rolledPool).catch(() => {});
      const next = await resolveWriteShardForGlobalAudio(incomingBytes);
      const retryRes = await writeFn(next.db, next.shard);
      const finalPool = (await loadGlobalAudioDbPool()).map((s) =>
        s.id === next.shard.id
          ? {
              ...s,
              usedBytes: Math.max(0, s.usedBytes + incomingBytes),
              docsCount: Math.max(0, s.docsCount + (isNewDoc ? 1 : 0)),
            }
          : s
      );
      await saveGlobalAudioDbPool(finalPool).catch(() => {});
      return retryRes;
    }
    throw err;
  }
}

export async function listAllSavedWordAudioEntries(): Promise<SavedWordAudioBrowserItem[]> {
  const items: SavedWordAudioBrowserItem[] = [];
  const seenKeyDoc = new Set<string>();
  const globalPool = await loadGlobalAudioDbPool(true);

  for (const sh of globalPool) {
    const dbKey = dbKeyFromConfig(sh.config);
    const sDb = getFirestoreForConfig(sh.config);
    const snap = await getDocsFresh(collection(sDb, 'wordAudio')).catch(() => null);
    if (!snap) continue;
    snap.forEach((d) => {
      const rec = d.data() as BookWordAudioRecord;
      const uniqueKey = `${dbKey}::${d.id}`;
      if (seenKeyDoc.has(uniqueKey)) return;
      seenKeyDoc.add(uniqueKey);
      items.push({
        docId: d.id,
        record: rec,
        dbKey,
        dbLabel: `قاعدة أصوات: ${sh.label}`,
        isGlobalPool: true,
        config: sh.config,
        approxBytes: Number(rec.byteSize) || estimateRecordBytes(rec),
      });
    });
  }

  const targets = await getAllKnownDatabases();
  for (const t of targets) {
    const snap = await getDocsFresh(collection(t.db, 'wordAudio')).catch(() => null);
    if (!snap) continue;
    snap.forEach((d) => {
      const rec = d.data() as BookWordAudioRecord;
      const uniqueKey = `${t.key}::${d.id}`;
      if (seenKeyDoc.has(uniqueKey)) return;
      seenKeyDoc.add(uniqueKey);
      items.push({
        docId: d.id,
        record: rec,
        dbKey: t.key,
        dbLabel: t.label,
        isGlobalPool: false,
        config: t.config,
        approxBytes: Number(rec.byteSize) || estimateRecordBytes(rec),
      });
    });
  }

  return items.sort((a, b) => {
    const aSec = (a.record.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
    const bSec = (b.record.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
    if (bSec !== aSec) return bSec - aSec;
    return String(a.record.wordText || '').localeCompare(String(b.record.wordText || ''), 'ar');
  });
}

export async function deleteSavedWordAudioEntry(item: SavedWordAudioBrowserItem): Promise<void> {
  const hostDb = item.config ? getFirestoreForConfig(item.config) : primaryDb;
  await deleteDoc(doc(hostDb, 'wordAudio', item.docId));
  if (item.isGlobalPool) {
    await recalculateGlobalAudioPoolUsage().catch(() => {});
  }
}

export async function overwriteSavedWordAudioEntry(params: {
  item: SavedWordAudioBrowserItem;
  diacritizedWord: string;
  wasAutoDiacritized: boolean;
  fullReading: string;
  steps: { part: string; ruleLabel: string; reading: string }[];
  audioBase64: string;
  mimeType: string;
}): Promise<BookWordAudioRecord> {
  const hostDb = params.item.config ? getFirestoreForConfig(params.item.config) : primaryDb;
  const shrunk = shrinkWavBase64ForDb(params.audioBase64 || '', params.mimeType || 'audio/wav');
  const cleanSteps = (Array.isArray(params.steps) ? params.steps : []).slice(0, 60).map((s) => ({
    part: String(s.part || '').slice(0, 80),
    ruleLabel: String(s.ruleLabel || '').slice(0, 140),
    reading: String(s.reading || '').slice(0, 180),
  }));

  const updatedFields = {
    diacritizedWord: String(params.diacritizedWord || params.item.record.wordText).slice(0, 1200),
    wasAutoDiacritized: Boolean(params.wasAutoDiacritized),
    fullReading: String(params.fullReading || params.item.record.wordText).slice(0, 2500),
    steps: cleanSteps,
    audioBase64: shrunk.audioBase64,
    mimeType: shrunk.mimeType || 'audio/wav',
  };
  const byteSize = estimateRecordBytes({
    ...params.item.record,
    ...updatedFields,
  });

  await updateDoc(doc(hostDb, 'wordAudio', params.item.docId), {
    ...updatedFields,
    byteSize,
    updatedAt: serverTimestamp(),
  });

  if (params.item.isGlobalPool) {
    await recalculateGlobalAudioPoolUsage().catch(() => {});
  }

  return {
    ...params.item.record,
    ...updatedFields,
    byteSize,
  };
}

/**
 * Searches Global Audio DB Pool (when configured), OR Presentations/Library DB shards,
 * using canonicalized Arabic vocalized text so shared words (like اللَّهُ) are reused globally across devices,
 * while distinct prefixes/harakat (like تَاللَّهِ vs اللَّهِ) remain strictly separate.
 */
export async function lookupWordAudioAcrossLibrary(
  workspace: ComplexWorkspaceData,
  mode: 'noor_albayan' | 'normal',
  wordText: string,
  contextSuffix = '',
  options?: { preferredTabKey?: 'library' | 'presentations' }
): Promise<BookWordAudioRecord | null> {
  const cleanText = canonicalizeArabicForAudioKey(wordText) || wordText.trim().replace(/\s+/g, ' ');
  if (!cleanText) return null;

  const globalDocId = buildGlobalWordAudioDocId(mode, cleanText, contextSuffix);
  const legacyDocId = buildWordAudioDocId(workspace.complex.id, mode, cleanText, contextSuffix);

  const searchDbsForDoc = async (dbs: Firestore[]): Promise<BookWordAudioRecord | null> => {
    const results = await Promise.all(
      dbs.map(async (targetDb) => {
        try {
          const gSnap = await getDoc(doc(targetDb, 'wordAudio', globalDocId)).catch(() => null);
          if (gSnap?.exists()) return gSnap.data() as BookWordAudioRecord;
          const lSnap = await getDoc(doc(targetDb, 'wordAudio', legacyDocId)).catch(() => null);
          if (lSnap?.exists()) return lSnap.data() as BookWordAudioRecord;
          return null;
        } catch {
          return null;
        }
      })
    );
    const withAudio = results.find((r) => r && r.audioBase64 && r.audioBase64.length > 120);
    if (withAudio) return withAudio;
    return results.find((r) => Boolean(r)) || null;
  };

  try {
    // 1. Check Global Audio DB Pool first (ordered active -> standby/full shards)
    const globalPool = await loadGlobalAudioDbPool();
    if (globalPool.length > 0) {
      const orderedGlobal = [
        ...globalPool.filter((s) => s.status === 'active'),
        ...globalPool.filter((s) => s.status !== 'active'),
      ];
      const globalDbs = orderedGlobal
        .map((s) => getFirestoreForConfig(s.config))
        .filter((d) => d !== primaryDb);

      const globalHit = await searchDbsForDoc(globalDbs);
      if (globalHit) return globalHit;

      // Also scan by exact normalized wordText in case docId came from another context
      for (const gDb of globalDbs) {
        const qSnap = await getDocs(
          query(
            collection(gDb, 'wordAudio'),
            where('wordText', '==', cleanText),
            where('mode', '==', mode)
          )
        ).catch(() => null);
        const hitDoc = qSnap?.docs.find((d) => {
          const rec = d.data() as BookWordAudioRecord;
          return rec && rec.audioBase64 && rec.audioBase64.length > 120;
        });
        if (hitDoc) return hitDoc.data() as BookWordAudioRecord;
      }
      return null;
    }

    // 2. If Presentations has its own isolated DB and caller is from Presentations, search there
    const hasIsolatedPresentations =
      Boolean(workspace.tabPools?.presentations?.length) ||
      Boolean(workspace.tabConfigMap?.presentations);
    if (options?.preferredTabKey === 'presentations' && hasIsolatedPresentations) {
      const presDbs = getReadDbsForComplexTab(workspace, 'presentations');
      const presHit = await searchDbsForDoc(presDbs);
      if (presHit) return presHit;
    }

    // 3. Fallback to complex's Library DB shards
    const readDbs = getReadDbsForComplexTab(workspace, 'library');
    return await searchDbsForDoc(readDbs);
  } catch {
    return null;
  }
}

/**
 * Persists a newly generated word/tahajji pronunciation + audio WAV into:
 * 1) Global Audio DB Pool (strictly isolated from primary/tab DBs) if configured,
 * 2) Presentations dedicated DB if preferredTabKey === 'presentations' and Presentations is isolated,
 * 3) Complex's active `library` DB shard otherwise.
 */
export async function saveWordAudioToLibraryDb(params: {
  workspace: ComplexWorkspaceData;
  mode: 'noor_albayan' | 'normal';
  wordText: string;
  diacritizedWord: string;
  wasAutoDiacritized: boolean;
  fullReading: string;
  steps: { part: string; ruleLabel: string; reading: string }[];
  audioBase64: string;
  mimeType: string;
  createdBy?: string;
  contextSuffix?: string;
  preferredTabKey?: 'library' | 'presentations';
}): Promise<BookWordAudioRecord | null> {
  const { workspace, mode, wordText, diacritizedWord, wasAutoDiacritized, fullReading, steps } =
    params;
  const cleanText = (
    canonicalizeArabicForAudioKey(wordText) || wordText.trim().replace(/\s+/g, ' ')
  ).slice(0, 1200);
  if (!cleanText) return null;

  const docId = buildGlobalWordAudioDocId(mode, cleanText, params.contextSuffix || '');
  const shrunk = shrinkWavBase64ForDb(params.audioBase64 || '', params.mimeType || 'audio/wav');
  const cleanSteps = (Array.isArray(steps) ? steps : []).slice(0, 60).map((s) => ({
    part: String(s.part || '').slice(0, 80),
    ruleLabel: String(s.ruleLabel || '').slice(0, 140),
    reading: String(s.reading || '').slice(0, 180),
  }));

  const payloadBase = {
    id: docId,
    complexId: workspace.complex.id,
    mode,
    wordText: cleanText,
    diacritizedWord: String(diacritizedWord || cleanText).slice(0, 1200),
    wasAutoDiacritized: Boolean(wasAutoDiacritized),
    fullReading: String(fullReading || cleanText).slice(0, 2500),
    steps: cleanSteps,
    audioBase64: shrunk.audioBase64,
    mimeType: shrunk.mimeType || 'audio/wav',
    createdBy: (auth.currentUser?.uid || params.createdBy || 'reader').slice(0, 128),
  };

  const byteSize = estimateRecordBytes(payloadBase);
  const record: BookWordAudioRecord = {
    ...payloadBase,
    byteSize,
  };

  try {
    // Priority 1: Global Audio DB Pool (never writes to primaryDb or tab DBs!)
    const globalPool = await loadGlobalAudioDbPool();
    if (globalPool.length > 0) {
      const orderedGlobal = [
        ...globalPool.filter((s) => s.status === 'active'),
        ...globalPool.filter((s) => s.status !== 'active'),
      ];
      for (const sh of orderedGlobal) {
        const gDb = getFirestoreForConfig(sh.config);
        const snap = await getDocFresh(doc(gDb, 'wordAudio', docId)).catch(() => null);
        if (snap?.exists()) {
          if (shrunk.audioBase64.length > 120) {
            await updateDoc(doc(gDb, 'wordAudio', docId), {
              diacritizedWord: record.diacritizedWord,
              wasAutoDiacritized: record.wasAutoDiacritized,
              fullReading: record.fullReading,
              steps: record.steps,
              audioBase64: record.audioBase64,
              mimeType: record.mimeType,
              byteSize: record.byteSize,
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }
          return record;
        }
      }

      await executeGlobalAudioWriteWithRollover(byteSize, true, async (targetDb) => {
        await setDoc(doc(targetDb, 'wordAudio', docId), {
          ...record,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      return record;
    }

    // Priority 2: Presentations isolated DB if caller is from Presentations & isolated DB exists
    const hasIsolatedPresentations =
      Boolean(workspace.tabPools?.presentations?.length) ||
      Boolean(workspace.tabConfigMap?.presentations);
    const targetTabKey: ComplexFeatureTabKey =
      params.preferredTabKey === 'presentations' && hasIsolatedPresentations
        ? 'presentations'
        : 'library';

    const existingLoc = await findExistingDocInTabPool(workspace, targetTabKey, 'wordAudio', docId);
    if (existingLoc.exists) {
      if (shrunk.audioBase64.length > 120) {
        await updateDoc(doc(existingLoc.db, 'wordAudio', docId), {
          diacritizedWord: record.diacritizedWord,
          wasAutoDiacritized: record.wasAutoDiacritized,
          fullReading: record.fullReading,
          steps: record.steps,
          audioBase64: record.audioBase64,
          mimeType: record.mimeType,
          byteSize: record.byteSize,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
      return record;
    }

    await executeTabWriteWithRollover(workspace, targetTabKey, byteSize, true, async (targetDb) => {
      await setDoc(doc(targetDb, 'wordAudio', docId), {
        ...record,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
    return record;
  } catch {
    return null;
  }
}

// ============================================================================
// ATTENDANCE & ABSENCE (الحضور والغياب)
// ============================================================================

export function buildAttendanceDocId(halaqaId: string, dateKey: string): string {
  const cleanHalaqa = halaqaId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanDate = dateKey.replace(/[^0-9-]/g, '');
  return `att_${cleanHalaqa}_${cleanDate}`.slice(0, 128);
}

function sanitizeAttendanceEntries(entries: AttendanceEntry[]): AttendanceEntry[] {
  const validStatuses = new Set<AttendanceStatus>(['present', 'absent', 'excused', 'late']);
  return entries.slice(0, 200).map((e) => ({
    studentId: String(e.studentId || '').slice(0, 128),
    studentName: String(e.studentName || 'طالب').trim().slice(0, 120) || 'طالب',
    status: validStatuses.has(e.status) ? e.status : 'present',
    note: String(e.note || '').trim().slice(0, 200),
  }));
}

export async function loadAttendanceRecord(
  workspace: ComplexWorkspaceData,
  halaqaId: string,
  dateKey: string
): Promise<AttendanceRecord | null> {
  const readDbs = getReadDbsForComplexTab(workspace, 'attendance');
  const docId = buildAttendanceDocId(halaqaId, dateKey);
  for (const db of readDbs) {
    const snap = await getDocFresh(doc(db, 'attendance', docId)).catch(() => null);
    if (snap?.exists()) return snap.data() as AttendanceRecord;
  }
  return null;
}

export async function listAttendanceHistory(
  workspace: ComplexWorkspaceData,
  options?: { halaqaId?: string; mosqueIds?: string[] }
): Promise<AttendanceRecord[]> {
  try {
    const readDbs = getReadDbsForComplexTab(workspace, 'attendance');
    const allowedMosques =
      options?.mosqueIds && options.mosqueIds.length > 0 ? new Set(options.mosqueIds) : null;
    const byId = new Map<string, AttendanceRecord>();
    await Promise.all(
      readDbs.map(async (db) => {
        const snap = await getDocsFresh(
          query(collection(db, 'attendance'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null);
        snap?.forEach((d) => {
          const rec = d.data() as AttendanceRecord;
          if (options?.halaqaId && rec.halaqaId !== options.halaqaId) return;
          if (allowedMosques && !allowedMosques.has(rec.mosqueId)) return;
          byId.set(rec.id, rec);
        });
      })
    );
    return Array.from(byId.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  } catch {
    return [];
  }
}

export async function saveAttendanceRecord(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  dateKey: string;
  entries: AttendanceEntry[];
  recordedBy: string;
  recordedByName: string;
}): Promise<AttendanceRecord> {
  const { workspace, mosqueId, halaqaId, dateKey, entries, recordedBy, recordedByName } = params;
  if (!mosqueId || !halaqaId) {
    throw new Error('يرجى تحديد المسجد والحلقة أولاً.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('صيغة التاريخ غير صالحة.');
  }

  const id = buildAttendanceDocId(halaqaId, dateKey);
  const cleanEntries = sanitizeAttendanceEntries(entries);
  const cleanRecorder = (recordedBy || auth.currentUser?.uid || 'supervisor').slice(0, 128);
  const cleanRecorderName = (recordedByName || 'المشرف').trim().slice(0, 120) || 'المشرف';

  const located = await findExistingDocInTabPool(workspace, 'attendance', 'attendance', id);
  if (located.exists) {
    await updateDoc(doc(located.db, 'attendance', id), {
      entries: cleanEntries,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id,
      complexId: workspace.complex.id,
      mosqueId,
      halaqaId,
      dateKey,
      entries: cleanEntries,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
    };
    const byteSize = estimateRecordBytes(payload);
    await executeTabWriteWithRollover(workspace, 'attendance', byteSize, true, async (targetDb) => {
      await setDoc(doc(targetDb, 'attendance', id), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  }

  return {
    id,
    complexId: workspace.complex.id,
    mosqueId,
    halaqaId,
    dateKey,
    entries: cleanEntries,
    recordedBy: cleanRecorder,
    recordedByName: cleanRecorderName,
  };
}

// ============================================================================
// CURRICULA (المقررات)
// ============================================================================

export async function listCurriculaInComplex(
  workspace: ComplexWorkspaceData
): Promise<CurriculumRecord[]> {
  try {
    const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
    const byId = new Map<string, CurriculumRecord>();
    await Promise.all(
      readDbs.map(async (db) => {
        const snap = await getDocsFresh(
          query(collection(db, 'curricula'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null);
        snap?.forEach((d) => {
          const rec = d.data() as CurriculumRecord;
          if (rec.active !== false) {
            byId.set(rec.id, rec);
          }
        });
      })
    );
    return Array.from(byId.values()).sort((a, b) => {
      const aSec = (a.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
      const bSec = (b.updatedAt as { seconds?: number } | undefined)?.seconds || 0;
      return bSec - aSec;
    });
  } catch {
    return [];
  }
}

export async function saveCurriculumRecord(params: {
  workspace: ComplexWorkspaceData;
  id?: string;
  bookId: string;
  bookTitle: string;
  halaqaIds: string[];
  mosqueIds: string[];
  days: WeekDayKey[];
  scheduleNote?: string;
  createdBy: string;
}): Promise<CurriculumRecord> {
  const { workspace, id, bookId, bookTitle, halaqaIds, mosqueIds, days, scheduleNote, createdBy } =
    params;

  const cleanHalaqaIds = Array.from(new Set(halaqaIds.filter(Boolean))).slice(0, 100);
  const cleanMosqueIds = Array.from(new Set(mosqueIds.filter(Boolean))).slice(0, 50);
  const validDaysSet = new Set<WeekDayKey>(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']);
  const cleanDays = Array.from(new Set(days.filter((d) => validDaysSet.has(d)))).slice(0, 7);

  if (!bookId || !bookTitle.trim()) {
    throw new Error('يرجى اختيار الكتاب أو المصحف الشريف للمقرر.');
  }
  if (cleanHalaqaIds.length === 0) {
    throw new Error('يرجى اختيار حلقة واحدة على الأقل لهذا المقرر.');
  }
  if (cleanDays.length === 0) {
    throw new Error('يرجى تحديد أيام الأسبوع الخاصة بهذا المقرر.');
  }

  const recordId = id || generateValidId('cur');
  const cleanTitle = bookTitle.trim().slice(0, 160);
  const cleanNote = (scheduleNote || '').trim().slice(0, 240);
  const cleanCreator = (createdBy || auth.currentUser?.uid || 'supervisor').slice(0, 128);

  const located = id
    ? await findExistingDocInTabPool(workspace, 'curricula', 'curricula', recordId)
    : { exists: false, db: workspace.complexDb, shard: null };

  if (located.exists) {
    await updateDoc(doc(located.db, 'curricula', recordId), {
      bookId,
      bookTitle: cleanTitle,
      halaqaIds: cleanHalaqaIds,
      mosqueIds: cleanMosqueIds,
      days: cleanDays,
      scheduleNote: cleanNote,
      active: true,
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id: recordId,
      complexId: workspace.complex.id,
      bookId,
      bookTitle: cleanTitle,
      halaqaIds: cleanHalaqaIds,
      mosqueIds: cleanMosqueIds,
      days: cleanDays,
      scheduleNote: cleanNote,
      active: true,
      createdBy: cleanCreator,
    };
    const byteSize = estimateRecordBytes(payload);
    await executeTabWriteWithRollover(workspace, 'curricula', byteSize, true, async (targetDb) => {
      await setDoc(doc(targetDb, 'curricula', recordId), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  }

  return {
    id: recordId,
    complexId: workspace.complex.id,
    bookId,
    bookTitle: cleanTitle,
    halaqaIds: cleanHalaqaIds,
    mosqueIds: cleanMosqueIds,
    days: cleanDays,
    scheduleNote: cleanNote,
    active: true,
    createdBy: cleanCreator,
  };
}

export async function deleteCurriculumRecord(
  workspace: ComplexWorkspaceData,
  curriculumId: string
): Promise<void> {
  const located = await findExistingDocInTabPool(workspace, 'curricula', 'curricula', curriculumId);
  await deleteDoc(doc(located.db, 'curricula', curriculumId));
}

// ============================================================================
// PER-TAB EXTERNAL DB ISOLATION, CLONE BACKUP, AND JSON / ZIP EXPORT-IMPORT
// ============================================================================

async function copyDocWithTimestamp(
  destDb: Firestore,
  colName: string,
  docId: string,
  rawData: Record<string, unknown>
): Promise<void> {
  const payload = { ...rawData };
  delete payload.createdAt;
  delete payload.updatedAt;
  await upsertTransferredDoc(destDb, colName, docId, payload);
}

async function measureTabUsageOnDb(
  db: Firestore,
  complexId: string,
  tabKey: ComplexFeatureTabKey
): Promise<{ usedBytes: number; docsCount: number }> {
  let usedBytes = 0;
  let docsCount = 0;
  const colMap: Record<ComplexFeatureTabKey, string[]> = {
    attendance: ['attendance'],
    curricula: ['curricula', 'studentQuranPlans', 'studentMushafMistakes', 'studentBookPlans'],
    presentations: ['presentations', 'wordAudio'],
    library: ['books', 'bookPages', 'wordAudio'],
    mosques_halaqat: ['mosques', 'halaqat'],
    accounts_invites: ['accounts', 'inviteLinks', 'quickLinks'],
  };

  for (const colName of colMap[tabKey]) {
    const snap = await getDocsFresh(
      query(collection(db, colName), where('complexId', '==', complexId))
    ).catch(() => null);
    if (!snap) continue;
    snap.forEach((d) => {
      docsCount++;
      usedBytes += estimateRecordBytes(d.data());
    });
  }
  return { usedBytes, docsCount };
}

async function migrateSingleTabRecords(params: {
  complexId: string;
  tabKey: ComplexFeatureTabKey;
  sourceDbs: Firestore[];
  destDb: Firestore;
  onProgress?: (msg: string) => void;
}): Promise<{ movedCount: number; movedBytes: number }> {
  const { complexId, tabKey, sourceDbs, destDb, onProgress } = params;
  const uniqueSources = Array.from(new Set(sourceDbs));
  let movedCount = 0;
  let movedBytes = 0;

  if (tabKey === 'attendance') {
    for (const sDb of uniqueSources) {
      const snap = await getDocsFresh(
        query(collection(sDb, 'attendance'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        movedBytes += estimateRecordBytes(data);
        if (sDb !== destDb) {
          await copyDocWithTimestamp(destDb, 'attendance', d.id, data);
          await deleteDoc(doc(sDb, 'attendance', d.id)).catch(() => {});
        }
        movedCount++;
      }
    }
    if (destDb !== primaryDb) {
      const pSnap = await getDocs(
        query(collection(primaryDb, 'attendance'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (pSnap) {
        for (const d of pSnap.docs) {
          await deleteDoc(doc(primaryDb, 'attendance', d.id)).catch(() => {});
        }
      }
    }
    return { movedCount, movedBytes };
  }

  if (tabKey === 'curricula') {
    for (const sDb of uniqueSources) {
      for (const colName of [
        'curricula',
        'studentQuranPlans',
        'studentMushafMistakes',
        'studentBookPlans',
      ]) {
        const snap = await getDocsFresh(
          query(collection(sDb, colName), where('complexId', '==', complexId))
        ).catch(() => null);
        if (!snap) continue;
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          movedBytes += estimateRecordBytes(data);
          if (sDb !== destDb) {
            await copyDocWithTimestamp(destDb, colName, d.id, data);
            await deleteDoc(doc(sDb, colName, d.id)).catch(() => {});
          }
          movedCount++;
        }
      }
    }
    if (destDb !== primaryDb) {
      for (const colName of [
        'curricula',
        'studentQuranPlans',
        'studentMushafMistakes',
        'studentBookPlans',
      ]) {
        const pSnap = await getDocs(
          query(collection(primaryDb, colName), where('complexId', '==', complexId))
        ).catch(() => null);
        if (pSnap) {
          for (const d of pSnap.docs) {
            await deleteDoc(doc(primaryDb, colName, d.id)).catch(() => {});
          }
        }
      }
    }
    return { movedCount, movedBytes };
  }

  if (tabKey === 'presentations') {
    for (const sDb of uniqueSources) {
      onProgress?.('جاري نقل العروض التقديمية التفاعلية...');
      const snap = await getDocsFresh(
        query(collection(sDb, 'presentations'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        movedBytes += estimateRecordBytes(data);
        if (sDb !== destDb) {
          await copyDocWithTimestamp(destDb, 'presentations', d.id, data);
          await deleteDoc(doc(sDb, 'presentations', d.id)).catch(() => {});
        }
        movedCount++;
      }
    }
    if (destDb !== primaryDb) {
      const pSnap = await getDocs(
        query(collection(primaryDb, 'presentations'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (pSnap) {
        for (const d of pSnap.docs) {
          await deleteDoc(doc(primaryDb, 'presentations', d.id)).catch(() => {});
        }
      }
    }
    return { movedCount, movedBytes };
  }

  if (tabKey === 'library') {
    for (const sDb of uniqueSources) {
      onProgress?.('جاري نقل فهارس الكتب...');
      const booksSnap = await getDocsFresh(
        query(collection(sDb, 'books'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (booksSnap) {
        for (const d of booksSnap.docs) {
          const data = d.data() as Record<string, unknown>;
          movedBytes += estimateRecordBytes(data);
          if (sDb !== destDb) {
            await copyDocWithTimestamp(destDb, 'books', d.id, data);
            await deleteDoc(doc(sDb, 'books', d.id)).catch(() => {});
          }
          movedCount++;
        }
      }

      onProgress?.('جاري نقل صفحات الكتب المصورة...');
      const pagesSnap = await getDocsFresh(
        query(collection(sDb, 'bookPages'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (pagesSnap) {
        for (const d of pagesSnap.docs) {
          const data = d.data() as Record<string, unknown>;
          movedBytes += estimateRecordBytes(data);
          if (sDb !== destDb) {
            await setDoc(doc(destDb, 'bookPages', d.id), {
              ...data,
              updatedAt: serverTimestamp(),
            });
            await deleteDoc(doc(sDb, 'bookPages', d.id)).catch(() => {});
          }
          movedCount++;
        }
      }

      onProgress?.('جاري نقل مقاطع الصوت والتهجي المحفوظة...');
      const audioSnap = await getDocsFresh(
        query(collection(sDb, 'wordAudio'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (audioSnap) {
        for (const d of audioSnap.docs) {
          const data = d.data() as Record<string, unknown>;
          movedBytes += estimateRecordBytes(data);
          if (sDb !== destDb) {
            await copyDocWithTimestamp(destDb, 'wordAudio', d.id, data);
            await deleteDoc(doc(sDb, 'wordAudio', d.id)).catch(() => {});
          }
          movedCount++;
        }
      }
    }
    if (destDb !== primaryDb) {
      for (const colName of ['books', 'bookPages', 'wordAudio']) {
        const pSnap = await getDocs(
          query(collection(primaryDb, colName), where('complexId', '==', complexId))
        ).catch(() => null);
        if (pSnap) {
          for (const d of pSnap.docs) {
            await deleteDoc(doc(primaryDb, colName, d.id)).catch(() => {});
          }
        }
      }
    }
    return { movedCount, movedBytes };
  }

  if (tabKey === 'mosques_halaqat') {
    for (const sDb of uniqueSources) {
      for (const colName of ['mosques', 'halaqat']) {
        const snap = await getDocsFresh(
          query(collection(sDb, colName), where('complexId', '==', complexId))
        ).catch(() => null);
        if (!snap) continue;
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          movedBytes += estimateRecordBytes(data);
          if (sDb !== destDb) {
            await copyDocWithTimestamp(destDb, colName, d.id, data);
            await deleteDoc(doc(sDb, colName, d.id)).catch(() => {});
          }
          movedCount++;
        }
      }
    }
    if (destDb !== primaryDb) {
      for (const colName of ['mosques', 'halaqat']) {
        const pSnap = await getDocs(
          query(collection(primaryDb, colName), where('complexId', '==', complexId))
        ).catch(() => null);
        if (pSnap) {
          for (const d of pSnap.docs) {
            await deleteDoc(doc(primaryDb, colName, d.id)).catch(() => {});
          }
        }
      }
    }
    return { movedCount, movedBytes };
  }

  // accounts_invites
  for (const sDb of uniqueSources) {
    const aSnap = await getDocsFresh(
      query(collection(sDb, 'accounts'), where('complexId', '==', complexId))
    ).catch(() => null);
    if (aSnap) {
      for (const d of aSnap.docs) {
        const acc = d.data() as AccountRecord;
        movedBytes += estimateRecordBytes(acc);
        if (sDb !== destDb) {
          if (acc.nameHash) {
            await upsertNameIndexSafe(destDb, acc.nameHash, acc.id);
            await deleteDoc(doc(sDb, 'nameIndex', acc.nameHash)).catch(() => {});
          }
          await copyDocWithTimestamp(destDb, 'accounts', d.id, d.data() as Record<string, unknown>);
          await deleteDoc(doc(sDb, 'accounts', d.id)).catch(() => {});
        }
        movedCount++;
      }
    }

    for (const colName of ['inviteLinks', 'quickLinks']) {
      const snap = await getDocsFresh(
        query(collection(sDb, colName), where('complexId', '==', complexId))
      ).catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        movedBytes += estimateRecordBytes(data);
        if (sDb !== destDb) {
          await copyDocWithTimestamp(destDb, colName, d.id, data);
          await deleteDoc(doc(sDb, colName, d.id)).catch(() => {});
        }
        movedCount++;
      }
    }
  }
  if (destDb !== primaryDb) {
    const pAccounts = await getDocs(
      query(collection(primaryDb, 'accounts'), where('complexId', '==', complexId))
    ).catch(() => null);
    if (pAccounts) {
      for (const d of pAccounts.docs) {
        const acc = d.data() as AccountRecord;
        if (acc.nameHash) {
          await deleteDoc(doc(primaryDb, 'nameIndex', acc.nameHash)).catch(() => {});
        }
        await deleteDoc(doc(primaryDb, 'accounts', d.id)).catch(() => {});
      }
    }
    for (const colName of ['inviteLinks', 'quickLinks']) {
      const pSnap = await getDocs(
        query(collection(primaryDb, colName), where('complexId', '==', complexId))
      ).catch(() => null);
      if (pSnap) {
        for (const d of pSnap.docs) {
          await deleteDoc(doc(primaryDb, colName, d.id)).catch(() => {});
        }
      }
    }
  }
  return { movedCount, movedBytes };
}

/**
 * Adds an additional external DB shard (4 GB limit each) to a single tab's pool, or initializes
 * the pool and migrates all existing tab data from the complex default / primary DB into shard #1.
 */
export async function addShardToComplexTabPool(params: {
  workspace: ComplexWorkspaceData;
  tabKey: ComplexFeatureTabKey;
  config: ExternalFirebaseConfig;
  maxBytes?: number;
}): Promise<{ pool: TabDbShard[]; migratedDocs: number }> {
  const { workspace, tabKey, config, maxBytes = TAB_SHARD_MAX_BYTES } = params;
  const candidateDb = getFirestoreForConfig(config);
  if (candidateDb === primaryDb) {
    throw new Error('لا يمكن إضافة قاعدة المنصة الأم ضمن قواعد التبويبات المنفصلة.');
  }

  const candidateId = buildDbConnectionId(config);
  const existingPool = [...(workspace.tabPools?.[tabKey] || [])];
  if (existingPool.some((s) => s.id === candidateId || buildDbConnectionId(s.config) === candidateId)) {
    throw new Error('قاعدة البيانات هذه مضافة بالفعل إلى سلسلة هذا التبويب.');
  }

  await registerExternalDatabaseConnection(config);

  let migratedDocs = 0;
  let initialUsedBytes = 0;
  let initialDocsCount = 0;

  if (existingPool.length === 0) {
    const activeTabDb = getDbForComplexTab(workspace, tabKey);
    const sourceDbs: Firestore[] = [activeTabDb, workspace.complexDb];
    if (tabKey === 'presentations') {
      try {
        sourceDbs.push(...getReadDbsForComplexTab(workspace, 'curricula'));
      } catch {
        // Ignore if curricula isolated on unreachable DB
      }
    }
    if (tabKey === 'accounts_invites' || tabKey === 'mosques_halaqat') {
      sourceDbs.push(
        ...Object.values(workspace.mosqueDbMap),
        ...Object.values(workspace.halaqaDbMap)
      );
    }
    const migrated = await migrateSingleTabRecords({
      complexId: workspace.complex.id,
      tabKey,
      sourceDbs,
      destDb: candidateDb,
    });
    migratedDocs = migrated.movedCount;
    const stats = await measureTabUsageOnDb(candidateDb, workspace.complex.id, tabKey);
    initialUsedBytes = stats.usedBytes;
    initialDocsCount = stats.docsCount;
  } else {
    const stats = await measureTabUsageOnDb(candidateDb, workspace.complex.id, tabKey);
    initialUsedBytes = stats.usedBytes;
    initialDocsCount = stats.docsCount;
  }

  const hasAvailableActive = existingPool.some((s) => s.status === 'active');
  const newShard: TabDbShard = {
    id: candidateId,
    label: getDbDisplayLabel(config),
    config,
    usedBytes: initialUsedBytes,
    maxBytes,
    docsCount: initialDocsCount,
    status: initialUsedBytes >= maxBytes ? 'full' : hasAvailableActive ? 'standby' : 'active',
    createdAtMs: Date.now(),
  };

  const nextPool = await saveComplexTabPool(workspace.complex.id, tabKey, [...existingPool, newShard]);
  syncWorkspaceTabPointers(workspace, tabKey, nextPool);
  return { pool: nextPool, migratedDocs };
}

export async function activateShardInTabPool(params: {
  workspace: ComplexWorkspaceData;
  tabKey: ComplexFeatureTabKey;
  shardId: string;
}): Promise<TabDbShard[]> {
  const { workspace, tabKey, shardId } = params;
  const existingPool = workspace.tabPools?.[tabKey] || [];
  const target = existingPool.find((s) => s.id === shardId);
  if (!target) {
    throw new Error('لم يتم العثور على القاعدة المطلوبة في سلسلة التبويب.');
  }
  if (target.status === 'full' || target.usedBytes >= target.maxBytes) {
    throw new Error('هذه القاعدة وصلت للحد الأقصى (4 جيجابايت) ولا يمكن الكتابة عليها مجدداً.');
  }

  const updated = existingPool.map((s) => ({
    ...s,
    status: s.status === 'full' ? ('full' as const) : s.id === shardId ? ('active' as const) : ('standby' as const),
  }));
  const saved = await saveComplexTabPool(workspace.complex.id, tabKey, updated);
  syncWorkspaceTabPointers(workspace, tabKey, saved);
  return saved;
}

export async function recalculateTabPoolUsage(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): Promise<TabDbShard[]> {
  const existingPool = workspace.tabPools?.[tabKey] || [];
  if (existingPool.length === 0) return [];

  const recalculated: TabDbShard[] = [];
  for (const sh of existingPool) {
    const sDb = getFirestoreForConfig(sh.config);
    const stats = await measureTabUsageOnDb(sDb, workspace.complex.id, tabKey);
    const isFull = stats.usedBytes >= sh.maxBytes;
    recalculated.push({
      ...sh,
      usedBytes: stats.usedBytes,
      docsCount: stats.docsCount,
      status: isFull ? 'full' : sh.status === 'full' ? 'standby' : sh.status,
    });
  }

  const saved = await saveComplexTabPool(workspace.complex.id, tabKey, recalculated);
  syncWorkspaceTabPointers(workspace, tabKey, saved);
  return saved;
}

/**
 * Transfers all records of this tab stored inside `sourceShardId` to a replacement database
 * (either another existing shard in the pool OR a newly verified external DB) and removes the old copies.
 */
export async function migrateTabShardToReplacement(params: {
  workspace: ComplexWorkspaceData;
  tabKey: ComplexFeatureTabKey;
  sourceShardId: string;
  destConfig: ExternalFirebaseConfig;
  removeSourceAfterMigration?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<{ movedDocsCount: number; pool: TabDbShard[] }> {
  const {
    workspace,
    tabKey,
    sourceShardId,
    destConfig,
    removeSourceAfterMigration = true,
    onProgress,
  } = params;

  const existingPool = workspace.tabPools?.[tabKey] || [];
  const sourceShard = existingPool.find((s) => s.id === sourceShardId);
  if (!sourceShard) {
    throw new Error('القاعدة المصدر غير موجودة في سلسلة هذا التبويب.');
  }

  const destId = buildDbConnectionId(destConfig);
  if (destId === sourceShard.id) {
    throw new Error('يرجى اختيار قاعدة بديلة مختلفة عن القاعدة الحالية.');
  }

  const sourceDb = getFirestoreForConfig(sourceShard.config);
  const destDb = getFirestoreForConfig(destConfig);
  if (destDb === primaryDb) {
    throw new Error('لا يمكن نقل بيانات تبويب معزول إلى القاعدة الأم.');
  }

  await registerExternalDatabaseConnection(destConfig);

  const migrated = await migrateSingleTabRecords({
    complexId: workspace.complex.id,
    tabKey,
    sourceDbs: [sourceDb],
    destDb,
    onProgress,
  });

  const destStats = await measureTabUsageOnDb(destDb, workspace.complex.id, tabKey);
  const srcWasActive = sourceShard.status === 'active';
  const existingDestIdx = existingPool.findIndex(
    (s) => s.id === destId || buildDbConnectionId(s.config) === destId
  );

  let nextPool: TabDbShard[];
  if (existingDestIdx >= 0) {
    nextPool = existingPool
      .map((s) => {
        if (s.id === existingPool[existingDestIdx].id) {
          return {
            ...s,
            usedBytes: destStats.usedBytes,
            docsCount: destStats.docsCount,
            status:
              destStats.usedBytes >= s.maxBytes
                ? ('full' as const)
                : srcWasActive
                ? ('active' as const)
                : s.status,
          };
        }
        if (s.id === sourceShardId && !removeSourceAfterMigration) {
          return { ...s, usedBytes: 0, docsCount: 0, status: 'standby' as const };
        }
        return s;
      })
      .filter((s) => !(removeSourceAfterMigration && s.id === sourceShardId));
  } else {
    const replacementShard: TabDbShard = {
      id: destId,
      label: getDbDisplayLabel(destConfig),
      config: destConfig,
      usedBytes: destStats.usedBytes,
      maxBytes: sourceShard.maxBytes || TAB_SHARD_MAX_BYTES,
      docsCount: destStats.docsCount,
      status:
        destStats.usedBytes >= (sourceShard.maxBytes || TAB_SHARD_MAX_BYTES)
          ? 'full'
          : srcWasActive
          ? 'active'
          : 'standby',
      createdAtMs: Date.now(),
    };

    if (removeSourceAfterMigration) {
      nextPool = existingPool.map((s) => (s.id === sourceShardId ? replacementShard : s));
    } else {
      nextPool = [
        ...existingPool.map((s) =>
          s.id === sourceShardId ? { ...s, usedBytes: 0, docsCount: 0, status: 'standby' as const } : s
        ),
        replacementShard,
      ];
    }
  }

  const saved = await saveComplexTabPool(workspace.complex.id, tabKey, nextPool);
  syncWorkspaceTabPointers(workspace, tabKey, saved);
  return { movedDocsCount: migrated.movedCount, pool: saved };
}

/**
 * Assigns an external DB (or reverts to complex default if targetConfig is null) for specific tab(s)
 * ONLY for this complex, migrating all existing tab data and purging old copies permanently from primaryDb.
 */
export async function assignExternalDbToComplexTabs(params: {
  workspace: ComplexWorkspaceData;
  tabKeys: ComplexFeatureTabKey[];
  targetConfig: ExternalFirebaseConfig | null;
}): Promise<{ movedDocsCount: number }> {
  const { workspace, tabKeys, targetConfig } = params;
  if (tabKeys.length === 0) {
    throw new Error('يرجى اختيار تبويب واحد على الأقل.');
  }

  if (targetConfig) {
    await registerExternalDatabaseConnection(targetConfig);
  }
  const destDb = targetConfig ? getFirestoreForConfig(targetConfig) : workspace.complexDb;
  const currentRoutes = await loadComplexTabRoutes(workspace.complex.id);
  const nextRoutes: Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig>> = {
    ...currentRoutes,
  };

  let movedDocsCount = 0;

  for (const tabKey of tabKeys) {
    const readDbs = getReadDbsForComplexTab(workspace, tabKey);
    const sourceDbs: Firestore[] = [...readDbs, workspace.complexDb];
    if (tabKey === 'presentations') {
      try {
        sourceDbs.push(...getReadDbsForComplexTab(workspace, 'curricula'));
      } catch {
        // Optional
      }
    }
    if (tabKey === 'accounts_invites' || tabKey === 'mosques_halaqat') {
      sourceDbs.push(
        ...Object.values(workspace.mosqueDbMap),
        ...Object.values(workspace.halaqaDbMap)
      );
    }

    const migrated = await migrateSingleTabRecords({
      complexId: workspace.complex.id,
      tabKey,
      sourceDbs,
      destDb,
    });
    movedDocsCount += migrated.movedCount;

    if (targetConfig) {
      nextRoutes[tabKey] = targetConfig;
      const stats = await measureTabUsageOnDb(destDb, workspace.complex.id, tabKey);
      const shard: TabDbShard = {
        id: buildDbConnectionId(targetConfig),
        label: getDbDisplayLabel(targetConfig),
        config: targetConfig,
        usedBytes: stats.usedBytes,
        maxBytes: TAB_SHARD_MAX_BYTES,
        docsCount: stats.docsCount,
        status: stats.usedBytes >= TAB_SHARD_MAX_BYTES ? 'full' : 'active',
        createdAtMs: Date.now(),
      };
      await saveComplexTabPool(workspace.complex.id, tabKey, [shard]);
    } else {
      delete nextRoutes[tabKey];
      await saveComplexTabPool(workspace.complex.id, tabKey, []);
    }
  }

  await saveComplexTabRoutes(workspace.complex.id, nextRoutes);
  return { movedDocsCount };
}

/**
 * Copies ALL data of this complex across all collections & tabs into an isolated backup Firebase DB
 * WITHOUT altering or deleting the live data.
 */
export async function cloneComplexToBackupDatabase(params: {
  workspace: ComplexWorkspaceData;
  backupConfig: ExternalFirebaseConfig;
}): Promise<{ totalCopiedDocs: number }> {
  const { workspace, backupConfig } = params;
  const backupDb = getFirestoreForConfig(backupConfig);
  let totalCopiedDocs = 0;

  // Store inactive complex marker so live discovery queries (active == true) never mistake backup for live
  await upsertTransferredDoc(backupDb, 'complexes', workspace.complex.id, {
    id: workspace.complex.id,
    name: workspace.complex.name,
    usesExternalDb: true,
    active: false,
    createdBy: auth.currentUser?.uid || workspace.complex.createdBy || 'admin',
  });
  totalCopiedDocs++;

  for (const m of workspace.mosques) {
    await upsertTransferredDoc(backupDb, 'mosques', m.id, {
      id: m.id,
      complexId: m.complexId,
      name: m.name,
      usesExternalDb: m.usesExternalDb,
      active: m.active,
    });
    totalCopiedDocs++;
  }

  for (const h of workspace.halaqat) {
    await upsertTransferredDoc(backupDb, 'halaqat', h.id, {
      id: h.id,
      complexId: h.complexId,
      mosqueId: h.mosqueId,
      name: h.name,
      active: h.active,
    });
    totalCopiedDocs++;
  }

  for (const acc of workspace.accounts) {
    if (acc.nameHash) {
      await upsertNameIndexSafe(backupDb, acc.nameHash, acc.id);
    }
    await upsertTransferredDoc(backupDb, 'accounts', acc.id, {
      id: acc.id,
      uid: acc.uid || '',
      quadrupleName: acc.quadrupleName,
      nameHash: acc.nameHash,
      email: acc.email || '',
      photoURL: acc.photoURL || '',
      role: acc.role,
      complexId: acc.complexId || '',
      mosqueId: acc.mosqueId || '',
      mosqueIds: acc.mosqueIds || [],
      halaqaIds: acc.halaqaIds || [],
      inviteToken: acc.inviteToken || '',
      quickToken: acc.quickToken || '',
      lastLoginDate: acc.lastLoginDate || '',
    });
    totalCopiedDocs++;
  }

  for (const inv of workspace.inviteLinks) {
    await upsertTransferredDoc(backupDb, 'inviteLinks', inv.token, {
      token: inv.token,
      title: inv.title,
      complexId: inv.complexId,
      role: inv.role,
      mosqueId: inv.mosqueId || '',
      mosqueIds: inv.mosqueIds || [],
      halaqaIds: inv.halaqaIds || [],
      startsAtMs: inv.startsAtMs || 0,
      endsAtMs: inv.endsAtMs || 0,
      active: inv.active,
    });
    totalCopiedDocs++;
  }

  for (const ql of workspace.quickLinks) {
    await upsertTransferredDoc(backupDb, 'quickLinks', ql.token, {
      token: ql.token,
      accountId: ql.accountId,
      quadrupleName: ql.quadrupleName,
      role: ql.role,
      complexId: ql.complexId || '',
      complexName: ql.complexName || '',
      mosqueId: ql.mosqueId || '',
      mosqueName: ql.mosqueName || '',
      halaqaNames: ql.halaqaNames || [],
      active: ql.active,
    });
    totalCopiedDocs++;
  }

  const attendanceList = await listAttendanceHistory(workspace);
  for (const att of attendanceList) {
    await upsertTransferredDoc(backupDb, 'attendance', att.id, {
      id: att.id,
      complexId: att.complexId,
      mosqueId: att.mosqueId,
      halaqaId: att.halaqaId,
      dateKey: att.dateKey,
      entries: att.entries,
      recordedBy: att.recordedBy,
      recordedByName: att.recordedByName,
    });
    totalCopiedDocs++;
  }

  const books = await listBooksInComplex(workspace);
  for (const book of books) {
    await upsertTransferredDoc(backupDb, 'books', book.id, {
      id: book.id,
      complexId: book.complexId,
      title: book.title,
      fileName: book.fileName,
      fileType: book.fileType,
      totalPages: book.totalPages,
      uploadedPages: book.uploadedPages,
      recognizedPages: book.recognizedPages,
      status: book.status,
      createdBy: book.createdBy,
    });
    totalCopiedDocs++;
    const pages = await loadBookPages(workspace, book.id);
    for (const p of pages) {
      await setDoc(doc(backupDb, 'bookPages', p.id), {
        id: p.id,
        bookId: p.bookId,
        complexId: p.complexId,
        pageNumber: p.pageNumber,
        imageDataUrl: p.imageDataUrl,
        width: p.width,
        height: p.height,
        recognized: p.recognized,
        fullText: p.fullText,
        segments: p.segments,
        updatedAt: serverTimestamp(),
      });
      totalCopiedDocs++;
    }
  }

  const seenWordAudioIds = new Set<string>();
  const libraryReadDbs = getReadDbsForComplexTab(workspace, 'library');
  for (const libDb of libraryReadDbs) {
    const waSnap = await getDocsFresh(
      query(collection(libDb, 'wordAudio'), where('complexId', '==', workspace.complex.id))
    ).catch(() => null);
    if (!waSnap) continue;
    for (const d of waSnap.docs) {
      if (seenWordAudioIds.has(d.id)) continue;
      seenWordAudioIds.add(d.id);
      await upsertTransferredDoc(backupDb, 'wordAudio', d.id, d.data() as Record<string, unknown>);
      totalCopiedDocs++;
    }
  }

  const curricula = await listCurriculaInComplex(workspace);
  for (const cur of curricula) {
    await upsertTransferredDoc(backupDb, 'curricula', cur.id, {
      id: cur.id,
      complexId: cur.complexId,
      bookId: cur.bookId,
      bookTitle: cur.bookTitle,
      halaqaIds: cur.halaqaIds,
      mosqueIds: cur.mosqueIds,
      days: cur.days,
      scheduleNote: cur.scheduleNote || '',
      active: cur.active,
      createdBy: cur.createdBy,
    });
    totalCopiedDocs++;
  }

  const curriculaReadDbs = getReadDbsForComplexTab(workspace, 'curricula');
  const seenQuranPlanIds = new Set<string>();
  const seenMistakeIds = new Set<string>();
  const seenBookPlanIds = new Set<string>();
  for (const curDb of curriculaReadDbs) {
    const qpSnap = await getDocsFresh(
      query(collection(curDb, 'studentQuranPlans'), where('complexId', '==', workspace.complex.id))
    ).catch(() => null);
    if (qpSnap) {
      for (const d of qpSnap.docs) {
        if (seenQuranPlanIds.has(d.id)) continue;
        seenQuranPlanIds.add(d.id);
        await upsertTransferredDoc(
          backupDb,
          'studentQuranPlans',
          d.id,
          d.data() as Record<string, unknown>
        );
        totalCopiedDocs++;
      }
    }
    const mmSnap = await getDocsFresh(
      query(collection(curDb, 'studentMushafMistakes'), where('complexId', '==', workspace.complex.id))
    ).catch(() => null);
    if (mmSnap) {
      for (const d of mmSnap.docs) {
        if (seenMistakeIds.has(d.id)) continue;
        seenMistakeIds.add(d.id);
        await upsertTransferredDoc(
          backupDb,
          'studentMushafMistakes',
          d.id,
          d.data() as Record<string, unknown>
        );
        totalCopiedDocs++;
      }
    }
    const bpSnap = await getDocsFresh(
      query(collection(curDb, 'studentBookPlans'), where('complexId', '==', workspace.complex.id))
    ).catch(() => null);
    if (bpSnap) {
      for (const d of bpSnap.docs) {
        if (seenBookPlanIds.has(d.id)) continue;
        seenBookPlanIds.add(d.id);
        await upsertTransferredDoc(
          backupDb,
          'studentBookPlans',
          d.id,
          d.data() as Record<string, unknown>
        );
        totalCopiedDocs++;
      }
    }
  }

  const presentationsReadDbs =
    workspace.tabPools?.presentations?.length || workspace.tabConfigMap?.presentations
      ? getReadDbsForComplexTab(workspace, 'presentations')
      : curriculaReadDbs;
  const seenPresentationIds = new Set<string>();
  for (const prsDb of presentationsReadDbs) {
    const prSnap = await getDocsFresh(
      query(collection(prsDb, 'presentations'), where('complexId', '==', workspace.complex.id))
    ).catch(() => null);
    if (prSnap) {
      for (const d of prSnap.docs) {
        if (seenPresentationIds.has(d.id)) continue;
        seenPresentationIds.add(d.id);
        await upsertTransferredDoc(
          backupDb,
          'presentations',
          d.id,
          d.data() as Record<string, unknown>
        );
        totalCopiedDocs++;
      }
    }
  }

  return { totalCopiedDocs };
}

export interface TabJsonExportPayload {
  platform: string;
  exportedAt: string;
  complexId: string;
  complexName: string;
  tabKey: ComplexFeatureTabKey;
  tabLabel: string;
  dbLabel: string;
  data: Record<string, unknown>;
}

export async function exportComplexTabJsonPayload(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): Promise<TabJsonExportPayload> {
  const dbLabel = getDbLabelForComplexTab(workspace, tabKey);
  let data: Record<string, unknown> = {};

  if (tabKey === 'attendance') {
    const records = await listAttendanceHistory(workspace);
    data = { attendance: records };
  } else if (tabKey === 'curricula') {
    const records = await listCurriculaInComplex(workspace);
    const qpMap = new Map<string, StudentQuranPlanRecord>();
    const mmMap = new Map<string, StudentMushafMistakesRecord>();
    const bpMap = new Map<string, StudentBookPlanRecord>();
    for (const curDb of getReadDbsForComplexTab(workspace, 'curricula')) {
      const [qpSnap, mmSnap, bpSnap] = await Promise.all([
        getDocsFresh(
          query(collection(curDb, 'studentQuranPlans'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null),
        getDocsFresh(
          query(
            collection(curDb, 'studentMushafMistakes'),
            where('complexId', '==', workspace.complex.id)
          )
        ).catch(() => null),
        getDocsFresh(
          query(collection(curDb, 'studentBookPlans'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null),
      ]);
      qpSnap?.forEach((d) => {
        if (!qpMap.has(d.id)) qpMap.set(d.id, d.data() as StudentQuranPlanRecord);
      });
      mmSnap?.forEach((d) => {
        if (!mmMap.has(d.id)) mmMap.set(d.id, d.data() as StudentMushafMistakesRecord);
      });
      bpSnap?.forEach((d) => {
        if (!bpMap.has(d.id)) bpMap.set(d.id, d.data() as StudentBookPlanRecord);
      });
    }
    data = {
      curricula: records,
      studentQuranPlans: Array.from(qpMap.values()),
      studentMushafMistakes: Array.from(mmMap.values()),
      studentBookPlans: Array.from(bpMap.values()),
    };
  } else if (tabKey === 'presentations') {
    const prMap = new Map<string, Record<string, unknown>>();
    const prsDbs =
      workspace.tabPools?.presentations?.length || workspace.tabConfigMap?.presentations
        ? getReadDbsForComplexTab(workspace, 'presentations')
        : getReadDbsForComplexTab(workspace, 'curricula');
    for (const prsDb of prsDbs) {
      const prSnap = await getDocsFresh(
        query(collection(prsDb, 'presentations'), where('complexId', '==', workspace.complex.id))
      ).catch(() => null);
      prSnap?.forEach((d) => {
        if (!prMap.has(d.id)) prMap.set(d.id, d.data() as Record<string, unknown>);
      });
    }
    data = { presentations: Array.from(prMap.values()) };
  } else if (tabKey === 'library') {
    const books = await listBooksInComplex(workspace);
    const bookPages: BookPageRecord[] = [];
    for (const b of books) {
      const pages = await loadBookPages(workspace, b.id);
      bookPages.push(...pages);
    }
    const wordAudioMap = new Map<string, BookWordAudioRecord>();
    for (const libDb of getReadDbsForComplexTab(workspace, 'library')) {
      const waSnap = await getDocsFresh(
        query(collection(libDb, 'wordAudio'), where('complexId', '==', workspace.complex.id))
      ).catch(() => null);
      if (!waSnap) continue;
      waSnap.forEach((d) => {
        if (!wordAudioMap.has(d.id)) {
          wordAudioMap.set(d.id, d.data() as BookWordAudioRecord);
        }
      });
    }
    data = { books, bookPages, wordAudio: Array.from(wordAudioMap.values()) };
  } else if (tabKey === 'mosques_halaqat') {
    data = {
      mosques: workspace.mosques,
      halaqat: workspace.halaqat,
    };
  } else {
    data = {
      accounts: workspace.accounts,
      inviteLinks: workspace.inviteLinks,
      quickLinks: workspace.quickLinks,
    };
  }

  return {
    platform: 'براعم عمران',
    exportedAt: new Date().toISOString(),
    complexId: workspace.complex.id,
    complexName: workspace.complex.name,
    tabKey,
    tabLabel: COMPLEX_FEATURE_TAB_LABELS[tabKey],
    dbLabel,
    data,
  };
}

export async function exportAllComplexBackupFiles(workspace: ComplexWorkspaceData): Promise<{
  files: { filename: string; content: string }[];
  fullSnapshot: Record<string, unknown>;
}> {
  const tabKeys: ComplexFeatureTabKey[] = [
    'mosques_halaqat',
    'accounts_invites',
    'attendance',
    'library',
    'curricula',
    'presentations',
  ];

  const files: { filename: string; content: string }[] = [];
  const tabsBundle: Record<string, TabJsonExportPayload> = {};

  for (const key of tabKeys) {
    const payload = await exportComplexTabJsonPayload(workspace, key);
    tabsBundle[key] = payload;
    files.push({
      filename: `${key}.json`,
      content: JSON.stringify(payload, null, 2),
    });
  }

  const fullSnapshot = {
    platform: 'براعم عمران',
    exportedAt: new Date().toISOString(),
    complex: workspace.complex,
    ownerDbLabel: workspace.discovered.ownerDbLabel,
    tabs: tabsBundle,
  };

  files.push({
    filename: 'full-complex-backup.json',
    content: JSON.stringify(fullSnapshot, null, 2),
  });

  return { files, fullSnapshot };
}

export async function importComplexTabJsonPayload(params: {
  workspace: ComplexWorkspaceData;
  tabKey: ComplexFeatureTabKey;
  parsedJson: unknown;
}): Promise<{ importedCount: number }> {
  const { workspace, tabKey, parsedJson } = params;
  if (!parsedJson || typeof parsedJson !== 'object') {
    throw new Error('ملف JSON غير صالح.');
  }

  const obj = parsedJson as Record<string, unknown>;
  let sourceData: Record<string, unknown> = obj;

  if (obj.tabs && typeof obj.tabs === 'object') {
    const tabsObj = obj.tabs as Record<string, unknown>;
    const tabEntry = tabsObj[tabKey] as Record<string, unknown> | undefined;
    if (tabEntry && tabEntry.data && typeof tabEntry.data === 'object') {
      sourceData = tabEntry.data as Record<string, unknown>;
    }
  } else if (obj.data && typeof obj.data === 'object') {
    sourceData = obj.data as Record<string, unknown>;
  }

  const destDb = getDbForComplexTab(workspace, tabKey);
  const complexId = workspace.complex.id;
  let importedCount = 0;

  if (tabKey === 'attendance') {
    const items = Array.isArray(sourceData.attendance) ? (sourceData.attendance as AttendanceRecord[]) : [];
    for (const rec of items) {
      if (!rec || !rec.halaqaId || !rec.dateKey) continue;
      const docId = buildAttendanceDocId(rec.halaqaId, rec.dateKey);
      const payload = {
        id: docId,
        complexId,
        mosqueId: rec.mosqueId || '',
        halaqaId: rec.halaqaId,
        dateKey: rec.dateKey,
        entries: sanitizeAttendanceEntries(Array.isArray(rec.entries) ? rec.entries : []),
        recordedBy: rec.recordedBy || auth.currentUser?.uid || 'admin',
        recordedByName: rec.recordedByName || 'استيراد JSON',
      };
      await executeTabWriteWithRollover(
        workspace,
        'attendance',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'attendance', docId, payload);
        }
      );
      importedCount++;
    }
    return { importedCount };
  }

  if (tabKey === 'curricula') {
    const items = Array.isArray(sourceData.curricula) ? (sourceData.curricula as CurriculumRecord[]) : [];
    for (const cur of items) {
      if (!cur || !cur.id || !cur.bookId || !cur.bookTitle) continue;
      const payload = {
        id: cur.id,
        complexId,
        bookId: cur.bookId,
        bookTitle: cur.bookTitle,
        halaqaIds: Array.isArray(cur.halaqaIds) ? cur.halaqaIds : [],
        mosqueIds: Array.isArray(cur.mosqueIds) ? cur.mosqueIds : [],
        days: Array.isArray(cur.days) ? cur.days : [],
        scheduleNote: cur.scheduleNote || '',
        active: cur.active !== false,
        createdBy: cur.createdBy || auth.currentUser?.uid || 'admin',
      };
      await executeTabWriteWithRollover(
        workspace,
        'curricula',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'curricula', cur.id, payload);
        }
      );
      importedCount++;
    }

    const quranPlans = Array.isArray(sourceData.studentQuranPlans)
      ? (sourceData.studentQuranPlans as StudentQuranPlanRecord[])
      : [];
    for (const qp of quranPlans) {
      if (!qp || !qp.studentId || !qp.dateKey) continue;
      const planId = buildQuranPlanDocId(qp.studentId, qp.dateKey);
      const payload = {
        id: planId,
        complexId,
        mosqueId: qp.mosqueId || '',
        halaqaId: qp.halaqaId || '',
        studentId: qp.studentId,
        studentName: String(qp.studentName || 'طالب').slice(0, 120),
        dateKey: qp.dateKey,
        todayNew: sanitizeNewHifzItem(qp.todayNew),
        todayReviews: sanitizeReviewItems(qp.todayReviews),
        tomorrowNew: sanitizeNewHifzItem(qp.tomorrowNew),
        tomorrowReviews: sanitizeReviewItems(qp.tomorrowReviews),
        recordedBy: qp.recordedBy || auth.currentUser?.uid || 'admin',
        recordedByName: String(qp.recordedByName || 'استيراد JSON').slice(0, 120),
      };
      await executeTabWriteWithRollover(
        workspace,
        'curricula',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'studentQuranPlans', planId, payload);
        }
      );
      importedCount++;
    }

    const mistakesList = Array.isArray(sourceData.studentMushafMistakes)
      ? (sourceData.studentMushafMistakes as StudentMushafMistakesRecord[])
      : [];
    for (const mm of mistakesList) {
      if (!mm || !mm.studentId) continue;
      const recId = buildMushafMistakesDocId(mm.studentId);
      const payload = {
        id: recId,
        complexId,
        studentId: mm.studentId,
        studentName: String(mm.studentName || 'طالب').slice(0, 120),
        mistakes: sanitizeMistakesMap(mm.mistakes),
        updatedBy: mm.updatedBy || auth.currentUser?.uid || 'admin',
      };
      await executeTabWriteWithRollover(
        workspace,
        'curricula',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'studentMushafMistakes', recId, payload);
        }
      );
      importedCount++;
    }

    const bookPlansList = Array.isArray(sourceData.studentBookPlans)
      ? (sourceData.studentBookPlans as StudentBookPlanRecord[])
      : [];
    for (const bp of bookPlansList) {
      if (!bp || !bp.studentId || !bp.bookId || !bp.dateKey) continue;
      const planId = buildBookPlanDocId(bp.studentId, bp.bookId, bp.dateKey);
      const payload = {
        id: planId,
        complexId,
        mosqueId: bp.mosqueId || '',
        halaqaId: bp.halaqaId || '',
        studentId: bp.studentId,
        studentName: String(bp.studentName || 'طالب').slice(0, 120),
        bookId: bp.bookId,
        bookTitle: String(bp.bookTitle || 'كتاب').slice(0, 160),
        dateKey: bp.dateKey,
        whereWeReachedPage: Math.max(1, Math.min(2000, Math.floor(Number(bp.whereWeReachedPage) || 1))),
        todayHomeworks: sanitizeBookHomeworks(bp.todayHomeworks),
        tomorrowHomeworks: sanitizeBookHomeworks(bp.tomorrowHomeworks),
        recordedBy: bp.recordedBy || auth.currentUser?.uid || 'admin',
        recordedByName: String(bp.recordedByName || 'استيراد JSON').slice(0, 120),
      };
      await executeTabWriteWithRollover(
        workspace,
        'curricula',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'studentBookPlans', planId, payload);
        }
      );
      importedCount++;
    }

    const presentationsList = Array.isArray(sourceData.presentations)
      ? (sourceData.presentations as Array<Record<string, unknown>>)
      : [];
    for (const pr of presentationsList) {
      if (!pr || !pr.id || !pr.title) continue;
      const prId = String(pr.id);
      const payload: Record<string, unknown> = {
        id: prId,
        complexId,
        mosqueId: String(pr.mosqueId || ''),
        halaqaId: String(pr.halaqaId || ''),
        title: String(pr.title || 'عرض مستورد').slice(0, 180),
        description: String(pr.description || '').slice(0, 600),
        sourceType: pr.sourceType === 'pptx_import' ? 'pptx_import' : 'ai',
        sourceFileName: String(pr.sourceFileName || '').slice(0, 200),
        slides: Array.isArray(pr.slides) ? pr.slides.slice(0, 40) : [],
        chatHistory: Array.isArray(pr.chatHistory) ? pr.chatHistory.slice(-60) : [],
        createdBy: String(pr.createdBy || auth.currentUser?.uid || 'admin').slice(0, 128),
        createdByName: String(pr.createdByName || 'استيراد JSON').slice(0, 120),
        active: pr.active !== false,
      };
      await executeTabWriteWithRollover(
        workspace,
        'presentations',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'presentations', prId, payload);
        }
      );
      importedCount++;
    }
    return { importedCount };
  }

  if (tabKey === 'presentations') {
    const presentationsList = Array.isArray(sourceData.presentations)
      ? (sourceData.presentations as Array<Record<string, unknown>>)
      : [];
    for (const pr of presentationsList) {
      if (!pr || !pr.id || !pr.title) continue;
      const prId = String(pr.id);
      const payload: Record<string, unknown> = {
        id: prId,
        complexId,
        mosqueId: String(pr.mosqueId || ''),
        halaqaId: String(pr.halaqaId || ''),
        title: String(pr.title || 'عرض مستورد').slice(0, 180),
        description: String(pr.description || '').slice(0, 600),
        sourceType: pr.sourceType === 'pptx_import' ? 'pptx_import' : 'ai',
        sourceFileName: String(pr.sourceFileName || '').slice(0, 200),
        slides: Array.isArray(pr.slides) ? pr.slides.slice(0, 40) : [],
        chatHistory: Array.isArray(pr.chatHistory) ? pr.chatHistory.slice(-60) : [],
        createdBy: String(pr.createdBy || auth.currentUser?.uid || 'admin').slice(0, 128),
        createdByName: String(pr.createdByName || 'استيراد JSON').slice(0, 120),
        active: pr.active !== false,
      };
      await executeTabWriteWithRollover(
        workspace,
        'presentations',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'presentations', prId, payload);
        }
      );
      importedCount++;
    }
    return { importedCount };
  }

  if (tabKey === 'library') {
    const books = Array.isArray(sourceData.books) ? (sourceData.books as BookRecord[]) : [];
    const pages = Array.isArray(sourceData.bookPages) ? (sourceData.bookPages as BookPageRecord[]) : [];
    for (const b of books) {
      if (!b || !b.id) continue;
      const payload = {
        id: b.id,
        complexId,
        title: b.title || 'كتاب مستورد',
        fileName: b.fileName || 'book.pdf',
        fileType: b.fileType === 'image' ? 'image' : 'pdf',
        totalPages: Number(b.totalPages) || 1,
        uploadedPages: Number(b.uploadedPages) || 0,
        recognizedPages: Number(b.recognizedPages) || 0,
        status: b.status || 'ready',
        createdBy: b.createdBy || auth.currentUser?.uid || 'admin',
      };
      await executeTabWriteWithRollover(
        workspace,
        'library',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'books', b.id, payload);
        }
      );
      importedCount++;
    }
    for (const p of pages) {
      if (!p || !p.id || !p.bookId) continue;
      const payload = {
        id: p.id,
        bookId: p.bookId,
        complexId,
        pageNumber: Number(p.pageNumber) || 1,
        imageDataUrl: p.imageDataUrl || '',
        width: Number(p.width) || 800,
        height: Number(p.height) || 1000,
        recognized: Boolean(p.recognized),
        fullText: String(p.fullText || '').slice(0, 25000),
        segments: sanitizeBookSegments(Array.isArray(p.segments) ? p.segments : []),
      };
      await executeTabWriteWithRollover(
        workspace,
        'library',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await setDoc(doc(writeDb, 'bookPages', p.id), {
            ...payload,
            updatedAt: serverTimestamp(),
          });
        }
      );
      importedCount++;
    }
    const wordAudioList = Array.isArray(sourceData.wordAudio)
      ? (sourceData.wordAudio as BookWordAudioRecord[])
      : [];
    for (const wa of wordAudioList) {
      if (!wa || !wa.id || !wa.wordText) continue;
      const payload = {
        id: wa.id,
        complexId,
        mode: wa.mode === 'normal' ? 'normal' : 'noor_albayan',
        wordText: String(wa.wordText).slice(0, 1200),
        diacritizedWord: String(wa.diacritizedWord || wa.wordText).slice(0, 1200),
        wasAutoDiacritized: Boolean(wa.wasAutoDiacritized),
        fullReading: String(wa.fullReading || wa.wordText).slice(0, 2500),
        steps: Array.isArray(wa.steps) ? wa.steps.slice(0, 60) : [],
        audioBase64: String(wa.audioBase64 || ''),
        mimeType: String(wa.mimeType || 'audio/wav'),
        byteSize: Number(wa.byteSize) || estimateRecordBytes(wa),
        createdBy: wa.createdBy || auth.currentUser?.uid || 'admin',
      };
      await executeTabWriteWithRollover(
        workspace,
        'library',
        estimateRecordBytes(payload),
        true,
        async (writeDb) => {
          await upsertTransferredDoc(writeDb, 'wordAudio', wa.id, payload);
        }
      );
      importedCount++;
    }
    return { importedCount };
  }

  if (tabKey === 'mosques_halaqat') {
    const mosques = Array.isArray(sourceData.mosques) ? (sourceData.mosques as MosqueRecord[]) : [];
    const halaqat = Array.isArray(sourceData.halaqat) ? (sourceData.halaqat as HalaqaRecord[]) : [];
    for (const m of mosques) {
      if (!m || !m.id || !m.name) continue;
      await upsertTransferredDoc(destDb, 'mosques', m.id, {
        id: m.id,
        complexId,
        name: m.name,
        usesExternalDb: false,
        active: m.active !== false,
      });
      importedCount++;
    }
    for (const h of halaqat) {
      if (!h || !h.id || !h.mosqueId || !h.name) continue;
      await upsertTransferredDoc(destDb, 'halaqat', h.id, {
        id: h.id,
        complexId,
        mosqueId: h.mosqueId,
        name: h.name,
        active: h.active !== false,
      });
      importedCount++;
    }
    return { importedCount };
  }

  // accounts_invites
  const accounts = Array.isArray(sourceData.accounts) ? (sourceData.accounts as AccountRecord[]) : [];
  const invites = Array.isArray(sourceData.inviteLinks) ? (sourceData.inviteLinks as InviteLinkRecord[]) : [];
  const quicks = Array.isArray(sourceData.quickLinks) ? (sourceData.quickLinks as QuickLinkRecord[]) : [];

  for (const acc of accounts) {
    if (!acc || !acc.id || !acc.quadrupleName) continue;
    if (acc.nameHash) {
      await upsertNameIndexSafe(destDb, acc.nameHash, acc.id);
    }
    await upsertTransferredDoc(destDb, 'accounts', acc.id, {
      id: acc.id,
      uid: acc.uid || '',
      quadrupleName: acc.quadrupleName,
      nameHash: acc.nameHash || '',
      email: acc.email || '',
      photoURL: acc.photoURL || '',
      role: acc.role || 'student',
      complexId,
      mosqueId: acc.mosqueId || '',
      mosqueIds: Array.isArray(acc.mosqueIds) ? acc.mosqueIds : [],
      halaqaIds: Array.isArray(acc.halaqaIds) ? acc.halaqaIds : [],
      inviteToken: acc.inviteToken || '',
      quickToken: acc.quickToken || '',
      lastLoginDate: acc.lastLoginDate || '',
    });
    importedCount++;
  }
  for (const inv of invites) {
    if (!inv || !inv.token) continue;
    await upsertTransferredDoc(destDb, 'inviteLinks', inv.token, {
      token: inv.token,
      title: inv.title || 'رابط تسجيل',
      complexId,
      role: inv.role || 'student',
      mosqueId: inv.mosqueId || '',
      mosqueIds: Array.isArray(inv.mosqueIds) ? inv.mosqueIds : [],
      halaqaIds: Array.isArray(inv.halaqaIds) ? inv.halaqaIds : [],
      startsAtMs: Number(inv.startsAtMs) || 0,
      endsAtMs: Number(inv.endsAtMs) || 0,
      active: inv.active !== false,
    });
    importedCount++;
  }
  for (const ql of quicks) {
    if (!ql || !ql.token) continue;
    await upsertTransferredDoc(destDb, 'quickLinks', ql.token, {
      token: ql.token,
      accountId: ql.accountId || '',
      quadrupleName: ql.quadrupleName || '',
      role: ql.role || 'student',
      complexId,
      complexName: ql.complexName || workspace.complex.name,
      mosqueId: ql.mosqueId || '',
      mosqueName: ql.mosqueName || '',
      halaqaNames: Array.isArray(ql.halaqaNames) ? ql.halaqaNames : [],
      active: ql.active !== false,
    });
    importedCount++;
  }

  return { importedCount };
}

// ============================================================================
// STUDENT QURAN PLANS (الحفظ والمراجعة اليومية والغد) & PER-STUDENT MUSHAF MISTAKES
// ============================================================================

export function buildQuranPlanDocId(studentId: string, dateKey: string): string {
  const cleanStudent = studentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanDate = dateKey.replace(/[^0-9-]/g, '');
  return `qp_${cleanStudent}_${cleanDate}`.slice(0, 128);
}

export function buildMushafMistakesDocId(studentId: string): string {
  const cleanStudent = studentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mm_${cleanStudent}`.slice(0, 128);
}

function clampSurahNum(n: unknown): number {
  const num = Number(n);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.min(114, Math.floor(num)));
}

function clampAyahNum(n: unknown): number {
  const num = Number(n);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.min(286, Math.floor(num)));
}

function sanitizeNewHifzItem(
  raw: StudentQuranNewHifzItem | null | undefined
): StudentQuranNewHifzItem | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    startSurah: clampSurahNum(raw.startSurah),
    startAyah: clampAyahNum(raw.startAyah),
    endSurah: clampSurahNum(raw.endSurah),
    endAyah: clampAyahNum(raw.endAyah),
    ...(raw.reciterId ? { reciterId: String(raw.reciterId).slice(0, 64) } : {}),
    ...(raw.note ? { note: String(raw.note).trim().slice(0, 240) } : {}),
    ...(typeof raw.completed === 'boolean' ? { completed: raw.completed } : {}),
  };
}

function sanitizeReviewItems(rawList: unknown): StudentQuranReviewItem[] {
  if (!Array.isArray(rawList)) return [];
  const validTypes = new Set<QuranReviewType>(Object.keys(QURAN_REVIEW_TYPE_LABELS) as QuranReviewType[]);
  return rawList.slice(0, 50).map((raw) => {
    const r = (raw || {}) as Partial<StudentQuranReviewItem>;
    const reviewType: QuranReviewType =
      r.reviewType && validTypes.has(r.reviewType) ? r.reviewType : 'surah_review';
    return {
      id: r.id && typeof r.id === 'string' ? r.id.slice(0, 64) : generateValidId('rev'),
      reviewType,
      ...(r.customLabel ? { customLabel: String(r.customLabel).trim().slice(0, 80) } : {}),
      startSurah: clampSurahNum(r.startSurah),
      startAyah: clampAyahNum(r.startAyah),
      endSurah: clampSurahNum(r.endSurah),
      endAyah: clampAyahNum(r.endAyah),
      ...(r.note ? { note: String(r.note).trim().slice(0, 240) } : {}),
      ...(typeof r.completed === 'boolean' ? { completed: r.completed } : {}),
    };
  });
}

function sanitizeMistakesMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,3}:\d{1,3}$/.test(k)) continue;
    const count = Math.floor(Number(v));
    if (Number.isFinite(count) && count >= 1 && count <= 999) {
      clean[k] = count;
    }
  }
  return clean;
}

export async function listStudentQuranPlanHistory(
  workspace: ComplexWorkspaceData,
  studentId: string
): Promise<StudentQuranPlanRecord[]> {
  try {
    const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
    const byId = new Map<string, StudentQuranPlanRecord>();
    await Promise.all(
      readDbs.map(async (db) => {
        const snap = await getDocsFresh(
          query(collection(db, 'studentQuranPlans'), where('studentId', '==', studentId))
        ).catch(() => null);
        snap?.forEach((d) => {
          const rec = d.data() as StudentQuranPlanRecord;
          if (rec.complexId === workspace.complex.id) {
            byId.set(rec.id, rec);
          }
        });
      })
    );
    return Array.from(byId.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  } catch {
    return [];
  }
}

export async function loadStudentQuranPlanForDate(params: {
  workspace: ComplexWorkspaceData;
  studentId: string;
  dateKey: string;
}): Promise<{
  savedPlan: StudentQuranPlanRecord | null;
  historyRecords: StudentQuranPlanRecord[];
  carriedFromDate: string | null;
  effectiveTodayNew: StudentQuranNewHifzItem | null;
  effectiveTodayReviews: StudentQuranReviewItem[];
  effectiveTomorrowNew: StudentQuranNewHifzItem | null;
  effectiveTomorrowReviews: StudentQuranReviewItem[];
}> {
  const { workspace, studentId, dateKey } = params;
  const historyRecords = await listStudentQuranPlanHistory(workspace, studentId);
  const exact = historyRecords.find((r) => r.dateKey === dateKey) || null;

  if (exact) {
    return {
      savedPlan: exact,
      historyRecords,
      carriedFromDate: null,
      effectiveTodayNew: exact.todayNew || null,
      effectiveTodayReviews: Array.isArray(exact.todayReviews) ? exact.todayReviews : [],
      effectiveTomorrowNew: exact.tomorrowNew || null,
      effectiveTomorrowReviews: Array.isArray(exact.tomorrowReviews) ? exact.tomorrowReviews : [],
    };
  }

  // Carry over automatically from the most recent recorded date prior to `dateKey`
  const prior = historyRecords.find(
    (r) => r.dateKey < dateKey && (r.tomorrowNew !== null || (r.tomorrowReviews || []).length > 0)
  );

  if (prior) {
    const cleanCarriedNew = prior.tomorrowNew
      ? (() => {
          const { completed: _ignored, ...rest } = prior.tomorrowNew;
          return rest;
        })()
      : null;
    return {
      savedPlan: null,
      historyRecords,
      carriedFromDate: prior.dateKey,
      effectiveTodayNew: cleanCarriedNew,
      effectiveTodayReviews: (prior.tomorrowReviews || []).map((rev) => {
        const { completed: _ignored, ...rest } = rev;
        return {
          ...rest,
          id: generateValidId('rev'),
        };
      }),
      effectiveTomorrowNew: null,
      effectiveTomorrowReviews: [],
    };
  }

  return {
    savedPlan: null,
    historyRecords,
    carriedFromDate: null,
    effectiveTodayNew: null,
    effectiveTodayReviews: [],
    effectiveTomorrowNew: null,
    effectiveTomorrowReviews: [],
  };
}

export async function saveStudentQuranPlan(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  studentId: string;
  studentName: string;
  dateKey: string;
  todayNew: StudentQuranNewHifzItem | null;
  todayReviews: StudentQuranReviewItem[];
  tomorrowNew: StudentQuranNewHifzItem | null;
  tomorrowReviews: StudentQuranReviewItem[];
  recordedBy: string;
  recordedByName: string;
}): Promise<StudentQuranPlanRecord> {
  const { workspace, mosqueId, halaqaId, studentId, studentName, dateKey, recordedBy, recordedByName } =
    params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('صيغة التاريخ غير صالحة.');
  }

  const planId = buildQuranPlanDocId(studentId, dateKey);
  const cleanTodayNew = sanitizeNewHifzItem(params.todayNew);
  const cleanTodayReviews = sanitizeReviewItems(params.todayReviews);
  const cleanTomorrowNew = sanitizeNewHifzItem(params.tomorrowNew);
  const cleanTomorrowReviews = sanitizeReviewItems(params.tomorrowReviews);
  const cleanStudentName = (studentName || 'طالب').trim().slice(0, 120) || 'طالب';
  const cleanRecorder = (recordedBy || auth.currentUser?.uid || 'teacher').slice(0, 128);
  const cleanRecorderName = (recordedByName || 'المعلم').trim().slice(0, 120) || 'المعلم';

  const located = await findExistingDocInTabPool(
    workspace,
    'curricula',
    'studentQuranPlans',
    planId
  );

  if (located.exists) {
    await updateDoc(doc(located.db, 'studentQuranPlans', planId), {
      mosqueId: (mosqueId || '').slice(0, 128),
      halaqaId: (halaqaId || '').slice(0, 128),
      studentName: cleanStudentName,
      todayNew: cleanTodayNew,
      todayReviews: cleanTodayReviews,
      tomorrowNew: cleanTomorrowNew,
      tomorrowReviews: cleanTomorrowReviews,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id: planId,
      complexId: workspace.complex.id,
      mosqueId: (mosqueId || '').slice(0, 128),
      halaqaId: (halaqaId || '').slice(0, 128),
      studentId,
      studentName: cleanStudentName,
      dateKey,
      todayNew: cleanTodayNew,
      todayReviews: cleanTodayReviews,
      tomorrowNew: cleanTomorrowNew,
      tomorrowReviews: cleanTomorrowReviews,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
    };
    const byteSize = estimateRecordBytes(payload);
    await executeTabWriteWithRollover(workspace, 'curricula', byteSize, true, async (targetDb) => {
      await setDoc(doc(targetDb, 'studentQuranPlans', planId), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  }

  return {
    id: planId,
    complexId: workspace.complex.id,
    mosqueId: (mosqueId || '').slice(0, 128),
    halaqaId: (halaqaId || '').slice(0, 128),
    studentId,
    studentName: cleanStudentName,
    dateKey,
    todayNew: cleanTodayNew,
    todayReviews: cleanTodayReviews,
    tomorrowNew: cleanTomorrowNew,
    tomorrowReviews: cleanTomorrowReviews,
    recordedBy: cleanRecorder,
    recordedByName: cleanRecorderName,
  };
}

export async function loadStudentMushafMistakes(
  workspace: ComplexWorkspaceData,
  studentId: string
): Promise<Record<string, number>> {
  const docId = buildMushafMistakesDocId(studentId);
  const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
  for (const db of readDbs) {
    const snap = await getDocFresh(doc(db, 'studentMushafMistakes', docId)).catch(() => null);
    if (snap?.exists()) {
      const data = snap.data() as StudentMushafMistakesRecord;
      return sanitizeMistakesMap(data.mistakes);
    }
  }
  return {};
}

export async function saveStudentMushafMistakes(params: {
  workspace: ComplexWorkspaceData;
  studentId: string;
  studentName: string;
  mistakes: Record<string, number>;
  updatedBy: string;
}): Promise<Record<string, number>> {
  const { workspace, studentId, studentName, updatedBy } = params;
  const docId = buildMushafMistakesDocId(studentId);
  const cleanMistakes = sanitizeMistakesMap(params.mistakes);
  const cleanStudentName = (studentName || 'طالب').trim().slice(0, 120) || 'طالب';
  const cleanUpdater = (updatedBy || auth.currentUser?.uid || 'teacher').slice(0, 128);

  const located = await findExistingDocInTabPool(
    workspace,
    'curricula',
    'studentMushafMistakes',
    docId
  );

  if (located.exists) {
    await updateDoc(doc(located.db, 'studentMushafMistakes', docId), {
      studentName: cleanStudentName,
      mistakes: cleanMistakes,
      updatedBy: cleanUpdater,
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id: docId,
      complexId: workspace.complex.id,
      studentId,
      studentName: cleanStudentName,
      mistakes: cleanMistakes,
      updatedBy: cleanUpdater,
    };
    const byteSize = estimateRecordBytes(payload);
    await executeTabWriteWithRollover(workspace, 'curricula', byteSize, true, async (targetDb) => {
      await setDoc(doc(targetDb, 'studentMushafMistakes', docId), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  }

  return cleanMistakes;
}

// ============================================================================
// STANDALONE TEACHER WORKSPACE LOADER
// ============================================================================

export async function loadTeacherWorkspace(session: ActiveSession): Promise<{
  workspace: ComplexWorkspaceData;
  teacherAccount: AccountRecord;
}> {
  const workspace = await loadSupervisorWorkspace(session);
  const realAcc =
    workspace.accounts.find((a) => a.id === session.account.id) ||
    (session.account.uid
      ? workspace.accounts.find((a) => a.uid === session.account.uid)
      : undefined) ||
    session.account;
  return { workspace, teacherAccount: realAcc };
}

// ============================================================================
// LIVE MULTI-DATABASE USAGE TELEMETRY FOR PROGRAMMER ADMIN ("قواعد البيانات")
// ============================================================================

const ALL_TRACKED_COLLECTIONS: {
  col: string;
  label: string;
  tabGroup: ComplexFeatureTabKey | 'core_broadcasts';
  primaryOnly?: boolean;
}[] = [
  { col: 'complexes', label: 'المجمعات', tabGroup: 'mosques_halaqat' },
  { col: 'mosques', label: 'المساجد', tabGroup: 'mosques_halaqat' },
  { col: 'halaqat', label: 'الحلقات', tabGroup: 'mosques_halaqat' },
  { col: 'accounts', label: 'الحسابات والأعضاء', tabGroup: 'accounts_invites' },
  { col: 'nameIndex', label: 'فهرس الأسماء الفريدة', tabGroup: 'accounts_invites' },
  { col: 'inviteLinks', label: 'روابط التسجيل', tabGroup: 'accounts_invites' },
  { col: 'quickLinks', label: 'روابط الدخول السريع', tabGroup: 'accounts_invites' },
  { col: 'attendance', label: 'الحضور والغياب', tabGroup: 'attendance' },
  { col: 'books', label: 'الكتب والملفات', tabGroup: 'library' },
  { col: 'bookPages', label: 'صفحات الكتب والصور', tabGroup: 'library' },
  { col: 'wordAudio', label: 'صوتيات الكلمات والتهجي', tabGroup: 'library' },
  { col: 'curricula', label: 'المقررات', tabGroup: 'curricula' },
  { col: 'studentQuranPlans', label: 'خطط الحفظ والمراجعة', tabGroup: 'curricula' },
  { col: 'studentMushafMistakes', label: 'أخطاء تلاوة الطلاب', tabGroup: 'curricula' },
  { col: 'studentBookPlans', label: 'متابعة وواجبات الكتب', tabGroup: 'curricula' },
  { col: 'presentations', label: 'العروض التقديمية التفاعلية', tabGroup: 'presentations' },
  { col: 'broadcasts', label: 'الإشعارات والرسائل', tabGroup: 'core_broadcasts' },
  { col: 'stats', label: 'الإحصائيات', tabGroup: 'core_broadcasts' },
  { col: 'dbRegistry', label: 'سجل القواعد المرتبطة', tabGroup: 'core_broadcasts', primaryOnly: true },
];

export async function inspectAllDatabasesUsage(params: {
  complexes: DiscoveredComplex[];
  selectedComplexId: string; // 'all' | 'primary' | complexId
}): Promise<DatabaseUsageDashboardReport> {
  const { complexes, selectedComplexId } = params;
  const nowMs = Date.now();

  interface DbTargetMeta {
    dbKey: string;
    dbLabel: string;
    projectId: string;
    firestoreDatabaseId: string;
    isPrimary: boolean;
    db: Firestore;
    roleTags: Set<string>;
    complexIds: Set<string>;
    complexNames: Set<string>;
    limitBytes: number;
  }

  const dbMap = new Map<string, DbTargetMeta>();
  const primaryProjectId = primaryFirebaseConfig.projectId;
  const primaryDbId = primaryFirebaseConfig.firestoreDatabaseId || '(default)';

  const ensureEntry = (meta: {
    dbKey: string;
    dbLabel: string;
    projectId: string;
    firestoreDatabaseId: string;
    isPrimary: boolean;
    db: Firestore;
    limitBytes?: number;
  }): DbTargetMeta => {
    const existing = dbMap.get(meta.dbKey);
    if (existing) {
      if (meta.limitBytes && meta.limitBytes > existing.limitBytes) {
        existing.limitBytes = meta.limitBytes;
      }
      return existing;
    }
    const created: DbTargetMeta = {
      dbKey: meta.dbKey,
      dbLabel: meta.dbLabel,
      projectId: meta.projectId,
      firestoreDatabaseId: meta.firestoreDatabaseId,
      isPrimary: meta.isPrimary,
      db: meta.db,
      roleTags: new Set<string>(),
      complexIds: new Set<string>(),
      complexNames: new Set<string>(),
      limitBytes: meta.limitBytes || SPARK_FREE_TIER_BYTES,
    };
    dbMap.set(meta.dbKey, created);
    return created;
  };

  if (selectedComplexId === 'all' || selectedComplexId === 'primary') {
    const pMeta = ensureEntry({
      dbKey: 'primary',
      dbLabel: 'القاعدة الأساسية للموقع',
      projectId: primaryProjectId,
      firestoreDatabaseId: primaryDbId,
      isPrimary: true,
      db: primaryDb,
      limitBytes: SPARK_FREE_TIER_BYTES,
    });
    pMeta.roleTags.add('قاعدة المنصة الرئيسية (Primary)');
  }

  const libraryHostDbKeys = new Set<string>();
  const targetComplexes =
    selectedComplexId === 'all'
      ? complexes
      : selectedComplexId === 'primary'
      ? complexes.filter((c) => !c.isExternal)
      : complexes.filter((c) => c.id === selectedComplexId);

  for (const comp of targetComplexes) {
    const ownerProject = comp.ownerConfig?.projectId || primaryProjectId;
    const ownerDbId = comp.ownerConfig?.firestoreDatabaseId || '(default)';
    const ownerKey = comp.isExternal ? comp.ownerDbKey : 'primary';
    const ownerMeta = ensureEntry({
      dbKey: ownerKey,
      dbLabel: comp.isExternal ? comp.ownerDbLabel : 'القاعدة الأساسية للموقع',
      projectId: ownerProject,
      firestoreDatabaseId: ownerDbId,
      isPrimary: !comp.isExternal,
      db: comp.ownerDb,
      limitBytes: SPARK_FREE_TIER_BYTES,
    });
    ownerMeta.roleTags.add(`قاعدة مجمع: ${comp.name}`);
    ownerMeta.complexIds.add(comp.id);
    ownerMeta.complexNames.add(comp.name);

    // Inspect tabPools & mosques/halaqat configs for this complex
    const ws = await loadComplexWorkspace(comp).catch(() => null);
    if (ws) {
      for (const [mId, conf] of Object.entries(ws.mosqueConfigMap)) {
        if (!conf) continue;
        const mKey = dbKeyFromConfig(conf);
        const mObj = ws.mosques.find((m) => m.id === mId);
        const entry = ensureEntry({
          dbKey: mKey,
          dbLabel: `قاعدة منفصلة (${getDbDisplayLabel(conf)})`,
          projectId: conf.projectId,
          firestoreDatabaseId: conf.firestoreDatabaseId || '(default)',
          isPrimary: false,
          db: getFirestoreForConfig(conf),
          limitBytes: SPARK_FREE_TIER_BYTES,
        });
        entry.roleTags.add(`مسجد: ${mObj?.name || mId}`);
        entry.complexIds.add(comp.id);
        entry.complexNames.add(comp.name);
      }

      for (const tabKey of ALL_FEATURE_TAB_KEYS) {
        const shards = ws.tabPools?.[tabKey] || [];
        shards.forEach((sh, idx) => {
          const sKey = dbKeyFromConfig(sh.config);
          if (tabKey === 'library') {
            libraryHostDbKeys.add(sKey);
          }
          const entry = ensureEntry({
            dbKey: sKey,
            dbLabel: `قاعدة منفصلة (${getDbDisplayLabel(sh.config)})`,
            projectId: sh.config.projectId,
            firestoreDatabaseId: sh.config.firestoreDatabaseId || '(default)',
            isPrimary: false,
            db: getFirestoreForConfig(sh.config),
            limitBytes: sh.maxBytes || TAB_SHARD_MAX_BYTES,
          });
          const statusAr =
            sh.status === 'active' ? 'نشطة' : sh.status === 'full' ? 'ممتلئة' : 'احتياط';
          entry.roleTags.add(
            `${COMPLEX_FEATURE_TAB_LABELS[tabKey]} · شريحة #${idx + 1} (${statusAr})`
          );
          entry.complexIds.add(comp.id);
          entry.complexNames.add(comp.name);
        });
      }

      if ((ws.tabPools?.library || []).length === 0) {
        if (ws.tabConfigMap?.library) {
          libraryHostDbKeys.add(dbKeyFromConfig(ws.tabConfigMap.library));
        } else {
          libraryHostDbKeys.add(ownerKey);
        }
      }
    } else {
      libraryHostDbKeys.add(ownerKey);
    }
  }

  // Include Global Audio DB Pool shards explicitly in DB usage report
  const globalAudioPool = await loadGlobalAudioDbPool(true).catch(() => []);
  const globalAudioHostDbKeys = new Set<string>();
  if (selectedComplexId === 'all' && globalAudioPool.length > 0) {
    globalAudioPool.forEach((sh, idx) => {
      const aKey = dbKeyFromConfig(sh.config);
      globalAudioHostDbKeys.add(aKey);
      const entry = ensureEntry({
        dbKey: aKey,
        dbLabel: `قاعدة أصوات: ${sh.label}`,
        projectId: sh.config.projectId,
        firestoreDatabaseId: sh.config.firestoreDatabaseId || '(default)',
        isPrimary: false,
        db: getFirestoreForConfig(sh.config),
        limitBytes: sh.maxBytes || SPARK_FREE_TIER_BYTES,
      });
      const stAr =
        sh.status === 'active' ? 'نشطة للصوتيات' : sh.status === 'full' ? 'ممتلئة' : 'احتياط للصوتيات';
      entry.roleTags.add(`قاعدة أصوات عالمية #${idx + 1} (${stAr})`);
    });
  }

  // Also include standalone external DBs from registry when viewing 'all'
  if (selectedComplexId === 'all') {
    const known = await getAllKnownDatabases();
    for (const k of known) {
      if (k.isPrimary || !k.config) continue;
      const entry = ensureEntry({
        dbKey: k.key,
        dbLabel: k.label,
        projectId: k.config.projectId,
        firestoreDatabaseId: k.config.firestoreDatabaseId || '(default)',
        isPrimary: false,
        db: k.db,
        limitBytes: SPARK_FREE_TIER_BYTES,
      });
      if (entry.roleTags.size === 0) {
        entry.roleTags.add('قاعدة خارجية مربوطة بالسجل');
      }
    }
  }

  const tabAggMap = new Map<
    ComplexFeatureTabKey | 'core_broadcasts',
    { label: string; usedBytes: number; docsCount: number }
  >([
    ['mosques_halaqat', { label: COMPLEX_FEATURE_TAB_LABELS.mosques_halaqat, usedBytes: 0, docsCount: 0 }],
    ['accounts_invites', { label: COMPLEX_FEATURE_TAB_LABELS.accounts_invites, usedBytes: 0, docsCount: 0 }],
    ['attendance', { label: COMPLEX_FEATURE_TAB_LABELS.attendance, usedBytes: 0, docsCount: 0 }],
    ['library', { label: COMPLEX_FEATURE_TAB_LABELS.library, usedBytes: 0, docsCount: 0 }],
    ['curricula', { label: COMPLEX_FEATURE_TAB_LABELS.curricula, usedBytes: 0, docsCount: 0 }],
    ['presentations', { label: COMPLEX_FEATURE_TAB_LABELS.presentations, usedBytes: 0, docsCount: 0 }],
    ['core_broadcasts', { label: 'الإشعارات والنظام', usedBytes: 0, docsCount: 0 }],
  ]);

  const scopeSpecificComplex =
    selectedComplexId !== 'all' && selectedComplexId !== 'primary';

  let totalAudioDocs = 0;
  let audioWithWavDocs = 0;
  let audioWithWavBytes = 0;
  let tahajjiOnlyDocs = 0;
  let noorAlBayanDocs = 0;
  let normalDocs = 0;
  let totalAudioBytes = 0;
  const dbKeysWithAudioDocs = new Set<string>();

  const databaseSummaries: PhysicalDatabaseUsageSummary[] = await Promise.all(
    Array.from(dbMap.values()).map(async (meta) => {
      const colsToRead = ALL_TRACKED_COLLECTIONS.filter(
        (c) => !c.primaryOnly || meta.isPrimary
      );
      let reachable = false;
      let usedBytes = 0;
      let totalDocs = 0;
      const collectionStats: CollectionUsageStat[] = [];

      await Promise.all(
        colsToRead.map(async (cMeta) => {
          try {
            const shouldFilterByComplex =
              scopeSpecificComplex &&
              meta.isPrimary &&
              !['stats', 'dbRegistry', 'broadcasts'].includes(cMeta.col);

            const qRef =
              shouldFilterByComplex && cMeta.col === 'complexes'
                ? query(collection(meta.db, cMeta.col), where('id', '==', selectedComplexId))
                : shouldFilterByComplex
                ? query(collection(meta.db, cMeta.col), where('complexId', '==', selectedComplexId))
                : collection(meta.db, cMeta.col);

            const snap = await getDocsFresh(qRef);
            reachable = true;
            let colBytes = 0;
            let colDocs = 0;
            snap.forEach((d) => {
              const rawData = d.data();
              const docBytes = estimateRecordBytes(rawData);
              colDocs++;
              colBytes += docBytes;

              if (cMeta.col === 'wordAudio') {
                dbKeysWithAudioDocs.add(meta.dbKey);
                totalAudioDocs++;
                totalAudioBytes += docBytes;
                const audioRec = rawData as { audioBase64?: unknown; mode?: unknown };
                if (typeof audioRec.audioBase64 === 'string' && audioRec.audioBase64.length > 120) {
                  audioWithWavDocs++;
                  audioWithWavBytes += docBytes;
                } else {
                  tahajjiOnlyDocs++;
                }
                if (audioRec.mode === 'noor_albayan') {
                  noorAlBayanDocs++;
                } else if (audioRec.mode === 'normal') {
                  normalDocs++;
                }
              }
            });
            totalDocs += colDocs;
            usedBytes += colBytes;
            collectionStats.push({
              collection: cMeta.col,
              label: cMeta.label,
              docsCount: colDocs,
              usedBytes: colBytes,
            });
            const agg = tabAggMap.get(cMeta.tabGroup);
            if (agg) {
              agg.usedBytes += colBytes;
              agg.docsCount += colDocs;
            }
          } catch {
            // Skip inaccessible collection cleanly; overall reachability checked below
          }
        })
      );

      collectionStats.sort((a, b) => b.usedBytes - a.usedBytes);
      const limitBytes = Math.max(SPARK_FREE_TIER_BYTES, meta.limitBytes);
      const remainingBytes = Math.max(0, limitBytes - usedBytes);
      const usagePercent = Math.min(100, Number(((usedBytes / limitBytes) * 100).toFixed(4)));

      return {
        dbKey: meta.dbKey,
        dbLabel: meta.dbLabel,
        projectId: meta.projectId,
        firestoreDatabaseId: meta.firestoreDatabaseId,
        isPrimary: meta.isPrimary,
        reachable,
        ...(!reachable ? { errorMessage: 'تعذّر قراءة القاعدة أو الصلاحيات غير مكتملة.' } : {}),
        roleTags: Array.from(meta.roleTags),
        complexIds: Array.from(meta.complexIds),
        complexNames: Array.from(meta.complexNames),
        totalDocs,
        usedBytes,
        limitBytes,
        remainingBytes,
        usagePercent,
        collections: collectionStats,
        checkedAtMs: nowMs,
      };
    })
  );

  // Order Primary DB first (if present), then most used descending
  databaseSummaries.sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return b.usedBytes - a.usedBytes;
  });

  const resolvedAudioHostKeys =
    globalAudioHostDbKeys.size > 0
      ? globalAudioHostDbKeys
      : new Set<string>([
          ...Array.from(libraryHostDbKeys),
          ...Array.from(dbKeysWithAudioDocs),
        ]);
  let libraryHosts = databaseSummaries.filter((d) => resolvedAudioHostKeys.has(d.dbKey));
  if (libraryHosts.length === 0 && databaseSummaries.length > 0) {
    libraryHosts = [databaseSummaries[0]];
  }

  const isAvgEstimated = audioWithWavDocs === 0;
  const avgAudioClipBytes =
    audioWithWavDocs > 0
      ? Math.max(1024, Math.round(audioWithWavBytes / audioWithWavDocs))
      : 150 * 1024; // ~150 KB realistic WAV baseline before clips accumulate
  const librarySparkTotalLimitBytes =
    Math.max(1, libraryHosts.length) * SPARK_FREE_TIER_BYTES;
  const librarySparkTotalUsedBytes = libraryHosts.reduce((acc, d) => acc + d.usedBytes, 0);
  const librarySparkRemainingBytes = Math.max(
    0,
    librarySparkTotalLimitBytes - librarySparkTotalUsedBytes
  );
  const librarySparkUsagePercent = Math.min(
    100,
    Number(((librarySparkTotalUsedBytes / librarySparkTotalLimitBytes) * 100).toFixed(4))
  );

  const audioStorageSummary: AudioStorageQuotaSummary = {
    totalAudioDocs,
    audioWithWavDocs,
    tahajjiOnlyDocs,
    noorAlBayanDocs,
    normalDocs,
    totalAudioBytes,
    avgAudioClipBytes,
    isAvgEstimated,
    libraryHostDbCount: libraryHosts.length,
    libraryHostDbLabels: libraryHosts.map((d) => d.dbLabel),
    sparkFreeLimitPerDbBytes: SPARK_FREE_TIER_BYTES,
    librarySparkTotalLimitBytes,
    librarySparkTotalUsedBytes,
    librarySparkRemainingBytes,
    librarySparkUsagePercent,
    estimatedRemainingAudioClips: Math.floor(librarySparkRemainingBytes / avgAudioClipBytes),
    globalAudioPoolActive: globalAudioPool.length > 0,
    globalAudioHostCount: globalAudioPool.length,
  };

  const totalDocsCount = databaseSummaries.reduce((acc, d) => acc + d.totalDocs, 0);
  const totalUsedBytes = databaseSummaries.reduce((acc, d) => acc + d.usedBytes, 0);
  const totalLimitBytes = databaseSummaries.reduce((acc, d) => acc + d.limitBytes, 0);
  const totalRemainingBytes = Math.max(0, totalLimitBytes - totalUsedBytes);

  return {
    checkedAtMs: nowMs,
    selectedComplexId,
    databases: databaseSummaries,
    totalDatabasesCount: databaseSummaries.length,
    totalDocsCount,
    totalUsedBytes,
    totalLimitBytes,
    totalRemainingBytes,
    byTabSummary: Array.from(tabAggMap.entries()).map(([tabKey, val]) => ({
      tabKey,
      label: val.label,
      usedBytes: val.usedBytes,
      docsCount: val.docsCount,
    })),
    audioStorageSummary,
  };
}

// ============================================================================
// STUDENT BOOK PLANS (أين وصلنا + واجبات اليوم + واجبات غد للكتب والصور)
// ============================================================================

export function buildBookPlanDocId(
  studentId: string,
  bookId: string,
  dateKey: string
): string {
  const cleanStudent = studentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const cleanBook = bookId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const cleanDate = dateKey.replace(/[^0-9-]/g, '').slice(0, 16);
  return `bp_${cleanStudent}_${cleanBook}_${cleanDate}`.slice(0, 128);
}

function sanitizeBookHomeworks(rawList: unknown): StudentBookHomeworkItem[] {
  if (!Array.isArray(rawList)) return [];
  const validTypes = new Set<BookHomeworkType>(
    Object.keys(BOOK_HOMEWORK_TYPE_LABELS) as BookHomeworkType[]
  );
  const validStatuses = new Set<BookHomeworkStatus>([
    'pending',
    'completed',
    'cancelled',
    'deferred',
  ]);
  return rawList.slice(0, 80).map((raw) => {
    const r = (raw || {}) as Partial<StudentBookHomeworkItem>;
    const type: BookHomeworkType =
      r.type && validTypes.has(r.type) ? r.type : 'reading';
    const status: BookHomeworkStatus =
      r.status && validStatuses.has(r.status) ? r.status : 'pending';
    const pageNumber = Math.max(
      1,
      Math.min(2000, Math.floor(Number(r.pageNumber) || 1))
    );
    return {
      id:
        r.id && typeof r.id === 'string' && r.id.trim()
          ? r.id.trim().slice(0, 64)
          : generateValidId('hw'),
      type,
      ...(r.customTypeLabel
        ? { customTypeLabel: String(r.customTypeLabel).trim().slice(0, 80) }
        : {}),
      pageNumber,
      ...(r.note ? { note: String(r.note).trim().slice(0, 240) } : {}),
      status,
      ...(r.deferredFromDate
        ? { deferredFromDate: String(r.deferredFromDate).trim().slice(0, 16) }
        : {}),
    };
  });
}

export async function listStudentBookPlanHistory(
  workspace: ComplexWorkspaceData,
  studentId: string,
  bookId: string
): Promise<StudentBookPlanRecord[]> {
  try {
    const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
    const byId = new Map<string, StudentBookPlanRecord>();
    await Promise.all(
      readDbs.map(async (db) => {
        const snap = await getDocsFresh(
          query(collection(db, 'studentBookPlans'), where('studentId', '==', studentId))
        ).catch(() => null);
        snap?.forEach((d) => {
          const rec = d.data() as StudentBookPlanRecord;
          if (rec.complexId === workspace.complex.id && rec.bookId === bookId) {
            byId.set(rec.id, rec);
          }
        });
      })
    );
    return Array.from(byId.values()).sort((a, b) =>
      b.dateKey.localeCompare(a.dateKey)
    );
  } catch {
    return [];
  }
}

export async function loadStudentBookPlanForDate(params: {
  workspace: ComplexWorkspaceData;
  studentId: string;
  bookId: string;
  dateKey: string;
}): Promise<{
  savedPlan: StudentBookPlanRecord | null;
  historyRecords: StudentBookPlanRecord[];
  carriedFromDate: string | null;
  effectiveWhereReachedPage: number;
  effectiveTodayHomeworks: StudentBookHomeworkItem[];
  effectiveTomorrowHomeworks: StudentBookHomeworkItem[];
}> {
  const { workspace, studentId, bookId, dateKey } = params;
  const historyRecords = await listStudentBookPlanHistory(workspace, studentId, bookId);
  const exact = historyRecords.find((r) => r.dateKey === dateKey) || null;

  if (exact) {
    return {
      savedPlan: exact,
      historyRecords,
      carriedFromDate: null,
      effectiveWhereReachedPage: Math.max(
        1,
        Math.min(2000, Math.floor(Number(exact.whereWeReachedPage) || 1))
      ),
      effectiveTodayHomeworks: Array.isArray(exact.todayHomeworks)
        ? exact.todayHomeworks
        : [],
      effectiveTomorrowHomeworks: Array.isArray(exact.tomorrowHomeworks)
        ? exact.tomorrowHomeworks
        : [],
    };
  }

  // Carry over latest stopped page from most recent prior session (defaults to Page 1)
  const mostRecentPrior = historyRecords.find((r) => r.dateKey < dateKey) || null;
  const effectiveWhereReachedPage = mostRecentPrior
    ? Math.max(
        1,
        Math.min(2000, Math.floor(Number(mostRecentPrior.whereWeReachedPage) || 1))
      )
    : 1;

  // Carry over yesterday's "tomorrowHomeworks" automatically into today's "todayHomeworks"
  const priorWithHomeworks = historyRecords.find(
    (r) =>
      r.dateKey < dateKey &&
      Array.isArray(r.tomorrowHomeworks) &&
      r.tomorrowHomeworks.length > 0
  );

  if (priorWithHomeworks) {
    return {
      savedPlan: null,
      historyRecords,
      carriedFromDate: priorWithHomeworks.dateKey,
      effectiveWhereReachedPage,
      effectiveTodayHomeworks: (priorWithHomeworks.tomorrowHomeworks || []).map(
        (hw) => ({
          ...hw,
          id: generateValidId('hw'),
          status: 'pending' as const,
        })
      ),
      effectiveTomorrowHomeworks: [],
    };
  }

  return {
    savedPlan: null,
    historyRecords,
    carriedFromDate: null,
    effectiveWhereReachedPage,
    effectiveTodayHomeworks: [],
    effectiveTomorrowHomeworks: [],
  };
}

export async function saveStudentBookPlan(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  studentId: string;
  studentName: string;
  bookId: string;
  bookTitle: string;
  dateKey: string;
  whereWeReachedPage: number;
  todayHomeworks: StudentBookHomeworkItem[];
  tomorrowHomeworks: StudentBookHomeworkItem[];
  recordedBy: string;
  recordedByName: string;
}): Promise<StudentBookPlanRecord> {
  const {
    workspace,
    mosqueId,
    halaqaId,
    studentId,
    studentName,
    bookId,
    bookTitle,
    dateKey,
    recordedBy,
    recordedByName,
  } = params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('صيغة التاريخ غير صالحة.');
  }

  const planId = buildBookPlanDocId(studentId, bookId, dateKey);
  const cleanPage = Math.max(
    1,
    Math.min(2000, Math.floor(Number(params.whereWeReachedPage) || 1))
  );
  const cleanToday = sanitizeBookHomeworks(params.todayHomeworks);
  const cleanTomorrow = sanitizeBookHomeworks(params.tomorrowHomeworks);
  const cleanStudentName = (studentName || 'طالب').trim().slice(0, 120) || 'طالب';
  const cleanBookTitle = (bookTitle || 'كتاب').trim().slice(0, 160) || 'كتاب';
  const cleanRecorder = (recordedBy || auth.currentUser?.uid || 'teacher').slice(0, 128);
  const cleanRecorderName = (recordedByName || 'المعلم').trim().slice(0, 120) || 'المعلم';

  const located = await findExistingDocInTabPool(
    workspace,
    'curricula',
    'studentBookPlans',
    planId
  );

  if (located.exists) {
    await updateDoc(doc(located.db, 'studentBookPlans', planId), {
      mosqueId: (mosqueId || '').slice(0, 128),
      halaqaId: (halaqaId || '').slice(0, 128),
      studentName: cleanStudentName,
      bookTitle: cleanBookTitle,
      whereWeReachedPage: cleanPage,
      todayHomeworks: cleanToday,
      tomorrowHomeworks: cleanTomorrow,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload = {
      id: planId,
      complexId: workspace.complex.id,
      mosqueId: (mosqueId || '').slice(0, 128),
      halaqaId: (halaqaId || '').slice(0, 128),
      studentId,
      studentName: cleanStudentName,
      bookId,
      bookTitle: cleanBookTitle,
      dateKey,
      whereWeReachedPage: cleanPage,
      todayHomeworks: cleanToday,
      tomorrowHomeworks: cleanTomorrow,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
    };
    const byteSize = estimateRecordBytes(payload);
    await executeTabWriteWithRollover(workspace, 'curricula', byteSize, true, async (targetDb) => {
      await setDoc(doc(targetDb, 'studentBookPlans', planId), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  }

  return {
    id: planId,
    complexId: workspace.complex.id,
    mosqueId: (mosqueId || '').slice(0, 128),
    halaqaId: (halaqaId || '').slice(0, 128),
    studentId,
    studentName: cleanStudentName,
    bookId,
    bookTitle: cleanBookTitle,
    dateKey,
    whereWeReachedPage: cleanPage,
    todayHomeworks: cleanToday,
    tomorrowHomeworks: cleanTomorrow,
    recordedBy: cleanRecorder,
    recordedByName: cleanRecorderName,
  };
}

export interface HalaqaStudentCurriculaStatus {
  quranTomorrowAssigned: boolean;
  quranTomorrowNew: StudentQuranNewHifzItem | null;
  quranTomorrowReviewsCount: number;
  books: Record<
    string,
    {
      whereWeReachedPage: number;
      todayHomeworksCount: number;
      tomorrowHomeworksCount: number;
      tomorrowHomeworkAssigned: boolean;
    }
  >;
}

/**
 * Loads today's Quran & Book assignment status for every student in a halaqa
 * in a single pooled pass so badges render immediately above each student card.
 */
export async function loadHalaqaCurriculaStatusesForDate(params: {
  workspace: ComplexWorkspaceData;
  studentIds: string[];
  dateKey: string;
}): Promise<Record<string, HalaqaStudentCurriculaStatus>> {
  const { workspace, studentIds, dateKey } = params;
  const result: Record<string, HalaqaStudentCurriculaStatus> = {};
  for (const sid of studentIds) {
    result[sid] = {
      quranTomorrowAssigned: false,
      quranTomorrowNew: null,
      quranTomorrowReviewsCount: 0,
      books: {},
    };
  }
  if (studentIds.length === 0) return result;

  const studentSet = new Set(studentIds);
  const readDbs = getReadDbsForComplexTab(workspace, 'curricula');

  const quranById = new Map<string, StudentQuranPlanRecord>();
  const bookById = new Map<string, StudentBookPlanRecord>();

  await Promise.all(
    readDbs.map(async (db) => {
      const [qSnap, bSnap] = await Promise.all([
        getDocsFresh(
          query(collection(db, 'studentQuranPlans'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null),
        getDocsFresh(
          query(collection(db, 'studentBookPlans'), where('complexId', '==', workspace.complex.id))
        ).catch(() => null),
      ]);

      qSnap?.forEach((d) => {
        const rec = d.data() as StudentQuranPlanRecord;
        if (studentSet.has(rec.studentId)) {
          quranById.set(rec.id, rec);
        }
      });

      bSnap?.forEach((d) => {
        const rec = d.data() as StudentBookPlanRecord;
        if (studentSet.has(rec.studentId)) {
          bookById.set(rec.id, rec);
        }
      });
    })
  );

  // Evaluate Quran tomorrow assignment status per student for `dateKey`
  quranById.forEach((rec) => {
    if (rec.dateKey !== dateKey) return;
    const entry = result[rec.studentId];
    if (!entry) return;
    const hasTomorrowNew = Boolean(rec.tomorrowNew);
    const revCount = Array.isArray(rec.tomorrowReviews) ? rec.tomorrowReviews.length : 0;
    entry.quranTomorrowNew = rec.tomorrowNew || null;
    entry.quranTomorrowReviewsCount = revCount;
    entry.quranTomorrowAssigned = hasTomorrowNew || revCount > 0;
  });

  // Group book records per (studentId -> bookId) sorted newest first
  const groupedBooks = new Map<string, Map<string, StudentBookPlanRecord[]>>();
  bookById.forEach((rec) => {
    if (!rec.studentId || !rec.bookId) return;
    let stMap = groupedBooks.get(rec.studentId);
    if (!stMap) {
      stMap = new Map();
      groupedBooks.set(rec.studentId, stMap);
    }
    const list = stMap.get(rec.bookId) || [];
    list.push(rec);
    stMap.set(rec.bookId, list);
  });

  groupedBooks.forEach((booksMap, sid) => {
    const entry = result[sid];
    if (!entry) return;
    booksMap.forEach((records, bookId) => {
      const sorted = [...records].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
      const exact = sorted.find((r) => r.dateKey === dateKey) || null;
      const prior = sorted.find((r) => r.dateKey < dateKey) || null;
      const wherePage = exact
        ? Math.max(1, Math.min(2000, Math.floor(Number(exact.whereWeReachedPage) || 1)))
        : prior
        ? Math.max(1, Math.min(2000, Math.floor(Number(prior.whereWeReachedPage) || 1)))
        : 1;
      const tomorrowList = exact && Array.isArray(exact.tomorrowHomeworks)
        ? exact.tomorrowHomeworks
        : [];
      const todayList = exact && Array.isArray(exact.todayHomeworks)
        ? exact.todayHomeworks
        : [];

      entry.books[bookId] = {
        whereWeReachedPage: wherePage,
        todayHomeworksCount: todayList.length,
        tomorrowHomeworksCount: tomorrowList.length,
        tomorrowHomeworkAssigned: tomorrowList.length > 0,
      };
    });
  });

  return result;
}

export async function batchApplyBookWhereReachedForStudents(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  students: AccountRecord[];
  bookId: string;
  bookTitle: string;
  dateKey: string;
  pageNumber: number;
  recordedBy: string;
  recordedByName: string;
}): Promise<{ savedCount: number; failedCount: number }> {
  const {
    workspace,
    mosqueId,
    halaqaId,
    students,
    bookId,
    bookTitle,
    dateKey,
    pageNumber,
    recordedBy,
    recordedByName,
  } = params;

  const cleanPage = Math.max(1, Math.min(2000, Math.floor(Number(pageNumber) || 1)));
  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < students.length; i += 5) {
    const chunk = students.slice(i, i + 5);
    await Promise.all(
      chunk.map(async (st) => {
        try {
          const existing = await loadStudentBookPlanForDate({
            workspace,
            studentId: st.id,
            bookId,
            dateKey,
          });
          await saveStudentBookPlan({
            workspace,
            mosqueId,
            halaqaId,
            studentId: st.id,
            studentName: st.quadrupleName,
            bookId,
            bookTitle,
            dateKey,
            whereWeReachedPage: cleanPage,
            todayHomeworks: existing.effectiveTodayHomeworks,
            tomorrowHomeworks: existing.effectiveTomorrowHomeworks,
            recordedBy,
            recordedByName,
          });
          savedCount++;
        } catch {
          failedCount++;
        }
      })
    );
  }

  return { savedCount, failedCount };
}

export async function batchAssignTomorrowBookHomeworkForStudents(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  students: AccountRecord[];
  bookId: string;
  bookTitle: string;
  dateKey: string;
  homeworks: Omit<StudentBookHomeworkItem, 'id' | 'status'>[];
  replaceExisting: boolean;
  recordedBy: string;
  recordedByName: string;
}): Promise<{ savedCount: number; failedCount: number }> {
  const {
    workspace,
    mosqueId,
    halaqaId,
    students,
    bookId,
    bookTitle,
    dateKey,
    homeworks,
    replaceExisting,
    recordedBy,
    recordedByName,
  } = params;

  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < students.length; i += 5) {
    const chunk = students.slice(i, i + 5);
    await Promise.all(
      chunk.map(async (st) => {
        try {
          const existing = await loadStudentBookPlanForDate({
            workspace,
            studentId: st.id,
            bookId,
            dateKey,
          });
          const clonedNew: StudentBookHomeworkItem[] = homeworks.map((hw) => ({
            ...hw,
            id: generateValidId('hw'),
            status: 'pending' as const,
          }));
          const nextTomorrow = replaceExisting
            ? clonedNew
            : [...existing.effectiveTomorrowHomeworks, ...clonedNew];

          await saveStudentBookPlan({
            workspace,
            mosqueId,
            halaqaId,
            studentId: st.id,
            studentName: st.quadrupleName,
            bookId,
            bookTitle,
            dateKey,
            whereWeReachedPage: existing.effectiveWhereReachedPage,
            todayHomeworks: existing.effectiveTodayHomeworks,
            tomorrowHomeworks: nextTomorrow,
            recordedBy,
            recordedByName,
          });
          savedCount++;
        } catch {
          failedCount++;
        }
      })
    );
  }

  return { savedCount, failedCount };
}

export async function batchAssignTomorrowQuranPlanForStudents(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  students: AccountRecord[];
  dateKey: string;
  tomorrowNew: StudentQuranNewHifzItem | null;
  tomorrowReviews: Omit<StudentQuranReviewItem, 'id' | 'completed'>[];
  replaceExisting: boolean;
  recordedBy: string;
  recordedByName: string;
}): Promise<{ savedCount: number; failedCount: number }> {
  const {
    workspace,
    mosqueId,
    halaqaId,
    students,
    dateKey,
    tomorrowNew,
    tomorrowReviews,
    replaceExisting,
    recordedBy,
    recordedByName,
  } = params;

  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < students.length; i += 5) {
    const chunk = students.slice(i, i + 5);
    await Promise.all(
      chunk.map(async (st) => {
        try {
          const existing = await loadStudentQuranPlanForDate({
            workspace,
            studentId: st.id,
            dateKey,
          });
          const nextTomorrowNew = tomorrowNew
            ? (() => {
                const { completed: _ignored, ...rest } = tomorrowNew;
                return rest;
              })()
            : replaceExisting
            ? null
            : existing.effectiveTomorrowNew;

          const clonedReviews: StudentQuranReviewItem[] = tomorrowReviews.map((rev) => ({
            ...rev,
            id: generateValidId('rev'),
          }));
          const nextTomorrowReviews = replaceExisting
            ? clonedReviews
            : [...existing.effectiveTomorrowReviews, ...clonedReviews];

          await saveStudentQuranPlan({
            workspace,
            mosqueId,
            halaqaId,
            studentId: st.id,
            studentName: st.quadrupleName,
            dateKey,
            todayNew: existing.effectiveTodayNew,
            todayReviews: existing.effectiveTodayReviews,
            tomorrowNew: nextTomorrowNew,
            tomorrowReviews: nextTomorrowReviews,
            recordedBy,
            recordedByName,
          });
          savedCount++;
        } catch {
          failedCount++;
        }
      })
    );
  }

  return { savedCount, failedCount };
}

/**
 * Applies tasmee rules:
 * - Untouched (`completed !== false`) becomes `completed: true` (heard by default).
 * - Unheard (`completed === false`) is auto-assigned to tomorrowNew / tomorrowReviews (deduplicated).
 */
export function applyQuranTasmeeOutcomesToPlan(params: {
  todayNew: StudentQuranNewHifzItem | null;
  todayReviews: StudentQuranReviewItem[];
  tomorrowNew: StudentQuranNewHifzItem | null;
  tomorrowReviews: StudentQuranReviewItem[];
}): {
  finalTodayNew: StudentQuranNewHifzItem | null;
  finalTodayReviews: StudentQuranReviewItem[];
  finalTomorrowNew: StudentQuranNewHifzItem | null;
  finalTomorrowReviews: StudentQuranReviewItem[];
} {
  const finalTodayNew: StudentQuranNewHifzItem | null = params.todayNew
    ? { ...params.todayNew, completed: params.todayNew.completed !== false }
    : null;

  const finalTodayReviews: StudentQuranReviewItem[] = params.todayReviews.map((rev) => ({
    ...rev,
    completed: rev.completed !== false,
  }));

  let finalTomorrowNew = params.tomorrowNew;
  if (finalTodayNew && finalTodayNew.completed === false) {
    const { completed: _c, note: _n, ...rangeProps } = finalTodayNew;
    finalTomorrowNew = {
      ...rangeProps,
      ...(params.tomorrowNew?.reciterId ? { reciterId: params.tomorrowNew.reciterId } : {}),
    };
  }

  const finalTomorrowReviews = [...params.tomorrowReviews];
  for (const rev of finalTodayReviews) {
    if (rev.completed !== false) continue;
    const alreadyExists = finalTomorrowReviews.some(
      (existing) =>
        existing.reviewType === rev.reviewType &&
        (existing.customLabel || '') === (rev.customLabel || '') &&
        existing.startSurah === rev.startSurah &&
        existing.startAyah === rev.startAyah &&
        existing.endSurah === rev.endSurah &&
        existing.endAyah === rev.endAyah
    );
    if (!alreadyExists) {
      const { id: _oldId, completed: _c, ...rest } = rev;
      finalTomorrowReviews.push({
        ...rest,
        id: generateValidId('rev'),
      });
    }
  }

  return {
    finalTodayNew,
    finalTodayReviews,
    finalTomorrowNew,
    finalTomorrowReviews,
  };
}

/**
 * Applies book homework correction rules:
 * - Untouched `'pending'` becomes `'completed'` ("تم الحل").
 * - `'deferred'` ("لم يحل") is auto-copied to tomorrowHomeworks (deduplicated).
 */
export function applyBookCorrectionOutcomesToPlan(params: {
  dateKey: string;
  todayHomeworks: StudentBookHomeworkItem[];
  tomorrowHomeworks: StudentBookHomeworkItem[];
}): {
  finalTodayHomeworks: StudentBookHomeworkItem[];
  finalTomorrowHomeworks: StudentBookHomeworkItem[];
} {
  const finalTodayHomeworks: StudentBookHomeworkItem[] = params.todayHomeworks.map((hw) =>
    hw.status === 'pending' ? { ...hw, status: 'completed' as const } : hw
  );

  const finalTomorrowHomeworks = [...params.tomorrowHomeworks];
  for (const hw of finalTodayHomeworks) {
    if (hw.status !== 'deferred') continue;
    const alreadyQueued = finalTomorrowHomeworks.some(
      (ex) =>
        ex.type === hw.type &&
        ex.pageNumber === hw.pageNumber &&
        (ex.customTypeLabel || '') === (hw.customTypeLabel || '') &&
        (ex.note || '') === (hw.note || '')
    );
    if (!alreadyQueued) {
      finalTomorrowHomeworks.push({
        ...hw,
        id: generateValidId('hw'),
        status: 'pending' as const,
        deferredFromDate: hw.deferredFromDate || params.dateKey,
      });
    }
  }

  return {
    finalTodayHomeworks,
    finalTomorrowHomeworks,
  };
}

export interface HalaqaStudentTodayQuranPlanEntry {
  studentId: string;
  carriedFromDate: string | null;
  todayNew: StudentQuranNewHifzItem | null;
  todayReviews: StudentQuranReviewItem[];
  tomorrowNew: StudentQuranNewHifzItem | null;
  tomorrowReviews: StudentQuranReviewItem[];
}

export async function loadHalaqaTodayQuranPlans(params: {
  workspace: ComplexWorkspaceData;
  studentIds: string[];
  dateKey: string;
}): Promise<Record<string, HalaqaStudentTodayQuranPlanEntry>> {
  const { workspace, studentIds, dateKey } = params;
  const map: Record<string, HalaqaStudentTodayQuranPlanEntry> = {};
  for (const sid of studentIds) {
    map[sid] = {
      studentId: sid,
      carriedFromDate: null,
      todayNew: null,
      todayReviews: [],
      tomorrowNew: null,
      tomorrowReviews: [],
    };
  }
  if (studentIds.length === 0) return map;

  const studentSet = new Set(studentIds);
  const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
  const byStudent = new Map<string, Map<string, StudentQuranPlanRecord>>();

  await Promise.all(
    readDbs.map(async (db) => {
      const snap = await getDocsFresh(
        query(collection(db, 'studentQuranPlans'), where('complexId', '==', workspace.complex.id))
      ).catch(() => null);
      snap?.forEach((d) => {
        const rec = d.data() as StudentQuranPlanRecord;
        if (!studentSet.has(rec.studentId)) return;
        let recMap = byStudent.get(rec.studentId);
        if (!recMap) {
          recMap = new Map();
          byStudent.set(rec.studentId, recMap);
        }
        recMap.set(rec.id, rec);
      });
    })
  );

  byStudent.forEach((recMap, sid) => {
    const history = Array.from(recMap.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
    const exact = history.find((r) => r.dateKey === dateKey) || null;
    if (exact) {
      map[sid] = {
        studentId: sid,
        carriedFromDate: null,
        todayNew: exact.todayNew || null,
        todayReviews: Array.isArray(exact.todayReviews) ? exact.todayReviews : [],
        tomorrowNew: exact.tomorrowNew || null,
        tomorrowReviews: Array.isArray(exact.tomorrowReviews) ? exact.tomorrowReviews : [],
      };
      return;
    }

    const prior = history.find(
      (r) => r.dateKey < dateKey && (r.tomorrowNew !== null || (r.tomorrowReviews || []).length > 0)
    );
    if (prior) {
      const cleanNew = prior.tomorrowNew
        ? (() => {
            const { completed: _c, ...rest } = prior.tomorrowNew;
            return rest;
          })()
        : null;
      map[sid] = {
        studentId: sid,
        carriedFromDate: prior.dateKey,
        todayNew: cleanNew,
        todayReviews: (prior.tomorrowReviews || []).map((rev) => {
          const { completed: _c, ...rest } = rev;
          return {
            ...rest,
            id: generateValidId('rev'),
          };
        }),
        tomorrowNew: null,
        tomorrowReviews: [],
      };
    }
  });

  return map;
}

export async function saveBatchQuranTasmeeOutcomes(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  dateKey: string;
  entries: {
    student: AccountRecord;
    todayNew: StudentQuranNewHifzItem | null;
    todayReviews: StudentQuranReviewItem[];
    tomorrowNew: StudentQuranNewHifzItem | null;
    tomorrowReviews: StudentQuranReviewItem[];
  }[];
  recordedBy: string;
  recordedByName: string;
}): Promise<{ savedCount: number; failedCount: number }> {
  const { workspace, mosqueId, halaqaId, dateKey, entries, recordedBy, recordedByName } = params;
  const nonEmptyEntries = entries.filter(
    (e) =>
      e.todayNew !== null ||
      e.todayReviews.length > 0 ||
      e.tomorrowNew !== null ||
      e.tomorrowReviews.length > 0
  );

  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < nonEmptyEntries.length; i += 5) {
    const chunk = nonEmptyEntries.slice(i, i + 5);
    await Promise.all(
      chunk.map(async (item) => {
        try {
          const normalized = applyQuranTasmeeOutcomesToPlan({
            todayNew: item.todayNew,
            todayReviews: item.todayReviews,
            tomorrowNew: item.tomorrowNew,
            tomorrowReviews: item.tomorrowReviews,
          });
          await saveStudentQuranPlan({
            workspace,
            mosqueId,
            halaqaId,
            studentId: item.student.id,
            studentName: item.student.quadrupleName,
            dateKey,
            todayNew: normalized.finalTodayNew,
            todayReviews: normalized.finalTodayReviews,
            tomorrowNew: normalized.finalTomorrowNew,
            tomorrowReviews: normalized.finalTomorrowReviews,
            recordedBy,
            recordedByName,
          });
          savedCount++;
        } catch {
          failedCount++;
        }
      })
    );
  }

  return { savedCount, failedCount };
}

export interface HalaqaStudentTodayBookPlanEntry {
  studentId: string;
  carriedFromDate: string | null;
  whereWeReachedPage: number;
  todayHomeworks: StudentBookHomeworkItem[];
  tomorrowHomeworks: StudentBookHomeworkItem[];
}

export async function loadHalaqaTodayBookPlans(params: {
  workspace: ComplexWorkspaceData;
  studentIds: string[];
  bookId: string;
  dateKey: string;
}): Promise<Record<string, HalaqaStudentTodayBookPlanEntry>> {
  const { workspace, studentIds, bookId, dateKey } = params;
  const map: Record<string, HalaqaStudentTodayBookPlanEntry> = {};
  for (const sid of studentIds) {
    map[sid] = {
      studentId: sid,
      carriedFromDate: null,
      whereWeReachedPage: 1,
      todayHomeworks: [],
      tomorrowHomeworks: [],
    };
  }
  if (studentIds.length === 0) return map;

  const studentSet = new Set(studentIds);
  const readDbs = getReadDbsForComplexTab(workspace, 'curricula');
  const byStudent = new Map<string, Map<string, StudentBookPlanRecord>>();

  await Promise.all(
    readDbs.map(async (db) => {
      const snap = await getDocsFresh(
        query(collection(db, 'studentBookPlans'), where('complexId', '==', workspace.complex.id))
      ).catch(() => null);
      snap?.forEach((d) => {
        const rec = d.data() as StudentBookPlanRecord;
        if (rec.bookId !== bookId || !studentSet.has(rec.studentId)) return;
        let recMap = byStudent.get(rec.studentId);
        if (!recMap) {
          recMap = new Map();
          byStudent.set(rec.studentId, recMap);
        }
        recMap.set(rec.id, rec);
      });
    })
  );

  byStudent.forEach((recMap, sid) => {
    const history = Array.from(recMap.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
    const exact = history.find((r) => r.dateKey === dateKey) || null;
    if (exact) {
      map[sid] = {
        studentId: sid,
        carriedFromDate: null,
        whereWeReachedPage: Math.max(
          1,
          Math.min(2000, Math.floor(Number(exact.whereWeReachedPage) || 1))
        ),
        todayHomeworks: Array.isArray(exact.todayHomeworks) ? exact.todayHomeworks : [],
        tomorrowHomeworks: Array.isArray(exact.tomorrowHomeworks) ? exact.tomorrowHomeworks : [],
      };
      return;
    }

    const mostRecentPrior = history.find((r) => r.dateKey < dateKey) || null;
    const wherePage = mostRecentPrior
      ? Math.max(1, Math.min(2000, Math.floor(Number(mostRecentPrior.whereWeReachedPage) || 1)))
      : 1;
    const priorWithHw = history.find(
      (r) =>
        r.dateKey < dateKey &&
        Array.isArray(r.tomorrowHomeworks) &&
        r.tomorrowHomeworks.length > 0
    );
    map[sid] = {
      studentId: sid,
      carriedFromDate: priorWithHw?.dateKey || null,
      whereWeReachedPage: wherePage,
      todayHomeworks: priorWithHw
        ? priorWithHw.tomorrowHomeworks.map((hw) => ({
            ...hw,
            id: generateValidId('hw'),
            status: 'pending' as const,
          }))
        : [],
      tomorrowHomeworks: [],
    };
  });

  return map;
}

export async function saveBatchBookCorrectionOutcomes(params: {
  workspace: ComplexWorkspaceData;
  mosqueId: string;
  halaqaId: string;
  bookId: string;
  bookTitle: string;
  dateKey: string;
  entries: {
    student: AccountRecord;
    whereWeReachedPage: number;
    todayHomeworks: StudentBookHomeworkItem[];
    tomorrowHomeworks: StudentBookHomeworkItem[];
  }[];
  recordedBy: string;
  recordedByName: string;
}): Promise<{ savedCount: number; failedCount: number }> {
  const {
    workspace,
    mosqueId,
    halaqaId,
    bookId,
    bookTitle,
    dateKey,
    entries,
    recordedBy,
    recordedByName,
  } = params;

  const nonEmptyEntries = entries.filter(
    (e) => e.todayHomeworks.length > 0 || e.tomorrowHomeworks.length > 0
  );

  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < nonEmptyEntries.length; i += 5) {
    const chunk = nonEmptyEntries.slice(i, i + 5);
    await Promise.all(
      chunk.map(async (item) => {
        try {
          const normalized = applyBookCorrectionOutcomesToPlan({
            dateKey,
            todayHomeworks: item.todayHomeworks,
            tomorrowHomeworks: item.tomorrowHomeworks,
          });
          await saveStudentBookPlan({
            workspace,
            mosqueId,
            halaqaId,
            studentId: item.student.id,
            studentName: item.student.quadrupleName,
            bookId,
            bookTitle,
            dateKey,
            whereWeReachedPage: item.whereWeReachedPage,
            todayHomeworks: normalized.finalTodayHomeworks,
            tomorrowHomeworks: normalized.finalTomorrowHomeworks,
            recordedBy,
            recordedByName,
          });
          savedCount++;
        } catch {
          failedCount++;
        }
      })
    );
  }

  return { savedCount, failedCount };
}

// ============================================================================
// FULL LIVE PLATFORM CONTEXT BUILDER FOR PROGRAMMER AI ASSISTANT
// ============================================================================

function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(3)} GB`;
}

export async function gatherProgrammerAiPlatformSnapshot(params: {
  complexes: DiscoveredComplex[];
  connectedDbs: ConnectedDatabaseInfo[];
  rulesAuditReport: PlatformRulesAuditReport | null;
}): Promise<{
  snapshotText: string;
  summary: {
    databasesCount: number;
    complexesCount: number;
    issuesCount: number;
    weaknessesCount: number;
    totalDocsCount: number;
    totalUsedBytes: number;
    audioDocsCount: number;
    estimatedRemainingAudioClips: number;
  };
}> {
  const { complexes, connectedDbs, rulesAuditReport } = params;
  const [statsRes, usageReport, workspacesAndBooks] = await Promise.all([
    getPlatformDashboardStats().catch(() => null),
    inspectAllDatabasesUsage({ complexes, selectedComplexId: 'all' }).catch(() => null),
    Promise.all(
      complexes.map(async (c) => {
        const ws = await loadComplexWorkspace(c).catch(() => null);
        const books = ws ? await listBooksInComplex(ws).catch(() => []) : [];
        const curricula = ws ? await listCurriculaInComplex(ws).catch(() => []) : [];
        return { comp: c, ws, books, curricula };
      })
    ),
  ]);

  const weaknesses: string[] = [];

  if (rulesAuditReport && !rulesAuditReport.allHealthy) {
    for (const u of rulesAuditReport.unhealthyDatabases) {
      weaknesses.push(
        `أخطاء Rules في "${u.dbLabel}" (${u.projectId} / ${u.firestoreDatabaseId}): ${u.issues
          .map((i) => i.title)
          .join('، ')}`
      );
    }
  }

  if (usageReport) {
    for (const dbItem of usageReport.databases) {
      if (!dbItem.reachable) {
        weaknesses.push(
          `قاعدة غير قابلة للوصول: ${dbItem.dbLabel} (${dbItem.projectId}) — ${dbItem.errorMessage || 'تعذر الاتصال'}`
        );
      } else if (dbItem.usagePercent >= 75) {
        weaknesses.push(
          `امتلاء مرتفع في "${dbItem.dbLabel}": ${dbItem.usagePercent}% (${formatBytesHuman(
            dbItem.usedBytes
          )} من ${formatBytesHuman(dbItem.limitBytes)})`
        );
      }
    }
    if (usageReport.audioStorageSummary.librarySparkUsagePercent >= 75) {
      weaknesses.push(
        `قواعد تخزين الصوتيات والمكتبة اقتربت من حد Firebase المجاني (Spark 1 GiB/قاعدة): استُهلك ${usageReport.audioStorageSummary.librarySparkUsagePercent}%، والمتبقي ${formatBytesHuman(
          usageReport.audioStorageSummary.librarySparkRemainingBytes
        )} (يكفي تقريباً ${usageReport.audioStorageSummary.estimatedRemainingAudioClips.toLocaleString('en-US')} مقطع صوتي).`
      );
    }
  }

  const complexesDetails = workspacesAndBooks.map(({ comp, ws, books, curricula }) => {
    const accounts = ws?.accounts || [];
    const supervisors = accounts.filter((a) => a.role === 'supervisor');
    const teachers = accounts.filter((a) => a.role === 'teacher');
    const students = accounts.filter((a) => a.role === 'student');
    const unlinkedGoogle = accounts.filter((a) => !a.uid);
    const mosques = ws?.mosques || [];
    const halaqat = ws?.halaqat || [];

    const emptyMosques = mosques.filter(
      (m) => !halaqat.some((h) => h.mosqueId === m.id)
    );
    const emptyHalaqat = halaqat.filter(
      (h) => !students.some((s) => s.halaqaIds.includes(h.id))
    );
    const halaqatWithoutTeacher = halaqat.filter(
      (h) => !teachers.some((t) => t.halaqaIds.includes(h.id))
    );
    const incompleteBooks = books.filter((b) => b.status !== 'ready');

    if (supervisors.length === 0) {
      weaknesses.push(`مجمع "${comp.name}" لا يوجد به مشرف.`);
    }
    if (emptyMosques.length > 0) {
      weaknesses.push(
        `مجمع "${comp.name}": ${emptyMosques.length} مسجد بدون أي حلقات (${emptyMosques
          .map((m) => m.name)
          .join('، ')}).`
      );
    }
    if (emptyHalaqat.length > 0) {
      weaknesses.push(
        `مجمع "${comp.name}": ${emptyHalaqat.length} حلقة بدون طلاب (${emptyHalaqat
          .map((h) => h.name)
          .slice(0, 5)
          .join('، ')}).`
      );
    }
    if (halaqatWithoutTeacher.length > 0) {
      weaknesses.push(
        `مجمع "${comp.name}": ${halaqatWithoutTeacher.length} حلقة بدون معلم مسند.`
      );
    }
    if (incompleteBooks.length > 0) {
      weaknesses.push(
        `مجمع "${comp.name}": ${incompleteBooks.length} كتاب في حالة غير مكتملة (${incompleteBooks
          .map((b) => `${b.title}:${b.status}`)
          .join('، ')}).`
      );
    }

    const tabStorageMap: Record<string, string> = {};
    for (const tabKey of ALL_FEATURE_TAB_KEYS) {
      const shards = ws?.tabPools?.[tabKey] || [];
      const route = ws?.tabConfigMap?.[tabKey];
      if (shards.length > 0) {
        tabStorageMap[tabKey] = shards
          .map(
            (s, i) =>
              `شريحة#${i + 1}:${s.label}(${s.status}, ${formatBytesHuman(
                s.usedBytes
              )}/${formatBytesHuman(s.maxBytes)}, ${s.docsCount} وثيقة)`
          )
          .join(' | ');
      } else if (route) {
        tabStorageMap[tabKey] = `قاعدة معزولة: ${getDbDisplayLabel(route)}`;
      } else {
        tabStorageMap[tabKey] = `تخزن في قاعدة المجمع (${comp.ownerDbLabel})`;
      }
    }

    return {
      complexId: comp.id,
      name: comp.name,
      storageLocation: comp.isExternal ? comp.ownerDbLabel : 'القاعدة الأساسية للموقع',
      mosquesCount: mosques.length,
      halaqatCount: halaqat.length,
      accountsSummary: {
        total: accounts.length,
        supervisors: supervisors.length,
        teachers: teachers.length,
        students: students.length,
        pendingGoogleLinkCount: unlinkedGoogle.length,
      },
      booksCount: books.length,
      curriculaCount: curricula.length,
      tabStorageRouting: tabStorageMap,
    };
  });

  const payload = {
    capturedAtIso: new Date().toISOString(),
    dataArchitectureMap: {
      primaryDatabaseOnly: ['admins', 'dbRegistry', 'stats (التشغيل اليومي العام)', 'broadcasts (الافتراضية لكل المجمعات)'],
      complexScopedCollections: {
        mosques_halaqat: ['mosques', 'halaqat'],
        accounts_invites: ['accounts', 'inviteLinks', 'quickLinks', 'nameIndex'],
        attendance: ['attendance'],
        library: ['books', 'bookPages', 'wordAudio'],
        curricula: [
          'curricula',
          'studentQuranPlans',
          'studentMushafMistakes',
          'studentBookPlans',
        ],
        presentations: ['presentations'],
      },
    },
    freeLimitsReference: {
      firebaseSparkFreeTierPerProject: {
        storageCapBytes: SPARK_FREE_TIER_BYTES,
        storageCapHuman: '1 GiB (1,024 MiB لكل قاعدة/مشروع مجاني في خطة Spark)',
        maxDocumentSize: '1 MiB لكل وثيقة (يضغط النظام ملفات الصوت WAV في wordAudio تلقائياً لتبقى <= 640 KB)',
        dailyReadsLimit: '50,000 عملية قراءة يومياً لكل مشروع (يتجدد يومياً)',
        dailyWritesLimit: '20,000 عملية كتابة يومياً لكل مشروع',
        dailyDeletesLimit: '20,000 عملية حذف يومياً لكل مشروع',
        monthlyNetworkEgressLimit: '10 GiB نقل بيانات خارجي شهرياً',
        shardRolloverNote:
          'عند إنشاء شريحة تبويب بمشروع مجاني جديد (Spark) فحدها المجاني الفعلي 1 GiB حتى تتم الترقية إلى خطة Blaze (حيث يمتد حد الشريحة البرمجي حتى 4 GB تلقائياً).',
      },
      geminiAndAudioLimits: {
        cachingBehavior:
          'أي كلمة/آية تُولَّد صوتياً تُحفظ في Firestore (wordAudio) وفي IndexedDB بالمتصفح فلا تستهلك طلبات Gemini API عند إعادة التشغيل.',
        freeKeyQuotas:
          'مفاتيح Gemini المجانية تخضع لحدود في الدقيقة (RPM/TPM) وحد يومي (RPD). عند الضغط المؤقت يرد الخادم 429 ويتحول القارئ تلقائياً لصوت المتصفح المحلي حتى انتهاء مهلة التهدئة.',
      },
    },
    audioStorageAndRemainingCapacity: usageReport
      ? {
          totalAudioDocs: usageReport.audioStorageSummary.totalAudioDocs,
          audioWithWavDocs: usageReport.audioStorageSummary.audioWithWavDocs,
          tahajjiOnlyDocs: usageReport.audioStorageSummary.tahajjiOnlyDocs,
          noorAlBayanDocs: usageReport.audioStorageSummary.noorAlBayanDocs,
          normalDocs: usageReport.audioStorageSummary.normalDocs,
          totalAudioBytesHuman: formatBytesHuman(usageReport.audioStorageSummary.totalAudioBytes),
          avgAudioClipHuman: `${formatBytesHuman(usageReport.audioStorageSummary.avgAudioClipBytes)}${
            usageReport.audioStorageSummary.isAvgEstimated ? ' (تقدير مبدئي قبل حفظ مقاطع WAV)' : ' (متوسط فعلي من المقاطع المحفوظة)'
          }`,
          libraryHostDbCount: usageReport.audioStorageSummary.libraryHostDbCount,
          libraryHostDbLabels: usageReport.audioStorageSummary.libraryHostDbLabels,
          sparkFreeLimitPerDbHuman: formatBytesHuman(
            usageReport.audioStorageSummary.sparkFreeLimitPerDbBytes
          ),
          librarySparkTotalLimitHuman: formatBytesHuman(
            usageReport.audioStorageSummary.librarySparkTotalLimitBytes
          ),
          librarySparkTotalUsedHuman: formatBytesHuman(
            usageReport.audioStorageSummary.librarySparkTotalUsedBytes
          ),
          librarySparkRemainingHuman: formatBytesHuman(
            usageReport.audioStorageSummary.librarySparkRemainingBytes
          ),
          librarySparkUsagePercent: usageReport.audioStorageSummary.librarySparkUsagePercent,
          estimatedRemainingAudioClipsBeforeSparkLimit:
            usageReport.audioStorageSummary.estimatedRemainingAudioClips,
        }
      : null,
    platformStats: statsRes
      ? {
          totalComplexes: statsRes.totalComplexes,
          totalMosques: statsRes.totalMosques,
          totalHalaqat: statsRes.totalHalaqat,
          totalAccounts: statsRes.totalAccounts,
          today: statsRes.today,
          global: statsRes.global,
        }
      : null,
    connectedDatabasesCount: connectedDbs.length,
    databaseUsageSummary: usageReport
      ? {
          totalDatabasesCount: usageReport.totalDatabasesCount,
          totalDocsCount: usageReport.totalDocsCount,
          totalUsedHuman: formatBytesHuman(usageReport.totalUsedBytes),
          totalLimitHuman: formatBytesHuman(usageReport.totalLimitBytes),
          totalRemainingHuman: formatBytesHuman(usageReport.totalRemainingBytes),
          byTabSummary: usageReport.byTabSummary.map((t) => ({
            tab: t.label,
            docsCount: t.docsCount,
            usedHuman: formatBytesHuman(t.usedBytes),
          })),
          databases: usageReport.databases.map((d) => ({
            dbLabel: d.dbLabel,
            projectId: d.projectId,
            firestoreDatabaseId: d.firestoreDatabaseId,
            isPrimary: d.isPrimary,
            reachable: d.reachable,
            errorMessage: d.errorMessage || null,
            roleTags: d.roleTags,
            complexNames: d.complexNames,
            totalDocs: d.totalDocs,
            usedHuman: formatBytesHuman(d.usedBytes),
            limitHuman: formatBytesHuman(d.limitBytes),
            remainingHuman: formatBytesHuman(d.remainingBytes),
            usagePercent: d.usagePercent,
            topCollections: d.collections
              .filter((c) => c.docsCount > 0)
              .slice(0, 8)
              .map((c) => ({
                collection: c.collection,
                label: c.label,
                docs: c.docsCount,
                usedHuman: formatBytesHuman(c.usedBytes),
              })),
          })),
        }
      : null,
    rulesHealthAudit: rulesAuditReport
      ? {
          allHealthy: rulesAuditReport.allHealthy,
          totalDatabases: rulesAuditReport.totalDatabases,
          healthyCount: rulesAuditReport.healthyCount,
          results: rulesAuditReport.allResults.map((r) => ({
            dbLabel: r.dbLabel,
            projectId: r.projectId,
            firestoreDatabaseId: r.firestoreDatabaseId,
            status: r.status,
            issues: r.issues,
          })),
        }
      : null,
    complexesDetails,
    detectedWeaknessesAndRisks: weaknesses,
  };

  return {
    snapshotText: JSON.stringify(payload),
    summary: {
      databasesCount: usageReport?.totalDatabasesCount ?? connectedDbs.length,
      complexesCount: complexes.length,
      issuesCount: rulesAuditReport?.unhealthyDatabases.reduce((s, d) => s + d.issues.length, 0) ?? 0,
      weaknessesCount: weaknesses.length,
      totalDocsCount: usageReport?.totalDocsCount ?? 0,
      totalUsedBytes: usageReport?.totalUsedBytes ?? 0,
      audioDocsCount: usageReport?.audioStorageSummary.audioWithWavDocs ?? 0,
      estimatedRemainingAudioClips:
        usageReport?.audioStorageSummary.estimatedRemainingAudioClips ?? 0,
    },
  };
}

export type AccountAssignmentStatus =
  | 'platform_admin'
  | 'in_halaqa'
  | 'complex_only'
  | 'unassigned';

export interface PlatformAccountDirectoryEntry {
  account: AccountRecord;
  sourceDb: Firestore;
  sourceDbKey: string;
  sourceDbLabel: string;
  sourceConfig: ExternalFirebaseConfig | null;
  complexName: string;
  mosqueNames: string[];
  halaqaNames: string[];
  registeredAtMs: number;
  assignmentStatus: AccountAssignmentStatus;
}

function parseAccountTimestampMs(val: unknown, fallbackDateKey?: string): number {
  if (val && typeof (val as { toMillis?: () => number }).toMillis === 'function') {
    try {
      const ms = (val as { toMillis: () => number }).toMillis();
      if (Number.isFinite(ms) && ms > 0) return ms;
    } catch {
      // ignore
    }
  }
  if (val && typeof (val as { seconds?: number }).seconds === 'number') {
    const sec = (val as { seconds: number }).seconds;
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.getTime();
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return val;
  }
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (fallbackDateKey && fallbackDateKey.trim()) {
    const parsed = Date.parse(fallbackDateKey.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export async function listAllPlatformAccountsDirectory(): Promise<{
  entries: PlatformAccountDirectoryEntry[];
  complexes: DiscoveredComplex[];
}> {
  const [targets, discoveredComplexes] = await Promise.all([
    getAllKnownDatabases(),
    listAllComplexesAcrossDatabases(),
  ]);

  const orderedTargets = [
    ...targets.filter((t) => !t.isPrimary),
    ...targets.filter((t) => t.isPrimary),
  ];

  const complexMap = new Map<string, DiscoveredComplex>();
  for (const c of discoveredComplexes) {
    complexMap.set(c.id, c);
  }

  const mosqueMap = new Map<string, MosqueRecord>();
  const halaqaMap = new Map<string, HalaqaRecord>();
  const accountMap = new Map<
    string,
    {
      account: AccountRecord;
      target: ResolvedDbTarget;
    }
  >();

  await Promise.all(
    orderedTargets.map(async (target) => {
      try {
        const [mSnap, hSnap, aSnap] = await Promise.all([
          getDocsFresh(query(collection(target.db, 'mosques'), where('active', '==', true))).catch(
            () => null
          ),
          getDocsFresh(query(collection(target.db, 'halaqat'), where('active', '==', true))).catch(
            () => null
          ),
          getDocsFresh(collection(target.db, 'accounts')).catch(() => null),
        ]);

        mSnap?.forEach((d) => {
          const m = d.data() as MosqueRecord;
          if (!mosqueMap.has(m.id) || !target.isPrimary) {
            mosqueMap.set(m.id, m);
          }
        });

        hSnap?.forEach((d) => {
          const h = d.data() as HalaqaRecord;
          if (!halaqaMap.has(h.id) || !target.isPrimary) {
            halaqaMap.set(h.id, h);
          }
        });

        aSnap?.forEach((d) => {
          const raw = d.data() as AccountRecord;
          const acc: AccountRecord = {
            ...raw,
            mosqueIds: Array.isArray(raw.mosqueIds) ? raw.mosqueIds : [],
            halaqaIds: Array.isArray(raw.halaqaIds) ? raw.halaqaIds : [],
          };
          const existing = accountMap.get(acc.id);
          if (!existing || (existing.target.isPrimary && !target.isPrimary)) {
            accountMap.set(acc.id, { account: acc, target });
          }
        });
      } catch {
        // Skip unreachable database target
      }
    })
  );

  const entries: PlatformAccountDirectoryEntry[] = [];
  for (const { account, target } of accountMap.values()) {
    const complexObj = account.complexId ? complexMap.get(account.complexId) : undefined;
    const complexName = complexObj?.name || (account.complexId ? account.complexId : '');

    const rawMosqueIds = Array.from(
      new Set([
        ...(account.mosqueIds || []),
        ...(account.mosqueId ? [account.mosqueId] : []),
      ])
    ).filter(Boolean);
    const mosqueNames = rawMosqueIds
      .map((id) => mosqueMap.get(id)?.name || '')
      .filter(Boolean);

    const halaqaNames = (account.halaqaIds || [])
      .map((id) => halaqaMap.get(id)?.name || '')
      .filter(Boolean);

    let assignmentStatus: AccountAssignmentStatus = 'unassigned';
    if (account.role === 'platform_admin') {
      assignmentStatus = 'platform_admin';
    } else if (account.complexId && account.halaqaIds.length > 0) {
      assignmentStatus = 'in_halaqa';
    } else if (account.complexId) {
      assignmentStatus = 'complex_only';
    } else {
      assignmentStatus = 'unassigned';
    }

    const registeredAtMs =
      parseAccountTimestampMs(account.createdAt) ||
      parseAccountTimestampMs(account.updatedAt, account.lastLoginDate);

    entries.push({
      account,
      sourceDb: target.db,
      sourceDbKey: target.key,
      sourceDbLabel: target.label,
      sourceConfig: target.config,
      complexName,
      mosqueNames,
      halaqaNames,
      registeredAtMs,
      assignmentStatus,
    });
  }

  entries.sort((a, b) => {
    if (b.registeredAtMs !== a.registeredAtMs) {
      return b.registeredAtMs - a.registeredAtMs;
    }
    return a.account.quadrupleName.localeCompare(b.account.quadrupleName, 'ar');
  });

  return {
    entries,
    complexes: discoveredComplexes,
  };
}

export async function assignOrTransferPlatformAccount(params: {
  entry: PlatformAccountDirectoryEntry;
  targetComplex: DiscoveredComplex;
  targetWorkspace: ComplexWorkspaceData;
  role: Exclude<UserRole, 'platform_admin'>;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
}): Promise<AccountRecord> {
  const { entry, targetComplex, targetWorkspace, role, mosqueId, mosqueIds, halaqaIds } = params;
  const account = entry.account;

  if (account.role === 'platform_admin') {
    throw new Error('لا يمكن نقل أو تغيير صلاحية حساب مشرف المنصة المبرمج.');
  }

  const normalizedMosqueIds = (
    role === 'supervisor'
      ? mosqueIds
      : mosqueIds.length > 0
      ? mosqueIds
      : mosqueId
      ? [mosqueId]
      : []
  ).slice(0, 50);
  const normalizedPrimaryMosque = role === 'supervisor' ? normalizedMosqueIds[0] || '' : mosqueId;
  const normalizedHalaqaIds = (role === 'supervisor' ? [] : halaqaIds).slice(0, 50);
  const quickToken = account.quickToken || generateToken(24);
  const nameHash = account.nameHash || (await hashQuadrupleName(account.quadrupleName));

  const destDb = resolveTargetDbForEntity(
    targetWorkspace,
    normalizedPrimaryMosque,
    normalizedHalaqaIds
  );

  const updatedAccount: AccountRecord = {
    ...account,
    nameHash,
    role,
    complexId: targetComplex.id,
    mosqueId: normalizedPrimaryMosque,
    mosqueIds: normalizedMosqueIds,
    halaqaIds: normalizedHalaqaIds,
    quickToken,
  };

  if (entry.sourceDb === destDb) {
    await updateDoc(doc(destDb, 'accounts', account.id), {
      nameHash,
      role: updatedAccount.role,
      complexId: updatedAccount.complexId,
      mosqueId: updatedAccount.mosqueId,
      mosqueIds: updatedAccount.mosqueIds,
      halaqaIds: updatedAccount.halaqaIds,
      quickToken: updatedAccount.quickToken,
      updatedAt: serverTimestamp(),
    });
    await upsertNameIndexSafe(destDb, nameHash, account.id).catch(() => {});
  } else {
    if (nameHash) {
      await upsertNameIndexSafe(destDb, nameHash, account.id);
    }
    await upsertTransferredDoc(destDb, 'accounts', account.id, {
      id: updatedAccount.id,
      uid: updatedAccount.uid || '',
      quadrupleName: updatedAccount.quadrupleName,
      nameHash,
      email: updatedAccount.email || '',
      photoURL: updatedAccount.photoURL || '',
      role: updatedAccount.role,
      complexId: updatedAccount.complexId,
      mosqueId: updatedAccount.mosqueId || '',
      mosqueIds: updatedAccount.mosqueIds || [],
      halaqaIds: updatedAccount.halaqaIds || [],
      inviteToken: updatedAccount.inviteToken || '',
      quickToken: updatedAccount.quickToken || '',
      lastLoginDate: updatedAccount.lastLoginDate || '',
    });

    await deleteDoc(doc(entry.sourceDb, 'accounts', account.id)).catch(() => {});
    if (account.nameHash) {
      await deleteDoc(doc(entry.sourceDb, 'nameIndex', account.nameHash)).catch(() => {});
    }
    if (account.quickToken) {
      await deleteDoc(doc(entry.sourceDb, 'quickLinks', account.quickToken)).catch(() => {});
    }
    try {
      const oldQSnap = await getDocs(
        query(collection(entry.sourceDb, 'quickLinks'), where('accountId', '==', account.id))
      );
      for (const qDoc of oldQSnap.docs) {
        await deleteDoc(doc(entry.sourceDb, 'quickLinks', qDoc.id)).catch(() => {});
      }
    } catch {
      // Non-fatal cleanup
    }
  }

  await syncQuickLinkForAccount(targetWorkspace, updatedAccount, destDb);
  return updatedAccount;
}

export async function deletePlatformAccountDirectoryEntry(
  entry: PlatformAccountDirectoryEntry,
  currentActor?: { accountId?: string; uid?: string }
): Promise<void> {
  const account = entry.account;
  if (account.role === 'platform_admin') {
    throw new Error('لا يمكن حذف حساب مشرف المنصة المبرمج.');
  }
  const activeUid = currentActor?.uid || auth.currentUser?.uid || '';
  if (
    (currentActor?.accountId && account.id === currentActor.accountId) ||
    (activeUid && (account.uid === activeUid || account.id === activeUid))
  ) {
    throw new Error('لا يمكنك حذف حسابك الشخصي.');
  }

  await deleteDoc(doc(entry.sourceDb, 'accounts', account.id));
  if (account.nameHash) {
    await deleteDoc(doc(entry.sourceDb, 'nameIndex', account.nameHash)).catch(() => {});
  }
  if (account.quickToken) {
    await deleteDoc(doc(entry.sourceDb, 'quickLinks', account.quickToken)).catch(() => {});
  }
  try {
    const qSnap = await getDocs(
      query(collection(entry.sourceDb, 'quickLinks'), where('accountId', '==', account.id))
    );
    for (const qDoc of qSnap.docs) {
      await deleteDoc(doc(entry.sourceDb, 'quickLinks', qDoc.id)).catch(() => {});
    }
  } catch {
    // Non-fatal
  }
}
