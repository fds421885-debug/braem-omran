import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Firestore } from 'firebase/firestore';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  generateValidId,
  parseFirebaseConfigInput,
  verifyExternalFirebaseSetup,
  type ExternalDbVerificationResult,
} from '../services/multiDb';
import {
  buildDatabaseBackupBundle,
  saveComplexWithStructure,
  type ComplexWorkspaceData,
  type DbTransferMode,
  type DiscoveredComplex,
  type MosqueDraft,
} from '../services/platformService';
import type {
  ConnectedDatabaseInfo,
  ExternalFirebaseConfig,
  HalaqaRecord,
  MosqueRecord,
} from '../types/platform';
import { ExternalDbVerifier } from './ExternalDbVerifier';
import { ModernLoader } from './ModernLoader';

interface ComplexEditorModalProps {
  adminUid: string;
  connectedExternalDbs: ConnectedDatabaseInfo[];
  editingComplex?: DiscoveredComplex | null;
  existingWorkspace?: ComplexWorkspaceData | null;
  existingMosques?: MosqueRecord[];
  existingHalaqat?: HalaqaRecord[];
  existingMosqueDbMap?: Record<string, Firestore>;
  existingMosqueConfigMap?: Record<string, ExternalFirebaseConfig | null>;
  onClose: () => void;
  onSaved: () => void;
}

function resolveDbSignature(
  useExternal: boolean,
  rawConfig: string,
  dbId: string,
  fallbackSignature: string
): string {
  if (!useExternal) return fallbackSignature;
  const parsed = parseFirebaseConfigInput(rawConfig, dbId);
  if (!parsed.config) return 'ext:unparsed';
  return `ext:${parsed.config.projectId}:${parsed.config.firestoreDatabaseId || '(default)'}`;
}

export const ComplexEditorModal: React.FC<ComplexEditorModalProps> = ({
  adminUid,
  connectedExternalDbs,
  editingComplex,
  existingWorkspace = null,
  existingMosques = [],
  existingHalaqat = [],
  existingMosqueDbMap = {},
  existingMosqueConfigMap = {},
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState(editingComplex?.name || '');
  const [usesExternalDb, setUsesExternalDb] = useState(
    editingComplex?.isExternal || false
  );
  const [externalConfigRaw, setExternalConfigRaw] = useState(
    editingComplex?.ownerConfig ? JSON.stringify(editingComplex.ownerConfig, null, 2) : ''
  );
  const [complexDatabaseId, setComplexDatabaseId] = useState(
    editingComplex?.ownerConfig?.firestoreDatabaseId || ''
  );
  const [complexVerification, setComplexVerification] =
    useState<ExternalDbVerificationResult | null>(null);

  const [mosques, setMosques] = useState<MosqueDraft[]>(() => {
    if (existingMosques.length > 0) {
      return existingMosques.map((m) => {
        const mConf = existingMosqueConfigMap[m.id] || null;
        const isDifferentFromComplex =
          !!mConf &&
          (!editingComplex?.ownerConfig ||
            mConf.projectId !== editingComplex.ownerConfig.projectId ||
            (mConf.firestoreDatabaseId || '') !==
              (editingComplex.ownerConfig.firestoreDatabaseId || ''));
        return {
          id: m.id,
          name: m.name,
          usesExternalDb: m.usesExternalDb && isDifferentFromComplex,
          externalConfigRaw:
            m.usesExternalDb && isDifferentFromComplex && mConf
              ? JSON.stringify(mConf, null, 2)
              : '',
          externalDatabaseId:
            m.usesExternalDb && isDifferentFromComplex && mConf
              ? mConf.firestoreDatabaseId || ''
              : '',
          parsedConfig: isDifferentFromComplex ? mConf : null,
          halaqat: existingHalaqat
            .filter((h) => h.mosqueId === m.id)
            .map((h) => ({ id: h.id, name: h.name })),
        };
      });
    }
    return [
      {
        id: generateValidId('msq'),
        name: '',
        usesExternalDb: false,
        externalConfigRaw: '',
        externalDatabaseId: '',
        parsedConfig: null,
        halaqat: [{ id: generateValidId('hlq'), name: '' }],
      },
    ];
  });

  const [mosqueVerifications, setMosqueVerifications] = useState<
    Record<string, ExternalDbVerificationResult | null>
  >({});

  const [dbChangeMode, setDbChangeMode] = useState<DbTransferMode>('migrate');
  const [backupDownloaded, setBackupDownloaded] = useState(false);
  const [confirmedDbChange, setConfirmedDbChange] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savingLabel, setSavingLabel] = useState('جاري حفظ المجمع والمساجد والحلقات...');
  const [error, setError] = useState<string | null>(null);

  const dbChangeAnalysis = useMemo(() => {
    if (!editingComplex) {
      return { hasDbChange: false, isComplexDbChanged: false, changedMosqueIds: [] as string[] };
    }
    const oldComplexSig =
      editingComplex.isExternal && editingComplex.ownerConfig
        ? `ext:${editingComplex.ownerConfig.projectId}:${editingComplex.ownerConfig.firestoreDatabaseId || '(default)'}`
        : 'primary';
    const newComplexSig = resolveDbSignature(
      usesExternalDb,
      externalConfigRaw,
      complexDatabaseId,
      'primary'
    );
    const isComplexDbChanged = newComplexSig !== oldComplexSig;

    const existingIds = new Set(existingMosques.map((m) => m.id));
    const changedMosqueIds: string[] = [];
    for (const m of mosques) {
      if (!existingIds.has(m.id)) continue;
      const oldMConf = existingMosqueConfigMap[m.id] || null;
      const oldMSig = oldMConf
        ? `ext:${oldMConf.projectId}:${oldMConf.firestoreDatabaseId || '(default)'}`
        : 'primary';
      const newMSig = resolveDbSignature(
        m.usesExternalDb,
        m.externalConfigRaw,
        m.externalDatabaseId || '',
        newComplexSig
      );
      if (newMSig !== oldMSig) {
        changedMosqueIds.push(m.id);
      }
    }

    return {
      hasDbChange: isComplexDbChanged || changedMosqueIds.length > 0,
      isComplexDbChanged,
      changedMosqueIds,
    };
  }, [
    editingComplex,
    usesExternalDb,
    externalConfigRaw,
    complexDatabaseId,
    mosques,
    existingMosques,
    existingMosqueConfigMap,
  ]);

  const handleDownloadJsonBackup = () => {
    if (!editingComplex) return;
    try {
      const bundle = existingWorkspace
        ? buildDatabaseBackupBundle({
            workspace: existingWorkspace,
            scope: 'complex',
            targetId: editingComplex.id,
          })
        : {
            exportedAt: new Date().toISOString(),
            platform: 'براعم عمران',
            scope: 'complex',
            targetId: editingComplex.id,
            targetName: editingComplex.name,
            sourceDbLabel: editingComplex.ownerDbLabel,
            complex: editingComplex.complex,
            mosques: existingMosques,
            halaqat: existingHalaqat,
            accounts: [],
            inviteLinks: [],
            quickLinks: [],
          };

      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `baraem-omran-backup-${editingComplex.id}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupDownloaded(true);
    } catch {
      setError('تعذّر تصدير ملف النسخة الاحتياطية JSON.');
    }
  };

  const handleAddMosque = () => {
    setMosques((prev) => [
      ...prev,
      {
        id: generateValidId('msq'),
        name: '',
        usesExternalDb: false,
        externalConfigRaw: '',
        externalDatabaseId: '',
        parsedConfig: null,
        halaqat: [{ id: generateValidId('hlq'), name: '' }],
      },
    ]);
  };

  const handleRemoveMosque = (mosqueId: string) => {
    setMosques((prev) => prev.filter((m) => m.id !== mosqueId));
  };

  const handleUpdateMosque = (mosqueId: string, patch: Partial<MosqueDraft>) => {
    setMosques((prev) =>
      prev.map((m) => (m.id === mosqueId ? { ...m, ...patch } : m))
    );
  };

  const handleAddHalaqa = (mosqueId: string) => {
    setMosques((prev) =>
      prev.map((m) =>
        m.id === mosqueId
          ? {
              ...m,
              halaqat: [...m.halaqat, { id: generateValidId('hlq'), name: '' }],
            }
          : m
      )
    );
  };

  const handleUpdateHalaqaName = (mosqueId: string, halaqaId: string, value: string) => {
    setMosques((prev) =>
      prev.map((m) =>
        m.id === mosqueId
          ? {
              ...m,
              halaqat: m.halaqat.map((h) =>
                h.id === halaqaId ? { ...h, name: value } : h
              ),
            }
          : m
      )
    );
  };

  const handleRemoveHalaqa = (mosqueId: string, halaqaId: string) => {
    setMosques((prev) =>
      prev.map((m) =>
        m.id === mosqueId
          ? { ...m, halaqat: m.halaqat.filter((h) => h.id !== halaqaId) }
          : m
      )
    );
  };

  const handlePickPresetDbForComplex = (dbInfo: ConnectedDatabaseInfo) => {
    if (!dbInfo.config) return;
    setExternalConfigRaw(JSON.stringify(dbInfo.config, null, 2));
    setComplexDatabaseId(dbInfo.config.firestoreDatabaseId || '');
    setComplexVerification(null);
  };

  const handlePickPresetDbForMosque = (mosqueId: string, dbInfo: ConnectedDatabaseInfo) => {
    if (!dbInfo.config) return;
    handleUpdateMosque(mosqueId, {
      externalConfigRaw: JSON.stringify(dbInfo.config, null, 2),
      externalDatabaseId: dbInfo.config.firestoreDatabaseId || '',
    });
    setMosqueVerifications((prev) => ({ ...prev, [mosqueId]: null }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (dbChangeAnalysis.hasDbChange && !confirmedDbChange) {
      setError(
        'تم تغيير قاعدة البيانات؛ يرجى اختيار الحفاظ على البيانات أو حذفها وتأكيد الاختيار قبل الحفظ.'
      );
      return;
    }

    setSaving(true);

    try {
      if (usesExternalDb) {
        let ver = complexVerification;
        if (!ver) {
          setSavingLabel('جاري فحص واعتماد قاعدة بيانات المجمع...');
          ver = await verifyExternalFirebaseSetup(externalConfigRaw, complexDatabaseId);
          setComplexVerification(ver);
        }
        if (!ver.approved) {
          setError(
            'لم يتم اعتماد قاعدة بيانات المجمع بعد؛ راجع نتائج الفحص أعلاه وأكمل الإعدادات الناقصة ثم أعد الفحص.'
          );
          setSaving(false);
          return;
        }
      }

      for (const m of mosques) {
        if (m.usesExternalDb) {
          let mVer = mosqueVerifications[m.id] || null;
          if (!mVer) {
            setSavingLabel(`جاري فحص واعتماد قاعدة مسجد "${m.name || 'جديد'}"...`);
            mVer = await verifyExternalFirebaseSetup(
              m.externalConfigRaw,
              m.externalDatabaseId
            );
            setMosqueVerifications((prev) => ({ ...prev, [m.id]: mVer }));
          }
          if (!mVer.approved) {
            setError(
              `قاعدة بيانات مسجد "${m.name || 'المحدد'}" غير معتمدة بعد؛ راجع نتائج الفحص الخاصة به.`
            );
            setSaving(false);
            return;
          }
        }
      }

      const mosqueMigrationModes: Record<string, DbTransferMode> = {};
      for (const mId of dbChangeAnalysis.changedMosqueIds) {
        mosqueMigrationModes[mId] = dbChangeMode;
      }

      setSavingLabel(
        dbChangeAnalysis.hasDbChange
          ? dbChangeMode === 'migrate'
            ? 'جاري نقل البيانات للقاعدة الجديدة وحذفها من القديمة...'
            : 'جاري حذف البيانات القديمة وتحديث القاعدة...'
          : 'تمت الموافقة! جاري حفظ المجمع على قاعدته المستقلة...'
      );
      await saveComplexWithStructure({
        adminUid,
        complexId: editingComplex?.id,
        name,
        usesExternalDb,
        externalConfigRaw,
        complexDatabaseId,
        mosques,
        previousOwnerDb: editingComplex?.ownerDb || null,
        previousMosqueDbMap: existingMosqueDbMap,
        complexMigrationMode: dbChangeAnalysis.isComplexDbChanged ? dbChangeMode : undefined,
        mosqueMigrationModes,
      });
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'حدث خطأ أثناء حفظ بيانات المجمع.'
      );
    } finally {
      setSaving(false);
    }
  };

  const modalContent = (
    <div
      dir="rtl"
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="complex-editor-title"
    >
      <div className="w-full sm:max-w-3xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92dvh] pb-safe flex flex-col">
        <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-4 shrink-0">
          <h2 id="complex-editor-title" className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
            {editingComplex ? 'تعديل المجمع القرآني' : 'إنشاء مجمع قرآني جديد'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {saving ? (
          <div className="p-8">
            <ModernLoader label={savingLabel} />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="overflow-y-auto p-5 sm:p-6 space-y-6">
            <div>
              <label htmlFor="complex-name" className="block font-display text-sm font-bold text-[#4A220D] mb-2">
                اسم المجمع القرآني
              </label>
              <input
                id="complex-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: مجمع عمران القرآني"
                maxLength={120}
                required
                className="w-full min-h-[48px] px-4 py-2.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-[#4A220D] font-medium focus:outline-none focus:border-[#F56900] focus:bg-white"
              />
            </div>

            {/* External Firebase DB Option for Complex */}
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-[#F56900]" />
                  <span className="font-display font-bold text-sm text-[#4A220D]">
                    قاعدة بيانات المجمع
                  </span>
                </div>
                <div className="flex items-center gap-1.5 bg-white p-1 rounded-xl border border-[#EADBC8]">
                  <button
                    type="button"
                    onClick={() => setUsesExternalDb(false)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-lg font-display text-xs font-bold cursor-pointer ${
                      !usesExternalDb
                        ? 'bg-[#F56900] text-white'
                        : 'text-[#7D4E35] hover:text-[#4A220D]'
                    }`}
                  >
                    القاعدة الأساسية
                  </button>
                  <button
                    type="button"
                    onClick={() => setUsesExternalDb(true)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-lg font-display text-xs font-bold cursor-pointer ${
                      usesExternalDb
                        ? 'bg-[#F56900] text-white'
                        : 'text-[#7D4E35] hover:text-[#4A220D]'
                    }`}
                  >
                    ربط بقاعدة بيانات منفصلة
                  </button>
                </div>
              </div>

              {usesExternalDb && (
                <div className="space-y-3">
                  <p className="text-xs font-bold text-[#46A302]">
                    عزل تام: سيتم حفظ وقراءة وتعديل جميع بيانات هذا المجمع حصراً على قاعدته المنفصلة دون أي تخزين أو كتابة في القاعدة الأساسية.
                  </p>

                  {connectedExternalDbs.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-bold text-[#7D4E35]">
                        اختر قاعدة مرتبطة مسبقاً أو الصق كود قاعدة جديدة:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {connectedExternalDbs.map((dbInfo) => (
                          <button
                            key={dbInfo.key}
                            type="button"
                            onClick={() => handlePickPresetDbForComplex(dbInfo)}
                            className="min-h-[36px] px-3 py-1 rounded-xl border border-[#EADBC8] bg-white hover:border-[#F56900] text-xs font-bold text-[#4A220D] cursor-pointer"
                          >
                            {dbInfo.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <ExternalDbVerifier
                    idPrefix="complex-ext"
                    configRaw={externalConfigRaw}
                    databaseId={complexDatabaseId}
                    verification={complexVerification}
                    onConfigRawChange={setExternalConfigRaw}
                    onDatabaseIdChange={setComplexDatabaseId}
                    onVerificationChange={setComplexVerification}
                  />
                </div>
              )}
            </div>

            {/* Mosques & Halaqat Builder */}
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-base font-extrabold text-[#4A220D]">
                  المساجد والحلقات التابعة للمجمع
                </h3>
                <button
                  type="button"
                  onClick={handleAddMosque}
                  className="duo-btn-cream min-h-[42px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4 text-[#F56900]" />
                  <span>إضافة مسجد</span>
                </button>
              </div>

              <div className="space-y-4">
                {mosques.map((mosque, mIdx) => (
                  <div
                    key={mosque.id}
                    className="bg-[#FDF6EE]/70 border-2 border-[#EADBC8] rounded-2xl p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-display text-xs font-extrabold text-[#F56900]">
                        مسجد {mIdx + 1}
                      </span>
                      {mosques.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveMosque(mosque.id)}
                          className="min-h-[36px] px-2.5 rounded-lg text-xs font-bold text-[#D95338] hover:bg-[#D95338]/10 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>حذف المسجد</span>
                        </button>
                      )}
                    </div>

                    <input
                      type="text"
                      value={mosque.name}
                      onChange={(e) =>
                        handleUpdateMosque(mosque.id, { name: e.target.value })
                      }
                      placeholder="اسم المسجد (مثال: مسجد النور)"
                      maxLength={120}
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-medium text-[#4A220D] focus:outline-none focus:border-[#F56900]"
                    />

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <label className="inline-flex items-center gap-2 text-xs font-bold text-[#7D4E35] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={mosque.usesExternalDb}
                          onChange={(e) =>
                            handleUpdateMosque(mosque.id, {
                              usesExternalDb: e.target.checked,
                            })
                          }
                          className="w-4 h-4 accent-[#F56900]"
                        />
                        <span>ربط هذا المسجد بقاعدة بيانات منفصلة عن المجمع</span>
                      </label>
                    </div>

                    {mosque.usesExternalDb && (
                      <div className="bg-white/80 border border-[#EADBC8] rounded-xl p-3 space-y-2.5">
                        {connectedExternalDbs.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {connectedExternalDbs.map((dbInfo) => (
                              <button
                                key={dbInfo.key}
                                type="button"
                                onClick={() => handlePickPresetDbForMosque(mosque.id, dbInfo)}
                                className="min-h-[32px] px-2.5 py-1 rounded-lg border border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-[11px] font-bold text-[#4A220D] cursor-pointer"
                              >
                                {dbInfo.label}
                              </button>
                            ))}
                          </div>
                        )}
                        <ExternalDbVerifier
                          idPrefix={`mosque-${mosque.id}`}
                          configRaw={mosque.externalConfigRaw}
                          databaseId={mosque.externalDatabaseId || ''}
                          verification={mosqueVerifications[mosque.id] || null}
                          onConfigRawChange={(val) =>
                            handleUpdateMosque(mosque.id, { externalConfigRaw: val })
                          }
                          onDatabaseIdChange={(val) =>
                            handleUpdateMosque(mosque.id, { externalDatabaseId: val })
                          }
                          onVerificationChange={(res) =>
                            setMosqueVerifications((prev) => ({
                              ...prev,
                              [mosque.id]: res,
                            }))
                          }
                        />
                      </div>
                    )}

                    <div className="pt-2 border-t border-[#EADBC8] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-[#4A220D]">
                          حلقات هذا المسجد
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAddHalaqa(mosque.id)}
                          className="text-xs font-bold text-[#F56900] hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>إضافة حلقة</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {mosque.halaqat.map((hlq, hIdx) => (
                          <div key={hlq.id} className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={hlq.name}
                              onChange={(e) =>
                                handleUpdateHalaqaName(mosque.id, hlq.id, e.target.value)
                              }
                              placeholder={`حلقة ${hIdx + 1}`}
                              maxLength={120}
                              className="flex-1 min-h-[42px] px-3 py-1.5 rounded-xl border border-[#EADBC8] bg-white text-xs sm:text-sm text-[#4A220D] focus:outline-none focus:border-[#F56900]"
                            />
                            {mosque.halaqat.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveHalaqa(mosque.id, hlq.id)}
                                aria-label="حذف الحلقة"
                                className="min-w-[38px] min-h-[38px] rounded-xl text-[#D95338] hover:bg-[#D95338]/10 flex items-center justify-center cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {dbChangeAnalysis.hasDbChange && (
              <div className="bg-[#FFA900]/10 border-2 border-[#FFA900]/45 rounded-2xl p-4 space-y-3.5">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-5 h-5 text-[#D98A00] shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-display text-sm font-extrabold text-[#4A220D]">
                      تم رصد تغيير في إعدادات قاعدة بيانات Firebase — حدّد مصير البيانات السابقة
                    </p>
                    <p className="text-xs text-[#7D4E35] leading-relaxed">
                      ننصحك أولاً بتنزيل نسخة احتياطية كاملة بصيغة JSON قبل نقل البيانات للقاعدة الجديدة أو حذفها من القاعدة القديمة.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleDownloadJsonBackup}
                  className="duo-btn-cream min-h-[40px] px-4 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-2 cursor-pointer"
                >
                  {backupDownloaded ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-[#58CC02]" />
                      <span className="text-[#46A302]">تم تنزيل النسخة الاحتياطية (JSON)</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4 text-[#F56900]" />
                      <span>تنزيل نسخة احتياطية (JSON) الآن</span>
                    </>
                  )}
                </button>

                <div className="space-y-2">
                  <label
                    className={`flex items-start gap-2.5 p-3 rounded-xl border-2 cursor-pointer ${
                      dbChangeMode === 'migrate'
                        ? 'bg-white border-[#58CC02]'
                        : 'bg-white/70 border-[#EADBC8]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="editor-db-mode"
                      checked={dbChangeMode === 'migrate'}
                      onChange={() => setDbChangeMode('migrate')}
                      className="mt-1 w-4 h-4 accent-[#58CC02]"
                    />
                    <div>
                      <p className="font-display text-xs sm:text-sm font-extrabold text-[#4A220D] flex items-center gap-1.5">
                        <RefreshCw className="w-3.5 h-3.5 text-[#46A302]" />
                        <span>الحفاظ على البيانات ونقلها للقاعدة الجديدة وحذفها من القديمة</span>
                      </p>
                      <p className="text-[11px] text-[#7D4E35]">
                        يتم نقل الحسابات والمساجد والحلقات والروابط للقاعدة الجديدة ثم حذفها من القاعدة السابقة.
                      </p>
                    </div>
                  </label>

                  <label
                    className={`flex items-start gap-2.5 p-3 rounded-xl border-2 cursor-pointer ${
                      dbChangeMode === 'delete_old'
                        ? 'bg-white border-[#D95338]'
                        : 'bg-white/70 border-[#EADBC8]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="editor-db-mode"
                      checked={dbChangeMode === 'delete_old'}
                      onChange={() => setDbChangeMode('delete_old')}
                      className="mt-1 w-4 h-4 accent-[#D95338]"
                    />
                    <div>
                      <p className="font-display text-xs sm:text-sm font-extrabold text-[#D95338] flex items-center gap-1.5">
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>حذف البيانات القديمة والبدء بقاعدة جديدة فارغة</span>
                      </p>
                      <p className="text-[11px] text-[#7D4E35]">
                        يتم حذف البيانات القديمة نهائياً دون نقلها إلى القاعدة الجديدة.
                      </p>
                    </div>
                  </label>
                </div>

                <label className="flex items-start gap-2.5 p-3 rounded-xl bg-white border border-[#EADBC8] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmedDbChange}
                    onChange={(e) => setConfirmedDbChange(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-[#F56900]"
                  />
                  <span className="text-xs font-bold text-[#4A220D]">
                    أؤكد اختياري (
                    {dbChangeMode === 'migrate'
                      ? 'الحفاظ على البيانات ونقلها للقاعدة الجديدة وحذفها من القديمة'
                      : 'حذف البيانات القديمة نهائياً دون نقل'}
                    ) وتنفيذ التغيير.
                  </span>
                </label>
              </div>
            )}

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
                disabled={dbChangeAnalysis.hasDbChange && !confirmedDbChange}
                className="duo-btn-orange flex-1 min-h-[50px] px-6 rounded-2xl font-display font-extrabold text-base cursor-pointer disabled:opacity-50"
              >
                حفظ وربط المجمع
              </button>
              <button
                type="button"
                onClick={onClose}
                className="duo-btn-cream min-h-[50px] px-5 rounded-2xl font-display font-bold text-sm cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalContent, document.body)
    : modalContent;
};
