import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import JSZip from 'jszip';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  FileJson,
  HardDrive,
  HardDriveUpload,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  buildDbConnectionId,
  getDbDisplayLabel,
  verifyExternalFirebaseSetup,
  type ExternalDbVerificationResult,
} from '../services/multiDb';
import {
  activateShardInTabPool,
  addShardToComplexTabPool,
  assignExternalDbToComplexTabs,
  buildDatabaseBackupBundle,
  cloneComplexToBackupDatabase,
  exportAllComplexBackupFiles,
  exportComplexTabJsonPayload,
  getDbLabelForComplexTab,
  importComplexTabJsonPayload,
  migrateTabShardToReplacement,
  recalculateTabPoolUsage,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  COMPLEX_FEATURE_TAB_LABELS,
  TAB_SHARD_MAX_BYTES,
  type ComplexFeatureTabKey,
  type ConnectedDatabaseInfo,
  type ExternalFirebaseConfig,
  type TabDbShard,
} from '../types/platform';
import { ExternalDbVerifier } from './ExternalDbVerifier';
import { ModernLoader } from './ModernLoader';

interface ComplexDatabasesTabProps {
  workspace: ComplexWorkspaceData;
  connectedDbs: ConnectedDatabaseInfo[];
  onOpenComplexDbTransferModal: () => void;
  onWorkspaceUpdated: () => Promise<void> | void;
}

const ALL_TAB_KEYS: ComplexFeatureTabKey[] = [
  'attendance',
  'library',
  'curricula',
  'accounts_invites',
  'mosques_halaqat',
];

function triggerDownloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatBytesArabic(bytes: number): string {
  const clean = Math.max(0, Number(bytes) || 0);
  if (clean < 1024) return `${clean} بايت`;
  if (clean < 1024 * 1024) return `${(clean / 1024).toFixed(1)} كيلوبايت`;
  if (clean < 1024 * 1024 * 1024) return `${(clean / (1024 * 1024)).toFixed(2)} ميجابايت`;
  return `${(clean / (1024 * 1024 * 1024)).toFixed(3)} جيجابايت`;
}

export const ComplexDatabasesTab: React.FC<ComplexDatabasesTabProps> = ({
  workspace,
  connectedDbs,
  onOpenComplexDbTransferModal,
  onWorkspaceUpdated,
}) => {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Add/Assign DB Shard to Tab Modal state
  const [showTabModal, setShowTabModal] = useState(false);
  const [selectedTabs, setSelectedTabs] = useState<ComplexFeatureTabKey[]>(['attendance']);
  const [tabDestMode, setTabDestMode] = useState<
    'add_shard' | 'replace_all_external' | 'complex_default'
  >('add_shard');
  const [tabConfigRaw, setTabConfigRaw] = useState('');
  const [tabDatabaseId, setTabDatabaseId] = useState('');
  const [tabVerification, setTabVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [confirmTabIsolation, setConfirmTabIsolation] = useState(false);
  const [tabModalError, setTabModalError] = useState<string | null>(null);

  // Migrate Shard to Replacement DB Modal state
  const [migrateTarget, setMigrateTarget] = useState<{
    tabKey: ComplexFeatureTabKey;
    shard: TabDbShard;
  } | null>(null);
  const [migrateDestConfigRaw, setMigrateDestConfigRaw] = useState('');
  const [migrateDestDatabaseId, setMigrateDestDatabaseId] = useState('');
  const [migrateVerification, setMigrateVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [removeSourceAfterMigrate, setRemoveSourceAfterMigrate] = useState(true);
  const [migrateModalError, setMigrateModalError] = useState<string | null>(null);

  // Clone to Backup DB Modal state
  const [showBackupCloneModal, setShowBackupCloneModal] = useState(false);
  const [backupConfigRaw, setBackupConfigRaw] = useState('');
  const [backupDatabaseId, setBackupDatabaseId] = useState('');
  const [backupVerification, setBackupVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [backupCloneError, setBackupCloneError] = useState<string | null>(null);

  // Per-tab JSON Upload Ref
  const jsonUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTargetTab, setUploadTargetTab] = useState<ComplexFeatureTabKey | null>(null);

  const externalPresets = connectedDbs.filter((d) => !d.isPrimary);

  const handleDownloadFullComplexJson = () => {
    try {
      const bundle = buildDatabaseBackupBundle({
        workspace,
        scope: 'complex',
        targetId: workspace.complex.id,
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const dateStr = new Date().toISOString().slice(0, 10);
      triggerDownloadBlob(
        `baraem-omran-${workspace.complex.id}-${dateStr}.json`,
        blob
      );
      setFeedback({
        type: 'ok',
        text: 'تم تنزيل نسخة JSON للمجمع بنجاح.',
      });
    } catch {
      setFeedback({ type: 'err', text: 'تعذّر تصدير نسخة JSON للمجمع.' });
    }
  };

  const handleDownloadAllZipBackup = async () => {
    setBusyLabel('جاري تجميع جميع تبويبات المجمع وضغطها في ملف ZIP...');
    setFeedback(null);
    try {
      const { files } = await exportAllComplexBackupFiles(workspace);
      const zip = new JSZip();
      for (const f of files) {
        zip.file(f.filename, f.content);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const dateStr = new Date().toISOString().slice(0, 10);
      triggerDownloadBlob(
        `baraem-omran-full-backup-${workspace.complex.id}-${dateStr}.zip`,
        zipBlob
      );
      setFeedback({
        type: 'ok',
        text: 'تم تنزيل النسخة الاحتياطية الكاملة لجميع البيانات (ملف ZIP يحتوي على ملف JSON لكل تبويب) بنجاح.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر إنشاء ملف النسخة الاحتياطية ZIP.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleDownloadSingleTabJson = async (tabKey: ComplexFeatureTabKey) => {
    setBusyLabel(`جاري تصدير بيانات "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}"...`);
    setFeedback(null);
    try {
      const payload = await exportComplexTabJsonPayload(workspace, tabKey);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const dateStr = new Date().toISOString().slice(0, 10);
      triggerDownloadBlob(
        `baraem-${workspace.complex.id}-${tabKey}-${dateStr}.json`,
        blob
      );
      setFeedback({
        type: 'ok',
        text: `تم تنزيل ملف JSON الخاص بتبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تصدير ملف التبويب.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleTriggerUploadTabJson = (tabKey: ComplexFeatureTabKey) => {
    setUploadTargetTab(tabKey);
    if (jsonUploadInputRef.current) {
      jsonUploadInputRef.current.value = '';
      jsonUploadInputRef.current.click();
    }
  };

  const handleJsonFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetTab = uploadTargetTab;
    if (!file || !targetTab) return;

    setBusyLabel(`جاري قراءة ورفع ملف JSON إلى تبويب "${COMPLEX_FEATURE_TAB_LABELS[targetTab]}"...`);
    setFeedback(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const { importedCount } = await importComplexTabJsonPayload({
        workspace,
        tabKey: targetTab,
        parsedJson: parsed,
      });
      await onWorkspaceUpdated();
      setFeedback({
        type: 'ok',
        text: `تم استيراد ورفع ${importedCount} سجل إلى قاعدة تبويب "${COMPLEX_FEATURE_TAB_LABELS[targetTab]}" بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر قراءة أو استيراد ملف JSON.',
      });
    } finally {
      setBusyLabel(null);
      setUploadTargetTab(null);
    }
  };

  const openAssignTabModal = (
    initialTab?: ComplexFeatureTabKey,
    mode: 'add_shard' | 'replace_all_external' = 'add_shard'
  ) => {
    setSelectedTabs(initialTab ? [initialTab] : ['library']);
    setTabDestMode(mode);
    setTabConfigRaw('');
    setTabDatabaseId('');
    setTabVerification(null);
    setConfirmTabIsolation(false);
    setTabModalError(null);
    setShowTabModal(true);
  };

  const handleExecuteTabDbAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setTabModalError(null);
    if (selectedTabs.length === 0) {
      setTabModalError('يرجى اختيار تبويب واحد على الأقل.');
      return;
    }
    if (!confirmTabIsolation) {
      setTabModalError('يرجى وضع علامة التأكيد قبل متابعة الإجراء.');
      return;
    }

    let targetConfig: ExternalFirebaseConfig | null = null;
    if (tabDestMode !== 'complex_default') {
      let ver = tabVerification;
      if (!ver) {
        ver = await verifyExternalFirebaseSetup(tabConfigRaw, tabDatabaseId);
        setTabVerification(ver);
      }
      if (!ver.approved || !ver.config) {
        setTabModalError('قاعدة البيانات المختارة غير معتمدة بعد؛ راجع نتيجة الفحص.');
        return;
      }
      targetConfig = ver.config;
    }

    setBusyLabel(
      tabDestMode === 'add_shard'
        ? 'جاري إضافة القاعدة إلى سلسلة قواعد التبويب (بحد أقصى 4 جيجابايت لكل قاعدة)...'
        : 'جاري نقل بيانات التبويب المختار حصراً لهذا المجمع وحذفها نهائياً من القاعدة الأم...'
    );
    try {
      if (tabDestMode === 'add_shard' && targetConfig) {
        let totalMigrated = 0;
        for (const tk of selectedTabs) {
          const res = await addShardToComplexTabPool({
            workspace,
            tabKey: tk,
            config: targetConfig,
            maxBytes: TAB_SHARD_MAX_BYTES,
          });
          totalMigrated += res.migratedDocs;
        }
        setShowTabModal(false);
        await onWorkspaceUpdated();
        setFeedback({
          type: 'ok',
          text:
            totalMigrated > 0
              ? `تم ربط القاعدة وإضافتها لسلسلة التبويب بنجاح، ونُقل (${totalMigrated}) سجل مع عزلها عن القاعدة الأم. ستنتقل الكتابة تلقائياً للقاعدة التالية عند وصول الاستهلاك إلى 4 جيجابايت.`
              : `تمت إضافة القاعدة (${getDbDisplayLabel(targetConfig)}) إلى سلسلة التبويب كقاعدة جاهزة بسعة 4 جيجابايت، وستُفتح تلقائياً فور امتلاء القاعدة الحالية.`,
        });
      } else {
        const { movedDocsCount } = await assignExternalDbToComplexTabs({
          workspace,
          tabKeys: selectedTabs,
          targetConfig,
        });
        setShowTabModal(false);
        await onWorkspaceUpdated();
        setFeedback({
          type: 'ok',
          text:
            tabDestMode === 'replace_all_external'
              ? `تم نقل (${movedDocsCount}) سجل للتبويبات المحددة إلى القاعدة الخارجية وحذفها نهائياً من القاعدة الأم.`
              : `تمت إعادة (${movedDocsCount}) سجل للتبويبات المحددة إلى قاعدة المجمع الأساسية بنجاح.`,
        });
      }
    } catch (err) {
      setTabModalError(
        err instanceof Error ? err.message : 'تعذّر ربط التبويب بقاعدة البيانات.'
      );
    } finally {
      setBusyLabel(null);
    }
  };

  const handleActivateShard = async (tabKey: ComplexFeatureTabKey, shardId: string) => {
    setBusyLabel('جاري تفعيل القاعدة المختارة للكتابة والتخزين...');
    setFeedback(null);
    try {
      await activateShardInTabPool({ workspace, tabKey, shardId });
      await onWorkspaceUpdated();
      setFeedback({
        type: 'ok',
        text: `تم تفعيل القاعدة المختارة للكتابة على تبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}". جميع القواعد السابقة لا تزال مقروءة بسلاسة.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تفعيل القاعدة.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleRecalculateUsage = async (tabKey: ComplexFeatureTabKey) => {
    setBusyLabel(`جاري فحص وحساب المساحة الفعلية لقواعد "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}"...`);
    setFeedback(null);
    try {
      await recalculateTabPoolUsage(workspace, tabKey);
      await onWorkspaceUpdated();
      setFeedback({
        type: 'ok',
        text: `تم تحديث عدادات المساحة وعدد السجلات لجميع قواعد تبويب "${COMPLEX_FEATURE_TAB_LABELS[tabKey]}" بدقة.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر إعادة حساب المساحة.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleExecuteShardMigration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!migrateTarget) return;
    setMigrateModalError(null);

    let ver = migrateVerification;
    if (!ver) {
      ver = await verifyExternalFirebaseSetup(migrateDestConfigRaw, migrateDestDatabaseId);
      setMigrateVerification(ver);
    }
    if (!ver.approved || !ver.config) {
      setMigrateModalError('القاعدة البديلة غير معتمدة بعد؛ أكمل فحصها أولاً.');
      return;
    }

    const destId = buildDbConnectionId(ver.config);
    if (destId === migrateTarget.shard.id) {
      setMigrateModalError('القاعدة البديلة مطابقة تماماً للقاعدة المصدر؛ اختر قاعدة مختلفة.');
      return;
    }

    setBusyLabel('جاري نقل جميع بيانات القاعدة المختارة إلى البديلة...');
    try {
      const { movedDocsCount } = await migrateTabShardToReplacement({
        workspace,
        tabKey: migrateTarget.tabKey,
        sourceShardId: migrateTarget.shard.id,
        destConfig: ver.config,
        removeSourceAfterMigration: removeSourceAfterMigrate,
        onProgress: (msg) => setBusyLabel(msg),
      });
      setMigrateTarget(null);
      await onWorkspaceUpdated();
      setFeedback({
        type: 'ok',
        text: `تم نقل (${movedDocsCount}) سجل إلى القاعدة البديلة (${getDbDisplayLabel(ver.config)}) بنجاح.`,
      });
    } catch (err) {
      setMigrateModalError(
        err instanceof Error ? err.message : 'تعذّر نقل البيانات إلى القاعدة البديلة.'
      );
    } finally {
      setBusyLabel(null);
    }
  };

  const handleExecuteBackupClone = async (e: React.FormEvent) => {
    e.preventDefault();
    setBackupCloneError(null);
    let ver = backupVerification;
    if (!ver) {
      ver = await verifyExternalFirebaseSetup(backupConfigRaw, backupDatabaseId);
      setBackupVerification(ver);
    }
    if (!ver.approved || !ver.config) {
      setBackupCloneError('القاعدة الاحتياطية غير معتمدة بعد؛ أكمل الفحص أولاً.');
      return;
    }

    setBusyLabel('جاري نسخ جميع بيانات المجمع بالكامل إلى القاعدة الاحتياطية...');
    try {
      const { totalCopiedDocs } = await cloneComplexToBackupDatabase({
        workspace,
        backupConfig: ver.config,
      });
      setShowBackupCloneModal(false);
      setFeedback({
        type: 'ok',
        text: `تم نسخ قاعدة المجمع بالكامل (${totalCopiedDocs} سجل) إلى القاعدة الاحتياطية بنجاح دون التأثير على البيانات الأساسية.`,
      });
    } catch (err) {
      setBackupCloneError(err instanceof Error ? err.message : 'تعذّر نسخ البيانات للقاعدة الاحتياطية.');
    } finally {
      setBusyLabel(null);
    }
  };

  return (
    <div className="space-y-6">
      <input
        ref={jsonUploadInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleJsonFileSelected}
      />

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

      {/* Section 1: Main Complex DB & Backup Operations */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Database className="w-6 h-6 text-[#F56900]" />
            <div>
              <h3 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
                إدارة قواعد بيانات المجمع والنسخ الاحتياطي
              </h3>
              <p className="text-xs sm:text-sm text-[#7D4E35]">
                القاعدة الحالية للمجمع:{' '}
                <strong className="text-[#4A220D]">{workspace.discovered.ownerDbLabel}</strong>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => openAssignTabModal('library', 'add_shard')}
            className="duo-btn-orange min-h-[44px] px-5 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>أضف قاعدة بيانات لتبويب</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={onOpenComplexDbTransferModal}
            className="duo-btn-cream min-h-[54px] px-4 py-3 rounded-2xl font-display font-bold text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-[#F56900]" />
            <span>إعداد / تعديل قاعدة المجمع</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setBackupConfigRaw('');
              setBackupDatabaseId('');
              setBackupVerification(null);
              setBackupCloneError(null);
              setShowBackupCloneModal(true);
            }}
            className="duo-btn-cream min-h-[54px] px-4 py-3 rounded-2xl font-display font-bold text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <Copy className="w-4 h-4 text-[#F56900]" />
            <span>نسخ لقاعدة احتياطية</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadFullComplexJson}
            className="duo-btn-cream min-h-[54px] px-4 py-3 rounded-2xl font-display font-bold text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <FileJson className="w-4 h-4 text-[#F56900]" />
            <span>تنزيل نسخة JSON للمجمع</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadAllZipBackup}
            className="duo-btn-green min-h-[54px] px-4 py-3 rounded-2xl font-display font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <Archive className="w-4 h-4" />
            <span>تنزيل نسخة JSON شاملة (ZIP)</span>
          </button>
        </div>
      </div>

      {/* Section 2: Multi-Shard Isolated Tabs (4 GB per DB + Auto-Rollover + Shard Migration) */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#F7EBDD]">
          <div>
            <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
              التبويبات المنفصلة وسلاسل قواعد البيانات (حد 4 جيجابايت لكل قاعدة)
            </h3>
            <p className="text-xs text-[#7D4E35]">
              يمكنك إضافة أكثر من قاعدة بيانات (5 قواعد فأكثر) لنفس التبويب؛ يعمل النظام على القاعدة النشطة حتى تصل إلى 4 جيجابايت فيوقف الكتابة عليها ويفتح التالية تلقائياً مع استمرار القراءة من الجميع، مع إمكانية نقل أي قاعدة لبديلتها.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {ALL_TAB_KEYS.map((tabKey) => {
            const label = COMPLEX_FEATURE_TAB_LABELS[tabKey];
            const pool = workspace.tabPools?.[tabKey] || [];
            const isCustomExternal = pool.length > 0 || Boolean(workspace.tabConfigMap?.[tabKey]);
            const dbLabel = getDbLabelForComplexTab(workspace, tabKey);

            return (
              <div
                key={tabKey}
                className={`rounded-2xl border-2 p-4 space-y-3 ${
                  isCustomExternal
                    ? 'bg-[#58CC02]/6 border-[#58CC02]'
                    : 'bg-[#FDF6EE] border-[#EADBC8]'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display font-extrabold text-sm sm:text-base text-[#4A220D]">
                        {label}
                      </span>
                      {isCustomExternal ? (
                        <span className="text-[11px] font-extrabold text-[#46A302] bg-white border border-[#58CC02] px-2.5 py-0.5 rounded-lg inline-flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          {pool.length > 1
                            ? `معزول على سلسلة (${pool.length} قواعد)`
                            : 'معزول على قاعدة مستقلة'}
                        </span>
                      ) : (
                        <span className="text-[11px] font-bold text-[#7D4E35] bg-white border border-[#EADBC8] px-2.5 py-0.5 rounded-lg">
                          يستخدم قاعدة المجمع
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#7D4E35] truncate">{dbLabel}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => openAssignTabModal(tabKey, 'add_shard')}
                      className="duo-btn-orange min-h-[38px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>
                        {pool.length > 0 ? 'إضافة قاعدة للسلسلة' : 'تعيين قاعدة للتبويب'}
                      </span>
                    </button>

                    {pool.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleRecalculateUsage(tabKey)}
                        className="min-h-[38px] px-3 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#F56900] font-display font-bold text-xs text-[#4A220D] inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5 text-[#F56900]" />
                        <span>حساب المساحة</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleDownloadSingleTabJson(tabKey)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#F56900] font-display font-bold text-xs text-[#4A220D] inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-[#F56900]" />
                      <span>تنزيل JSON</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleTriggerUploadTabJson(tabKey)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:border-[#58CC02] font-display font-bold text-xs text-[#4A220D] inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5 text-[#46A302]" />
                      <span>رفع JSON</span>
                    </button>
                  </div>
                </div>

                {/* Multi-Shard Chain List with 4 GB Meters & Replacement Migration */}
                {pool.length > 0 && (
                  <div className="pt-2 border-t border-[#EADBC8]/80 grid grid-cols-1 gap-2.5">
                    {pool.map((shard, index) => {
                      const pct = Math.min(
                        100,
                        Math.round(((shard.usedBytes || 0) / (shard.maxBytes || TAB_SHARD_MAX_BYTES)) * 1000) / 10
                      );
                      const remainingBytes = Math.max(
                        0,
                        (shard.maxBytes || TAB_SHARD_MAX_BYTES) - (shard.usedBytes || 0)
                      );
                      const isActive = shard.status === 'active';
                      const isFull = shard.status === 'full';

                      return (
                        <div
                          key={shard.id}
                          className={`rounded-xl border-2 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white ${
                            isActive
                              ? 'border-[#58CC02]'
                              : isFull
                              ? 'border-[#D95338]/50 bg-[#D95338]/3'
                              : 'border-[#EADBC8]'
                          }`}
                        >
                          <div className="space-y-1.5 min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs font-display font-extrabold text-[#4A220D]">
                                <HardDrive className="w-3.5 h-3.5 text-[#F56900]" />
                                قاعدة #{index + 1}: {shard.label}
                              </span>

                              {isActive ? (
                                <span className="px-2 py-0.5 rounded-md bg-[#58CC02]/15 text-[#46A302] text-[10px] font-extrabold">
                                  نشطة للتخزين الآن
                                </span>
                              ) : isFull ? (
                                <span className="px-2 py-0.5 rounded-md bg-[#D95338]/15 text-[#D95338] text-[10px] font-extrabold">
                                  ممتلئة (توقف عند 4 جيجابايت)
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-md bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35] text-[10px] font-bold">
                                  احتياطية · ستُفتح تلقائياً
                                </span>
                              )}

                              <span className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
                                ({shard.docsCount} سجل)
                              </span>
                            </div>

                            {/* 4 GB Usage Bar */}
                            <div className="space-y-1">
                              <div className="w-full h-2 rounded-full bg-[#FDF6EE] border border-[#EADBC8] overflow-hidden">
                                <div
                                  className={`h-full transition-all ${
                                    isFull
                                      ? 'bg-[#D95338]'
                                      : pct >= 85
                                      ? 'bg-[#FFA900]'
                                      : 'bg-[#58CC02]'
                                  }`}
                                  style={{ width: `${Math.max(shard.usedBytes > 0 ? 2 : 0, pct)}%` }}
                                />
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#7D4E35] tabular-nums">
                                <span>
                                  المستخدم: <strong className="text-[#4A220D]">{formatBytesArabic(shard.usedBytes)}</strong> من 4 جيجابايت ({pct}%)
                                </span>
                                <span>
                                  المتبقي قبل التبديل: <strong className="text-[#46A302]">{formatBytesArabic(remainingBytes)}</strong>
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            {!isActive && !isFull && (
                              <button
                                type="button"
                                onClick={() => void handleActivateShard(tabKey, shard.id)}
                                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#58CC02]/12 border border-[#58CC02]/40 hover:bg-[#58CC02]/20 text-[#46A302] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Zap className="w-3.5 h-3.5" />
                                <span>تفعيل للكتابة</span>
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                setMigrateTarget({ tabKey, shard });
                                setMigrateDestConfigRaw('');
                                setMigrateDestDatabaseId('');
                                setMigrateVerification(null);
                                setRemoveSourceAfterMigrate(true);
                                setMigrateModalError(null);
                              }}
                              className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#FDF6EE] border border-[#EADBC8] hover:border-[#F56900] text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                            >
                              <ArrowRightLeft className="w-3.5 h-3.5 text-[#F56900]" />
                              <span>نقل لبديلة</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal 1: Add Shard / Assign DB to Tab(s) */}
      {showTabModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleExecuteTabDbAssign}
              dir="rtl"
              className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92vh] flex flex-col"
            >
              <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-[#F56900]" />
                  <div>
                    <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                      أضف قاعدة بيانات لتبويب (حد 4 جيجابايت لكل قاعدة)
                    </h3>
                    <p className="text-xs text-[#7D4E35]">
                      يمكنك إضافة عدة قواعد بيانات متتالية للتبويب الواحد؛ عند امتلاء 4 جيجابايت تتوقف الأولى وتُفتح الثانية تلقائياً.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTabModal(false)}
                  aria-label="إغلاق"
                  className="p-2 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 sm:p-6 space-y-5">
                {/* Pick Tabs */}
                <div className="space-y-2">
                  <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                    ١. اختر التبويبات المطلوب ربطها بقاعدة البيانات:
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {ALL_TAB_KEYS.map((tk) => {
                      const checked = selectedTabs.includes(tk);
                      const existingCount = workspace.tabPools?.[tk]?.length || 0;
                      return (
                        <button
                          key={tk}
                          type="button"
                          onClick={() =>
                            setSelectedTabs((prev) =>
                              prev.includes(tk) ? prev.filter((x) => x !== tk) : [...prev, tk]
                            )
                          }
                          className={`min-h-[44px] px-3.5 py-2 rounded-xl border-2 text-right font-display text-xs sm:text-sm font-bold flex items-center justify-between gap-2 cursor-pointer ${
                            checked
                              ? 'bg-[#F56900]/10 border-[#F56900] text-[#4A220D]'
                              : 'bg-[#FDF6EE] border-[#EADBC8] text-[#7D4E35]'
                          }`}
                        >
                          <span>
                            {COMPLEX_FEATURE_TAB_LABELS[tk]}
                            {existingCount > 0 ? ` (${existingCount})` : ''}
                          </span>
                          {checked && <Check className="w-4 h-4 text-[#F56900]" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Pick Action Mode */}
                <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
                  <div className="space-y-2">
                    <span className="block font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                      ٢. نوع العملية للقاعدة الهدف:
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 bg-white p-1.5 rounded-xl border border-[#EADBC8]">
                      <button
                        type="button"
                        onClick={() => setTabDestMode('add_shard')}
                        className={`min-h-[38px] px-3 py-1.5 rounded-lg font-display text-xs font-bold cursor-pointer ${
                          tabDestMode === 'add_shard'
                            ? 'bg-[#F56900] text-white'
                            : 'text-[#7D4E35]'
                        }`}
                      >
                        إضافة لسلسلة التبويب (4 GB)
                      </button>
                      <button
                        type="button"
                        onClick={() => setTabDestMode('replace_all_external')}
                        className={`min-h-[38px] px-3 py-1.5 rounded-lg font-display text-xs font-bold cursor-pointer ${
                          tabDestMode === 'replace_all_external'
                            ? 'bg-[#F56900] text-white'
                            : 'text-[#7D4E35]'
                        }`}
                      >
                        توحيد ونقل الكل لقاعدة واحدة
                      </button>
                      <button
                        type="button"
                        onClick={() => setTabDestMode('complex_default')}
                        className={`min-h-[38px] px-3 py-1.5 rounded-lg font-display text-xs font-bold cursor-pointer ${
                          tabDestMode === 'complex_default'
                            ? 'bg-[#F56900] text-white'
                            : 'text-[#7D4E35]'
                        }`}
                      >
                        إعادة لقاعدة المجمع الأساسية
                      </button>
                    </div>
                  </div>

                  {tabDestMode !== 'complex_default' && (
                    <div className="space-y-3">
                      {externalPresets.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-bold text-[#7D4E35]">
                            قواعد مرتبطة مسبقاً:
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {externalPresets.map((dbInfo) => (
                              <button
                                key={dbInfo.key}
                                type="button"
                                onClick={() => {
                                  if (!dbInfo.config) return;
                                  setTabConfigRaw(JSON.stringify(dbInfo.config, null, 2));
                                  setTabDatabaseId(dbInfo.config.firestoreDatabaseId || '');
                                  setTabVerification(null);
                                }}
                                className="min-h-[34px] px-3 py-1 rounded-xl border border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#4A220D] cursor-pointer"
                              >
                                {dbInfo.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <ExternalDbVerifier
                        idPrefix="tab-assign-db"
                        configRaw={tabConfigRaw}
                        databaseId={tabDatabaseId}
                        verification={tabVerification}
                        onConfigRawChange={setTabConfigRaw}
                        onDatabaseIdChange={setTabDatabaseId}
                        onVerificationChange={setTabVerification}
                      />
                    </div>
                  )}
                </div>

                {/* Warning + Confirmation */}
                <div className="bg-[#FFA900]/12 border-2 border-[#FFA900]/45 rounded-2xl p-4 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-5 h-5 text-[#D98A00] shrink-0 mt-0.5" />
                    <p className="text-xs sm:text-sm font-bold text-[#4A220D] leading-relaxed">
                      {tabDestMode === 'add_shard'
                        ? 'عند إضافة أول قاعدة للتبويب سيتم نقل بياناته الحالية إليها وحذفها نهائياً من القاعدة الأم. وعند إضافة قواعد إضافية (مثل ٢ أو ٣ أو ٤ أو ٥) تُحفظ كقواعد جاهزة بسعة 4 جيجابايت لكل قاعدة، وتُفتح تلقائياً بالتسلسل عند امتلاء القاعدة النشطة مع بقاء جميع القواعد السابقة مقروءة.'
                        : 'تنبيه العزل التام: سيتم نقل جميع بيانات التبويبات المختارة لهذا المجمع فقط إلى القاعدة الجديدة وحذفها نهائياً من القاعدة الأم.'}
                    </p>
                  </div>
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs sm:text-sm font-extrabold text-[#4A220D]">
                    <input
                      type="checkbox"
                      checked={confirmTabIsolation}
                      onChange={(e) => setConfirmTabIsolation(e.target.checked)}
                      className="w-4 h-4 accent-[#F56900]"
                    />
                    <span>أؤكد تنفيذ هذا الإجراء وعزل بيانات التبويبات المحددة لهذا المجمع فقط.</span>
                  </label>
                </div>

                {tabModalError && (
                  <div
                    role="alert"
                    className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{tabModalError}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2 border-t-2 border-[#F7EBDD]">
                  <button
                    type="submit"
                    disabled={!confirmTabIsolation}
                    className="duo-btn-orange flex-1 min-h-[46px] rounded-2xl font-display font-extrabold text-sm cursor-pointer disabled:opacity-50"
                  >
                    {tabDestMode === 'add_shard'
                      ? 'إضافة القاعدة للسلسلة الآن'
                      : 'تأكيد ونقل التبويب الآن'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTabModal(false)}
                    className="duo-btn-cream min-h-[46px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* Modal 2: Transfer Any Shard to Its Replacement Database */}
      {migrateTarget &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleExecuteShardMigration}
              dir="rtl"
              className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92vh] flex flex-col"
            >
              <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2">
                  <ArrowRightLeft className="w-5 h-5 text-[#F56900]" />
                  <div>
                    <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                      نقل بيانات القاعدة إلى بديلتها
                    </h3>
                    <p className="text-xs text-[#7D4E35]">
                      التبويب: {COMPLEX_FEATURE_TAB_LABELS[migrateTarget.tabKey]} · المصدر:{' '}
                      {migrateTarget.shard.label}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMigrateTarget(null)}
                  aria-label="إغلاق"
                  className="p-2 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 sm:p-6 space-y-4">
                <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
                  <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                    اختر القاعدة البديلة (أو ألصق بيانات قاعدة جديدة):
                  </p>

                  {/* Other shards in this tab pool or known external DBs */}
                  {externalPresets.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {externalPresets
                        .filter(
                          (d) =>
                            d.config &&
                            buildDbConnectionId(d.config) !== migrateTarget.shard.id
                        )
                        .map((dbInfo) => (
                          <button
                            key={dbInfo.key}
                            type="button"
                            onClick={() => {
                              if (!dbInfo.config) return;
                              setMigrateDestConfigRaw(JSON.stringify(dbInfo.config, null, 2));
                              setMigrateDestDatabaseId(dbInfo.config.firestoreDatabaseId || '');
                              setMigrateVerification(null);
                            }}
                            className="min-h-[34px] px-3 py-1 rounded-xl border border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#4A220D] cursor-pointer"
                          >
                            {dbInfo.label}
                          </button>
                        ))}
                    </div>
                  )}

                  <ExternalDbVerifier
                    idPrefix="shard-migrate-db"
                    configRaw={migrateDestConfigRaw}
                    databaseId={migrateDestDatabaseId}
                    verification={migrateVerification}
                    onConfigRawChange={setMigrateDestConfigRaw}
                    onDatabaseIdChange={setMigrateDestDatabaseId}
                    onVerificationChange={setMigrateVerification}
                  />
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer text-xs sm:text-sm font-bold text-[#4A220D] bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-3">
                  <input
                    type="checkbox"
                    checked={removeSourceAfterMigrate}
                    onChange={(e) => setRemoveSourceAfterMigrate(e.target.checked)}
                    className="w-4 h-4 accent-[#F56900]"
                  />
                  <span>
                    استبدال القاعدة القديمة بالبديلة وحذف النسخ المنقولة من القاعدة المصدر بعد النقل
                  </span>
                </label>

                {migrateModalError && (
                  <div
                    role="alert"
                    className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{migrateModalError}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2 border-t-2 border-[#F7EBDD]">
                  <button
                    type="submit"
                    className="duo-btn-orange flex-1 min-h-[46px] rounded-2xl font-display font-extrabold text-sm cursor-pointer"
                  >
                    بدء النقل إلى القاعدة البديلة
                  </button>
                  <button
                    type="button"
                    onClick={() => setMigrateTarget(null)}
                    className="duo-btn-cream min-h-[46px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* Modal 3: Clone Complex to Backup Database */}
      {showBackupCloneModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleExecuteBackupClone}
              dir="rtl"
              className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92vh] flex flex-col"
            >
              <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2">
                  <HardDriveUpload className="w-5 h-5 text-[#F56900]" />
                  <div>
                    <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                      نسخ قاعدة المجمع لقاعدة احتياطية
                    </h3>
                    <p className="text-xs text-[#7D4E35]">
                      تُنسخ جميع بيانات المجمع الحالية إلى القاعدة الاحتياطية مع بقاء البيانات الحية كما هي دون حذف.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowBackupCloneModal(false)}
                  aria-label="إغلاق"
                  className="p-2 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 sm:p-6 space-y-4">
                <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4">
                  <ExternalDbVerifier
                    idPrefix="backup-clone-db"
                    configRaw={backupConfigRaw}
                    databaseId={backupDatabaseId}
                    verification={backupVerification}
                    onConfigRawChange={setBackupConfigRaw}
                    onDatabaseIdChange={setBackupDatabaseId}
                    onVerificationChange={setBackupVerification}
                  />
                </div>

                {backupCloneError && (
                  <div
                    role="alert"
                    className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-2.5 text-xs font-bold text-[#D95338] flex items-center gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{backupCloneError}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2 border-t-2 border-[#F7EBDD]">
                  <button
                    type="submit"
                    className="duo-btn-green flex-1 min-h-[46px] rounded-2xl font-display font-extrabold text-sm cursor-pointer"
                  >
                    بدء النسخ الاحتياطي للقاعدة
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBackupCloneModal(false)}
                    className="duo-btn-cream min-h-[46px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            </form>
          </div>,
          document.body
        )}
    </div>
  );
};
