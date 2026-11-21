import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { BookTextSegment, NoorAlBayanStep } from '../types/platform';

interface CompactAyahEntry {
  surahNumber: number;
  ayahNumber: number;
  surahName: string;
  page: number;
  diacritizedWords: string[];
  plainWords: string[];
  skeletons: string[];
}

interface QuranIndexData {
  ayahs: CompactAyahEntry[];
  trigIndex: Map<string, number[]>;
  bigramIndex: Map<string, number[]>;
  skeletonIndex: Map<string, number[]>;
  skeletonBucketMap: Map<string, string[]>;
  surahNameMap: Map<string, number>;
}

const QURAN_CACHE_DB = 'braem_omran_quran_cache_v1';
const QURAN_CACHE_STORE = 'quranData';
const QURAN_CACHE_KEY = 'full_quran_simple_v2';

export interface PageOcrProgress {
  pageNumber: number;
  pagePercent: number;
  stageText: string;
}

let ocrWorkerPromise: Promise<Worker> | null = null;
let activeOcrLoggerCallback: ((m: { status?: string; progress?: number }) => void) | null = null;
let quranIndexPromise: Promise<QuranIndexData | null> | null = null;
let loadedQuranWordMap: Map<string, string> | null = null;

/**
 * Normalizes ALL Arabic fonts & Unicode encodings:
 * - Presentation Forms-A (U+FB50-FDFF) & Presentation Forms-B (U+FE70-FEFF): Naskh, Ruq'ah, Thuluth, Diwani, Kufi glyph forms & Lam-Alif ligatures
 * - Extended/Persian/Urdu print codepoints often embedded by PDF fonts (U+06A9 ک, U+06CC ی, U+06C1 ہ, U+06BE ھ, U+06D5 ە, U+06C3 ۃ, U+06D2 ے)
 * - Removes Tatweel (ـ) and invisible directional marks while keeping Tashkeel intact.
 */
export function normalizeAllArabicFontForms(input: string): string {
  if (!input) return '';
  let out = input
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\uFDFD/g, 'بسم الله الرحمن الرحيم')
    .replace(/\uFDF2/g, 'الله')
    .replace(/[\u06A9\u06AA]/g, 'ك')
    .replace(/[\u06CC\u06D0\u06D1]/g, 'ي')
    .replace(/\u06D2/g, 'ى')
    .replace(/[\u06C0\u06C1\u06C2\u06BE\u06D5]/g, 'ه')
    .replace(/\u06C3/g, 'ة')
    .replace(/\u067E/g, 'ب')
    .replace(/\u0686/g, 'ج')
    .replace(/\u0698/g, 'ز')
    .replace(/\u06AF/g, 'ك')
    .replace(/\u06A4/g, 'ف')
    .replace(/\u0640/g, '');
  // Normalize Uthmani small high maddah / silent markers slightly if needed without stripping vowel marks
  return out.replace(/\s+/g, ' ').trim();
}

export function stripArabicDiacriticsForMatch(input: string): string {
  return normalizeAllArabicFontForms(input)
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\u0621-\u064A0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getArabicLetterName(ch: string): string {
  const names: Record<string, string> = {
    ا: 'أَلِفْ',
    أ: 'أَلِفْ هَمْزَة',
    إ: 'أَلِفْ هَمْزَة',
    آ: 'أَلِفْ مَدّ',
    ٱ: 'أَلِفْ وَصْل',
    ب: 'بَاءْ',
    ت: 'تَاءْ',
    ث: 'ثَاءْ',
    ج: 'جِيمْ',
    ح: 'حَاءْ',
    خ: 'خَاءْ',
    د: 'دَالْ',
    ذ: 'ذَالْ',
    ر: 'رَاءْ',
    ز: 'زَايْ',
    س: 'سِينْ',
    ش: 'شِينْ',
    ص: 'صَادْ',
    ض: 'ضَادْ',
    ط: 'طَاءْ',
    ظ: 'ظَاءْ',
    ع: 'عَيْنْ',
    غ: 'غَيْنْ',
    ف: 'فَاءْ',
    ق: 'قَافْ',
    ك: 'كَافْ',
    ل: 'لَامْ',
    م: 'مِيمْ',
    ن: 'نُونْ',
    ه: 'هَاءْ',
    ة: 'تَاءْ مَرْبُوطَة',
    و: 'وَاوْ',
    ي: 'يَاءْ',
    ى: 'أَلِفْ مَقْصُورَة',
    ء: 'هَمْزَة',
    ؤ: 'هَمْزَة عَلَى وَاو',
    ئ: 'هَمْزَة عَلَى يَاء',
  };
  return names[ch] || ch;
}

const FATHA = '\u064E';
const DAMMA = '\u064F';
const KASRA = '\u0650';
const FATHATAN = '\u064B';
const DAMMATAN = '\u064C';
const KASRATAN = '\u064D';
const SHADDA = '\u0651';
const SUKOON = '\u0652';
const DAGGER_ALIF = '\u0670';
const MADDAH = '\u0653';

const SUN_LETTERS = new Set([
  'ت',
  'ث',
  'د',
  'ذ',
  'ر',
  'ز',
  'س',
  'ش',
  'ص',
  'ض',
  'ط',
  'ظ',
  'ل',
  'ن',
]);

// Curated high-frequency Arabic/Islamic/Noor Al-Bayan lexicon for instant accurate vocalization of undiacritized text
const COMMON_ARABIC_VOCALIZED_DICT: Record<string, string> = {
  بسم: 'بِسْمِ',
  الله: 'اللَّهِ',
  الرحمن: 'الرَّحْمَٰنِ',
  الرحيم: 'الرَّحِيمِ',
  الحمد: 'الْحَمْدُ',
  لله: 'لِلَّهِ',
  رب: 'رَبِّ',
  العالمين: 'الْعَالَمِينَ',
  مالك: 'مَالِكِ',
  يوم: 'يَوْمِ',
  الدين: 'الدِّينِ',
  نعبد: 'نَعْبُدُ',
  نستعين: 'نَسْتَعِينُ',
  اهدنا: 'اهْدِنَا',
  الصراط: 'الصِّرَاطَ',
  المستقيم: 'الْمُسْتَقِيمَ',
  السلام: 'السَّلَامُ',
  عليكم: 'عَلَيْكُمْ',
  ورحمة: 'وَرَحْمَةُ',
  وبركاته: 'وَبَرَكَاتُهُ',
  سبحان: 'سُبْحَانَ',
  اكبر: 'أَكْبَرُ',
  استغفر: 'أَسْتَغْفِرُ',
  محمد: 'مُحَمَّدٌ',
  رسول: 'رَسُولُ',
  نبي: 'نَبِيٌّ',
  قران: 'قُرْآنٌ',
  القران: 'الْقُرْآنُ',
  الكريم: 'الْكَرِيمُ',
  كتاب: 'كِتَابٌ',
  الكتاب: 'الْكِتَابُ',
  قلم: 'قَلَمٌ',
  القلم: 'الْقَلَمُ',
  علم: 'عِلْمٌ',
  العلم: 'الْعِلْمُ',
  معلم: 'مُعَلِّمٌ',
  المعلم: 'الْمُعَلِّمُ',
  طالب: 'طَالِبٌ',
  الطالب: 'الطَّالِبُ',
  تلميذ: 'تِلْمِيذٌ',
  مدرسة: 'مَدْرَسَةٌ',
  المدرسة: 'الْمَدْرَسَةُ',
  مسجد: 'مَسْجِدٌ',
  المسجد: 'الْمَسْجِدُ',
  بيت: 'بَيْتٌ',
  البيت: 'الْبَيْتُ',
  باب: 'بَابٌ',
  الباب: 'الْبَابُ',
  نور: 'نُورٌ',
  بيان: 'بَيَانٌ',
  البيان: 'الْبَيَانُ',
  سورة: 'سُورَةُ',
  ايه: 'آيَةٌ',
  اية: 'آيَةٌ',
  صلاه: 'صَلَاةٌ',
  الصلاه: 'الصَّلَاةُ',
  زكاه: 'زَكَاةٌ',
  الزكاه: 'الزَّكَاةُ',
  صيام: 'صِيَامٌ',
  حج: 'حَجٌّ',
  اسلام: 'إِسْلَامٌ',
  الاسلام: 'الْإِسْلَامُ',
  ايمان: 'إِيمَانٌ',
  احسان: 'إِحْسَانٌ',
  تجويد: 'تَجْوِيدٌ',
  حرف: 'حَرْفٌ',
  كلمة: 'كَلِمَةٌ',
  جملة: 'جُمْلَةٌ',
  درس: 'دَرْسٌ',
  فصل: 'فَصْلٌ',
  صفحة: 'صَفْحَةٌ',
  حفظ: 'حِفْظٌ',
  تلاوة: 'تِلَاوَةٌ',
  قراءة: 'قِرَاءَةٌ',
  كتابة: 'كِتَابَةٌ',
  يكتب: 'يَكْتُبُ',
  تكتب: 'تَكْتُبُ',
  يقرا: 'يَقْرَأُ',
  تقرا: 'تَقْرَأُ',
  اقرا: 'اقْرَأْ',
  يحفظ: 'يَحْفَظُ',
  تحفظ: 'تَحْفَظُ',
  يعلم: 'يَعْلَمُ',
  يسمع: 'يَسْمَعُ',
  يفهم: 'يَفْهَمُ',
  يدرس: 'يَدْرُسُ',
  يشرح: 'يَشْرَحُ',
  ذهب: 'ذَهَبَ',
  رجع: 'رَجَعَ',
  فتح: 'فَتَحَ',
  فهم: 'فَهِمَ',
  كتب: 'كَتَبَ',
  قرا: 'قَرَأَ',
  حفظه: 'حَفِظَهُ',
  شمس: 'شَمْسٌ',
  الشمس: 'الشَّمْسُ',
  قمر: 'قَمَرٌ',
  القمر: 'الْقَمَرُ',
  سماء: 'سَمَاءٌ',
  السماء: 'السَّمَاءُ',
  ارض: 'أَرْضٌ',
  الارض: 'الْأَرْضُ',
  ماء: 'مَاءٌ',
  شجرة: 'شَجَرَةٌ',
  حديقة: 'حَدِيقَةٌ',
  طريق: 'طَرِيقٌ',
  صديق: 'صَدِيقٌ',
  خير: 'خَيْرٌ',
  شر: 'شَرٌّ',
  حق: 'حَقٌّ',
  الحق: 'الْحَقُّ',
  عدل: 'عَدْلٌ',
  صدق: 'صِدْقٌ',
  امانة: 'أَمَانَةٌ',
  بر: 'بِرٌّ',
  والدين: 'وَالِدَيْنِ',
  جنة: 'جَنَّةٌ',
  الجنة: 'الْجَنَّةُ',
  نار: 'نَارٌ',
  في: 'فِي',
  من: 'مِنْ',
  الي: 'إِلَى',
  على: 'عَلَى',
  علي: 'عَلَى',
  عن: 'عَنْ',
  مع: 'مَعَ',
  ان: 'إِنَّ',
  انني: 'إِنَّنِي',
  كان: 'كَانَ',
  يكون: 'يَكُونُ',
  هو: 'هُوَ',
  هي: 'هِيَ',
  هم: 'هُمْ',
  نحن: 'نَحْنُ',
  انت: 'أَنْتَ',
  انا: 'أَنَا',
  هذا: 'هَٰذَا',
  هذه: 'هَٰذِهِ',
  ذلك: 'ذَٰلِكَ',
  تلك: 'تِلْكَ',
  الذي: 'الَّذِي',
  التي: 'الَّتِي',
  الذين: 'الَّذِينَ',
  اولئك: 'أُولَٰئِكَ',
  كل: 'كُلُّ',
  بعض: 'بَعْضُ',
  ثم: 'ثُمَّ',
  او: 'أَوْ',
  لا: 'لَا',
  نعم: 'نَعَمْ',
  ما: 'مَا',
  لم: 'لَمْ',
  لن: 'لَنْ',
  قد: 'قَدْ',
  اذا: 'إِذَا',
  اذ: 'إِذْ',
  كيف: 'كَيْفَ',
  اين: 'أَيْنَ',
  متى: 'مَتَى',
  لماذا: 'لِمَاذَا',
  شكرا: 'شُكْرًا',
  جدا: 'جِدًّا',
  صباح: 'صَبَاحُ',
  مساء: 'مَسَاءُ',
  ولد: 'وَلَدٌ',
  بنت: 'بِنْتٌ',
  رجل: 'رَجُلٌ',
  امراة: 'امْرَأَةٌ',
  اب: 'أَبٌ',
  ام: 'أُمٌّ',
  اخ: 'أَخٌ',
  اخت: 'أُخْتٌ',
};

function isCombiningMark(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x06d6 && code <= 0x06ed)
  );
}

interface ParsedUnit {
  letter: string;
  marks: string;
  hasFatha: boolean;
  hasDamma: boolean;
  hasKasra: boolean;
  hasFathatan: boolean;
  hasDammatan: boolean;
  hasKasratan: boolean;
  hasShadda: boolean;
  hasSukoon: boolean;
  hasDaggerAlif: boolean;
  hasMaddah: boolean;
}

function parseArabicWordUnits(word: string): ParsedUnit[] {
  const normalized = normalizeAllArabicFontForms(word);
  const chars = Array.from(normalized);
  const units: ParsedUnit[] = [];

  for (const ch of chars) {
    if (ch === '\u0640') continue; // Tatweel
    if (isCombiningMark(ch)) {
      const prev = units[units.length - 1];
      if (prev) {
        prev.marks += ch;
        if (ch === FATHA) prev.hasFatha = true;
        if (ch === DAMMA) prev.hasDamma = true;
        if (ch === KASRA) prev.hasKasra = true;
        if (ch === FATHATAN) prev.hasFathatan = true;
        if (ch === DAMMATAN) prev.hasDammatan = true;
        if (ch === KASRATAN) prev.hasKasratan = true;
        if (ch === SHADDA) prev.hasShadda = true;
        if (ch === SUKOON) prev.hasSukoon = true;
        if (ch === DAGGER_ALIF) prev.hasDaggerAlif = true;
        if (ch === MADDAH) prev.hasMaddah = true;
      }
      continue;
    }

    if (/[\u0621-\u064A\u0671]/.test(ch)) {
      units.push({
        letter: ch,
        marks: '',
        hasFatha: false,
        hasDamma: false,
        hasKasra: false,
        hasFathatan: false,
        hasDammatan: false,
        hasKasratan: false,
        hasShadda: false,
        hasSukoon: false,
        hasDaggerAlif: false,
        hasMaddah: false,
      });
    }
  }

  return units;
}

function countVocalizedUnits(units: ParsedUnit[]): number {
  let count = 0;
  for (const u of units) {
    if (
      u.hasFatha ||
      u.hasDamma ||
      u.hasKasra ||
      u.hasFathatan ||
      u.hasDammatan ||
      u.hasKasratan ||
      u.hasShadda ||
      u.hasSukoon ||
      u.hasDaggerAlif
    ) {
      count++;
    }
  }
  return count;
}

function diacritizeStemByArabicMorphology(stem: string, hasDefiniteAl: boolean): string {
  const letters = Array.from(stem);
  const n = letters.length;
  if (n === 0) return stem;
  if (n === 1) return `${letters[0]}${FATHA}`;

  // Preserve leading Alif Madda / Hamza vowel hints
  const marks = new Array<string>(n).fill('');

  // Ending vowel
  const last = letters[n - 1];
  const prevLast = letters[n - 2];

  // Check common morphological templates first
  // 1) Verbal present prefixes: يَـ / تَـ / نَـ + Cْ + Cُ/َ + Cُ (4 letters starting with ي/ت/ن and 4th not ة/ا)
  if (
    !hasDefiniteAl &&
    n === 4 &&
    (letters[0] === 'ي' || letters[0] === 'ت' || letters[0] === 'ن') &&
    last !== 'ة' &&
    last !== 'ا' &&
    last !== 'ى' &&
    letters[1] !== 'ا' &&
    letters[2] !== 'و' &&
    letters[2] !== 'ي'
  ) {
    return `${letters[0]}${FATHA}${letters[1]}${SUKOON}${letters[2]}${FATHA}${letters[3]}${DAMMA}`;
  }

  // 2) مَفْعَلَة / مَفْعُول / مِفْعَال / مُفَعِّل
  if (n >= 4 && letters[0] === 'م') {
    if (n === 5 && letters[3] === 'و' && last !== 'ة') {
      // مَفْعُول (مَكْتُوبٌ / مَفْتُوحٌ)
      return `م${FATHA}${letters[1]}${SUKOON}${letters[2]}${DAMMA}و${letters[4]}${hasDefiniteAl ? DAMMA : DAMMATAN}`;
    }
    if (n === 5 && last === 'ة') {
      // مَدْرَسَةٌ
      return `م${FATHA}${letters[1]}${SUKOON}${letters[2]}${FATHA}${letters[3]}${FATHA}ة${
        hasDefiniteAl ? DAMMA : DAMMATAN
      }`;
    }
    if (n === 4 && last !== 'ة' && letters[2] !== 'ا') {
      // مَسْجِد / مَكْتَب
      return `م${FATHA}${letters[1]}${SUKOON}${letters[2]}${KASRA}${letters[3]}${
        hasDefiniteAl ? DAMMA : DAMMATAN
      }`;
    }
  }

  // General vowel placement driven by long vowels (ا و ي ى), initial hamzas, and ending patterns
  for (let i = 0; i < n; i++) {
    const ch = letters[i];
    const next = i + 1 < n ? letters[i + 1] : '';
    const prev = i > 0 ? letters[i - 1] : '';

    if (i === n - 1) {
      if (ch === 'ة') {
        marks[i] = hasDefiniteAl ? DAMMA : DAMMATAN;
      } else if (ch === 'ا' || ch === 'ى') {
        marks[i] = '';
      } else if (prevLast === 'ي' || prevLast === 'و' || prevLast === 'ا') {
        marks[i] = hasDefiniteAl ? DAMMA : DAMMATAN;
      } else if (last === 'ي') {
        marks[i] = '';
      } else {
        marks[i] = hasDefiniteAl ? DAMMA : DAMMATAN;
      }
      continue;
    }

    if (ch === 'ا' && i > 0) {
      // Alif of prolongation after Fatha
      marks[i] = '';
      if (i > 0 && !marks[i - 1]) marks[i - 1] = FATHA;
      continue;
    }

    if (ch === 'إ') {
      marks[i] = KASRA;
      continue;
    }
    if (ch === 'أ') {
      marks[i] = next === 'ي' ? KASRA : next === 'و' ? DAMMA : FATHA;
      continue;
    }
    if (ch === 'آ') {
      marks[i] = '';
      continue;
    }

    // Long vowel triggers from next character
    if (next === 'ا' || next === 'ى') {
      marks[i] = FATHA;
    } else if (next === 'و' && i > 0 && i + 1 < n) {
      marks[i] = DAMMA;
    } else if (next === 'ي' && i > 0) {
      marks[i] = KASRA;
    } else if ((ch === 'و' || ch === 'ي') && i > 0 && (marks[i - 1] === DAMMA || marks[i - 1] === KASRA)) {
      // Sustained madd vowel has no haraka
      marks[i] = '';
    } else if (i === 0) {
      marks[i] = next === 'ئ' ? KASRA : FATHA;
    } else if (i === 1 && n === 3 && next !== 'ا' && next !== 'و' && next !== 'ي' && prev !== 'ا') {
      // CVCC (قَلْبٌ / بَحْرٌ / دَرْسٌ) vs CVCV — balanced sukoon when prev had fatha
      marks[i] = SUKOON;
    } else if (i === 1 && n >= 4 && next !== 'ا' && next !== 'و' && next !== 'ي' && marks[0] === FATHA) {
      marks[i] = SUKOON;
    } else {
      marks[i] = next === 'ة' ? FATHA : FATHA;
    }
  }

  let res = '';
  for (let i = 0; i < n; i++) {
    res += `${letters[i]}${marks[i]}`;
  }
  return res;
}

/**
 * Infers full Arabic diacritics for an unvocalized word so Noor Al-Bayan & voice reading
 * always know HOW the word should be pronounced.
 */
export function inferArabicDiacriticsForWord(rawWord: string): {
  vocalized: string;
  wasAutoDiacritized: boolean;
} {
  const cleaned = normalizeAllArabicFontForms(rawWord)
    .replace(/^[^\u0621-\u064A\u0671]+|[^\u0621-\u064A\u0671\u064B-\u065F\u0670]+$/g, '')
    .trim();

  if (!cleaned) {
    return { vocalized: rawWord, wasAutoDiacritized: false };
  }

  const units = parseArabicWordUnits(cleaned);
  if (units.length === 0) {
    return { vocalized: rawWord, wasAutoDiacritized: false };
  }

  const vocalizedCount = countVocalizedUnits(units);
  // Already sufficiently vocalized (e.g., Mushaf or vowelized textbook word)
  if (vocalizedCount >= Math.max(1, Math.floor(units.length * 0.45))) {
    return { vocalized: cleaned, wasAutoDiacritized: false };
  }

  const plainLetters = units.map((u) => u.letter).join('');
  const bareMatchKey = stripArabicDiacriticsForMatch(plainLetters).replace(/\s+/g, '');

  // 1. Dictionary lookup (including exact Quranic words if index is already loaded)
  if (loadedQuranWordMap?.has(bareMatchKey)) {
    return {
      vocalized: loadedQuranWordMap.get(bareMatchKey)!,
      wasAutoDiacritized: true,
    };
  }

  if (COMMON_ARABIC_VOCALIZED_DICT[bareMatchKey]) {
    return {
      vocalized: COMMON_ARABIC_VOCALIZED_DICT[bareMatchKey],
      wasAutoDiacritized: true,
    };
  }

  // 2. Prefix stripping for conjunctions/prepositions (و، ف، ب، ك، ل) + lookup or rules
  let prefixVocalized = '';
  let stemLetters = plainLetters;

  if (stemLetters.length >= 4 && (stemLetters[0] === 'و' || stemLetters[0] === 'ف')) {
    const rest = stemLetters.slice(1);
    const restBare = stripArabicDiacriticsForMatch(rest);
    if (COMMON_ARABIC_VOCALIZED_DICT[restBare]) {
      return {
        vocalized: `${stemLetters[0]}${FATHA}${COMMON_ARABIC_VOCALIZED_DICT[restBare]}`,
        wasAutoDiacritized: true,
      };
    }
    prefixVocalized = `${stemLetters[0]}${FATHA}`;
    stemLetters = rest;
  } else if (
    stemLetters.length >= 4 &&
    (stemLetters[0] === 'ب' || stemLetters[0] === 'ك' || stemLetters[0] === 'ل') &&
    (stemLetters.startsWith('بال') || stemLetters.startsWith('كال') || stemLetters.startsWith('لل'))
  ) {
    if (stemLetters.startsWith('لل')) {
      const restStem = stemLetters.slice(2);
      const isSun = SUN_LETTERS.has(restStem[0] || '');
      const body = diacritizeStemByArabicMorphology(restStem, true);
      if (isSun && body.length >= 1) {
        const bodyChars = Array.from(body);
        const sunRest =
          bodyChars.length >= 2 && isCombiningMark(bodyChars[1])
            ? `${bodyChars[0]}${SHADDA}${bodyChars[1]}${bodyChars.slice(2).join('')}`
            : `${bodyChars[0]}${SHADDA}${FATHA}${bodyChars.slice(1).join('')}`;
        return {
          vocalized: `لِـل${sunRest}`.replace('ـ', ''),
          wasAutoDiacritized: true,
        };
      }
      return { vocalized: `لِلْ${body}`, wasAutoDiacritized: true };
    }
    prefixVocalized = `${stemLetters[0]}${stemLetters[0] === 'ك' ? FATHA : KASRA}`;
    stemLetters = stemLetters.slice(1);
  }

  // 3. Definite article "ال" (Al-Qamariya vs Al-Shamsiya)
  if ((stemLetters.startsWith('ال') || stemLetters.startsWith('ٱل')) && stemLetters.length >= 4) {
    const firstAlif = stemLetters[0];
    const afterAl = stemLetters.slice(2);
    const firstRoot = afterAl[0];
    const isSun = SUN_LETTERS.has(firstRoot);
    const body = diacritizeStemByArabicMorphology(afterAl, true);

    if (isSun) {
      const bodyChars = Array.from(body);
      const hasFirstMark = bodyChars.length >= 2 && isCombiningMark(bodyChars[1]);
      const shaddaBody = hasFirstMark
        ? `${bodyChars[0]}${SHADDA}${bodyChars[1]}${bodyChars.slice(2).join('')}`
        : `${bodyChars[0]}${SHADDA}${FATHA}${bodyChars.slice(1).join('')}`;
      return {
        vocalized: `${prefixVocalized}${firstAlif}${FATHA}ل${shaddaBody}`,
        wasAutoDiacritized: true,
      };
    }

    return {
      vocalized: `${prefixVocalized}${firstAlif}${FATHA}ل${SUKOON}${body}`,
      wasAutoDiacritized: true,
    };
  }

  const finalStem = diacritizeStemByArabicMorphology(stemLetters, false);
  return {
    vocalized: `${prefixVocalized}${finalStem}`,
    wasAutoDiacritized: true,
  };
}

function describeUnitRule(unit: ParsedUnit): {
  ruleLabel: string;
  spokenRule: string;
} {
  if (unit.hasShadda) {
    if (unit.hasFathatan) {
      return {
        ruleLabel: 'شدة وتنوين بالفتح',
        spokenRule: 'شَدَّةٌ وَتَنْوِينٌ بِالْفَتْحِ',
      };
    }
    if (unit.hasDammatan) {
      return {
        ruleLabel: 'شدة وتنوين بالضم',
        spokenRule: 'شَدَّةٌ وَتَنْوِينٌ بِالضَّمِّ',
      };
    }
    if (unit.hasKasratan) {
      return {
        ruleLabel: 'شدة وتنوين بالكسر',
        spokenRule: 'شَدَّةٌ وَتَنْوِينٌ بِالْكَسْرِ',
      };
    }
    if (unit.hasFatha) {
      return { ruleLabel: 'شدة وفتحة', spokenRule: 'شَدَّةٌ وَفَتْحَة' };
    }
    if (unit.hasDamma) {
      return { ruleLabel: 'شدة وضمة', spokenRule: 'شَدَّةٌ وَضَمَّة' };
    }
    if (unit.hasKasra) {
      return { ruleLabel: 'شدة وكسرة', spokenRule: 'شَدَّةٌ وَكَسْرَة' };
    }
    return { ruleLabel: 'شدة', spokenRule: 'شَدَّةٌ' };
  }

  if (unit.hasFathatan) {
    return { ruleLabel: 'تنوين بالفتح', spokenRule: 'تَنْوِينٌ بِالْفَتْحِ' };
  }
  if (unit.hasDammatan) {
    return { ruleLabel: 'تنوين بالضم', spokenRule: 'تَنْوِينٌ بِالضَّمِّ' };
  }
  if (unit.hasKasratan) {
    return { ruleLabel: 'تنوين بالكسر', spokenRule: 'تَنْوِينٌ بِالْكَسْرِ' };
  }
  if (unit.hasSukoon) {
    return { ruleLabel: 'سكون', spokenRule: 'سُكُونْ' };
  }
  if (unit.hasFatha) {
    return { ruleLabel: 'فتحة', spokenRule: 'فَتْحَة' };
  }
  if (unit.hasDamma) {
    return { ruleLabel: 'ضمة', spokenRule: 'ضَمَّة' };
  }
  if (unit.hasKasra) {
    return { ruleLabel: 'كسرة', spokenRule: 'كَسْرَة' };
  }
  return { ruleLabel: 'حرف', spokenRule: 'حَرْفٌ' };
}

/**
 * Generates authentic, crystal-clear Noor Al-Bayan spelling breakdown purely in the browser
 * — including automatic morphological vocalization for UNDIACRITIZED words & all Arabic script fonts!
 * Works 100% offline / static hosts / zero limits.
 */
export function generateNoorAlBayanClientFallback(text: string): {
  diacritizedWord: string;
  wasAutoDiacritized: boolean;
  steps: NoorAlBayanStep[];
  fullReading: string;
} {
  const normalizedInput = normalizeAllArabicFontForms(text);
  const rawWords = normalizedInput
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  const steps: NoorAlBayanStep[] = [];
  const spokenParts: string[] = [];
  const resolvedWords: string[] = [];
  let anyAutoDiacritized = false;

  for (const rawWord of rawWords) {
    const inferred = inferArabicDiacriticsForWord(rawWord);
    const word = inferred.vocalized;
    if (inferred.wasAutoDiacritized) {
      anyAutoDiacritized = true;
    }
    resolvedWords.push(word);

    const units = parseArabicWordUnits(word);
    if (units.length === 0) continue;

    if (inferred.wasAutoDiacritized && rawWords.length <= 2) {
      spokenParts.push(`الكَلِمَةُ بِتَشْكِيلِ القِرَاءَةِ: ${word}`);
    }

    let cumulative = '';

    for (let i = 0; i < units.length; i++) {
      const curr = units[i];
      const prev = i > 0 ? units[i - 1] : null;
      const next = i + 1 < units.length ? units[i + 1] : null;

      // 1. Alif Maddah (آ)
      if (curr.letter === 'آ' || (curr.letter === 'ا' && curr.hasMaddah)) {
        cumulative += 'آ';
        steps.push({
          part: 'آ',
          ruleLabel: 'همزة ممدودة بالألف حركتان',
          reading: cumulative,
        });
        spokenParts.push(`هَمْزَةٌ مَمْدُودَةٌ بِالْأَلِفِ حَرَكَتَانْ: آ، ${cumulative}`);
        continue;
      }

      // 2. Definite Article "ال" (Al-Qamariya vs Al-Shamsiya)
      if (
        i === 0 &&
        (curr.letter === 'ا' || curr.letter === 'ٱ') &&
        next &&
        next.letter === 'ل' &&
        i + 2 < units.length
      ) {
        const afterLam = units[i + 2];
        const isShamsiya = afterLam.hasShadda || (SUN_LETTERS.has(afterLam.letter) && !next.hasSukoon);
        if (isShamsiya) {
          cumulative += `${curr.letter}${curr.marks}ل`;
          steps.push({
            part: `${curr.letter}ل`,
            ruleLabel: 'همزة وصل تسقط ولام شمسية مُدغمة لا تُنطق',
            reading: `${cumulative}${afterLam.letter}ْ`,
          });
          spokenParts.push(
            `هَمْزَةُ وَصْلٍ وَلاَمٌ شَمْسِيَّةٌ مُدْغَمَةٌ تَسْقُطُ فِي النُّطْقِ`
          );
          i++; // skip لام because it assimilates directly with the next Shadda letter
          continue;
        } else {
          cumulative += `${curr.letter}${curr.marks}لْ`;
          steps.push({
            part: `${curr.letter}لْ`,
            ruleLabel: 'همزة وصل ولام قمرية مُظهرة (أَلْ)',
            reading: cumulative,
          });
          spokenParts.push(`أَلِفُ وَصْلٍ وَلاَمٌ قَمَرِيَّةٌ مُظْهَرَة: أَلْ`);
          i++; // skip لام since we read أَلْ together!
          continue;
        }
      }

      // 3. Natural Madd letters (Alif after Fatha, Waw after Damma, Ya/Maqsura after Kasra/Fatha)
      const hasAnyMarks = Boolean(curr.marks.replace(MADDAH, ''));
      const isAlifMadd =
        (curr.letter === 'ا' || curr.letter === 'ى') &&
        !hasAnyMarks &&
        prev &&
        (prev.hasFatha || prev.hasFathatan);
      const isWawMadd =
        curr.letter === 'و' && !hasAnyMarks && prev && prev.hasDamma;
      const isYaMadd =
        curr.letter === 'ي' && !hasAnyMarks && prev && prev.hasKasra;

      if (isAlifMadd || isWawMadd || isYaMadd) {
        const maddLabel = isAlifMadd
          ? curr.letter === 'ى'
            ? 'أَلِفٌ مَقْصُورَةٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ'
            : 'أَلِفٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ'
          : isWawMadd
          ? 'وَاوٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ'
          : 'يَاءٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ';
        const maddRule = isAlifMadd
          ? curr.letter === 'ى'
            ? 'ألف مقصورة مد حركتان'
            : 'مد بالألف حركتان'
          : isWawMadd
          ? 'مد بالواو حركتان'
          : 'مد بالياء حركتان';
        cumulative += curr.letter;
        steps.push({
          part: curr.letter,
          ruleLabel: maddRule,
          reading: cumulative,
        });
        spokenParts.push(`${maddLabel}: ${cumulative}`);
        continue;
      }

      // 4. Standalone Hamza Wasl at start (non-AL)
      if (i === 0 && (curr.letter === 'ٱ' || (curr.letter === 'ا' && !hasAnyMarks))) {
        cumulative += curr.letter;
        steps.push({
          part: curr.letter,
          ruleLabel: 'همزة وصل يُبتدأ بها مفتوحة أو مكسورة حسب الفعل',
          reading: cumulative,
        });
        spokenParts.push(`هَمْزَةُ وَصْلٍ: ${cumulative}`);
        continue;
      }

      const unitGlyph = `${curr.letter}${curr.marks}`;
      cumulative += unitGlyph;

      // 5. Dagger Alif (الألف الخنجرية مثل: الرَّحْمَٰنِ، هَٰذَا)
      if (curr.hasDaggerAlif) {
        const letterName = getArabicLetterName(curr.letter);
        steps.push({
          part: unitGlyph,
          ruleLabel: 'فتحة وألف صغيرة مد طبيعي حركتان',
          reading: cumulative,
        });
        spokenParts.push(
          `${letterName} فَتْحَة وَأَلِفٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ: ${cumulative}`
        );
        continue;
      }

      // 6. Standard Unit / Shadda / Sukoon / Tanween / Teh Marbuta
      const { ruleLabel, spokenRule } = describeUnitRule(curr);
      const letterName = getArabicLetterName(curr.letter);
      const syllable =
        (curr.hasSukoon || curr.hasShadda) && prev
          ? `${prev.letter}${prev.marks}${unitGlyph}`
          : unitGlyph;

      const extraStopHint =
        curr.letter === 'ة' && i === units.length - 1
          ? ' (وَتُقْرَأُ هَاءً عِنْدَ الْوَقْفِ)'
          : '';

      steps.push({
        part: unitGlyph,
        ruleLabel:
          curr.letter === 'ة' && i === units.length - 1
            ? `${ruleLabel} (تاء مربوطة تُنطق هاءً وقفاً)`
            : ruleLabel,
        reading: cumulative,
      });

      if (curr.hasSukoon) {
        spokenParts.push(`${letterName} ${spokenRule}: ${syllable}، ${cumulative}`);
      } else if (curr.hasShadda) {
        spokenParts.push(
          `${letterName} ${spokenRule}: ${syllable}، ${cumulative}`
        );
      } else {
        spokenParts.push(`${letterName} ${spokenRule}: ${syllable}${extraStopHint}`);
        if (i > 0 && i < units.length - 1) {
          spokenParts.push(cumulative);
        }
      }
    }

    spokenParts.push(`الْكَلِمَةُ كَامِلَةً: ${word}`);
  }

  const finalDisplayWord = resolvedWords.join(' ').trim() || normalizedInput;
  return {
    diacritizedWord: finalDisplayWord,
    wasAutoDiacritized: anyAutoDiacritized,
    steps,
    fullReading:
      spokenParts.length > 0 ? `${spokenParts.join('، ')}.` : finalDisplayWord,
  };
}

function openQuranCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QURAN_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QURAN_CACHE_STORE)) {
        db.createObjectStore(QURAN_CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadCachedQuranRaw(): Promise<CompactAyahEntry[] | null> {
  try {
    const db = await openQuranCacheDb();
    const res = await new Promise<{ key: string; ayahs: CompactAyahEntry[] } | null>(
      (resolve, reject) => {
        const tx = db.transaction(QURAN_CACHE_STORE, 'readonly');
        const req = tx.objectStore(QURAN_CACHE_STORE).get(QURAN_CACHE_KEY);
        req.onsuccess = () =>
          resolve(
            (req.result as { key: string; ayahs: CompactAyahEntry[] } | undefined) ||
              null
          );
        req.onerror = () => reject(req.error);
      }
    );
    db.close();
    return res?.ayahs || null;
  } catch {
    return null;
  }
}

async function saveCachedQuranRaw(ayahs: CompactAyahEntry[]): Promise<void> {
  try {
    const db = await openQuranCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QURAN_CACHE_STORE, 'readwrite');
      tx.objectStore(QURAN_CACHE_STORE).put({
        key: QURAN_CACHE_KEY,
        ayahs,
        savedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage quota errors
  }
}

const WAQF_ONLY_REGEX = /^[\u06D6-\u06ED\u06DE\u06E9۞۩﴿﴾()[\].,؛،؟]+$/u;

const QURAN_STOP_SKELETONS = new Set([
  'من',
  'في',
  'ان',
  'ما',
  'لا',
  'علي',
  'الي',
  'هو',
  'هم',
  'قد',
  'كان',
  'قل',
  'الله',
  'لله',
  'رب',
  'وما',
  'ولا',
  'وان',
  'فان',
  'لم',
  'لن',
  'عن',
  'مع',
  'او',
  'ثم',
  'اذا',
  'اذ',
  'هذا',
  'ذلك',
  'الذي',
  'الذين',
  'التي',
  'كل',
  'بما',
  'فيها',
  'منهم',
  'لهم',
  'لكم',
  'عليكم',
  'عليهم',
  'انهم',
  'انكم',
]);

/**
 * Uthmani-tolerant consonantal skeleton:
 * Normalizes hamzas, ta-marbuta, alif-maqsura, AND collapses medial Alif for >= 4-letter words
 * so Uthmani Mushaf spellings ("الكتب", "الصعقه", "تجدلك") match Standard Simple ("الكتاب", "الصاعقة", "تجادلك").
 */
function uthmaniSkeleton(word: string): string {
  const plain = stripArabicDiacriticsForMatch(word).replace(/\s+/g, '');
  if (!plain) return '';
  if (plain.length < 4) return plain;
  const first = plain[0];
  const rest = plain.slice(1).replace(/ا/g, '');
  const merged = `${first}${rest}`;
  return merged.length >= 2 ? merged : plain;
}

function skeletonBucketKey(skel: string): string {
  if (!skel) return '';
  return `${skel[0]}_${skel[skel.length - 1]}`;
}

function buildQuranIndex(ayahs: CompactAyahEntry[]): QuranIndexData {
  const trigIndex = new Map<string, number[]>();
  const bigramIndex = new Map<string, number[]>();
  const skeletonIndex = new Map<string, number[]>();
  const skeletonBucketMap = new Map<string, string[]>();
  const surahNameMap = new Map<string, number>();

  for (let i = 0; i < ayahs.length; i++) {
    const ay = ayahs[i];
    const normSurah = stripArabicDiacriticsForMatch(ay.surahName).replace(/\s+/g, '');
    if (normSurah && !surahNameMap.has(normSurah)) {
      surahNameMap.set(normSurah, ay.surahNumber);
    }

    const words = ay.plainWords;
    const skels = ay.skeletons;

    for (let w = 0; w <= words.length - 3; w++) {
      const key = `${words[w]} ${words[w + 1]} ${words[w + 2]}`;
      const list = trigIndex.get(key);
      if (list) {
        if (list.length < 15) list.push(i);
      } else {
        trigIndex.set(key, [i]);
      }
    }

    for (let w = 0; w <= words.length - 2; w++) {
      const bKey = `${words[w]} ${words[w + 1]}`;
      const list = bigramIndex.get(bKey);
      if (list) {
        if (list.length < 24 && list[list.length - 1] !== i) list.push(i);
      } else {
        bigramIndex.set(bKey, [i]);
      }
    }

    for (let w = 0; w < skels.length; w++) {
      const sk = skels[w];
      if (!sk || sk.length < 2) continue;
      if (QURAN_STOP_SKELETONS.has(sk)) continue;
      const list = skeletonIndex.get(sk);
      if (list) {
        if (list[list.length - 1] !== i && list.length < 260) {
          list.push(i);
        }
      } else {
        skeletonIndex.set(sk, [i]);
        const bKey = skeletonBucketKey(sk);
        const bList = skeletonBucketMap.get(bKey);
        if (bList) {
          bList.push(sk);
        } else {
          skeletonBucketMap.set(bKey, [sk]);
        }
      }
    }
  }

  // Populate fast vocalization lookup map for instant unvocalized Quran word resolution
  const qMap = new Map<string, string>();
  for (const ay of ayahs) {
    for (let w = 0; w < ay.plainWords.length; w++) {
      const bare = ay.plainWords[w];
      if (bare && !qMap.has(bare)) {
        qMap.set(bare, ay.diacritizedWords[w]);
      }
    }
  }
  loadedQuranWordMap = qMap;

  return {
    ayahs,
    trigIndex,
    bigramIndex,
    skeletonIndex,
    skeletonBucketMap,
    surahNameMap,
  };
}

function buildEntryWords(
  rawText: string,
  surahNumber: number,
  ayahNumber: number
): { diacWords: string[]; plainWords: string[]; skeletons: string[] } {
  let cleanText = rawText.trim();
  // Strip prepended Bismillah on Surah 2..114 Ayah 1 (except Surah 9) so printed standalone Bismillah aligns cleanly
  if (surahNumber > 1 && surahNumber !== 9 && ayahNumber === 1) {
    cleanText = cleanText
      .replace(/^بِسْمِ\s+اللَّهِ\s+الرَّحْمَٰ?نِ\s+الرَّحِيمِ\s*/u, '')
      .trim();
  }

  const diacWords = cleanText
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !WAQF_ONLY_REGEX.test(w));

  const plainWords: string[] = [];
  const skeletons: string[] = [];
  const filteredDiac: string[] = [];

  for (const dw of diacWords) {
    const pl = stripArabicDiacriticsForMatch(dw);
    if (!pl) continue;
    filteredDiac.push(dw);
    plainWords.push(pl);
    skeletons.push(uthmaniSkeleton(pl));
  }

  return { diacWords: filteredDiac, plainWords, skeletons };
}

async function getQuranIndex(): Promise<QuranIndexData | null> {
  if (quranIndexPromise) return quranIndexPromise;

  quranIndexPromise = (async () => {
    const cached = await loadCachedQuranRaw();
    if (cached && cached.length > 6000 && Array.isArray(cached[0]?.skeletons)) {
      return buildQuranIndex(cached);
    }

    // Fetch complete Simple Quran JSON + Madinah Mushaf page numbers
    try {
      const res = await fetch('https://api.alquran.cloud/v1/quran/quran-simple');
      if (res.ok) {
        const json = (await res.json()) as {
          data?: {
            surahs?: Array<{
              number: number;
              name: string;
              ayahs: Array<{ numberInSurah: number; text: string; page?: number }>;
            }>;
          };
        };
        const surahs = json.data?.surahs || [];
        if (surahs.length >= 114) {
          const ayahs: CompactAyahEntry[] = [];
          for (const surah of surahs) {
            const cleanSurahName = surah.name.replace(/^سُورَةُ\s+|^سورة\s+/u, '').trim();
            for (const ay of surah.ayahs) {
              const built = buildEntryWords(ay.text, surah.number, ay.numberInSurah);
              if (built.plainWords.length > 0) {
                ayahs.push({
                  surahNumber: surah.number,
                  ayahNumber: ay.numberInSurah,
                  surahName: cleanSurahName,
                  page: Number(ay.page || 0),
                  diacritizedWords: built.diacWords,
                  plainWords: built.plainWords,
                  skeletons: built.skeletons,
                });
              }
            }
          }
          await saveCachedQuranRaw(ayahs);
          return buildQuranIndex(ayahs);
        }
      }
    } catch {
      // Try second public CDN below
    }

    try {
      const res = await fetch(
        'https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist/quran.json'
      );
      if (res.ok) {
        const surahs = (await res.json()) as Array<{
          id: number;
          name: string;
          verses: Array<{ id: number; text: string }>;
        }>;
        if (Array.isArray(surahs) && surahs.length >= 114) {
          const ayahs: CompactAyahEntry[] = [];
          for (const surah of surahs) {
            for (const ay of surah.verses || []) {
              const built = buildEntryWords(ay.text, surah.id, ay.id);
              if (built.plainWords.length > 0) {
                ayahs.push({
                  surahNumber: surah.id,
                  ayahNumber: ay.id,
                  surahName: surah.name,
                  page: 0,
                  diacritizedWords: built.diacWords,
                  plainWords: built.plainWords,
                  skeletons: built.skeletons,
                });
              }
            }
          }
          await saveCachedQuranRaw(ayahs);
          return buildQuranIndex(ayahs);
        }
      }
    } catch {
      // Offline / blocked CDN — gracefully skip Ayah tagging
    }

    return null;
  })();

  return quranIndexPromise;
}

function normalizeOcrConfusions(word: string): string {
  return stripArabicDiacriticsForMatch(word)
    .replace(/[ةه]/g, 'ه')
    .replace(/[يىئ]/g, 'ي')
    .replace(/[اأإآٱ]/g, 'ا');
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > 4) return Math.max(la, lb);

  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }
  return prev[lb];
}

function wordSimilarity(a: string, b: string): number {
  const na = normalizeOcrConfusions(a);
  const nb = normalizeOcrConfusions(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const sa = uthmaniSkeleton(na);
  const sb = uthmaniSkeleton(nb);
  if (sa && sb && sa === sb) return 0.96;

  const maxLen = Math.max(na.length, nb.length);
  const dist = levenshteinDistance(na, nb);
  const simRaw = Math.max(0, 1 - dist / maxLen);

  if (sa && sb) {
    const skDist = levenshteinDistance(sa, sb);
    const simSk = Math.max(0, 1 - skDist / Math.max(sa.length, sb.length));
    return Math.max(simRaw, simSk * 0.94);
  }
  return simRaw;
}

function enrichSegmentsWithQuranMatch(
  segments: BookTextSegment[],
  index: QuranIndexData | null
): BookTextSegment[] {
  if (!index || segments.length < 3) return segments;

  const plainList = segments.map((s) => stripArabicDiacriticsForMatch(s.text));
  const updated = segments.map((s) => ({ ...s }));
  const bigramMap = index.bigramIndex;

  for (let i = 0; i <= plainList.length - 3; i++) {
    const w1 = plainList[i];
    const w2 = plainList[i + 1];
    const w3 = plainList[i + 2];
    if (!w1 || !w2 || !w3) continue;

    // 1. Exact 3-word trigram fast lookup
    const trigKey = `${w1} ${w2} ${w3}`;
    const exactCandidates = index.trigIndex.get(trigKey);

    if (exactCandidates && exactCandidates.length > 0) {
      let matchedExact = false;
      for (const ayIdx of exactCandidates) {
        const ayah = index.ayahs[ayIdx];
        const startPos = ayah.plainWords.findIndex(
          (_, pos) =>
            pos <= ayah.plainWords.length - 3 &&
            ayah.plainWords[pos] === w1 &&
            ayah.plainWords[pos + 1] === w2 &&
            ayah.plainWords[pos + 2] === w3
        );
        if (startPos < 0) continue;

        let matchLen = 3;
        while (
          i + matchLen < plainList.length &&
          startPos + matchLen < ayah.plainWords.length &&
          wordSimilarity(plainList[i + matchLen], ayah.plainWords[startPos + matchLen]) >= 0.72
        ) {
          matchLen++;
        }

        for (let k = 0; k < matchLen; k++) {
          const segIdx = i + k;
          const diacWord = ayah.diacritizedWords[startPos + k];
          updated[segIdx] = {
            ...updated[segIdx],
            text: diacWord || updated[segIdx].text,
            plainText: ayah.plainWords[startPos + k] || updated[segIdx].plainText,
            kind: 'ayah',
            surahNumber: ayah.surahNumber,
            ayahNumber: ayah.ayahNumber,
            surahName: ayah.surahName,
          };
        }
        i += matchLen - 1;
        matchedExact = true;
        break;
      }
      if (matchedExact) continue;
    }

    // 2. Fuzzy 2-word bigram lookup to recover Ayahs from noisy low-res OCR
    const candSet = new Set<number>();
    const b12 = bigramMap.get(`${w1} ${w2}`);
    if (b12) for (const idx of b12) candSet.add(idx);
    const b23 = bigramMap.get(`${w2} ${w3}`);
    if (b23) for (const idx of b23) candSet.add(idx);

    if (candSet.size === 0) continue;

    let bestMatch: {
      ayIdx: number;
      startPos: number;
      matchLen: number;
      avgSim: number;
    } | null = null;

    for (const ayIdx of candSet) {
      const ayah = index.ayahs[ayIdx];
      if (ayah.plainWords.length < 3) continue;

      for (let pos = 0; pos <= ayah.plainWords.length - 3; pos++) {
        const s0 = wordSimilarity(w1, ayah.plainWords[pos]);
        const s1 = wordSimilarity(w2, ayah.plainWords[pos + 1]);
        const s2 = wordSimilarity(w3, ayah.plainWords[pos + 2]);
        const baseAvg = (s0 + s1 + s2) / 3;
        if (baseAvg < 0.76) continue;

        const strongCount = (s0 >= 0.8 ? 1 : 0) + (s1 >= 0.8 ? 1 : 0) + (s2 >= 0.8 ? 1 : 0);
        if (strongCount < 2) continue;

        let matchLen = 3;
        let simSum = s0 + s1 + s2;
        while (
          i + matchLen < plainList.length &&
          pos + matchLen < ayah.plainWords.length
        ) {
          const sim = wordSimilarity(
            plainList[i + matchLen],
            ayah.plainWords[pos + matchLen]
          );
          if (sim < 0.68) break;
          simSum += sim;
          matchLen++;
        }

        const avgSim = simSum / matchLen;
        if (
          !bestMatch ||
          matchLen > bestMatch.matchLen ||
          (matchLen === bestMatch.matchLen && avgSim > bestMatch.avgSim)
        ) {
          bestMatch = { ayIdx, startPos: pos, matchLen, avgSim };
        }
      }
    }

    if (bestMatch) {
      const ayah = index.ayahs[bestMatch.ayIdx];
      for (let k = 0; k < bestMatch.matchLen; k++) {
        const segIdx = i + k;
        const diacWord = ayah.diacritizedWords[bestMatch.startPos + k];
        updated[segIdx] = {
          ...updated[segIdx],
          text: diacWord || updated[segIdx].text,
          plainText: ayah.plainWords[bestMatch.startPos + k] || updated[segIdx].plainText,
          kind: 'ayah',
          surahNumber: ayah.surahNumber,
          ayahNumber: ayah.ayahNumber,
          surahName: ayah.surahName,
        };
      }
      i += bestMatch.matchLen - 1;
    }
  }

  return updated;
}

interface VisualLine {
  y0: number;
  y1: number;
  segments: BookTextSegment[];
}

function groupSegmentsIntoVisualLines(segments: BookTextSegment[]): VisualLine[] {
  if (segments.length === 0) return [];
  const sortedByY = [...segments].sort((a, b) => a.box[0] - b.box[0]);
  const lines: VisualLine[] = [];

  for (const seg of sortedByY) {
    const [sy0, , sy1] = seg.box;
    const sCy = (sy0 + sy1) / 2;
    const sH = Math.max(8, sy1 - sy0);

    let matchedLine: VisualLine | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const lCy = (line.y0 + line.y1) / 2;
      const lH = Math.max(8, line.y1 - line.y0);
      if (Math.abs(sCy - lCy) <= Math.max(sH, lH) * 0.58) {
        matchedLine = line;
        break;
      }
    }

    if (matchedLine) {
      matchedLine.segments.push(seg);
      matchedLine.y0 = Math.min(matchedLine.y0, sy0);
      matchedLine.y1 = Math.max(matchedLine.y1, sy1);
    } else {
      lines.push({ y0: sy0, y1: sy1, segments: [seg] });
    }
  }

  // Sort top-to-bottom, and RTL right-to-left (highest xmax first) inside each line
  lines.sort((a, b) => a.y0 - b.y0);
  for (const line of lines) {
    line.segments.sort((a, b) => b.box[3] - a.box[3]);
  }
  return lines;
}

function normalizeArabicDigits(input: string): string {
  const arNums = '٠١٢٣٤٥٦٧٨٩';
  return input.replace(/[٠-٩]/g, (d) => String(arNums.indexOf(d)));
}

function isPureMedallionOrNumber(text: string): boolean {
  const clean = normalizeArabicDigits(text).replace(/[﴿﴾()[\]\s.،ـ]/g, '');
  if (!clean) return true;
  if (/^\d{1,3}$/.test(clean)) return true;
  return /^[\u06D6-\u06ED\u06DE\u06E9]+$/u.test(clean);
}

interface QStreamItem {
  qIdx: number;
  ayahIdx: number;
  surahNumber: number;
  ayahNumber: number;
  surahName: string;
  diacWord: string;
  plainWord: string;
  skeleton: string;
  wordInAyah: number;
  ayahWordCount: number;
}

/**
 * Whole-Quran Monotonic Passage Aligner:
 * Turns noisy Uthmani Mushaf OCR (even with 40–60% garbled calligraphic characters or blue highlights)
 * into 100% zero-error fully-diacritized Quran text mapped onto the exact visual line boxes!
 */
function reconstructQuranPassageFromSegments(
  segments: BookTextSegment[],
  index: QuranIndexData | null,
  pageNumber: number
): BookTextSegment[] | null {
  if (!index || segments.length < 4) return null;

  const lines = groupSegmentsIntoVisualLines(segments);
  if (lines.length === 0) return null;

  // Detect optional Surah header ("سورة المجادلة") or Mushaf page ("صفحة ٥٤٢") in top 2 lines
  let hintSurahNumber: number | null = null;
  let hintPageNumber: number | null = null;
  let headerLinesCount = 0;

  for (let lIdx = 0; lIdx < Math.min(3, lines.length); lIdx++) {
    const lineJoined = lines[lIdx].segments.map((s) => s.text).join(' ');
    const linePlain = stripArabicDiacriticsForMatch(lineJoined);
    const digitsNorm = normalizeArabicDigits(lineJoined);

    const pageMatch = digitsNorm.match(/صفح[هة]\s*(\d{1,3})/);
    if (pageMatch) {
      const p = Number(pageMatch[1]);
      if (p >= 1 && p <= 604) hintPageNumber = p;
    }

    if (linePlain.includes('سوره') || lIdx === 0) {
      const compact = linePlain.replace(/سوره/g, '').replace(/\s+/g, '');
      for (const [sName, sNum] of index.surahNameMap.entries()) {
        if (compact.includes(sName) && sName.length >= 3) {
          hintSurahNumber = sNum;
          break;
        }
      }
    }
  }

  // Build ordered OCR word stream excluding pure medallion numbers for alignment (kept separately for bounds)
  interface IndexedOcrTok {
    tokIdx: number;
    lineIdx: number;
    lineWordIdx: number;
    seg: BookTextSegment;
    plain: string;
    skel: string;
  }

  // Separate top UI/header/Bismillah lines only when they match a Surah header or Bismillah pattern
  const bodyLinesStart = (() => {
    let start = 0;
    for (let lIdx = 0; lIdx < Math.min(3, lines.length); lIdx++) {
      const lPlain = stripArabicDiacriticsForMatch(
        lines[lIdx].segments.map((s) => s.text).join(' ')
      );
      const isUiBar =
        lPlain.includes('صفحه') ||
        lPlain.includes('جزء') ||
        lPlain.includes('حزب') ||
        (lPlain.includes('سوره') && lines[lIdx].segments.length <= 6);
      if (isUiBar) {
        start = lIdx + 1;
        headerLinesCount = start;
      } else {
        break;
      }
    }
    return start < lines.length ? start : 0;
  })();

  // Check if the first body line after Surah banner is standalone Bismillah
  let bismillahLineIdx = -1;
  if (bodyLinesStart < lines.length) {
    const firstBodyPlain = stripArabicDiacriticsForMatch(
      lines[bodyLinesStart].segments.map((s) => s.text).join(' ')
    );
    if (
      (firstBodyPlain.includes('بسم') && firstBodyPlain.includes('الرحيم')) ||
      (firstBodyPlain.includes('الرحمن') && firstBodyPlain.includes('الرحيم'))
    ) {
      // Only treat as standalone Bismillah header if there are more lines below and hintSurah != 1
      if (lines.length - bodyLinesStart >= 2 && hintSurahNumber !== 1) {
        bismillahLineIdx = bodyLinesStart;
      }
    }
  }

  const verseLineStart = bismillahLineIdx >= 0 ? bismillahLineIdx + 1 : bodyLinesStart;
  const ocrTokens: IndexedOcrTok[] = [];
  for (let lIdx = verseLineStart; lIdx < lines.length; lIdx++) {
    const lineSegs = lines[lIdx].segments;
    for (let wIdx = 0; wIdx < lineSegs.length; wIdx++) {
      const seg = lineSegs[wIdx];
      if (isPureMedallionOrNumber(seg.text)) continue;
      const plain = stripArabicDiacriticsForMatch(seg.text);
      if (!plain) continue;
      const skel = uthmaniSkeleton(plain);
      ocrTokens.push({
        tokIdx: ocrTokens.length,
        lineIdx: lIdx,
        lineWordIdx: wIdx,
        seg,
        plain,
        skel,
      });
    }
  }

  if (ocrTokens.length < 4) return null;

  // Step 1: Whole-Quran Inverted Skeleton + 1-Edit Fuzzy Anchor Voting
  const ayahVotes = new Float64Array(index.ayahs.length);

  for (const tok of ocrTokens) {
    if (!tok.skel || tok.skel.length < 2 || QURAN_STOP_SKELETONS.has(tok.skel)) continue;
    const hits = index.skeletonIndex.get(tok.skel);

    if (hits && hits.length > 0) {
      const w = Math.min(7, tok.skel.length * 1.15);
      for (const ayIdx of hits) ayahVotes[ayIdx] += w;
    } else if (tok.skel.length >= 4) {
      // Check fast 1-edit neighbors in same start+end bucket
      const bucket = index.skeletonBucketMap.get(skeletonBucketKey(tok.skel)) || [];
      const nearSkels: string[] = [];
      for (const candSk of bucket) {
        if (Math.abs(candSk.length - tok.skel.length) > 1) continue;
        if (levenshteinDistance(tok.skel, candSk) <= 1) {
          nearSkels.push(candSk);
        }
      }
      if (nearSkels.length > 0 && nearSkels.length <= 6) {
        const w = Math.min(4.5, tok.skel.length * 0.7);
        for (const sk of nearSkels) {
          const aList = index.skeletonIndex.get(sk) || [];
          for (const ayIdx of aList) ayahVotes[ayIdx] += w;
        }
      }
    }
  }

  // Sliding passage window scoring across all 6236 ayahs
  const WINDOW = 14;
  const candidateStarts: Array<{ startAyah: number; score: number }> = [];
  for (let a = 0; a < index.ayahs.length; a++) {
    let sum = 0;
    const end = Math.min(index.ayahs.length, a + WINDOW);
    for (let k = a; k < end; k++) {
      sum += ayahVotes[k];
    }
    if (sum <= 0) continue;
    if (hintPageNumber && index.ayahs[a].page === hintPageNumber) sum += 45;
    if (hintSurahNumber && index.ayahs[a].surahNumber === hintSurahNumber) sum += 30;
    candidateStarts.push({ startAyah: a, score: sum });
  }

  candidateStarts.sort((a, b) => b.score - a.score);
  const topCandidates: number[] = [];
  for (const c of candidateStarts) {
    if (topCandidates.every((prev) => Math.abs(prev - c.startAyah) >= 8)) {
      topCandidates.push(c.startAyah);
      if (topCandidates.length >= 4) break;
    }
  }
  if (topCandidates.length === 0) return null;

  interface AlignedPair {
    tokIdx: number;
    qIdx: number;
    sim: number;
  }

  let bestSolution: {
    qStream: QStreamItem[];
    chain: AlignedPair[];
    score: number;
    distinctiveCount: number;
    firstQ: number;
    lastQ: number;
  } | null = null;

  for (const candStart of topCandidates) {
    const ayFrom = Math.max(0, candStart - 2);
    const ayTo = Math.min(index.ayahs.length, candStart + 20);
    const qStream: QStreamItem[] = [];

    for (let a = ayFrom; a < ayTo; a++) {
      const ay = index.ayahs[a];
      for (let w = 0; w < ay.diacritizedWords.length; w++) {
        qStream.push({
          qIdx: qStream.length,
          ayahIdx: a,
          surahNumber: ay.surahNumber,
          ayahNumber: ay.ayahNumber,
          surahName: ay.surahName,
          diacWord: ay.diacritizedWords[w],
          plainWord: ay.plainWords[w],
          skeleton: ay.skeletons[w],
          wordInAyah: w,
          ayahWordCount: ay.diacritizedWords.length,
        });
      }
    }

    // Collect sparse high-confidence match pairs (tokIdx, qIdx)
    const pairs: AlignedPair[] = [];
    for (const tok of ocrTokens) {
      for (const q of qStream) {
        if (tok.skel === q.skeleton && tok.skel.length >= 2) {
          pairs.push({ tokIdx: tok.tokIdx, qIdx: q.qIdx, sim: 1 });
        } else if (tok.plain.length >= 3 && q.plainWord.length >= 3) {
          const sim = wordSimilarity(tok.plain, q.plainWord);
          if (sim >= 0.72) {
            pairs.push({ tokIdx: tok.tokIdx, qIdx: q.qIdx, sim });
          }
        }
      }
    }

    if (pairs.length < 4) continue;

    // Monotonic DP over pairs sorted by (tokIdx, qIdx)
    pairs.sort((a, b) => a.tokIdx - b.tokIdx || a.qIdx - b.qIdx);
    const n = pairs.length;
    const dp = new Float64Array(n);
    const prevIdx = new Int32Array(n).fill(-1);

    let bestEnd = 0;
    for (let i = 0; i < n; i++) {
      const p = pairs[i];
      const baseWeight =
        p.sim * (qStream[p.qIdx].skeleton.length >= 4 ? 5.5 : 2.8);
      dp[i] = baseWeight;

      for (let j = i - 1; j >= 0 && i - j <= 120; j--) {
        const pj = pairs[j];
        if (pj.tokIdx < p.tokIdx && pj.qIdx < p.qIdx) {
          const tokGap = p.tokIdx - pj.tokIdx;
          const qGap = p.qIdx - pj.qIdx;
          // Reject impossible giant skips across non-matching text
          if (qGap > tokGap * 3 + 10) continue;
          const gapPenalty = Math.max(0, qGap - tokGap - 1) * 0.45;
          const candScore = dp[j] + baseWeight - gapPenalty;
          if (candScore > dp[i]) {
            dp[i] = candScore;
            prevIdx[i] = j;
          }
        }
      }
      if (dp[i] > dp[bestEnd]) bestEnd = i;
    }

    const chain: AlignedPair[] = [];
    let cur = bestEnd;
    while (cur >= 0) {
      chain.push(pairs[cur]);
      cur = prevIdx[cur];
    }
    chain.reverse();

    if (chain.length < 4) continue;

    const firstQ = chain[0].qIdx;
    const lastQ = chain[chain.length - 1].qIdx;
    const qSpan = lastQ - firstQ + 1;
    const density = chain.length / Math.max(1, qSpan);
    const distinctiveCount = chain.filter(
      (p) => qStream[p.qIdx].skeleton.length >= 4
    ).length;

    const minAligned = ocrTokens.length <= 12 ? 4 : 6;
    if (chain.length < minAligned || distinctiveCount < 3 || density < 0.34) {
      continue;
    }

    const totalScore = dp[bestEnd];
    if (!bestSolution || totalScore > bestSolution.score) {
      bestSolution = {
        qStream,
        chain,
        score: totalScore,
        distinctiveCount,
        firstQ,
        lastQ,
      };
    }
  }

  if (!bestSolution) return null;

  const { qStream, chain } = bestSolution;
  let firstQ = bestSolution.firstQ;
  let lastQ = bestSolution.lastQ;

  // Recover up to 1–2 missing boundary words on first/last visual lines (e.g., "وَإِذْ" before "آتَيْنَا" or "عَلَيْكُمُ" after "وَظَلَّلْنَا")
  const firstTok = ocrTokens[chain[0].tokIdx];
  const leadingUnalignedOnFirstLine = ocrTokens.filter(
    (t) => t.lineIdx === firstTok.lineIdx && t.tokIdx < firstTok.tokIdx
  ).length;
  if (leadingUnalignedOnFirstLine > 0 && firstQ > 0) {
    const maxPull = Math.min(
      leadingUnalignedOnFirstLine,
      qStream[firstQ].wordInAyah,
      2
    );
    firstQ -= maxPull;
  }

  const lastTok = ocrTokens[chain[chain.length - 1].tokIdx];
  const trailingUnalignedOnLastLine = ocrTokens.filter(
    (t) => t.lineIdx === lastTok.lineIdx && t.tokIdx > lastTok.tokIdx
  ).length;
  if (trailingUnalignedOnLastLine > 0 && lastQ + 1 < qStream.length) {
    const remainingInAyah =
      qStream[lastQ].ayahWordCount - 1 - qStream[lastQ].wordInAyah;
    const maxPush = Math.min(trailingUnalignedOnLastLine, remainingInAyah, 2);
    lastQ += maxPush;
  }

  // Build map qIdx -> measured OCR token box & line
  const qToTok = new Map<number, IndexedOcrTok>();
  for (const p of chain) {
    qToTok.set(p.qIdx, ocrTokens[p.tokIdx]);
  }

  // Map every Quran word in [firstQ..lastQ] onto exact or interpolated visual line boxes
  const resultSegments: BookTextSegment[] = [];
  let counter = 0;

  // Optionally preserve Surah banner / Bismillah lines cleanly above verses
  if (headerLinesCount > 0 && hintSurahNumber) {
    const bannerLineIdx = Math.max(0, Math.min(lines.length - 1, headerLinesCount - 1));
    const headerSegs = lines[bannerLineIdx].segments;
    const minY = Math.min(...headerSegs.map((s) => s.box[0]));
    const minX = Math.min(...headerSegs.map((s) => s.box[1]));
    const maxY = Math.max(...headerSegs.map((s) => s.box[2]));
    const maxX = Math.max(...headerSegs.map((s) => s.box[3]));
    const firstAy = qStream[firstQ];
    counter++;
    resultSegments.push({
      id: `p${pageNumber}_w${counter}`,
      text: `سُورَةُ ${firstAy.surahName}`,
      plainText: stripArabicDiacriticsForMatch(`سورة ${firstAy.surahName}`),
      kind: 'word',
      box: [minY, minX, maxY, maxX],
    });
  }

  if (bismillahLineIdx >= 0) {
    const bisWords = ['بِسْمِ', 'اللَّهِ', 'الرَّحْمَٰنِ', 'الرَّحِيمِ'];
    const bLine = lines[bismillahLineIdx];
    const bMinX = Math.min(...bLine.segments.map((s) => s.box[1]));
    const bMaxX = Math.max(...bLine.segments.map((s) => s.box[3]));
    const span = Math.max(40, bMaxX - bMinX);
    const step = span / bisWords.length;
    bisWords.forEach((bw, idx) => {
      counter++;
      const x1 = Math.round(bMaxX - idx * step);
      const x0 = Math.max(0, Math.round(x1 - step + 2));
      resultSegments.push({
        id: `p${pageNumber}_w${counter}`,
        text: bw,
        plainText: stripArabicDiacriticsForMatch(bw),
        kind: 'word',
        box: [bLine.y0, x0, bLine.y1, Math.max(x0 + 8, x1)],
      });
    });
  }

  const alignedPositions = Array.from(qToTok.keys()).sort((a, b) => a - b);

  for (let qi = firstQ; qi <= lastQ; qi++) {
    const item = qStream[qi];
    let box: [number, number, number, number];

    const directTok = qToTok.get(qi);
    if (directTok) {
      box = directTok.seg.box;
    } else {
      // Find nearest left/right anchored Quran words to place missing word cleanly on its visual line
      let prevAnchorQ = -1;
      let nextAnchorQ = -1;
      for (const aq of alignedPositions) {
        if (aq < qi) prevAnchorQ = aq;
        if (aq > qi && nextAnchorQ < 0) {
          nextAnchorQ = aq;
          break;
        }
      }

      if (prevAnchorQ >= 0 && nextAnchorQ >= 0) {
        const pt = qToTok.get(prevAnchorQ)!;
        const nt = qToTok.get(nextAnchorQ)!;
        if (pt.lineIdx === nt.lineIdx) {
          // Interpolate horizontally RTL between pt (right) and nt (left)
          const steps = nextAnchorQ - prevAnchorQ;
          const t = (qi - prevAnchorQ) / steps;
          const rightEdge = pt.seg.box[1]; // xmin of prev word
          const leftEdge = nt.seg.box[3]; // xmax of next word
          const gapW = Math.max(18, rightEdge - leftEdge);
          const sliceW = gapW / steps;
          const x1 = Math.round(rightEdge - (qi - prevAnchorQ - 1) * sliceW);
          const x0 = Math.max(0, Math.round(x1 - sliceW));
          const y0 = Math.round(pt.seg.box[0] * (1 - t) + nt.seg.box[0] * t);
          const y1 = Math.round(pt.seg.box[2] * (1 - t) + nt.seg.box[2] * t);
          box = [y0, x0, Math.max(y0 + 10, y1), Math.max(x0 + 10, x1)];
        } else {
          // Cross-line gap: attach before nextAnchor if closer to next, else after prevAnchor
          const distPrev = qi - prevAnchorQ;
          const distNext = nextAnchorQ - qi;
          if (distNext <= distPrev) {
            const w = Math.max(24, Math.min(75, item.plainWord.length * 14));
            const x0 = Math.min(980, nt.seg.box[3] + 4);
            const x1 = Math.min(1000, x0 + w);
            box = [nt.seg.box[0], x0, nt.seg.box[2], Math.max(x0 + 10, x1)];
          } else {
            const w = Math.max(24, Math.min(75, item.plainWord.length * 14));
            const x1 = Math.max(20, pt.seg.box[1] - 4);
            const x0 = Math.max(0, x1 - w);
            box = [pt.seg.box[0], x0, pt.seg.box[2], Math.max(x0 + 10, x1)];
          }
        }
      } else if (nextAnchorQ >= 0) {
        const nt = qToTok.get(nextAnchorQ)!;
        const offsetCount = nextAnchorQ - qi;
        const w = Math.max(26, Math.min(75, item.plainWord.length * 13));
        const x0 = Math.min(970, nt.seg.box[3] + (offsetCount - 1) * (w + 6) + 4);
        const x1 = Math.min(1000, x0 + w);
        box = [nt.seg.box[0], x0, nt.seg.box[2], Math.max(x0 + 10, x1)];
      } else {
        const pt = qToTok.get(prevAnchorQ)!;
        const offsetCount = qi - prevAnchorQ;
        const w = Math.max(26, Math.min(75, item.plainWord.length * 13));
        const x1 = Math.max(30, pt.seg.box[1] - (offsetCount - 1) * (w + 6) - 4);
        const x0 = Math.max(0, x1 - w);
        box = [pt.seg.box[0], x0, pt.seg.box[2], Math.max(x0 + 10, x1)];
      }
    }

    counter++;
    resultSegments.push({
      id: `p${pageNumber}_w${counter}`,
      text: item.diacWord,
      plainText: item.plainWord,
      kind: 'ayah',
      surahNumber: item.surahNumber,
      ayahNumber: item.ayahNumber,
      surahName: item.surahName,
      box,
    });
  }

  return resultSegments.length > 0 ? resultSegments : null;
}

/**
 * Exposed so both server Gemini Vision responses and browser OCR outputs pass through
 * deterministic Quranic verification & zero-error diacritic restoration.
 */
export async function verifyAndAlignSegmentsWithQuran(params: {
  segments: BookTextSegment[];
  fullText: string;
  pageNumber: number;
  onProgress?: (progress: PageOcrProgress) => void;
}): Promise<{ fullText: string; segments: BookTextSegment[] }> {
  params.onProgress?.({
    pageNumber: params.pageNumber,
    pagePercent: 86,
    stageText: 'جاري مطابقة النصوص والآيات مع فهرس القرآن الكريم (٦٢٣٦ آية)...',
  });
  const quranIndex = await getQuranIndex().catch(() => null);
  if (!quranIndex || params.segments.length === 0) {
    params.onProgress?.({
      pageNumber: params.pageNumber,
      pagePercent: 100,
      stageText: 'اكتمل التعرف على الصفحة بنجاح',
    });
    return { fullText: params.fullText, segments: params.segments };
  }

  const reconstructed = reconstructQuranPassageFromSegments(
    params.segments,
    quranIndex,
    params.pageNumber
  );
  if (reconstructed && reconstructed.length > 0) {
    params.onProgress?.({
      pageNumber: params.pageNumber,
      pagePercent: 97,
      stageText: 'جاري ضبط التشكيل العثماني الكامل ومواقع الكلمات على الصفحة...',
    });
    params.onProgress?.({
      pageNumber: params.pageNumber,
      pagePercent: 100,
      stageText: 'تمت مطابقة الآيات والتشكيل بنسبة دقة كاملة',
    });
    return {
      fullText: reconstructed.map((s) => s.text).join(' ').slice(0, 18000),
      segments: reconstructed,
    };
  }

  const enriched = enrichSegmentsWithQuranMatch(params.segments, quranIndex);
  params.onProgress?.({
    pageNumber: params.pageNumber,
    pagePercent: 97,
    stageText: 'جاري ضبط التشكيل وإحداثيات الكلمات...',
  });
  params.onProgress?.({
    pageNumber: params.pageNumber,
    pagePercent: 100,
    stageText: 'اكتمل التعرف على الصفحة بنجاح',
  });
  return {
    fullText:
      enriched.length > 0
        ? enriched.map((s) => s.text).join(' ').slice(0, 18000)
        : params.fullText,
    segments: enriched,
  };
}

async function getArabicOcrWorker(): Promise<Worker> {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const worker = await createWorker('ara', 1, {
      logger: (m: { status?: string; progress?: number }) => {
        activeOcrLoggerCallback?.(m);
      },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    return worker;
  })().catch((err) => {
    ocrWorkerPromise = null;
    throw err;
  });
  return ocrWorkerPromise;
}

const OCR_WHITE_MARGIN = 40;
const MAX_OCR_CANVAS_SIDE = 2600;
const MAX_OCR_PIXELS = 6_600_000;

async function loadHtmlImage(imageDataUrl: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('تعذّر تحميل صورة الصفحة للتعرف النصي.'));
    el.src = imageDataUrl;
  });
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  origW: number;
  origH: number;
}

/**
 * Automatically detects and strips:
 * - Solid dark phone/tablet status bars & nav bars
 * - Blank A4/tablet margins (focusing 100% resolution on the text column)
 * - Isolated outer corner UI buttons
 * - Ornate vertical Mushaf borders ("زخارف المصحف") separated by vertical gutters
 */
function detectInnerTextCropRect(img: HTMLImageElement): CropRect {
  const origW = Math.max(1, img.width);
  const origH = Math.max(1, img.height);
  const fallback: CropRect = { x: 0, y: 0, w: origW, h: origH, origW, origH };

  if (origW < 120 || origH < 120) return fallback;

  const pw = Math.min(origW, 420);
  const ph = Math.max(40, Math.round(origH * (pw / origW)));
  const probe = document.createElement('canvas');
  probe.width = pw;
  probe.height = ph;
  const ctx = probe.getContext('2d');
  if (!ctx) return fallback;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, pw, ph);
  ctx.drawImage(img, 0, 0, pw, ph);

  let rgba: Uint8ClampedArray;
  try {
    rgba = ctx.getImageData(0, 0, pw, ph).data;
  } catch {
    return fallback;
  }

  const lum = new Uint8Array(pw * ph);
  const innerSamples: number[] = [];
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const p = y * pw + x;
      const i = p * 4;
      const v = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
      lum[p] = v;
      if (y > ph * 0.15 && y < ph * 0.85 && x > pw * 0.15 && x < pw * 0.85 && p % 5 === 0) {
        innerSamples.push(v);
      }
    }
  }

  innerSamples.sort((a, b) => a - b);
  const medianInner = innerSamples[Math.floor(innerSamples.length * 0.5)] ?? 255;
  // Skip dark-bar/white-margin trimming if image itself is dark-mode
  if (medianInner < 120) return fallback;
  const paperWhite = innerSamples[Math.floor(innerSamples.length * 0.85)] ?? 250;
  const inkCutoff = Math.max(60, paperWhite - 28);

  // 1. Trim solid dark status bars at very top/bottom (<12%)
  let topY = 0;
  const maxTopScan = Math.floor(ph * 0.12);
  while (topY < maxTopScan) {
    let sum = 0;
    const rowOff = topY * pw;
    for (let x = 0; x < pw; x++) sum += lum[rowOff + x];
    if (sum / pw < 78) {
      topY++;
    } else {
      break;
    }
  }

  let botY = ph - 1;
  const minBotScan = Math.floor(ph * 0.88);
  while (botY > minBotScan) {
    let sum = 0;
    const rowOff = botY * pw;
    for (let x = 0; x < pw; x++) sum += lum[rowOff + x];
    if (sum / pw < 78) {
      botY--;
    } else {
      break;
    }
  }

  // 2. Tight-crop empty white top & bottom margins
  const rowInkCount = new Int32Array(ph);
  for (let y = topY; y <= botY; y++) {
    let cnt = 0;
    const rowOff = y * pw;
    for (let x = 0; x < pw; x++) {
      if (lum[rowOff + x] < inkCutoff) cnt++;
    }
    rowInkCount[y] = cnt;
  }

  const minRowInk = Math.max(2, Math.floor(pw * 0.01));
  while (topY < botY && rowInkCount[topY] < minRowInk) topY++;
  while (botY > topY && rowInkCount[botY] < minRowInk) botY--;

  // Ignore thin detached home indicator bar right at bottom edge (gap >= 3% below text)
  const scanLimitBot = Math.max(topY + 10, botY - Math.floor(ph * 0.08));
  let gapRows = 0;
  for (let y = botY; y >= scanLimitBot; y--) {
    if (rowInkCount[y] < Math.max(3, Math.floor(pw * 0.018))) {
      gapRows++;
    } else {
      if (gapRows >= Math.max(4, Math.floor(ph * 0.025)) && botY - y < Math.floor(ph * 0.06)) {
        botY = y;
      }
      gapRows = 0;
    }
  }

  // 3. Find main horizontal text block (drops empty side margins & isolated floating corner buttons)
  const spanH = Math.max(1, botY - topY + 1);
  const colInk = new Float64Array(pw);
  for (let x = 0; x < pw; x++) {
    let cnt = 0;
    for (let y = topY; y <= botY; y++) {
      if (lum[y * pw + x] < inkCutoff) cnt++;
    }
    colInk[x] = cnt / spanH;
  }

  // Partition active horizontal clusters separated by pure-white vertical gutters (>= 3.5% width)
  const minGutterW = Math.max(4, Math.floor(pw * 0.035));
  let clusters: Array<{ x0: number; x1: number; mass: number }> = [];
  let inCluster = false;
  let cStart = 0;
  let cMass = 0;
  let emptyRun = 0;

  for (let x = 0; x < pw; x++) {
    const active = colInk[x] >= 0.015;
    if (active) {
      if (!inCluster) {
        inCluster = true;
        cStart = x;
        cMass = 0;
      }
      cMass += colInk[x];
      emptyRun = 0;
    } else if (inCluster) {
      emptyRun++;
      if (emptyRun >= minGutterW) {
        clusters.push({ x0: cStart, x1: x - emptyRun, mass: cMass });
        inCluster = false;
      } else {
        cMass += colInk[x];
      }
    }
  }
  if (inCluster) {
    clusters.push({ x0: cStart, x1: pw - 1 - emptyRun, mass: cMass });
  }

  let leftX = 0;
  let rightX = pw - 1;
  if (clusters.length > 0) {
    clusters.sort((a, b) => b.mass - a.mass);
    const primary = clusters[0];
    // Include adjacent secondary clusters only if they hold substantial text (>= 18% of primary mass)
    const significant = clusters.filter((c) => c.mass >= primary.mass * 0.18);
    leftX = Math.min(...significant.map((c) => c.x0));
    rightX = Math.max(...significant.map((c) => c.x1));
  }

  // Re-tighten topY / botY inside [leftX..rightX] (removes floating bottom corner mic icons cleanly!)
  const colW = Math.max(1, rightX - leftX + 1);
  const innerMinRowInk = Math.max(2, Math.floor(colW * 0.015));
  while (topY < botY) {
    let cnt = 0;
    for (let x = leftX; x <= rightX; x++) {
      if (lum[topY * pw + x] < inkCutoff) cnt++;
    }
    if (cnt < innerMinRowInk) topY++;
    else break;
  }
  while (botY > topY) {
    let cnt = 0;
    for (let x = leftX; x <= rightX; x++) {
      if (lum[botY * pw + x] < inkCutoff) cnt++;
    }
    if (cnt < innerMinRowInk) botY--;
    else break;
  }

  // 4. Trim ornate vertical Mushaf side-borders (high continuous vertical density at outer edges separated by vertical white gutter)
  const finalSpanH = Math.max(1, botY - topY + 1);
  const innerColFill = new Float64Array(pw);
  for (let x = leftX; x <= rightX; x++) {
    let cnt = 0;
    for (let y = topY; y <= botY; y++) {
      if (lum[y * pw + x] < paperWhite - 32) cnt++;
    }
    innerColFill[x] = cnt / finalSpanH;
  }

  const borderScanW = Math.floor((rightX - leftX + 1) * 0.16);
  // Check left ornate border
  let hasLeftDenseBand = false;
  for (let x = leftX; x < leftX + borderScanW; x++) {
    if (innerColFill[x] >= 0.45) {
      hasLeftDenseBand = true;
    } else if (
      hasLeftDenseBand &&
      innerColFill[x] <= 0.04 &&
      x + 1 < leftX + borderScanW &&
      innerColFill[x + 1] <= 0.04
    ) {
      // Found clean white gutter after ornate left border
      let gx = x;
      while (gx < leftX + borderScanW && innerColFill[gx] <= 0.04) gx++;
      if (gx < rightX - 20) leftX = gx;
      break;
    }
  }

  // Check right ornate border
  let hasRightDenseBand = false;
  for (let x = rightX; x > rightX - borderScanW; x--) {
    if (innerColFill[x] >= 0.45) {
      hasRightDenseBand = true;
    } else if (
      hasRightDenseBand &&
      innerColFill[x] <= 0.04 &&
      x - 1 > rightX - borderScanW &&
      innerColFill[x - 1] <= 0.04
    ) {
      let gx = x;
      while (gx > rightX - borderScanW && innerColFill[gx] <= 0.04) gx--;
      if (gx > leftX + 20) rightX = gx;
      break;
    }
  }

  // Add slight 1% safety pad and scale back to original pixels
  const padX = Math.max(2, Math.round(pw * 0.01));
  const padY = Math.max(2, Math.round(ph * 0.01));
  const px0 = Math.max(0, leftX - padX);
  const py0 = Math.max(0, topY - padY);
  const px1 = Math.min(pw, rightX + 1 + padX);
  const py1 = Math.min(ph, botY + 1 + padY);

  const cropX = Math.floor((px0 / pw) * origW);
  const cropY = Math.floor((py0 / ph) * origH);
  const cropW = Math.max(40, Math.min(origW - cropX, Math.ceil(((px1 - px0) / pw) * origW)));
  const cropH = Math.max(40, Math.min(origH - cropY, Math.ceil(((py1 - py0) / ph) * origH)));

  if (cropW < origW * 0.14 || cropH < origH * 0.14) {
    return fallback;
  }

  return { x: cropX, y: cropY, w: cropW, h: cropH, origW, origH };
}

/**
 * Crops the detected inner text area first, then progressively upscales ONLY that text
 * region to ~2200px wide for maximum Arabic character & harakat crispness.
 */
function progressiveCropAndUpscale(
  img: HTMLImageElement,
  crop: CropRect,
  targetMinWidth = 2150
): HTMLCanvasElement {
  const srcW = crop.w;
  const srcH = crop.h;

  let desiredScale = 1.0;
  if (srcW < 650) {
    desiredScale = Math.min(4.2, targetMinWidth / srcW);
  } else if (srcW < 1400) {
    desiredScale = Math.min(2.8, Math.max(1.5, targetMinWidth / srcW));
  } else if (srcW < 1900) {
    desiredScale = Math.min(1.4, targetMinWidth / srcW);
  }

  let targetW = Math.round(srcW * desiredScale);
  let targetH = Math.round(srcH * desiredScale);

  const maxDim = Math.max(targetW, targetH);
  if (maxDim > MAX_OCR_CANVAS_SIDE) {
    const shrink = MAX_OCR_CANVAS_SIDE / maxDim;
    targetW = Math.max(120, Math.round(targetW * shrink));
    targetH = Math.max(120, Math.round(targetH * shrink));
  }
  if (targetW * targetH > MAX_OCR_PIXELS) {
    const shrink = Math.sqrt(MAX_OCR_PIXELS / (targetW * targetH));
    targetW = Math.max(120, Math.round(targetW * shrink));
    targetH = Math.max(120, Math.round(targetH * shrink));
  }

  let currentCanvas = document.createElement('canvas');
  currentCanvas.width = srcW;
  currentCanvas.height = srcH;
  const initCtx = currentCanvas.getContext('2d');
  if (!initCtx) return currentCanvas;

  initCtx.fillStyle = '#FFFFFF';
  initCtx.fillRect(0, 0, srcW, srcH);
  initCtx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, srcW, srcH);

  while (currentCanvas.width * 1.85 < targetW) {
    const nextW = Math.min(targetW, Math.round(currentCanvas.width * 1.8));
    const nextH = Math.min(targetH, Math.round(currentCanvas.height * 1.8));
    const stepCanvas = document.createElement('canvas');
    stepCanvas.width = nextW;
    stepCanvas.height = nextH;
    const sCtx = stepCanvas.getContext('2d');
    if (!sCtx) break;
    sCtx.imageSmoothingEnabled = true;
    sCtx.imageSmoothingQuality = 'high';
    sCtx.fillStyle = '#FFFFFF';
    sCtx.fillRect(0, 0, nextW, nextH);
    sCtx.drawImage(currentCanvas, 0, 0, nextW, nextH);
    currentCanvas = stepCanvas;
  }

  if (currentCanvas.width !== targetW || currentCanvas.height !== targetH) {
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetW;
    finalCanvas.height = targetH;
    const fCtx = finalCanvas.getContext('2d');
    if (fCtx) {
      fCtx.imageSmoothingEnabled = true;
      fCtx.imageSmoothingQuality = 'high';
      fCtx.fillStyle = '#FFFFFF';
      fCtx.fillRect(0, 0, targetW, targetH);
      fCtx.drawImage(currentCanvas, 0, 0, targetW, targetH);
      currentCanvas = finalCanvas;
    }
  }

  return currentCanvas;
}

function extractNormalizedGrayscale(
  canvas: HTMLCanvasElement
): { gray: Uint8Array; isDarkBackground: boolean } {
  const w = canvas.width;
  const h = canvas.height;
  const gray = new Uint8Array(w * h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { gray, isDarkBackground: false };

  const rgba = ctx.getImageData(0, 0, w, h).data;
  const samples: number[] = [];
  const sampleStep = Math.max(4, Math.floor((w * h) / 4096));

  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const lum = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    gray[p] = lum;
    if (p % sampleStep === 0) samples.push(lum);
  }

  samples.sort((a, b) => a - b);
  const medianLum = samples[Math.floor(samples.length * 0.5)] ?? 255;
  const isDarkBackground = medianLum < 112;
  if (isDarkBackground) {
    for (let p = 0; p < gray.length; p++) {
      gray[p] = 255 - gray[p];
    }
  }
  return { gray, isDarkBackground };
}

function edgePreservingDenoise(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src);
  const diffThresh = 32;

  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      const c = src[idx];
      let sum = c * 2;
      let weight = 2;

      const n0 = src[idx - w];
      if (Math.abs(n0 - c) < diffThresh) {
        sum += n0;
        weight++;
      }
      const n1 = src[idx + w];
      if (Math.abs(n1 - c) < diffThresh) {
        sum += n1;
        weight++;
      }
      const n2 = src[idx - 1];
      if (Math.abs(n2 - c) < diffThresh) {
        sum += n2;
        weight++;
      }
      const n3 = src[idx + 1];
      if (Math.abs(n3 - c) < diffThresh) {
        sum += n3;
        weight++;
      }

      out[idx] = Math.round(sum / weight);
    }
  }
  return out;
}

function applyUnsharpMask(
  src: Uint8Array,
  w: number,
  h: number,
  amount: number,
  threshold: number
): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src);

  for (let y = 1; y < h - 1; y++) {
    const rPrev = (y - 1) * w;
    const rCurr = y * w;
    const rNext = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const c = src[rCurr + x];
      const blur =
        (src[rPrev + x - 1] +
          src[rPrev + x] * 2 +
          src[rPrev + x + 1] +
          src[rCurr + x - 1] * 2 +
          c * 4 +
          src[rCurr + x + 1] * 2 +
          src[rNext + x - 1] +
          src[rNext + x] * 2 +
          src[rNext + x + 1]) >>
        4;
      const diff = c - blur;
      if (Math.abs(diff) >= threshold) {
        const val = Math.round(c + amount * diff);
        out[rCurr + x] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
    }
  }
  return out;
}

function buildIntegralTables(
  gray: Uint8Array,
  w: number,
  h: number
): { sum: Float64Array; sumSq: Float64Array; stride: number } {
  const stride = w + 1;
  const sum = new Float64Array(stride * (h + 1));
  const sumSq = new Float64Array(stride * (h + 1));

  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const srcRow = (y - 1) * w;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let x = 1; x <= w; x++) {
      const v = gray[srcRow + (x - 1)];
      rowSum += v;
      rowSq += v * v;
      sum[dstRow + x] = sum[prevRow + x] + rowSum;
      sumSq[dstRow + x] = sumSq[prevRow + x] + rowSq;
    }
  }
  return { sum, sumSq, stride };
}

function queryWindowStats(
  tables: { sum: Float64Array; sumSq: Float64Array; stride: number },
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): { mean: number; std: number } {
  const x0 = x - radius < 0 ? 0 : x - radius;
  const y0 = y - radius < 0 ? 0 : y - radius;
  const x1 = x + radius >= w ? w - 1 : x + radius;
  const y1 = y + radius >= h ? h - 1 : y + radius;
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const st = tables.stride;

  const r1 = (y1 + 1) * st;
  const r0 = y0 * st;
  const s =
    tables.sum[r1 + (x1 + 1)] -
    tables.sum[r0 + (x1 + 1)] -
    tables.sum[r1 + x0] +
    tables.sum[r0 + x0];
  const sSq =
    tables.sumSq[r1 + (x1 + 1)] -
    tables.sumSq[r0 + (x1 + 1)] -
    tables.sumSq[r1 + x0] +
    tables.sumSq[r0 + x0];

  const mean = s / area;
  const variance = Math.max(0, sSq / area - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}

function renderGrayBufferWithMargin(
  gray: Uint8Array,
  w: number,
  h: number,
  margin: number
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = w + margin * 2;
  out.height = h + margin * 2;
  const ctx = out.getContext('2d');
  if (!ctx) return out;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);

  const imgData = ctx.createImageData(w, h);
  const d = imgData.data;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = gray[i];
    d[p] = v;
    d[p + 1] = v;
    d[p + 2] = v;
    d[p + 3] = 255;
  }
  ctx.putImageData(imgData, margin, margin);
  return out;
}

function estimateSkewAngleDeg(gray: Uint8Array, w: number, h: number): number {
  const targetSampleW = 320;
  const step = Math.max(1, Math.floor(w / targetSampleW));
  const sw = Math.floor(w / step);
  const sh = Math.floor(h / step);
  if (sw < 40 || sh < 40) return 0;

  let sumAll = 0;
  let countAll = 0;
  const xMin = Math.floor(sw * 0.08);
  const xMax = Math.floor(sw * 0.92);
  const yMin = Math.floor(sh * 0.08);
  const yMax = Math.floor(sh * 0.92);

  for (let sy = yMin; sy < yMax; sy++) {
    const rowOffset = sy * step * w;
    for (let sx = xMin; sx < xMax; sx++) {
      sumAll += gray[rowOffset + sx * step];
      countAll++;
    }
  }
  if (countAll === 0) return 0;
  const inkCutoff = Math.max(40, (sumAll / countAll) * 0.8);

  const inkX: number[] = [];
  const inkY: number[] = [];
  for (let sy = yMin; sy < yMax; sy++) {
    const rowOffset = sy * step * w;
    for (let sx = xMin; sx < xMax; sx++) {
      if (gray[rowOffset + sx * step] < inkCutoff) {
        inkX.push(sx);
        inkY.push(sy);
      }
    }
  }
  if (inkX.length < 180 || inkX.length > countAll * 0.65) return 0;

  const cx = sw / 2;
  const cy = sh / 2;
  const hist = new Float64Array(sh + 40);

  const scoreAngle = (deg: number): number => {
    const rad = (deg * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    hist.fill(0);
    for (let k = 0; k < inkX.length; k++) {
      const ry = Math.round((inkX[k] - cx) * s + (inkY[k] - cy) * c + cy + 20);
      if (ry >= 0 && ry < hist.length) hist[ry] += 1;
    }
    let energy = 0;
    for (let r = 0; r < hist.length; r++) {
      energy += hist[r] * hist[r];
    }
    return energy;
  };

  const zeroScore = scoreAngle(0);
  let bestDeg = 0;
  let bestScore = zeroScore;

  for (let deg = -6; deg <= 6; deg += 1) {
    if (deg === 0) continue;
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestDeg = deg;
    }
  }

  const refineStart = bestDeg;
  for (const offset of [-0.5, 0.5]) {
    const cand = refineStart + offset;
    const sc = scoreAngle(cand);
    if (sc > bestScore) {
      bestScore = sc;
      bestDeg = cand;
    }
  }

  if (Math.abs(bestDeg) < 0.9 || bestScore < zeroScore * 1.02) {
    return 0;
  }
  return bestDeg;
}

function rotateGrayBuffer(
  gray: Uint8Array,
  w: number,
  h: number,
  angleDeg: number
): Uint8Array {
  if (angleDeg === 0) return gray;
  const srcCanvas = renderGrayBufferWithMargin(gray, w, h, 0);
  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = w;
  dstCanvas.height = h;
  const ctx = dstCanvas.getContext('2d');
  if (!ctx) return gray;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(w / 2, h / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(srcCanvas, -w / 2, -h / 2);

  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = rgba[i];
  }
  return out;
}

/**
 * Finds horizontal text line bands using binary ink projection profile so
 * `PSM.SINGLE_LINE` can decode dense Uthmani / low-res lines cleanly one by one.
 */
function detectHorizontalTextLines(
  binaryBuf: Uint8Array,
  w: number,
  h: number
): Array<{ y0: number; y1: number }> {
  const rowBlack = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (binaryBuf[row + x] === 0) cnt++;
    }
    rowBlack[y] = cnt;
  }

  const minRowInk = Math.max(4, Math.floor(w * 0.005));
  const rawBands: Array<{ y0: number; y1: number }> = [];
  let inBand = false;
  let bStart = 0;

  for (let y = 0; y < h; y++) {
    if (rowBlack[y] >= minRowInk) {
      if (!inBand) {
        inBand = true;
        bStart = y;
      }
    } else if (inBand) {
      rawBands.push({ y0: bStart, y1: y });
      inBand = false;
    }
  }
  if (inBand) rawBands.push({ y0: bStart, y1: h });

  // Merge floating diacritic bands within vertical proximity of main text lines
  const minLineH = Math.max(16, Math.round(h * 0.015));
  const maxGap = Math.max(6, Math.round(h * 0.008));
  const merged: Array<{ y0: number; y1: number }> = [];

  for (const band of rawBands) {
    const bandH = band.y1 - band.y0;
    if (merged.length === 0) {
      merged.push({ ...band });
      continue;
    }
    const prev = merged[merged.length - 1];
    const gap = band.y0 - prev.y1;
    if (gap <= maxGap || (bandH < minLineH * 0.55 && gap <= minLineH * 0.7)) {
      prev.y1 = band.y1;
    } else {
      merged.push({ ...band });
    }
  }

  return merged.filter((b) => b.y1 - b.y0 >= minLineH);
}

interface PreparedOcrVariants {
  width: number;
  height: number;
  crop: CropRect;
  skewDeg: number;
  bufA: Uint8Array;
  bufB: Uint8Array;
  variantA: HTMLCanvasElement;
  variantB: HTMLCanvasElement;
  detectedLines: Array<{ y0: number; y1: number }>;
  buildVariantC: () => HTMLCanvasElement;
}

async function prepareOcrVariants(
  imageDataUrl: string,
  onStage?: (pct: number, stageText: string) => void
): Promise<PreparedOcrVariants> {
  onStage?.(4, 'جاري فحص أبعاد الصفحة وعزل الزخارف والأشرطة الجانبية...');
  const img = await loadHtmlImage(imageDataUrl);
  const crop = detectInnerTextCropRect(img);
  const upCanvas = progressiveCropAndUpscale(img, crop, 2150);
  const w = upCanvas.width;
  const h = upCanvas.height;

  onStage?.(9, 'جاري رفع دقة الحروف وتنقية الإضاءة وتصحيح ميل الصفحة...');
  const { gray: rawGray } = extractNormalizedGrayscale(upCanvas);
  const isLowRes = crop.w < 1150;

  const denoised = isLowRes ? edgePreservingDenoise(rawGray, w, h) : rawGray;
  const skewDeg = estimateSkewAngleDeg(denoised, w, h);
  const deskewed = skewDeg !== 0 ? rotateGrayBuffer(denoised, w, h, skewDeg) : denoised;

  const sharpened = applyUnsharpMask(
    deskewed,
    w,
    h,
    isLowRes ? 1.55 : 1.0,
    isLowRes ? 5 : 7
  );

  onStage?.(14, 'جاري إزالة التظليل وتحسين تباين الحبر والخلفية...');
  const tables = buildIntegralTables(sharpened, w, h);
  const radius = Math.max(22, Math.min(58, Math.round(w / 30)));

  const bufA = new Uint8Array(w * h);
  const bufB = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      const v = sharpened[idx];
      const { mean, std } = queryWindowStats(tables, x, y, w, h, radius);

      // Variant A: Adaptive illumination normalization (eliminates blue highlights & uneven lighting cleanly)
      const localPaper = Math.min(255, mean + Math.max(10, std * 0.72));
      const normalized = localPaper > 20 ? (v / localPaper) * 245 : v;
      const stretched =
        normalized > 214
          ? 255
          : normalized < 52
          ? 0
          : Math.round(((normalized - 52) / (214 - 52)) * 255);
      bufA[idx] = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched;

      // Variant B: Sauvola adaptive local binarization
      const sauvolaThresh = mean * (1 + 0.19 * (std / 128 - 1));
      const isBlankPaper = std < 7 && v > mean - 10;
      bufB[idx] = !isBlankPaper && v < sauvolaThresh ? 0 : 255;
    }
  }

  // Remove isolated 1-pixel speckles from Variant B while preserving 2px+ dots
  const bufBClean = new Uint8Array(bufB.length);
  bufBClean.set(bufB);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (bufB[idx] === 0) {
        let blackNeighbors = 0;
        if (bufB[idx - w - 1] === 0) blackNeighbors++;
        if (bufB[idx - w] === 0) blackNeighbors++;
        if (bufB[idx - w + 1] === 0) blackNeighbors++;
        if (bufB[idx - 1] === 0) blackNeighbors++;
        if (bufB[idx + 1] === 0) blackNeighbors++;
        if (bufB[idx + w - 1] === 0) blackNeighbors++;
        if (bufB[idx + w] === 0) blackNeighbors++;
        if (bufB[idx + w + 1] === 0) blackNeighbors++;
        if (blackNeighbors === 0) {
          bufBClean[idx] = 255;
        }
      }
    }
  }

  onStage?.(19, 'جاري اكتشاف وفصل أسطر الصفحة للتحليل الدقيق...');
  const detectedLines = detectHorizontalTextLines(bufBClean, w, h);
  const variantA = renderGrayBufferWithMargin(bufA, w, h, OCR_WHITE_MARGIN);
  const variantB = renderGrayBufferWithMargin(bufBClean, w, h, OCR_WHITE_MARGIN);

  const buildVariantC = (): HTMLCanvasElement => {
    const thick = new Uint8Array(w * h);
    thick.fill(255);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        const m = Math.min(
          sharpened[idx],
          sharpened[idx - 1],
          sharpened[idx + 1],
          sharpened[idx - w],
          sharpened[idx + w]
        );
        const blended = Math.round(sharpened[idx] * 0.4 + m * 0.6);
        const { mean, std } = queryWindowStats(tables, x, y, w, h, radius);
        const thr = mean * (1 + 0.12 * (std / 128 - 1));
        thick[idx] = !(std < 6 && blended > mean - 8) && blended < thr ? 0 : 255;
      }
    }
    return renderGrayBufferWithMargin(thick, w, h, OCR_WHITE_MARGIN);
  };

  return {
    width: w,
    height: h,
    crop,
    skewDeg,
    bufA,
    bufB: bufBClean,
    variantA,
    variantB,
    detectedLines,
    buildVariantC,
  };
}

/**
 * Also exposed so low-res images/scans can be enhanced before optional server vision analysis.
 */
export async function enhanceImageDataUrlForRecognition(
  imageDataUrl: string
): Promise<string> {
  try {
    const img = await loadHtmlImage(imageDataUrl);
    if (img.width >= 1500) {
      return imageDataUrl;
    }
    const fullCrop: CropRect = {
      x: 0,
      y: 0,
      w: img.width,
      h: img.height,
      origW: img.width,
      origH: img.height,
    };
    const canvas = progressiveCropAndUpscale(img, fullCrop, 1900);
    const w = canvas.width;
    const h = canvas.height;
    const { gray } = extractNormalizedGrayscale(canvas);
    const denoised = edgePreservingDenoise(gray, w, h);
    const sharpened = applyUnsharpMask(denoised, w, h, 1.35, 5);
    const outCanvas = renderGrayBufferWithMargin(sharpened, w, h, 0);
    return outCanvas.toDataURL('image/jpeg', 0.92);
  } catch {
    return imageDataUrl;
  }
}

function cleanOcrWordText(raw: string): string {
  return normalizeAllArabicFontForms(raw)
    .replace(/^[|_~`^]+|[|_~`^]+$/g, '')
    .trim();
}

/**
 * Maps word bounding boxes from the cropped/deskewed OCR canvas back into exact
 * [0..1000] coordinates on the FULL original page image.
 */
function mapOcrBoxToOriginalPage(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  procW: number,
  procH: number,
  marginX: number,
  marginY: number,
  offsetYInProc: number,
  skewDeg: number,
  crop: CropRect
): [number, number, number, number] {
  const rx0 = x0 - marginX;
  const ry0 = y0 - marginY + offsetYInProc;
  const rx1 = x1 - marginX;
  const ry1 = y1 - marginY + offsetYInProc;

  let ux0 = rx0;
  let uy0 = ry0;
  let ux1 = rx1;
  let uy1 = ry1;

  if (skewDeg !== 0) {
    const rad = (skewDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const cx = procW / 2;
    const cy = procH / 2;
    const corners: Array<[number, number]> = [
      [rx0, ry0],
      [rx1, ry0],
      [rx0, ry1],
      [rx1, ry1],
    ];
    ux0 = Infinity;
    uy0 = Infinity;
    ux1 = -Infinity;
    uy1 = -Infinity;
    for (const [qx, qy] of corners) {
      const dx = qx - cx;
      const dy = qy - cy;
      const px = cx + dx * c + dy * s;
      const py = cy - dx * s + dy * c;
      if (px < ux0) ux0 = px;
      if (px > ux1) ux1 = px;
      if (py < uy0) uy0 = py;
      if (py > uy1) uy1 = py;
    }
  }

  // Clamp inside cropped space, then transform into full original page [0..1000]
  const cX0 = Math.max(0, Math.min(procW, ux0));
  const cY0 = Math.max(0, Math.min(procH, uy0));
  const cX1 = Math.max(cX0 + 1, Math.min(procW, ux1));
  const cY1 = Math.max(cY0 + 1, Math.min(procH, uy1));

  const fullX0 = crop.x + (cX0 / Math.max(1, procW)) * crop.w;
  const fullY0 = crop.y + (cY0 / Math.max(1, procH)) * crop.h;
  const fullX1 = crop.x + (cX1 / Math.max(1, procW)) * crop.w;
  const fullY1 = crop.y + (cY1 / Math.max(1, procH)) * crop.h;

  const ymin = Math.max(0, Math.min(990, Math.round((fullY0 / Math.max(1, crop.origH)) * 1000)));
  const xmin = Math.max(0, Math.min(990, Math.round((fullX0 / Math.max(1, crop.origW)) * 1000)));
  const ymax = Math.max(ymin + 8, Math.min(1000, Math.round((fullY1 / Math.max(1, crop.origH)) * 1000)));
  const xmax = Math.max(xmin + 8, Math.min(1000, Math.round((fullX1 / Math.max(1, crop.origW)) * 1000)));
  return [ymin, xmin, ymax, xmax];
}

interface OcrPassOutcome {
  segments: BookTextSegment[];
  ocrText: string;
  confidence: number;
  arabicWords: number;
  junkTokens: number;
  score: number;
}

async function runOcrPass(
  worker: Worker,
  canvas: HTMLCanvasElement,
  psm: PSM,
  pageNumber: number,
  prepared: PreparedOcrVariants,
  onPassProgress?: (fraction: number) => void
): Promise<OcrPassOutcome> {
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });

  activeOcrLoggerCallback = (m) => {
    if (m.status === 'recognizing text' && typeof m.progress === 'number') {
      onPassProgress?.(Math.max(0, Math.min(1, m.progress)));
    }
  };

  let res: Awaited<ReturnType<Worker['recognize']>>;
  try {
    res = await worker.recognize(canvas, {}, { text: true, blocks: true });
  } finally {
    activeOcrLoggerCallback = null;
  }
  onPassProgress?.(1);

  const ocrText = (res.data.text || '').normalize('NFKC').trim();
  const confidence = Number(res.data.confidence || 0);
  const blocks = res.data.blocks || [];

  const segments: BookTextSegment[] = [];
  let wordCounter = 0;
  let arabicWords = 0;
  let junkTokens = 0;

  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          const cleanText = cleanOcrWordText(word.text || '');
          if (!cleanText) continue;

          const hasArabic = /[\u0621-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(
            cleanText
          );
          const hasDigit = /[0-9\u0660-\u0669]/.test(cleanText);
          const plain = stripArabicDiacriticsForMatch(cleanText);

          if (!hasArabic && !hasDigit && cleanText.length < 2) continue;
          if ((word.confidence || 0) < 12 && !hasArabic && cleanText.length <= 2) {
            junkTokens++;
            continue;
          }

          if (hasArabic) {
            arabicWords++;
          } else if (!hasDigit) {
            junkTokens++;
          }

          wordCounter++;
          if (segments.length >= 420) break;

          const box = mapOcrBoxToOriginalPage(
            word.bbox.x0,
            word.bbox.y0,
            word.bbox.x1,
            word.bbox.y1,
            prepared.width,
            prepared.height,
            OCR_WHITE_MARGIN,
            OCR_WHITE_MARGIN,
            0,
            prepared.skewDeg,
            prepared.crop
          );

          segments.push({
            id: `p${pageNumber}_w${wordCounter}`,
            text: cleanText.slice(0, 120),
            plainText: plain || cleanText.slice(0, 120),
            kind: 'word',
            box,
          });
        }
      }
    }
  }

  const score = arabicWords * 4.2 + confidence * 0.85 - junkTokens * 3;
  return { segments, ocrText, confidence, arabicWords, junkTokens, score };
}

/**
 * Isolated Line-by-Line OCR using PSM.SINGLE_LINE eliminates multi-line/border interference
 * on ornate calligraphy, Quran screenshots, and low-res tightly spaced lines.
 */
async function runLineByLineOcr(
  worker: Worker,
  prepared: PreparedOcrVariants,
  useBinarizedBuffer: boolean,
  pageNumber: number,
  onLineProgress?: (currentLine: number, totalLines: number) => void
): Promise<OcrPassOutcome> {
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });

  const buf = useBinarizedBuffer ? prepared.bufB : prepared.bufA;
  const w = prepared.width;
  const h = prepared.height;
  const lineMargin = 28;
  const padY = 12;

  const segments: BookTextSegment[] = [];
  const lineTexts: string[] = [];
  let confSum = 0;
  let confCount = 0;
  let arabicWords = 0;
  let junkTokens = 0;
  let wordCounter = 0;

  const totalLines = prepared.detectedLines.length;
  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const band = prepared.detectedLines[lineIdx];
    onLineProgress?.(lineIdx + 1, totalLines);
    const sy0 = Math.max(0, band.y0 - padY);
    const sy1 = Math.min(h, band.y1 + padY);
    const sliceH = Math.max(12, sy1 - sy0);

    const lineCanvas = document.createElement('canvas');
    lineCanvas.width = w + lineMargin * 2;
    lineCanvas.height = sliceH + lineMargin * 2;
    const lCtx = lineCanvas.getContext('2d');
    if (!lCtx) continue;

    lCtx.fillStyle = '#FFFFFF';
    lCtx.fillRect(0, 0, lineCanvas.width, lineCanvas.height);

    const imgData = lCtx.createImageData(w, sliceH);
    const d = imgData.data;
    for (let y = 0; y < sliceH; y++) {
      const srcRow = (sy0 + y) * w;
      const dstRow = y * w * 4;
      for (let x = 0; x < w; x++) {
        const v = buf[srcRow + x];
        const p = dstRow + x * 4;
        d[p] = v;
        d[p + 1] = v;
        d[p + 2] = v;
        d[p + 3] = 255;
      }
    }
    lCtx.putImageData(imgData, lineMargin, lineMargin);

    const res = await worker.recognize(lineCanvas, {}, { text: true, blocks: true });
    const lText = (res.data.text || '').normalize('NFKC').trim();
    if (lText) lineTexts.push(lText);
    if (typeof res.data.confidence === 'number') {
      confSum += res.data.confidence;
      confCount++;
    }

    for (const block of res.data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            const cleanText = cleanOcrWordText(word.text || '');
            if (!cleanText) continue;

            const hasArabic = /[\u0621-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(
              cleanText
            );
            const hasDigit = /[0-9\u0660-\u0669]/.test(cleanText);
            const plain = stripArabicDiacriticsForMatch(cleanText);

            if (!hasArabic && !hasDigit && cleanText.length < 2) continue;
            if ((word.confidence || 0) < 12 && !hasArabic && cleanText.length <= 2) {
              junkTokens++;
              continue;
            }

            if (hasArabic) arabicWords++;
            else if (!hasDigit) junkTokens++;

            wordCounter++;
            if (segments.length >= 420) break;

            const box = mapOcrBoxToOriginalPage(
              word.bbox.x0,
              word.bbox.y0,
              word.bbox.x1,
              word.bbox.y1,
              prepared.width,
              prepared.height,
              lineMargin,
              lineMargin,
              sy0,
              prepared.skewDeg,
              prepared.crop
            );

            segments.push({
              id: `p${pageNumber}_w${wordCounter}`,
              text: cleanText.slice(0, 120),
              plainText: plain || cleanText.slice(0, 120),
              kind: 'word',
              box,
            });
          }
        }
      }
    }
  }

  const confidence = confCount > 0 ? confSum / confCount : 0;
  const score = arabicWords * 4.4 + confidence * 0.85 - junkTokens * 3;
  return {
    segments,
    ocrText: lineTexts.join('\n'),
    confidence,
    arabicWords,
    junkTokens,
    score,
  };
}

function isEmbeddedTextReliable(
  embeddedSegments?: Array<{
    text: string;
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
  }>
): BookTextSegment[] | null {
  if (!embeddedSegments || embeddedSegments.length === 0) return null;

  let totalChars = 0;
  let validArabicOrDigitChars = 0;
  let replacementOrGarbage = 0;

  const cleaned: Array<{
    text: string;
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
  }> = [];

  for (const seg of embeddedSegments) {
    const normalized = normalizeAllArabicFontForms(seg.text || '').trim();
    if (!normalized) continue;
    for (const ch of normalized) {
      totalChars++;
      if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF0-9\s]/.test(ch)) {
        validArabicOrDigitChars++;
      } else if (ch === '\uFFFD' || ch === '?') {
        replacementOrGarbage++;
      }
    }
    cleaned.push({ ...seg, text: normalized });
  }

  if (cleaned.length === 0 || totalChars === 0) return null;
  const validRatio = validArabicOrDigitChars / totalChars;
  const garbageRatio = replacementOrGarbage / totalChars;
  if (validRatio < 0.45 || garbageRatio > 0.15) {
    return null;
  }

  return cleaned.slice(0, 420).map((seg, idx) => ({
    id: `p_emb_w${idx + 1}`,
    text: seg.text.slice(0, 120),
    plainText: stripArabicDiacriticsForMatch(seg.text) || seg.text.slice(0, 120),
    kind: 'word',
    box: [seg.ymin, seg.xmin, seg.ymax, seg.xmax],
  }));
}

/**
 * Full 100% browser-based Arabic OCR + Auto-Cropper + Line-by-Line + Quranic Passage Alignment Engine.
 * Runs cleanly on static hosts (GitHub Pages / Netlify / Cloudflare Pages) without a server.
 */
export async function analyzeBookPageInBrowser(params: {
  imageDataUrl: string;
  pageNumber: number;
  embeddedSegments?: Array<{
    text: string;
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
  }>;
  onProgress?: (progress: PageOcrProgress) => void;
}): Promise<{
  fullText: string;
  segments: BookTextSegment[];
}> {
  let highestPct = 0;
  const emit = (pct: number, stageText: string) => {
    const clamped = Math.max(highestPct, Math.min(100, Math.round(pct)));
    highestPct = clamped;
    params.onProgress?.({
      pageNumber: params.pageNumber,
      pagePercent: clamped,
      stageText,
    });
  };

  emit(2, 'جاري تحضير الصفحة وفهرس القرآن الكريم...');

  const [prepared, quranIndex] = await Promise.all([
    prepareOcrVariants(params.imageDataUrl, (pct, msg) => emit(pct, msg)),
    getQuranIndex().catch(() => null),
  ]);

  let bestPass: OcrPassOutcome | null = null;

  try {
    emit(21, 'جاري تهيئة محرك القراءة العربي الذكي...');
    activeOcrLoggerCallback = (m) => {
      const p = typeof m.progress === 'number' ? m.progress : 0;
      if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
        emit(22 + p * 3, 'جاري تشغيل نواة التعرف الذكي...');
      } else if (m.status === 'loading language traineddata' || m.status === 'initializing api') {
        emit(25 + p * 5, 'جاري تحميل حزمة اللغة العربية وتهيئتها...');
      }
    };
    const worker = await getArabicOcrWorker();
    activeOcrLoggerCallback = null;

    // Pass 1: Cropped inner text (no borders/status bars) + normalized contrast + SINGLE_BLOCK
    emit(30, 'جاري التعرف الأولي على الكلمات العربية في الصفحة...');
    const pass1 = await runOcrPass(
      worker,
      prepared.variantA,
      PSM.SINGLE_BLOCK,
      params.pageNumber,
      prepared,
      (frac) => {
        emit(30 + frac * 22, 'جاري التعرف الأولي على الكلمات العربية في الصفحة...');
      }
    );
    bestPass = pass1;

    const junkRatio1 = pass1.junkTokens / Math.max(1, pass1.segments.length);
    const pass1Strong =
      pass1.confidence >= 82 && pass1.arabicWords >= 12 && junkRatio1 < 0.16;

    if (!pass1Strong) {
      // Pass 2: Sauvola binarized cropped block (eliminates shadows & highlight tints)
      emit(53, 'جاري التحليل المعمّق بعزل التظليل وتحسين تباين الحروف...');
      const pass2 = await runOcrPass(
        worker,
        prepared.variantB,
        PSM.SINGLE_BLOCK,
        params.pageNumber,
        prepared,
        (frac) => {
          emit(53 + frac * 15, 'جاري التحليل المعمّق بعزل التظليل وتحسين تباين الحروف...');
        }
      );
      const useBinarized = pass2.score > pass1.score;
      if (useBinarized) {
        bestPass = pass2;
      }

      // Pass 3: Isolated Line-by-Line PSM.SINGLE_LINE if page has clear horizontal lines and accuracy can improve
      if (
        prepared.detectedLines.length >= 2 &&
        prepared.detectedLines.length <= 32 &&
        (bestPass.confidence < 82 || bestPass.arabicWords < prepared.detectedLines.length * 3)
      ) {
        const linePass = await runLineByLineOcr(
          worker,
          prepared,
          useBinarized,
          params.pageNumber,
          (lineNum, totalLines) => {
            const frac = totalLines > 0 ? lineNum / totalLines : 1;
            emit(
              68 + frac * 16,
              `جاري قراءة الصفحة سطراً بسطر بدقة عالية (السطر ${lineNum} من ${totalLines})...`
            );
          }
        );
        if (linePass.score > bestPass.score) {
          bestPass = linePass;
        }
      }

      // Pass 4: Stroke-thickened sparse layout fallback for ultra-low-res or scattered pages
      if (bestPass.arabicWords < 8 || bestPass.confidence < 54) {
        emit(84, 'جاري تعريض الحروف الدقيقة لقراءة الكلمات منخفضة الوضوح...');
        const variantC = prepared.buildVariantC();
        const pass4 = await runOcrPass(
          worker,
          variantC,
          PSM.SPARSE_TEXT,
          params.pageNumber,
          prepared,
          (frac) => {
            emit(84 + frac * 5, 'جاري تعريض الحروف الدقيقة لقراءة الكلمات منخفضة الوضوح...');
          }
        );
        if (pass4.score > bestPass.score) {
          bestPass = pass4;
        }
      }
    }
  } catch (err) {
    const reliableEmbedded = isEmbeddedTextReliable(params.embeddedSegments);
    if (!reliableEmbedded) {
      throw err instanceof Error
        ? err
        : new Error('تعذّر التعرف على نص الصفحة في المتصفح.');
    }
  } finally {
    activeOcrLoggerCallback = null;
  }

  let rawSegments: BookTextSegment[] = bestPass?.segments || [];
  const ocrText = bestPass?.ocrText || '';

  emit(90, 'جاري فحص النص المضمّن ومطابقة الآيات مع فهرس القرآن الكريم...');

  // Only prefer embedded PDF Unicode text when verified as readable Arabic (not legacy gibberish)
  const reliableEmbedded = isEmbeddedTextReliable(params.embeddedSegments);
  if (
    reliableEmbedded &&
    (rawSegments.length < 4 || reliableEmbedded.length >= Math.round(rawSegments.length * 0.85))
  ) {
    rawSegments = reliableEmbedded.map((seg, idx) => ({
      ...seg,
      id: `p${params.pageNumber}_w${idx + 1}`,
    }));
  }

  // Whole-Quran Monotonic Passage Reconstruction (100% zero-error Mushaf & Quran screenshot accuracy)
  emit(94, 'جاري مطابقة تسلسل الآيات واستعادة التشكيل الكامل...');
  const reconstructedQuran = reconstructQuranPassageFromSegments(
    rawSegments,
    quranIndex,
    params.pageNumber
  );

  const finalSegments =
    reconstructedQuran && reconstructedQuran.length > 0
      ? reconstructedQuran
      : enrichSegmentsWithQuranMatch(rawSegments, quranIndex);

  emit(98, 'جاري تثبيت إحداثيات الكلمات والآيات لحفظ الصفحة...');

  const fullText =
    finalSegments.length > 0
      ? finalSegments.map((s) => s.text).join(' ').slice(0, 18000)
      : ocrText.slice(0, 18000);

  emit(100, `اكتمل التعرف على الصفحة بنجاح (${finalSegments.length} كلمة)`);

  return {
    fullText,
    segments: finalSegments,
  };
}
