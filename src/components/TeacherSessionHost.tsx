import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { signOut } from 'firebase/auth';
import { LogOut, RefreshCw } from 'lucide-react';
import { getAuthForConfig } from '../services/multiDb';
import {
  loadTeacherWorkspace,
  type ComplexWorkspaceData,
} from '../services/platformService';
import type {
  AccountRecord,
  ActiveSession,
  TeacherRoleContext,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';
import { TeacherDashboardView } from './TeacherDashboardView';

interface TeacherSessionHostProps {
  session: ActiveSession;
  onExitQuickSession: () => void;
}

export const TeacherSessionHost: React.FC<TeacherSessionHostProps> = ({
  session,
  onExitQuickSession,
}) => {
  const [workspace, setWorkspace] = useState<ComplexWorkspaceData | null>(null);
  const [teacherAccount, setTeacherAccount] = useState<AccountRecord>(session.account);
  const [selectedContext, setSelectedContext] = useState<TeacherRoleContext | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await loadTeacherWorkspace(session);
      setWorkspace(res.workspace);
      setTeacherAccount(res.teacherAccount);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'تعذّر تحميل لوحة المعلم وحلقته، يرجى المحاولة مجدداً.'
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const availableContexts: TeacherRoleContext[] = useMemo(() => {
    if (!workspace) return [];

    const assignedHalaqaIds = new Set(teacherAccount.halaqaIds || []);
    let matchingHalaqat = workspace.halaqat.filter((h) => assignedHalaqaIds.has(h.id));

    if (matchingHalaqat.length === 0) {
      const mIds = new Set(
        [teacherAccount.mosqueId, ...(teacherAccount.mosqueIds || [])].filter(Boolean)
      );
      if (mIds.size > 0) {
        matchingHalaqat = workspace.halaqat.filter((h) => mIds.has(h.mosqueId));
      }
    }

    return matchingHalaqat.map((h) => {
      const mObj = workspace.mosques.find((m) => m.id === h.mosqueId);
      return {
        mosqueId: h.mosqueId,
        mosqueName: mObj?.name || session.mosqueName || 'مسجد',
        halaqaId: h.id,
        halaqaName: h.name,
      };
    });
  }, [workspace, teacherAccount, session.mosqueName]);

  useEffect(() => {
    if (availableContexts.length === 0) {
      setSelectedContext(null);
      return;
    }
    setSelectedContext((prev) => {
      if (prev && availableContexts.some((c) => c.halaqaId === prev.halaqaId)) {
        return prev;
      }
      return availableContexts[0];
    });
  }, [availableContexts]);

  const handleLogout = async () => {
    if (session.mode === 'quick') {
      onExitQuickSession();
      return;
    }
    await signOut(getAuthForConfig(session.authConfig));
  };

  if (loading) {
    return <ModernLoader fullScreen label="جاري فتح لوحة المعلم وتجهيز الحلقة..." />;
  }

  if (error || !workspace) {
    return (
      <div className="min-h-screen bg-[#FDF6EE] flex items-center justify-center p-4" dir="rtl">
        <div className="max-w-md w-full bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4">
          <h1 className="font-display text-xl font-extrabold text-[#D95338]">
            تعذّر فتح لوحة المعلم
          </h1>
          <p className="text-sm text-[#7D4E35]">{error || 'البيانات غير متوفرة حالياً.'}</p>
          <div className="flex flex-wrap gap-2.5 justify-center">
            <button
              type="button"
              onClick={() => void loadWorkspace()}
              className="duo-btn-orange min-h-[44px] px-5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>إعادة المحاولة</span>
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="duo-btn-cream min-h-[44px] px-5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>تسجيل الخروج</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedContext) {
    return (
      <div className="min-h-screen bg-[#FDF6EE] flex items-center justify-center p-4" dir="rtl">
        <div className="max-w-md w-full bg-white border-2 border-[#EADBC8] rounded-3xl p-6 text-center space-y-4">
          <h1 className="font-display text-xl font-extrabold text-[#4A220D]">
            لم يتم إسناد حلقة لهذا الحساب بعد
          </h1>
          <p className="text-sm text-[#7D4E35]">
            يرجى مراجعة مشرف المجمع لإسناد حلقة لحسابك ({teacherAccount.quadrupleName}).
          </p>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="duo-btn-orange min-h-[44px] px-5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>تسجيل الخروج</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <TeacherDashboardView
      workspace={workspace}
      context={selectedContext}
      currentUserId={teacherAccount.uid || teacherAccount.id}
      currentUserName={teacherAccount.quadrupleName}
      onReturnToSupervisor={() => void handleLogout()}
      isStandaloneTeacher
      availableContexts={availableContexts}
      onSwitchContext={setSelectedContext}
    />
  );
};
