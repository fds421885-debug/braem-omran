import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  verifyExternalFirebaseSetup,
  type ExternalDbVerificationResult,
} from '../services/multiDb';
import {
  buildDatabaseBackupBundle,
  executeDatabaseTransfer,
  type ComplexWorkspaceData,
  type DbTransferMode,
  type DbTransferScope,
} from '../services/platformService';
import type {
  ConnectedDatabaseInfo,
  ExternalFirebaseConfig,
} from '../types/platform';
import { ExternalDbVerifier } from './ExternalDbVerifier';
import { ModernLoader } from './ModernLoader';

interface DatabaseTransferModalProps {
  workspace: ComplexWorkspaceData;
  scope: DbTransferScope;
  targetId: string;
  targetName: string;
  currentDbLabel: string;
  connectedDbs: ConnectedDatabaseInfo[];
  onClose: () => void;
  onCompleted: () => void;
}

const SCOPE_TITLE: Record<DbTransferScope, string> = {
  complex: 'المجمع القرآني',
  mosque: 'المسجد',
  halaqa: 'الحلقة',
};

export const DatabaseTransferModal: React.FC<DatabaseTransferModalProps> = ({
  workspace,
  scope,
  targetId,
  targetName,
  currentDbLabel,
  connectedDbs,
  onClose,
  onCompleted,
}) => {
  const [destType, setDestType] = useState<'primary' | 'external'>('external');
  const [configRaw, setConfigRaw] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [verification, setVerification] =
    useState<ExternalDbVerificationResult | null>(null);

  const [mode, setMode] = useState<DbTransferMode>('migrate');
  const [backupDownloaded, setBackupDownloaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const [executing, setExecuting] = useState(false);
  const [execLabel, setExecLabel] = useState('جاري تنفيذ النقل وتنظيف القاعدة القديمة...');
  const [error, setError] = useState<string | null>(null);

  const backupBundle = useMemo(
    () => buildDatabaseBackupBundle({ workspace, scope, targetId }),
    [workspace, scope, targetId]
  );

  const externalPresets = useMemo(
    () => connectedDbs.filter((d) => !d.isPrimary),
    [connectedDbs]
  );

  const handleDownloadJsonBackup = () => {
    try {
      const jsonStr = JSON.stringify(backupBundle, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `baraem-omran-backup-${scope}-${targetId}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupDownloaded(true);
    } catch {
      setError('تعذّر تصدير ملف النسخة الاحتياطية JSON.');
    }
  };

  const handlePickPreset = (dbInfo: ConnectedDatabaseInfo) => {
    if (!dbInfo.config) return;
    setDestType('external');
    setConfigRaw(JSON.stringify(dbInfo.config, null, 2));
    setDatabaseId(dbInfo.config.firestoreDatabaseId || '');
    setVerification(null);
  };

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!confirmed) {
      setError('يرجى وضع علامة تأكيد الاختيار قبل تنفيذ النقل أو الحذف.');
      return;
    }

    setExecuting(true);
    try {
      let targetConfig: ExternalFirebaseConfig | null = null;

      if (destType === 'external') {
        let ver = verification;
        if (!ver) {
          setExecLabel('جاري فحص واعتماد قاعدة البيانات الجديدة...');
          ver = await verifyExternalFirebaseSetup(configRaw, databaseId);
          setVerification(ver);
        }
        if (!ver.approved || !ver.config) {
          setError('قاعدة البيانات الجديدة غير معتمدة بعد؛ راجع نتائج الفحص ثم أعد المحاولة.');
          setExecuting(false);
          return;
        }
        targetConfig = ver.config;
      }

      setExecLabel(
        mode === 'migrate'
          ? 'جاري نقل جميع البيانات للقاعدة الجديدة وحذفها من القديمة...'
          : 'جاري حذف البيانات القديمة وتهيئة القاعدة الجديدة...'
      );

      await executeDatabaseTransfer({
        workspace,
        scope,
        targetId,
        targetConfig,
        mode,
      });

      onCompleted();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'تعذّر تغيير أو نقل قاعدة البيانات.'
      );
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="db-transfer-title"
    >
      <div className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <Database className="w-5 h-5 text-[#F56900]" />
            <div>
              <h2 id="db-transfer-title" className="font-display text-lg font-extrabold text-[#4A220D]">
                تغيير أو نقل قاعدة بيانات {SCOPE_TITLE[scope]}
              </h2>
              <p className="text-xs font-bold text-[#7D4E35]">
                {targetName} · القاعدة الحالية: {currentDbLabel}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {executing ? (
          <div className="p-8">
            <ModernLoader label={execLabel} />
          </div>
        ) : (
          <form onSubmit={handleExecute} className="overflow-y-auto p-5 sm:p-6 space-y-5">
            {/* Scope Data Summary */}
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-2">
              <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D]">
                ملخص البيانات المرتبطة حالياً بهذا القسم:
              </p>
              <div className="flex flex-wrap gap-2 text-xs font-bold text-[#7D4E35]">
                {scope === 'complex' && (
                  <span className="bg-white border border-[#EADBC8] px-2.5 py-1 rounded-xl">
                    المساجد: {backupBundle.mosques.length}
                  </span>
                )}
                {scope !== 'halaqa' && (
                  <span className="bg-white border border-[#EADBC8] px-2.5 py-1 rounded-xl">
                    الحلقات: {backupBundle.halaqat.length}
                  </span>
                )}
                <span className="bg-white border border-[#EADBC8] px-2.5 py-1 rounded-xl">
                  الحسابات: {backupBundle.accounts.length}
                </span>
                <span className="bg-white border border-[#EADBC8] px-2.5 py-1 rounded-xl">
                  روابط التسجيل: {backupBundle.inviteLinks.length}
                </span>
                <span className="bg-white border border-[#EADBC8] px-2.5 py-1 rounded-xl">
                  روابط الدخول السريع: {backupBundle.quickLinks.length}
                </span>
              </div>
            </div>

            {/* Step 1: JSON Backup Advisory */}
            <div className="bg-[#FFA900]/12 border-2 border-[#FFA900]/40 rounded-2xl p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-[#D98A00] shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-display text-sm font-extrabold text-[#4A220D]">
                    نصيحة هامة: احتفظ بنسخة احتياطية (JSON) قبل التغيير
                  </p>
                  <p className="text-xs text-[#7D4E35] leading-relaxed">
                    ننصحك بتنزيل نسخة احتياطية كاملة بصيغة JSON قبل نقل أو حذف البيانات من القاعدة القديمة لضمان حفظ جميع السجلات لديك.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDownloadJsonBackup}
                className="duo-btn-cream min-h-[42px] px-4 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-2 cursor-pointer"
              >
                {backupDownloaded ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-[#58CC02]" />
                    <span className="text-[#46A302]">تم تحميل النسخة الاحتياطية (JSON)</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 text-[#F56900]" />
                    <span>تحميل نسخة احتياطية (JSON)</span>
                  </>
                )}
              </button>
            </div>

            {/* Step 2: Select New Target Database */}
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-display text-sm font-extrabold text-[#4A220D]">
                  اختر قاعدة البيانات الجديدة
                </span>
                <div className="flex items-center gap-1.5 bg-white p-1 rounded-xl border border-[#EADBC8]">
                  <button
                    type="button"
                    onClick={() => setDestType('primary')}
                    className={`min-h-[36px] px-3 py-1 rounded-lg font-display text-xs font-bold cursor-pointer ${
                      destType === 'primary'
                        ? 'bg-[#F56900] text-white'
                        : 'text-[#7D4E35] hover:text-[#4A220D]'
                    }`}
                  >
                    القاعدة الأساسية
                  </button>
                  <button
                    type="button"
                    onClick={() => setDestType('external')}
                    className={`min-h-[36px] px-3 py-1 rounded-lg font-display text-xs font-bold cursor-pointer ${
                      destType === 'external'
                        ? 'bg-[#F56900] text-white'
                        : 'text-[#7D4E35] hover:text-[#4A220D]'
                    }`}
                  >
                    قاعدة Firebase أخرى
                  </button>
                </div>
              </div>

              {destType === 'external' && (
                <div className="space-y-3">
                  {externalPresets.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-bold text-[#7D4E35]">
                        اختيار سريع من القواعد المضافة:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {externalPresets.map((dbInfo) => (
                          <button
                            key={dbInfo.key}
                            type="button"
                            onClick={() => handlePickPreset(dbInfo)}
                            className="min-h-[34px] px-3 py-1 rounded-xl border border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#4A220D] cursor-pointer"
                          >
                            {dbInfo.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <ExternalDbVerifier
                    idPrefix={`transfer-${scope}-${targetId}`}
                    configRaw={configRaw}
                    databaseId={databaseId}
                    verification={verification}
                    onConfigRawChange={setConfigRaw}
                    onDatabaseIdChange={setDatabaseId}
                    onVerificationChange={setVerification}
                  />
                </div>
              )}
            </div>

            {/* Step 3: Choose Migrate vs Delete Old */}
            <div className="space-y-2.5">
              <p className="font-display text-sm font-extrabold text-[#4A220D]">
                ماذا تريد أن تفعل بالبيانات السابقة؟
              </p>

              <label
                className={`flex items-start gap-3 p-3.5 rounded-2xl border-2 cursor-pointer transition-colors ${
                  mode === 'migrate'
                    ? 'bg-[#58CC02]/10 border-[#58CC02]'
                    : 'bg-white border-[#EADBC8]'
                }`}
              >
                <input
                  type="radio"
                  name="transfer-mode"
                  checked={mode === 'migrate'}
                  onChange={() => setMode('migrate')}
                  className="mt-1 w-4 h-4 accent-[#58CC02]"
                />
                <div className="space-y-0.5">
                  <p className="font-display text-sm font-extrabold text-[#4A220D] flex items-center gap-1.5">
                    <RefreshCw className="w-4 h-4 text-[#46A302]" />
                    <span>الحفاظ على البيانات ونقلها للقاعدة الجديدة وحذفها من القديمة</span>
                  </p>
                  <p className="text-xs text-[#7D4E35]">
                    يتم نسخ جميع الحسابات والمساجد والحلقات والروابط إلى القاعدة الجديدة ثم حذفها تماماً من القاعدة القديمة.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 p-3.5 rounded-2xl border-2 cursor-pointer transition-colors ${
                  mode === 'delete_old'
                    ? 'bg-[#D95338]/10 border-[#D95338]'
                    : 'bg-white border-[#EADBC8]'
                }`}
              >
                <input
                  type="radio"
                  name="transfer-mode"
                  checked={mode === 'delete_old'}
                  onChange={() => setMode('delete_old')}
                  className="mt-1 w-4 h-4 accent-[#D95338]"
                />
                <div className="space-y-0.5">
                  <p className="font-display text-sm font-extrabold text-[#D95338] flex items-center gap-1.5">
                    <Trash2 className="w-4 h-4" />
                    <span>حذف البيانات القديمة والبدء من جديد على القاعدة الجديدة</span>
                  </p>
                  <p className="text-xs text-[#7D4E35]">
                    يتم حذف جميع الحسابات والسجلات السابقة من القاعدة القديمة نهائياً دون نقلها، والبدء ببيانات فارغة على القاعدة الجديدة.
                  </p>
                </div>
              </label>
            </div>

            {/* Step 4: Explicit Confirmation Checkbox */}
            <label className="flex items-start gap-3 p-3.5 rounded-2xl bg-[#FDF6EE] border-2 border-[#EADBC8] cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#F56900]"
              />
              <span className="text-xs sm:text-sm font-bold text-[#4A220D] leading-relaxed">
                أؤكد اختياري المحدد أعلاه (
                {mode === 'migrate'
                  ? 'نقل جميع البيانات للقاعدة الجديدة وحذفها من القديمة'
                  : 'حذف البيانات القديمة نهائياً دون نقل'}
                )، وأتحمل مسؤولية تنفيذ هذا التغيير.
              </span>
            </label>

            {error && (
              <div
                role="alert"
                className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-3 text-sm font-bold text-[#D95338] flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center gap-3 pt-2 border-t-2 border-[#F7EBDD]">
              <button
                type="submit"
                disabled={!confirmed}
                className="duo-btn-orange flex-1 min-h-[48px] px-6 rounded-2xl font-display font-extrabold text-sm sm:text-base cursor-pointer disabled:opacity-50"
              >
                تأكيد وتنفيذ تغيير القاعدة
              </button>
              <button
                type="button"
                onClick={onClose}
                className="duo-btn-cream min-h-[48px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
