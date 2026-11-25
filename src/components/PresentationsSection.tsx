import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  FileUp,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Presentation,
  Repeat,
  Save,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import { toArabicIndicDigits } from '../services/mushafService';
import type { ComplexWorkspaceData } from '../services/platformService';
import {
  deletePresentationRecord,
  generateOrEditPresentationWithAi,
  listPresentationsInComplex,
  parsePptxFile,
  sanitizeSlideHtml,
  savePresentationRecord,
  type ParsedPptxSlide,
} from '../services/presentationService';
import type {
  PresentationChatTurn,
  PresentationRecord,
  PresentationSlide,
  PresentationThemeTone,
} from '../types/platform';
import { ModernLoader } from './ModernLoader';
import {
  SlideArabicAudioBar,
  type SlideAudioCommand,
  type SlideAudioPlayMode,
  type SlideAudioTarget,
} from './SlideArabicAudioBar';

interface PresentationsSectionProps {
  workspace: ComplexWorkspaceData;
  currentUserId: string;
  currentUserName: string;
  fixedMosqueId?: string;
  fixedHalaqaId?: string;
}

const STARTER_IDEAS: string[] = [
  'اعملي عرض تقديمي تفاعلي عن سورة الفاتحة مع التهجي وتلاوة الآيات وشرح المعاني للأطفال',
  'أنشئ عرضاً تعليمياً عن أحكام المد الطبيعي والمد المتصل مع أمثلة مشكولة بالفتح الرباني',
  'صمّم درساً تفاعلياً عن اللام الشمسية واللام القمرية بكلمات مشكولة قابلة للتهجي',
  'أعدّ عرضاً مبسطاً لآداب تلاوة القرآن الكريم وحلقة التحفيظ',
];

function getToneFrameClasses(tone: PresentationThemeTone): string {
  switch (tone) {
    case 'orange':
      return 'bg-[#FFFDF9] border-[#F56900]/45';
    case 'green':
      return 'bg-[#FAFEF6] border-[#58CC02]/50';
    case 'espresso':
      return 'bg-[#FDF6EE] border-[#4A220D]/30';
    case 'cream':
    default:
      return 'bg-white border-[#EADBC8]';
  }
}

function getLayoutBadgeLabel(layout: PresentationSlide['layout']): string {
  switch (layout) {
    case 'cover':
      return 'غلاف';
    case 'quran_ayah':
      return 'آيات وتلاوة';
    case 'tahajji_words':
      return 'تهجي وتدريب';
    case 'comparison':
      return 'مقارنة';
    case 'summary':
      return 'خلاصة';
    default:
      return 'محتوى';
  }
}

export const PresentationsSection: React.FC<PresentationsSectionProps> = ({
  workspace,
  currentUserId,
  currentUserName,
  fixedMosqueId = '',
  fixedHalaqaId = '',
}) => {
  const [viewMode, setViewMode] = useState<'library' | 'studio'>('library');
  const [presentations, setPresentations] = useState<PresentationRecord[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Active Deck Studio State
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [deckTitle, setDeckTitle] = useState<string>('عرض تعليمي تفاعلي جديد');
  const [deckDescription, setDeckDescription] = useState<string>('');
  const [sourceType, setSourceType] = useState<'ai' | 'pptx_import'>('ai');
  const [sourceFileName, setSourceFileName] = useState<string>('');
  const [slides, setSlides] = useState<PresentationSlide[]>([]);
  const [activeSlideIndex, setActiveSlideIndex] = useState<number>(0);
  const [chatHistory, setChatHistory] = useState<PresentationChatTurn[]>([]);

  // AI Composer & PPTX State
  const [chatInput, setChatInput] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [editTargetMode, setEditTargetMode] = useState<'deck' | 'current_slide'>('deck');
  const [pendingPptxSlides, setPendingPptxSlides] = useState<ParsedPptxSlide[] | null>(null);
  const [parsingPptx, setParsingPptx] = useState(false);

  // Persistence & Presenter Mode
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [selectedAudioTarget, setSelectedAudioTarget] = useState<SlideAudioTarget | null>(null);
  const [audioCommand, setAudioCommand] = useState<SlideAudioCommand | null>(null);
  const [speakerMenu, setSpeakerMenu] = useState<{
    target: SlideAudioTarget;
    top: number;
    left: number;
  } | null>(null);

  const pptxInputRef = useRef<HTMLInputElement | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const loadLibrary = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const list = await listPresentationsInComplex(workspace);
      setPresentations(list);
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : 'تعذّر تحميل العروض التقديمية المحفوظة.'
      );
    } finally {
      setLoadingList(false);
    }
  }, [workspace]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, aiGenerating]);

  const currentSlide = slides[activeSlideIndex] || null;

  useEffect(() => {
    if (!currentSlide) {
      setSelectedAudioTarget(null);
      return;
    }
    const firstBlock = currentSlide.interactiveBlocks?.[0];
    if (firstBlock) {
      setSelectedAudioTarget({
        text: firstBlock.arabicText,
        type: firstBlock.type,
        surahNumber: firstBlock.surahNumber,
        ayahNumber: firstBlock.ayahNumber,
        surahName: firstBlock.surahName,
        label: firstBlock.label,
      });
    } else {
      setSelectedAudioTarget(null);
    }
  }, [activeSlideIndex, currentSlide]);

  useEffect(() => {
    setAudioCommand(null);
    setSpeakerMenu(null);
  }, [activeSlideIndex]);

  const setFullscreenMode = useCallback((open: boolean) => {
    setAudioCommand(null);
    setSpeakerMenu(null);
    setFullscreenOpen(open);
  }, []);

  const openNewStudio = (options?: {
    initialPrompt?: string;
    autoStartPptx?: boolean;
  }) => {
    setActiveId(undefined);
    setDeckTitle('عرض تعليمي تفاعلي جديد');
    setDeckDescription('');
    setSourceType('ai');
    setSourceFileName('');
    setSlides([]);
    setActiveSlideIndex(0);
    setChatHistory([]);
    setEditTargetMode('deck');
    setPendingPptxSlides(null);
    setAiError(null);
    setSaveFeedback(null);
    setHasUnsavedChanges(false);
    setAudioCommand(null);
    setSpeakerMenu(null);
    setFullscreenOpen(false);
    setChatInput(options?.initialPrompt || '');
    setViewMode('studio');
    if (options?.autoStartPptx) {
      window.setTimeout(() => pptxInputRef.current?.click(), 120);
    } else {
      window.setTimeout(() => chatInputRef.current?.focus(), 120);
    }
  };

  const openExistingPresentation = (
    rec: PresentationRecord,
    startFullscreen = false
  ) => {
    setActiveId(rec.id);
    setDeckTitle(rec.title);
    setDeckDescription(rec.description || '');
    setSourceType(rec.sourceType || 'ai');
    setSourceFileName(rec.sourceFileName || '');
    setSlides(rec.slides || []);
    setActiveSlideIndex(0);
    setChatHistory(rec.chatHistory || []);
    setEditTargetMode('deck');
    setPendingPptxSlides(null);
    setAiError(null);
    setSaveFeedback(null);
    setHasUnsavedChanges(false);
    setAudioCommand(null);
    setSpeakerMenu(null);
    setViewMode('studio');
    setFullscreenOpen(startFullscreen);
  };

  const persistDeckToDb = useCallback(
    async (params: {
      overrideId?: string;
      title: string;
      description: string;
      srcType: 'ai' | 'pptx_import';
      srcFileName: string;
      nextSlides: PresentationSlide[];
      nextHistory: PresentationChatTurn[];
      silent?: boolean;
    }) => {
      if (params.nextSlides.length === 0) return;
      setSaving(true);
      try {
        const saved = await savePresentationRecord({
          workspace,
          id: params.overrideId,
          mosqueId: fixedMosqueId,
          halaqaId: fixedHalaqaId,
          title: params.title,
          description: params.description,
          sourceType: params.srcType,
          sourceFileName: params.srcFileName,
          slides: params.nextSlides,
          chatHistory: params.nextHistory,
          createdBy: currentUserId,
          createdByName: currentUserName,
        });
        setActiveId(saved.id);
        setHasUnsavedChanges(false);
        setPresentations((prev) => {
          const rest = prev.filter((p) => p.id !== saved.id);
          return [saved, ...rest];
        });
        if (!params.silent) {
          setSaveFeedback('تم حفظ العرض التقديمي بنجاح.');
          window.setTimeout(() => setSaveFeedback(null), 3500);
        }
      } catch (err) {
        setAiError(
          err instanceof Error ? err.message : 'تعذّر حفظ العرض التقديمي حالياً.'
        );
      } finally {
        setSaving(false);
      }
    },
    [workspace, fixedMosqueId, fixedHalaqaId, currentUserId, currentUserName]
  );

  const handleSendAiPrompt = async (overridePrompt?: string, overridePptx?: ParsedPptxSlide[], overrideFileName?: string) => {
    const pptxToUse = overridePptx || pendingPptxSlides || undefined;
    const rawText = (overridePrompt ?? chatInput).trim();
    const promptText =
      rawText ||
      (pptxToUse
        ? 'حوّل ملف الباوربوينت المرفق إلى عرض تقديمي تفاعلي بثيم منصة براعم عمران مع التشكيل والتهجي.'
        : '');
    if (!promptText || aiGenerating) return;

    const targetedIdx =
      editTargetMode === 'current_slide' && slides.length > 0 && !pptxToUse
        ? activeSlideIndex
        : undefined;

    const userTurn: PresentationChatTurn = {
      id: `pt_u_${Date.now()}`,
      role: 'user',
      text: promptText,
      timestampMs: Date.now(),
      ...(typeof targetedIdx === 'number' ? { targetSlideIndex: targetedIdx } : {}),
    };

    const historyBefore = chatHistory.map((h) => ({ role: h.role, text: h.text }));
    const nextHistoryPending = [...chatHistory, userTurn];
    setChatHistory(nextHistoryPending);
    if (!overridePrompt) setChatInput('');
    setAiError(null);
    setAiGenerating(true);

    try {
      const response = await generateOrEditPresentationWithAi({
        message: promptText,
        history: historyBefore,
        presentationTitle: deckTitle,
        currentSlides: slides,
        targetSlideIndex: targetedIdx,
        importedPptxSlides: pptxToUse,
        complexId: workspace.complex.id,
        accountId: currentUserId,
      });

      let mergedSlides: PresentationSlide[];
      let nextActiveIdx = activeSlideIndex;

      if (
        response.operation === 'update_slide' &&
        slides.length > 0 &&
        response.slides.length >= 1
      ) {
        const idxToUpdate =
          typeof targetedIdx === 'number'
            ? targetedIdx
            : typeof response.targetSlideIndex === 'number' &&
              response.targetSlideIndex >= 0 &&
              response.targetSlideIndex < slides.length
            ? response.targetSlideIndex
            : activeSlideIndex;

        mergedSlides = slides.map((s, i) =>
          i === idxToUpdate ? { ...response.slides[0], order: i } : s
        );
        nextActiveIdx = idxToUpdate;
      } else if (response.operation === 'append_slides' && slides.length > 0) {
        mergedSlides = [...slides, ...response.slides].map((s, i) => ({
          ...s,
          order: i,
        }));
        nextActiveIdx = slides.length;
      } else {
        mergedSlides = response.slides.map((s, i) => ({ ...s, order: i }));
        nextActiveIdx = 0;
      }

      const nextTitle =
        response.deckTitle && (slides.length === 0 || Boolean(pptxToUse) || response.operation === 'replace_deck')
          ? response.deckTitle
          : deckTitle;
      const nextDesc = response.description || deckDescription;
      const nextSourceType: 'ai' | 'pptx_import' = pptxToUse ? 'pptx_import' : sourceType;
      const nextFileName = overrideFileName || sourceFileName;

      const modelTurn: PresentationChatTurn = {
        id: `pt_m_${Date.now()}`,
        role: 'model',
        text: response.assistantReply,
        timestampMs: Date.now(),
        ...(typeof targetedIdx === 'number' ? { targetSlideIndex: targetedIdx } : {}),
      };
      const finalHistory = [...nextHistoryPending, modelTurn].slice(-60);

      setSlides(mergedSlides);
      setActiveSlideIndex(Math.max(0, Math.min(mergedSlides.length - 1, nextActiveIdx)));
      setDeckTitle(nextTitle);
      setDeckDescription(nextDesc);
      setSourceType(nextSourceType);
      setSourceFileName(nextFileName);
      setChatHistory(finalHistory);
      if (pptxToUse) {
        setPendingPptxSlides(null);
      }
      setEditTargetMode('deck');

      await persistDeckToDb({
        overrideId: activeId,
        title: nextTitle,
        description: nextDesc,
        srcType: nextSourceType,
        srcFileName: nextFileName,
        nextSlides: mergedSlides,
        nextHistory: finalHistory,
        silent: false,
      });
    } catch (err) {
      setAiError(
        err instanceof Error ? err.message : 'تعذّر إنشاء أو تعديل الشرائح حالياً.'
      );
    } finally {
      setAiGenerating(false);
    }
  };

  const handlePptxFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setAiError(null);
    setParsingPptx(true);
    try {
      const parsedSlides = await parsePptxFile(file);
      setPendingPptxSlides(parsedSlides);
      setSourceType('pptx_import');
      setSourceFileName(file.name);
      if (viewMode !== 'studio') {
        setActiveId(undefined);
        setDeckTitle(file.name.replace(/\.pptx$/i, ''));
        setDeckDescription(`عرض مستورد من ملف ${file.name}`);
        setSlides([]);
        setChatHistory([]);
        setViewMode('studio');
      }
      await handleSendAiPrompt(
        `حوّل ملف الباوربوينت "${file.name}" (${toArabicIndicDigits(parsedSlides.length)} شريحة) إلى شرائح تفاعلية جميلة بثيم منصة براعم عمران مع التشكيل والتهجي والآيات.`,
        parsedSlides,
        file.name
      );
    } catch (err) {
      setAiError(
        err instanceof Error ? err.message : 'تعذّر قراءة ملف الباوربوينت (.pptx).'
      );
    } finally {
      setParsingPptx(false);
    }
  };

  const handleAddBlankSlide = () => {
    const newIndex = slides.length;
    const blank: PresentationSlide = {
      id: `slide_${Date.now()}`,
      order: newIndex,
      title: `شريحة جديدة (${toArabicIndicDigits(newIndex + 1)})`,
      subtitle: 'اطلب من الذكاء الاصطناعي تعديل هذه الشريحة أو تعبئتها',
      layout: 'points',
      themeTone: 'cream',
      htmlContent: `<div class="space-y-4 p-2"><h3 class="font-display text-2xl font-extrabold text-[#4A220D]">شريحة قابلة للتخصيص بالذكاء الاصطناعي</h3><p class="text-sm text-[#7D4E35]">اختر «تعديل هذه الشريحة بالـ AI» واكتب ما تريده فيها من آيات أو كلمات للتهجي أو نقاط شرح.</p><div class="flex flex-wrap gap-2"><span data-tahajji="true" class="tahajji-chip font-quran text-xl leading-[2.1] inline-flex items-center px-4 py-2 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE] text-[#4A220D] font-bold cursor-pointer">بِسْمِ اللَّهِ</span></div></div>`,
      interactiveBlocks: [
        {
          id: `blk_new_${Date.now()}`,
          type: 'tahajji_words',
          label: 'تدريب',
          arabicText: 'بِسْمِ اللَّهِ',
        },
      ],
      speakerNotes: '',
    };
    const next = [...slides, blank];
    setSlides(next);
    setActiveSlideIndex(newIndex);
    setHasUnsavedChanges(true);
  };

  const handleDeleteCurrentSlide = () => {
    if (slides.length <= 1) return;
    const next = slides
      .filter((_, i) => i !== activeSlideIndex)
      .map((s, i) => ({ ...s, order: i }));
    setSlides(next);
    setActiveSlideIndex((prev) => Math.max(0, Math.min(next.length - 1, prev)));
    setHasUnsavedChanges(true);
  };

  const handleDeletePresentation = async (id: string) => {
    setDeletingId(id);
    try {
      await deletePresentationRecord(workspace, id);
      setPresentations((prev) => prev.filter((p) => p.id !== id));
      if (activeId === id) {
        setViewMode('library');
        setActiveId(undefined);
      }
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : 'تعذّر حذف العرض التقديمي.'
      );
    } finally {
      setDeletingId(null);
    }
  };

  const openSpeakerPopoverAtElement = useCallback(
    (anchorEl: HTMLElement | null, target: SlideAudioTarget) => {
      setSelectedAudioTarget(target);
      if (typeof window === 'undefined' || !anchorEl) {
        setSpeakerMenu({
          target,
          top: 140,
          left: 24,
        });
        return;
      }
      const rect = anchorEl.getBoundingClientRect();
      const menuWidth = 280;
      const clampedLeft = Math.max(
        12,
        Math.min(window.innerWidth - menuWidth - 12, rect.left + rect.width / 2 - menuWidth / 2)
      );
      const preferBelow = rect.bottom + 240 < window.innerHeight;
      const topPos = preferBelow
        ? rect.bottom + 8
        : Math.max(12, rect.top - 220);
      setSpeakerMenu({
        target,
        top: topPos,
        left: clampedLeft,
      });
    },
    []
  );

  const dispatchAudioCommand = useCallback(
    (target: SlideAudioTarget, mode: SlideAudioPlayMode) => {
      setSelectedAudioTarget(target);
      setSpeakerMenu(null);
      setAudioCommand({
        id: Date.now() + Math.floor(Math.random() * 1000),
        target,
        mode,
      });
    },
    []
  );

  const handleSlideCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const speakerTrigger = target.closest('[data-speaker-trigger]') as HTMLElement | null;
    if (speakerTrigger) {
      e.stopPropagation();
      const attrText = (speakerTrigger.getAttribute('data-audio-text') || '').trim();
      const kind = speakerTrigger.getAttribute('data-audio-kind') || 'tahajji_words';
      const sNum = Number(speakerTrigger.getAttribute('data-surah') || 0);
      const aNum = Number(speakerTrigger.getAttribute('data-ayah-num') || 0);
      const sName = speakerTrigger.getAttribute('data-surah-name') || '';
      if (attrText) {
        openSpeakerPopoverAtElement(speakerTrigger, {
          text: attrText,
          type: kind === 'ayah' ? 'ayah' : 'tahajji_words',
          ...(sNum >= 1 && aNum >= 1
            ? { surahNumber: sNum, ayahNumber: aNum, surahName: sName }
            : {}),
        });
      }
      return;
    }

    const ayahCard = target.closest('[data-ayah], .quran-ayah-card') as HTMLElement | null;
    if (ayahCard) {
      const attrText = (ayahCard.getAttribute('data-audio-text') || '').trim();
      const txt = attrText || (ayahCard.textContent || '').replace(/استماع \/ تهجي/g, '').trim();
      const sNum = Number(ayahCard.getAttribute('data-surah') || 0);
      const aNum = Number(ayahCard.getAttribute('data-ayah-num') || 0);
      const sName = ayahCard.getAttribute('data-surah-name') || '';
      if (txt) {
        openSpeakerPopoverAtElement(ayahCard, {
          text: txt,
          type: 'ayah',
          ...(sNum >= 1 && aNum >= 1
            ? { surahNumber: sNum, ayahNumber: aNum, surahName: sName }
            : {}),
        });
      }
      return;
    }

    const chip = target.closest('[data-tahajji], .tahajji-chip') as HTMLElement | null;
    if (chip) {
      const attrText = (chip.getAttribute('data-audio-text') || '').trim();
      const txt = attrText || (chip.textContent || '').trim();
      if (txt) {
        openSpeakerPopoverAtElement(chip, {
          text: txt,
          type: 'tahajji_words',
        });
      }
      return;
    }

    // Fallback: if user taps inside a paragraph/heading containing Arabic words
    const textEl = target.closest('p, li, h2, h3, h4, td, th, span') as HTMLElement | null;
    if (textEl) {
      const txt = (textEl.textContent || '').trim();
      if (txt && /[\u0600-\u06FF]/.test(txt) && txt.length <= 240) {
        setSelectedAudioTarget({
          text: txt,
          type: 'card',
        });
      }
    }
  };

  const sanitizedCurrentHtml = useMemo(
    () => (currentSlide ? sanitizeSlideHtml(currentSlide.htmlContent) : ''),
    [currentSlide]
  );

  return (
    <div className="space-y-5" dir="rtl">
      <input
        ref={pptxInputRef}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={(e) => void handlePptxFileSelected(e)}
        className="hidden"
      />

      {/* Persistent Section Header with Fixed Top-Right Create Button (أعلى اليمين in RTL) */}
      <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Top-Right Fixed Primary Action */}
          <button
            type="button"
            onClick={() => openNewStudio()}
            className="duo-btn-orange min-h-[44px] px-4 py-2 rounded-2xl font-display font-extrabold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer shadow-sm"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>إنشاء عرض جديد</span>
          </button>

          <button
            type="button"
            disabled={parsingPptx || aiGenerating}
            onClick={() => pptxInputRef.current?.click()}
            className="duo-btn-cream min-h-[44px] px-3.5 py-2 rounded-2xl font-display font-bold text-xs sm:text-sm inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {parsingPptx ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#F56900]" />
            ) : (
              <FileUp className="w-4 h-4 text-[#F56900]" />
            )}
            <span>استيراد باوربوينت (.pptx)</span>
          </button>

          {viewMode === 'studio' && (
            <button
              type="button"
              onClick={() => {
                setAudioCommand(null);
                setSpeakerMenu(null);
                setFullscreenOpen(false);
                setViewMode('library');
              }}
              className="min-h-[42px] px-3 py-1.5 rounded-2xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:bg-white text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowRight className="w-4 h-4 text-[#F56900]" />
              <span>مكتبة العروض ({toArabicIndicDigits(presentations.length)})</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center shrink-0">
            <Presentation className="w-5 h-5" />
          </div>
          <div className="text-right">
            <h2 className="font-display text-base sm:text-lg font-extrabold text-[#4A220D]">
              استوديو العروض التقديمية التفاعلية
            </h2>
            <p className="text-[11px] sm:text-xs font-bold text-[#7D4E35]">
              إنشاء شرائح HTML بالذكاء الاصطناعي · تهجي الفتح الرباني · تلاوة الآيات · استيراد PowerPoint
            </p>
          </div>
        </div>
      </div>

      {/* ==================== LIBRARY VIEW ==================== */}
      {viewMode === 'library' && (
        <div className="space-y-4">
          {listError && (
            <div className="bg-[#D95338]/10 border border-[#D95338]/40 rounded-2xl px-4 py-3 text-xs font-bold text-[#D95338]">
              {listError}
            </div>
          )}

          {loadingList ? (
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-10">
              <ModernLoader label="جاري تحميل العروض التقديمية..." />
            </div>
          ) : presentations.length === 0 ? (
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-8 sm:p-12 text-center space-y-5 max-w-2xl mx-auto">
              <div className="w-16 h-16 rounded-3xl bg-[#F56900]/12 text-[#F56900] mx-auto flex items-center justify-center">
                <Presentation className="w-8 h-8" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display text-xl sm:text-2xl font-extrabold text-[#4A220D]">
                  لم يتم إنشاء عروض بعد
                </h3>
                <p className="text-xs sm:text-sm text-[#7D4E35] max-w-md mx-auto leading-relaxed">
                  أنشئ أول عرض تقديمي تفاعلي بالذكاء الاصطناعي مع قراءة الكلمات بالتهجي وتلاوة الآيات، أو ارفع ملف باوربوينت لتحويله تلقائياً إلى ثيم المنصة.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => openNewStudio()}
                  className="duo-btn-orange min-h-[48px] px-6 py-2.5 rounded-2xl font-display font-extrabold text-sm inline-flex items-center gap-2 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>أنشئ الآن</span>
                </button>
                <button
                  type="button"
                  onClick={() => openNewStudio({ autoStartPptx: true })}
                  className="duo-btn-cream min-h-[48px] px-5 py-2.5 rounded-2xl font-display font-bold text-sm inline-flex items-center gap-2 cursor-pointer"
                >
                  <FileUp className="w-4 h-4 text-[#F56900]" />
                  <span>استيراد ملف PowerPoint</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {presentations.map((pres) => (
                <article
                  key={pres.id}
                  className="bg-white border-2 border-[#EADBC8] hover:border-[#F56900] rounded-3xl p-5 flex flex-col justify-between gap-4 transition-colors"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`px-2.5 py-0.5 rounded-lg text-[11px] font-extrabold ${
                          pres.sourceType === 'pptx_import'
                            ? 'bg-[#58CC02]/15 text-[#357A02]'
                            : 'bg-[#F56900]/12 text-[#F56900]'
                        }`}
                      >
                        {pres.sourceType === 'pptx_import' ? 'مستورد من PowerPoint' : 'إنشاء AI تفاعلي'}
                      </span>
                      <span className="text-xs font-bold text-[#7D4E35] inline-flex items-center gap-1 tabular-nums">
                        <Layers className="w-3.5 h-3.5 text-[#F56900]" />
                        {toArabicIndicDigits(pres.slides.length)} شريحة
                      </span>
                    </div>

                    <h3 className="font-display font-extrabold text-base sm:text-lg text-[#4A220D] line-clamp-2">
                      {pres.title}
                    </h3>
                    {pres.description && (
                      <p className="text-xs text-[#7D4E35] line-clamp-2 leading-relaxed">
                        {pres.description}
                      </p>
                    )}
                    <p className="text-[11px] font-bold text-[#7D4E35]">
                      أعدّه: {pres.createdByName}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t border-[#F7EBDD]">
                    <button
                      type="button"
                      onClick={() => openExistingPresentation(pres, false)}
                      className="flex-1 duo-btn-orange min-h-[40px] px-3 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>فتح وتعديل</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openExistingPresentation(pres, true)}
                      title="عرض ملء الشاشة"
                      className="duo-btn-green min-h-[40px] px-3 rounded-xl font-display font-bold text-xs inline-flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>عرض</span>
                    </button>
                    <button
                      type="button"
                      disabled={deletingId === pres.id}
                      onClick={() => void handleDeletePresentation(pres.id)}
                      aria-label="حذف العرض"
                      className="min-h-[40px] w-10 rounded-xl border-2 border-[#EADBC8] hover:border-[#D95338] text-[#D95338] flex items-center justify-center cursor-pointer disabled:opacity-50"
                    >
                      {deletingId === pres.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================== STUDIO WORKSPACE (CANVAS RIGHT / AI CHAT LEFT in RTL) ==================== */}
      {viewMode === 'studio' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start" dir="rtl">
          {/* RIGHT PANEL IN RTL (first grid child = lg:col-span-8): INTERACTIVE HTML SLIDE CANVAS */}
          <section className="lg:col-span-8 space-y-3 min-w-0">
            {/* Canvas Top Controls */}
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-3 sm:p-4 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex-1 min-w-[200px]">
                <input
                  type="text"
                  value={deckTitle}
                  onChange={(e) => {
                    setDeckTitle(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="عنوان العرض التقديمي..."
                  className="w-full min-h-[40px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] font-display font-extrabold text-sm sm:text-base text-[#4A220D] focus:outline-none focus:border-[#F56900]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {slides.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditTargetMode('current_slide');
                        chatInputRef.current?.focus();
                      }}
                      className={`min-h-[38px] px-3 rounded-xl border-2 font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                        editTargetMode === 'current_slide'
                          ? 'bg-[#F56900] border-[#F56900] text-white'
                          : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D] hover:border-[#F56900]'
                      }`}
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      <span>تعديل هذه الشريحة بالـ AI</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setFullscreenMode(true)}
                      className="duo-btn-green min-h-[38px] px-3 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>عرض</span>
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={handleAddBlankSlide}
                  className="min-h-[38px] px-2.5 rounded-xl border-2 border-[#EADBC8] bg-white hover:bg-[#FDF6EE] text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-[#F56900]" />
                  <span>شريحة</span>
                </button>

                {slides.length > 1 && (
                  <button
                    type="button"
                    onClick={handleDeleteCurrentSlide}
                    title="حذف الشريحة الحالية"
                    className="min-h-[38px] w-9 rounded-xl border-2 border-[#EADBC8] hover:border-[#D95338] text-[#D95338] flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  disabled={saving || slides.length === 0}
                  onClick={() =>
                    void persistDeckToDb({
                      overrideId: activeId,
                      title: deckTitle,
                      description: deckDescription,
                      srcType: sourceType,
                      srcFileName: sourceFileName,
                      nextSlides: slides,
                      nextHistory: chatHistory,
                      silent: false,
                    })
                  }
                  className={`min-h-[40px] px-4 rounded-xl font-display font-extrabold text-xs inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                    hasUnsavedChanges || !activeId
                      ? 'duo-btn-orange'
                      : 'duo-btn-cream'
                  }`}
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 text-current" />
                  )}
                  <span>
                    {hasUnsavedChanges
                      ? 'حفظ العرض (تغييرات غير محفوظة)'
                      : activeId
                      ? 'حفظ العرض'
                      : 'حفظ العرض الآن'}
                  </span>
                </button>
              </div>
            </div>

            {saveFeedback && (
              <div className="bg-[#58CC02]/15 border border-[#58CC02] rounded-2xl px-4 py-2.5 flex items-center gap-2 text-xs font-extrabold text-[#357A02]">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{saveFeedback}</span>
              </div>
            )}

            {/* Main Slide Canvas Stage */}
            <div className="bg-white border-2 border-[#EADBC8] rounded-3xl p-3 sm:p-5 space-y-4">
              {aiGenerating && slides.length === 0 ? (
                <div className="min-h-[340px] flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <ModernLoader label="جاري تصميم الشرائح التفاعلية بثيم براعم عمران..." />
                  <p className="text-xs font-bold text-[#7D4E35]">
                    يتم الآن ضبط التشكيل والآيات وعناصر التهجي التفاعلية في الكانفاس...
                  </p>
                </div>
              ) : !currentSlide ? (
                <div className="min-h-[340px] rounded-2xl bg-[#FDF6EE] border-2 border-dashed border-[#EADBC8] flex flex-col items-center justify-center text-center p-6 space-y-3">
                  <div className="w-14 h-14 rounded-2xl bg-[#F56900]/12 text-[#F56900] flex items-center justify-center">
                    <Sparkles className="w-7 h-7" />
                  </div>
                  <h3 className="font-display text-lg font-extrabold text-[#4A220D]">
                    كانفاس العرض التفاعلي جاهز
                  </h3>
                  <p className="text-xs sm:text-sm text-[#7D4E35] max-w-md leading-relaxed">
                    صِف للذكاء الاصطناعي في المحادثة على اليسار الموضوع الذي تريد شرحه، أو ارفع ملف PowerPoint (.pptx)، وستظهر شرائح HTML المنسقة هنا فوراً.
                  </p>
                </div>
              ) : (
                <>
                  {/* Navigation Header Inside Canvas */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#F7EBDD]">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-xl bg-[#F56900] text-white font-display font-extrabold text-xs tabular-nums">
                        الشريحة {toArabicIndicDigits(activeSlideIndex + 1)} / {toArabicIndicDigits(slides.length)}
                      </span>
                      <span className="px-2.5 py-1 rounded-xl bg-[#FDF6EE] border border-[#EADBC8] text-[#7D4E35] font-bold text-xs">
                        {getLayoutBadgeLabel(currentSlide.layout)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={activeSlideIndex <= 0}
                        onClick={() => setActiveSlideIndex((i) => Math.max(0, i - 1))}
                        aria-label="الشريحة السابقة"
                        className="min-h-[36px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:bg-white text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      >
                        <ChevronRight className="w-4 h-4" />
                        <span>السابقة</span>
                      </button>
                      <button
                        type="button"
                        disabled={activeSlideIndex >= slides.length - 1}
                        onClick={() =>
                          setActiveSlideIndex((i) => Math.min(slides.length - 1, i + 1))
                        }
                        aria-label="الشريحة التالية"
                        className="min-h-[36px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] hover:bg-white text-[#4A220D] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      >
                        <span>التالية</span>
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Rendered Braem Omran 16:9 Editorial Slide */}
                  <div
                    onClick={handleSlideCanvasClick}
                    className={`relative rounded-3xl border-2 p-5 sm:p-8 min-h-[360px] lg:aspect-[16/9] flex flex-col justify-between gap-4 shadow-sm transition-all overflow-hidden ${getToneFrameClasses(
                      currentSlide.themeTone
                    )}`}
                  >
                    <header className="space-y-1 border-b border-[#EADBC8]/80 pb-3.5 shrink-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-display font-extrabold text-[#F56900] bg-[#F56900]/10 px-2.5 py-0.5 rounded-lg">
                          {getLayoutBadgeLabel(currentSlide.layout)}
                        </span>
                        <span className="text-[11px] font-bold text-[#7D4E35] tabular-nums">
                          {toArabicIndicDigits(activeSlideIndex + 1)} / {toArabicIndicDigits(slides.length)}
                        </span>
                      </div>
                      <h3 className="font-display text-xl sm:text-2xl lg:text-3xl font-extrabold text-[#4A220D] leading-snug">
                        {currentSlide.title}
                      </h3>
                      {currentSlide.subtitle && (
                        <p className="text-xs sm:text-sm font-bold text-[#7D4E35]">
                          {currentSlide.subtitle}
                        </p>
                      )}
                    </header>

                    <div
                      className="flex-1 text-[#4A220D] text-sm sm:text-base leading-relaxed space-y-3 overflow-y-auto pr-0.5"
                      dangerouslySetInnerHTML={{ __html: sanitizedCurrentHtml }}
                    />

                    {/* Interactive Quick Chips on Slide Bottom with Speaker Icon */}
                    {currentSlide.interactiveBlocks.length > 0 && (
                      <div className="pt-3 border-t border-[#EADBC8]/80 flex flex-wrap items-center gap-2 shrink-0">
                        <span className="text-[11px] font-extrabold text-[#7D4E35]">
                          عناصر التهجي والتلاوة:
                        </span>
                        {currentSlide.interactiveBlocks.map((blk) => {
                          const isSelected =
                            selectedAudioTarget?.text === blk.arabicText &&
                            selectedAudioTarget?.type === blk.type;
                          const targetObj: SlideAudioTarget = {
                            text: blk.arabicText,
                            type: blk.type,
                            surahNumber: blk.surahNumber,
                            ayahNumber: blk.ayahNumber,
                            surahName: blk.surahName,
                            label: blk.label,
                          };
                          return (
                            <div
                              key={blk.id}
                              className={`inline-flex items-center gap-1 rounded-2xl border-2 px-2.5 py-1 transition-colors ${
                                isSelected
                                  ? 'bg-[#F56900]/10 border-[#F56900] text-[#4A220D]'
                                  : blk.type === 'ayah'
                                  ? 'bg-[#F4FBE9] border-[#58CC02]/60 text-[#357A02]'
                                  : 'bg-[#FDF6EE] border-[#EADBC8] text-[#4A220D]'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  openSpeakerPopoverAtElement(ev.currentTarget, targetObj);
                                }}
                                className="font-quran text-lg leading-[1.9] font-bold cursor-pointer px-1"
                              >
                                {blk.arabicText.slice(0, 44)}
                                {blk.arabicText.length > 44 ? '…' : ''}
                              </button>
                              <button
                                type="button"
                                aria-label={`خيارات الاستماع والتهجي لعنصر ${blk.arabicText.slice(0, 30)}`}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  openSpeakerPopoverAtElement(ev.currentTarget, targetObj);
                                }}
                                className="w-7 h-7 rounded-xl bg-white border border-[#EADBC8] hover:bg-[#F56900] hover:text-white text-[#F56900] flex items-center justify-center cursor-pointer transition-colors shrink-0"
                              >
                                <Volume2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Speaker Notes Strip */}
                  {currentSlide.speakerNotes && (
                    <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl px-4 py-2.5 text-xs text-[#7D4E35]">
                      <strong className="text-[#4A220D]">ملاحظات للمعلم: </strong>
                      {currentSlide.speakerNotes}
                    </div>
                  )}

                  {/* Slide Thumbnails Strip */}
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {slides.map((sl, idx) => {
                      const active = idx === activeSlideIndex;
                      return (
                        <button
                          key={sl.id}
                          type="button"
                          onClick={() => setActiveSlideIndex(idx)}
                          className={`min-w-[140px] max-w-[175px] p-2.5 rounded-2xl border-2 text-right transition-all cursor-pointer shrink-0 ${
                            active
                              ? 'border-[#F56900] bg-[#FFF8F1] shadow-sm'
                              : 'border-[#EADBC8] bg-[#FDF6EE]/70 hover:bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span
                              className={`w-5 h-5 rounded-lg text-[10px] font-extrabold inline-flex items-center justify-center tabular-nums ${
                                active ? 'bg-[#F56900] text-white' : 'bg-[#EADBC8] text-[#4A220D]'
                              }`}
                            >
                              {toArabicIndicDigits(idx + 1)}
                            </span>
                            <span className="text-[10px] font-bold text-[#7D4E35]">
                              {getLayoutBadgeLabel(sl.layout)}
                            </span>
                          </div>
                          <p className="font-display font-bold text-xs text-[#4A220D] truncate">
                            {sl.title}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Interactive Tahajji + Quran Audio Player Docked Under Canvas (unmounted in fullscreen to avoid duplicate players) */}
            {currentSlide && !fullscreenOpen && (
              <SlideArabicAudioBar
                workspace={workspace}
                currentUserId={currentUserId}
                selectedTarget={selectedAudioTarget}
                slideBlocks={currentSlide.interactiveBlocks}
                onSelectTarget={setSelectedAudioTarget}
                commandRequest={audioCommand}
                slideKey={`${currentSlide.id}_${activeSlideIndex}`}
              />
            )}
          </section>

          {/* LEFT PANEL IN RTL (second grid child = lg:col-span-4): AI CONVERSATION + SLIDE TARGET + PPTX */}
          <aside className="lg:col-span-4 bg-white border-2 border-[#EADBC8] rounded-3xl overflow-hidden flex flex-col lg:sticky lg:top-24 max-h-[82dvh]">
            <div className="bg-gradient-to-l from-[#F56900] to-[#FF851B] text-white px-4 py-3 flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-display font-extrabold text-sm truncate">
                    مصمم العروض التفاعلية AI
                  </h3>
                  <p className="text-[11px] font-bold text-white/90 truncate">
                    إنشاء، تعديل شريحة محددة، أو تحويل PowerPoint
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => pptxInputRef.current?.click()}
                disabled={parsingPptx || aiGenerating}
                title="رفع ملف PowerPoint (.pptx)"
                className="px-2.5 py-1.5 rounded-xl bg-white/20 hover:bg-white/30 text-white text-[11px] font-extrabold inline-flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-50"
              >
                <FileUp className="w-3.5 h-3.5" />
                <span>PPTX</span>
              </button>
            </div>

            {/* Target Scope Selector */}
            {slides.length > 0 && (
              <div className="px-3 py-2 bg-[#FDF6EE] border-b border-[#EADBC8] flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditTargetMode('deck')}
                  className={`flex-1 min-h-[34px] px-2 rounded-xl font-display font-bold text-[11px] cursor-pointer transition-colors ${
                    editTargetMode === 'deck'
                      ? 'bg-[#F56900] text-white'
                      : 'bg-white border border-[#EADBC8] text-[#7D4E35]'
                  }`}
                >
                  العرض كاملاً
                </button>
                <button
                  type="button"
                  onClick={() => setEditTargetMode('current_slide')}
                  className={`flex-1 min-h-[34px] px-2 rounded-xl font-display font-bold text-[11px] cursor-pointer transition-colors ${
                    editTargetMode === 'current_slide'
                      ? 'bg-[#58CC02] text-white'
                      : 'bg-white border border-[#EADBC8] text-[#7D4E35]'
                  }`}
                >
                  الشريحة #{toArabicIndicDigits(activeSlideIndex + 1)} فقط
                </button>
              </div>
            )}

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-[240px]">
              {chatHistory.length === 0 ? (
                <div className="space-y-3">
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl p-3 text-xs text-[#4A220D] leading-relaxed">
                    اكتب وصف العرض التقديمي الذي تريده، أو ارفع ملف <strong>.pptx</strong> ليقوم الذكاء الاصطناعي ببنائه هنا بثيم منصة براعم عمران.
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-extrabold text-[#7D4E35]">أفكار سريعة:</p>
                    {STARTER_IDEAS.map((idea) => (
                      <button
                        key={idea}
                        type="button"
                        disabled={aiGenerating}
                        onClick={() => void handleSendAiPrompt(idea)}
                        className="w-full text-right px-3 py-2 rounded-xl border border-[#EADBC8] bg-[#FDF6EE]/70 hover:bg-[#FDF6EE] hover:border-[#F56900] text-xs font-bold text-[#4A220D] transition-colors cursor-pointer"
                      >
                        {idea}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                chatHistory.map((turn) => (
                  <div
                    key={turn.id}
                    className={`flex flex-col ${
                      turn.role === 'user' ? 'items-start' : 'items-end'
                    }`}
                  >
                    {typeof turn.targetSlideIndex === 'number' && (
                      <span className="text-[10px] font-extrabold text-[#46A302] mb-0.5 px-1">
                        تعديل الشريحة {toArabicIndicDigits(turn.targetSlideIndex + 1)}
                      </span>
                    )}
                    <div
                      className={`max-w-[92%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                        turn.role === 'user'
                          ? 'bg-[#F56900] text-white font-bold rounded-tr-sm'
                          : 'bg-[#FDF6EE] border border-[#EADBC8] text-[#4A220D] rounded-tl-sm'
                      }`}
                    >
                      {turn.text}
                    </div>
                  </div>
                ))
              )}

              {(aiGenerating || parsingPptx) && (
                <div className="flex justify-end">
                  <div className="bg-[#FDF6EE] border border-[#EADBC8] rounded-2xl px-3 py-2 inline-flex items-center gap-2 text-xs font-bold text-[#7D4E35]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#F56900]" />
                    <span>
                      {parsingPptx
                        ? 'جاري قراءة ملف الباوربوينت...'
                        : editTargetMode === 'current_slide'
                        ? 'جاري تعديل الشريحة المحددة...'
                        : 'جاري إنشاء الشرائح في الكانفاس...'}
                    </span>
                  </div>
                </div>
              )}

              {aiError && (
                <div className="bg-[#D95338]/10 border border-[#D95338] rounded-xl px-3 py-2 text-xs font-bold text-[#D95338]">
                  {aiError}
                </div>
              )}

              <div ref={chatBottomRef} />
            </div>

            {/* Prompt Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendAiPrompt();
              }}
              className="p-3 border-t-2 border-[#EADBC8] bg-[#FDF6EE]/70 flex items-end gap-2 shrink-0"
            >
              <textarea
                ref={chatInputRef}
                rows={2}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendAiPrompt();
                  }
                }}
                placeholder={
                  editTargetMode === 'current_slide'
                    ? `عدّل في الشريحة ${toArabicIndicDigits(activeSlideIndex + 1)} مثلاً: أضف آية من الفاتحة وكلمات للتهجي...`
                    : 'صف العرض المطلوب: الموضوع، الفئة، والآيات أو الكلمات...'
                }
                className="flex-1 min-h-[48px] max-h-32 px-3 py-2 rounded-2xl border-2 border-[#EADBC8] bg-white text-xs sm:text-sm text-[#4A220D] focus:outline-none focus:border-[#F56900] resize-none"
              />
              <button
                type="submit"
                disabled={aiGenerating || parsingPptx || !chatInput.trim()}
                aria-label="إرسال الطلب للذكاء الاصطناعي"
                className="duo-btn-orange w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </aside>
        </div>
      )}

      {/* ==================== FULLSCREEN PRESENTER PORTAL ==================== */}
      {fullscreenOpen &&
        currentSlide &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[95] bg-[#FDF6EE] flex flex-col justify-between p-3 sm:p-6 gap-3 overflow-y-auto"
            dir="rtl"
          >
            <div className="max-w-6xl w-full mx-auto flex items-center justify-between gap-3 bg-white border-2 border-[#EADBC8] rounded-2xl px-4 py-2.5 shrink-0">
              <div className="min-w-0">
                <h3 className="font-display font-extrabold text-sm sm:text-base text-[#4A220D] truncate">
                  {deckTitle}
                </h3>
                <p className="text-[11px] font-bold text-[#7D4E35]">
                  الشريحة {toArabicIndicDigits(activeSlideIndex + 1)} من {toArabicIndicDigits(slides.length)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={activeSlideIndex <= 0}
                  onClick={() => setActiveSlideIndex((i) => Math.max(0, i - 1))}
                  className="min-h-[38px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <ChevronRight className="w-4 h-4" />
                  <span>السابقة</span>
                </button>
                <button
                  type="button"
                  disabled={activeSlideIndex >= slides.length - 1}
                  onClick={() =>
                    setActiveSlideIndex((i) => Math.min(slides.length - 1, i + 1))
                  }
                  className="min-h-[38px] px-3 rounded-xl border-2 border-[#EADBC8] bg-[#FDF6EE] font-display font-bold text-xs inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <span>التالية</span>
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setFullscreenMode(false)}
                  className="duo-btn-orange min-h-[38px] px-3.5 rounded-xl font-display font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Minimize2 className="w-4 h-4" />
                  <span>إنهاء العرض</span>
                </button>
              </div>
            </div>

            <div className="max-w-6xl w-full mx-auto flex-1 flex flex-col justify-center gap-3">
              <div
                onClick={handleSlideCanvasClick}
                className={`rounded-3xl border-2 p-6 sm:p-10 min-h-[55dvh] flex flex-col justify-between gap-6 shadow-md ${getToneFrameClasses(
                  currentSlide.themeTone
                )}`}
              >
                <header className="space-y-2 border-b border-[#EADBC8]/80 pb-4">
                  <h2 className="font-display text-2xl sm:text-4xl font-extrabold text-[#4A220D]">
                    {currentSlide.title}
                  </h2>
                  {currentSlide.subtitle && (
                    <p className="text-sm sm:text-lg font-bold text-[#7D4E35]">
                      {currentSlide.subtitle}
                    </p>
                  )}
                </header>
                <div
                  className="flex-1 text-[#4A220D] text-base sm:text-xl leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: sanitizedCurrentHtml }}
                />
              </div>

              <SlideArabicAudioBar
                workspace={workspace}
                currentUserId={currentUserId}
                selectedTarget={selectedAudioTarget}
                slideBlocks={currentSlide.interactiveBlocks}
                onSelectTarget={setSelectedAudioTarget}
                commandRequest={audioCommand}
                slideKey={`${currentSlide.id}_${activeSlideIndex}_fs`}
                compact
              />
            </div>
          </div>,
          document.body
        )}

      {/* ==================== 3-MODE SPEAKER POPOVER MENU ==================== */}
      {speakerMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[110]"
            onClick={() => setSpeakerMenu(null)}
            dir="rtl"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                top: `${speakerMenu.top}px`,
                left: `${speakerMenu.left}px`,
                width: '280px',
              }}
              className="fixed bg-white border-2 border-[#F56900] rounded-3xl shadow-2xl p-3.5 space-y-2.5"
              role="menu"
              aria-label="خيارات الاستماع والتهجي"
            >
              <div className="flex items-start justify-between gap-2 pb-2 border-b border-[#F7EBDD]">
                <p className="font-quran text-xl text-[#4A220D] leading-[1.9] line-clamp-2">
                  {speakerMenu.target.text}
                </p>
                <button
                  type="button"
                  onClick={() => setSpeakerMenu(null)}
                  aria-label="إغلاق القائمة"
                  className="p-1 rounded-lg text-[#7D4E35] hover:bg-[#FDF6EE] cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => dispatchAudioCommand(speakerMenu.target, 'normal')}
                  className="w-full min-h-[42px] px-3 py-2 rounded-2xl bg-[#FDF6EE] hover:bg-[#58CC02] hover:text-white text-[#4A220D] font-display font-bold text-xs flex items-center gap-2 transition-colors cursor-pointer"
                >
                  <Volume2 className="w-4 h-4 shrink-0 text-[#46A302]" />
                  <span>قراءة مباشرة</span>
                </button>

                <button
                  type="button"
                  onClick={() => dispatchAudioCommand(speakerMenu.target, 'noor_albayan')}
                  className="w-full min-h-[42px] px-3 py-2 rounded-2xl bg-[#FDF6EE] hover:bg-[#F56900] hover:text-white text-[#4A220D] font-display font-bold text-xs flex items-center gap-2 transition-colors cursor-pointer"
                >
                  <Sparkles className="w-4 h-4 shrink-0 text-[#F56900]" />
                  <span>تهجي مباشر (الفتح الرباني)</span>
                </button>

                <button
                  type="button"
                  onClick={() => dispatchAudioCommand(speakerMenu.target, 'cumulative_tahajji')}
                  className="w-full min-h-[42px] px-3 py-2 rounded-2xl bg-[#FDF6EE] hover:bg-[#D98A00] hover:text-white text-[#4A220D] font-display font-bold text-xs flex items-center gap-2 transition-colors cursor-pointer text-right"
                >
                  <Repeat className="w-4 h-4 shrink-0 text-[#D98A00]" />
                  <span>تهجي تجميعي (يتهجى ويرجع من البداية)</span>
                </button>

                {speakerMenu.target.surahNumber && speakerMenu.target.ayahNumber && (
                  <button
                    type="button"
                    onClick={() => dispatchAudioCommand(speakerMenu.target, 'sheikh')}
                    className="w-full min-h-[42px] px-3 py-2 rounded-2xl bg-[#58CC02]/12 hover:bg-[#58CC02] hover:text-white text-[#357A02] font-display font-bold text-xs flex items-center gap-2 transition-colors cursor-pointer"
                  >
                    <Volume2 className="w-4 h-4 shrink-0" />
                    <span>تلاوة الشيخ للآية</span>
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
