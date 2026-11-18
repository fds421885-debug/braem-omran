import React from 'react';
import { signOut } from 'firebase/auth';
import { CheckCircle2, LogOut } from 'lucide-react';
import { getAuthForConfig } from '../services/multiDb';
import type { ActiveSession } from '../types/platform';
import { MascotImage } from './MascotImage';
import { PWAInstallButton } from './PWAInstallButton';

interface RoleWelcomeViewProps {
  session: ActiveSession;
  onExitQuickSession: () => void;
}

const BASE_URL = import.meta.env.BASE_URL;
const WAVING_FOX_PATH = `${BASE_URL}src/assets/images/fox_welcome_wave_1794991801893.jpg`;

export const RoleWelcomeView: React.FC<RoleWelcomeViewProps> = ({
  session,
  onExitQuickSession,
}) => {
  const { account, complexName, mosqueName, mosqueNames, halaqaNames, mode } = session;

  const getRoleGreetingTitle = () => {
    switch (account.role) {
      case 'supervisor':
        return 'مرحباً أيها المشرف';
      case 'teacher':
        return 'مرحباً أيها المعلم';
      case 'student':
      default:
        return 'مرحباً أيها الطالب';
    }
  };

  const handleLogout = async () => {
    if (mode === 'quick') {
      onExitQuickSession();
      return;
    }
    await signOut(getAuthForConfig(session.authConfig));
  };

  return (
    <div className="min-h-screen bg-[#FDF6EE] text-[#4A220D] flex flex-col justify-between">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b-2 border-[#EADBC8]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <img
              src={`${BASE_URL}icon.svg`}
              alt="براعم عمران"
              className="w-9 h-9 rounded-xl border border-[#EADBC8]"
            />
            <span className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D] whitespace-nowrap">
              براعم عمران
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <PWAInstallButton variant="compact" />
            <button
              type="button"
              onClick={handleLogout}
              className="min-h-[44px] px-3.5 py-2 rounded-2xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#7D4E35] hover:text-[#4A220D] font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              <span>تسجيل الخروج</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Welcome Card */}
      <main className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-3xl bg-white border-2 border-[#EADBC8] rounded-3xl p-6 sm:p-10 text-center space-y-6">
          <div className="inline-flex items-center gap-2 bg-[#58CC02]/10 border-2 border-[#58CC02] rounded-2xl px-4 py-2 text-sm font-display font-extrabold text-[#46A302]">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <span>تم تسجيل الدخول</span>
          </div>

          <div className="flex flex-col items-center">
            <div className="relative bg-[#F56900] text-white rounded-2xl px-6 py-3 mb-4 border-b-4 border-[#C95200]">
              <p className="font-display text-lg sm:text-xl font-extrabold">
                مرحباً بك!
              </p>
              <span
                aria-hidden="true"
                className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-[#F56900] border-b-4 border-r-4 border-[#C95200] rotate-45"
              />
            </div>

            <div className="w-48 h-48 sm:w-56 sm:h-56 flex items-center justify-center">
              <MascotImage
                src={WAVING_FOX_PATH}
                alt="شخصية براعم عمران"
                className="w-full h-full animate-fox-float"
              />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="font-display text-2xl sm:text-4xl font-extrabold text-[#4A220D]">
              {getRoleGreetingTitle()}
            </h1>
            <p className="font-display text-lg sm:text-xl font-bold text-[#F56900]">
              {account.quadrupleName}
            </p>
          </div>

          {(complexName || mosqueName || (mosqueNames && mosqueNames.length > 0) || (halaqaNames && halaqaNames.length > 0)) && (
            <div className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-4 sm:p-5 text-sm text-[#7D4E35] space-y-1.5 max-w-lg mx-auto">
              {complexName && (
                <p>
                  <strong className="text-[#4A220D]">المجمع:</strong> {complexName}
                </p>
              )}
              {(mosqueName || (mosqueNames && mosqueNames.length > 0)) && (
                <p>
                  <strong className="text-[#4A220D]">المسجد:</strong>{' '}
                  {mosqueNames && mosqueNames.length > 0 ? mosqueNames.join('، ') : mosqueName}
                </p>
              )}
              {halaqaNames && halaqaNames.length > 0 && (
                <p>
                  <strong className="text-[#4A220D]">الحلقة:</strong> {halaqaNames.join('، ')}
                </p>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="py-4 px-4 text-center text-xs sm:text-sm font-medium text-[#7D4E35]">
        منصة براعم عمران · جميع الحقوق محفوظة لاستيديو expraiment
      </footer>
    </div>
  );
};
