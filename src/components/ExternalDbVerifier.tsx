import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  EXTERNAL_DB_RECOMMENDED_RULES,
  verifyExternalFirebaseSetup,
  type ExternalDbVerificationResult,
} from '../services/multiDb';
import { ModernLoader } from './ModernLoader';

interface ExternalDbVerifierProps {
  idPrefix: string;
  configRaw: string;
  databaseId: string;
  verification: ExternalDbVerificationResult | null;
  onConfigRawChange: (value: string) => void;
  onDatabaseIdChange: (value: string) => void;
  onVerificationChange: (result: ExternalDbVerificationResult | null) => void;
}

export const ExternalDbVerifier: React.FC<ExternalDbVerifierProps> = ({
  idPrefix,
  configRaw,
  databaseId,
  verification,
  onConfigRawChange,
  onDatabaseIdChange,
  onVerificationChange,
}) => {
  const [testing, setTesting] = useState(false);
  const [copiedRules, setCopiedRules] = useState(false);

  const handleRunVerify = async () => {
    setTesting(true);
    try {
      const result = await verifyExternalFirebaseSetup(configRaw, databaseId);
      onVerificationChange(result);
    } finally {
      setTesting(false);
    }
  };

  const handleCopyRules = async () => {
    try {
      await navigator.clipboard.writeText(EXTERNAL_DB_RECOMMENDED_RULES);
      setCopiedRules(true);
      setTimeout(() => setCopiedRules(false), 2400);
    } catch {
      setCopiedRules(false);
    }
  };

  return (
    <div className="space-y-3 pt-1">
      <div>
        <label htmlFor={`${idPrefix}-config`} className="block text-xs font-bold text-[#7D4E35] mb-1.5">
          ألصق كود تهيئة Firebase الكامل (أو كائن firebaseConfig) — تُخزّن البيانات حصراً على هذه القاعدة:
        </label>
        <textarea
          id={`${idPrefix}-config`}
          rows={6}
          dir="ltr"
          value={configRaw}
          onChange={(e) => {
            onConfigRawChange(e.target.value);
            onVerificationChange(null);
          }}
          placeholder={`import { initializeApp } from "firebase/app";\nconst firebaseConfig = {\n  apiKey: "...",\n  authDomain: "...",\n  projectId: "...",\n  appId: "..."\n};`}
          className="w-full p-3 rounded-xl border-2 border-[#EADBC8] bg-white font-mono text-xs text-[#4A220D] focus:outline-none focus:border-[#F56900]"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
        <div className="sm:col-span-7">
          <label htmlFor={`${idPrefix}-dbname`} className="block text-xs font-bold text-[#7D4E35] mb-1">
            اسم قاعدة البيانات (اختياري إذا لم تكن <span dir="ltr">(default)</span>)
          </label>
          <input
            id={`${idPrefix}-dbname`}
            type="text"
            dir="ltr"
            value={databaseId}
            onChange={(e) => {
              onDatabaseIdChange(e.target.value);
              onVerificationChange(null);
            }}
            placeholder="(default)"
            className="w-full min-h-[44px] px-3 py-2 rounded-xl border-2 border-[#EADBC8] bg-white font-mono text-xs text-[#4A220D] focus:outline-none focus:border-[#F56900]"
          />
        </div>

        <div className="sm:col-span-5">
          <button
            type="button"
            onClick={handleRunVerify}
            disabled={testing || !configRaw.trim()}
            className="duo-btn-orange w-full min-h-[44px] px-4 py-2 rounded-xl font-display font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>{testing ? 'جاري الفحص...' : 'فحص واعتماد القاعدة'}</span>
          </button>
        </div>
      </div>

      {testing && (
        <div className="bg-white border-2 border-[#EADBC8] rounded-2xl p-3">
          <ModernLoader label="جاري فحص تفعيل القاعدة والرولز وإعدادات الدخول..." />
        </div>
      )}

      {!testing && verification && (
        <div
          className={`rounded-2xl border-2 p-4 space-y-3 ${
            verification.approved
              ? 'bg-[#58CC02]/10 border-[#58CC02]'
              : 'bg-white border-[#D95338]/40'
          }`}
        >
          <div className="flex items-center gap-2">
            {verification.approved ? (
              <CheckCircle2 className="w-5 h-5 text-[#46A302] shrink-0" />
            ) : (
              <ShieldAlert className="w-5 h-5 text-[#D95338] shrink-0" />
            )}
            <p
              className={`font-display text-sm font-extrabold ${
                verification.approved ? 'text-[#46A302]' : 'text-[#D95338]'
              }`}
            >
              {verification.summary}
            </p>
          </div>

          <ul className="space-y-2">
            {verification.checks.map((chk) => (
              <li
                key={chk.id}
                className="flex items-start gap-2.5 text-xs bg-white/90 border border-[#EADBC8] rounded-xl p-2.5"
              >
                {chk.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-[#58CC02] shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-[#D95338] shrink-0 mt-0.5" />
                )}
                <div className="space-y-0.5">
                  <p className="font-display font-bold text-[#4A220D]">{chk.title}</p>
                  <p className="text-[#7D4E35] leading-relaxed">{chk.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          {verification.needsRulesHelp && (
            <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-xl p-3 space-y-2">
              <p className="text-xs font-bold text-[#4A220D]">
                انسخ قواعد Firestore التالية وضعها في Firebase Console ← Firestore Database ← Rules ثم اضغط Publish وأعد الفحص:
              </p>
              <button
                type="button"
                onClick={handleCopyRules}
                className="duo-btn-cream min-h-[40px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                {copiedRules ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#58CC02]" />
                    <span>تم نسخ قواعد الأمان الجاهزة</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#F56900]" />
                    <span>نسخ قواعد Firestore للربط الخارجي</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
