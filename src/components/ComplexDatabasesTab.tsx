import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import JSZip from 'jszip';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  FileJson,
  HardDriveUpload,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  getDbDisplayLabel,
  verifyExternalFirebaseSetup,
  type ExternalDbVerificationResult,
} from '../services/multiDb';
import {
  assignExternalDbToComplexTabs,
  buildDatabaseBackupBundle,
  cloneComplexToBackupDatabase,
  exportAllComplexBackupFiles,
  exportComplexTabJsonPayload,
  getDbLabelForComplexTab,
  importComplexTabJsonPayload,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  COMPLEX_FEATURE_TAB_LABELS,
  type ComplexFeatureTabKey,
  type ConnectedDatabaseInfo,
  type ExternalFirebaseConfig,
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

export const ComplexDatabasesTab: React.FC<ComplexDatabasesTabProps> = ({
  workspace,
  connectedDbs,
  onOpenComplexDbTransferModal,
  onWorkspaceUpdated,
}) => {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Add/Assign DB to Tab Modal state
  const [showTabModal, setShowTabModal] = useState(false);
  const [selectedTabs, setSelectedTabs] = useState<ComplexFeatureTabKey[]>(['attendance']);
  const [tabDestMode, setTabDestMode] = useState<'external' | 'complex_default'>('external');
  const [tabConfigRaw, setTabConfigRaw] = useState('');
  const [tabDatabaseId, setTabDatabaseId] = useState('');
  const [tabVerification, setTabVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [confirmTabIsolation, setConfirmTabIsolation] = useState(false);
  const [tabModalError, setTabModalError] = useState<string | null>(null);

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

  const openAssignTabModal = (initialTab?: ComplexFeatureTabKey) => {
    setSelectedTabs(initialTab ? [initialTab] : ['attendance']);
    setTabDestMode('external');
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
      setTabModalError('يرجى وضع علامة التأكيد قبل نقل وحذف بيانات التبويب من القاعدة الأم.');
      return;
    }

    let targetConfig: ExternalFirebaseConfig | null = null;
    if (tabDestMode === 'external') {
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
      'جاري نقل بيانات التبويب المختار حصراً لهذا المجمع وحذفها نهائياً من القاعدة الأم...'
    );
    try {
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
          tabDestMode === 'external'
            ? `تم نقل (${movedDocsCount}) سجل للتبويبات المحددة إلى القاعدة الخارجية وحذفها نهائياً من القاعدة الأم. جميع العمليات الآن تعمل على القاعدة المعزولة فقط.`
            : `تمت إعادة (${movedDocsCount}) سجل للتبويبات المحددة إلى قاعدة المجمع الأساسية بنجاح.`,
      });
    } catch (err) {
      setTabModalError(err instanceof Error ? err.message : 'تعذّر ربط التبويب بقاعدة البيانات.');
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
            onClick={() => openAssignTabModal()}
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

      {/* Section 2: Per-Tab Database Isolation & Individual JSON Export/Import */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#F7EBDD]">
          <div>
            <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
              قواعد البيانات المخصصة للتبويبات والنسخ الفردي (JSON)
            </h3>
            <p className="text-xs text-[#7D4E35]">
              عند ربط أي تبويب بقاعدة بيانات خاصة، تُنقل بيانات هذا التبويب فقط لهذا المجمع وتُحذف تماماً من القاعدة الأم وتعمل حصراً على قاعدته المستقلة.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {ALL_TAB_KEYS.map((tabKey) => {
            const label = COMPLEX_FEATURE_TAB_LABELS[tabKey];
            const isCustomExternal = Boolean(workspace.tabConfigMap?.[tabKey]);
            const dbLabel = getDbLabelForComplexTab(workspace, tabKey);

            return (
              <div
                key={tabKey}
                className={`rounded-2xl border-2 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 ${
                  isCustomExternal
                    ? 'bg-[#58CC02]/8 border-[#58CC02]'
                    : 'bg-[#FDF6EE] border-[#EADBC8]'
                }`}
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display font-extrabold text-sm sm:text-base text-[#4A220D]">
                      {label}
                    </span>
                    {isCustomExternal ? (
                      <span className="text-[11px] font-extrabold text-[#46A302] bg-white border border-[#58CC02] px-2.5 py-0.5 rounded-lg inline-flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        معزول على قاعدة مستقلة
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
                    onClick={() => openAssignTabModal(tabKey)}
                    className="duo-btn-cream min-h-[38px] px-3 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Database className="w-3.5 h-3.5 text-[#F56900]" />
                    <span>تعيين قاعدة للتبويب</span>
                  </button>

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
            );
          })}
        </div>
      </div>

      {/* Modal 1: Assign DB to Tab(s) */}
      {showTabModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
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
                      أضف قاعدة بيانات لتبويب
                    </h3>
                    <p className="text-xs text-[#7D4E35]">
                      عزل تبويب أو أكثر لهذا المجمع فقط ونقل جميع سجلاته للقاعدة المختارة.
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
                          <span>{COMPLEX_FEATURE_TAB_LABELS[tk]}</span>
                          {checked && <Check className="w-4 h-4 text-[#F56900]" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Pick Destination DB */}
                <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                      ٢. اختر القاعدة الهدف للتبويبات المحددة:
                    </span>
                    <div className="flex items-center gap-1.5 bg-white p-1 rounded-xl border border-[#EADBC8]">
                      <button
                        type="button"
                        onClick={() => setTabDestMode('external')}
                        className={`min-h-[34px] px-3 py-1 rounded-lg font-display text-xs font-bold cursor-pointer ${
                          tabDestMode === 'external'
                            ? 'bg-[#F56900] text-white'
                            : 'text-[#7D4E35]'
                        }`}
                      >
                        قاعدة Firebase منفصلة
                      </button>
                      <button
                        type="button"
                        onClick={() => setTabDestMode('complex_default')}
                        className={`min-h-[34px] px-3 py-1 rounded-lg font-display text-xs font-bold cursor-pointer ${
                          tabDestMode === 'complex_default'
                            ? 'bg-[#F56900] text-white'
                            : 'text-[#7D4E35]'
                        }`}
                      >
                        قاعدة المجمع الأساسية
                      </button>
                    </div>
                  </div>

                  {tabDestMode === 'external' && (
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
                      تنبيه العزل التام: سيتم نقل جميع بيانات التبويبات المختارة لهذا المجمع فقط إلى القاعدة الجديدة وحذفها نهائياً من القاعدة الأم، ولن تُقرأ أو تُحفظ أي بيانات لهذا التبويب في القاعدة الأم بعد الآن.
                    </p>
                  </div>
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs sm:text-sm font-extrabold text-[#4A220D]">
                    <input
                      type="checkbox"
                      checked={confirmTabIsolation}
                      onChange={(e) => setConfirmTabIsolation(e.target.checked)}
                      className="w-4 h-4 accent-[#F56900]"
                    />
                    <span>أؤكد نقل التبويبات المحددة وحذف نسخها من القاعدة الأم نهائياً.</span>
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
                    تأكيد ونقل التبويب الآن
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

      {/* Modal 2: Clone Complex to Backup Database */}
      {showBackupCloneModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
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
