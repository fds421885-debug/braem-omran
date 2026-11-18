import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { getDbDisplayLabel, validateQuadrupleArabicName } from '../services/multiDb';
import {
  addAccountToWorkspace,
  addOrRenameHalaqaInWorkspace,
  addOrRenameMosqueInWorkspace,
  bulkImportAccountsToWorkspace,
  deleteInviteLinkFromWorkspace,
  loadComplexWorkspace,
  saveInviteLinkToWorkspace,
  syncQuickLinkForAccount,
  transferAccountAssignment,
  transferEntireHalaqa,
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
import { DatabaseTransferModal } from './DatabaseTransferModal';
import { ModernLoader } from './ModernLoader';

interface ComplexWorkspaceProps {
  discovered: DiscoveredComplex;
  connectedDbs: ConnectedDatabaseInfo[];
  onBack: () => void;
  onComplexRelocated: (complexId: string) => Promise<void> | void;
}

type WorkspaceTab = 'stats' | 'accounts' | 'mosques' | 'quick_links';
type AccountSubTab = 'list' | 'single' | 'bulk' | 'invites';

export const ComplexWorkspace: React.FC<ComplexWorkspaceProps> = ({
  discovered,
  connectedDbs,
  onBack,
  onComplexRelocated,
}) => {
  const [workspace, setWorkspace] = useState<ComplexWorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('stats');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Accounts Subtab state
  const [accountSubTab, setAccountSubTab] = useState<AccountSubTab>('single');
  const [singleName, setSingleName] = useState('');
  const [singleEmail, setSingleEmail] = useState('');
  const [singleRole, setSingleRole] = useState<Exclude<UserRole, 'platform_admin'>>('student');
  const [singleMosqueId, setSingleMosqueId] = useState('');
  const [singleMosqueIds, setSingleMosqueIds] = useState<string[]>([]);
  const [singleHalaqaIds, setSingleHalaqaIds] = useState<string[]>([]);

  // Bulk import state
  const [bulkLines, setBulkLines] = useState('');
  const [bulkRole, setBulkRole] = useState<Exclude<UserRole, 'platform_admin'>>('student');
  const [bulkMosqueId, setBulkMosqueId] = useState('');
  const [bulkMosqueIds, setBulkMosqueIds] = useState<string[]>([]);
  const [bulkHalaqaIds, setBulkHalaqaIds] = useState<string[]>([]);

  // Invite link state
  const [editingInviteToken, setEditingInviteToken] = useState<string | undefined>(undefined);
  const [inviteTitle, setInviteTitle] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<UserRole, 'platform_admin'>>('student');
  const [inviteMosqueId, setInviteMosqueId] = useState('');
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<{
    scope: DbTransferScope;
    targetId: string;
    targetName: string;
    currentDbLabel: string;
  } | null>(null);

  const refreshWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadComplexWorkspace(discovered);
      setWorkspace(data);
      const firstMosque = data.mosques[0]?.id || '';
      setSingleMosqueId((prev) => prev || firstMosque);
      setBulkMosqueId((prev) => prev || firstMosque);
      setInviteMosqueId((prev) => prev || firstMosque);
    } finally {
      setLoading(false);
    }
  }, [discovered]);

  useEffect(() => {
    refreshWorkspace();
  }, [refreshWorkspace]);

  const bulkLineAnalysis = useMemo(() => {
    const lines = bulkLines
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let validCount = 0;
    let invalidCount = 0;
    for (const l of lines) {
      if (validateQuadrupleArabicName(l).valid) validCount++;
      else invalidCount++;
    }
    return { total: lines.length, validCount, invalidCount };
  }, [bulkLines]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 2200);
    } catch {
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

  const supervisors = workspace.accounts.filter((a) => a.role === 'supervisor');
  const teachers = workspace.accounts.filter((a) => a.role === 'teacher');
  const students = workspace.accounts.filter((a) => a.role === 'student');

  const singleMosqueHalaqat = workspace.halaqat.filter(
    (h) => h.mosqueId === singleMosqueId
  );
  const bulkMosqueHalaqat = workspace.halaqat.filter(
    (h) => h.mosqueId === bulkMosqueId
  );
  const inviteMosqueHalaqat = workspace.halaqat.filter(
    (h) => h.mosqueId === inviteMosqueId
  );

  const handleAddSingleAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setBusyLabel('جاري التحقق من الاسم وحفظ الحساب...');
    try {
      const mIds = singleRole === 'supervisor' ? singleMosqueIds : singleMosqueId ? [singleMosqueId] : [];
      const primaryMosque = singleRole === 'supervisor' ? mIds[0] || '' : singleMosqueId;
      await addAccountToWorkspace({
        workspace,
        quadrupleName: singleName,
        role: singleRole,
        email: singleEmail,
        mosqueId: primaryMosque,
        mosqueIds: mIds,
        halaqaIds: singleRole === 'supervisor' ? [] : singleHalaqaIds,
      });
      setSingleName('');
      setSingleEmail('');
      setSingleHalaqaIds([]);
      setFeedback({ type: 'ok', text: 'تمت إضافة الحساب بنجاح دون تكرار.' });
      await refreshWorkspace();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذرت إضافة الحساب.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleBulkImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setBusyLabel('جاري فحص القائمة وإضافة الحسابات...');
    try {
      const mIds = bulkRole === 'supervisor' ? bulkMosqueIds : bulkMosqueId ? [bulkMosqueId] : [];
      const primaryMosque = bulkRole === 'supervisor' ? mIds[0] || '' : bulkMosqueId;
      const res = await bulkImportAccountsToWorkspace({
        workspace,
        rawLines: bulkLines,
        role: bulkRole,
        mosqueId: primaryMosque,
        mosqueIds: mIds,
        halaqaIds: bulkRole === 'supervisor' ? [] : bulkHalaqaIds,
      });
      if (res.addedCount > 0) setBulkLines('');
      const msg =
        res.skippedErrors.length > 0
          ? `تمت إضافة ${res.addedCount} حساب، وتجاهل ${res.skippedErrors.length} سطر: ${res.skippedErrors.slice(0, 2).join(' | ')}`
          : `تمت إضافة ${res.addedCount} حساب للجامع بنجاح.`;
      setFeedback({ type: res.addedCount > 0 ? 'ok' : 'err', text: msg });
      await refreshWorkspace();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر استيراد القائمة.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleSaveInviteLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    if (!inviteTitle.trim()) {
      setFeedback({ type: 'err', text: 'يرجى كتابة عنوان رابط التسجيل.' });
      return;
    }

    const startsAtMs = inviteStartsAt ? new Date(inviteStartsAt).getTime() : 0;
    const endsAtMs = inviteEndsAt ? new Date(inviteEndsAt).getTime() : 0;
    if (startsAtMs > 0 && endsAtMs > 0 && endsAtMs <= startsAtMs) {
      setFeedback({ type: 'err', text: 'يجب أن يكون وقت النهاية بعد وقت البداية.' });
      return;
    }

    const mIds =
      inviteRole === 'supervisor'
        ? inviteMosqueIds
        : inviteMosqueId
        ? [inviteMosqueId]
        : [];
    const primaryMosque = inviteRole === 'supervisor' ? mIds[0] || '' : inviteMosqueId;

    setBusyLabel('جاري حفظ رابط التسجيل...');
    try {
      await saveInviteLinkToWorkspace({
        workspace,
        existingToken: editingInviteToken,
        title: inviteTitle,
        role: inviteRole,
        mosqueId: primaryMosque,
        mosqueIds: mIds,
        halaqaIds: inviteRole === 'supervisor' ? [] : inviteHalaqaIds,
        startsAtMs,
        endsAtMs,
        active: inviteActive,
      });
      setEditingInviteToken(undefined);
      setInviteTitle('');
      setInviteHalaqaIds([]);
      setInviteMosqueIds([]);
      setInviteStartsAt('');
      setInviteEndsAt('');
      setInviteActive(true);
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
    setInviteRole(link.role);
    setInviteMosqueId(link.mosqueId);
    setInviteMosqueIds(link.mosqueIds);
    setInviteHalaqaIds(link.halaqaIds);
    setInviteStartsAt(
      link.startsAtMs ? new Date(link.startsAtMs).toISOString().slice(0, 16) : ''
    );
    setInviteEndsAt(
      link.endsAtMs ? new Date(link.endsAtMs).toISOString().slice(0, 16) : ''
    );
    setInviteActive(link.active);
    setAccountSubTab('invites');
  };

  const handleCopyInviteUrl = (link: InviteLinkRecord) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('invite', link.token);
    url.searchParams.set('cpx', discovered.id);
    if (link.mosqueId) url.searchParams.set('msq', link.mosqueId);
    copyText(`inv_${link.token}`, url.toString());
  };

  const handleCopyQuickUrl = async (account: AccountRecord) => {
    setBusyLabel('جاري تجهيز رابط الدخول السريع...');
    try {
      const quick = await syncQuickLinkForAccount(workspace, account);
      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('quick', quick.token);
      url.searchParams.set('cpx', discovered.id);
      if (account.mosqueId) url.searchParams.set('msq', account.mosqueId);
      await copyText(`qk_${account.id}`, url.toString());
      await refreshWorkspace();
    } finally {
      setBusyLabel(null);
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

  const quickFilteredAccounts = workspace.accounts.filter((a) => {
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

  const filteredMemberList = workspace.accounts.filter((a) =>
    a.quadrupleName.includes(memberSearch.trim())
  );

  return (
    <div className="space-y-6">
      {/* Top Complex Header */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="duo-btn-cream min-h-[44px] px-3.5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowRight className="w-4 h-4" />
            <span>المجمعات</span>
          </button>
          <div className="flex flex-wrap items-center gap-2.5">
            <div>
              <h2 className="font-display text-lg sm:text-2xl font-extrabold text-[#4A220D]">
                {workspace.complex?.name || discovered.name}
              </h2>
              <p className="text-xs font-medium text-[#7D4E35]">
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

        {/* 4 Workspace Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 bg-[#FDF6EE] p-1.5 rounded-2xl border border-[#EADBC8]">
          {[
            { id: 'stats' as WorkspaceTab, label: 'الإحصائيات', icon: BarChart3 },
            { id: 'accounts' as WorkspaceTab, label: 'الحسابات', icon: Users },
            { id: 'mosques' as WorkspaceTab, label: 'المساجد', icon: Building2 },
            { id: 'quick_links' as WorkspaceTab, label: 'روابط الدخول السريع', icon: KeyRound },
          ].map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`min-h-[42px] px-3 sm:px-4 py-2 rounded-xl font-display text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
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
              <div className="overflow-x-auto">
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
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Accounts (Manual, Bulk List, Invite Links, Members List) */}
      {tab === 'accounts' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2 bg-white p-2 rounded-2xl border-2 border-[#EADBC8]">
            {[
              { id: 'single' as AccountSubTab, label: 'إضافة حساب يدوي', icon: UserPlus },
              { id: 'bulk' as AccountSubTab, label: 'استيراد قائمة أسماء', icon: Users },
              { id: 'invites' as AccountSubTab, label: 'روابط التسجيل', icon: Link2 },
              { id: 'list' as AccountSubTab, label: `الأعضاء (${workspace.accounts.length})`, icon: Search },
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

          {accountSubTab === 'single' && (
            <form
              onSubmit={handleAddSingleAccount}
              className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
            >
              <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                إضافة حساب وتصنيفه
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                    الاسم الرباعي (إلزامي وغير مكرر)
                  </label>
                  <input
                    type="text"
                    value={singleName}
                    onChange={(e) => setSingleName(e.target.value)}
                    placeholder="مثال: خالد عبدالله سالم الحربي"
                    required
                    className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                  />
                </div>
                <div>
                  <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                    بريد جوجل (اختياري للربط التلقائي عند الدخول)
                  </label>
                  <input
                    type="email"
                    dir="ltr"
                    value={singleEmail}
                    onChange={(e) => setSingleEmail(e.target.value)}
                    placeholder="user@gmail.com"
                    className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                    الرتبة / التصنيف
                  </label>
                  <select
                    value={singleRole}
                    onChange={(e) => {
                      setSingleRole(e.target.value as Exclude<UserRole, 'platform_admin'>);
                      setSingleHalaqaIds([]);
                      setSingleMosqueIds([]);
                    }}
                    className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                  >
                    <option value="student">طالب</option>
                    <option value="teacher">معلم</option>
                    <option value="supervisor">مشرف</option>
                  </select>
                </div>

                {singleRole !== 'supervisor' && (
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      المسجد
                    </label>
                    <select
                      value={singleMosqueId}
                      onChange={(e) => {
                        setSingleMosqueId(e.target.value);
                        setSingleHalaqaIds([]);
                      }}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                    >
                      {workspace.mosques.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {singleRole === 'supervisor' ? (
                <div>
                  <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                    اختر المسجد أو المساجد التي يشرف عليها:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {workspace.mosques.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() =>
                          setSingleMosqueIds((prev) => toggleArrayItem(prev, m.id))
                        }
                        className={`min-h-[40px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                          singleMosqueIds.includes(m.id)
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
                <div>
                  <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                    {singleRole === 'teacher'
                      ? 'اختر حلقة أو حلقات المعلم:'
                      : 'اختر حلقة الطالب:'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {singleMosqueHalaqat.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() =>
                          setSingleHalaqaIds((prev) =>
                            singleRole === 'teacher' ? toggleArrayItem(prev, h.id) : [h.id]
                          )
                        }
                        className={`min-h-[40px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                          singleHalaqaIds.includes(h.id)
                            ? 'bg-[#F56900] border-[#C95200] text-white'
                            : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                        }`}
                      >
                        {h.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="submit"
                className="duo-btn-orange min-h-[48px] px-6 py-2.5 rounded-2xl font-display font-extrabold text-sm cursor-pointer"
              >
                حفظ وإضافة الحساب
              </button>
            </form>
          )}

          {accountSubTab === 'bulk' && (
            <form
              onSubmit={handleBulkImport}
              className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4"
            >
              <div>
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  إضافة قائمة أسماء رباعية دفعة واحدة
                </h3>
                <p className="text-xs sm:text-sm text-[#7D4E35]">
                  ضع كل اسم رباعي في سطر مستقل؛ يُشترط أن يكون رباعياً وألا يتكرر في قاعدة البيانات.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                    رتبة الأسماء المستوردة
                  </label>
                  <select
                    value={bulkRole}
                    onChange={(e) => {
                      setBulkRole(e.target.value as Exclude<UserRole, 'platform_admin'>);
                      setBulkHalaqaIds([]);
                      setBulkMosqueIds([]);
                    }}
                    className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                  >
                    <option value="student">طلاب</option>
                    <option value="teacher">معلمين</option>
                    <option value="supervisor">مشرفين</option>
                  </select>
                </div>

                {bulkRole !== 'supervisor' && (
                  <div>
                    <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                      الجامع / المسجد
                    </label>
                    <select
                      value={bulkMosqueId}
                      onChange={(e) => {
                        setBulkMosqueId(e.target.value);
                        setBulkHalaqaIds([]);
                      }}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                    >
                      {workspace.mosques.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {bulkRole === 'supervisor' ? (
                <div className="flex flex-wrap gap-2">
                  {workspace.mosques.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setBulkMosqueIds((prev) => toggleArrayItem(prev, m.id))
                      }
                      className={`min-h-[40px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                        bulkMosqueIds.includes(m.id)
                          ? 'bg-[#F56900] border-[#C95200] text-white'
                          : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                      }`}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {bulkMosqueHalaqat.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() =>
                        setBulkHalaqaIds((prev) =>
                          bulkRole === 'teacher' ? toggleArrayItem(prev, h.id) : [h.id]
                        )
                      }
                      className={`min-h-[40px] px-3.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                        bulkHalaqaIds.includes(h.id)
                          ? 'bg-[#F56900] border-[#C95200] text-white'
                          : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                      }`}
                    >
                      {h.name}
                    </button>
                  ))}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between text-xs font-bold mb-1.5">
                  <span className="text-[#4A220D]">قائمة الأسماء (كل اسم رباعي في سطر)</span>
                  <span className="text-[#7D4E35] tabular-nums">
                    صالح: {bulkLineAnalysis.validCount} · غير مكتمل: {bulkLineAnalysis.invalidCount}
                  </span>
                </div>
                <textarea
                  rows={6}
                  value={bulkLines}
                  onChange={(e) => setBulkLines(e.target.value)}
                  placeholder={`محمد أحمد علي السالم\nيوسف خالد حسن العتيبي\nسعد فهد ناصر القحطاني`}
                  className="w-full p-3.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm text-[#4A220D] focus:outline-none focus:border-[#F56900] focus:bg-white"
                />
              </div>

              <button
                type="submit"
                className="duo-btn-orange min-h-[48px] px-6 py-2.5 rounded-2xl font-display font-extrabold text-sm cursor-pointer"
              >
                إضافة القائمة إلى الجامع
              </button>
            </form>
          )}

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
                      onClick={() => {
                        setEditingInviteToken(undefined);
                        setInviteTitle('');
                      }}
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
                      value={inviteRole}
                      onChange={(e) => {
                        setInviteRole(e.target.value as Exclude<UserRole, 'platform_admin'>);
                        setInviteHalaqaIds([]);
                        setInviteMosqueIds([]);
                      }}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold"
                    >
                      <option value="student">طلاب</option>
                      <option value="teacher">معلمين</option>
                      <option value="supervisor">مشرفين</option>
                    </select>
                  </div>
                </div>

                {inviteRole === 'supervisor' ? (
                  <div>
                    <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                      حدد المسجد أو المساجد لهذا المشرف:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {workspace.mosques.map((m) => (
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
                        {workspace.mosques.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <p className="font-display text-xs font-bold text-[#4A220D] mb-2">
                        {inviteRole === 'teacher'
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
                                inviteRole === 'teacher' ? toggleArrayItem(prev, h.id) : [h.id]
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
                  روابط التسجيل المنشأة ({workspace.inviteLinks.length})
                </h4>
                {workspace.inviteLinks.length === 0 ? (
                  <p className="text-sm text-[#7D4E35]">لم يتم إنشاء روابط تسجيل بعد.</p>
                ) : (
                  <div className="space-y-3">
                    {workspace.inviteLinks.map((lnk) => {
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
                              {ROLE_LABELS[lnk.role]} · الحالة: <strong className="text-[#F56900]">{stateText}</strong>
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleCopyInviteUrl(lnk)}
                              className="duo-btn-cream min-h-[40px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              {copiedId === `inv_${lnk.token}` ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-[#58CC02]" />
                                  <span>تم النسخ</span>
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
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                  أعضاء المجمع
                </h3>
                <input
                  type="search"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="بحث بالاسم الرباعي..."
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-sm w-full sm:w-64"
                />
              </div>

              {filteredMemberList.length === 0 ? (
                <p className="text-sm text-[#7D4E35]">لا توجد حسابات مطابقة.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-sm">
                    <thead>
                      <tr className="border-b-2 border-[#F7EBDD] text-[#7D4E35]">
                        <th className="py-2.5 px-3 font-display font-bold">الاسم الرباعي</th>
                        <th className="py-2.5 px-3 font-display font-bold">الرتبة</th>
                        <th className="py-2.5 px-3 font-display font-bold">المسجد</th>
                        <th className="py-2.5 px-3 font-display font-bold">الحلقات</th>
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
                        return (
                          <tr key={acc.id} className="border-b border-[#F7EBDD] last:border-b-0">
                            <td className="py-3 px-3 font-bold text-[#4A220D]">
                              {acc.quadrupleName}
                            </td>
                            <td className="py-3 px-3 text-[#F56900] font-bold">
                              {ROLE_LABELS[acc.role]}
                            </td>
                            <td className="py-3 px-3 text-[#7D4E35]">{mNames || '—'}</td>
                            <td className="py-3 px-3 text-[#7D4E35]">{hNames || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Mosques, Halaqat, Supervisors & Full Transfers */}
      {tab === 'mosques' && (
        <div className="space-y-6">
          {/* Add Mosque Bar */}
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

          {/* Mosques Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {workspace.mosques.map((m) => {
              const mHalaqat = workspace.halaqat.filter((h) => h.mosqueId === m.id);
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
                          <p className="text-[11px] font-bold text-[#F56900] mt-0.5">
                            القاعدة:{' '}
                            {workspace.mosqueConfigMap[m.id]
                              ? getDbDisplayLabel(workspace.mosqueConfigMap[m.id]!)
                              : discovered.ownerDbLabel}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
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
                                {hDbDiffersFromMosque && (
                                  <span className="block text-[11px] font-bold text-[#46A302]">
                                    قاعدة مستقلة: {hDbLabel}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
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
                  {workspace.halaqat.map((h: HalaqaRecord) => {
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
                  {workspace.mosques.map((m) => (
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
                    const acc = workspace.accounts.find((a) => a.id === e.target.value);
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
                  {workspace.accounts
                    .filter((a) => a.role !== 'platform_admin')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.quadrupleName} ({ROLE_LABELS[a.role]})
                      </option>
                    ))}
                </select>
              </div>

              {selectedTransferAccount && (
                <>
                  {selectedTransferAccount.role === 'supervisor' ? (
                    <div>
                      <p className="text-xs font-bold text-[#7D4E35] mb-2">
                        المساجد التي يشرف عليها:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {workspace.mosques.map((m) => (
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
                          {workspace.mosques.map((m) => (
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
                          {workspace.halaqat
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
                {workspace.mosques.map((m) => (
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
                {workspace.halaqat
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
                        {ROLE_LABELS[acc.role]}
                        {mName ? ` · ${mName}` : ''}
                        {hNames ? ` · ${hNames}` : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleCopyQuickUrl(acc)}
                      className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
                    >
                      {copiedId === `qk_${acc.id}` ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>تم نسخ رابط الدخول السريع</span>
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

      {transferTarget && (
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
    </div>
  );
};
