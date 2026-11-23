import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Database, X } from 'lucide-react';
import {
  verifyExternalFirebaseSetup,
  type ExternalDbVerificationResult,
} from '../services/multiDb';
import { registerExternalDatabaseConnection } from '../services/platformService';
import { ExternalDbVerifier } from './ExternalDbVerifier';
import { ModernLoader } from './ModernLoader';

interface ExternalDbModalProps {
  onClose: () => void;
  onAdded: () => void;
}

export const ExternalDbModal: React.FC<ExternalDbModalProps> = ({
  onClose,
  onAdded,
}) => {
  const [configRaw, setConfigRaw] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [verification, setVerification] =
    useState<ExternalDbVerificationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      let ver = verification;
      if (!ver) {
        ver = await verifyExternalFirebaseSetup(configRaw, databaseId);
        setVerification(ver);
      }
      if (!ver.approved || !ver.config) {
        setError('لم يتم اعتماد القاعدة بعد؛ استكمل الإعدادات الناقصة في نتائج الفحص ثم أعد الفحص.');
        setSaving(false);
        return;
      }
      await registerExternalDatabaseConnection(ver.config);
      onAdded();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'تعذّر ربط قاعدة البيانات الخارجية.'
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
      aria-labelledby="add-ext-db-title"
    >
      <div className="w-full sm:max-w-2xl bg-white border-2 border-[#EADBC8] rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92dvh] pb-safe flex flex-col">
        <div className="px-5 sm:px-6 py-4 border-b-2 border-[#F7EBDD] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-[#F56900]" />
            <h2 id="add-ext-db-title" className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
              إضافة قاعدة بيانات منفصلة
            </h2>
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

        {saving ? (
          <div className="p-8">
            <ModernLoader label="جاري التحقق وإضافة قاعدة البيانات لقائمة المشرف..." />
          </div>
        ) : (
          <form onSubmit={handleSave} className="overflow-y-auto p-5 sm:p-6 space-y-5">
            <p className="text-xs sm:text-sm text-[#7D4E35] leading-relaxed">
              أضف قاعدة بيانات Firebase خارجية هنا لتظهر المجمعات المحفوظة فيها تلقائياً في صفحة المجمعات، ولتتمكن من اختيارها مباشرة عند إنشاء أو تعديل أي مجمع أو مسجد دون لمس القاعدة الأساسية.
            </p>

            <ExternalDbVerifier
              idPrefix="standalone-db"
              configRaw={configRaw}
              databaseId={databaseId}
              verification={verification}
              onConfigRawChange={setConfigRaw}
              onDatabaseIdChange={setDatabaseId}
              onVerificationChange={setVerification}
            />

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
                className="duo-btn-orange flex-1 min-h-[48px] px-6 rounded-2xl font-display font-extrabold text-sm sm:text-base cursor-pointer"
              >
                اعتماد وإضافة القاعدة
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

  return typeof document !== 'undefined'
    ? createPortal(modalContent, document.body)
    : modalContent;
};
