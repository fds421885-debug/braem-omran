import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  History,
  Save,
  UserCheck,
  UserMinus,
  UserX,
} from 'lucide-react';
import { getTodayDateKey } from '../services/multiDb';
import {
  listAttendanceHistory,
  loadAttendanceRecord,
  saveAttendanceRecord,
  type ComplexWorkspaceData,
} from '../services/platformService';
import {
  ATTENDANCE_STATUS_LABELS,
  type AttendanceEntry,
  type AttendanceRecord,
  type AttendanceStatus,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';

interface AttendanceSectionProps {
  workspace: ComplexWorkspaceData;
  currentUserId: string;
  currentUserName: string;
  restrictMosqueIds?: string[];
  fixedMosqueId?: string;
  fixedHalaqaId?: string;
}

const STATUS_BUTTONS: {
  key: AttendanceStatus;
  label: string;
  activeClass: string;
  idleClass: string;
  icon: typeof UserCheck;
}[] = [
  {
    key: 'present',
    label: 'حاضر',
    activeClass: 'bg-[#58CC02] border-[#46A302] text-white',
    idleClass: 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#58CC02]',
    icon: UserCheck,
  },
  {
    key: 'absent',
    label: 'غائب',
    activeClass: 'bg-[#D95338] border-[#B63D25] text-white',
    idleClass: 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#D95338]',
    icon: UserX,
  },
  {
    key: 'excused',
    label: 'بعذر',
    activeClass: 'bg-[#2563EB] border-[#1D4ED8] text-white',
    idleClass: 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#2563EB]',
    icon: UserMinus,
  },
  {
    key: 'late',
    label: 'متأخر',
    activeClass: 'bg-[#F56900] border-[#C95200] text-white',
    idleClass: 'bg-white border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]',
    icon: Clock,
  },
];

export const AttendanceSection: React.FC<AttendanceSectionProps> = ({
  workspace,
  currentUserId,
  currentUserName,
  restrictMosqueIds,
  fixedMosqueId,
  fixedHalaqaId,
}) => {
  const allowedMosqueSet = useMemo(() => {
    if (!restrictMosqueIds || restrictMosqueIds.length === 0) return null;
    return new Set(restrictMosqueIds);
  }, [restrictMosqueIds]);

  const visibleMosques = useMemo(
    () =>
      allowedMosqueSet
        ? workspace.mosques.filter((m) => allowedMosqueSet.has(m.id))
        : workspace.mosques,
    [workspace.mosques, allowedMosqueSet]
  );

  const [selectedMosqueId, setSelectedMosqueId] = useState<string>(
    fixedMosqueId || visibleMosques[0]?.id || ''
  );

  const mosqueHalaqat = useMemo(
    () => workspace.halaqat.filter((h) => h.mosqueId === selectedMosqueId),
    [workspace.halaqat, selectedMosqueId]
  );

  const [selectedHalaqaId, setSelectedHalaqaId] = useState<string>(
    fixedHalaqaId || mosqueHalaqat[0]?.id || ''
  );
  const [dateKey, setDateKey] = useState<string>(getTodayDateKey());

  const [entries, setEntries] = useState<AttendanceEntry[]>([]);
  const [history, setHistory] = useState<AttendanceRecord[]>([]);
  const [existingRecord, setExistingRecord] = useState<AttendanceRecord | null>(null);
  const [loadingSheet, setLoadingSheet] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (fixedMosqueId) {
      setSelectedMosqueId(fixedMosqueId);
    } else if (!selectedMosqueId && visibleMosques[0]?.id) {
      setSelectedMosqueId(visibleMosques[0].id);
    }
  }, [fixedMosqueId, selectedMosqueId, visibleMosques]);

  useEffect(() => {
    if (fixedHalaqaId) {
      setSelectedHalaqaId(fixedHalaqaId);
      return;
    }
    const valid = mosqueHalaqat.some((h) => h.id === selectedHalaqaId);
    if (!valid) {
      setSelectedHalaqaId(mosqueHalaqat[0]?.id || '');
    }
  }, [fixedHalaqaId, mosqueHalaqat, selectedHalaqaId]);

  const halaqaStudents = useMemo(() => {
    if (!selectedHalaqaId) return [];
    return workspace.accounts
      .filter((a) => a.role === 'student' && a.halaqaIds.includes(selectedHalaqaId))
      .sort((a, b) => a.quadrupleName.localeCompare(b.quadrupleName, 'ar'));
  }, [workspace.accounts, selectedHalaqaId]);

  const loadHistory = useCallback(async () => {
    if (!selectedHalaqaId) {
      setHistory([]);
      return;
    }
    setLoadingHistory(true);
    try {
      const list = await listAttendanceHistory(workspace, {
        halaqaId: selectedHalaqaId,
        mosqueIds: restrictMosqueIds,
      });
      setHistory(list);
    } finally {
      setLoadingHistory(false);
    }
  }, [workspace, selectedHalaqaId, restrictMosqueIds]);

  const loadSheet = useCallback(async () => {
    if (!selectedHalaqaId || !dateKey) {
      setEntries([]);
      setExistingRecord(null);
      return;
    }
    setLoadingSheet(true);
    setFeedback(null);
    try {
      const saved = await loadAttendanceRecord(workspace, selectedHalaqaId, dateKey);
      setExistingRecord(saved);
      const savedMap = new Map<string, AttendanceEntry>();
      if (saved) {
        for (const e of saved.entries) {
          savedMap.set(e.studentId, e);
        }
      }
      const merged: AttendanceEntry[] = halaqaStudents.map((st) => {
        const prev = savedMap.get(st.id);
        return {
          studentId: st.id,
          studentName: st.quadrupleName,
          status: prev?.status || 'present',
          note: prev?.note || '',
        };
      });
      // Include any previously recorded students who might no longer be listed
      if (saved) {
        const currentIds = new Set(halaqaStudents.map((s) => s.id));
        for (const e of saved.entries) {
          if (!currentIds.has(e.studentId)) {
            merged.push(e);
          }
        }
      }
      setEntries(merged);
    } finally {
      setLoadingSheet(false);
    }
  }, [workspace, selectedHalaqaId, dateKey, halaqaStudents]);

  useEffect(() => {
    void loadSheet();
  }, [loadSheet]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleStatusChange = (studentId: string, status: AttendanceStatus) => {
    setEntries((prev) =>
      prev.map((e) => (e.studentId === studentId ? { ...e, status } : e))
    );
  };

  const handleNoteChange = (studentId: string, note: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.studentId === studentId ? { ...e, note } : e))
    );
  };

  const handleMarkAll = (status: AttendanceStatus) => {
    setEntries((prev) => prev.map((e) => ({ ...e, status })));
  };

  const handleSave = async () => {
    if (!selectedMosqueId || !selectedHalaqaId) return;
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await saveAttendanceRecord({
        workspace,
        mosqueId: selectedMosqueId,
        halaqaId: selectedHalaqaId,
        dateKey,
        entries,
        recordedBy: currentUserId,
        recordedByName: currentUserName,
      });
      setExistingRecord(saved);
      await loadHistory();
      setFeedback({
        type: 'ok',
        text: `تم حفظ تحضير يوم ${dateKey} بنجاح (${entries.length} طالب). يمكنك تعديله في أي وقت.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حفظ سجل التحضير.',
      });
    } finally {
      setSaving(false);
    }
  };

  const summaryCounts = useMemo(() => {
    let present = 0;
    let absent = 0;
    let excused = 0;
    let late = 0;
    for (const e of entries) {
      if (e.status === 'present') present++;
      else if (e.status === 'absent') absent++;
      else if (e.status === 'excused') excused++;
      else if (e.status === 'late') late++;
    }
    return { present, absent, excused, late };
  }, [entries]);

  const activeMosqueName =
    visibleMosques.find((m) => m.id === selectedMosqueId)?.name || 'المسجد';
  const activeHalaqaName =
    mosqueHalaqat.find((h) => h.id === selectedHalaqaId)?.name || 'الحلقة';

  return (
    <div className="space-y-6">
      {/* Header & Selection Controls */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ClipboardCheck className="w-6 h-6 text-[#F56900]" />
            <div>
              <h2 className="font-display text-lg sm:text-xl font-extrabold text-[#4A220D]">
                سجل الحضور والغياب اليومي
              </h2>
              <p className="text-xs text-[#7D4E35]">
                اختر المسجد والحلقة والتاريخ لتحضير الطلاب أو تعديل تحضير أي يوم سابق في أي وقت.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setDateKey(getTodayDateKey())}
            className="duo-btn-cream w-full sm:w-auto min-h-[40px] px-3.5 py-1.5 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Calendar className="w-4 h-4 text-[#F56900]" />
            <span>تاريخ اليوم</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {!fixedMosqueId && (
            <div>
              <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                الجامع / المسجد
              </label>
              <select
                value={selectedMosqueId}
                onChange={(e) => setSelectedMosqueId(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
              >
                {visibleMosques.length === 0 ? (
                  <option value="">لا توجد مساجد متاحة</option>
                ) : (
                  visibleMosques.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}

          {!fixedHalaqaId && (
            <div>
              <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
                الحلقة
              </label>
              <select
                value={selectedHalaqaId}
                onChange={(e) => setSelectedHalaqaId(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
              >
                {mosqueHalaqat.length === 0 ? (
                  <option value="">لا توجد حلقات في هذا المسجد</option>
                ) : (
                  mosqueHalaqat.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}

          <div className={fixedMosqueId && fixedHalaqaId ? 'md:col-span-3 max-w-xs' : ''}>
            <label className="block font-display text-xs font-bold text-[#4A220D] mb-1.5">
              تاريخ التحضير
            </label>
            <input
              type="date"
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
              className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border-2 border-[#EADBC8] bg-white text-sm font-bold text-[#4A220D]"
            />
          </div>
        </div>

        {/* Summary Counters + Quick Mark All */}
        {selectedHalaqaId && entries.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t-2 border-[#F7EBDD]">
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 text-xs font-bold">
              <span className="px-3 py-1.5 rounded-xl bg-[#58CC02]/15 text-[#46A302] tabular-nums text-center">
                حاضر: {summaryCounts.present}
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-[#D95338]/12 text-[#D95338] tabular-nums text-center">
                غائب: {summaryCounts.absent}
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-[#2563EB]/12 text-[#1D4ED8] tabular-nums text-center">
                بعذر: {summaryCounts.excused}
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-[#F56900]/12 text-[#C95200] tabular-nums text-center">
                متأخر: {summaryCounts.late}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleMarkAll('present')}
                className="min-h-[40px] px-3 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#58CC02] text-xs font-bold text-[#4A220D] cursor-pointer"
              >
                تحضير الجميع (حاضر)
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="duo-btn-green min-h-[42px] px-5 py-2 rounded-xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Save className="w-4 h-4" />
                <span>
                  {saving
                    ? 'جاري الحفظ...'
                    : existingRecord
                    ? 'تحديث وحفظ التحضير'
                    : 'حفظ التحضير'}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

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

      {/* Attendance Sheet */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#F7EBDD]">
          <div>
            <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
              كشف تحضير: {activeHalaqaName} — {activeMosqueName}
            </h3>
            <p className="text-xs text-[#7D4E35]">
              التاريخ: <span className="font-bold text-[#4A220D]" dir="ltr">{dateKey}</span>
              {existingRecord
                ? ` · مسجّل مسبقاً بواسطة: ${existingRecord.recordedByName} (يمكنك التعديل الآن)`
                : ' · تحضير جديد لهذا اليوم'}
            </p>
          </div>
        </div>

        {loadingSheet ? (
          <ModernLoader label="جاري تحميل قائمة طلاب الحلقة..." />
        ) : !selectedHalaqaId ? (
          <p className="text-sm text-[#7D4E35] py-4 text-center">
            اختر مسجداً وحلقة لعرض طلابها.
          </p>
        ) : entries.length === 0 ? (
          <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-6 text-center text-sm font-bold text-[#7D4E35]">
            لا يوجد طلاب مسجلون في هذه الحلقة بعد.
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry, idx) => (
              <div
                key={entry.studentId}
                className="bg-[#FDF6EE] border-2 border-[#EADBC8] rounded-2xl p-3.5 sm:p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-xl bg-white border border-[#EADBC8] font-display font-extrabold text-xs text-[#7D4E35] inline-flex items-center justify-center shrink-0 tabular-nums">
                    {idx + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                      {entry.studentName}
                    </p>
                    <p className="text-[11px] font-bold text-[#7D4E35]">
                      الحالة المختارة: {ATTENDANCE_STATUS_LABELS[entry.status]}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {STATUS_BUTTONS.map((btn) => {
                      const Icon = btn.icon;
                      const isActive = entry.status === btn.key;
                      return (
                        <button
                          key={btn.key}
                          type="button"
                          onClick={() => handleStatusChange(entry.studentId, btn.key)}
                          className={`min-h-[42px] px-2.5 py-1.5 rounded-xl border-2 font-display text-xs font-bold inline-flex items-center justify-center gap-1 cursor-pointer transition-colors whitespace-nowrap ${
                            isActive ? btn.activeClass : btn.idleClass
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          <span>{btn.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <input
                    type="text"
                    value={entry.note}
                    onChange={(e) => handleNoteChange(entry.studentId, e.target.value)}
                    placeholder="ملاحظة أو عذر (اختياري)..."
                    maxLength={200}
                    className="sm:w-52 min-h-[42px] px-3 py-1.5 rounded-xl border-2 border-[#EADBC8] bg-white text-xs text-[#4A220D] focus:outline-none focus:border-[#F56900]"
                  />
                </div>
              </div>
            ))}

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="duo-btn-orange w-full sm:w-auto min-h-[46px] px-7 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Save className="w-4 h-4" />
                <span>
                  {saving
                    ? 'جاري الحفظ...'
                    : existingRecord
                    ? 'حفظ تعديلات التحضير'
                    : 'حفظ التحضير'}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Previous Days Attendance Archive */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-[#F56900]" />
          <h3 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
            سجلات التحضير للأيام السابقة ({activeHalaqaName})
          </h3>
        </div>

        {loadingHistory ? (
          <ModernLoader label="جاري تحميل سجل الأيام السابقة..." />
        ) : history.length === 0 ? (
          <p className="text-xs sm:text-sm text-[#7D4E35]">
            لم يتم حفظ أي تحضير لهذه الحلقة بعد. عند حفظ تحضير اليوم سيظهر هنا للرجوع إليه وتعديله في أي وقت.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {history.map((rec) => {
              const presentCnt = rec.entries.filter((e) => e.status === 'present').length;
              const absentCnt = rec.entries.filter((e) => e.status === 'absent').length;
              const excusedCnt = rec.entries.filter((e) => e.status === 'excused').length;
              const lateCnt = rec.entries.filter((e) => e.status === 'late').length;
              const isSelectedDate = rec.dateKey === dateKey;

              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => setDateKey(rec.dateKey)}
                  className={`text-right rounded-2xl border-2 p-4 transition-colors cursor-pointer space-y-2 ${
                    isSelectedDate
                      ? 'bg-[#F56900]/10 border-[#F56900]'
                      : 'bg-[#FDF6EE] border-[#EADBC8] hover:border-[#F56900]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-extrabold text-sm text-[#4A220D]" dir="ltr">
                      {rec.dateKey}
                    </span>
                    <span className="text-[11px] font-bold text-[#F56900]">
                      {isSelectedDate ? 'مفتوح الآن' : 'عرض / تعديل'}
                    </span>
                  </div>
                  <p className="text-xs text-[#7D4E35] tabular-nums">
                    حاضر {presentCnt} · غائب {absentCnt} · بعذر {excusedCnt} · متأخر {lateCnt}
                  </p>
                  <p className="text-[11px] text-[#7D4E35] truncate">
                    المسجِّل: {rec.recordedByName}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
