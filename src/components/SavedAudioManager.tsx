import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  base64AudioToObjectUrl,
  generateNoorAlBayanOnServer,
  synthesizeSpeechOnServer,
} from '../services/bookStorage';
import { generateNoorAlBayanClientFallback } from '../services/clientArabicEngine';
import {
  deleteSavedWordAudioEntry,
  listAllSavedWordAudioEntries,
  overwriteSavedWordAudioEntry,
} from '../services/platformService';
import type { NoorAlBayanStep, SavedWordAudioBrowserItem } from '../types/platform';
import { ModernLoader } from './ModernLoader';

function formatBytesArabic(bytes: number): string {
  const clean = Math.max(0, Number(bytes) || 0);
  if (clean < 1024) return `${clean} بايت`;
  if (clean < 1024 * 1024) return `${(clean / 1024).toFixed(1)} كيلوبايت`;
  return `${(clean / (1024 * 1024)).toFixed(2)} ميجابايت`;
}

interface SavedAudioManagerProps {
  onAudioMutated?: () => void;
}

export const SavedAudioManager: React.FC<SavedAudioManagerProps> = ({
  onAudioMutated,
}) => {
  const [items, setItems] = useState<SavedWordAudioBrowserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<'all' | 'noor_albayan' | 'normal'>('all');
  const [dbFilter, setDbFilter] = useState<string>('all');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [playingDocKey, setPlayingDocKey] = useState<string | null>(null);
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeUrlRef = useRef<string | null>(null);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
      } catch {
        // ignore
      }
    }
    if (activeUrlRef.current) {
      URL.revokeObjectURL(activeUrlRef.current);
      activeUrlRef.current = null;
    }
    setPlayingDocKey(null);
  }, []);

  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, [stopAudio]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const list = await listAllSavedWordAudioEntries();
      setItems(list);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر جلب قائمة الأصوات المحفوظة.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const dbOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (!map.has(item.dbKey)) {
        map.set(item.dbKey, item.dbLabel);
      }
    }
    return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (modeFilter !== 'all' && item.record.mode !== modeFilter) return false;
      if (dbFilter !== 'all' && item.dbKey !== dbFilter) return false;
      if (!q) return true;
      const hay = `${item.record.wordText || ''} ${item.record.diacritizedWord || ''} ${item.record.fullReading || ''} ${item.dbLabel}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, searchQuery, modeFilter, dbFilter]);

  const handlePlayItem = (item: SavedWordAudioBrowserItem) => {
    const key = `${item.dbKey}::${item.docId}`;
    if (playingDocKey === key) {
      stopAudio();
      return;
    }
    stopAudio();
    if (!item.record.audioBase64 || item.record.audioBase64.length < 100) {
      setFeedback({
        type: 'err',
        text: `السجل "${item.record.wordText}" يحتوي على نص التهجي فقط بدون ملف WAV.`,
      });
      return;
    }
    try {
      const objUrl = base64AudioToObjectUrl(
        item.record.audioBase64,
        item.record.mimeType || 'audio/wav'
      );
      activeUrlRef.current = objUrl;
      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      const audio = audioRef.current;
      audio.src = objUrl;
      audio.onended = () => stopAudio();
      audio.onerror = () => {
        stopAudio();
        setFeedback({ type: 'err', text: 'تعذّر تشغيل مقطع الصوت.' });
      };
      setPlayingDocKey(key);
      void audio.play().catch(() => {
        stopAudio();
        setFeedback({ type: 'err', text: 'تعذّر بدء تشغيل الصوت.' });
      });
    } catch {
      setFeedback({ type: 'err', text: 'بيانات الصوت في هذا السجل غير صالحة.' });
    }
  };

  const handleDeleteItem = async (item: SavedWordAudioBrowserItem) => {
    const key = `${item.dbKey}::${item.docId}`;
    setDeletingKey(key);
    setFeedback(null);
    if (playingDocKey === key) stopAudio();
    try {
      await deleteSavedWordAudioEntry(item);
      setItems((prev) => prev.filter((x) => `${x.dbKey}::${x.docId}` !== key));
      setConfirmDeleteKey(null);
      onAudioMutated?.();
      setFeedback({
        type: 'ok',
        text: `تم حذف صوت "${item.record.wordText}" بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر حذف الصوت.',
      });
    } finally {
      setDeletingKey(null);
    }
  };

  const handleRegenerateItem = async (item: SavedWordAudioBrowserItem) => {
    const key = `${item.dbKey}::${item.docId}`;
    setRegeneratingKey(key);
    setFeedback(null);
    if (playingDocKey === key) stopAudio();

    try {
      const word = item.record.wordText;
      const mode: 'noor_albayan' | 'normal' =
        item.record.mode === 'normal' ? 'normal' : 'noor_albayan';

      let diacritizedWord = item.record.diacritizedWord || word;
      let wasAutoDiacritized = Boolean(item.record.wasAutoDiacritized);
      let steps: NoorAlBayanStep[] = Array.isArray(item.record.steps) ? item.record.steps : [];
      let fullReading = item.record.fullReading || word;

      if (mode === 'noor_albayan') {
        const fallback = generateNoorAlBayanClientFallback(word, {});
        diacritizedWord = fallback.diacritizedWord;
        wasAutoDiacritized = fallback.wasAutoDiacritized;
        steps = fallback.steps;
        fullReading = fallback.fullReading;

        const breakdown = await generateNoorAlBayanOnServer({ text: word }).catch(() => null);
        if (breakdown) {
          diacritizedWord = breakdown.diacritizedWord;
          wasAutoDiacritized = breakdown.wasAutoDiacritized;
          steps = breakdown.steps;
          fullReading = breakdown.fullReading || breakdown.diacritizedWord;
        }
      } else {
        diacritizedWord = word;
        fullReading = word;
        steps = [];
      }

      const tts = await synthesizeSpeechOnServer({
        text: fullReading,
        mode,
      });

      if (tts.engine !== 'server_wav' || !tts.audioBase64 || tts.audioBase64.length < 120) {
        throw new Error(
          tts.error || 'تعذّر إعادة توليد الصوت من Gemini TTS حالياً؛ حاول بعد قليل.'
        );
      }

      const updatedRecord = await overwriteSavedWordAudioEntry({
        item,
        diacritizedWord,
        wasAutoDiacritized,
        fullReading: tts.text || fullReading,
        steps,
        audioBase64: tts.audioBase64,
        mimeType: tts.mimeType || 'audio/wav',
      });

      setItems((prev) =>
        prev.map((x) =>
          `${x.dbKey}::${x.docId}` === key
            ? {
                ...x,
                record: updatedRecord,
                approxBytes: Number(updatedRecord.byteSize) || x.approxBytes,
              }
            : x
        )
      );
      onAudioMutated?.();
      setFeedback({
        type: 'ok',
        text: `تمت إعادة إنشاء وحفظ الصوت الجديد لعبارة "${word}" بنجاح.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'تعذّر إعادة إنشاء الصوت.',
      });
    } finally {
      setRegeneratingKey(null);
    }
  };

  return (
    <div className="space-y-5" dir="rtl">
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

      {/* Search & Filter Header */}
      <section className="bg-white border-2 border-[#EADBC8] rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-display font-extrabold text-[#F56900]">
              <Volume2 className="w-4 h-4" />
              <span>مراجعة والتحكم في مكتبة الأصوات</span>
            </div>
            <h2 className="font-display text-xl font-extrabold text-[#4A220D]">
              الأصوات المحفوظة عبر قواعد المنصة ({filteredItems.length.toLocaleString('en-US')})
            </h2>
            <p className="text-xs text-[#7D4E35]">
              تصفّح كل كلمة أو آية تم توليد صوتها، استمع إليها، احذف غير المناسب، أو أعد توليد صوتها بنقرة واحدة مع ضبط التشكيل الدقيق.
            </p>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadEntries()}
            className="duo-btn-orange min-h-[42px] px-4 py-2 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>تحديث القائمة</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5 relative">
            <Search className="w-4 h-4 text-[#7D4E35] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث بالكلمة أو التشكيل أو اسم القاعدة..."
              className="w-full min-h-[42px] pr-10 pl-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-xs sm:text-sm font-bold text-[#4A220D] focus:outline-none focus:border-[#F56900]"
            />
          </div>

          <div className="md:col-span-3">
            <select
              value={modeFilter}
              onChange={(e) =>
                setModeFilter(e.target.value as 'all' | 'noor_albayan' | 'normal')
              }
              aria-label="تصفية حسب النمط"
              className="w-full min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-xs font-bold text-[#4A220D] cursor-pointer"
            >
              <option value="all">جميع الأنماط (تهجي + قراءة)</option>
              <option value="noor_albayan">تهجي الفتح الرباني فقط</option>
              <option value="normal">قراءة مباشرة فقط</option>
            </select>
          </div>

          <div className="md:col-span-4">
            <select
              value={dbFilter}
              onChange={(e) => setDbFilter(e.target.value)}
              aria-label="تصفية حسب قاعدة البيانات"
              className="w-full min-h-[42px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-xs font-bold text-[#4A220D] cursor-pointer"
            >
              <option value="all">جميع قواعد البيانات ({dbOptions.length})</option>
              {dbOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Audio Entries List */}
      {loading ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
          <ModernLoader label="جاري قراءة الأصوات المحفوظة من جميع القواعد..." />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10 text-center space-y-2">
          <Volume2 className="w-10 h-10 text-[#EADBC8] mx-auto" />
          <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
            لا توجد أصوات مطابقة حالياً
          </h3>
          <p className="text-xs text-[#7D4E35]">
            عند تشغيل أو تهجي أي كلمة في الكتب أو العروض التقديمية، سيُحفظ صوتها تلقائياً ويظهر هنا للمراجعة والتحكم.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredItems.slice(0, 120).map((item) => {
            const key = `${item.dbKey}::${item.docId}`;
            const isPlaying = playingDocKey === key;
            const isRegen = regeneratingKey === key;
            const isDel = deletingKey === key;
            const hasWav = Boolean(item.record.audioBase64 && item.record.audioBase64.length > 100);

            return (
              <article
                key={key}
                className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 flex flex-col justify-between gap-3 hover:border-[#F56900]/60 transition-colors"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-quran text-2xl sm:text-3xl text-[#4A220D] leading-[2.0] break-words">
                        {item.record.diacritizedWord || item.record.wordText}
                      </p>
                      {item.record.wordText !== item.record.diacritizedWord && (
                        <p className="text-[11px] font-bold text-[#7D4E35]">
                          الأصل: {item.record.wordText}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span
                        className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold ${
                          item.record.mode === 'noor_albayan'
                            ? 'bg-[#F56900]/12 text-[#F56900]'
                            : 'bg-[#58CC02]/15 text-[#357A02]'
                        }`}
                      >
                        {item.record.mode === 'noor_albayan' ? 'تهجي الفتح الرباني' : 'قراءة مباشرة'}
                      </span>
                      <span className="text-[10px] font-bold text-[#7D4E35] tabular-nums">
                        {formatBytesArabic(item.approxBytes)}
                      </span>
                    </div>
                  </div>

                  {item.record.fullReading && (
                    <p className="text-xs font-bold text-[#4A220D]/80 bg-[#FDF6EE] border border-[#EADBC8] rounded-xl px-3 py-1.5 leading-relaxed line-clamp-2">
                      {item.record.fullReading}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#7D4E35] font-bold">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#FDF6EE] border border-[#EADBC8]">
                      <Database className="w-3 h-3 text-[#F56900]" />
                      {item.dbLabel}
                    </span>
                    {!hasWav && (
                      <span className="px-2 py-0.5 rounded-md bg-[#FFA900]/15 text-[#B45309]">
                        نص بدون ملف صوتي
                      </span>
                    )}
                  </div>
                </div>

                {/* Action Row */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#F7EBDD]">
                  <button
                    type="button"
                    disabled={!hasWav && !isPlaying}
                    onClick={() => handlePlayItem(item)}
                    className={`min-h-[36px] px-3 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 ${
                      isPlaying
                        ? 'bg-[#D95338] text-white'
                        : 'duo-btn-green'
                    }`}
                  >
                    {isPlaying ? (
                      <>
                        <Square className="w-3.5 h-3.5" />
                        <span>إيقاف</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        <span>استماع</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={isRegen || isDel}
                    onClick={() => void handleRegenerateItem(item)}
                    className="min-h-[36px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:border-[#F56900] text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isRegen ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#F56900]" />
                    ) : (
                      <RotateCw className="w-3.5 h-3.5 text-[#F56900]" />
                    )}
                    <span>إعادة إنشاء</span>
                  </button>

                  {confirmDeleteKey === key ? (
                    <div className="inline-flex items-center gap-1 mr-auto bg-[#D95338]/10 border border-[#D95338]/40 rounded-xl px-2 py-1">
                      <button
                        type="button"
                        disabled={isDel}
                        onClick={() => void handleDeleteItem(item)}
                        className="px-2.5 py-1 rounded-lg bg-[#D95338] text-white text-[11px] font-bold cursor-pointer"
                      >
                        {isDel ? 'جاري الحذف...' : 'تأكيد الحذف'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteKey(null)}
                        className="px-2 py-1 rounded-lg bg-white text-[#4A220D] text-[11px] font-bold cursor-pointer"
                      >
                        إلغاء
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={isRegen || isDel}
                      onClick={() => setConfirmDeleteKey(key)}
                      aria-label={`حذف صوت ${item.record.wordText}`}
                      className="min-h-[36px] px-2.5 rounded-xl border-2 border-[#EADBC8] hover:border-[#D95338] text-[#D95338] font-display font-bold text-xs inline-flex items-center gap-1 mr-auto cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>حذف</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {filteredItems.length > 120 && (
        <p className="text-center text-xs font-bold text-[#7D4E35]">
          يتم عرض أول ١٢٠ صوتاً فقط من أصل {filteredItems.length.toLocaleString('en-US')}؛ استخدم مربع البحث للوصول السريع لأي كلمة.
        </p>
      )}
    </div>
  );
};
