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
  authConfig?: ExternalFirebaseConfig | null;
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

export interface BookTextSegment {
  id: string;
  text: string;
  plainText: string;
  kind: 'ayah' | 'word';
  box: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0..1000
  surahNumber?: number;
  ayahNumber?: number;
  surahName?: string;
}

export interface BookRecord {
  id: string;
  complexId: string;
  title: string;
  fileName: string;
  fileType: 'pdf' | 'image';
  totalPages: number;
  uploadedPages: number;
  recognizedPages: number;
  status: 'uploading' | 'processing' | 'paused' | 'ready' | 'error';
  createdBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BookPageRecord {
  id: string;
  bookId: string;
  complexId: string;
  pageNumber: number;
  imageDataUrl: string;
  width: number;
  height: number;
  recognized: boolean;
  fullText: string;
  segments: BookTextSegment[];
  updatedAt?: unknown;
}

export interface NoorAlBayanStep {
  part: string;
  ruleLabel: string;
  reading: string;
}

export interface QuranReciterInfo {
  id: string;
  name: string;
  style: string;
  everyAyahFolder: string;
}

export const QURAN_RECITERS: QuranReciterInfo[] = [
  {
    id: 'alafasy',
    name: 'الشيخ مشاري راشد العفاسي',
    style: 'مرتل',
    everyAyahFolder: 'Alafasy_128kbps',
  },
  {
    id: 'abdulbasit',
    name: 'الشيخ عبد الباسط عبد الصمد',
    style: 'مرتل',
    everyAyahFolder: 'Abdul_Basit_Murattal_192kbps',
  },
  {
    id: 'husary',
    name: 'الشيخ محمود خليل الحصري',
    style: 'مرتل تعليمي',
    everyAyahFolder: 'Husary_128kbps',
  },
  {
    id: 'minshawy',
    name: 'الشيخ محمد صديق المنشاوي',
    style: 'مرتل',
    everyAyahFolder: 'Minshawy_Murattal_128kbps',
  },
  {
    id: 'muaiqly',
    name: 'الشيخ ماهر المعيقلي',
    style: 'مرتل',
    everyAyahFolder: 'MaherAlMuaiqly128kbps',
  },
  {
    id: 'ghamadi',
    name: 'الشيخ سعد الغامدي',
    style: 'مرتل',
    everyAyahFolder: 'Ghamadi_40kbps',
  },
  {
    id: 'shuraym',
    name: 'الشيخ سعود الشريم',
    style: 'مرتل',
    everyAyahFolder: 'Saood_ash-Shuraym_128kbps',
  },
  {
    id: 'sudais',
    name: 'الشيخ عبد الرحمن السديس',
    style: 'مرتل',
    everyAyahFolder: 'Abdurrahmaan_As-Sudais_192kbps',
  },
  {
    id: 'dussary',
    name: 'الشيخ ياسر الدوسري',
    style: 'مرتل',
    everyAyahFolder: 'Yasser_Ad-Dussary_128kbps',
  },
  {
    id: 'ayyoub',
    name: 'الشيخ محمد أيوب',
    style: 'مرتل',
    everyAyahFolder: 'Muhammad_Ayyoub_128kbps',
  },
];

export interface HalaqaRankingItem {
  halaqaId: string;
  halaqaName: string;
  mosqueName: string;
  studentsCount: number;
  teachersCount: number;
  recitedAyahs: number;
  recitedPages: number;
  achievementScore: number;
}

export interface StudentRankingItem {
  accountId: string;
  studentName: string;
  mosqueName: string;
  halaqaName: string;
  recitedAyahs: number;
  recitedPages: number;
  attendanceActive: boolean;
  achievementScore: number;
}
