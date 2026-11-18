import React, { useState } from 'react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  LogOut,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import type { Firestore } from 'firebase/firestore';
import { auth, googleProvider } from '../firebase';
import { validateQuadrupleArabicName } from '../services/multiDb';
import {
  findExistingAccountForUser,
  registerNewUserAccount,
} from '../services/platformService';
import {
  ROLE_LABELS,
  type ActiveSession,
  type InviteLinkRecord,
} from '../types/platform';
import { MascotImage } from './MascotImage';
import { ModernLoader } from './ModernLoader';
import { PWAInstallButton } from './PWAInstallButton';

interface InviteState {
  token: string;
  link: InviteLinkRecord | null;
  db: Firestore;
  dbLabel: string;
  complexName: string;
  mosqueNames: string[];
  halaqaNames: string[];
  status: 'valid' | 'not_found' | 'closed' | 'not_started' | 'expired';
}

interface AuthScreenProps {
  pendingGoogleUser: User | null;
  inviteState: InviteState | null;
  onSessionReady: (session: ActiveSession) => void;
}

const BASE_URL = import.meta.env.BASE_URL;
const LOGIN_FOX_PATH = `${BASE_URL}assets/aistudio/1794991269553_f447925b.jpg`;

export const AuthScreen: React.FC<AuthScreenProps> = ({
  pendingGoogleUser,
  inviteState,
  onSessionReady,
}) => {
  const [quadrupleName, setQuadrupleName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);

  const nameStatus = validateQuadrupleArabicName(quadrupleName);

  const inviteBlocked =
    inviteState !== null && inviteState.status !== 'valid';

  const getInviteBlockedMessage = () => {
    if (!inviteState) return '';
    switch (inviteState.status) {
      case 'not_started':
        return 'لم يبدأ وقت التسجيل لهذا الرابط بعد.';
      case 'expired':
        return 'انتهى وقت التسجيل المحدد وأُغلق هذا الرابط نهائياً.';
      case 'closed':
        return 'تم إغلاق رابط التسجيل هذا من قِبل المشرف.';
      case 'not_found':
      default:
        return 'رابط التسجيل غير موجود أو غير صالح.';
    }
  };

  const handleGoogleSignIn = async () => {
    if (inviteBlocked) return;
    setError(null);
    setLoadingLabel('جاري تسجيل الدخول بحساب جوجل...');

    try {
      const result = await signInWithPopup(auth, googleProvider);
      setLoadingLabel('جاري التحقق من بيانات الحساب...');
      const existingSession = await findExistingAccountForUser(result.user);
      if (existingSession) {
        onSessionReady(existingSession);
      }
      // If null, App updates pendingGoogleUser so Step 2 (Quadruple Name) appears cleanly
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user') {
        setError('تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.');
      } else if (code === 'auth/popup-blocked') {
        setError('يرجى السماح بالنوافذ المنبثقة لإتمام تسجيل الدخول بحساب جوجل.');
      } else {
        setError('تعذّر تسجيل الدخول بحساب جوجل، يرجى المحاولة مرة أخرى.');
      }
    } finally {
      setLoadingLabel(null);
    }
  };

  const handleRegisterQuadrupleName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingGoogleUser || inviteBlocked) return;

    setError(null);
    if (!nameStatus.valid) {
      setError(nameStatus.error || 'مرفوض: يجب كتابة الاسم الرباعي كاملاً.');
      return;
    }

    setLoadingLabel('جاري التحقق من عدم تكرار الاسم وحفظ الحساب...');
    try {
      const session = await registerNewUserAccount({
        user: pendingGoogleUser,
        quadrupleName: nameStatus.normalized,
        inviteLink: inviteState?.link || null,
        inviteTargetDb: inviteState?.db,
        inviteDbLabel: inviteState?.dbLabel,
      });
      onSessionReady(session);
    } catch (err: unknown) {
      setError(
        err instanceof Error && !err.message.startsWith('{')
          ? err.message
          : 'تعذّر إتمام التسجيل، يرجى التأكد من الاسم الرباعي والمحاولة مرة أخرى.'
      );
    } finally {
      setLoadingLabel(null);
    }
  };

  const handleSwitchAccount = async () => {
    setError(null);
    setQuadrupleName('');
    await signOut(auth);
  };

  return (
    <div className="min-h-screen bg-[#FDF6EE] flex flex-col justify-between">
      {/* Top Bar */}
      <header className="w-full bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8] sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <img
              src={`${BASE_URL}icon.svg`}
              alt="شعار براعم عمران"
              className="w-9 h-9 rounded-xl border border-[#EADBC8]"
            />
            <span className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] whitespace-nowrap">
              براعم عمران
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton variant="compact" />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center px-4 py-6 sm:py-10">
        <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-stretch">
          {/* Mascot Card */}
          <section className="lg:col-span-5 bg-white border-2 border-[#EADBC8] rounded-3xl p-6 sm:p-8 flex flex-col items-center justify-center text-center">
            <div className="relative bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl px-5 py-3 mb-4 max-w-xs">
              <p className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
                مرحباً بك في براعم عمران
              </p>
              <span
                aria-hidden="true"
                className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-4 h-4 bg-[#FDF6EE] border-b-2 border-r-2 border-[#EADBC8] rotate-45"
              />
            </div>

            <div className="w-44 h-44 sm:w-56 sm:h-56 flex items-center justify-center">
              <MascotImage
                src={LOGIN_FOX_PATH}
                alt="شخصية براعم عمران"
                className="w-full h-full animate-fox-float"
              />
            </div>

            <div className="mt-4 pt-4 border-t border-[#EADBC8] w-full flex items-center justify-center gap-3 text-xs sm:text-sm font-medium text-[#7D4E35]">
              <span>إدارة الحلقات</span>
              <span aria-hidden="true">·</span>
              <span>متوافق مع كل الشاشات</span>
            </div>
          </section>

          {/* Login / New-User Quadruple Name Card */}
          <section className="lg:col-span-7 bg-white border-2 border-[#EADBC8] rounded-3xl p-6 sm:p-8 lg:p-10 flex flex-col justify-center">
            {loadingLabel ? (
              <ModernLoader label={loadingLabel} />
            ) : inviteBlocked ? (
              <div className="text-center space-y-4 py-6">
                <div className="w-16 h-16 mx-auto rounded-2xl bg-[#D95338]/10 text-[#D95338] flex items-center justify-center">
                  <CalendarClock className="w-8 h-8" />
                </div>
                <h1 className="font-display text-2xl font-extrabold text-[#4A220D]">
                  رابط التسجيل مغلق
                </h1>
                <p className="text-sm sm:text-base font-medium text-[#7D4E35]">
                  {getInviteBlockedMessage()}
                </p>
              </div>
            ) : !pendingGoogleUser ? (
              /* Step 1: Google Sign-In ONLY */
              <div className="space-y-6">
                <div>
                  <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-extrabold text-[#4A220D] leading-snug mb-2">
                    مرحباً بك في براعم عمران
                  </h1>
                  <p className="text-sm sm:text-base text-[#7D4E35] leading-relaxed">
                    سجّل الدخول بحساب جوجل؛ إذا كنت مسجلاً مسبقاً ستدخل مباشرة، وإذا كنت جديداً سيُطلب منك اسمك الرباعي.
                  </p>
                </div>

                {inviteState?.link && (
                  <div className="bg-[#FDF6EE] border-2 border-[#F56900]/40 rounded-2xl p-4 space-y-1.5">
                    <div className="flex items-center gap-2 font-display font-extrabold text-sm text-[#F56900]">
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                      <span>دعوة تسجيل: {inviteState.link.title}</span>
                    </div>
                    <p className="text-xs sm:text-sm font-bold text-[#4A220D]">
                      الصفة: {ROLE_LABELS[inviteState.link.role]}
                      {inviteState.complexName ? ` · المجمع: ${inviteState.complexName}` : ''}
                    </p>
                    {inviteState.mosqueNames.length > 0 && (
                      <p className="text-xs text-[#7D4E35]">
                        المسجد: {inviteState.mosqueNames.join('، ')}
                      </p>
                    )}
                    {inviteState.halaqaNames.length > 0 && (
                      <p className="text-xs text-[#7D4E35]">
                        الحلقة: {inviteState.halaqaNames.join('، ')}
                      </p>
                    )}
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

                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="duo-btn-orange w-full min-h-[56px] px-6 py-3.5 rounded-2xl font-display font-extrabold text-base sm:text-lg flex items-center justify-center gap-3 cursor-pointer"
                >
                  <span className="w-8 h-8 rounded-xl bg-white flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                  </span>
                  <span>تسجيل الدخول بحساب جوجل</span>
                </button>

                <div className="sm:hidden">
                  <PWAInstallButton variant="full" />
                </div>
              </div>
            ) : (
              /* Step 2: New User must provide unique Quadruple Arabic Name */
              <form onSubmit={handleRegisterQuadrupleName} className="space-y-5">
                <div className="flex items-center justify-between gap-3 bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    {pendingGoogleUser.photoURL ? (
                      <img
                        src={pendingGoogleUser.photoURL}
                        alt={pendingGoogleUser.displayName || 'حساب جوجل'}
                        referrerPolicy="no-referrer"
                        className="w-11 h-11 rounded-xl border-2 border-white shrink-0"
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-xl bg-[#F56900] text-white flex items-center justify-center shrink-0">
                        <UserCheck className="w-5 h-5" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-display font-bold text-sm text-[#4A220D] flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-[#58CC02] shrink-0" />
                        <span>تم توثيق حساب جوجل</span>
                      </p>
                      <p className="text-xs text-[#7D4E35] truncate" dir="ltr">
                        {pendingGoogleUser.email}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSwitchAccount}
                    className="min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-bold text-[#7D4E35] hover:bg-white border border-transparent hover:border-[#EADBC8] inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>تغيير</span>
                  </button>
                </div>

                <div>
                  <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-[#4A220D] mb-1.5">
                    أدخل اسمك الرباعي
                  </h2>
                  <p className="text-sm text-[#7D4E35]">
                    حسابك جديد على المنصة؛ يجب كتابة الاسم الرباعي كاملاً ودون تكرار لإتمام الدخول.
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <label
                      htmlFor="new-user-quadruple-name"
                      className="font-display text-sm sm:text-base font-bold text-[#4A220D]"
                    >
                      الاسم الرباعي (إلزامي)
                    </label>
                    <span className="text-xs font-bold text-[#7D4E35] tabular-nums">
                      {nameStatus.wordCount} / ٤ مقاطع
                    </span>
                  </div>
                  <input
                    id="new-user-quadruple-name"
                    type="text"
                    value={quadrupleName}
                    onChange={(e) => {
                      setQuadrupleName(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="مثال: عمر أحمد محمد العلي"
                    maxLength={100}
                    autoFocus
                    className="w-full min-h-[52px] px-4 py-3 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE]/60 text-[#4A220D] placeholder:text-[#7D4E35]/50 font-medium text-base focus:outline-none focus:border-[#F56900] focus:bg-white transition-colors"
                  />
                  <p className="mt-1.5 text-xs text-[#7D4E35]">
                    الاسم الأول · اسم الأب · اسم الجد · اسم العائلة
                  </p>
                </div>

                {error && (
                  <div
                    role="alert"
                    className="rounded-2xl bg-[#D95338]/10 border-2 border-[#D95338]/30 px-4 py-3 text-sm font-bold text-[#D95338] flex items-center gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  className="duo-btn-green w-full min-h-[54px] px-6 py-3.5 rounded-2xl font-display font-extrabold text-base sm:text-lg flex items-center justify-center gap-2.5 cursor-pointer"
                >
                  <span>تأكيد الاسم والدخول</span>
                  <ArrowLeft className="w-5 h-5" />
                </button>
              </form>
            )}
          </section>
        </div>
      </main>

      {/* Clean Footer per User Exact Instruction */}
      <footer className="py-4 px-4 text-center text-xs sm:text-sm font-medium text-[#7D4E35]">
        منصة براعم عمران · جميع الحقوق محفوظة لاستيديو expraiment
      </footer>
    </div>
  );
};
