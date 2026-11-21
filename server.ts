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
const IS_PROD = process.env.NODE_ENV === 'production';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
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

function getFriendlyGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('gemini_api_key')) {
    return {
      status: 500,
      message: 'مفتاح الذكاء الاصطناعي غير مضبوط على الخادم (Settings > Secrets).',
    };
  }
  if (lower.includes('permission_denied') || lower.includes('api_key_invalid') || lower.includes('403')) {
    return {
      status: 403,
      message: 'تعذّر التحقق من صلاحية مفتاح الذكاء الاصطناعي؛ يرجى مراجعة Settings > Secrets.',
    };
  }
  if (lower.includes('resource_exhausted') || lower.includes('429')) {
    return {
      status: 429,
      message: 'تم الوصول للحد المؤقت من الطلبات، انتظر لحظات ثم أعد المحاولة.',
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
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const retryable =
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('500') ||
        msg.includes('timeout') ||
        msg.includes('network');
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
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
  app.use(express.json({ limit: '25mb' }));

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

      const result = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
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
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
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
      );

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

  // 2. Generate authentic Noor Al-Bayan spelling breakdown with auto-vocalization for unvocalized words
  app.post('/api/books/noor-albayan', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      const target = String(text || '').trim().slice(0, 400);
      if (!target) {
        res.status(400).json({ error: 'النص مطلوب لإنشاء التهجي.' });
        return;
      }

      const cachedNoor = noorAlBayanServerCache.get(target);
      if (cachedNoor) {
        res.json(cachedNoor);
        return;
      }

      const ai = getGeminiClient();
      const prompt = `أنت معلم متقن لمنهج "نور البيان" في تعليم القراءة العربية والقرآن الكريم.
حلّل النص التالي بالتهجي التفصيلي حسب قاعدة نور البيان الحرفية حرفاً بحرف:
النص: "${target}"

قاعدة مهمة للكلمات بدون حركات:
- إذا كان النص أو بعض كلماته بدون حركات (غير مشكول): اضبطه أولاً بالتشكيل العربي الصحيح الكامل (حسب المعنى القرآني أو القاعدة الصرفية والنحوية وأل القمرية والشمسية)، وضع النتيجة في "diacritizedWord" واجعل "wasAutoDiacritized": true. أما إذا كان مشكولاً بالفعل فضعه كما هو واجعل "wasAutoDiacritized": false.

أرجع JSON يتكون من:
1. "diacritizedWord": النص مضبوطاً بالشكل الكامل (الفتحة والضمة والكسرة والسكون والشدة والتنوين والمد).
2. "wasAutoDiacritized": boolean هل تم تقدير التشكيل لكلمة كانت بدون حركات؟
3. "tahajjiScript": نص التهجي المنطوق بالكامل مضبوطاً بالتشكيل الكامل والحركات الدقيقة ليُقرأ بصوت واضح مع فواصل وقفات قصيرة (،).
مثال توضيحي لكلمة "بَيَانٌ":
"بَاءٌ فَتْحَة: بَ، يَاءٌ فَتْحَة: يَ، أَلِفٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ: يَا، بَيَا، نُونٌ تَنْوِينٌ بِالضَّمِّ: نُنْ، الْكَلِمَةُ كَامِلَةً: بَيَانٌ."
ومثال لللام الشمسية مثل "الشَّمْسُ":
"هَمْزَةُ وَصْلٍ وَلَامٌ شَمْسِيَّةٌ مُدْغَمَةٌ تَسْقُطُ فِي النُّطْقِ، شِينٌ شَدَّةٌ وَفَتْحَة: الشَّ، مِيمٌ سُكُونْ: الشَّمْ، سِينٌ ضَمَّة: الشَّمْسُ."
ومثال للسكون مثل "يَكْتُبُ":
"يَاءٌ فَتْحَة: يَ، كَافٌ سُكُونْ: يَكْ، تَاءٌ ضَمَّة: تُ، يَكْتُ، بَاءٌ ضَمَّة: بُ، يَكْتُبُ."
اجعل كل حرف وحركته ومدّه وسكونه وشدّته وتنوينه وأل القمرية والشمسية والتاء المربوطة واضحة جداً باللغة العربية الفصحى وبالحركات الكاملة.
4. "steps": مصفوفة من الخطوات البصرية لعرضها أمام الطالب:
   - "part": الحرف أو المقطع
   - "ruleLabel": القاعدة مثل (فتحة، كسرة، ضمة، لام قمرية مظهرة، لام شمسية مدغمة، مد بالألف حركتان، سكون، شدة وفتحة، تنوين بالضم...)
   - "reading": النتيجة المجمعة حتى هذه الخطوة بالحركات الكاملة.`;

      const result = await withTimeout(
        withRetry(() =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: prompt,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
        9000
      );

      const rawJson = (result.text ?? '{}').trim();
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
      setLruCache(noorAlBayanServerCache, target, payload, 250);
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

      const spokenText = String(text || '').trim().slice(0, 1800);
      if (!spokenText) {
        res.status(400).json({ error: 'النص المطلوب قراءته فارغ.' });
        return;
      }

      const readingMode =
        mode === 'tahajji' || mode === 'noor_albayan' ? 'tahajji' : 'normal';
      const cacheKey = `${readingMode}:${spokenText}`;
      const cachedWav = ttsAudioServerCache.get(cacheKey);
      if (cachedWav) {
        res.json({
          audioBase64: cachedWav,
          mimeType: 'audio/wav',
        });
        return;
      }

      const ai = getGeminiClient();
      const response = await withTimeout(
        withRetry(() =>
          ai.models.generateContent({
            model: 'gemini-3.8-flash-lite-tts',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: spokenText,
                  },
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
          })
        ),
        10500
      );

      const audioPart = response.candidates?.[0]?.content?.parts?.find(
        (p) => Boolean(p.inlineData?.data)
      )?.inlineData;
      const base64Audio = audioPart?.data;

      if (!base64Audio || base64Audio.length < 120) {
        res.status(502).json({ error: 'لم يتمكن محرك الصوت من توليد المقطع الصوتي.' });
        return;
      }

      const wrapped = ensureWavBase64(base64Audio, audioPart?.mimeType);
      setLruCache(ttsAudioServerCache, cacheKey, wrapped.base64Wav, 250);
      res.json({
        audioBase64: wrapped.base64Wav,
        mimeType: wrapped.mimeType,
      });
    } catch (err) {
      const friendly = getFriendlyGeminiError(err);
      res.status(friendly.status).json({ error: friendly.message });
    }
  });

  if (IS_PROD) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
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
