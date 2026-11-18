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
import {
  ADMIN_QUADRUPLE_NAME,
  COMPLEX_FEATURE_TAB_LABELS,
  type AccountRecord,
  type ActiveSession,
  type AttendanceEntry,
  type AttendanceRecord,
  type AttendanceStatus,
  type BookPageRecord,
  type BookRecord,
  type BookTextSegment,
  type ComplexFeatureTabKey,
  type ComplexRecord,
  type ConnectedDatabaseInfo,
  type CurriculumRecord,
  type DailyStatsRecord,
  type DbRegistryEntry,
  type ExternalFirebaseConfig,
  type HalaqaRankingItem,
  type HalaqaRecord,
  type InviteLinkRecord,
  type MosqueRecord,
  type QuickLinkRecord,
  type StudentRankingItem,
  type UserRole,
  type WeekDayKey,
} from '../types/platform';
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

async function getDocFresh(
  ref: DocumentReference<DocumentData>
): Promise<DocumentSnapshot<DocumentData>> {
  try {
    return await getDocFromServer(ref);
  } catch {
    return await getDoc(ref);
  }
}

async function getDocsFresh(
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

  const seenKeys = new Set<string>(['primary']);

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

    // Backwards compatibility for legacy per-mosque configs AND per-tab external routes
    const rawMap = safeParseMosqueConfigs(entry.mosqueConfigsJson) as Record<string, unknown>;
    const candidateConfigs: ExternalFirebaseConfig[] = [];
    if (
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

  // Clean up any legacy per-complex registry doc or per-tab routes pointer if present
  await deleteDoc(doc(primaryDb, 'dbRegistry', discovered.id)).catch(() => {});
  await deleteDoc(doc(primaryDb, 'dbRegistry', `${TAB_ROUTE_DOC_PREFIX}${discovered.id}`)).catch(() => {});
}

const TAB_ROUTE_DOC_PREFIX = 'tabroutes_';

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
  if (serialized.length > 7900) {
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

export function getDbForComplexTab(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): Firestore {
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

export function getDbLabelForComplexTab(
  workspace: ComplexWorkspaceData,
  tabKey: ComplexFeatureTabKey
): string {
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

  const loadedRoutes = await loadComplexTabRoutes(discovered.id);
  const tabDbMap: Partial<Record<ComplexFeatureTabKey, Firestore>> = {};
  const tabConfigMap: Partial<Record<ComplexFeatureTabKey, ExternalFirebaseConfig | null>> = {};

  for (const [k, conf] of Object.entries(loadedRoutes)) {
    if (conf) {
      const tabKey = k as ComplexFeatureTabKey;
      tabConfigMap[tabKey] = conf;
      tabDbMap[tabKey] = getFirestoreForConfig(conf);
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

  const extMosquesDb = tabDbMap.mosques_halaqat || null;
  const extMosquesConfig = tabConfigMap.mosques_halaqat || null;
  const extAccountsDb = tabDbMap.accounts_invites || null;

  if (extMosquesDb) {
    try {
      const [mSnap, hSnap] = await Promise.all([
        getDocsFresh(query(collection(extMosquesDb, 'mosques'), where('complexId', '==', discovered.id))),
        getDocsFresh(query(collection(extMosquesDb, 'halaqat'), where('complexId', '==', discovered.id))),
      ]);
      mSnap.forEach((d) => {
        const m = d.data() as MosqueRecord;
        if (m.active) {
          mosquesMap.set(m.id, m);
          mosqueDbMap[m.id] = extMosquesDb;
          mosqueConfigMap[m.id] = extMosquesConfig;
        }
      });
      hSnap.forEach((d) => {
        const h = d.data() as HalaqaRecord;
        if (h.active) {
          halaqatMap.set(h.id, h);
          halaqaDbMap[h.id] = extMosquesDb;
          halaqaConfigMap[h.id] = extMosquesConfig;
        }
      });
    } catch {
      // Skip unreachable isolated tab DB
    }
  }

  if (extAccountsDb) {
    try {
      const [aSnap, iSnap, qSnap] = await Promise.all([
        getDocsFresh(query(collection(extAccountsDb, 'accounts'), where('complexId', '==', discovered.id))),
        getDocsFresh(query(collection(extAccountsDb, 'inviteLinks'), where('complexId', '==', discovered.id))),
        getDocsFresh(query(collection(extAccountsDb, 'quickLinks'), where('complexId', '==', discovered.id))),
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
      // Skip unreachable isolated tab DB
    }
  }

  for (const source of orderedSources) {
    try {
      if (!extMosquesDb) {
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

      if (!extAccountsDb) {
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
    complexDb,
  };
}

function resolveTargetDbForEntity(
  workspace: ComplexWorkspaceData,
  mosqueId: string,
  halaqaIds?: string[]
): Firestore {
  if (workspace.tabConfigMap?.accounts_invites) {
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

  await setDoc(doc(targetDb, 'quickLinks', token), {
    ...quickPayload,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

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
  const targetDb = params.workspace.tabConfigMap?.mosques_halaqat
    ? getDbForComplexTab(params.workspace, 'mosques_halaqat')
    : params.workspace.mosqueDbMap[mosqueId] || params.workspace.complexDb;

  if (params.mosqueId) {
    await updateDoc(doc(targetDb, 'mosques', mosqueId), {
      name: params.name.trim().slice(0, 120),
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(doc(targetDb, 'mosques', mosqueId), {
      id: mosqueId,
      complexId: params.workspace.discovered.id,
      name: params.name.trim().slice(0, 120),
      usesExternalDb: false,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}

export async function addOrRenameHalaqaInWorkspace(params: {
  workspace: ComplexWorkspaceData;
  halaqaId?: string;
  mosqueId: string;
  name: string;
}): Promise<void> {
  const halaqaId = params.halaqaId || generateValidId('hlq');
  const targetDb = params.workspace.tabConfigMap?.mosques_halaqat
    ? getDbForComplexTab(params.workspace, 'mosques_halaqat')
    : params.halaqaId
    ? params.workspace.halaqaDbMap[params.halaqaId] ||
      params.workspace.mosqueDbMap[params.mosqueId] ||
      params.workspace.complexDb
    : params.workspace.mosqueDbMap[params.mosqueId] || params.workspace.complexDb;

  if (params.halaqaId) {
    await updateDoc(doc(targetDb, 'halaqat', halaqaId), {
      name: params.name.trim().slice(0, 120),
      mosqueId: params.mosqueId,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(doc(targetDb, 'halaqat', halaqaId), {
      id: halaqaId,
      complexId: params.workspace.discovered.id,
      mosqueId: params.mosqueId,
      name: params.name.trim().slice(0, 120),
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
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
  account: AccountRecord
): Promise<void> {
  if (account.role === 'platform_admin') {
    throw new Error('لا يمكن حذف حساب المشرف المبرمج.');
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
    const libraryDb = getDbForComplexTab(workspace, 'library');
    const snap = await getDocsFresh(
      query(
        collection(libraryDb, 'books'),
        where('complexId', '==', workspace.complex.id)
      )
    );
    const items: BookRecord[] = [];
    snap.forEach((d) => {
      items.push(d.data() as BookRecord);
    });
    return items.sort((a, b) => {
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
  const libraryDb = getDbForComplexTab(workspace, 'library');
  const snap = await getDocsFresh(
    query(collection(libraryDb, 'bookPages'), where('bookId', '==', bookId))
  );
  const pages: BookPageRecord[] = [];
  snap.forEach((d) => {
    pages.push(d.data() as BookPageRecord);
  });
  return pages.sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function upsertBookRecord(
  workspace: ComplexWorkspaceData,
  book: BookRecord
): Promise<void> {
  const libraryDb = getDbForComplexTab(workspace, 'library');
  const targetRef = doc(libraryDb, 'books', book.id);
  const existing = await getDocFresh(targetRef).catch(() => null);
  const title = book.title.trim().slice(0, 160) || 'كتاب بدون عنوان';
  const totalPages = Math.max(1, Math.min(2000, Math.round(book.totalPages)));
  const uploadedPages = Math.max(0, Math.min(totalPages, Math.round(book.uploadedPages)));
  const recognizedPages = Math.max(0, Math.min(totalPages, Math.round(book.recognizedPages)));

  if (existing?.exists()) {
    await updateDoc(targetRef, {
      title,
      totalPages,
      uploadedPages,
      recognizedPages,
      status: book.status,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(targetRef, {
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
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}

export async function upsertBookPageRecord(
  workspace: ComplexWorkspaceData,
  page: BookPageRecord
): Promise<void> {
  const libraryDb = getDbForComplexTab(workspace, 'library');
  const targetRef = doc(libraryDb, 'bookPages', page.id);
  const existing = await getDocFresh(targetRef).catch(() => null);
  const cleanSegments = sanitizeBookSegments(page.segments);
  const cleanFullText = String(page.fullText || '').slice(0, 25000);
  const cleanWidth = Math.max(1, Math.min(10000, Math.round(page.width)));
  const cleanHeight = Math.max(1, Math.min(10000, Math.round(page.height)));

  if (existing?.exists()) {
    await updateDoc(targetRef, {
      imageDataUrl: page.imageDataUrl,
      width: cleanWidth,
      height: cleanHeight,
      recognized: Boolean(page.recognized),
      fullText: cleanFullText,
      segments: cleanSegments,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(targetRef, {
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
      updatedAt: serverTimestamp(),
    });
  }
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
  const libraryDb = getDbForComplexTab(workspace, 'library');
  await updateDoc(doc(libraryDb, 'books', bookId), {
    title: clean,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteBookFromWorkspace(
  workspace: ComplexWorkspaceData,
  bookId: string
): Promise<void> {
  const libraryDb = getDbForComplexTab(workspace, 'library');
  const pagesSnap = await getDocs(
    query(collection(libraryDb, 'bookPages'), where('bookId', '==', bookId))
  ).catch(() => null);
  if (pagesSnap) {
    for (const p of pagesSnap.docs) {
      await deleteDoc(doc(libraryDb, 'bookPages', p.id)).catch(() => {});
    }
  }
  await deleteDoc(doc(libraryDb, 'books', bookId));
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
  const db = getDbForComplexTab(workspace, 'attendance');
  const docId = buildAttendanceDocId(halaqaId, dateKey);
  const snap = await getDocFresh(doc(db, 'attendance', docId)).catch(() => null);
  if (!snap?.exists()) return null;
  return snap.data() as AttendanceRecord;
}

export async function listAttendanceHistory(
  workspace: ComplexWorkspaceData,
  options?: { halaqaId?: string; mosqueIds?: string[] }
): Promise<AttendanceRecord[]> {
  try {
    const db = getDbForComplexTab(workspace, 'attendance');
    const snap = await getDocsFresh(
      query(collection(db, 'attendance'), where('complexId', '==', workspace.complex.id))
    );
    const allowedMosques =
      options?.mosqueIds && options.mosqueIds.length > 0 ? new Set(options.mosqueIds) : null;
    const records: AttendanceRecord[] = [];
    snap.forEach((d) => {
      const rec = d.data() as AttendanceRecord;
      if (options?.halaqaId && rec.halaqaId !== options.halaqaId) return;
      if (allowedMosques && !allowedMosques.has(rec.mosqueId)) return;
      records.push(rec);
    });
    return records.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
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

  const db = getDbForComplexTab(workspace, 'attendance');
  const id = buildAttendanceDocId(halaqaId, dateKey);
  const targetRef = doc(db, 'attendance', id);
  const existing = await getDocFresh(targetRef).catch(() => null);
  const cleanEntries = sanitizeAttendanceEntries(entries);
  const cleanRecorder = (recordedBy || auth.currentUser?.uid || 'supervisor').slice(0, 128);
  const cleanRecorderName = (recordedByName || 'المشرف').trim().slice(0, 120) || 'المشرف';

  if (existing?.exists()) {
    await updateDoc(targetRef, {
      entries: cleanEntries,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
      updatedAt: serverTimestamp(),
    });
  } else {
    await setDoc(targetRef, {
      id,
      complexId: workspace.complex.id,
      mosqueId,
      halaqaId,
      dateKey,
      entries: cleanEntries,
      recordedBy: cleanRecorder,
      recordedByName: cleanRecorderName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
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
    const db = getDbForComplexTab(workspace, 'curricula');
    const snap = await getDocsFresh(
      query(collection(db, 'curricula'), where('complexId', '==', workspace.complex.id))
    );
    const list: CurriculumRecord[] = [];
    snap.forEach((d) => {
      const rec = d.data() as CurriculumRecord;
      if (rec.active !== false) {
        list.push(rec);
      }
    });
    return list.sort((a, b) => {
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

  const db = getDbForComplexTab(workspace, 'curricula');
  const recordId = id || generateValidId('cur');
  const targetRef = doc(db, 'curricula', recordId);
  const existing = id ? await getDocFresh(targetRef).catch(() => null) : null;
  const cleanTitle = bookTitle.trim().slice(0, 160);
  const cleanNote = (scheduleNote || '').trim().slice(0, 240);
  const cleanCreator = (createdBy || auth.currentUser?.uid || 'supervisor').slice(0, 128);

  if (existing?.exists()) {
    await updateDoc(targetRef, {
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
    await setDoc(targetRef, {
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
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
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
  const db = getDbForComplexTab(workspace, 'curricula');
  await deleteDoc(doc(db, 'curricula', curriculumId));
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

async function migrateSingleTabRecords(params: {
  complexId: string;
  tabKey: ComplexFeatureTabKey;
  sourceDbs: Firestore[];
  destDb: Firestore;
}): Promise<number> {
  const { complexId, tabKey, sourceDbs, destDb } = params;
  const uniqueSources = Array.from(new Set(sourceDbs));
  let migratedCount = 0;

  if (tabKey === 'attendance') {
    for (const sDb of uniqueSources) {
      const snap = await getDocsFresh(
        query(collection(sDb, 'attendance'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        if (sDb !== destDb) {
          await copyDocWithTimestamp(destDb, 'attendance', d.id, data);
          await deleteDoc(doc(sDb, 'attendance', d.id)).catch(() => {});
        }
        migratedCount++;
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
    return migratedCount;
  }

  if (tabKey === 'curricula') {
    for (const sDb of uniqueSources) {
      const snap = await getDocsFresh(
        query(collection(sDb, 'curricula'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>;
        if (sDb !== destDb) {
          await copyDocWithTimestamp(destDb, 'curricula', d.id, data);
          await deleteDoc(doc(sDb, 'curricula', d.id)).catch(() => {});
        }
        migratedCount++;
      }
    }
    if (destDb !== primaryDb) {
      const pSnap = await getDocs(
        query(collection(primaryDb, 'curricula'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (pSnap) {
        for (const d of pSnap.docs) {
          await deleteDoc(doc(primaryDb, 'curricula', d.id)).catch(() => {});
        }
      }
    }
    return migratedCount;
  }

  if (tabKey === 'library') {
    for (const sDb of uniqueSources) {
      const booksSnap = await getDocsFresh(
        query(collection(sDb, 'books'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (booksSnap) {
        for (const d of booksSnap.docs) {
          const data = d.data() as Record<string, unknown>;
          if (sDb !== destDb) {
            await copyDocWithTimestamp(destDb, 'books', d.id, data);
            await deleteDoc(doc(sDb, 'books', d.id)).catch(() => {});
          }
          migratedCount++;
        }
      }

      const pagesSnap = await getDocsFresh(
        query(collection(sDb, 'bookPages'), where('complexId', '==', complexId))
      ).catch(() => null);
      if (pagesSnap) {
        for (const d of pagesSnap.docs) {
          const data = d.data() as Record<string, unknown>;
          if (sDb !== destDb) {
            await setDoc(doc(destDb, 'bookPages', d.id), {
              ...data,
              updatedAt: serverTimestamp(),
            });
            await deleteDoc(doc(sDb, 'bookPages', d.id)).catch(() => {});
          }
          migratedCount++;
        }
      }
    }
    if (destDb !== primaryDb) {
      for (const colName of ['books', 'bookPages']) {
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
    return migratedCount;
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
          if (sDb !== destDb) {
            await copyDocWithTimestamp(destDb, colName, d.id, data);
            await deleteDoc(doc(sDb, colName, d.id)).catch(() => {});
          }
          migratedCount++;
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
    return migratedCount;
  }

  // accounts_invites
  for (const sDb of uniqueSources) {
    const aSnap = await getDocsFresh(
      query(collection(sDb, 'accounts'), where('complexId', '==', complexId))
    ).catch(() => null);
    if (aSnap) {
      for (const d of aSnap.docs) {
        const acc = d.data() as AccountRecord;
        if (sDb !== destDb) {
          if (acc.nameHash) {
            await upsertNameIndexSafe(destDb, acc.nameHash, acc.id);
            await deleteDoc(doc(sDb, 'nameIndex', acc.nameHash)).catch(() => {});
          }
          await copyDocWithTimestamp(destDb, 'accounts', d.id, d.data() as Record<string, unknown>);
          await deleteDoc(doc(sDb, 'accounts', d.id)).catch(() => {});
        }
        migratedCount++;
      }
    }

    for (const colName of ['inviteLinks', 'quickLinks']) {
      const snap = await getDocsFresh(
        query(collection(sDb, colName), where('complexId', '==', complexId))
      ).catch(() => null);
      if (!snap) continue;
      for (const d of snap.docs) {
        if (sDb !== destDb) {
          await copyDocWithTimestamp(destDb, colName, d.id, d.data() as Record<string, unknown>);
          await deleteDoc(doc(sDb, colName, d.id)).catch(() => {});
        }
        migratedCount++;
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
  return migratedCount;
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
    const activeTabDb = getDbForComplexTab(workspace, tabKey);
    const sourceDbs: Firestore[] = [activeTabDb, workspace.complexDb];
    if (tabKey === 'accounts_invites' || tabKey === 'mosques_halaqat') {
      sourceDbs.push(
        ...Object.values(workspace.mosqueDbMap),
        ...Object.values(workspace.halaqaDbMap)
      );
    }

    movedDocsCount += await migrateSingleTabRecords({
      complexId: workspace.complex.id,
      tabKey,
      sourceDbs,
      destDb,
    });

    if (targetConfig) {
      nextRoutes[tabKey] = targetConfig;
    } else {
      delete nextRoutes[tabKey];
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
    data = { curricula: records };
  } else if (tabKey === 'library') {
    const books = await listBooksInComplex(workspace);
    const bookPages: BookPageRecord[] = [];
    for (const b of books) {
      const pages = await loadBookPages(workspace, b.id);
      bookPages.push(...pages);
    }
    data = { books, bookPages };
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
      await upsertTransferredDoc(destDb, 'attendance', docId, {
        id: docId,
        complexId,
        mosqueId: rec.mosqueId || '',
        halaqaId: rec.halaqaId,
        dateKey: rec.dateKey,
        entries: sanitizeAttendanceEntries(Array.isArray(rec.entries) ? rec.entries : []),
        recordedBy: rec.recordedBy || auth.currentUser?.uid || 'admin',
        recordedByName: rec.recordedByName || 'استيراد JSON',
      });
      importedCount++;
    }
    return { importedCount };
  }

  if (tabKey === 'curricula') {
    const items = Array.isArray(sourceData.curricula) ? (sourceData.curricula as CurriculumRecord[]) : [];
    for (const cur of items) {
      if (!cur || !cur.id || !cur.bookId || !cur.bookTitle) continue;
      await upsertTransferredDoc(destDb, 'curricula', cur.id, {
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
      });
      importedCount++;
    }
    return { importedCount };
  }

  if (tabKey === 'library') {
    const books = Array.isArray(sourceData.books) ? (sourceData.books as BookRecord[]) : [];
    const pages = Array.isArray(sourceData.bookPages) ? (sourceData.bookPages as BookPageRecord[]) : [];
    for (const b of books) {
      if (!b || !b.id) continue;
      await upsertTransferredDoc(destDb, 'books', b.id, {
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
      });
      importedCount++;
    }
    for (const p of pages) {
      if (!p || !p.id || !p.bookId) continue;
      await setDoc(doc(destDb, 'bookPages', p.id), {
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
        updatedAt: serverTimestamp(),
      });
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

