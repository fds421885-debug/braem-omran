import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowRight,
  ArrowRightLeft,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Edit3,
  KeyRound,
  Link2,
  Lock,
  Plus,
  Search,
  Trash2,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import { getDbDisplayLabel, validateQuadrupleArabicName } from '../services/multiDb';
import {
  addOrRenameHalaqaInWorkspace,
  addOrRenameMosqueInWorkspace,
  deleteInviteLinkFromWorkspace,
  deleteMemberAccountFromWorkspace,
  loadComplexWorkspace,
  saveInviteLinkToWorkspace,
  syncQuickLinkForAccount,
  toggleInviteLinkActiveState,
  transferAccountAssignment,
  transferEntireHalaqa,
  updateMemberAccountInWorkspace,
  type ComplexWorkspaceData,
  type DbTransferScope,
  type DiscoveredComplex,
} from '../services/platformService';
import {
  ROLE_LABELS,
  type AccountRecord,
  type ConnectedDatabaseInfo,
  type HalaqaRecord,
  type InviteLinkRecord,
  type UserRole,
} from '../types/platform';
import { ComplexDatabasesTab } from './ComplexDatabasesTab';
import { DatabaseTransferModal } from './DatabaseTransferModal';
import { ModernLoader } from './ModernLoader';

interface ComplexWorkspaceProps {
  discovered: DiscoveredComplex;
  connectedDbs: ConnectedDatabaseInfo[];
  onBack: () => void;
  onComplexRelocated: (complexId: string) => Promise<void> | void;
  supervisorMode?: boolean;
  initialWorkspace?: ComplexWorkspaceData | null;
  restrictMosqueIds?: string[];
  onWorkspaceMutated?: () => Promise<void> | void;
}

type WorkspaceTab = 'stats' | 'accounts' | 'mosques' | 'quick_links' | 'databases';
type AccountSubTab = 'invites' | 'list';
type TargetRoleOption = Exclude<UserRole, 'platform_admin'> | 'complex_supervisor';

function getRoleDisplayLabel(acc: { role: UserRole; mosqueId?: string; mosqueIds?: string[] }): string {
  if (
    acc.role === 'supervisor' &&
    !acc.mosqueId &&
    (!acc.mosqueIds || acc.mosqueIds.length === 0)
  ) {
    return 'مشرف المجمع بالكامل';
  }
  return ROLE_LABELS[acc.role];
}

export const ComplexWorkspace: React.FC<ComplexWorkspaceProps> = ({
  discovered,
  connectedDbs,
  onBack,
  onComplexRelocated,
  supervisorMode = false,
  initialWorkspace = null,
  restrictMosqueIds,
  onWorkspaceMutated,
}) => {
  const [workspace, setWorkspace] = useState<ComplexWorkspaceData | null>(initialWorkspace);
  const [loading, setLoading] = useState(!initialWorkspace);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>(supervisorMode ? 'accounts' : 'stats');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Accounts Subtab state (Registration Links & Members)
  const [accountSubTab, setAccountSubTab] = useState<AccountSubTab>('invites');

  // Invite link state
  const [editingInviteToken, setEditingInviteToken] = useState<string | undefined>(undefined);
  const [inviteTitle, setInviteTitle] = useState('');
  const [inviteTargetRole, setInviteTargetRole] = useState<TargetRoleOption>('student');
  const [inviteMosqueId, setInviteMosqueId] = useState(
    initialWorkspace?.mosques[0]?.id || ''
  );
  const [inviteMosqueIds, setInviteMosqueIds] = useState<string[]>([]);
  const [inviteHalaqaIds, setInviteHalaqaIds] = useState<string[]>([]);
  const [inviteStartsAt, setInviteStartsAt] = useState('');
  const [inviteEndsAt, setInviteEndsAt] = useState('');
  const [inviteActive, setInviteActive] = useState(true);

  // Mosques tab operations state
  const [newMosqueName, setNewMosqueName] = useState('');
  const [newHalaqaNames, setNewHalaqaNames] = useState<Record<string, string>>({});
  const [renamingMosqueId, setRenamingMosqueId] = useState<string | null>(null);
  const [renamingMosqueVal, setRenamingMosqueVal] = useState('');
  const [renamingHalaqaId, setRenamingHalaqaId] = useState<string | null>(null);
  const [renamingHalaqaVal, setRenamingHalaqaVal] = useState('');

  // Transfer states
  const [transferHalaqaId, setTransferHalaqaId] = useState('');
  const [transferHalaqaDestMosqueId, setTransferHalaqaDestMosqueId] = useState('');
  const [transferAccId, setTransferAccId] = useState('');
  const [transferAccMosqueId, setTransferAccMosqueId] = useState('');
  const [transferAccMosqueIds, setTransferAccMosqueIds] = useState<string[]>([]);
  const [transferAccHalaqaIds, setTransferAccHalaqaIds] = useState<string[]>([]);

  // Quick links filter state
  const [quickRoleFilter, setQuickRoleFilter] = useState<'all' | 'supervisor' | 'teacher' | 'student'>('all');
  const [quickMosqueFilter, setQuickMosqueFilter] = useState<string>('all');
  const [quickHalaqaFilter, setQuickHalaqaFilter] = useState<string>('all');
  const [memberSearch, setMemberSearch] = useState('');
  const [memberRoleFilter, setMemberRoleFilter] = useState<
    'all' | 'student' | 'teacher' | 'supervisor'
  >('all');
  const [editingMember, setEditingMember] = useState<AccountRecord | null>(null);
  const [editMemberName, setEditMemberName] = useState('');
  const [editMemberTargetRole, setEditMemberTargetRole] =
    useState<TargetRoleOption>('student');
  const [editMemberMosqueId, setEditMemberMosqueId] = useState('');
  const [editMemberMosqueIds, setEditMemberMosqueIds] = useState<string[]>([]);
  const [editMemberHalaqaIds, setEditMemberHalaqaIds] = useState<string[]>([]);
  const [editMemberError, setEditMemberError] = useState<string | null>(null);
  const [savingMember, setSavingMember] = useState(false);
  const [confirmDeleteMember, setConfirmDeleteMember] = useState<AccountRecord | null>(null);
  const [deletingMember, setDeletingMember] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [transferTarget, setTransferTarget] = useState<{
    scope: DbTransferScope;
    targetId: string;
    targetName: string;
    currentDbLabel: string;
  } | null>(null);

  const isFirstInitialMount = useRef(Boolean(initialWorkspace));

  const refreshWorkspace = useCallback(async () => {
    setLoading((prev) => (workspace ? prev : true));
    try {
      const data = await loadComplexWorkspace(discovered);
      setWorkspace(data);
      const firstMosque =
        (restrictMosqueIds && restrictMosqueIds.length > 0
          ? data.mosques.find((m) => restrictMosqueIds.includes(m.id))?.id
          : data.mosques[0]?.id) || '';
      setInviteMosqueId((prev) => prev || firstMosque);
      await onWorkspaceMutated?.();
    } finally {
      setLoading(false);
    }
  }, [discovered, restrictMosqueIds, onWorkspaceMutated, workspace]);

  useEffect(() => {
    if (isFirstInitialMount.current && initialWorkspace) {
      isFirstInitialMount.current = false;
      const firstMosque =
        (restrictMosqueIds && restrictMosqueIds.length > 0
          ? initialWorkspace.mosques.find((m) => restrictMosqueIds.includes(m.id))?.id
          : initialWorkspace.mosques[0]?.id) || '';
      setInviteMosqueId((prev) => prev || firstMosque);
      setLoading(false);
      return;
    }
    void refreshWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discovered]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const fallbackExecCopy = (text: string): boolean => {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  };

  const showCopiedSuccess = (key: string, toastMessage: string) => {
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
    }
    setCopiedId(key);
    setCopyToast(toastMessage);
    setFeedback({ type: 'ok', text: toastMessage });
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedId(null);
      setCopyToast(null);
      copyTimerRef.current = null;
    }, 3000);
  };

  const copyText = async (
    key: string,
    text: string,
    toastMessage = 'تم النسخ بنجاح'
  ) => {
    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = fallbackExecCopy(text);
      }
    } else {
      copied = fallbackExecCopy(text);
    }

    if (copied) {
      showCopiedSuccess(key, toastMessage);
    } else {
      setFeedback({ type: 'err', text: 'تعذّر النسخ للحافظة.' });
    }
  };

  const toggleArrayItem = (arr: string[], id: string) =>
    arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];

  if (loading || !workspace) {
    return (
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8">
        <ModernLoader label="جاري تحميل بيانات المجمع..." />
      </div>
    );
  }

  const allowedMosqueSet =
    restrictMosqueIds && restrictMosqueIds.length > 0 ? new Set(restrictMosqueIds) : null;
  const visibleMosques = allowedMosqueSet
    ? workspace.mosques.filter((m) => allowedMosqueSet.has(m.id))
    : workspace.mosques;
  const visibleHalaqat = allowedMosqueSet
    ? workspace.halaqat.filter((h) => allowedMosqueSet.has(h.mosqueId))
    : workspace.halaqat;
  const visibleAccounts = allowedMosqueSet
    ? workspace.accounts.filter(
        (a) =>
          allowedMosqueSet.has(a.mosqueId) ||
          a.mosqueIds.some((id) => allowedMosqueSet.has(id))
      )
    : workspace.accounts;
  const visibleInvites = allowedMosqueSet
    ? workspace.inviteLinks.filter(
        (lnk) =>
          allowedMosqueSet.has(lnk.mosqueId) ||
          lnk.mosqueIds.some((id) => allowedMosqueSet.has(id))
      )
    : workspace.inviteLinks;

  const supervisors = visibleAccounts.filter((a) => a.role === 'supervisor');
  const teachers = visibleAccounts.filter((a) => a.role === 'teacher');
  const students = visibleAccounts.filter((a) => a.role === 'student');

  const inviteMosqueHalaqat = visibleHalaqat.filter(
    (h) => h.mosqueId === inviteMosqueId
  );

  const getInviteTargetDbLabel = (mosqueId: string, halaqaIds: string[]): string => {
    if (halaqaIds.length === 1 && workspace.halaqaDbMap[halaqaIds[0]]) {
      const hConf = workspace.halaqaConfigMap[halaqaIds[0]];
      return hConf ? `قاعدة منفصلة (${getDbDisplayLabel(hConf)})` : 'القاعدة الأساسية';
    }
    if (mosqueId && workspace.mosqueDbMap[mosqueId]) {
      const mConf = workspace.mosqueConfigMap[mosqueId];
      return mConf ? `قاعدة منفصلة (${getDbDisplayLabel(mConf)})` : 'القاعدة الأساسية';
    }
    return discovered.ownerDbLabel;
  };

  const toLocalDateTimeInput = (ms: number): string => {
    if (!ms || ms <= 0) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  };

  const resetInviteForm = () => {
    setEditingInviteToken(undefined);
    setInviteTitle('');
    setInviteHalaqaIds([]);
    setInviteMosqueIds([]);
    setInviteStartsAt('');
    setInviteEndsAt('');
    setInviteActive(true);
  };

  const handleSaveInviteLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const trimmedTitle = inviteTitle.trim();
    if (trimmedTitle.length < 2) {
      setFeedback({ type: 'err', text: 'يرجى كتابة عنوان واضح للرابط (حرفان على الأقل).' });
      return;
    }

    const rawStarts = inviteStartsAt ? new Date(inviteStartsAt).getTime() : 0;
    const rawEnds = inviteEndsAt ? new Date(inviteEndsAt).getTime() : 0;
    const startsAtMs = Number.isFinite(rawStarts) ? rawStarts : 0;
    const endsAtMs = Number.isFinite(rawEnds) ? rawEnds : 0;
    if (startsAtMs > 0 && endsAtMs > 0 && endsAtMs <= startsAtMs) {
      setFeedback({ type: 'err', text: 'يجب أن يكون وقت النهاية بعد وقت البداية.' });
      return;
    }

    const actualRole: Exclude<UserRole, 'platform_admin'> =
      inviteTargetRole === 'complex_supervisor' ? 'supervisor' : inviteTargetRole;
    const mIds =
      inviteTargetRole === 'complex_supervisor'
        ? []
        : inviteTargetRole === 'supervisor'
        ? inviteMosqueIds
        : inviteMosqueId
        ? [inviteMosqueId]
        : [];
    const primaryMosque =
      inviteTargetRole === 'complex_supervisor'
        ? ''
        : inviteTargetRole === 'supervisor'
        ? mIds[0] || ''
        : inviteMosqueId;

    if (inviteTargetRole === 'supervisor' && mIds.length === 0) {
      setFeedback({ type: 'err', text: 'يرجى تحديد مسجد واحد على الأقل لمشرف المسجد، أو اختر "مشرف المجمع بالكامل".' });
      return;
    }

    setBusyLabel('جاري حفظ رابط التسجيل...');
    try {
      await saveInviteLinkToWorkspace({
        workspace,
        existingToken: editingInviteToken,
        title: trimmedTitle,
        role: actualRole,
        mosqueId: primaryMosque,
        mosqueIds: mIds,
        halaqaIds:
          actualRole === 'supervisor' ? [] : inviteHalaqaIds,
        startsAtMs,
        endsAtMs,
        active: inviteActive,
      });
      resetInviteForm();
      setFeedback({ type: 'ok', text: 'تم حفظ رابط التسجيل بنجاح.' });
      await refreshWorkspace();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حفظ رابط التسجيل.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleEditInviteLink = (link: InviteLinkRecord) => {
    setEditingInviteToken(link.token);
    setInviteTitle(link.title);
    const isComplexWideSup =
      link.role === 'supervisor' && !link.mosqueId && link.mosqueIds.length === 0;
    setInviteTargetRole(isComplexWideSup ? 'complex_supervisor' : link.role);
    setInviteMosqueId(link.mosqueId);
    setInviteMosqueIds(link.mosqueIds);
    setInviteHalaqaIds(link.halaqaIds);
    setInviteStartsAt(toLocalDateTimeInput(link.startsAtMs));
    setInviteEndsAt(toLocalDateTimeInput(link.endsAtMs));
    setInviteActive(link.active);
    setAccountSubTab('invites');
  };

  const handleToggleInviteActive = async (link: InviteLinkRecord) => {
    const nextActive = !link.active;
    setFeedback(null);
    try {
      const updated = await toggleInviteLinkActiveState(workspace, link, nextActive);
      setWorkspace((prev) =>
        prev
          ? {
              ...prev,
              inviteLinks: prev.inviteLinks.map((item) =>
                item.token === updated.token ? updated : item
              ),
            }
          : prev
      );
      setFeedback({
        type: 'ok',
        text: nextActive
          ? `تم فتح وتفعيل رابط "${link.title}" بنجاح.`
          : `تم إغلاق رابط "${link.title}" بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تحديث حالة الرابط.',
      });
    }
  };

  const buildQuickLoginUrl = (token: string, mosqueId?: string) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('quick', token);
    url.searchParams.set('cpx', discovered.id);
    if (mosqueId) url.searchParams.set('msq', mosqueId);
    return url.toString();
  };

  const handleCopyInviteUrl = (link: InviteLinkRecord) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('invite', link.token);
    url.searchParams.set('cpx', discovered.id);
    if (link.mosqueId) url.searchParams.set('msq', link.mosqueId);
    void copyText(`inv_${link.token}`, url.toString(), 'تم النسخ بنجاح');
  };

  const mergeQuickLinkIntoWorkspace = (
    accountId: string,
    quick: Awaited<ReturnType<typeof syncQuickLinkForAccount>>
  ) => {
    setWorkspace((prev) => {
      if (!prev) return prev;
      const nextAccounts = prev.accounts.map((acc) =>
        acc.id === accountId ? { ...acc, quickToken: quick.token } : acc
      );
      const exists = prev.quickLinks.some((q) => q.token === quick.token);
      const nextQuickLinks = exists
        ? prev.quickLinks.map((q) => (q.token === quick.token ? quick : q))
        : [...prev.quickLinks, quick];
      return {
        ...prev,
        accounts: nextAccounts,
        quickLinks: nextQuickLinks,
      };
    });
  };

  const handleCopyQuickUrl = async (account: AccountRecord) => {
    if (account.quickToken) {
      const quickUrl = buildQuickLoginUrl(account.quickToken, account.mosqueId);
      // انسخ فوراً ضمن نقرة المستخدم حتى يظهر "تم النسخ بنجاح" مباشرة دون إعادة تحميل الصفحة
      await copyText(
        `qk_${account.id}`,
        quickUrl,
        `تم النسخ بنجاح — ${account.quadrupleName}`
      );
      syncQuickLinkForAccount(workspace, account)
        .then((quick) => mergeQuickLinkIntoWorkspace(account.id, quick))
        .catch(() => {
          // الرابط موجود ومفعل بالفعل في قاعدة البيانات
        });
      return;
    }

    try {
      const quick = await syncQuickLinkForAccount(workspace, account);
      mergeQuickLinkIntoWorkspace(account.id, quick);
      const quickUrl = buildQuickLoginUrl(quick.token, account.mosqueId);
      await copyText(
        `qk_${account.id}`,
        quickUrl,
        `تم النسخ بنجاح — ${account.quadrupleName}`
      );
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تجهيز ونسخ رابط الدخول السريع.',
      });
    }
  };

  const handleAddMosque = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMosqueName.trim()) return;
    setBusyLabel('جاري إضافة المسجد...');
    try {
      await addOrRenameMosqueInWorkspace({ workspace, name: newMosqueName });
      setNewMosqueName('');
      await refreshWorkspace();
    } finally {
      setBusyLabel(null);
    }
  };

  const handleAddHalaqa = async (mosqueId: string) => {
    const hName = (newHalaqaNames[mosqueId] || '').trim();
    if (!hName) return;
    setBusyLabel('جاري إضافة الحلقة...');
    try {
      await addOrRenameHalaqaInWorkspace({ workspace, mosqueId, name: hName });
      setNewHalaqaNames((prev) => ({ ...prev, [mosqueId]: '' }));
      await refreshWorkspace();
    } finally {
      setBusyLabel(null);
    }
  };

  const handleTransferHalaqa = async (e: React.FormEvent) => {
    e.preventDefault();
    const hlq = workspace.halaqat.find((h) => h.id === transferHalaqaId);
    if (!hlq || !transferHalaqaDestMosqueId) return;
    setBusyLabel('جاري نقل الحلقة مع معلميها وطلابها...');
    try {
      await transferEntireHalaqa({
        workspace,
        halaqa: hlq,
        destinationMosqueId: transferHalaqaDestMosqueId,
      });
      setTransferHalaqaId('');
      setFeedback({ type: 'ok', text: 'تم نقل الحلقة الكاملة وأعضائها بنجاح.' });
      await refreshWorkspace();
    } finally {
      setBusyLabel(null);
    }
  };

  const selectedTransferAccount = workspace.accounts.find((a) => a.id === transferAccId);

  const handleTransferAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTransferAccount) return;
    setBusyLabel('جاري تنفيذ النقل وتحديث التعيين...');
    try {
      const mIds =
        selectedTransferAccount.role === 'supervisor'
          ? transferAccMosqueIds
          : transferAccMosqueId
          ? [transferAccMosqueId]
          : [];
      const primaryM =
        selectedTransferAccount.role === 'supervisor' ? mIds[0] || '' : transferAccMosqueId;
      await transferAccountAssignment({
        workspace,
        account: selectedTransferAccount,
        newMosqueId: primaryM,
        newMosqueIds: mIds,
        newHalaqaIds:
          selectedTransferAccount.role === 'supervisor' ? [] : transferAccHalaqaIds,
      });
      setTransferAccId('');
      setFeedback({ type: 'ok', text: 'تم نقل وتحديث تعيين العضو بنجاح.' });
      await refreshWorkspace();
    } finally {
      setBusyLabel(null);
    }
  };

  const quickFilteredAccounts = visibleAccounts.filter((a) => {
    if (a.role === 'platform_admin') return false;
    if (quickRoleFilter !== 'all' && a.role !== quickRoleFilter) return false;
    if (quickMosqueFilter !== 'all') {
      const belongsMosque =
        a.mosqueId === quickMosqueFilter || a.mosqueIds.includes(quickMosqueFilter);
      if (!belongsMosque) return false;
    }
    if (quickHalaqaFilter !== 'all' && !a.halaqaIds.includes(quickHalaqaFilter)) {
      return false;
    }
    return true;
  });

  const openEditMemberModal = (acc: AccountRecord) => {
    if (acc.role === 'platform_admin') return;
    setEditingMember(acc);
    setEditMemberName(acc.quadrupleName);
    const isComplexWide =
      acc.role === 'supervisor' && !acc.mosqueId && acc.mosqueIds.length === 0;
    setEditMemberTargetRole(isComplexWide ? 'complex_supervisor' : acc.role);
    const defaultMosqueId = acc.mosqueId || visibleMosques[0]?.id || '';
    setEditMemberMosqueId(defaultMosqueId);
    setEditMemberMosqueIds(
      acc.mosqueIds.length > 0 ? acc.mosqueIds : acc.mosqueId ? [acc.mosqueId] : []
    );
    setEditMemberHalaqaIds(acc.halaqaIds || []);
    setEditMemberError(null);
  };

  const handleSaveMemberEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMember) return;
    setEditMemberError(null);

    const validation = validateQuadrupleArabicName(editMemberName);
    if (!validation.valid) {
      setEditMemberError(validation.error || 'يرجى كتابة الاسم الرباعي كاملاً.');
      return;
    }

    const actualRole: Exclude<UserRole, 'platform_admin'> =
      editMemberTargetRole === 'complex_supervisor' ? 'supervisor' : editMemberTargetRole;
    const mIds =
      editMemberTargetRole === 'complex_supervisor'
        ? []
        : editMemberTargetRole === 'supervisor'
        ? editMemberMosqueIds
        : editMemberMosqueId
        ? [editMemberMosqueId]
        : [];
    const primaryMosque =
      editMemberTargetRole === 'complex_supervisor'
        ? ''
        : editMemberTargetRole === 'supervisor'
        ? mIds[0] || ''
        : editMemberMosqueId;
    const hIds = actualRole === 'supervisor' ? [] : editMemberHalaqaIds;

    setSavingMember(true);
    try {
      await updateMemberAccountInWorkspace({
        workspace,
        account: editingMember,
        quadrupleName: validation.normalized,
        role: actualRole,
        mosqueId: primaryMosque,
        mosqueIds: mIds,
        halaqaIds: hIds,
      });
      setEditingMember(null);
      setFeedback({ type: 'ok', text: 'تم تعديل بيانات العضو وتحديث رابط الدخول السريع بنجاح.' });
      await refreshWorkspace();
    } catch (err) {
      setEditMemberError(err instanceof Error ? err.message : 'تعذّر حفظ تعديلات العضو.');
    } finally {
      setSavingMember(false);
    }
  };

  const handleConfirmDeleteMember = async () => {
    if (!confirmDeleteMember) return;
    setDeletingMember(true);
    setFeedback(null);
    try {
      const deletedName = confirmDeleteMember.quadrupleName;
      await deleteMemberAccountFromWorkspace(workspace, confirmDeleteMember);
      setConfirmDeleteMember(null);
      setFeedback({ type: 'ok', text: `تم حذف "${deletedName}" من المجمع بنجاح.` });
      await refreshWorkspace();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حذف العضو.',
      });
    } finally {
      setDeletingMember(false);
    }
  };

  const normalizeSearchText = (val: string): string =>
    val
      .trim()
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const normalizedQuery = normalizeSearchText(memberSearch);

  const filteredMemberList = visibleAccounts.filter((a) => {
    if (memberRoleFilter !== 'all' && a.role !== memberRoleFilter) {
      return false;
    }
    if (!normalizedQuery) return true;

    const mosqueText = (a.mosqueIds.length ? a.mosqueIds : [a.mosqueId])
      .map((id) => workspace.mosques.find((m) => m.id === id)?.name || '')
      .join(' ');
    const halaqaText = a.halaqaIds
      .map((id) => workspace.halaqat.find((h) => h.id === id)?.name || '')
      .join(' ');
    const haystack = normalizeSearchText(
      `${a.quadrupleName} ${a.email || ''} ${mosqueText} ${halaqaText}`
    );
    return haystack.includes(normalizedQuery);
  });

  const workspaceTabsList = supervisorMode
    ? [
        { id: 'accounts' as WorkspaceTab, label: 'الحسابات والأعضاء', icon: Users },
        { id: 'mosques' as WorkspaceTab, label: 'المساجد والحلقات', icon: Building2 },
        { id: 'quick_links' as WorkspaceTab, label: 'روابط الدخول السريع', icon: KeyRound },
      ]
    : [
        { id: 'stats' as WorkspaceTab, label: 'الإحصائيات', icon: BarChart3 },
        { id: 'accounts' as WorkspaceTab, label: 'الحسابات', icon: Users },
        { id: 'mosques' as WorkspaceTab, label: 'المساجد', icon: Building2 },
        { id: 'quick_links' as WorkspaceTab, label: 'روابط الدخول السريع', icon: KeyRound },
        { id: 'databases' as WorkspaceTab, label: 'قواعد البيانات', icon: Database },
      ];

  return (
    <div className="space-y-6">
      {/* Top Complex Header (Admin sees DB + Back button; Supervisor sees clean sub-tabs bar) */}
      {supervisorMode ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
              الحسابات والمساجد
            </h2>
            <p className="text-xs text-[#7D4E35]">
              إدارة روابط التسجيل، الأعضاء، المساجد والحلقات، وروابط الدخول السريع للمجمع.
            </p>
          </div>
          <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 bg-[#FDF6EE] p-1.5 rounded-2xl border border-[#EADBC8] overflow-x-auto no-scrollbar max-w-full w-full lg:w-auto">
            {workspaceTabsList.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`min-h-[42px] px-3 sm:px-4 py-2 rounded-xl font-display text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#F56900] text-white'
                      : 'text-[#7D4E35] hover:text-[#4A220D] hover:bg-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="duo-btn-cream min-h-[42px] px-3.5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <ArrowRight className="w-4 h-4" />
              <span>المجمعات</span>
            </button>
            <div className="flex flex-wrap items-center gap-2.5 min-w-0">
              <div className="min-w-0">
                <h2 className="font-display text-lg sm:text-2xl font-extrabold text-[#4A220D] truncate">
                  {workspace.complex?.name || discovered.name}
                </h2>
                <p className="text-xs font-medium text-[#7D4E35] truncate">
                  {discovered.ownerDbLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setTransferTarget({
                    scope: 'complex',
                    targetId: discovered.id,
                    targetName: workspace.complex?.name || discovered.name,
                    currentDbLabel: discovered.ownerDbLabel,
                  })
                }
                className="duo-btn-cream min-h-[38px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Database className="w-3.5 h-3.5 text-[#F56900]" />
                <span>تغيير قاعدة المجمع</span>
              </button>
            </div>
          </div>

          {/* Workspace Tabs */}
          <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 bg-[#FDF6EE] p-1.5 rounded-2xl border border-[#EADBC8] overflow-x-auto no-scrollbar max-w-full w-full lg:w-auto">
            {workspaceTabsList.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`min-h-[42px] px-3 sm:px-4 py-2 rounded-xl font-display text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#F56900] text-white'
                      : 'text-[#7D4E35] hover:text-[#4A220D] hover:bg-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {busyLabel && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4">
          <ModernLoader label={busyLabel} />
        </div>
      )}

      {feedback && (
        <div
          role="alert"
          className={`rounded-2xl border-2 px-4 py-3 text-sm font-bold flex items-center gap-2 ${
            feedback.type === 'ok'
              ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#46A302]'
              : 'bg-[#D95338]/10 border-[#D95338]/40 text-[#D95338]'
          }`}
        >
          {feedback.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* TAB 1: Complex Stats */}
      {tab === 'stats' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4">
            {[
              { label: 'المساجد', val: workspace.mosques.length },
              { label: 'الحلقات', val: workspace.halaqat.length },
              { label: 'المشرفين', val: supervisors.length },
              { label: 'المعلمين', val: teachers.length },
              { label: 'الطلاب', val: students.length },
            ].map((s) => (
              <div
                key={s.label}
                className="bg-white border-2 border-[#EADBC8] rounded-2xl p-4 text-center"
              >
                <p className="font-display text-2xl sm:text-3xl font-extrabold text-[#F56900] tabular-nums">
                  {s.val}
                </p>
                <p className="text-xs sm:text-sm font-bold text-[#7D4E35] mt-1">
                  {s.label}
                </p>
              </div>
            ))}
          </div>

          <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6">
            <h3 className="font-display text-lg font-extrabold text-[#4A220D] mb-4">
              تفاصيل المساجد والحلقات داخل المجمع
            </h3>
            {workspace.mosques.length === 0 ? (
              <p className="text-sm text-[#7D4E35]">لا توجد مساجد مضافة لهذا المجمع بعد.</p>
            ) : (
              <>
                {/* Mobile Cards View */}
                <div className="md:hidden space-y-3">
                  {workspace.mosques.map((m) => {
                    const mHalaqat = workspace.halaqat.filter((h) => h.mosqueId === m.id);
                    const mSups = supervisors.filter(
                      (a) => a.mosqueId === m.id || a.mosqueIds.includes(m.id)
                    );
                    const mTeachers = teachers.filter((a) => a.mosqueId === m.id);
                    const mStudents = students.filter((a) => a.mosqueId === m.id);
                    return (
                      <div
                        key={`mob_mosque_${m.id}`}
                        className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-3.5 space-y-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-display font-extrabold text-sm text-[#4A220D]">
                            {m.name}
                          </span>
                          {m.usesExternalDb && (
                            <span className="text-[11px] font-bold text-[#F56900] bg-white border border-[#EADBC8] px-2 py-0.5 rounded-lg">
                              قاعدة مستقلة
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
                          <div className="bg-white border border-[#EADBC8] rounded-xl py-1.5 px-1">
                            <p className="font-display font-extrabold text-[#F56900] tabular-nums">{mHalaqat.length}</p>
                            <p className="text-[10px] font-bold text-[#7D4E35]">الحلقات</p>
                          </div>
                          <div className="bg-white border border-[#EADBC8] rounded-xl py-1.5 px-1">
                            <p className="font-display font-extrabold text-[#4A220D] tabular-nums">{mSups.length}</p>
                            <p className="text-[10px] font-bold text-[#7D4E35]">المشرفين</p>
                          </div>
                          <div className="bg-white border border-[#EADBC8] rounded-xl py-1.5 px-1">
                            <p className="font-display font-extrabold text-[#46A302] tabular-nums">{mTeachers.length}</p>
                            <p className="text-[10px] font-bold text-[#7D4E35]">المعلمين</p>
                          </div>
                          <div className="bg-white border border-[#EADBC8] rounded-xl py-1.5 px-1">
                            <p className="font-display font-extrabold text-[#4A220D] tabular-nums">{mStudents.length}</p>
                            <p className="text-[10px] font-bold text-[#7D4E35]">الطلاب</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Desktop Table View */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-right text-sm">
                    <thead>
                      <tr className="border-b-2 border-[#F7EBDD] text-[#7D4E35]">
                        <th className="py-2.5 px-3 font-display font-bold">المسجد</th>
                        <th className="py-2.5 px-3 font-display font-bold">الحلقات</th>
                        <th className="py-2.5 px-3 font-display font-bold">المشرفين</th>
                        <th className="py-2.5 px-3 font-display font-bold">المعلمين</th>
                        <th className="py-2.5 px-3 font-display font-bold">الطلاب</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workspace.mosques.map((m) => {
                        const mHalaqat = workspace.halaqat.filter((h) => h.mosqueId === m.id);
                        const mSups = supervisors.filter(
                          (a) => a.mosqueId === m.id || a.mosqueIds.includes(m.id)
                        );
                        const mTeachers = teachers.filter((a) => a.mosqueId === m.id);
                        const mStudents = students.filter((a) => a.mosqueId === m.id);
                        return (
                          <tr key={m.id} className="border-b border-[#F7EBDD] last:border-b-0">
                            <td className="py-3 px-3 font-bold text-[#4A220D]">
                              {m.name}
                              {m.usesExternalDb && (
                                <span className="text-xs text-[#F56900] mr-2">· قاعدة مستقلة</span>
                              )}
                            </td>
                            <td className="py-3 px-3 tabular-nums">{mHalaqat.length}</td>
                            <td className="py-3 px-3 tabular-nums">{mSups.length}</td>
                            <td className="py-3 px-3 tabular-nums">{mTeachers.length}</td>
                            <td className="py-3 px-3 tabular-nums">{mStudents.length}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Accounts (Invite Links & Members List) */}
      {tab === 'accounts' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2 bg-white p-2 rounded-2xl border-2 border-[#EADBC8]">
            {[
              { id: 'invites' as AccountSubTab, label: 'روابط التسجيل', icon: Link2 },
              { id: 'list' as AccountSubTab, label: `الأعضاء (${workspace.accounts.length})`, icon: Users },
            ].map((st) => {
              const Icon = st.icon;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setAccountSubTab(st.id)}
                  className={`min-h-[42px] px-3.5 py-2 rounded-xl font-display text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                    accountSubTab === st.id
                      ? 'bg-[#4A220D] text-white'
                      : 'text-[#7D4E35] hover:bg-[#FDF6EE]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{st.label}</span>
                </button>
              );
            })}
          </div>

          {accountSubTab === 'invites' && (
            <div className="space-y-6">
              <form
                onSubmit={handleSaveInviteLink}
                className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                    {editingInviteToken ? 'تعديل رابط التسجيل' : 'إنشاء رابط تسجيل جديد'}
                  </h3>
                  {editingInviteToken && (
                    <button
                      type="button"
                      onClick={resetInviteForm}
                      className="text-xs font-bold text-[#D95338] cursor-pointer"
                    >
                      إلغاء التعديل
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      عنوان الرابط (تظهر عند تسجيل الدخول)
                    </label>
                    <input
                      type="text"
                      value={inviteTitle}
                      onChange={(e) => setInviteTitle(e.target.value)}
                      placeholder="مثال: تسجيل طلاب حلقة الفجر"
                      required
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      الفئة المستهدفة
                    </label>
                    <select
                      value={inviteTargetRole}
                      onChange={(e) => {
                        setInviteTargetRole(e.target.value as TargetRoleOption);
                        setInviteHalaqaIds([]);
                        setInviteMosqueIds([]);
                      }}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                    >
                      <option value="student">طلاب</option>
                      <option value="teacher">معلمين</option>
                      <option value="supervisor">مشرف مسجد</option>
                      {!allowedMosqueSet && (
                        <option value="complex_supervisor">مشرف المجمع بالكامل</option>
                      )}
                    </select>
                  </div>
                </div>

                {inviteTargetRole === 'complex_supervisor' ? (
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-4 text-xs sm:text-sm text-[#4A220D] font-medium">
                    يمنح هذا الرابط المسجِّل صلاحية <strong>مشرف المجمع بالكامل</strong> (جميع المساجد والحلقات) بمجرد إدخال اسمه الرباعي وتسجيل الدخول بحساب جوجل.
                  </div>
                ) : inviteTargetRole === 'supervisor' ? (
                  <div>
                    <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                      حدد المسجد أو المساجد لهذا المشرف:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {visibleMosques.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() =>
                            setInviteMosqueIds((prev) => toggleArrayItem(prev, m.id))
                          }
                          className={`min-h-[40px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                            inviteMosqueIds.includes(m.id)
                              ? 'bg-[#F56900] border-[#C95200] text-white'
                              : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                          }`}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                        المسجد
                      </label>
                      <select
                        value={inviteMosqueId}
                        onChange={(e) => {
                          setInviteMosqueId(e.target.value);
                          setInviteHalaqaIds([]);
                        }}
                        className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                      >
                        {visibleMosques.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                        {inviteTargetRole === 'teacher'
                          ? 'حدد حلقة أو حلقات المعلم:'
                          : 'حدد حلقة الطالب:'}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {inviteMosqueHalaqat.map((h) => (
                          <button
                            key={h.id}
                            type="button"
                            onClick={() =>
                              setInviteHalaqaIds((prev) =>
                                inviteTargetRole === 'teacher' ? toggleArrayItem(prev, h.id) : [h.id]
                              )
                            }
                            className={`min-h-[40px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                              inviteHalaqaIds.includes(h.id)
                                ? 'bg-[#F56900] border-[#C95200] text-white'
                                : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                            }`}
                          >
                            {h.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      وقت البداية (اختياري)
                    </label>
                    <input
                      type="datetime-local"
                      value={inviteStartsAt}
                      onChange={(e) => setInviteStartsAt(e.target.value)}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      وقت النهاية (يُقفل الرابط بعده نهائياً)
                    </label>
                    <input
                      type="datetime-local"
                      value={inviteEndsAt}
                      onChange={(e) => setInviteEndsAt(e.target.value)}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                    />
                  </div>
                </div>

                <label className="inline-flex items-center gap-2 text-xs sm:text-sm font-bold text-[#4A220D] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={inviteActive}
                    onChange={(e) => setInviteActive(e.target.checked)}
                    className="w-4 h-4 accent-[#F56900]"
                  />
                  <span>الرابط مفتوح ومفعل للتسجيل</span>
                </label>

                {!supervisorMode && (
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl px-4 py-2.5 text-xs font-bold text-[#4A220D] flex flex-wrap items-center gap-2">
                    <Database className="w-4 h-4 text-[#F56900] shrink-0" />
                    <span>
                      القاعدة المرتبطة بتسجيل الدخول وحفظ الحسابات لهذا الرابط:{' '}
                      <strong className="text-[#46A302]">
                        {getInviteTargetDbLabel(
                          inviteTargetRole === 'complex_supervisor'
                            ? ''
                            : inviteTargetRole === 'supervisor'
                            ? inviteMosqueIds[0] || ''
                            : inviteMosqueId,
                          inviteTargetRole === 'complex_supervisor' || inviteTargetRole === 'supervisor'
                            ? []
                            : inviteHalaqaIds
                        )}
                      </strong>
                    </span>
                  </div>
                )}

                <div>
                  <button
                    type="submit"
                    className="duo-btn-orange min-h-[48px] px-6 py-2.5 rounded-2xl font-display font-extrabold text-sm cursor-pointer"
                  >
                    {editingInviteToken ? 'حفظ تعديل الرابط' : 'إنشاء رابط التسجيل'}
                  </button>
                </div>
              </form>

              {/* Saved Invite Links */}
              <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-3">
                <h4 className="font-display text-base font-extrabold text-[#4A220D]">
                  روابط التسجيل المنشأة ({visibleInvites.length})
                </h4>
                {visibleInvites.length === 0 ? (
                  <p className="text-sm text-[#7D4E35]">لم يتم إنشاء روابط تسجيل بعد.</p>
                ) : (
                  <div className="space-y-3">
                    {visibleInvites.map((lnk) => {
                      const now = Date.now();
                      const expired = lnk.endsAtMs > 0 && now > lnk.endsAtMs;
                      const notStarted = lnk.startsAtMs > 0 && now < lnk.startsAtMs;
                      const stateText = !lnk.active
                        ? 'مغلق'
                        : expired
                        ? 'منتهي الصلاحية'
                        : notStarted
                        ? 'لم يبدأ بعد'
                        : 'نشط';

                      return (
                        <div
                          key={lnk.token}
                          className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="space-y-1">
                            <p className="font-display font-extrabold text-sm text-[#4A220D]">
                              {lnk.title}
                            </p>
                            <p className="text-xs text-[#7D4E35]">
                              {getRoleDisplayLabel(lnk)} · الحالة: <strong className="text-[#F56900]">{stateText}</strong>
                            </p>
                            {!supervisorMode && (
                              <p className="text-[11px] font-bold text-[#46A302]">
                                قاعدة الحفظ والدخول: {getInviteTargetDbLabel(lnk.mosqueId, lnk.halaqaIds)}
                              </p>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleCopyInviteUrl(lnk)}
                              className={`min-h-[40px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                                copiedId === `inv_${lnk.token}`
                                  ? 'duo-btn-green'
                                  : 'duo-btn-cream'
                              }`}
                            >
                              {copiedId === `inv_${lnk.token}` ? (
                                <>
                                  <Check className="w-3.5 h-3.5" />
                                  <span>تم النسخ بنجاح</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5 text-[#F56900]" />
                                  <span>نسخ الرابط</span>
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleInviteActive(lnk)}
                              className={`min-h-[40px] px-3 py-1.5 rounded-xl border text-xs font-bold inline-flex items-center gap-1 cursor-pointer ${
                                lnk.active
                                  ? 'border-[#EADBC8] bg-white text-[#7D4E35] hover:bg-[#FDF6EE]'
                                  : 'border-[#58CC02] bg-[#58CC02]/10 text-[#46A302]'
                              }`}
                            >
                              {lnk.active ? (
                                <>
                                  <Lock className="w-3.5 h-3.5" />
                                  <span>إغلاق</span>
                                </>
                              ) : (
                                <>
                                  <Unlock className="w-3.5 h-3.5" />
                                  <span>فتح الرابط</span>
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleEditInviteLink(lnk)}
                              className="min-h-[40px] px-3 py-1.5 rounded-xl border border-[#EADBC8] bg-white text-xs font-bold text-[#4A220D] inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>تعديل</span>
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                await deleteInviteLinkFromWorkspace(workspace, lnk);
                                await refreshWorkspace();
                              }}
                              aria-label="حذف الرابط"
                              className="min-h-[40px] px-2.5 rounded-xl text-[#D95338] hover:bg-[#D95338]/10 cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {accountSubTab === 'list' && (
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                    أعضاء المجمع ({filteredMemberList.length} من {visibleAccounts.length})
                  </h3>
                  <p className="text-xs text-[#7D4E35]">
                    ابحث بالاسم أو البريد أو الحلقة، أو عدّل/احذف العضو أو انسخ رابط الدخول السريع الخاص به.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
                  <div className="relative flex-1 sm:flex-initial sm:w-72">
                    <Search className="w-4 h-4 text-[#7D4E35] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="بحث بالاسم أو البريد أو الحلقة..."
                      className="w-full min-h-[42px] pr-10 pl-8 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm focus:outline-none focus:border-[#F56900] focus:bg-white"
                    />
                    {memberSearch && (
                      <button
                        type="button"
                        onClick={() => setMemberSearch('')}
                        aria-label="مسح البحث"
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7D4E35] hover:text-[#4A220D] cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <select
                    value={memberRoleFilter}
                    onChange={(e) =>
                      setMemberRoleFilter(
                        e.target.value as 'all' | 'student' | 'teacher' | 'supervisor'
                      )
                    }
                    aria-label="تصفية حسب الفئة"
                    className="min-h-[42px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
                  >
                    <option value="all">كل الأعضاء</option>
                    <option value="student">الطلاب فقط</option>
                    <option value="teacher">المعلمين فقط</option>
                    <option value="supervisor">المشرفين فقط</option>
                  </select>
                </div>
              </div>

              {filteredMemberList.length === 0 ? (
                <p className="text-sm text-[#7D4E35] py-4 text-center">
                  لا توجد حسابات مطابقة للبحث أو التصفية المحددة.
                </p>
              ) : (
                <>
                  {/* Mobile Cards View */}
                  <div className="md:hidden space-y-3">
                    {filteredMemberList.map((acc) => {
                      const mNames = (acc.mosqueIds.length ? acc.mosqueIds : [acc.mosqueId])
                        .map((id) => workspace.mosques.find((m) => m.id === id)?.name)
                        .filter(Boolean)
                        .join('، ');
                      const hNames = acc.halaqaIds
                        .map((id) => workspace.halaqat.find((h) => h.id === id)?.name)
                        .filter(Boolean)
                        .join('، ');
                      const isQuickCopied = copiedId === `qk_${acc.id}`;
                      const mosqueDisplay =
                        acc.role === 'supervisor' && !acc.mosqueId && acc.mosqueIds.length === 0
                          ? 'جميع المساجد'
                          : mNames || '—';

                      return (
                        <div
                          key={`mob_mem_${acc.id}`}
                          className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-3.5 space-y-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-display font-extrabold text-sm text-[#4A220D] truncate">
                                {acc.quadrupleName}
                              </p>
                              {acc.email && (
                                <p className="text-[11px] text-[#7D4E35] truncate" dir="ltr">
                                  {acc.email}
                                </p>
                              )}
                            </div>
                            <span className="px-2.5 py-0.5 rounded-lg bg-[#F56900]/12 text-[#F56900] text-[11px] font-extrabold shrink-0">
                              {getRoleDisplayLabel(acc)}
                            </span>
                          </div>

                          <div className="text-xs text-[#7D4E35] space-y-0.5">
                            <p>
                              <strong className="text-[#4A220D]">المسجد:</strong> {mosqueDisplay}
                            </p>
                            {hNames && (
                              <p>
                                <strong className="text-[#4A220D]">الحلقات:</strong> {hNames}
                              </p>
                            )}
                          </div>

                          {acc.role === 'platform_admin' ? (
                            <p className="text-xs font-bold text-[#7D4E35]">حساب المنصة الأساسي</p>
                          ) : (
                            <div className="grid grid-cols-2 gap-1.5 pt-1">
                              <button
                                type="button"
                                onClick={() => handleCopyQuickUrl(acc)}
                                className={`col-span-2 min-h-[40px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                                  isQuickCopied ? 'duo-btn-green' : 'duo-btn-orange'
                                }`}
                              >
                                {isQuickCopied ? (
                                  <>
                                    <Check className="w-3.5 h-3.5" />
                                    <span>تم النسخ بنجاح</span>
                                  </>
                                ) : (
                                  <>
                                    <KeyRound className="w-3.5 h-3.5" />
                                    <span>نسخ رابط الدخول السريع</span>
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => openEditMemberModal(acc)}
                                className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#4A220D] inline-flex items-center justify-center gap-1 cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5 text-[#F56900]" />
                                <span>تعديل</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setConfirmDeleteMember(acc)}
                                className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] text-xs font-bold text-[#D95338] inline-flex items-center justify-center gap-1 cursor-pointer"
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

                  {/* Desktop Table View */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-right text-sm">
                      <thead>
                        <tr className="border-b-2 border-[#F7EBDD] text-[#7D4E35]">
                          <th className="py-2.5 px-3 font-display font-bold">الاسم الرباعي</th>
                          <th className="py-2.5 px-3 font-display font-bold">الرتبة</th>
                          <th className="py-2.5 px-3 font-display font-bold">المسجد</th>
                          <th className="py-2.5 px-3 font-display font-bold">الحلقات</th>
                          <th className="py-2.5 px-3 font-display font-bold">الإجراءات ورابط الدخول</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMemberList.map((acc) => {
                          const mNames = (acc.mosqueIds.length ? acc.mosqueIds : [acc.mosqueId])
                            .map((id) => workspace.mosques.find((m) => m.id === id)?.name)
                            .filter(Boolean)
                            .join('، ');
                          const hNames = acc.halaqaIds
                            .map((id) => workspace.halaqat.find((h) => h.id === id)?.name)
                            .filter(Boolean)
                            .join('، ');
                          const isQuickCopied = copiedId === `qk_${acc.id}`;
                          return (
                            <tr key={acc.id} className="border-b border-[#F7EBDD] last:border-b-0">
                              <td className="py-3 px-3">
                                <p className="font-bold text-[#4A220D]">{acc.quadrupleName}</p>
                                {acc.email && (
                                  <p className="text-[11px] text-[#7D4E35]" dir="ltr">
                                    {acc.email}
                                  </p>
                                )}
                              </td>
                              <td className="py-3 px-3 text-[#F56900] font-bold whitespace-nowrap">
                                {getRoleDisplayLabel(acc)}
                              </td>
                              <td className="py-3 px-3 text-[#7D4E35]">
                                {acc.role === 'supervisor' && !acc.mosqueId && acc.mosqueIds.length === 0
                                  ? 'جميع المساجد'
                                  : mNames || '—'}
                              </td>
                              <td className="py-3 px-3 text-[#7D4E35]">{hNames || '—'}</td>
                              <td className="py-3 px-3">
                                {acc.role === 'platform_admin' ? (
                                  <span className="text-xs font-bold text-[#7D4E35]">حساب المنصة الأساسي</span>
                                ) : (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => handleCopyQuickUrl(acc)}
                                      className={`min-h-[38px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors ${
                                        isQuickCopied ? 'duo-btn-green' : 'duo-btn-orange'
                                      }`}
                                    >
                                      {isQuickCopied ? (
                                        <>
                                          <Check className="w-3.5 h-3.5" />
                                          <span>تم النسخ بنجاح</span>
                                        </>
                                      ) : (
                                        <>
                                          <KeyRound className="w-3.5 h-3.5" />
                                          <span>نسخ الدخول السريع</span>
                                        </>
                                      )}
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => openEditMemberModal(acc)}
                                      aria-label={`تعديل ${acc.quadrupleName}`}
                                      className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                    >
                                      <Edit3 className="w-3.5 h-3.5 text-[#F56900]" />
                                      <span>تعديل</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteMember(acc)}
                                      aria-label={`حذف ${acc.quadrupleName}`}
                                      className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] bg-white hover:border-[#D95338] hover:bg-[#D95338]/10 text-xs font-bold text-[#D95338] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                      <span>حذف</span>
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
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Mosques, Halaqat, Supervisors & Full Transfers */}
      {tab === 'mosques' && (
        <div className="space-y-6">
          {/* Add Mosque Bar (only when not restricted to specific mosques) */}
          {!allowedMosqueSet && (
            <form
              onSubmit={handleAddMosque}
              className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
            >
              <input
                type="text"
                value={newMosqueName}
                onChange={(e) => setNewMosqueName(e.target.value)}
                placeholder="اسم مسجد جديد لإضافته للمجمع..."
                className="flex-1 min-h-[46px] px-4 py-2 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
              />
              <button
                type="submit"
                className="duo-btn-orange min-h-[46px] px-5 rounded-2xl font-display font-bold text-sm inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة مسجد</span>
              </button>
            </form>
          )}

          {/* Mosques Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {visibleMosques.map((m) => {
              const mHalaqat = visibleHalaqat.filter((h) => h.mosqueId === m.id);
              const mSups = supervisors.filter(
                (a) => a.mosqueId === m.id || a.mosqueIds.includes(m.id)
              );

              return (
                <div
                  key={m.id}
                  className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 space-y-4"
                >
                  <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#F7EBDD]">
                    {renamingMosqueId === m.id ? (
                      <div className="flex-1 flex items-center gap-2">
                        <input
                          type="text"
                          value={renamingMosqueVal}
                          onChange={(e) => setRenamingMosqueVal(e.target.value)}
                          className="flex-1 min-h-[40px] px-3 rounded-xl border-2 border-[#F56900] text-sm"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            await addOrRenameMosqueInWorkspace({
                              workspace,
                              mosqueId: m.id,
                              name: renamingMosqueVal,
                            });
                            setRenamingMosqueId(null);
                            await refreshWorkspace();
                          }}
                          className="duo-btn-green min-h-[40px] px-3 rounded-xl text-xs font-bold cursor-pointer"
                        >
                          حفظ
                        </button>
                      </div>
                    ) : (
                      <>
                        <div>
                          <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                            {m.name}
                          </h3>
                          <p className="text-xs text-[#7D4E35]">
                            المشرفون: {mSups.map((s) => s.quadrupleName).join('، ') || 'غير معيّن'}
                          </p>
                          {!supervisorMode && (
                            <p className="text-[11px] font-bold text-[#F56900] mt-0.5">
                              القاعدة:{' '}
                              {workspace.mosqueConfigMap[m.id]
                                ? getDbDisplayLabel(workspace.mosqueConfigMap[m.id]!)
                                : discovered.ownerDbLabel}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {!supervisorMode && (
                            <button
                              type="button"
                              onClick={() =>
                                setTransferTarget({
                                  scope: 'mosque',
                                  targetId: m.id,
                                  targetName: m.name,
                                  currentDbLabel: workspace.mosqueConfigMap[m.id]
                                    ? getDbDisplayLabel(workspace.mosqueConfigMap[m.id]!)
                                    : discovered.ownerDbLabel,
                                })
                              }
                              className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Database className="w-3.5 h-3.5 text-[#F56900]" />
                              <span>القاعدة</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingMosqueId(m.id);
                              setRenamingMosqueVal(m.name);
                            }}
                            className="min-h-[38px] px-3 py-1.5 rounded-xl border border-[#EADBC8] text-xs font-bold text-[#7D4E35] hover:text-[#4A220D] inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>تعديل</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Halaqat inside Mosque */}
                  <div className="space-y-2">
                    <p className="font-display text-xs font-bold text-[#7D4E35]">
                      الحلقات ({mHalaqat.length})
                    </p>
                    {mHalaqat.map((h) => {
                      const hConf = workspace.halaqaConfigMap[h.id];
                      const mConf = workspace.mosqueConfigMap[m.id];
                      const hDbLabel = hConf
                        ? getDbDisplayLabel(hConf)
                        : mConf
                        ? getDbDisplayLabel(mConf)
                        : discovered.ownerDbLabel;
                      const hDbDiffersFromMosque =
                        (workspace.halaqaDbMap[h.id] || null) !==
                        (workspace.mosqueDbMap[m.id] || workspace.complexDb);

                      return (
                        <div
                          key={h.id}
                          className="bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                        >
                          {renamingHalaqaId === h.id ? (
                            <div className="flex-1 flex items-center gap-2">
                              <input
                                type="text"
                                value={renamingHalaqaVal}
                                onChange={(e) => setRenamingHalaqaVal(e.target.value)}
                                className="flex-1 min-h-[36px] px-2.5 rounded-lg border border-[#F56900] bg-white text-xs"
                              />
                              <button
                                type="button"
                                onClick={async () => {
                                  await addOrRenameHalaqaInWorkspace({
                                    workspace,
                                    halaqaId: h.id,
                                    mosqueId: m.id,
                                    name: renamingHalaqaVal,
                                  });
                                  setRenamingHalaqaId(null);
                                  await refreshWorkspace();
                                }}
                                className="duo-btn-green px-3 py-1 rounded-lg text-xs font-bold cursor-pointer"
                              >
                                حفظ
                              </button>
                            </div>
                          ) : (
                            <>
                              <div>
                                <span className="font-bold text-sm text-[#4A220D]">
                                  {h.name}
                                </span>
                                {!supervisorMode && hDbDiffersFromMosque && (
                                  <span className="block text-[11px] font-bold text-[#46A302]">
                                    قاعدة مستقلة: {hDbLabel}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {!supervisorMode && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setTransferTarget({
                                        scope: 'halaqa',
                                        targetId: h.id,
                                        targetName: h.name,
                                        currentDbLabel: hDbLabel,
                                      })
                                    }
                                    className="min-h-[32px] px-2.5 py-1 rounded-lg border border-[#EADBC8] bg-white hover:border-[#F56900] text-[11px] font-bold text-[#4A220D] inline-flex items-center gap-1 cursor-pointer"
                                  >
                                    <Database className="w-3 h-3 text-[#F56900]" />
                                    <span>تغيير القاعدة</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRenamingHalaqaId(h.id);
                                    setRenamingHalaqaVal(h.name);
                                  }}
                                  className="text-xs font-bold text-[#F56900] hover:underline cursor-pointer"
                                >
                                  تعديل الاسم
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}

                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={newHalaqaNames[m.id] || ''}
                        onChange={(e) =>
                          setNewHalaqaNames((prev) => ({
                            ...prev,
                            [m.id]: e.target.value,
                          }))
                        }
                        placeholder="اسم حلقة جديدة..."
                        className="flex-1 min-h-[40px] px-3 rounded-xl border border-[#EADBC8] bg-white text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddHalaqa(m.id)}
                        className="duo-btn-cream min-h-[40px] px-3 rounded-xl text-xs font-bold cursor-pointer whitespace-nowrap"
                      >
                        + حلقة
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Transfer Tools: Entire Halaqa + Teachers/Students/Supervisors */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Transfer Entire Halaqa */}
            <form
              onSubmit={handleTransferHalaqa}
              className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
            >
              <div className="flex items-center gap-2">
                <ArrowRightLeft className="w-5 h-5 text-[#F56900]" />
                <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                  نقل حلقة كاملة (بمعلميها وطلابها)
                </h3>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#7D4E35] mb-1">
                  اختر الحلقة المراد نقلها
                </label>
                <select
                  value={transferHalaqaId}
                  onChange={(e) => setTransferHalaqaId(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                >
                  <option value="">-- اختر الحلقة --</option>
                  {visibleHalaqat.map((h: HalaqaRecord) => {
                    const srcMosque = workspace.mosques.find((m) => m.id === h.mosqueId);
                    return (
                      <option key={h.id} value={h.id}>
                        {h.name} ({srcMosque?.name || 'مسجد'})
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#7D4E35] mb-1">
                  نقل إلى مسجد:
                </label>
                <select
                  value={transferHalaqaDestMosqueId}
                  onChange={(e) => setTransferHalaqaDestMosqueId(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                >
                  <option value="">-- اختر المسجد الهدف --</option>
                  {visibleMosques.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={!transferHalaqaId || !transferHalaqaDestMosqueId}
                className="duo-btn-orange w-full min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-50"
              >
                تنفيذ نقل الحلقة الكاملة
              </button>
            </form>

            {/* Transfer Member (Supervisor / Teacher / Student) */}
            <form
              onSubmit={handleTransferAccount}
              className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
            >
              <div className="flex items-center gap-2">
                <ArrowRightLeft className="w-5 h-5 text-[#F56900]" />
                <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                  نقل مشرف أو معلم أو طالب
                </h3>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#7D4E35] mb-1">
                  اختر العضو
                </label>
                <select
                  value={transferAccId}
                  onChange={(e) => {
                    const acc = visibleAccounts.find((a) => a.id === e.target.value);
                    setTransferAccId(e.target.value);
                    if (acc) {
                      setTransferAccMosqueId(acc.mosqueId);
                      setTransferAccMosqueIds(acc.mosqueIds);
                      setTransferAccHalaqaIds(acc.halaqaIds);
                    }
                  }}
                  className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                >
                  <option value="">-- اختر مشرف / معلم / طالب --</option>
                  {visibleAccounts
                    .filter((a) => a.role !== 'platform_admin')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.quadrupleName} ({getRoleDisplayLabel(a)})
                      </option>
                    ))}
                </select>
              </div>

              {selectedTransferAccount && (
                <>
                  {selectedTransferAccount.role === 'supervisor' ? (
                    <div>
                      <p className="text-xs font-bold text-[#7D4E35] mb-2">
                        المساجد التي يشرف عليها (اتركها فارغة لإشراف المجمع بالكامل):
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {visibleMosques.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setTransferAccMosqueIds((prev) => toggleArrayItem(prev, m.id))
                            }
                            className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                              transferAccMosqueIds.includes(m.id)
                                ? 'bg-[#F56900] border-[#C95200] text-white'
                                : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                            }`}
                          >
                            {m.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs font-bold text-[#7D4E35] mb-1">
                          المسجد الجديد
                        </label>
                        <select
                          value={transferAccMosqueId}
                          onChange={(e) => {
                            setTransferAccMosqueId(e.target.value);
                            setTransferAccHalaqaIds([]);
                          }}
                          className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                        >
                          {visibleMosques.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <p className="text-xs font-bold text-[#7D4E35] mb-2">
                          الحلقات الجديدة:
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {visibleHalaqat
                            .filter((h) => h.mosqueId === transferAccMosqueId)
                            .map((h) => (
                              <button
                                key={h.id}
                                type="button"
                                onClick={() =>
                                  setTransferAccHalaqaIds((prev) =>
                                    selectedTransferAccount.role === 'teacher'
                                      ? toggleArrayItem(prev, h.id)
                                      : [h.id]
                                  )
                                }
                                className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                                  transferAccHalaqaIds.includes(h.id)
                                    ? 'bg-[#F56900] border-[#C95200] text-white'
                                    : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                                }`}
                              >
                                {h.name}
                              </button>
                            ))}
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              <button
                type="submit"
                disabled={!selectedTransferAccount}
                className="duo-btn-orange w-full min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-50"
              >
                حفظ النقل والتعيين
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB 4: Quick Login Links */}
      {tab === 'quick_links' && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-5">
          <div>
            <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
              روابط الدخول السريع
            </h3>
            <p className="text-xs sm:text-sm text-[#7D4E35]">
              حدّد الفئة والمسجد والحلقة وانسخ رابط الدخول المباشر ليدخل المشرف أو المعلم أو الطالب مباشرة لحسابه.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#7D4E35] mb-1">الفئة</label>
              <select
                value={quickRoleFilter}
                onChange={(e) =>
                  setQuickRoleFilter(
                    e.target.value as 'all' | 'supervisor' | 'teacher' | 'student'
                  )
                }
                className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
              >
                <option value="all">الجميع</option>
                <option value="supervisor">المشرفين فقط</option>
                <option value="teacher">المعلمين فقط</option>
                <option value="student">الطلاب فقط</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#7D4E35] mb-1">المسجد</label>
              <select
                value={quickMosqueFilter}
                onChange={(e) => {
                  setQuickMosqueFilter(e.target.value);
                  setQuickHalaqaFilter('all');
                }}
                className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
              >
                <option value="all">كل المساجد</option>
                {visibleMosques.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#7D4E35] mb-1">الحلقة</label>
              <select
                value={quickHalaqaFilter}
                onChange={(e) => setQuickHalaqaFilter(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
              >
                <option value="all">كل الحلقات</option>
                {visibleHalaqat
                  .filter(
                    (h) => quickMosqueFilter === 'all' || h.mosqueId === quickMosqueFilter
                  )
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {quickFilteredAccounts.length === 0 ? (
            <p className="text-sm text-[#7D4E35] py-4">لا توجد حسابات مطابقة للتصفية المحددة.</p>
          ) : (
            <div className="space-y-3">
              {quickFilteredAccounts.map((acc) => {
                const mName = workspace.mosques.find((m) => m.id === acc.mosqueId)?.name || '';
                const hNames = acc.halaqaIds
                  .map((id) => workspace.halaqat.find((h) => h.id === id)?.name)
                  .filter(Boolean)
                  .join('، ');

                return (
                  <div
                    key={acc.id}
                    className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
                      <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D]">
                        {acc.quadrupleName}
                      </p>
                      <p className="text-xs text-[#7D4E35]">
                        {getRoleDisplayLabel(acc)}
                        {mName ? ` · ${mName}` : ''}
                        {hNames ? ` · ${hNames}` : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleCopyQuickUrl(acc)}
                      className={`min-h-[44px] px-4 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap transition-colors ${
                        copiedId === `qk_${acc.id}` ? 'duo-btn-green' : 'duo-btn-orange'
                      }`}
                    >
                      {copiedId === `qk_${acc.id}` ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>تم النسخ بنجاح</span>
                        </>
                      ) : (
                        <>
                          <KeyRound className="w-4 h-4" />
                          <span>نسخ رابط الدخول السريع</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 5: COMPLEX & PER-TAB DATABASES (ADMIN ONLY) ==================== */}
      {!supervisorMode && tab === 'databases' && (
        <ComplexDatabasesTab
          workspace={workspace}
          connectedDbs={connectedDbs}
          onOpenComplexDbTransferModal={() =>
            setTransferTarget({
              scope: 'complex',
              targetId: discovered.id,
              targetName: workspace.complex?.name || discovered.name,
              currentDbLabel: discovered.ownerDbLabel,
            })
          }
          onWorkspaceUpdated={refreshWorkspace}
        />
      )}

      {!supervisorMode && transferTarget && (
        <DatabaseTransferModal
          workspace={workspace}
          scope={transferTarget.scope}
          targetId={transferTarget.targetId}
          targetName={transferTarget.targetName}
          currentDbLabel={transferTarget.currentDbLabel}
          connectedDbs={connectedDbs}
          onClose={() => setTransferTarget(null)}
          onCompleted={async () => {
            const finishedScope = transferTarget.scope;
            setTransferTarget(null);
            if (finishedScope === 'complex') {
              await onComplexRelocated(discovered.id);
            } else {
              await refreshWorkspace();
            }
            setFeedback({
              type: 'ok',
              text: 'تم تغيير قاعدة البيانات وتنفيذ الإجراء المحدد بنجاح.',
            });
          }}
        />
      )}
      {editingMember &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleSaveMemberEdit}
              className="w-full sm:max-w-lg bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 pb-safe space-y-4 shadow-xl max-h-[92dvh] overflow-y-auto"
              dir="rtl"
            >
              <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#F7EBDD]">
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  تعديل بيانات العضو
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingMember(null)}
                  aria-label="إغلاق"
                  className="p-1.5 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="font-display text-xs font-bold text-[#4A220D]">
                    الاسم الرباعي (إلزامي)
                  </label>
                  <span className="text-xs font-bold text-[#7D4E35] tabular-nums">
                    {validateQuadrupleArabicName(editMemberName).wordCount} / ٤ مقاطع
                  </span>
                </div>
                <input
                  type="text"
                  value={editMemberName}
                  onChange={(e) => {
                    setEditMemberName(e.target.value);
                    if (editMemberError) setEditMemberError(null);
                  }}
                  placeholder="الاسم الأول اسم الأب اسم الجد العائلة"
                  maxLength={100}
                  required
                  className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm font-medium focus:outline-none focus:border-[#F56900] focus:bg-white"
                />
              </div>

              <div>
                <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                  الصفة
                </label>
                <select
                  value={editMemberTargetRole}
                  onChange={(e) => {
                    const nextRole = e.target.value as TargetRoleOption;
                    setEditMemberTargetRole(nextRole);
                    if (nextRole === 'complex_supervisor') {
                      setEditMemberHalaqaIds([]);
                      setEditMemberMosqueIds([]);
                    } else if (nextRole === 'supervisor') {
                      setEditMemberHalaqaIds([]);
                      if (editMemberMosqueIds.length === 0 && editMemberMosqueId) {
                        setEditMemberMosqueIds([editMemberMosqueId]);
                      }
                    } else if (!editMemberMosqueId && editMemberMosqueIds[0]) {
                      setEditMemberMosqueId(editMemberMosqueIds[0]);
                    }
                  }}
                  className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                >
                  <option value="student">طالب</option>
                  <option value="teacher">معلم</option>
                  <option value="supervisor">مشرف مسجد</option>
                  {!allowedMosqueSet && (
                    <option value="complex_supervisor">مشرف المجمع بالكامل</option>
                  )}
                </select>
              </div>

              {editMemberTargetRole === 'complex_supervisor' ? (
                <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 text-xs font-bold text-[#4A220D]">
                  يشرف هذا العضو على المجمع بالكامل (جميع المساجد والحلقات).
                </div>
              ) : editMemberTargetRole === 'supervisor' ? (
                <div>
                  <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                    المساجد التي يشرف عليها:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {visibleMosques.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() =>
                          setEditMemberMosqueIds((prev) => toggleArrayItem(prev, m.id))
                        }
                        className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                          editMemberMosqueIds.includes(m.id)
                            ? 'bg-[#F56900] border-[#C95200] text-white'
                            : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                        }`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      المسجد
                    </label>
                    <select
                      value={editMemberMosqueId}
                      onChange={(e) => {
                        setEditMemberMosqueId(e.target.value);
                        setEditMemberHalaqaIds([]);
                      }}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                    >
                      <option value="">-- بدون مسجد --</option>
                      {visibleMosques.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                      {editMemberTargetRole === 'teacher' ? 'الحلقات:' : 'الحلقة:'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {visibleHalaqat
                        .filter((h) => h.mosqueId === editMemberMosqueId)
                        .map((h) => (
                          <button
                            key={h.id}
                            type="button"
                            onClick={() =>
                              setEditMemberHalaqaIds((prev) =>
                                editMemberTargetRole === 'teacher'
                                  ? toggleArrayItem(prev, h.id)
                                  : [h.id]
                              )
                            }
                            className={`min-h-[38px] px-3 py-1 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                              editMemberHalaqaIds.includes(h.id)
                                ? 'bg-[#F56900] border-[#C95200] text-white'
                                : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                            }`}
                          >
                            {h.name}
                          </button>
                        ))}
                    </div>
                  </div>
                </div>
              )}

              {editMemberError && (
                <div
                  role="alert"
                  className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{editMemberError}</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingMember}
                  className="duo-btn-orange flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {savingMember ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                </button>
                <button
                  type="button"
                  disabled={savingMember}
                  onClick={() => setEditingMember(null)}
                  className="duo-btn-cream flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}

      {confirmDeleteMember &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-4"
            role="dialog"
            aria-modal="true"
          >
            <div
              className="w-full max-w-sm bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4 shadow-xl"
              dir="rtl"
            >
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                حذف {ROLE_LABELS[confirmDeleteMember.role]}: {confirmDeleteMember.quadrupleName}؟
              </h3>
              <p className="text-sm text-[#7D4E35]">
                سيتم حذف الحساب وفهرس الاسم الرباعي ورابط الدخول السريع الخاص به من قاعدة البيانات بشكل نهائي.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={deletingMember}
                  onClick={handleConfirmDeleteMember}
                  className="flex-1 min-h-[46px] rounded-2xl bg-[#D95338] text-white font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  {deletingMember ? 'جاري الحذف...' : 'تأكيد الحذف'}
                </button>
                <button
                  type="button"
                  disabled={deletingMember}
                  onClick={() => setConfirmDeleteMember(null)}
                  className="duo-btn-cream flex-1 min-h-[46px] rounded-2xl font-display font-bold text-sm cursor-pointer disabled:opacity-60"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {copyToast &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] max-w-[92vw] pointer-events-none"
          >
            <div className="bg-[#46A302] text-white border-2 border-[#58CC02] rounded-2xl px-5 py-3 shadow-xl flex items-center gap-2.5 font-display font-extrabold text-sm sm:text-base max-w-full">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <span className="truncate">{copyToast}</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
