export type UserRole = 'platform_admin' | 'supervisor' | 'teacher' | 'student';

export interface ExternalFirebaseConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
}

export interface DbRegistryEntry {
  id: string;
  name: string;
  hasExternalDb: boolean;
  firebaseConfigJson: string;
  mosqueConfigsJson: string; // JSON stringified map { [mosqueId]: ExternalFirebaseConfig }
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ComplexRecord {
  id: string;
  name: string;
  usesExternalDb: boolean;
  active: boolean;
  createdBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface MosqueRecord {
  id: string;
  complexId: string;
  name: string;
  usesExternalDb: boolean;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface HalaqaRecord {
  id: string;
  complexId: string;
  mosqueId: string;
  name: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AccountRecord {
  id: string;
  uid: string;
  quadrupleName: string;
  nameHash: string;
  email: string;
  photoURL: string;
  role: UserRole;
  complexId: string;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
  inviteToken: string;
  quickToken: string;
  lastLoginDate: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InviteLinkRecord {
  token: string;
  title: string;
  complexId: string;
  role: Exclude<UserRole, 'platform_admin'>;
  mosqueId: string;
  mosqueIds: string[];
  halaqaIds: string[];
  startsAtMs: number;
  endsAtMs: number;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface QuickLinkRecord {
  token: string;
  accountId: string;
  quadrupleName: string;
  role: Exclude<UserRole, 'platform_admin'>;
  complexId: string;
  complexName: string;
  mosqueId: string;
  mosqueName: string;
  halaqaNames: string[];
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DailyStatsRecord {
  dateKey: string;
  studentLogins: number;
  teacherLogins: number;
  supervisorLogins: number;
  totalVisits: number;
  recitedAyahs: number;
  recitedPages: number;
  updatedAt?: unknown;
}

export interface ActiveSession {
  mode: 'google' | 'quick';
  account: AccountRecord;
  complexName?: string;
  mosqueName?: string;
  mosqueNames?: string[];
  halaqaNames?: string[];
  dbSourceLabel?: string;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  platform_admin: 'مشرف المنصة المبرمج',
  supervisor: 'مشرف',
  teacher: 'معلم',
  student: 'طالب',
};

export const ADMIN_QUADRUPLE_NAME = 'محمد منتصر محمد يونس';

export interface ConnectedDatabaseInfo {
  id: string;
  key: string;
  label: string;
  isPrimary: boolean;
  config: ExternalFirebaseConfig | null;
}

