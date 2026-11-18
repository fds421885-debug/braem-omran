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
  type AccountRecord,
  type ActiveSession,
  type ComplexRecord,
  type ConnectedDatabaseInfo,
  type DailyStatsRecord,
  type DbRegistryEntry,
  type ExternalFirebaseConfig,
  type HalaqaRecord,
  type InviteLinkRecord,
  type MosqueRecord,
  type QuickLinkRecord,
  type UserRole,
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

    // Backwards compatibility for any legacy per-mosque configs inside older entries
    const legacyMosques = safeParseMosqueConfigs(entry.mosqueConfigsJson);
    for (const mConf of Object.values(legacyMosques)) {
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

  // Clean up any legacy per-complex registry doc if present
  await deleteDoc(doc(primaryDb, 'dbRegistry', discovered.id)).catch(() => {});
}

export async function loadComplexWorkspace(
  discovered: DiscoveredComplex
): Promise<ComplexWorkspaceData> {
  const complexDb = discovered.ownerDb;
  const mosqueDbMap: Record<string, Firestore> = {};
  const mosqueConfigMap: Record<string, ExternalFirebaseConfig | null> = {};
  const halaqaDbMap: Record<string, Firestore> = {};
  const halaqaConfigMap: Record<string, ExternalFirebaseConfig | null> = {};

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

  const allTargets = await getAllKnownDatabases();
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

  for (const source of orderedSources) {
    try {
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
    complexDb,
  };
}

function resolveTargetDbForEntity(
  workspace: ComplexWorkspaceData,
  mosqueId: string,
  halaqaIds?: string[]
): Firestore {
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
  const targetDb = params.workspace.mosqueDbMap[mosqueId] || params.workspace.complexDb;

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
  const targetDb = params.halaqaId
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
