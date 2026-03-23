import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file (server-side only - NEVER exposed to client)
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

const DEFAULT_LLM_PROVIDER = (process.env.LLM_PROVIDER || 'lmstudio').toLowerCase();
const DEFAULT_TTS_PROVIDER = (process.env.TTS_PROVIDER || 'openai').toLowerCase();

const SYSTEM_PROMPT = `You are a witty assistant that will use the chat history and the image provided by the user to answer its questions.

Use few words on your answers. Go straight to the point. Do not use any emoticons or emojis. Do not ask the user any questions.

Be friendly and helpful. Show some personality. Do not be too formal.`;

// --- LLM Provider Setup (initialize BOTH so UI can switch at runtime) ---
let geminiModel = null;
let lmStudioClient = null;

// Always try to initialise Gemini if a key is configured
if (process.env.GOOGLE_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    geminiModel = genAI.getGenerativeModel({ 
      model: process.env.GOOGLE_MODEL || 'gemini-3.1-flash-lite-preview',
      systemInstruction: {
        role: 'user',
        parts: [{ text: SYSTEM_PROMPT }],
      },
    });
    console.log(`LLM Provider available: Google Gemini (${process.env.GOOGLE_MODEL || 'gemini-3.1-flash-lite-preview'})`);
  } catch (e) {
    console.warn('Could not initialise Gemini:', e.message);
  }
}

// Always initialise LM Studio client (no key required)
lmStudioClient = new OpenAI({
  baseURL: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1',
  apiKey: 'lm-studio',
});
console.log(`LLM Provider available: LM Studio @ ${process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1'} (${process.env.LMSTUDIO_MODEL || 'auto'})`);

// Initialize OpenAI client for TTS and STT (cloud paths)
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration - allow local network access
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || [] 
    : [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/, /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/, /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parser with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  // Report which providers are available and which are the current defaults
  const available = {
    stt:  { local: true, cloud: !!openai },
    llm:  { local: true, cloud: !!geminiModel },
    tts:  { local: true, cloud: !!openai },
  };

  // Build model info for default configuration
  const llmModel = DEFAULT_LLM_PROVIDER === 'gemini'
    ? (process.env.GOOGLE_MODEL || 'gemini-3.1-flash-lite-preview')
    : (process.env.LMSTUDIO_MODEL || 'local model');
  const llmLocation = DEFAULT_LLM_PROVIDER === 'gemini' ? 'cloud' : 'local';

  const ttsModel = DEFAULT_TTS_PROVIDER === 'browser' ? 'browser' : (process.env.OPENAI_TTS_MODEL || 'tts-1');
  const ttsLocation = DEFAULT_TTS_PROVIDER === 'browser' ? 'local' : 'cloud';

  const sttModel = 'Web Speech API';
  const sttLocation = 'local';

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ttsProvider: DEFAULT_TTS_PROVIDER,
    defaults: {
      stt: 'local',
      llm: DEFAULT_LLM_PROVIDER === 'gemini' ? 'cloud' : 'local',
      tts: DEFAULT_TTS_PROVIDER === 'browser' ? 'local' : 'cloud',
    },
    available,
    models: {
      stt:  { name: sttModel,  location: sttLocation },
      llm:  { name: llmModel,  location: llmLocation },
      tts:  { name: ttsModel,  location: ttsLocation },
    },
    providerNames: {
      stt:  { local: 'Web Speech API', cloud: process.env.OPENAI_STT_MODEL || 'whisper-1' },
      llm:  { local: process.env.LMSTUDIO_MODEL || 'LM Studio', cloud: process.env.GOOGLE_MODEL || 'gemini-3.1-flash-lite-preview' },
      tts:  { local: 'Browser TTS', cloud: process.env.OPENAI_TTS_MODEL || 'tts-1' },
    },
  });
});

// Chat completion endpoint - supports LM Studio (local) or Google Gemini
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, imageBase64, chatHistory = [], llmProvider: reqLLM } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Allow per-request override; fall back to server default
    const effectiveLLM = (reqLLM || DEFAULT_LLM_PROVIDER).toLowerCase();

    let response = '';
    let modelName = '';
    const llmStartTime = Date.now();

    if (effectiveLLM === 'gemini') {
      // --- Google Gemini path ---
      if (!process.env.GOOGLE_API_KEY) {
        return res.status(500).json({ error: 'Server configuration error: Google API key not configured' });
      }

      const geminiHistory = chatHistory
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        }));

      const chat = geminiModel.startChat({
        history: geminiHistory,
      });

      const parts = [];
      parts.push({ text: prompt });

      if (imageBase64) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBase64
          }
        });
      }

      const result = await chat.sendMessage(parts);
      response = result.response.text() || '';
      modelName = process.env.GOOGLE_MODEL || 'gemini-3.1-flash-lite-preview';

    } else {
      // --- LM Studio (local) path ---
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatHistory
          .filter(msg => msg.role === 'user' || msg.role === 'assistant')
          .slice(-10)
          .map(msg => ({ role: msg.role, content: msg.content }))
      ];

      // Build user message content
      const userContent = [];
      userContent.push({ type: 'text', text: prompt });
      
      if (imageBase64) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${imageBase64}`,
          }
        });
      }

      messages.push({ role: 'user', content: userContent.length === 1 ? prompt : userContent });

      const completion = await lmStudioClient.chat.completions.create({
        model: process.env.LMSTUDIO_MODEL || '',
        messages: messages,
        temperature: 0.7,
        max_tokens: 100000,
      });

      const choice = completion.choices[0];
      let rawContent = choice?.message?.content || '';
      const reasoning = choice?.message?.reasoning_content || '';
      const hitTokenLimit = choice?.finish_reason === 'length';

      // Qwen3.5 "thinking" models spend most tokens on reasoning_content.
      // When the token limit is hit, content may be empty or truncated.
      // Detect truncation: empty, or ends mid-word/mid-sentence without punctuation.
      const isTruncated = hitTokenLimit && (
        !rawContent.trim() ||
        (rawContent.trim().length > 0 && !/[.!?]$/.test(rawContent.trim()))
      );

      if (isTruncated && reasoning) {
        console.log(`Warning: content appears truncated ("${rawContent.trim().slice(0, 50)}..."), extracting from reasoning_content`);
        // Look for draft/final answer lines in the reasoning
        const lines = reasoning.split('\n').filter(l => l.trim());
        // Search backwards for a line that looks like a final answer (quoted or after "Final"/"Revised")
        let fallback = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          // Match quoted answer lines like: "You look about 50..."
          const quoted = line.match(/^[""](.+)[""]\.?$/);
          if (quoted) { fallback = quoted[1]; break; }
          // Match lines after Final/Revised labels
          if (/^(Final|Revised|Draft \d|Answer)/i.test(line)) {
            const nextLine = lines[i + 1]?.trim();
            if (nextLine) { fallback = nextLine.replace(/^[""]|[""]$/g, ''); break; }
          }
        }
        // If no structured answer found, just take the last non-empty line
        if (!fallback) {
          fallback = lines[lines.length - 1] || reasoning.slice(-300);
        }
        rawContent = fallback;
      }

      // Strip special tokens that some models (GLM-4.6V, Qwen3.5) wrap around answers
      response = rawContent
        .replace(/<\|begin_of_box\|>/g, '')
        .replace(/<\|end_of_box\|>/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<\|[a-z_]+\|>/g, '')  // catch other special tokens
        .trim();

      modelName = completion.model || process.env.LMSTUDIO_MODEL || 'lm-studio';
    }

    const llmDuration = ((Date.now() - llmStartTime) / 1000).toFixed(1);
    res.json({ response, model: modelName, llmSeconds: parseFloat(llmDuration) });

  } catch (error) {
    console.error('Chat API Error:', error.message);
    
    const msg = (error.message || '').toLowerCase();
    const statusMatch = msg.match(/\[(\d{3})/); // Extract HTTP status from "[429 Too Many Requests]"
    const status = error.status || error.httpStatusCode || error?.response?.status || (statusMatch ? parseInt(statusMatch[1]) : 0);
    
    // Extract retry delay if present (e.g., "Please retry in 59.596445146s")
    const retryMatch = msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
    const retrySeconds = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
    const retryMsg = retrySeconds ? ` Please try again in about ${retrySeconds} seconds.` : ' Please wait a moment and try again.';
    
    if (msg.includes('api_key_invalid') || msg.includes('api key not valid') || status === 401 || status === 403) {
      return res.status(500).json({ 
        error: 'Invalid Google API key. Please check your server configuration.',
        errorType: 'auth'
      });
    }
    
    if (status === 429 || msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted') || msg.includes('too many requests')) {
      // Check if it's a daily quota vs rate limit
      const isDaily = msg.includes('per day') || msg.includes('perdayper') || msg.includes('free_tier');
      const quotaMsg = isDaily 
        ? `You've hit the daily request limit for Gemini (free tier: 20 requests/day).${retryMsg} Consider upgrading to a paid Google AI plan for higher limits.`
        : `Gemini is rate limited — too many requests too fast.${retryMsg}`;
      
      return res.status(429).json({ 
        error: quotaMsg,
        errorType: 'rate_limit',
        retryAfterSeconds: retrySeconds
      });
    }

    if (status === 503 || status === 500 || msg.includes('overloaded') || msg.includes('unavailable')) {
      return res.status(503).json({ 
        error: 'Gemini is temporarily unavailable due to high demand. Please try again in a few seconds.',
        errorType: 'overloaded'
      });
    }

    if (msg.includes('safety') || msg.includes('blocked')) {
      return res.status(400).json({ 
        error: 'Your message was blocked by the AI safety filter. Please rephrase and try again.',
        errorType: 'safety'
      });
    }

    if (msg.includes('timeout') || msg.includes('deadline_exceeded') || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
      const isLocal = effectiveLLM === 'lmstudio';
      return res.status(504).json({ 
        error: isLocal 
          ? 'Cannot connect to LM Studio. Make sure LM Studio is running and the model is loaded.'
          : 'The AI model took too long to respond. Please try again with a shorter message.',
        errorType: 'timeout'
      });
    }

    if (error.code === 'ECONNREFUSED' || msg.includes('econnrefused') || msg.includes('connect')) {
      return res.status(503).json({ 
        error: 'Cannot connect to LM Studio at ' + (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1') + '. Make sure LM Studio is running and the local server is enabled.',
        errorType: 'connection'
      });
    }
    
    res.status(500).json({ 
      error: 'Something went wrong with the AI model. Please try again.',
      errorType: 'unknown',
      detail: process.env.NODE_ENV === 'development' ? msg : undefined
    });
  }
});

// Text-to-Speech endpoint - generates audio from text
// API key is used server-side only, never exposed to client
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'fable' } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (!openai) {
      return res.status(500).json({ error: 'Server configuration error: OpenAI API key not configured' });
    }

    const mp3Response = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || 'tts-1',
      voice: voice || process.env.OPENAI_TTS_VOICE || 'fable',
      input: text,
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await mp3Response.arrayBuffer());
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache',
    });
    
    res.send(buffer);

  } catch (error) {
    console.error('TTS API Error:', error.message);

    const status = error.status || error?.response?.status;
    const msg = error.message || '';

    if (status === 401 || status === 403) {
      return res.status(500).json({ 
        error: 'Invalid OpenAI API key for Text-to-Speech. Please check server configuration.',
        errorType: 'auth'
      });
    }

    if (status === 429 || msg.includes('rate') || msg.includes('quota')) {
      return res.status(429).json({ 
        error: 'Text-to-Speech service is rate limited. Too many requests — please wait a moment.',
        errorType: 'rate_limit'
      });
    }

    if (status === 503 || status === 500 || msg.includes('overloaded') || msg.includes('server_error')) {
      return res.status(503).json({ 
        error: 'OpenAI Text-to-Speech service is temporarily unavailable. The response text is still shown above.',
        errorType: 'overloaded'
      });
    }

    if (msg.includes('timeout') || error.code === 'ETIMEDOUT') {
      return res.status(504).json({ 
        error: 'Text-to-Speech request timed out. The response text is still shown above.',
        errorType: 'timeout'
      });
    }

    res.status(500).json({ 
      error: 'Failed to generate speech audio. The text response is still shown above.',
      errorType: 'unknown',
      detail: process.env.NODE_ENV === 'development' ? msg : undefined
    });
  }
});

// Speech-to-Text endpoint (Whisper API)
// API key is used server-side only, never exposed to client
app.post('/api/stt', async (req, res) => {
  try {
    const { audioBase64 } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: 'Audio data is required' });
    }

    if (!openai) {
      return res.status(500).json({ error: 'Server configuration error: OpenAI API key not configured' });
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    
    // Create a File object for the API
    const audioFile = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: process.env.OPENAI_STT_MODEL || 'whisper-1',
      language: 'en',
    });

    res.json({ 
      text: transcription.text 
    });

  } catch (error) {
    console.error('STT API Error:', error.message);

    const status = error.status || error?.response?.status;
    const msg = error.message || '';

    if (status === 401 || status === 403) {
      return res.status(500).json({ 
        error: 'Invalid OpenAI API key for Speech-to-Text. Please check server configuration.',
        errorType: 'auth'
      });
    }

    if (status === 429 || msg.includes('rate') || msg.includes('quota')) {
      return res.status(429).json({ 
        error: 'Speech-to-Text service is rate limited. Please wait a moment and try again.',
        errorType: 'rate_limit'
      });
    }

    if (status === 503 || status === 500 || msg.includes('overloaded') || msg.includes('server_error')) {
      return res.status(503).json({ 
        error: 'OpenAI Speech-to-Text service is temporarily unavailable. Please try speaking again in a moment.',
        errorType: 'overloaded'
      });
    }

    if (msg.includes('timeout') || error.code === 'ETIMEDOUT') {
      return res.status(504).json({ 
        error: 'Speech-to-Text request timed out. Please try speaking again.',
        errorType: 'timeout'
      });
    }

    res.status(500).json({ 
      error: 'Failed to transcribe your speech. Please try again or type your message instead.',
      errorType: 'unknown',
      detail: process.env.NODE_ENV === 'development' ? msg : undefined
    });
  }
});

// Catch-all handler for SPA routing in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Load SSL certificates for HTTPS
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, '../certs/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '../certs/cert.pem')),
};

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`
🔒 Secure Garry's MultiModal Voice AI Server running on https://localhost:${PORT}

AI Providers (switchable at runtime via UI):
  🧠 LLM:  LM Studio (local) ${geminiModel ? '+ Google Gemini (cloud)' : '— Gemini unavailable (no API key)'}
  🔊 TTS:  Browser (local) ${openai ? '+ OpenAI (cloud)' : '— OpenAI unavailable (no API key)'}
  🎤 STT:  Web Speech API (local) ${openai ? '+ Whisper (cloud)' : '— Whisper unavailable (no API key)'}

  Defaults: LLM=${DEFAULT_LLM_PROVIDER}, TTS=${DEFAULT_TTS_PROVIDER}, STT=local

Endpoints:
  POST /api/chat   - Chat/Vision (accepts llmProvider param)
  POST /api/tts    - Text-to-Speech via OpenAI
  POST /api/stt    - Speech-to-Text via OpenAI Whisper
  GET  /api/health - Health check + available providers
  `);
});

export default app;
