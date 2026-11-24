import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowRightLeft,
  CalendarClock,
  Check,
  CheckCircle2,
  Database,
  KeyRound,
  Lock,
  RefreshCw,
  Search,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  assignOrTransferPlatformAccount,
  deletePlatformAccountDirectoryEntry,
  listAllPlatformAccountsDirectory,
  loadComplexWorkspace,
  resolveTargetDbForEntity,
  type AccountAssignmentStatus,
  type ComplexWorkspaceData,
  type DiscoveredComplex,
  type PlatformAccountDirectoryEntry,
} from '../services/platformService';
import {
  ROLE_LABELS,
  type AccountRecord,
  type UserRole,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';

interface AdminAccountsSectionProps {
  currentAccountId: string;
  currentUserUid?: string;
  onAccountsMutated?: () => Promise<void> | void;
}

type StatusFilter = 'all' | 'unassigned' | 'in_halaqa' | 'complex_only';
type RoleFilter = 'all' | UserRole;
type SortOrder = 'newest' | 'oldest' | 'name';
type AssignRoleOption = Exclude<UserRole, 'platform_admin'> | 'complex_supervisor';

function formatRegistrationDateTime(ms: number): string {
  if (!ms || ms <= 0) return 'غير مسجّل التاريخ';
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      calendar: 'gregory',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function getAccountRoleLabel(acc: AccountRecord): string {
  if (
    acc.role === 'supervisor' &&
    !acc.mosqueId &&
    (!acc.mosqueIds || acc.mosqueIds.length === 0)
  ) {
    return 'مشرف المجمع بالكامل';
  }
  return ROLE_LABELS[acc.role];
}

function getAssignmentBadge(status: AccountAssignmentStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'in_halaqa':
      return {
        label: 'تابع لحلقة ومجمع',
        className: 'bg-[#58CC02]/12 border-[#58CC02]/40 text-[#357A02]',
      };
    case 'complex_only':
      return {
        label: 'تابع لمجمع (بدون حلقة)',
        className: 'bg-[#F56900]/12 border-[#F56900]/40 text-[#C95200]',
      };
    case 'platform_admin':
      return {
        label: 'المشرف المبرمج',
        className: 'bg-[#4A220D]/10 border-[#4A220D]/30 text-[#4A220D]',
      };
    case 'unassigned':
    default:
      return {
        label: 'مسجّل فقط (غير معيّن)',
        className: 'bg-[#FFA900]/15 border-[#FFA900]/50 text-[#9A5B00]',
      };
  }
}

function normalizeSearch(val: string): string {
  return val
    .trim()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export const AdminAccountsSection: React.FC<AdminAccountsSectionProps> = ({
  currentAccountId,
  currentUserUid,
  onAccountsMutated,
}) => {
  const [entries, setEntries] = useState<PlatformAccountDirectoryEntry[]>([]);
  const [complexes, setComplexes] = useState<DiscoveredComplex[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [complexFilter, setComplexFilter] = useState<string>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [searchQuery, setSearchQuery] = useState('');

  // Quick copy toast state
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Transfer & Assignment Modal state
  const workspaceCacheRef = useRef<Map<string, ComplexWorkspaceData>>(new Map());
  const [assignEntry, setAssignEntry] = useState<PlatformAccountDirectoryEntry | null>(null);
  const [assignComplexId, setAssignComplexId] = useState('');
  const [assignWorkspace, setAssignWorkspace] = useState<ComplexWorkspaceData | null>(null);
  const [loadingAssignWorkspace, setLoadingAssignWorkspace] = useState(false);
  const [assignRoleOption, setAssignRoleOption] = useState<AssignRoleOption>('student');
  const [assignMosqueId, setAssignMosqueId] = useState('');
  const [assignMosqueIds, setAssignMosqueIds] = useState<string[]>([]);
  const [assignHalaqaIds, setAssignHalaqaIds] = useState<string[]>([]);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [savingAssign, setSavingAssign] = useState(false);

  // Delete confirmation
  const [confirmDeleteEntry, setConfirmDeleteEntry] =
    useState<PlatformAccountDirectoryEntry | null>(null);
  const [deletingEntry, setDeletingEntry] = useState(false);

  const loadDirectory = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      workspaceCacheRef.current.clear();
      const res = await listAllPlatformAccountsDirectory();
      setEntries(res.entries);
      setComplexes(res.complexes);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تحميل سجل الحسابات.',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDirectory(false);
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, [loadDirectory]);

  const counts = useMemo(() => {
    let unassigned = 0;
    let inHalaqa = 0;
    let complexOnly = 0;
    for (const item of entries) {
      if (item.assignmentStatus === 'unassigned') unassigned++;
      else if (item.assignmentStatus === 'in_halaqa') inHalaqa++;
      else if (item.assignmentStatus === 'complex_only') complexOnly++;
    }
    return {
      total: entries.length,
      unassigned,
      inHalaqa,
      complexOnly,
    };
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = normalizeSearch(searchQuery);
    const list = entries.filter((item) => {
      const { account } = item;
      if (statusFilter !== 'all' && item.assignmentStatus !== statusFilter) {
        return false;
      }
      if (roleFilter !== 'all' && account.role !== roleFilter) {
        return false;
      }
      if (complexFilter === 'none') {
        if (account.complexId) return false;
      } else if (complexFilter !== 'all') {
        if (account.complexId !== complexFilter) return false;
      }
      if (!q) return true;
      const haystack = normalizeSearch(
        `${account.quadrupleName} ${account.email || ''} ${item.complexName} ${item.mosqueNames.join(' ')} ${item.halaqaNames.join(' ')} ${getAccountRoleLabel(account)}`
      );
      return haystack.includes(q);
    });

    return [...list].sort((a, b) => {
      if (sortOrder === 'newest') {
        if (b.registeredAtMs !== a.registeredAtMs) return b.registeredAtMs - a.registeredAtMs;
      } else if (sortOrder === 'oldest') {
        if (a.registeredAtMs !== b.registeredAtMs) {
          if (a.registeredAtMs === 0) return 1;
          if (b.registeredAtMs === 0) return -1;
          return a.registeredAtMs - b.registeredAtMs;
        }
      }
      return a.account.quadrupleName.localeCompare(b.account.quadrupleName, 'ar');
    });
  }, [entries, statusFilter, roleFilter, complexFilter, sortOrder, searchQuery]);

  const loadTargetComplexWorkspace = async (
    complexId: string,
    preferAccount?: AccountRecord
  ) => {
    const targetComp = complexes.find((c) => c.id === complexId);
    if (!targetComp) {
      setAssignWorkspace(null);
      return;
    }

    setLoadingAssignWorkspace(true);
    setAssignError(null);
    try {
      let ws = workspaceCacheRef.current.get(complexId);
      if (!ws) {
        ws = await loadComplexWorkspace(targetComp);
        workspaceCacheRef.current.set(complexId, ws);
      }
      setAssignWorkspace(ws);

      const isSameComplex = preferAccount && preferAccount.complexId === complexId;
      const defaultMosqueId = isSameComplex
        ? preferAccount.mosqueId || ws.mosques[0]?.id || ''
        : ws.mosques[0]?.id || '';

      setAssignMosqueId(defaultMosqueId);
      setAssignMosqueIds(
        isSameComplex
          ? preferAccount.mosqueIds.length > 0
            ? preferAccount.mosqueIds
            : preferAccount.mosqueId
            ? [preferAccount.mosqueId]
            : []
          : []
      );

      if (isSameComplex && preferAccount.halaqaIds.length > 0) {
        setAssignHalaqaIds(preferAccount.halaqaIds);
      } else if (defaultMosqueId) {
        const firstHalaqa = ws.halaqat.find((h) => h.mosqueId === defaultMosqueId)?.id;
        setAssignHalaqaIds(firstHalaqa ? [firstHalaqa] : []);
      } else {
        setAssignHalaqaIds([]);
      }
    } catch (err) {
      setAssignWorkspace(null);
      setAssignError(
        err instanceof Error ? err.message : 'تعذّر تحميل مساجد وحلقات هذا المجمع.'
      );
    } finally {
      setLoadingAssignWorkspace(false);
    }
  };

  const openAssignModal = (entry: PlatformAccountDirectoryEntry) => {
    if (entry.account.role === 'platform_admin') return;
    setAssignEntry(entry);
    setAssignError(null);

    const acc = entry.account;
    if (acc.role === 'platform_admin') return;
    const isComplexWide =
      acc.role === 'supervisor' && !acc.mosqueId && acc.mosqueIds.length === 0 && Boolean(acc.complexId);
    setAssignRoleOption(isComplexWide ? 'complex_supervisor' : acc.role);

    const initialComplexId =
      (acc.complexId && complexes.some((c) => c.id === acc.complexId) ? acc.complexId : '') ||
      complexes[0]?.id ||
      '';
    setAssignComplexId(initialComplexId);
    if (initialComplexId) {
      void loadTargetComplexWorkspace(initialComplexId, acc);
    } else {
      setAssignWorkspace(null);
    }
  };

  const toggleArrayItem = (arr: string[], id: string) =>
    arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];

  const handleConfirmAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignEntry) return;
    setAssignError(null);

    const targetComplex = complexes.find((c) => c.id === assignComplexId);
    if (!targetComplex || !assignWorkspace) {
      setAssignError('يرجى اختيار المجمع المراد النقل أو التعيين إليه.');
      return;
    }

    const actualRole: Exclude<UserRole, 'platform_admin'> =
      assignRoleOption === 'complex_supervisor' ? 'supervisor' : assignRoleOption;

    if (assignRoleOption === 'supervisor' && assignMosqueIds.length === 0) {
      setAssignError('يرجى تحديد مسجد واحد على الأقل لمشرف المسجد، أو اختيار "مشرف المجمع بالكامل".');
      return;
    }

    const mosqueHalaqat = assignMosqueId
      ? assignWorkspace.halaqat.filter((h) => h.mosqueId === assignMosqueId)
      : [];

    if (actualRole !== 'supervisor') {
      if (assignWorkspace.mosques.length > 0 && !assignMosqueId) {
        setAssignError('يرجى اختيار المسجد.');
        return;
      }
      if (mosqueHalaqat.length > 0 && assignHalaqaIds.length === 0) {
        setAssignError(
          actualRole === 'teacher'
            ? 'يرجى تحديد حلقة واحدة على الأقل للمعلم.'
            : 'يرجى تحديد الحلقة التي يُعيَّن فيها الطالب.'
        );
        return;
      }
    }

    const mIds =
      assignRoleOption === 'complex_supervisor'
        ? []
        : assignRoleOption === 'supervisor'
        ? assignMosqueIds
        : assignMosqueId
        ? [assignMosqueId]
        : [];
    const primaryMosque =
      assignRoleOption === 'complex_supervisor'
        ? ''
        : assignRoleOption === 'supervisor'
        ? mIds[0] || ''
        : assignMosqueId;
    const hIds = actualRole === 'supervisor' ? [] : assignHalaqaIds;

    setSavingAssign(true);
    try {
      await assignOrTransferPlatformAccount({
        entry: assignEntry,
        targetComplex,
        targetWorkspace: assignWorkspace,
        role: actualRole,
        mosqueId: primaryMosque,
        mosqueIds: mIds,
        halaqaIds: hIds,
      });

      const targetName = assignEntry.account.quadrupleName;
      setAssignEntry(null);
      setFeedback({
        type: 'ok',
        text: `تم نقل وتعيين "${targetName}" في مجمع "${targetComplex.name}" بنجاح.`,
      });
      await loadDirectory(true);
      await onAccountsMutated?.();
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'تعذّر حفظ النقل والتعيين.');
    } finally {
      setSavingAssign(false);
    }
  };

  const handleCopyQuickUrl = async (entry: PlatformAccountDirectoryEntry) => {
    const acc = entry.account;
    if (!acc.complexId || !acc.quickToken) return;
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('quick', acc.quickToken);
    url.searchParams.set('cpx', acc.complexId);
    if (acc.mosqueId) url.searchParams.set('msq', acc.mosqueId);
    const linkStr = url.toString();

    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(linkStr);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = linkStr;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        copied = false;
      }
    }

    if (copied) {
      setCopiedId(acc.id);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedId(null), 2500);
    } else {
      setFeedback({ type: 'err', text: 'تعذّر نسخ رابط الدخول السريع.' });
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteEntry) return;
    setDeletingEntry(true);
    setFeedback(null);
    try {
      const deletedName = confirmDeleteEntry.account.quadrupleName;
      await deletePlatformAccountDirectoryEntry(confirmDeleteEntry, {
        accountId: currentAccountId,
        uid: currentUserUid,
      });
      setConfirmDeleteEntry(null);
      setFeedback({ type: 'ok', text: `تم حذف حساب "${deletedName}" بنجاح.` });
      await loadDirectory(true);
      await onAccountsMutated?.();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حذف الحساب.',
      });
    } finally {
      setDeletingEntry(false);
    }
  };

  const isSelf = (acc: AccountRecord): boolean =>
    acc.id === currentAccountId ||
    (Boolean(currentUserUid) && (acc.uid === currentUserUid || acc.id === currentUserUid));

  const assignDestDbDifferent = useMemo(() => {
    if (!assignEntry || !assignWorkspace) return false;
    const actualRole: Exclude<UserRole, 'platform_admin'> =
      assignRoleOption === 'complex_supervisor' ? 'supervisor' : assignRoleOption;
    const primaryMosque =
      assignRoleOption === 'complex_supervisor'
        ? ''
        : assignRoleOption === 'supervisor'
        ? assignMosqueIds[0] || ''
        : assignMosqueId;
    const hIds = actualRole === 'supervisor' ? [] : assignHalaqaIds;
    const destDb = resolveTargetDbForEntity(assignWorkspace, primaryMosque, hIds);
    return destDb !== assignEntry.sourceDb;
  }, [assignEntry, assignWorkspace, assignRoleOption, assignMosqueId, assignMosqueIds, assignHalaqaIds]);

  const assignMosqueHalaqat = useMemo(() => {
    if (!assignWorkspace || !assignMosqueId) return [];
    return assignWorkspace.halaqat.filter((h) => h.mosqueId === assignMosqueId);
  }, [assignWorkspace, assignMosqueId]);

  if (loading) {
    return (
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
        <ModernLoader label="جاري جلب جميع الحسابات من كافة قواعد البيانات..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 bg-[#F56900]/10 border border-[#F56900]/30 rounded-xl px-3 py-1 text-xs font-display font-extrabold text-[#F56900] mb-2">
            <Users className="w-4 h-4 shrink-0" />
            <span>السجل الشامل للحسابات المسجلة</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D]">
            جميع الحسابات في المنصة ({counts.total})
          </h1>
          <p className="text-xs sm:text-sm text-[#7D4E35] mt-1">
            عرض كل الحسابات المسجلة وتاريخ تسجيلها (المعيّنة في حلقات ومجمعات، والمسجلة فقط دون حلقة) مع إمكانية نقلها وتعيينها في أي مجمع وحلقة.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadDirectory(true)}
          disabled={refreshing}
          className="duo-btn-cream min-h-[44px] px-4 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer shrink-0 disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 text-[#F56900] ${refreshing ? 'animate-spin' : ''}`} />
          <span>{refreshing ? 'جاري التحديث...' : 'تحديث السجل'}</span>
        </button>
      </section>

      {feedback && (
        <div
          role="alert"
          className={`rounded-2xl border-2 px-4 py-3 text-sm font-bold flex items-center justify-between gap-2 ${
            feedback.type === 'ok'
              ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#357A02]'
              : 'bg-[#D95338]/10 border-[#D95338]/40 text-[#D95338]'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {feedback.type === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 rounded-lg hover:bg-black/5 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Quick Classification Cards */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4" aria-label="تصنيف الحسابات">
        <button
          type="button"
          onClick={() => setStatusFilter('all')}
          className={`text-right rounded-3xl p-4 border-2 transition-all cursor-pointer ${
            statusFilter === 'all'
              ? 'bg-[#4A220D] text-white border-[#4A220D]'
              : 'bg-white border-[#EADBC8] hover:border-[#F56900]'
          }`}
        >
          <p className={`text-xs font-bold ${statusFilter === 'all' ? 'text-[#EADBC8]' : 'text-[#7D4E35]'}`}>
            جميع الحسابات
          </p>
          <p className="font-display text-2xl sm:text-3xl font-extrabold tabular-nums mt-1">
            {counts.total}
          </p>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('unassigned')}
          className={`text-right rounded-3xl p-4 border-2 transition-all cursor-pointer ${
            statusFilter === 'unassigned'
              ? 'bg-[#FFA900] text-white border-[#D98A00]'
              : 'bg-white border-[#EADBC8] hover:border-[#FFA900]'
          }`}
        >
          <p className={`text-xs font-bold ${statusFilter === 'unassigned' ? 'text-white/90' : 'text-[#9A5B00]'}`}>
            مسجّلة فقط (بدون مجمع/حلقة)
          </p>
          <p className="font-display text-2xl sm:text-3xl font-extrabold tabular-nums mt-1">
            {counts.unassigned}
          </p>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('in_halaqa')}
          className={`text-right rounded-3xl p-4 border-2 transition-all cursor-pointer ${
            statusFilter === 'in_halaqa'
              ? 'bg-[#58CC02] text-white border-[#46A302]'
              : 'bg-white border-[#EADBC8] hover:border-[#58CC02]'
          }`}
        >
          <p className={`text-xs font-bold ${statusFilter === 'in_halaqa' ? 'text-white/90' : 'text-[#357A02]'}`}>
            تابعة لحلقة ومجمع
          </p>
          <p className="font-display text-2xl sm:text-3xl font-extrabold tabular-nums mt-1">
            {counts.inHalaqa}
          </p>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('complex_only')}
          className={`text-right rounded-3xl p-4 border-2 transition-all cursor-pointer ${
            statusFilter === 'complex_only'
              ? 'bg-[#F56900] text-white border-[#C95200]'
              : 'bg-white border-[#EADBC8] hover:border-[#F56900]'
          }`}
        >
          <p className={`text-xs font-bold ${statusFilter === 'complex_only' ? 'text-white/90' : 'text-[#C95200]'}`}>
            تابعة لمجمع (بدون حلقة)
          </p>
          <p className="font-display text-2xl sm:text-3xl font-extrabold tabular-nums mt-1">
            {counts.complexOnly}
          </p>
        </button>
      </section>

      {/* Search & Filter Toolbar */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="w-4 h-4 text-[#7D4E35] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="بحث بالاسم، البريد، المجمع، الحلقة..."
              className="w-full min-h-[44px] pr-10 pl-8 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm focus:outline-none focus:border-[#F56900] focus:bg-white"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="مسح البحث"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7D4E35] hover:text-[#4A220D] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            aria-label="تصفية حسب الرتبة"
            className="w-full min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
          >
            <option value="all">كل الرتب</option>
            <option value="student">الطلاب</option>
            <option value="teacher">المعلمون</option>
            <option value="supervisor">المشرفون</option>
            <option value="platform_admin">المشرف المبرمج</option>
          </select>

          <select
            value={complexFilter}
            onChange={(e) => setComplexFilter(e.target.value)}
            aria-label="تصفية حسب المجمع"
            className="w-full min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
          >
            <option value="all">كل المجمعات</option>
            <option value="none">بدون مجمع (مسجّل فقط)</option>
            {complexes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as SortOrder)}
            aria-label="ترتيب الحسابات"
            className="w-full min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
          >
            <option value="newest">الأحدث تسجيلاً أولاً</option>
            <option value="oldest">الأقدم تسجيلاً أولاً</option>
            <option value="name">ترتيب أبجدي بالاسم</option>
          </select>
        </div>

        {/* Results Count */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#7D4E35] font-bold">
          <span>
            عرض <strong className="text-[#4A220D] tabular-nums">{filteredEntries.length}</strong> من أصل{' '}
            <strong className="text-[#4A220D] tabular-nums">{entries.length}</strong> حساب
          </span>
          {(statusFilter !== 'all' || roleFilter !== 'all' || complexFilter !== 'all' || searchQuery) && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter('all');
                setRoleFilter('all');
                setComplexFilter('all');
                setSearchQuery('');
              }}
              className="text-[#F56900] hover:underline cursor-pointer"
            >
              إعادة ضبط التصفية
            </button>
          )}
        </div>

        {/* Empty State */}
        {filteredEntries.length === 0 ? (
          <div className="bg-[#FDF6EE] border-2 border-dashed border-[#EADBC8] rounded-2xl p-8 text-center space-y-2">
            <Users className="w-8 h-8 mx-auto text-[#F56900]" />
            <p className="font-display font-bold text-sm text-[#4A220D]">
              لا توجد حسابات مطابقة للتصفية الحالية
            </p>
            <p className="text-xs text-[#7D4E35]">
              جرّب تغيير نوع التصفية أو مسح نص البحث لعرض جميع الحسابات المسجلة.
            </p>
          </div>
        ) : (
          <>
            {/* Mobile & Small Tablet Cards */}
            <div className="lg:hidden space-y-3">
              {filteredEntries.map((item) => {
                const { account } = item;
                const badge = getAssignmentBadge(item.assignmentStatus);
                const self = isSelf(account);
                const isCopied = copiedId === account.id;

                return (
                  <div
                    key={`mob_acc_${account.id}`}
                    className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                          {account.quadrupleName}
                        </p>
                        {account.email ? (
                          <p className="text-[11px] text-[#7D4E35] truncate" dir="ltr">
                            {account.email}
                          </p>
                        ) : (
                          <p className="text-[11px] text-[#7D4E35]">مضاف بالاسم الرباعي (بدون بريد)</p>
                        )}
                      </div>
                      <span
                        className={`px-2.5 py-1 rounded-xl border text-[11px] font-extrabold shrink-0 ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-[#7D4E35] bg-white border border-[#EADBC8] rounded-xl p-3">
                      <p>
                        <strong className="text-[#4A220D]">الرتبة:</strong>{' '}
                        <span className="text-[#F56900] font-bold">{getAccountRoleLabel(account)}</span>
                      </p>
                      <p className="flex items-center gap-1">
                        <CalendarClock className="w-3.5 h-3.5 text-[#F56900] shrink-0" />
                        <span>
                          <strong className="text-[#4A220D]">التسجيل:</strong>{' '}
                          {formatRegistrationDateTime(item.registeredAtMs)}
                        </span>
                      </p>
                      <p>
                        <strong className="text-[#4A220D]">المجمع:</strong>{' '}
                        {item.complexName || 'غير معيّن بمجمع'}
                      </p>
                      <p>
                        <strong className="text-[#4A220D]">المسجد:</strong>{' '}
                        {account.role === 'supervisor' &&
                        account.complexId &&
                        !account.mosqueId &&
                        account.mosqueIds.length === 0
                          ? 'جميع مساجد المجمع'
                          : item.mosqueNames.join('، ') || '—'}
                      </p>
                      <p>
                        <strong className="text-[#4A220D]">الحلقة:</strong>{' '}
                        {item.halaqaNames.join('، ') || 'غير معيّن بحلقة'}
                      </p>
                      <p className="truncate">
                        <strong className="text-[#4A220D]">القاعدة:</strong> {item.sourceDbLabel}
                      </p>
                      {account.lastLoginDate && (
                        <p>
                          <strong className="text-[#4A220D]">آخر دخول:</strong>{' '}
                          <span dir="ltr">{account.lastLoginDate}</span>
                        </p>
                      )}
                    </div>

                    {account.role === 'platform_admin' || self ? (
                      <div className="flex items-center gap-1.5 text-xs font-bold text-[#357A02] bg-[#58CC02]/10 border border-[#58CC02]/30 rounded-xl px-3 py-2">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>حساب المشرف المبرمج الأساسي للمنصة</span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => openAssignModal(item)}
                          disabled={complexes.length === 0}
                          className="duo-btn-orange flex-1 min-h-[40px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                        >
                          {item.assignmentStatus === 'unassigned' ? (
                            <>
                              <UserPlus className="w-3.5 h-3.5 shrink-0" />
                              <span>تعيين في حلقة ومجمع</span>
                            </>
                          ) : (
                            <>
                              <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" />
                              <span>نقل / تغيير الحلقة</span>
                            </>
                          )}
                        </button>

                        {account.complexId && account.quickToken && (
                          <button
                            type="button"
                            onClick={() => void handleCopyQuickUrl(item)}
                            className={`min-h-[40px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1 cursor-pointer ${
                              isCopied ? 'duo-btn-green' : 'duo-btn-cream'
                            }`}
                          >
                            {isCopied ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span>تم النسخ</span>
                              </>
                            ) : (
                              <>
                                <KeyRound className="w-3.5 h-3.5 text-[#F56900]" />
                                <span>دخول سريع</span>
                              </>
                            )}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => setConfirmDeleteEntry(item)}
                          aria-label={`حذف ${account.quadrupleName}`}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-xs font-bold text-[#D95338] inline-flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>حذف</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Laptop / Wide Tablet Table View */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead>
                  <tr className="border-b-2 border-[#F7EBDD] text-[#7D4E35]">
                    <th className="py-3 px-3 font-display font-bold">العضو والبريد</th>
                    <th className="py-3 px-3 font-display font-bold">متى سُجِّل</th>
                    <th className="py-3 px-3 font-display font-bold">التصنيف والرتبة</th>
                    <th className="py-3 px-3 font-display font-bold">المجمع والمسجد والحلقة</th>
                    <th className="py-3 px-3 font-display font-bold">القاعدة</th>
                    <th className="py-3 px-3 font-display font-bold">النقل والإجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((item) => {
                    const { account } = item;
                    const badge = getAssignmentBadge(item.assignmentStatus);
                    const self = isSelf(account);
                    const isCopied = copiedId === account.id;

                    return (
                      <tr
                        key={account.id}
                        className="border-b border-[#F7EBDD] last:border-b-0 hover:bg-[#FDF6EE]/60 transition-colors"
                      >
                        <td className="py-3 px-3 align-top">
                          <p className="font-bold text-[#4A220D]">{account.quadrupleName}</p>
                          {account.email ? (
                            <p className="text-[11px] text-[#7D4E35]" dir="ltr">
                              {account.email}
                            </p>
                          ) : (
                            <p className="text-[11px] text-[#7D4E35]">بدون بريد إلكتروني</p>
                          )}
                          <span className="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35]">
                            {account.uid ? 'مرتبط بجوجل' : 'دخول سريع فقط'}
                          </span>
                        </td>

                        <td className="py-3 px-3 align-top whitespace-nowrap">
                          <p className="text-xs font-bold text-[#4A220D]">
                            {formatRegistrationDateTime(item.registeredAtMs)}
                          </p>
                          {account.lastLoginDate && (
                            <p className="text-[11px] text-[#7D4E35] mt-0.5">
                              آخر دخول: <span dir="ltr">{account.lastLoginDate}</span>
                            </p>
                          )}
                        </td>

                        <td className="py-3 px-3 align-top">
                          <span
                            className={`inline-block px-2.5 py-0.5 rounded-lg border text-[11px] font-extrabold whitespace-nowrap ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                          <p className="text-xs font-bold text-[#F56900] mt-1 whitespace-nowrap">
                            {getAccountRoleLabel(account)}
                          </p>
                        </td>

                        <td className="py-3 px-3 align-top text-xs text-[#7D4E35] space-y-0.5">
                          <p>
                            <strong className="text-[#4A220D]">المجمع:</strong>{' '}
                            {item.complexName || '—'}
                          </p>
                          <p>
                            <strong className="text-[#4A220D]">المسجد:</strong>{' '}
                            {account.role === 'supervisor' &&
                            account.complexId &&
                            !account.mosqueId &&
                            account.mosqueIds.length === 0
                              ? 'جميع المساجد'
                              : item.mosqueNames.join('، ') || '—'}
                          </p>
                          <p>
                            <strong className="text-[#4A220D]">الحلقة:</strong>{' '}
                            {item.halaqaNames.join('، ') || '—'}
                          </p>
                        </td>

                        <td className="py-3 px-3 align-top text-xs font-bold text-[#7D4E35]">
                          {item.sourceDbLabel}
                        </td>

                        <td className="py-3 px-3 align-top">
                          {account.role === 'platform_admin' || self ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[#58CC02]/10 border border-[#58CC02]/30 text-[11px] font-bold text-[#357A02] whitespace-nowrap">
                              <Lock className="w-3.5 h-3.5 shrink-0" />
                              <span>محمي</span>
                            </span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => openAssignModal(item)}
                                disabled={complexes.length === 0}
                                className="duo-btn-orange min-h-[38px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-50"
                              >
                                {item.assignmentStatus === 'unassigned' ? (
                                  <>
                                    <UserPlus className="w-3.5 h-3.5 shrink-0" />
                                    <span>تعيين في حلقة</span>
                                  </>
                                ) : (
                                  <>
                                    <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" />
                                    <span>نقل / تغيير</span>
                                  </>
                                )}
                              </button>

                              {account.complexId && account.quickToken && (
                                <button
                                  type="button"
                                  onClick={() => void handleCopyQuickUrl(item)}
                                  title="نسخ رابط الدخول السريع"
                                  className={`min-h-[38px] px-2.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer whitespace-nowrap ${
                                    isCopied ? 'duo-btn-green' : 'duo-btn-cream'
                                  }`}
                                >
                                  {isCopied ? (
                                    <Check className="w-3.5 h-3.5" />
                                  ) : (
                                    <KeyRound className="w-3.5 h-3.5 text-[#F56900]" />
                                  )}
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => setConfirmDeleteEntry(item)}
                                aria-label={`حذف ${account.quadrupleName}`}
                                title="حذف الحساب"
                                className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] hover:bg-[#D95338]/10 text-[#D95338] inline-flex items-center justify-center cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* Transfer & Assignment Modal */}
      {assignEntry &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[95] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
            onClick={(e) => {
              if (e.target === e.currentTarget && !savingAssign) setAssignEntry(null);
            }}
          >
            <form
              onSubmit={handleConfirmAssign}
              dir="rtl"
              className="w-full sm:max-w-xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 pb-safe space-y-4 shadow-2xl max-h-[92dvh] overflow-y-auto"
            >
              <div className="flex items-center justify-between gap-2 pb-3 border-b-2 border-[#F7EBDD]">
                <div className="flex items-center gap-2 min-w-0">
                  <UserCheck className="w-5 h-5 text-[#F56900] shrink-0" />
                  <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D] truncate">
                    نقل وتعيين الحساب في مجمع وحلقة
                  </h3>
                </div>
                <button
                  type="button"
                  disabled={savingAssign}
                  onClick={() => setAssignEntry(null)}
                  aria-label="إغلاق"
                  className="p-1.5 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Member Info Box */}
              <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 text-xs space-y-1">
                <p className="font-display font-extrabold text-sm text-[#4A220D]">
                  {assignEntry.account.quadrupleName}
                </p>
                <p className="text-[#7D4E35]">
                  الوضع الحالي:{' '}
                  <strong className="text-[#F56900]">
                    {assignEntry.complexName
                      ? `${assignEntry.complexName}${
                          assignEntry.halaqaNames.length
                            ? ` · ${assignEntry.halaqaNames.join('، ')}`
                            : ''
                        }`
                      : 'مسجّل فقط (غير معيّن في أي مجمع أو حلقة)'}
                  </strong>
                </p>
                <p className="text-[#7D4E35]">
                  تاريخ التسجيل: {formatRegistrationDateTime(assignEntry.registeredAtMs)}
                </p>
              </div>

              {/* Complex & Role */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                    المجمع القرآني الهدف
                  </label>
                  <select
                    value={assignComplexId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setAssignComplexId(nextId);
                      void loadTargetComplexWorkspace(nextId, assignEntry.account);
                    }}
                    className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
                  >
                    {complexes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                    الصفة / الدور في المجمع
                  </label>
                  <select
                    value={assignRoleOption}
                    onChange={(e) => {
                      const next = e.target.value as AssignRoleOption;
                      setAssignRoleOption(next);
                      if (next === 'complex_supervisor') {
                        setAssignMosqueIds([]);
                        setAssignHalaqaIds([]);
                      } else if (next === 'supervisor') {
                        setAssignHalaqaIds([]);
                        if (assignMosqueIds.length === 0 && assignMosqueId) {
                          setAssignMosqueIds([assignMosqueId]);
                        }
                      } else if (!assignMosqueId && assignMosqueIds[0]) {
                        setAssignMosqueId(assignMosqueIds[0]);
                      }
                    }}
                    className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
                  >
                    <option value="student">طالب</option>
                    <option value="teacher">معلم</option>
                    <option value="supervisor">مشرف مسجد</option>
                    <option value="complex_supervisor">مشرف المجمع بالكامل</option>
                  </select>
                </div>
              </div>

              {loadingAssignWorkspace ? (
                <div className="py-4">
                  <ModernLoader label="جاري تحميل مساجد وحلقات المجمع..." />
                </div>
              ) : assignWorkspace ? (
                assignRoleOption === 'complex_supervisor' ? (
                  <div className="bg-[#58CC02]/10 border border-[#58CC02]/30 rounded-2xl p-3.5 text-xs font-bold text-[#357A02]">
                    سيتم تعيينه بصلاحية <strong>مشرف المجمع بالكامل</strong> على جميع المساجد والحلقات في هذا المجمع.
                  </div>
                ) : assignRoleOption === 'supervisor' ? (
                  <div>
                    <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                      حدد المسجد أو المساجد التي يشرف عليها:
                    </p>
                    {assignWorkspace.mosques.length === 0 ? (
                      <p className="text-xs text-[#D95338] font-bold">
                        لا توجد مساجد في هذا المجمع بعد.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {assignWorkspace.mosques.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setAssignMosqueIds((prev) => toggleArrayItem(prev, m.id))
                            }
                            className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                              assignMosqueIds.includes(m.id)
                                ? 'bg-[#F56900] border-[#C95200] text-white'
                                : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                            }`}
                          >
                            {m.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                        المسجد
                      </label>
                      {assignWorkspace.mosques.length === 0 ? (
                        <p className="text-xs text-[#D95338] font-bold">
                          لا توجد مساجد مضافة في هذا المجمع بعد.
                        </p>
                      ) : (
                        <select
                          value={assignMosqueId}
                          onChange={(e) => {
                            const nextM = e.target.value;
                            setAssignMosqueId(nextM);
                            const firstH = assignWorkspace.halaqat.find(
                              (h) => h.mosqueId === nextM
                            )?.id;
                            setAssignHalaqaIds(firstH ? [firstH] : []);
                          }}
                          className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
                        >
                          {assignWorkspace.mosques.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div>
                      <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                        {assignRoleOption === 'teacher'
                          ? 'الحلقات التي يدرّسها المعلم:'
                          : 'الحلقة المعيّن بها الطالب:'}
                      </p>
                      {assignMosqueHalaqat.length === 0 ? (
                        <p className="text-xs text-[#7D4E35] bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-3">
                          لا توجد حلقات داخل هذا المسجد بعد (يمكنك إضافة حلقات من قسم المجمعات، أو حفظ التعيين على مستوى المسجد مؤقتاً).
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {assignMosqueHalaqat.map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              onClick={() =>
                                setAssignHalaqaIds((prev) =>
                                  assignRoleOption === 'teacher'
                                    ? toggleArrayItem(prev, h.id)
                                    : [h.id]
                                )
                              }
                              className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                                assignHalaqaIds.includes(h.id)
                                  ? 'bg-[#F56900] border-[#C95200] text-white'
                                  : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                              }`}
                            >
                              {h.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              ) : null}

              {assignDestDbDifferent && (
                <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl px-3.5 py-2.5 text-xs font-bold text-[#4A220D] flex items-center gap-2">
                  <Database className="w-4 h-4 text-[#F56900] shrink-0" />
                  <span>
                    سيتم نقل سجل الحساب تلقائياً من قاعدته الحالية ({assignEntry.sourceDbLabel}) إلى قاعدة بيانات المجمع/الحلقة المختارة.
                  </span>
                </div>
              )}

              {assignError && (
                <div
                  role="alert"
                  className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{assignError}</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingAssign || loadingAssignWorkspace || !assignWorkspace}
                  className="duo-btn-orange flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {savingAssign ? 'جاري النقل والتعيين...' : 'حفظ النقل والتعيين'}
                </button>
                <button
                  type="button"
                  disabled={savingAssign}
                  onClick={() => setAssignEntry(null)}
                  className="duo-btn-cream flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteEntry &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[95] flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
            role="dialog"
            aria-modal="true"
          >
            <div
              dir="rtl"
              className="w-full max-w-sm bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4 shadow-xl"
            >
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                حذف حساب: {confirmDeleteEntry.account.quadrupleName}؟
              </h3>
              <p className="text-sm text-[#7D4E35]">
                سيتم حذف سجل هذا الحساب وفهرس اسمه الرباعي من قاعدة البيانات نهائياً.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={deletingEntry}
                  onClick={() => void handleConfirmDelete()}
                  className="flex-1 min-h-[46px] rounded-2xl bg-[#D95338] text-white font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {deletingEntry ? 'جاري الحذف...' : 'تأكيد الحذف'}
                </button>
                <button
                  type="button"
                  disabled={deletingEntry}
                  onClick={() => setConfirmDeleteEntry(null)}
                  className="duo-btn-cream flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
