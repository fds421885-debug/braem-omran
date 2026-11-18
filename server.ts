import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
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

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
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
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
  throw lastError;
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
  tahajjiScript?: string;
  steps?: Array<{
    part?: string;
    ruleLabel?: string;
    reading?: string;
  }>;
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
- لا تتجاهل أي كلمة عربية أو قرآنية واضحة في الصفحة.
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

  // 2. Generate authentic Noor Al-Bayan spelling breakdown with full Arabic Tashkeel
  app.post('/api/books/noor-albayan', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      const target = String(text || '').trim().slice(0, 400);
      if (!target) {
        res.status(400).json({ error: 'النص مطلوب لإنشاء التهجي.' });
        return;
      }

      const ai = getGeminiClient();
      const prompt = `أنت معلم متقن لمنهج "نور البيان" في تعليم القراءة العربية والقرآن الكريم.
حلّل النص التالي بالتهجي التفصيلي حسب قاعدة نور البيان الحرفية حرفاً بحرف:
النص: "${target}"

أرجع JSON يتكون من:
1. "tahajjiScript": نص التهجي المنطوق بالكامل مضبوطاً بالتشكيل الكامل والحركات الدقيقة ليُقرأ بصوت واضح مع فواصل وقفات قصيرة (،).
مثال توضيحي لكلمة "بَيَانٌ":
"بَاءٌ فَتْحَة: بَ، يَاءٌ فَتْحَة: يَ، أَلِفٌ مَدٌّ طَبِيعِيٌّ حَرَكَتَانْ: يَا، بَيَا، نُونٌ تَنْوِينٌ بِالضَّمِّ: نُنْ، بَيَانٌ."
ومثال آخر لكلمة "يَكْتُبُ":
"يَاءٌ فَتْحَة: يَ، كَافٌ سُكُونْ: يَكْ، تَاءٌ ضَمَّة: تُ، يَكْتُ، بَاءٌ ضَمَّة: بُ، يَكْتُبُ."
ومثال للشدة مثل "رَبِّ":
"رَاءٌ فَتْحَة: رَ، بَاءٌ شَدَّةٌ وَكَسْرَة: رَبِّ."
اجعل كل حرف وحركته ومدّه وسكونه وشدّته وتنوينه واضحة جداً باللغة العربية الفصحى وبالحركات الكاملة.
2. "steps": مصفوفة من الخطوات البصرية لعرضها أمام الطالب:
   - "part": الحرف أو المقطع
   - "ruleLabel": القاعدة مثل (فتحة، كسرة، ضمة، مد بالألف حركتان، سكون، شدة وفتحة، تنوين بالضم...)
   - "reading": النتيجة المجمعة حتى هذه الخطوة بالحركات الكاملة.`;

      const result = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
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
              required: ['tahajjiScript', 'steps'],
            },
          },
        })
      );

      const rawJson = (result.text ?? '{}').trim();
      const parsed = JSON.parse(rawJson) as RawNoorResponse;
      const script = String(parsed.tahajjiScript || target).trim();
      res.json({
        diacritizedWord: target,
        tahajjiScript: script,
        fullReading: script,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      });
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
      const stylePrompt =
        readingMode === 'tahajji'
          ? 'Warm, patient Classical Arabic Noor Al-Bayan Quran teacher. Speak slowly and articulate every Arabic letter name, fatha, kasra, damma, sukoon, shadda, tanween, and 2-count madd elongation clearly with short gentle pauses at commas.'
          : 'Clear, articulate Classical Arabic educator reading the Arabic text naturally at a calm pace while pronouncing every short vowel (harakat) and letter ending accurately.';

      const ai = getGeminiClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: spokenText,
                  speechMetadata: {
                    style: stylePrompt,
                  },
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
      );

      const base64Audio = response.candidates?.[0]?.content?.parts?.find(
        (p) => Boolean(p.inlineData?.data)
      )?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({ error: 'لم يتمكن محرك الصوت من توليد المقطع الصوتي.' });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
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
