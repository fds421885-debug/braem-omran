import { GoogleGenAI, MediaResolution, ThinkingLevel, Type } from '@google/genai';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DIST_DIR = path.resolve(__dirname, 'dist');
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
const IS_RENDER =
  process.env.RENDER === 'true' ||
  Boolean(process.env.RENDER_EXTERNAL_URL) ||
  Boolean(process.env.RENDER_SERVICE_ID);
const IS_PROD =
  process.env.NODE_ENV === 'production' ||
  IS_RENDER ||
  (fs.existsSync(DIST_INDEX) &&
    process.env.DISABLE_HMR !== 'true' &&
    process.env.NODE_ENV !== 'development');

function cleanEnvSecret(raw?: string): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

function getConfiguredGeminiKey(customApiKey?: string): string {
  const custom = cleanEnvSecret(customApiKey);
  if (custom) return custom;
  return (
    cleanEnvSecret(process.env.GEMINI_API_KEY) ||
    cleanEnvSecret(process.env.GOOGLE_API_KEY) ||
    cleanEnvSecret(process.env.API_KEY)
  );
}

function isAiStudioManagedModel(modelName: string): boolean {
  return (
    modelName === 'gemini-4-hydrogen' ||
    modelName === 'gemini-3.1-flash-lite' ||
    modelName === 'gemini-3.8-flash-lite-tts'
  );
}

function shouldPreferPublicGeminiModels(customApiKey?: string): boolean {
  const cleanedCustom = cleanEnvSecret(customApiKey);
  if (IS_RENDER) return true;
  if (cleanedCustom && !process.env.DISABLE_HMR) return true;
  return false;
}

function buildOrderedModels(
  aiStudioModels: string[],
  publicModels: string[],
  preferPublic: boolean
): string[] {
  return preferPublic ? [...publicModels, ...aiStudioModels] : [...aiStudioModels, ...publicModels];
}

function isModelRetryableOrFallbackError(err: unknown): boolean {
  const errObj = err as { status?: number; code?: number; message?: string };
  const statusCode = Number(errObj?.status || errObj?.code || 0);
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (statusCode === 404 || lower.includes('not_found') || lower.includes('not found')) {
    return true;
  }
  // Invalid model/thinking argument for a specific model variant (e.g. 400 INVALID_ARGUMENT), not API_KEY_INVALID
  if (
    statusCode === 400 &&
    !lower.includes('api_key_invalid') &&
    !lower.includes('api key not valid')
  ) {
    return true;
  }
  if (statusCode === 429 || statusCode === 500 || statusCode === 503 || statusCode === 504) {
    return true;
  }
  if (
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('resource_exhausted') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('no longer available')
  ) {
    return true;
  }
  return false;
}

function getGeminiClient(customApiKey?: string): GoogleGenAI {
  const apiKey = getConfiguredGeminiKey(customApiKey);
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function normalizeUthmaniForTts(input: string): string {
  if (!input) return '';
  let out = input
    // Canonicalize Shadda BEFORE vowel/tanween/sukoon
    .replace(/([\u064B-\u0650\u0652\u06E1])(\u0651)/g, '$2$1')
    // Uthmani sukoon -> standard sukoon
    .replace(/\u06E1/g, '\u0652')
    // Hamzat Wasl Alif -> standard Alif
    .replace(/\u0671/g, 'ا')
    // Alif seated on Waw (الصَّلَوٰةِ، الزَّكَوٰةَ، الْحَيَوٰةِ) -> standard Alif madd
    .replace(/و\u0670/g, 'ا')
    // Dagger Alif on Alif Maqsura (مُوسَىٰ، عَلَىٰ، إِلَىٰ) -> standard Alif madd
    .replace(/ى\u0670/g, 'ا')
    // Dagger Alif on consonant -> fatha + Alif madd
    .replace(/([\u0621-\u064A]\u0651?\u064E?)\u0670/g, '$1ا')
    .replace(/\u0670/g, 'ا')
    // Small Waw / Small Ya (Madd Silah)
    .replace(/\u06E5/g, 'و')
    .replace(/\u06E6/g, 'ي')
    // Strip silent circle / pause / Uthmani annotations
    .replace(/[\u06DF\u06E0\u0653\u06D6-\u06DC\u06DD\u06DE\u06E2-\u06E4\u06E7-\u06ED]/g, '');
  out = out.replace(/([\u064B-\u0650\u0652])(\u0651)/g, '$2$1');
  return out.replace(/\s+/g, ' ').trim();
}

function isTransientRateOrLoadError(err: unknown): boolean {
  const errObj = err as { status?: number; code?: number; message?: string };
  const statusCode = Number(errObj?.status || errObj?.code || 0);
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    statusCode === 429 ||
    statusCode === 503 ||
    statusCode === 504 ||
    lower.includes('resource_exhausted') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('timeout') ||
    lower.includes('429')
  );
}

function getFriendlyGeminiError(err: unknown): { status: number; message: string } {
  const errObj = err as { status?: number; code?: number; message?: string };
  const statusCode = Number(errObj?.status || errObj?.code || 0);
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    statusCode === 429 ||
    statusCode === 503 ||
    statusCode === 404 ||
    lower.includes('resource_exhausted') ||
    lower.includes('429') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('timeout')
  ) {
    console.warn('[Gemini API Notice]', { statusCode, message: raw.slice(0, 320) });
  } else {
    console.error('[Gemini API Error]', { statusCode, message: raw.slice(0, 500) });
  }

  if (lower.includes('gemini_api_key')) {
    return {
      status: 500,
      message:
        'مفتاح الذكاء الاصطناعي غير مضبوط على الخادم (أضف GEMINI_API_KEY في متغيرات البيئة على Render ثم أعد النشر).',
    };
  }
  if (lower.includes('timeout')) {
    return {
      status: 504,
      message: 'استغرق الاتصال بمحرك الذكاء الاصطناعي وقتاً أطول من المعتاد؛ يرجى إعادة المحاولة.',
    };
  }
  if (
    statusCode === 400 &&
    (lower.includes('api_key_invalid') || lower.includes('api key not valid'))
  ) {
    return {
      status: 400,
      message: 'مفتاح Gemini API غير صالح أو يفتقد الإعداد المطلوب.',
    };
  }
  if (statusCode === 400) {
    return {
      status: 400,
      message: 'تعذّر قبول الطلب من واجهة Gemini API؛ تأكد من صحة المفتاح وصلاحياته.',
    };
  }
  if (statusCode === 403 || lower.includes('permission_denied') || lower.includes('403')) {
    return {
      status: 403,
      message:
        'تم رفض الصلاحية لمفتاح Gemini API؛ يرجى مراجعة المفتاح أو تفعيل خدمة Generative Language API.',
    };
  }
  if (statusCode === 404 || lower.includes('not_found')) {
    return {
      status: 404,
      message: 'النموذج المطلوب غير متاح حالياً في حساب هذا المفتاح.',
    };
  }
  if (statusCode === 429 || lower.includes('resource_exhausted') || lower.includes('429')) {
    return {
      status: 429,
      message: 'تم الوصول للحد المؤقت من الطلبات، انتظر لحظات ثم أعد المحاولة.',
    };
  }
  if (
    statusCode === 503 ||
    lower.includes('unavailable') ||
    lower.includes('high demand')
  ) {
    return {
      status: 503,
      message: 'خوادم الذكاء الاصطناعي تشهد ضغطاً مؤقتاً الآن؛ يرجى إعادة المحاولة بعد ثوانٍ.',
    };
  }
  return {
    status: 500,
    message: 'تعذّر إتمام المعالجة الذكية حالياً، يرجى المحاولة مرة أخرى.',
  };
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const errObj = err as { status?: number; code?: number };
      const statusCode = Number(errObj?.status || errObj?.code || 0);
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      // Never tight-loop retry 429 RESOURCE_EXHAUSTED — immediate fallback/cooldown prevents quota spiral
      const isRateLimited =
        statusCode === 429 || msg.includes('429') || msg.includes('resource_exhausted');
      const retryable =
        !isRateLimited &&
        (statusCode === 503 ||
          statusCode === 500 ||
          msg.includes('503') ||
          msg.includes('500') ||
          msg.includes('unavailable') ||
          msg.includes('high demand') ||
          msg.includes('timeout') ||
          msg.includes('network'));
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 450 * attempt));
    }
  }
  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

function ensureWavBase64(rawBase64: string, rawMimeType?: string): {
  base64Wav: string;
  mimeType: string;
} {
  const buf = Buffer.from(rawBase64, 'base64');
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46
  ) {
    return { base64Wav: rawBase64, mimeType: 'audio/wav' };
  }

  // Gemini TTS often returns raw signed 16-bit LE PCM (e.g., audio/L16;codec=pcm;rate=24000).
  // Wrap it in a standard 44-byte RIFF/WAVE header so browser <audio> decodes immediately.
  if (
    !rawMimeType ||
    rawMimeType.toLowerCase().includes('pcm') ||
    rawMimeType.toLowerCase().includes('l16') ||
    rawMimeType.toLowerCase().includes('wav')
  ) {
    const rateMatch = rawMimeType?.match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? Math.max(8000, Math.min(48000, Number(rateMatch[1]))) : 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = buf.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return {
      base64Wav: Buffer.concat([header, buf]).toString('base64'),
      mimeType: 'audio/wav',
    };
  }

  return {
    base64Wav: rawBase64,
    mimeType: rawMimeType,
  };
}

function stripTashkeel(input: string): string {
  return input
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

interface RawAnalyzedSegment {
  text?: string;
  kind?: string;
  ymin?: number;
  xmin?: number;
  ymax?: number;
  xmax?: number;
  surahNumber?: number;
  ayahNumber?: number;
  surahName?: string;
}

interface RawPageAnalysisResponse {
  fullText?: string;
  segments?: RawAnalyzedSegment[];
}

interface RawNoorResponse {
  diacritizedWord?: string;
  wasAutoDiacritized?: boolean;
  tahajjiScript?: string;
  steps?: Array<{
    part?: string;
    ruleLabel?: string;
    reading?: string;
  }>;
}

const noorAlBayanServerCache = new Map<
  string,
  {
    diacritizedWord: string;
    wasAutoDiacritized: boolean;
    tahajjiScript: string;
    fullReading: string;
    steps: Array<{ part: string; ruleLabel: string; reading: string }>;
  }
>();

const ttsAudioServerCache = new Map<string, string>();
const ttsInFlightCache = new Map<string, Promise<{ audioBase64: string; mimeType: string }>>();
let ttsRateLimitUntilMs = 0;
let ttsQueueTail: Promise<void> = Promise.resolve();
let lastTtsDispatchAtMs = 0;

function enqueueTtsRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = ttsQueueTail.then(async () => {
    const gapMs = Date.now() - lastTtsDispatchAtMs;
    if (gapMs < 240) {
      await new Promise((r) => setTimeout(r, 240 - gapMs));
    }
    lastTtsDispatchAtMs = Date.now();
    return task();
  });
  ttsQueueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function setLruCache<K, V>(cache: Map<K, V>, key: K, val: V, maxSize = 250): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, val);
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      runtime: IS_RENDER ? 'render' : 'node',
      isProd: IS_PROD,
      hasGeminiKey: Boolean(getConfiguredGeminiKey()),
      nodeVersion: process.version,
    });
  });

  // 1. Analyze an uploaded book page image (OCR with full Arabic Tashkeel + Bounding Boxes + Quran Ayah detection)
  app.post('/api/books/analyze-page', async (req: Request, res: Response) => {
    try {
      const { imageBase64, imageDataUrl, mimeType, pageNumber, bookTitle } = req.body as {
        imageBase64?: string;
        imageDataUrl?: string;
        mimeType?: string;
        pageNumber?: number;
        bookTitle?: string;
      };

      const rawImageInput = imageBase64 || imageDataUrl;
      if (!rawImageInput || typeof rawImageInput !== 'string') {
        res.status(400).json({ error: 'صورة الصفحة مطلوبة للتحليل.' });
        return;
      }

      let detectedMimeType = mimeType || 'image/jpeg';
      if (rawImageInput.startsWith('data:')) {
        const headerMatch = rawImageInput.match(/^data:([^;]+);base64,/i);
        if (headerMatch?.[1]) {
          detectedMimeType = headerMatch[1];
        }
      }

      const cleanBase64 = rawImageInput.includes(',')
        ? rawImageInput.split(',')[1] || ''
        : rawImageInput;

      const ai = getGeminiClient();

      const promptText = `أنت خبير متخصص في الرقمنة القرآنية والتعليمية واللغة العربية وضبط الحركات (التشكيل) ومنهج نور البيان.
قم بتحليل صورة صفحة الكتاب العربي التالية (عنوان الكتاب: "${bookTitle || 'كتاب تعليمي'}", صفحة رقم ${pageNumber || 1}) بدقة فائقة:

المطلوب استخراج JSON منظم يحتوي على:
1. "fullText": النص العربي الكامل في الصفحة مرتباً من اليمين إلى اليسار ومن الأعلى إلى الأسفل مضبوطاً بالشكل الكامل (الفتحة، الضمة، الكسرة، السكون، الشدة، التنوين، علامات المد) كما في الصفحة تماماً.
2. "segments": مصفوفة تغطي **كل كلمة** ظاهرة في الصفحة بالترتيب الصحيح للقراءة (من اليمين لليسار سطراً بسطر، بحد أقصى 400 كلمة):
   - "text": الكلمة نفسها مضبوطة بالحركات الكاملة والتشكيل الدقيق.
   - "kind": ضع "ayah" إذا كانت هذه الكلمة جزءاً من آية قرآنية من المصحف الشريف في الصفحة، وإلا ضع "word".
   - "ymin", "xmin", "ymax", "xmax": الإحداثيات النسبية الدقيقة لموقع هذه الكلمة داخل الصورة من 0 إلى 1000 (حيث 0 أعلى/يسار الصورة و 1000 أسفل/يمين الصورة). احرص أن يحيط المستطيل بالكلمة بدقة تامة.
   - إذا كانت "kind" تساوي "ayah": حدد بدقة "surahNumber" (رقم السورة 1-114)، و"ayahNumber" (رقم الآية التي تنتمي إليها هذه الكلمة)، و"surahName" (اسم السورة بالعربية مثل الفاتحة، البقرة، الإخلاص).

ملاحظات حاسمة:
- تعرّف بدقة على النص العربي بمختلف الخطوط العربية (النسخ، الرقعة، الثلث، الديواني، الكوفي، الخط المغربي، والخط العثماني للمصحف)، وأخرج النص بصيغة عربية قياسية واضحة ومشكولة بالكامل.
- تجاهل تماماً شريط الحالة العلوي للهاتف (الساعة، البطارية، اسم الشبكة مثل salam mobile)، وأزرار التطبيقات الجانبية العائمة أو أشرطة الأدوات، والزخارف الجانبية للمصحف.
- اقرأ النص بوضوح تام حتى لو كان داخل لقطة شاشة ذات خلفية مظللة (مثل التظليل الأزرق الفاتح أو الأصفر على الآيات) أو بخط المصحف العثماني الدقيق أو بدقة منخفضة.
- لا تتجاهل أي كلمة عربية أو قرآنية واضحة في متن الصفحة.
- تأكد من صحة الحركات (تشكيل كل حرف) وعدم إسقاطها.
- تأكد أن 0 <= ymin < ymax <= 1000 و 0 <= xmin < xmax <= 1000 لكل كلمة.`;

      const runAnalyzeModel = async (
        modelName: string,
        timeoutMs: number,
        useMediaRes = true
      ) =>
        await withTimeout(
          withRetry(() =>
            ai.models.generateContent({
              model: modelName,
              contents: {
                parts: [
                  {
                    inlineData: {
                      mimeType: detectedMimeType,
                      data: cleanBase64,
                    },
                  },
                  { text: promptText },
                ],
              },
              config: {
                ...(useMediaRes && isAiStudioManagedModel(modelName)
                  ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH }
                  : {}),
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    fullText: {
                      type: Type.STRING,
                      description: 'Complete diacritized Arabic text of the page.',
                    },
                    segments: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          text: { type: Type.STRING },
                          kind: { type: Type.STRING },
                          ymin: { type: Type.INTEGER },
                          xmin: { type: Type.INTEGER },
                          ymax: { type: Type.INTEGER },
                          xmax: { type: Type.INTEGER },
                          surahNumber: { type: Type.INTEGER },
                          ayahNumber: { type: Type.INTEGER },
                          surahName: { type: Type.STRING },
                        },
                        required: ['text', 'kind', 'ymin', 'xmin', 'ymax', 'xmax'],
                      },
                    },
                  },
                  required: ['fullText', 'segments'],
                },
              },
            })
          ),
          timeoutMs
        );

      const analyzeCandidates = buildOrderedModels(
        ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
        ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
        shouldPreferPublicGeminiModels()
      );
      let result;
      let lastAnalyzeErr: unknown;
      for (const candidateModel of analyzeCandidates) {
        try {
          result = await runAnalyzeModel(candidateModel, 20000);
          break;
        } catch (err) {
          lastAnalyzeErr = err;
          if (!isModelRetryableOrFallbackError(err)) {
            throw err;
          }
        }
      }
      if (!result) {
        throw lastAnalyzeErr || new Error('No vision model succeeded.');
      }

      const rawJson = (result.text ?? '{}')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(rawJson || '{}') as RawPageAnalysisResponse;

      const normalizedSegments = (parsed.segments || [])
        .filter((seg) => seg && typeof seg.text === 'string' && seg.text.trim().length > 0)
        .slice(0, 420)
        .map((seg, idx) => {
          const text = String(seg.text || '').trim().slice(0, 120);
          const ymin = Math.max(0, Math.min(995, Math.round(Number(seg.ymin) || 0)));
          const xmin = Math.max(0, Math.min(995, Math.round(Number(seg.xmin) || 0)));
          const ymax = Math.max(ymin + 5, Math.min(1000, Math.round(Number(seg.ymax) || ymin + 40)));
          const xmax = Math.max(xmin + 5, Math.min(1000, Math.round(Number(seg.xmax) || xmin + 60)));
          const isAyah =
            seg.kind === 'ayah' &&
            Number(seg.surahNumber) >= 1 &&
            Number(seg.surahNumber) <= 114 &&
            Number(seg.ayahNumber) >= 1;

          return {
            id: `p${pageNumber || 1}_w${idx + 1}`,
            text,
            plainText: stripTashkeel(text),
            kind: (isAyah ? 'ayah' : 'word') as 'ayah' | 'word',
            box: [ymin, xmin, ymax, xmax] as [number, number, number, number],
            ...(isAyah
              ? {
                  surahNumber: Math.round(Number(seg.surahNumber)),
                  ayahNumber: Math.round(Number(seg.ayahNumber)),
                  surahName: String(seg.surahName || '').trim().slice(0, 60),
                }
              : {}),
          };
        });

      res.json({
        fullText: String(parsed.fullText || normalizedSegments.map((s) => s.text).join(' '))
          .trim()
          .slice(0, 18000),
        segments: normalizedSegments,
      });
    } catch (err) {
      const friendly = getFriendlyGeminiError(err);
      res.status(friendly.status).json({ error: friendly.message });
    }
  });

  // 2. Generate authentic Al-Fath Al-Rabbani (أكاديمية الفتح العالمية بعرب القرآن) Tajweed-integrated Tahajji
  app.post('/api/books/noor-albayan', async (req: Request, res: Response) => {
    try {
      const { text, surahName, nextWord, isEndOfAyah } = req.body as {
        text?: string;
        surahName?: string;
        nextWord?: string;
        isEndOfAyah?: boolean;
      };
      const target = String(text || '').trim().slice(0, 400);
      if (!target) {
        res.status(400).json({ error: 'النص مطلوب لإنشاء التهجي.' });
        return;
      }

      const cleanNextWord = String(nextWord || '').trim().slice(0, 80);
      const cacheKey = `fath_v4:${target}|${cleanNextWord}|${isEndOfAyah ? '1' : '0'}`;
      const cachedNoor = noorAlBayanServerCache.get(cacheKey);
      if (cachedNoor) {
        res.json(cachedNoor);
        return;
      }

      const contextNotes: string[] = [];
      if (surahName) contextNotes.push(`السورة: ${String(surahName).trim().slice(0, 80)}`);
      if (cleanNextWord) contextNotes.push(`الكلمة التالية مباشرة في الوصل: "${cleanNextWord}"`);
      if (typeof isEndOfAyah === 'boolean') {
        contextNotes.push(
          isEndOfAyah
            ? 'موقع الكلمة: في نهاية الآية / موضع وقف (طبّق المد العارض للسكون أو مد اللين العارض للسكون والحرف الأخير ساكن عند الوقف إن وُجد حرف مد أو لين قبل الأخير، ما لم يكن المد متصلاً أو لازماً فيُقدّم حكمه).'
            : 'موقع الكلمة: وسط الجملة أو الآية (لا تجعل آخرها موضع وقف عارض للسكون ما لم يطلب النص).'
        );
      }
      const contextBlock =
        contextNotes.length > 0 ? `\nسياق القراءة:\n- ${contextNotes.join('\n- ')}\n` : '';

      const ai = getGeminiClient();
      const prompt = `أنت معلم متقن لمنهج "الفتح الرباني" (طريقة أكاديمية الفتح العالمية بعرب القرآن) في تعليم القراءة العربية وتهجي القرآن الكريم بأحكام التجويد.
حلّل النص التالي بالتهجي التفصيلي حسب منهج الفتح الرباني:
النص: "${target}"${contextBlock}

قواعد منهج الفتح الرباني الإلزامية (طبقها بدقة على أي كلمة أو آية عربية أو قرآنية):
1. الحركات القصيرة (فتحة، ضمة، كسرة): تُنطق بالصوت المباشر فوراً دون ذكر اسم الحرف أو اسم الحركة (مثال: "بِ" وليس "باء كسرة: بِ"، ثم "سِينْ سَاكِنَة: بِسْ، مِ: بِسْمِ"). يُمنع تماماً قول "باء فتحة" أو "كاف ضمة" أو "ميم كسرة".
2. اسم الجلالة (الله / لِلَّهِ / بِاللَّهِ / وَاللَّهِ): لا تُتهجّى حروفه مفردةً تعظيماً، بل: "اسْمُ الْجَلَالَةِ: اللَّهُ" (وإذا سبقه حرف مثل "لِلَّهِ": "لِ، اسْمُ الْجَلَالَةِ: لِلَّهِ").
3. همزة الوصل:
   - في بداية النطق: "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا نَبْدَأُ بِهَا أَ" (أو إِ / أُ حسب القاعدة).
   - إذا سبقها حرف أو كلمة: "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا".
4. اللام القمرية والشمسية:
   - القمرية: "لَامْ قَمَرِيَّةٌ مُظْهَرَةٌ: أَلْ" (أو التجميع مع ما قبلها مثل "وَالْ").
   - الشمسية: "لَامْ شَمْسِيَّةٌ مُدْغَمَةٌ فِي <اسم الحرف مجروراً بأل وصفته مثل الرَّاءِ الْمَفْتُوحَةِ / الصَّادِ الْمَكْسُورَةِ / الضَّادِ الْمَفْتُوحَةِ>" (وأضف "مَعَ الْغُنَّةِ حَرَكَتَانْ" للنون والميم)، ثم التجميع مثل "الرَّ".
5. الحرف المشدد: "<اسم الحرف> شَدَّة وَ<فتحة/ضمة/كسرة/تنوين>: <التجميع مضبوطاً بالشدة والحركة مثل رَبِّ>"، وإذا كان نوناً أو ميماً مشددةً أضف "مَعَ الْغُنَّةِ حَرَكَتَانْ".
6. السكون وأحكام النون والميم الساكنتين والقلقلة:
   - نون ساكنة بعدها حرف حلق (ء هـ ع ح غ خ) في مثل "أَنْعَمْتَ": "نُونْ سَاكِنَة مُظْهَرَة قَبْلَ الْعَيْنِ الْمَفْتُوحَةِ: أَنْعَ" (وإن جاءت بين كلمتين مثل "مِنْ خَوْفٍ": "نُونْ سَاكِنَة مُظْهَرَة قَبْلَ الْخَاءِ").
   - نون ساكنة إخفاء حقيقي / إقلاب / إدغام بغنة أو بغير غنة حسب الحرف التالي داخل الكلمة أو أول الكلمة التالية.
   - ميم ساكنة مظهرة أو إخفاء شفوي (عند الباء) أو إدغام مثلين صغير (عند الميم).
   - قلقلة (ق ط ب ج د): "<اسم الحرف> سَاكِنَة مُقَلْقَلَة: <التجميع>" (مثال: "يَطْمَ": طَاءْ سَاكِنَة مُقَلْقَلَة: يَطْ).
   - غيرها: "<اسم الحرف> سَاكِنَة: <التجميع>".
7. الألف الخنجرية والألف المرسومة على الواو (وٰ) أو الياء (ىٰ):
   - انتبه بشدة للرسم العثماني: في نحو "الصَّلَوٰةِ، الزَّكَوٰةَ، الْحَيَوٰةِ، الرِّبَوٰا": الواو هنا كرسي رسم للألف الخنجرية ولا تُنطق واواً أبداً! بل يُتهجّى الحرف الذي قبلها مفتوحاً ثم الألف مباشرة: مثال "الصَّلَوٰةِ" -> "... لَ: الصَّلَ، أَلِفْ مَدّ طَبِيعِي حَرَكَتَانْ: الصَّلَا، تِ: الصَّلَاةِ".
   - في نحو "مُوسَىٰ، عَلَىٰ، إِلَىٰ": الياء كرسي رسم لا تُنطق ياءً، بل: "أَلِفْ مَدّ طَبِيعِي حَرَكَتَانْ" (أو "يَسْقُطُ وَصْلًا" قبل همزة وصل نحو "عَلَى اللَّهِ").
   - واو الصلة وياء الصلة الصغيرة (ۥ / ۦ مثل بِهِۦ / دَاوُۥدَ): "وَاوْ صِلَة صُغْرَى حَرَكَتَانْ" أو "يَاءْ صِلَة صُغْرَى حَرَكَتَانْ" (وكبرى ٤ أو ٥ حركات قبل الهمزة).
   - ألف التفريق بعد واو الجماعة (مثل قَالُوا / آمَنُوا): واو المد "وَاوْ مَدّ طَبِيعِي حَرَكَتَانْ" ثم الألف الأخيرة "أَلِفْ صِفْرٌ مُسْتَدِيرٌ لَا يُنْطَقْ" ولا تجعل الواو مدّاً عارضاً للسكون!
8. المدود بأنواعها وترتيب الأولوية (الأقوى مقدَّم دائماً):
   - مد لازم (حرف مد وبعده حرف مشدد مثل "الضَّالِّينَ"): "أَلِفْ مَدّ لَازِمْ كَلِمِي مُثَقَّلْ سِتّ حَرَكَاتْ: الضَّا".
   - مد واجب متصل (حرف مد وبعده همزة في نفس الكلمة مثل "السَّمَاءُ" حتى لو كانت آخر الآية): "أَلِفْ مَدّ وَاجِبْ مُتَّصِلْ أَرْبَعْ أَوْ خَمْسْ حَرَكَاتْ (وَيُوصَلُ سِتًّا عِنْدَ الْوَقْفْ): السَّمَا".
   - مد جائز منفصل (٤ أو ٥ حركات مثل "إِنَّا أَعْطَيْنَاكَ").
   - مد بدل (همزة ممدودة مثل "آمَنُوا / إِيمَانًا / أُوتُوا"): "مَدّ بَدَلْ حَرَكَتَانْ".
   - مد يسقط وصلاً (التقاء ساكنين: إذا انتهت الكلمة بحرف مد والكلمة التالية تبدأ بهمزة وصل مثل "اهْدِنَا" قبل "الصِّرَاطَ"): "أَلِفْ مَدّ طَبِيعِي حَرَكَتَانْ يَسْقُطُ وَصْلًا: اهْدِنَا".
   - مد عارض للسكون في نهاية الآية أو الوقف: "<حرف المد> مَدّ عَارِض لِلسُّكُونْ اثْنَانْ أَوْ أَرْبَعْ أَوْ سِتّ حَرَكَاتْ، <اسم الحرف الأخير> سَاكِنَة عِنْدَ الْوَقْفْ: <الكلمة ساكنة الآخر مثل الرَّحِيمْ>".
   - مد اللين العارض للسكون (واو أو ياء ساكنة قبلها فتحة وقبل الحرف الأخير عند الوقف مثل "خَوْفٍ / قُرَيْشٍ / الْبَيْتِ"): "<وَاوْ/يَاءْ> مَدّ لِينْ عَارِض لِلسُّكُونْ اثْنَانْ أَوْ أَرْبَعْ أَوْ سِتّ حَرَكَاتْ، <اسم الحرف الأخير> سَاكِنَة عِنْدَ الْوَقْفْ".
9. ممنوع تماماً إنهاء التهجي بعبارة "الكلمة كاملةً: ..." لأن آخر خطوة تجميعية تنطق الكلمة كاملةً بالفعل.

أمثلة تطبيقية دقيقة لمنهج الفتح الرباني:
- "بِسْمِ": "بِ، سِينْ سَاكِنَة: بِسْ، مِ: بِسْمِ"
- "اللَّهِ": "اسْمُ الْجَلَالَةِ: اللَّهِ"
- "الرَّحْمَٰنِ": "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا نَبْدَأُ بِهَا أَ، لَامْ شَمْسِيَّةٌ مُدْغَمَةٌ فِي الرَّاءِ الْمَفْتُوحَةِ: الرَّ، حَاءْ سَاكِنَة: الرَّحْ، مَ: الرَّحْمَ، أَلِفْ مَدّ طَبِيعِي حَرَكَتَانْ: الرَّحْمَا، نِ: الرَّحْمَانِ"
- "الرَّحِيمِ" (وقفاً): "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا نَبْدَأُ بِهَا أَ، لَامْ شَمْسِيَّةٌ مُدْغَمَةٌ فِي الرَّاءِ الْمَفْتُوحَةِ: الرَّ، حِ: الرَّحِ، يَاءْ مَدّ عَارِض لِلسُّكُونْ اثْنَانْ أَوْ أَرْبَعْ أَوْ سِتّ حَرَكَاتْ، مِيمْ سَاكِنَة عِنْدَ الْوَقْفْ: الرَّحِيمْ"
- "الصَّلَوٰةِ": "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا نَبْدَأُ بِهَا أَ، لَامْ شَمْسِيَّةٌ مُدْغَمَةٌ فِي الصَّادِ الْمَفْتُوحَةِ: الصَّ، لَ: الصَّلَ، أَلِفْ مَدّ طَبِيعِي حَرَكَتَانْ: الصَّلَا، تِ: الصَّلَاةِ"
- "خَوْفٍ" (وقفاً): "خَ، وَاوْ مَدّ لِينْ عَارِض لِلسُّكُونْ اثْنَانْ أَوْ أَرْبَعْ أَوْ سِتّ حَرَكَاتْ، فَاءْ سَاكِنَة عِنْدَ الْوَقْفْ: خَوْفْ"
- "أَنْعَمْتَ": "أَ، نُونْ سَاكِنَة مُظْهَرَة قَبْلَ الْعَيْنِ الْمَفْتُوحَةِ: أَنْعَ، مِيمْ سَاكِنَة مُظْهَرَة: أَنْعَمْ، تَ: أَنْعَمْتَ"
- "اهْدِنَا" (قبل "الصِّرَاطَ"): "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا نَبْدَأُ بِهَا إِ، هَاءْ سَاكِنَة: اهْ، دِ: اهْدِ، نَ: اهْدِنَ، أَلِفْ مَدّ طَبِيعِي حَرَكَتَانْ يَسْقُطُ وَصْلًا: اهْدِنَا"
- "الضَّالِّينَ" (وقفاً): "هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا نَبْدَأُ بِهَا أَ، لَامْ شَمْسِيَّةٌ مُدْغَمَةٌ فِي الضَّادِ الْمَفْتُوحَةِ: الضَّ، أَلِفْ مَدّ لَازِمْ كَلِمِي مُثَقَّلْ سِتّ حَرَكَاتْ: الضَّا، لَامْ شَدَّة وَكَسْرَة: الضَّالِّ، يَاءْ مَدّ عَارِض لِلسُّكُونْ اثْنَانْ أَوْ أَرْبَعْ أَوْ سِتّ حَرَكَاتْ، نُونْ سَاكِنَة عِنْدَ الْوَقْفْ: الضَّالِّينْ"
- "وَالْعَصْرِ": "وَ، هَمْزَةُ وَصْلٍ تَسْقُطُ وَصْلًا، لَامْ قَمَرِيَّةٌ مُظْهَرَةٌ: وَالْ، عَ: وَالْعَ، صَادْ سَاكِنَة: وَالْعَصْ، رِ: وَالْعَصْرِ"

قاعدة مهمة للكلمات بدون حركات:
- إذا كان النص أو بعض كلماته بدون حركات أو ناقص الشكل: اضبطه أولاً بالتشكيل العربي الصحيح الكامل (بما في ذلك الشدات والسكون) وضع النتيجة في "diacritizedWord" واجعل "wasAutoDiacritized": true، وإلا فاجعل "wasAutoDiacritized": false.

أرجع JSON يتكون من:
1. "diacritizedWord": النص مضبوطاً بالشكل الكامل.
2. "wasAutoDiacritized": boolean
3. "tahajjiScript": نص التهجي المنطوق بالكامل حسب منهج الفتح الرباني مضبوطاً بالتشكيل الكامل مع الفواصل (،).
4. "steps": مصفوفة الخطوات البصرية:
   - "part": الحرف أو المقطع
   - "ruleLabel": اسم القاعدة التجويدية (فتحة، كسرة، ضمة، اسم الجلالة، همزة وصل تسقط وصلاً نبدأ بها أَ، لام قمرية مظهرة، لام شمسية مدغمة في الراء المفتوحة، نون ساكنة مظهرة قبل العين المفتوحة، ألف مد طبيعي حركتان، ألف مد لازم ٦ حركات، ياء مد عارض للسكون...)
   - "reading": التجميع التراكمي حتى هذه الخطوة بالحركات الكاملة.`;

      const runNoorModel = async (modelName: string, timeoutMs: number) =>
        await withTimeout(
          withRetry(() =>
            ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: {
                ...(isAiStudioManagedModel(modelName)
                  ? {
                      thinkingConfig: {
                        thinkingLevel:
                          modelName === 'gemini-3.1-flash-lite'
                            ? ThinkingLevel.MINIMAL
                            : ThinkingLevel.LOW,
                      },
                    }
                  : {}),
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    diacritizedWord: { type: Type.STRING },
                    wasAutoDiacritized: { type: Type.BOOLEAN },
                    tahajjiScript: { type: Type.STRING },
                    steps: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          part: { type: Type.STRING },
                          ruleLabel: { type: Type.STRING },
                          reading: { type: Type.STRING },
                        },
                        required: ['part', 'ruleLabel', 'reading'],
                      },
                    },
                  },
                  required: ['diacritizedWord', 'tahajjiScript', 'steps'],
                },
              },
            })
          ),
          timeoutMs
        );

      const noorCandidates = buildOrderedModels(
        ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'],
        ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
        shouldPreferPublicGeminiModels()
      );
      let result;
      let lastNoorErr: unknown;
      for (const candidateModel of noorCandidates) {
        try {
          result = await runNoorModel(candidateModel, 12000);
          break;
        } catch (err) {
          lastNoorErr = err;
          if (!isModelRetryableOrFallbackError(err)) {
            throw err;
          }
        }
      }
      if (!result) {
        throw lastNoorErr || new Error('No Al-Fath Al-Rabbani model succeeded.');
      }

      const rawJson = (result.text ?? '{}')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(rawJson) as RawNoorResponse;
      const vocalized = String(parsed.diacritizedWord || target).trim();
      const script = String(parsed.tahajjiScript || vocalized).trim();
      const payload = {
        diacritizedWord: vocalized,
        wasAutoDiacritized: Boolean(parsed.wasAutoDiacritized),
        tahajjiScript: script,
        fullReading: script,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      };
      setLruCache(noorAlBayanServerCache, cacheKey, payload, 250);
      res.json(payload);
    } catch (err) {
      const friendly = getFriendlyGeminiError(err);
      res.status(friendly.status).json({ error: friendly.message });
    }
  });

  // 3. Generate Studio Arabic Audio (WAV) via Gemini TTS respecting Harakat & Tajweed articulation
  app.post('/api/tts/speak', async (req: Request, res: Response) => {
    try {
      const { text, mode } = req.body as {
        text?: string;
        mode?: 'tahajji' | 'noor_albayan' | 'normal';
      };

      const spokenText = normalizeUthmaniForTts(String(text || '').trim().slice(0, 1800));
      if (!spokenText) {
        res.status(400).json({ error: 'النص المطلوب قراءته فارغ.' });
        return;
      }

      const readingMode =
        mode === 'tahajji' || mode === 'noor_albayan' ? 'tahajji' : 'normal';
      const cacheKey = `${readingMode}:fath_v4:${spokenText}`;
      const cachedWav = ttsAudioServerCache.get(cacheKey);
      if (cachedWav) {
        res.json({
          audioBase64: cachedWav,
          mimeType: 'audio/wav',
        });
        return;
      }

      if (Date.now() < ttsRateLimitUntilMs) {
        const retryAfterSec = Math.max(
          2,
          Math.ceil((ttsRateLimitUntilMs - Date.now()) / 1000)
        );
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
          error: 'تم الوصول للحد المؤقت من طلبات الصوت، انتظر لحظات ثم أعد المحاولة.',
        });
        return;
      }

      let pendingPromise = ttsInFlightCache.get(cacheKey);
      if (!pendingPromise) {
        const ttsStyleInstruction =
          readingMode === 'tahajji'
            ? 'Arabic Tajweed teacher reciting Al-Fath Al-Rabbani step-by-step spelling. Articulate every single short vowel (Fatha, Kasra, Damma) crisply and accurately even on isolated one-letter syllables—never mute them into Sukoon or change Kasra to Fatha. Hold every Sukoon cleanly without adding extra vowels. Pronounce every Shadda with clear double gemination and its exact attached vowel. Lengthen Madd letters and Ghunnah clearly and naturally at a calm, measured instructional pace.'
            : 'Eloquent Classical Arabic Quran and pedagogy teacher reciting with exact Tashkeel, clear Shadda gemination, accurate Sukoon stops, proper Madd elongation, and natural connected pacing without rushing.';

        const ai = getGeminiClient();
        const ttsCandidates = buildOrderedModels(
          ['gemini-3.8-flash-lite-tts'],
          ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
          shouldPreferPublicGeminiModels()
        ).filter((m, idx, arr) => arr.indexOf(m) === idx);

        pendingPromise = enqueueTtsRequest(async () => {
          const cachedInsideQueue = ttsAudioServerCache.get(cacheKey);
          if (cachedInsideQueue) {
            return { audioBase64: cachedInsideQueue, mimeType: 'audio/wav' };
          }
          if (Date.now() < ttsRateLimitUntilMs) {
            throw Object.assign(new Error('429 RESOURCE_EXHAUSTED cooldown active'), {
              status: 429,
            });
          }

          let response;
          let lastTtsErr: unknown;
          for (const candidateModel of ttsCandidates) {
            const sendTts = (withStyleMetadata: boolean) =>
              withTimeout(
                ai.models.generateContent({
                  model: candidateModel,
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        withStyleMetadata
                          ? ({
                              text: spokenText,
                              speechMetadata: { style: ttsStyleInstruction },
                            } as unknown as { text: string })
                          : { text: spokenText },
                      ],
                    },
                  ],
                  config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                      voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Charon' },
                      },
                    },
                  },
                }),
                12000
              );

            try {
              response = await sendTts(true);
              break;
            } catch (err) {
              const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
              if (msg.includes('speechmetadata') || msg.includes('speech_metadata')) {
                try {
                  response = await sendTts(false);
                  break;
                } catch (err2) {
                  lastTtsErr = err2;
                  if (!isModelRetryableOrFallbackError(err2)) {
                    throw err2;
                  }
                  continue;
                }
              }
              lastTtsErr = err;
              if (!isModelRetryableOrFallbackError(err)) {
                throw err;
              }
            }
          }

          if (!response) {
            const lastErrObj = lastTtsErr as { status?: number; code?: number; message?: string };
            const lastStatus = Number(lastErrObj?.status || lastErrObj?.code || 0);
            const lastMsg = (
              lastTtsErr instanceof Error ? lastTtsErr.message : String(lastTtsErr || '')
            ).toLowerCase();
            if (
              lastStatus === 429 ||
              lastMsg.includes('429') ||
              lastMsg.includes('resource_exhausted')
            ) {
              ttsRateLimitUntilMs = Date.now() + 12000;
            }
            throw lastTtsErr || new Error('No TTS model succeeded.');
          }

          const audioPart = response.candidates?.[0]?.content?.parts?.find(
            (p) => Boolean(p.inlineData?.data)
          )?.inlineData;
          const base64Audio = audioPart?.data;

          if (!base64Audio || base64Audio.length < 120) {
            throw Object.assign(new Error('لم يتمكن محرك الصوت من توليد المقطع الصوتي.'), {
              status: 502,
            });
          }

          const wrapped = ensureWavBase64(base64Audio, audioPart?.mimeType);
          setLruCache(ttsAudioServerCache, cacheKey, wrapped.base64Wav, 250);
          return {
            audioBase64: wrapped.base64Wav,
            mimeType: wrapped.mimeType,
          };
        }).finally(() => {
          ttsInFlightCache.delete(cacheKey);
        });

        ttsInFlightCache.set(cacheKey, pendingPromise);
      }

      const generated = await pendingPromise;
      res.json(generated);
    } catch (err) {
      if ((err as { status?: number })?.status === 502) {
        res.status(502).json({ error: 'لم يتمكن محرك الصوت من توليد المقطع الصوتي.' });
        return;
      }
      const friendly = getFriendlyGeminiError(err);
      if (friendly.status === 429) {
        if (ttsRateLimitUntilMs <= Date.now()) {
          ttsRateLimitUntilMs = Date.now() + 12000;
        }
        res.setHeader(
          'Retry-After',
          String(Math.max(2, Math.ceil(Math.max(0, ttsRateLimitUntilMs - Date.now()) / 1000) || 12))
        );
      }
      res.status(friendly.status).json({ error: friendly.message });
    }
  });

  // 4. Smart & Fast Programmer AI Assistant for full platform & database diagnostics
  app.post('/api/admin/ai-chat', async (req: Request, res: Response) => {
    try {
      const { message, history, systemContext, customApiKey } = req.body as {
        message?: string;
        history?: Array<{ role: 'user' | 'model'; text: string }>;
        systemContext?: string;
        customApiKey?: string;
      };

      const cleanMessage = String(message || '').trim().slice(0, 4000);
      if (!cleanMessage) {
        res.status(400).json({ error: 'يرجى كتابة سؤالك أولاً.' });
        return;
      }

      const trimmedCustomKey =
        typeof customApiKey === 'string' ? customApiKey.trim() : '';
      const ai = getGeminiClient(trimmedCustomKey || undefined);

      const safeContext = String(systemContext || '').slice(0, 95000);
      const systemInstruction = `أنت المساعد التقني الذكي المتخصص لمبرمج منصة «براعم عمران» (منصة تعليمية قرآنية متعددة قواعد البيانات).
مهمتك مساعدة المبرمج في فحص كل شاردة وواردة بدقة وسرعة ووضوح باللغة العربية الفصحى المنظمة:
- أين تُخزن كل البيانات والمجموعات (Primary DB أم External DB للمجمع أم Tab Shards المعزولة لكل تبويب: attendance / library / curricula / accounts_invites / mosques_halaqat).
- تحليل استهلاك المساحة والوثائق لكل قاعدة ولكل مجموعة وكم تبقى على الحدود (خطة Firebase Spark المجانية تمنح 1 GiB لكل قاعدة/مشروع مجاني + 50,000 قراءة/يوم + 20,000 كتابة/يوم + 20,000 حذف/يوم + 10 GiB نقل شبكة شهرياً + حد 1 MiB للوثيقة الواحدة؛ بينما تمتد شرائح التبويب حتى 4 GB عند الترقية لخطة Blaze).
- تحليل تخزين الصوتيات (wordAudio) بدقة من حقل "audioStorageAndRemainingCapacity" وحقل "freeLimitsReference": عدد المقاطع الصوتية المحفوظة، متوسط حجم المقطع، القواعد المستضيفة للمكتبة والصوتيات، كم تبقى بالميجابايت/جيجابايت وكم مقطعاً صوتياً تقريباً يكفي قبل نفاد حد Spark المجاني (1 GiB لكل قاعدة)، وكيف تقلل القاعدة والـ IndexedDB استهلاك Gemini TTS المجاني (RPM/RPD).
- كشف نقاط الضعف والمشاكل التقنية والتشغيلية (قواعد ممتلئة أو تقترب من الحد، قواعد لا تستجيب، أخطاء Firestore Rules مفصلة، مجمعات دون معزولة، حلقات بلا طلاب أو بلا معلمين، حسابات لم تربط جوجل، كتب عالقة أو متوقفة، إلخ).
- إذا لم تتوفر معلومة دقيقة في اللقطة الحية المرفقة فاذكر ذلك بوضوح ولا تخمّن بيانات غير موجودة.
- قدّم إجابات دقيقة، مركزة، بنقاط مرقمة وعملية.

اللقطة الحية الشاملة الحالية للمنصة وقواعدها:
${safeContext || 'لم يتم إرفاق بيانات بعد.'}`;

      const safeHistory = Array.isArray(history)
        ? history
            .slice(-12)
            .filter(
              (h) =>
                h &&
                (h.role === 'user' || h.role === 'model') &&
                typeof h.text === 'string' &&
                h.text.trim().length > 0
            )
            .map((h) => ({
              role: h.role,
              parts: [{ text: h.text.trim().slice(0, 4000) }],
            }))
        : [];

      const contents = [
        ...safeHistory,
        {
          role: 'user' as const,
          parts: [{ text: cleanMessage }],
        },
      ];

      const startedAt = Date.now();
      const callModel = async (modelName: string, timeoutMs: number) => {
        return await withTimeout(
          withRetry(
            () =>
              ai.models.generateContent({
                model: modelName,
                contents,
                config: {
                  ...(isAiStudioManagedModel(modelName)
                    ? {
                        thinkingConfig: {
                          thinkingLevel:
                            modelName === 'gemini-3.1-flash-lite'
                              ? ThinkingLevel.MINIMAL
                              : ThinkingLevel.LOW,
                        },
                      }
                    : {}),
                  systemInstruction,
                },
              }),
            2
          ),
          timeoutMs
        );
      };

      const chatCandidates = buildOrderedModels(
        ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
        ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
        shouldPreferPublicGeminiModels(trimmedCustomKey)
      );

      let result;
      let lastChatErr: unknown;
      for (const candidateModel of chatCandidates) {
        try {
          result = await callModel(candidateModel, 18000);
          break;
        } catch (candidateErr) {
          const errStatus = Number(
            (candidateErr as { status?: number; code?: number })?.status ||
              (candidateErr as { status?: number; code?: number })?.code ||
              0
          );
          if (!lastChatErr || errStatus !== 404) {
            lastChatErr = candidateErr;
          }
          const rawErr =
            candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
          console.warn(`[AI Chat fallback from ${candidateModel}]`, rawErr.slice(0, 220));
          if (!isModelRetryableOrFallbackError(candidateErr)) {
            throw candidateErr;
          }
        }
      }
      if (!result) {
        throw lastChatErr || new Error('No chat model succeeded.');
      }

      const latencyMs = Date.now() - startedAt;

      const replyText = (result.text ?? '').trim();
      if (!replyText) {
        res.status(502).json({ error: 'لم يُرجع الذكاء الاصطناعي نصاً للرد؛ أعد المحاولة.' });
        return;
      }

      res.json({
        reply: replyText,
        usageMetadata: result.usageMetadata
          ? {
              promptTokenCount: result.usageMetadata.promptTokenCount ?? 0,
              candidatesTokenCount: result.usageMetadata.candidatesTokenCount ?? 0,
              totalTokenCount: result.usageMetadata.totalTokenCount ?? 0,
            }
          : null,
        latencyMs,
        usingCustomKey: Boolean(trimmedCustomKey),
      });
    } catch (err) {
      const friendly = getFriendlyGeminiError(err);
      const customKeyNote =
        typeof (req.body as { customApiKey?: string })?.customApiKey === 'string' &&
        (req.body as { customApiKey?: string }).customApiKey?.trim()
          ? ' (تم استخدام مفتاح API المخصص المدخل من زر القلم — تأكد من صحته وصلاحياته)'
          : '';
      res.status(friendly.status).json({ error: `${friendly.message}${customKeyNote}` });
    }
  });

  app.all('/api/*', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  if (IS_PROD) {
    app.use(
      express.static(DIST_DIR, {
        setHeaders: (res, filePath) => {
          const baseName = path.basename(filePath);
          if (baseName === 'version.json' || baseName === 'sw.js' || baseName === 'index.html') {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      if (fs.existsSync(DIST_INDEX)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.sendFile(DIST_INDEX);
      } else {
        res.status(404).send('Build not found.');
      }
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Braem Omran server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
