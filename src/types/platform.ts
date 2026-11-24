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

export type ComplexFeatureTabKey =
  | 'attendance'
  | 'library'
  | 'curricula'
  | 'accounts_invites'
  | 'mosques_halaqat';

export const COMPLEX_FEATURE_TAB_LABELS: Record<ComplexFeatureTabKey, string> = {
  attendance: 'الحضور والغياب',
  library: 'الملفات والكتب',
  curricula: 'المقررات',
  accounts_invites: 'الحسابات وروابط التسجيل',
  mosques_halaqat: 'المساجد والحلقات',
};

export type AttendanceStatus = 'present' | 'absent' | 'excused' | 'late';

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'حاضر',
  absent: 'غائب',
  excused: 'بعذر',
  late: 'متأخر',
};

export interface AttendanceEntry {
  studentId: string;
  studentName: string;
  status: AttendanceStatus;
  note: string;
}

export interface AttendanceRecord {
  id: string;
  complexId: string;
  mosqueId: string;
  halaqaId: string;
  dateKey: string; // YYYY-MM-DD
  entries: AttendanceEntry[];
  recordedBy: string;
  recordedByName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type WeekDayKey = 'sat' | 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri';

export const WEEK_DAYS: { key: WeekDayKey; label: string }[] = [
  { key: 'sat', label: 'السبت' },
  { key: 'sun', label: 'الأحد' },
  { key: 'mon', label: 'الإثنين' },
  { key: 'tue', label: 'الثلاثاء' },
  { key: 'wed', label: 'الأربعاء' },
  { key: 'thu', label: 'الخميس' },
  { key: 'fri', label: 'الجمعة' },
];

export const QURAN_MUSHAF_BOOK_ID = 'quran_mushaf';
export const QURAN_MUSHAF_TITLE = 'المصحف الشريف';

export interface CurriculumRecord {
  id: string;
  complexId: string;
  bookId: string;
  bookTitle: string;
  halaqaIds: string[];
  mosqueIds: string[];
  days: WeekDayKey[];
  scheduleNote: string;
  active: boolean;
  createdBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TeacherRoleContext {
  mosqueId: string;
  mosqueName: string;
  halaqaId: string;
  halaqaName: string;
}

export const TAB_SHARD_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB cap per database shard

export type TabDbShardStatus = 'active' | 'full' | 'standby';

export interface TabDbShard {
  id: string;
  label: string;
  config: ExternalFirebaseConfig;
  usedBytes: number;
  maxBytes: number;
  docsCount: number;
  status: TabDbShardStatus;
  createdAtMs: number;
}

export type TabDbPoolMap = Partial<Record<ComplexFeatureTabKey, TabDbShard[]>>;

export interface BookWordAudioRecord {
  id: string;
  complexId: string;
  mode: 'noor_albayan' | 'normal';
  wordText: string;
  diacritizedWord: string;
  wasAutoDiacritized: boolean;
  fullReading: string;
  steps: NoorAlBayanStep[];
  audioBase64: string;
  mimeType: string;
  byteSize: number;
  createdBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type BroadcastTargetRole = 'supervisor' | 'teacher' | 'student';

export const BROADCAST_ROLE_LABELS: Record<BroadcastTargetRole, string> = {
  supervisor: 'المشرفون',
  teacher: 'المعلمون',
  student: 'الطلاب',
};

export interface BroadcastMessageRecord {
  id: string;
  title: string;
  body: string;
  targetRoles: BroadcastTargetRole[];
  targetComplexId: string;
  targetComplexName: string;
  senderName: string;
  createdBy: string;
  active: boolean;
  createdAtMs: number;
  createdAt?: unknown;
  updatedAt?: unknown;
  queuedOffline?: boolean;
}

export type QuranReviewType =
  | 'surah_review'
  | 'cumulative_review'
  | 'near_review'
  | 'juz_review'
  | 'custom';

export const QURAN_REVIEW_TYPE_LABELS: Record<QuranReviewType, string> = {
  surah_review: 'مراجعة سور',
  cumulative_review: 'مراجعة تراكمية',
  near_review: 'مراجعة قريبة (ربط)',
  juz_review: 'مراجعة أجزاء',
  custom: 'مراجعة مخصصة',
};

export interface QuranRangeRef {
  startSurah: number;
  startAyah: number;
  endSurah: number;
  endAyah: number;
}

export interface StudentQuranNewHifzItem extends QuranRangeRef {
  reciterId?: string;
  note?: string;
  completed?: boolean;
}

export interface StudentQuranReviewItem extends QuranRangeRef {
  id: string;
  reviewType: QuranReviewType;
  customLabel?: string;
  note?: string;
  completed?: boolean;
}

export interface StudentQuranPlanRecord {
  id: string;
  complexId: string;
  mosqueId: string;
  halaqaId: string;
  studentId: string;
  studentName: string;
  dateKey: string; // YYYY-MM-DD
  todayNew: StudentQuranNewHifzItem | null;
  todayReviews: StudentQuranReviewItem[];
  tomorrowNew: StudentQuranNewHifzItem | null;
  tomorrowReviews: StudentQuranReviewItem[];
  recordedBy: string;
  recordedByName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StudentMushafMistakesRecord {
  id: string;
  complexId: string;
  studentId: string;
  studentName: string;
  mistakes: Record<string, number>; // key: "surah:ayah", value: mistakes count
  updatedBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export const SPARK_FREE_TIER_BYTES = 1024 * 1024 * 1024; // 1 GiB Firebase Spark Free Tier Storage Cap

export interface CollectionUsageStat {
  collection: string;
  label: string;
  docsCount: number;
  usedBytes: number;
}

export interface PhysicalDatabaseUsageSummary {
  dbKey: string;
  dbLabel: string;
  projectId: string;
  firestoreDatabaseId: string;
  isPrimary: boolean;
  reachable: boolean;
  errorMessage?: string;
  roleTags: string[];
  complexIds: string[];
  complexNames: string[];
  totalDocs: number;
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  usagePercent: number;
  collections: CollectionUsageStat[];
  checkedAtMs: number;
}

export interface AudioStorageQuotaSummary {
  totalAudioDocs: number;
  audioWithWavDocs: number;
  tahajjiOnlyDocs: number;
  noorAlBayanDocs: number;
  normalDocs: number;
  totalAudioBytes: number;
  avgAudioClipBytes: number;
  isAvgEstimated: boolean;
  libraryHostDbCount: number;
  libraryHostDbLabels: string[];
  sparkFreeLimitPerDbBytes: number;
  librarySparkTotalLimitBytes: number;
  librarySparkTotalUsedBytes: number;
  librarySparkRemainingBytes: number;
  librarySparkUsagePercent: number;
  estimatedRemainingAudioClips: number;
}

export interface DatabaseUsageDashboardReport {
  checkedAtMs: number;
  selectedComplexId: string;
  databases: PhysicalDatabaseUsageSummary[];
  totalDatabasesCount: number;
  totalDocsCount: number;
  totalUsedBytes: number;
  totalLimitBytes: number;
  totalRemainingBytes: number;
  byTabSummary: {
    tabKey: ComplexFeatureTabKey | 'core_broadcasts';
    label: string;
    usedBytes: number;
    docsCount: number;
  }[];
  audioStorageSummary: AudioStorageQuotaSummary;
}

export type BookHomeworkType =
  | 'reading'
  | 'writing'
  | 'exercise'
  | 'page_solve'
  | 'other';

export const BOOK_HOMEWORK_TYPE_LABELS: Record<BookHomeworkType, string> = {
  reading: 'قراءة',
  writing: 'كتابة',
  exercise: 'حل تمرين',
  page_solve: 'حل صفحة',
  other: 'أخرى',
};

export type BookHomeworkStatus = 'pending' | 'completed' | 'cancelled' | 'deferred';

export interface StudentBookHomeworkItem {
  id: string;
  type: BookHomeworkType;
  customTypeLabel?: string;
  pageNumber: number;
  note?: string;
  status: BookHomeworkStatus;
  deferredFromDate?: string;
}

export interface StudentBookPlanRecord {
  id: string;
  complexId: string;
  mosqueId: string;
  halaqaId: string;
  studentId: string;
  studentName: string;
  bookId: string;
  bookTitle: string;
  dateKey: string; // YYYY-MM-DD
  whereWeReachedPage: number;
  todayHomeworks: StudentBookHomeworkItem[];
  tomorrowHomeworks: StudentBookHomeworkItem[];
  recordedBy: string;
  recordedByName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type PresentationSlideLayout =
  | 'cover'
  | 'quran_ayah'
  | 'tahajji_words'
  | 'points'
  | 'comparison'
  | 'summary';

export type PresentationThemeTone = 'cream' | 'orange' | 'green' | 'espresso';

export interface PresentationInteractiveBlock {
  id: string;
  type: 'ayah' | 'tahajji_words' | 'card' | 'tip';
  label?: string;
  arabicText: string;
  surahNumber?: number;
  ayahNumber?: number;
  surahName?: string;
  note?: string;
}

export interface PresentationSlide {
  id: string;
  order: number;
  title: string;
  subtitle?: string;
  layout: PresentationSlideLayout;
  themeTone: PresentationThemeTone;
  htmlContent: string;
  interactiveBlocks: PresentationInteractiveBlock[];
  speakerNotes?: string;
  slideImageDataUrl?: string;
}

export interface PresentationChatTurn {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestampMs: number;
  targetSlideIndex?: number;
}

export interface PresentationRecord {
  id: string;
  complexId: string;
  mosqueId: string;
  halaqaId: string;
  title: string;
  description: string;
  sourceType: 'ai' | 'pptx_import';
  sourceFileName: string;
  slides: PresentationSlide[];
  chatHistory: PresentationChatTurn[];
  createdBy: string;
  createdByName: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}


