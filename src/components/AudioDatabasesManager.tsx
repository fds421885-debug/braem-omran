import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Database,
  HardDrive,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Volume2,
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
  activateGlobalAudioShard,
  addDbToGlobalAudioPool,
  listConnectedDatabasesInfo,
  loadGlobalAudioDbPool,
  migrateGlobalAudioShard,
  migrateLegacyWordAudioToGlobalPool,
  recalculateGlobalAudioPoolUsage,
  removeShardFromGlobalAudioPool,
} from '../services/platformService';
import {
  SPARK_FREE_TIER_BYTES,
  type ConnectedDatabaseInfo,
  type TabDbShard,
} from '../types/platform';
import { ExternalDbVerifier } from './ExternalDbVerifier';
import { ModernLoader } from './ModernLoader';

function formatBytesArabic(bytes: number): string {
  const clean = Math.max(0, Number(bytes) || 0);
  if (clean < 1024) return `${clean.toLocaleString('en-US')} بايت`;
  if (clean < 1024 * 1024) return `${(clean / 1024).toFixed(1)} كيلوبايت`;
  if (clean < 1024 * 1024 * 1024) return `${(clean / (1024 * 1024)).toFixed(2)} ميجابايت`;
  return `${(clean / (1024 * 1024 * 1024)).toFixed(3)} جيجابايت`;
}

interface AudioDatabasesManagerProps {
  onPoolChanged?: () => void;
}

export const AudioDatabasesManager: React.FC<AudioDatabasesManagerProps> = ({
  onPoolChanged,
}) => {
  const [pool, setPool] = useState<TabDbShard[]>([]);
  const [connectedDbs, setConnectedDbs] = useState<ConnectedDatabaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Add Audio DB Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addConfigRaw, setAddConfigRaw] = useState('');
  const [addDatabaseId, setAddDatabaseId] = useState('');
  const [addVerification, setAddVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [addMaxGb, setAddMaxGb] = useState<'1' | '4'>('1');
  const [addModalError, setAddModalError] = useState<string | null>(null);

  // Migrate Shard Modal
  const [migrateShardTarget, setMigrateShardTarget] = useState<TabDbShard | null>(null);
  const [migrateConfigRaw, setMigrateConfigRaw] = useState('');
  const [migrateDatabaseId, setMigrateDatabaseId] = useState('');
  const [migrateVerification, setMigrateVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [removeSource, setRemoveSource] = useState(true);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  // Confirm Remove Shard
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const loadPool = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const [shards, knownDbs] = await Promise.all([
        loadGlobalAudioDbPool(force),
        listConnectedDatabasesInfo().catch(() => []),
      ]);
      setPool(shards);
      setConnectedDbs(knownDbs);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر تحميل قائمة قواعد الصوتيات.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPool(true);
  }, [loadPool]);

  const externalPresets = connectedDbs.filter((d) => !d.isPrimary);

  const handleAddAudioDb = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddModalError(null);

    let ver = addVerification;
    if (!ver) {
      ver = await verifyExternalFirebaseSetup(addConfigRaw, addDatabaseId);
      setAddVerification(ver);
    }
    if (!ver.approved || !ver.config) {
      setAddModalError('يرجى إدخال بيانات القاعدة الخارجية وفحصها واعتمادها أولاً.');
      return;
    }

    const maxBytes =
      addMaxGb === '4' ? 4 * 1024 * 1024 * 1024 : SPARK_FREE_TIER_BYTES;

    setBusyLabel(`جاري ربط قاعدة الأصوات (${getDbDisplayLabel(ver.config)})...`);
    try {
      const res = await addDbToGlobalAudioPool({
        config: ver.config,
        maxBytes,
      });
      setPool(res.pool);
      setShowAddModal(false);
      setAddConfigRaw('');
      setAddDatabaseId('');
      setAddVerification(null);
      onPoolChanged?.();
      setFeedback({
        type: 'ok',
        text: `تم ربط قاعدة الأصوات (${getDbDisplayLabel(ver.config)}) بنجاح. أي صوت جديد سيُحفظ هنا ويُبحث عنه هنا أولاً.`,
      });
    } catch (err) {
      setAddModalError(
        err instanceof Error ? err.message : 'تعذّر ربط قاعدة الأصوات.'
      );
    } finally {
      setBusyLabel(null);
    }
  };

  const handleActivateShard = async (shardId: string) => {
    setBusyLabel('جاري تفعيل قاعدة الأصوات المختارة للكتابة...');
    setFeedback(null);
    try {
      const updated = await activateGlobalAudioShard(shardId);
      setPool(updated);
      onPoolChanged?.();
      setFeedback({
        type: 'ok',
        text: 'تم تفعيل القاعدة المختارة لحفظ الصوتيات الجديدة.',
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

  const handleRecalculate = async () => {
    setBusyLabel('جاري فحص السجلات وحساب المساحة المتبقية في جميع قواعد الأصوات...');
    setFeedback(null);
    try {
      const updated = await recalculateGlobalAudioPoolUsage();
      setPool(updated);
      onPoolChanged?.();
      setFeedback({
        type: 'ok',
        text: 'تم تحديث عدادات المساحة وعدد الصوتيات لجميع قواعد الأصوات بدقة.',
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

  const handleRemoveShard = async (shardId: string) => {
    setBusyLabel('جاري فصل القاعدة من سلسلة قواعد الأصوات...');
    setFeedback(null);
    try {
      const updated = await removeShardFromGlobalAudioPool(shardId);
      setPool(updated);
      setConfirmRemoveId(null);
      onPoolChanged?.();
      setFeedback({
        type: 'ok',
        text: 'تم فصل القاعدة من قائمة قواعد الأصوات (لم يتم حذف الملفات داخل مشروع Firebase نفسه).',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر فصل القاعدة.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleMigrateLegacy = async () => {
    setBusyLabel('جاري نقل الصوتيات المحفوظة سابقاً إلى قواعد الأصوات المخصصة...');
    setFeedback(null);
    try {
      const { movedCount } = await migrateLegacyWordAudioToGlobalPool((msg) =>
        setBusyLabel(msg)
      );
      await loadPool(true);
      onPoolChanged?.();
      setFeedback({
        type: 'ok',
        text:
          movedCount > 0
            ? `تم ترحيل (${movedCount}) ملف صوتي بنجاح إلى قواعد الأصوات المخصصة وإفراغ القواعد السابقة منها.`
            : 'لا توجد صوتيات قديمة متبقية خارج قواعد الأصوات المخصصة.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر ترحيل الصوتيات السابقة.',
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleExecuteMigrateShard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!migrateShardTarget) return;
    setMigrateError(null);

    let ver = migrateVerification;
    if (!ver) {
      ver = await verifyExternalFirebaseSetup(migrateConfigRaw, migrateDatabaseId);
      setMigrateVerification(ver);
    }
    if (!ver.approved || !ver.config) {
      setMigrateError('يرجى اعتماد القاعدة البديلة أولاً.');
      return;
    }

    if (buildDbConnectionId(ver.config) === migrateShardTarget.id) {
      setMigrateError('القاعدة البديلة مطابقة تماماً للقاعدة المصدر.');
      return;
    }

    setBusyLabel('جاري نقل مقاطع الصوت إلى القاعدة البديلة...');
    try {
      const res = await migrateGlobalAudioShard({
        sourceShardId: migrateShardTarget.id,
        destConfig: ver.config,
        removeSourceAfterMigration: removeSource,
        onProgress: (msg) => setBusyLabel(msg),
      });
      setPool(res.pool);
      setMigrateShardTarget(null);
      onPoolChanged?.();
      setFeedback({
        type: 'ok',
        text: `تم نقل (${res.movedDocsCount}) صوت إلى القاعدة البديلة بنجاح.`,
      });
    } catch (err) {
      setMigrateError(
        err instanceof Error ? err.message : 'تعذّر نقل الصوتيات للقاعدة البديلة.'
      );
    } finally {
      setBusyLabel(null);
    }
  };

  const totalUsed = pool.reduce((sum, s) => sum + (s.usedBytes || 0), 0);
  const totalMax = pool.reduce((sum, s) => sum + (s.maxBytes || SPARK_FREE_TIER_BYTES), 0);
  const totalDocs = pool.reduce((sum, s) => sum + (s.docsCount || 0), 0);

  return (
    <div className="space-y-5" dir="rtl">
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
              ? 'bg-[#58CC02]/10 border-[#58CC02] text-[#357A02]'
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

      {/* Overview Header Card */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="inline-flex items-center gap-1.5 text-xs font-display font-extrabold text-[#2B8A3E]">
              <Volume2 className="w-4 h-4" />
              <span>سلسلة قواعد البيانات المخصصة للأصوات (عامة لجميع المجمعات والأجهزة)</span>
            </div>
            <h2 className="font-display text-xl font-extrabold text-[#4A220D]">
              قواعد تخزين الصوتيات الذكية وعالية السعة
            </h2>
            <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
              عند ربط قاعدة أو أكثر هنا، يتم عزل تخزين جميع الأصوات المولّدة إليها فقط (ولا تستهلك مساحة القاعدة الأساسية أو تبويبات المجمعات). عند قراءة أي كلمة أو آية، يبحث النظام داخل هذه القواعد أولاً على مستوى كل المنصة، فإذا وُجدت الكلمة بالتشكيل المطابق تُشغَّل فوراً من أي جهاز دون إعادة توليد.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAddConfigRaw('');
                setAddDatabaseId('');
                setAddVerification(null);
                setAddModalError(null);
                setShowAddModal(true);
              }}
              className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>ربط قاعدة أصوات جديدة</span>
            </button>

            {pool.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => void handleRecalculate()}
                  className="min-h-[44px] px-3.5 py-2 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4 text-[#F56900]" />
                  <span>حساب المساحة</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleMigrateLegacy()}
                  className="duo-btn-green min-h-[44px] px-3.5 py-2 rounded-2xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>ترحيل الصوتيات القديمة إلى هنا</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Quick KPI Row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[#F7EBDD]">
          <div className="rounded-2xl bg-[#FDF6EE] border border-[#EADBC8] p-3.5">
            <p className="text-[11px] font-bold text-[#7D4E35]">عدد قواعد الأصوات المربوطة</p>
            <p className="font-display text-2xl font-extrabold text-[#4A220D] tabular-nums mt-0.5">
              {pool.length.toLocaleString('en-US')}
            </p>
            <p className="text-[11px] font-semibold text-[#7D4E35]">
              {pool.length > 0
                ? 'التخزين المعزول للأصوات مفعّل'
                : 'تُحفظ الأصوات حالياً داخل قواعد المكتبة/العروض'}
            </p>
          </div>

          <div className="rounded-2xl bg-[#FDF6EE] border border-[#EADBC8] p-3.5">
            <p className="text-[11px] font-bold text-[#7D4E35]">إجمالي المقاطع الصوتية المسجلة</p>
            <p className="font-display text-2xl font-extrabold text-[#F56900] tabular-nums mt-0.5">
              {totalDocs.toLocaleString('en-US')}
            </p>
            <p className="text-[11px] font-semibold text-[#7D4E35]">
              متاحة من أي مجمع وأي جهاز
            </p>
          </div>

          <div className="rounded-2xl bg-[#58CC02]/10 border border-[#58CC02]/40 p-3.5">
            <p className="text-[11px] font-bold text-[#357A02]">المساحة المتبقية في سلسلة الأصوات</p>
            <p className="font-display text-2xl font-extrabold text-[#357A02] tabular-nums mt-0.5">
              {pool.length > 0 ? formatBytesArabic(Math.max(0, totalMax - totalUsed)) : '—'}
            </p>
            <p className="text-[11px] font-semibold text-[#357A02]">
              {pool.length > 0
                ? `المستخدم: ${formatBytesArabic(totalUsed)} من ${formatBytesArabic(totalMax)}`
                : 'اربط قاعدة خارجية لتفعيل السعة المخصصة'}
            </p>
          </div>
        </div>
      </section>

      {/* Pool Shards List */}
      {loading ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8">
          <ModernLoader label="جاري تحميل قواعد الصوتيات..." />
        </div>
      ) : pool.length === 0 ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8 sm:p-10 text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-[#2B8A3E]/12 text-[#2B8A3E] mx-auto flex items-center justify-center">
            <Database className="w-7 h-7" />
          </div>
          <div className="space-y-1 max-w-lg mx-auto">
            <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
              لا توجد قواعد مخصصة للأصوات بعد
            </h3>
            <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
              اربط قاعدة أو عدة قواعد Firebase خارجية هنا لتجميع كل أصوات الكلمات والآيات فيها بعيداً عن القاعدة الأساسية وبمتابعة دقيقة لسعة كل قاعدة.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAddConfigRaw('');
              setAddDatabaseId('');
              setAddVerification(null);
              setAddModalError(null);
              setShowAddModal(true);
            }}
            className="duo-btn-orange min-h-[46px] px-6 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>ربط أول قاعدة أصوات</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {pool.map((shard, index) => {
            const maxB = shard.maxBytes || SPARK_FREE_TIER_BYTES;
            const usedB = shard.usedBytes || 0;
            const pct = Math.min(100, Math.round((usedB / maxB) * 10000) / 100);
            const remainingB = Math.max(0, maxB - usedB);
            const isActive = shard.status === 'active';
            const isFull = shard.status === 'full';

            return (
              <article
                key={shard.id}
                className={`bg-white border-2 rounded-3xl p-4 sm:p-5 space-y-3 ${
                  isActive
                    ? 'border-[#58CC02]'
                    : isFull
                    ? 'border-[#D95338]/60'
                    : 'border-[#EADBC8]'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 font-display font-extrabold text-sm sm:text-base text-[#4A220D]">
                        <HardDrive className="w-4 h-4 text-[#F56900]" />
                        قاعدة أصوات #{index + 1}: {shard.label}
                      </span>

                      {isActive ? (
                        <span className="px-2.5 py-0.5 rounded-lg bg-[#58CC02]/15 text-[#357A02] text-xs font-extrabold inline-flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          نشطة للحفظ الآن
                        </span>
                      ) : isFull ? (
                        <span className="px-2.5 py-0.5 rounded-lg bg-[#D95338]/15 text-[#D95338] text-xs font-extrabold">
                          ممتلئة (تحولت للقاعدة التالية)
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-lg bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35] text-xs font-bold">
                          جاهزة في الانتظار · مقروءة دائماً
                        </span>
                      )}

                      <span className="text-xs font-bold text-[#7D4E35] tabular-nums">
                        ({(shard.docsCount || 0).toLocaleString('en-US')} صوت محفوظ)
                      </span>
                    </div>

                    <p className="text-xs font-mono text-[#7D4E35]" dir="ltr">
                      {shard.config.projectId} / {shard.config.firestoreDatabaseId || '(default)'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {!isActive && !isFull && (
                      <button
                        type="button"
                        onClick={() => void handleActivateShard(shard.id)}
                        className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#58CC02]/12 border border-[#58CC02]/40 hover:bg-[#58CC02]/20 text-[#357A02] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Zap className="w-3.5 h-3.5" />
                        <span>تفعيل للحفظ</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setMigrateShardTarget(shard);
                        setMigrateConfigRaw('');
                        setMigrateDatabaseId('');
                        setMigrateVerification(null);
                        setRemoveSource(true);
                        setMigrateError(null);
                      }}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#FDF6EE] border border-[#EADBC8] hover:border-[#F56900] text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5 text-[#F56900]" />
                      <span>نقل لبديلة</span>
                    </button>

                    {confirmRemoveId === shard.id ? (
                      <div className="inline-flex items-center gap-1 bg-[#D95338]/10 border border-[#D95338]/40 rounded-xl px-2 py-1">
                        <button
                          type="button"
                          onClick={() => void handleRemoveShard(shard.id)}
                          className="px-2 py-1 rounded-lg bg-[#D95338] text-white text-[11px] font-bold cursor-pointer"
                        >
                          تأكيد الفصل
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(null)}
                          className="px-2 py-1 rounded-lg bg-white text-[#4A220D] text-[11px] font-bold cursor-pointer"
                        >
                          إلغاء
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(shard.id)}
                        className="min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[#EADBC8] hover:border-[#D95338] text-[#D95338] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>فصل</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Live Space Progress Bar */}
                <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold tabular-nums">
                    <span className="text-[#4A220D]">
                      المستهلك: <strong className="text-[#F56900]">{formatBytesArabic(usedB)}</strong> ({pct.toFixed(2)}%)
                    </span>
                    <span className="text-[#357A02]">
                      المتبقي: <strong>{formatBytesArabic(remainingB)}</strong> من أصل {formatBytesArabic(maxB)}
                    </span>
                  </div>
                  <div className="w-full h-3 rounded-full bg-white border border-[#EADBC8] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        isFull
                          ? 'bg-[#D95338]'
                          : pct >= 85
                          ? 'bg-[#FFA900]'
                          : 'bg-[#58CC02]'
                      }`}
                      style={{ width: `${Math.max(usedB > 0 ? 1.5 : 0, pct)}%` }}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Add Audio DB Modal */}
      {showAddModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleAddAudioDb}
              dir="rtl"
              className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92dvh] pb-safe flex flex-col"
            >
              <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-5 h-5 text-[#F56900]" />
                  <div>
                    <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                      ربط قاعدة بيانات مخصصة للأصوات
                    </h3>
                    <p className="text-xs text-[#7D4E35]">
                      ستُستخدم لحفظ والبحث عن جميع أصوات التهجي والآيات عبر كل الأجهزة والمجمعات.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  aria-label="إغلاق"
                  className="p-2 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 sm:p-6 space-y-4">
                <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3.5 space-y-2">
                  <p className="text-xs font-extrabold text-[#4A220D]">
                    حد التبديل التلقائي لهذه القاعدة قبل الانتقال للقاعدة التالية:
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setAddMaxGb('1')}
                      className={`min-h-[38px] px-3 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                        addMaxGb === '1'
                          ? 'bg-[#F56900] border-[#F56900] text-white'
                          : 'bg-white border-[#EADBC8] text-[#4A220D]'
                      }`}
                    >
                      ١ جيجابايت (خطة Spark المجانية)
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddMaxGb('4')}
                      className={`min-h-[38px] px-3 rounded-xl border-2 text-xs font-bold cursor-pointer ${
                        addMaxGb === '4'
                          ? 'bg-[#F56900] border-[#F56900] text-white'
                          : 'bg-white border-[#EADBC8] text-[#4A220D]'
                      }`}
                    >
                      ٤ جيجابايت (خطة Blaze المدفوعة)
                    </button>
                  </div>
                </div>

                {externalPresets.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-bold text-[#7D4E35]">قواعد خارجية مرتبطة مسبقاً:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {externalPresets.map((dbInfo) => (
                        <button
                          key={dbInfo.key}
                          type="button"
                          onClick={() => {
                            if (!dbInfo.config) return;
                            setAddConfigRaw(JSON.stringify(dbInfo.config, null, 2));
                            setAddDatabaseId(dbInfo.config.firestoreDatabaseId || '');
                            setAddVerification(null);
                          }}
                          className="min-h-[34px] px-3 py-1 rounded-xl border border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] cursor-pointer"
                        >
                          {dbInfo.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <ExternalDbVerifier
                  idPrefix="global-audio-add-db"
                  configRaw={addConfigRaw}
                  databaseId={addDatabaseId}
                  verification={addVerification}
                  onConfigRawChange={setAddConfigRaw}
                  onDatabaseIdChange={setAddDatabaseId}
                  onVerificationChange={setAddVerification}
                />

                <div className="bg-[#FFA900]/12 border border-[#FFA900]/40 rounded-xl p-3 flex items-start gap-2 text-xs text-[#4A220D]">
                  <AlertTriangle className="w-4 h-4 text-[#D98A00] shrink-0 mt-0.5" />
                  <span>
                    ملاحظة: لا يُسمح باختيار القاعدة الأساسية للموقع؛ يجب أن تكون قاعدة الأصوات مشروع Firebase خارجي مستقل لضمان بقاء القاعدة الأساسية خفيفة.
                  </span>
                </div>

                {addModalError && (
                  <div
                    role="alert"
                    className="rounded-xl bg-[#D95338]/10 border border-[#D95338]/40 px-3 py-2 text-xs font-bold text-[#D95338]"
                  >
                    {addModalError}
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2 border-t-2 border-[#F7EBDD]">
                  <button
                    type="submit"
                    className="duo-btn-orange flex-1 min-h-[46px] rounded-2xl font-display font-extrabold text-sm cursor-pointer"
                  >
                    إضافة وتفعيل في سلسلة الأصوات
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
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

      {/* Migrate Shard Modal */}
      {migrateShardTarget &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-[#4A220D]/55 backdrop-blur-xs p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <form
              onSubmit={handleExecuteMigrateShard}
              dir="rtl"
              className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92dvh] pb-safe flex flex-col"
            >
              <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2">
                  <ArrowRightLeft className="w-5 h-5 text-[#F56900]" />
                  <div>
                    <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                      نقل الأصوات إلى قاعدة بديلة
                    </h3>
                    <p className="text-xs text-[#7D4E35]">
                      المصدر: {migrateShardTarget.label}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMigrateShardTarget(null)}
                  aria-label="إغلاق"
                  className="p-2 rounded-xl text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 sm:p-6 space-y-4">
                <ExternalDbVerifier
                  idPrefix="global-audio-migrate-db"
                  configRaw={migrateConfigRaw}
                  databaseId={migrateDatabaseId}
                  verification={migrateVerification}
                  onConfigRawChange={setMigrateConfigRaw}
                  onDatabaseIdChange={setMigrateDatabaseId}
                  onVerificationChange={setMigrateVerification}
                />

                <label className="flex items-center gap-2 text-xs font-bold text-[#4A220D] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={removeSource}
                    onChange={(e) => setRemoveSource(e.target.checked)}
                    className="w-4 h-4 accent-[#F56900]"
                  />
                  <span>حذف النسخ المنقولة من القاعدة المصدر واستبدالها بالبديلة في السلسلة</span>
                </label>

                {migrateError && (
                  <div className="rounded-xl bg-[#D95338]/10 border border-[#D95338]/40 px-3 py-2 text-xs font-bold text-[#D95338]">
                    {migrateError}
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2 border-t-2 border-[#F7EBDD]">
                  <button
                    type="submit"
                    className="duo-btn-orange flex-1 min-h-[46px] rounded-2xl font-display font-extrabold text-sm cursor-pointer"
                  >
                    بدء نقل الصوتيات
                  </button>
                  <button
                    type="button"
                    onClick={() => setMigrateShardTarget(null)}
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
