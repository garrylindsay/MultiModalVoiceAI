# MultiModal Voice AI — React App

A multimodal AI assistant that combines **live webcam vision**, **voice input/output**, and **text chat** into a single real-time interface. Ask questions by speaking or typing, and the AI can see what your camera sees to give contextual answers — then speaks the response back to you.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19, Vite 6 | SPA with hot module reload |
| **Backend** | Express 4, Node.js (ESM) | Secure API proxy — all keys stay server-side |
| **Chat / Vision LLM** | LM Studio (local) _or_ Google Gemini | Multimodal chat completions with image understanding |
| **Text-to-Speech** | OpenAI TTS (`tts-1`) | Speaks AI responses aloud |
| **Speech-to-Text** | Web Speech API (browser) + OpenAI Whisper (server fallback) | Voice input transcription |
| **Security** | HTTPS (self-signed), Helmet, CORS, rate limiting | API keys never leave the server |

### Security Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────┐
│   Browser        │     │   Express Server │     │  AI Services         │
│   (React + Vite) │────▶│   (port 3001)    │────▶│  LM Studio / Gemini  │
│                  │     │   API Keys 🔐     │     │  OpenAI TTS/STT      │
│   No API keys!   │◀────│                  │◀────│                      │
└─────────────────┘     └─────────────────┘     └──────────────────────┘
```

### Browser Compatibility

| Browser | Voice Recognition | TTS | Camera |
|---------|-------------------|-----|--------|
| Chrome 90+ | Full | Yes | Yes |
| Edge 90+ | Full | Yes | Yes |
| Safari 14+ | Limited | Yes | Yes |
| Firefox 88+ | No (text input works) | Yes | Yes |

---

## Project Structure

```
react-app/
├── src/
│   ├── App.jsx                     # Main app — orchestrates camera, chat, voice
│   ├── main.jsx                    # Entry point
│   ├── index.css                   # Styles
│   ├── components/
│   │   ├── Chat.jsx                # Chat message list + text input
│   │   └── Webcam.jsx              # Camera feed + frame capture
│   └── hooks/
│       ├── useApi.js               # Fetch wrapper for /api/chat, /api/tts, /api/stt
│       └── useSpeechRecognition.js # Browser speech recognition hook
├── server/
│   ├── server.js                   # Express backend (HTTPS, all API endpoints)
│   └── .env                        # API keys & config (NEVER commit this)
├── certs/                          # Self-signed SSL certs (generated locally)
├── vite.config.js                  # Vite dev server config + proxy to backend
├── package.json                    # Scripts & frontend deps
└── index.html
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Send text + optional base64 image → get AI response |
| `POST` | `/api/tts` | Send text → get MP3 audio stream |
| `POST` | `/api/stt` | Send audio blob → get transcription |
| `GET` | `/api/health` | Server health check |

---

## Prerequisites

- **Node.js** 18+
- **npm**
- **LM Studio** running locally with a model loaded (default), _or_ a Google Gemini API key
- **OpenAI API key** (for TTS/STT only)
- Self-signed SSL certificates in `certs/` (see setup below)

---

## Initial Setup

### Option A — Automated setup (recommended for new machines)

If you have the [GitHub CLI](https://cli.github.com/) installed and are authenticated (`gh auth login`), a single script will pull all configuration from GitHub and prompt you only for your API keys:

```bash
# From the repo root
chmod +x setup.sh && ./setup.sh
```

The script:
- Fetches non-sensitive config automatically from GitHub Variables
- Prompts (with hidden input) for your OpenAI and Google API keys
- Writes both `.env` files ready to go

Then skip to [Install dependencies](#1-install-dependencies).

---

### Option B — Manual setup

### 1. Install dependencies

```bash
cd react-app
npm install
cd server && npm install && cd ..
```

### 2. Generate SSL certificates

Required for HTTPS (camera/microphone access needs a secure context):

```bash
# Replace 192.168.1.186 with your machine's local IP
mkdir -p certs
openssl req -x509 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:192.168.1.186,IP:127.0.0.1"
```

Find your local IP with:
```bash
ipconfig getifaddr en0    # macOS
```

### 3. Configure environment

Edit `server/.env`:

```dotenv
# LLM Provider: "lmstudio" (local) or "gemini" (cloud)
LLM_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=qwen3.5-9b

# Uncomment for Gemini instead:
# LLM_PROVIDER=gemini
# GOOGLE_API_KEY=your-key-here
# GOOGLE_MODEL=gemini-3.1-flash-lite-preview

# OpenAI (TTS + STT only)
OPENAI_API_KEY=your-openai-key
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=fable
OPENAI_STT_MODEL=whisper-1

# Server
PORT=3001
NODE_ENV=development
```

### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_PROVIDER` | No | `lmstudio` | `lmstudio` or `gemini` |
| `LMSTUDIO_BASE_URL` | No | `http://localhost:1234/v1` | LM Studio server URL |
| `LMSTUDIO_MODEL` | No | auto | Model name in LM Studio |
| `GOOGLE_API_KEY` | If gemini | — | Google AI API key |
| `GOOGLE_MODEL` | No | `gemini-3.1-flash-lite-preview` | Gemini model name |
| `OPENAI_API_KEY` | Yes | — | OpenAI key (TTS/STT only) |
| `OPENAI_TTS_MODEL` | No | `tts-1` | TTS model |
| `OPENAI_TTS_VOICE` | No | `fable` | Voice: alloy, echo, fable, onyx, nova, shimmer |
| `OPENAI_STT_MODEL` | No | `whisper-1` | STT model |
| `PORT` | No | `3001` | Backend server port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `ALLOWED_ORIGINS` | Prod only | — | Comma-separated CORS origins |

---

## Development Mode

Runs the **Vite dev server** (port 5173, hot reload) and the **Express backend** (port 3001) concurrently. Vite proxies `/api/*` requests to the backend automatically.

### Start

```bash
cd react-app
npm run dev
```

This starts both servers. You can also run them individually:

```bash
npm run dev:client   # Vite only (port 5173)
npm run dev:server   # Express only (port 3001)
```

Open **https://localhost:5173** (accept the self-signed cert warning).

### Restart (both servers)

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null; lsof -ti:5173 | xargs kill -9 2>/dev/null; sleep 1 && cd react-app && npm run dev
```

### Restart backend only

Use this after editing `server/server.js` or `server/.env`:

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null; sleep 1 && cd react-app && npm run dev:server
```

---

## Production Mode

The Vite frontend is compiled into static files served directly by Express on a single port.

### Build + Start

```bash
cd react-app
npm run build
NODE_ENV=production node server/server.js
```

Or simply:

```bash
cd react-app
npm run build && npm start
```

The app is served at **https://localhost:3001** (single port — no Vite server needed).

### Restart (production)

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null; sleep 1 && cd react-app && NODE_ENV=production node server/server.js
```

---

## Accessing from Other Devices (Phone / Tablet)

Both servers bind to `0.0.0.0`, making them accessible on your local network.

- **Dev:** `https://<your-ip>:5173`
- **Prod:** `https://<your-ip>:3001`

You'll need to accept the self-signed certificate warning on the device. Make sure the SSL certificate was generated with your IP in the SAN (see setup step 2).

---

## LM Studio Notes

1. Open LM Studio and load a model (e.g., Qwen3.5-9B, Qwen3.5-35B-A3B)
2. Enable the local server — it should show "Running" at `http://127.0.0.1:1234`
3. Set `LMSTUDIO_MODEL` in `.env` to match the model identifier

**Thinking models** (Qwen3.5, etc.) use part of `max_tokens` for internal reasoning before producing visible output. If responses appear truncated, increase `max_tokens` in the `lmStudioClient.chat.completions.create()` call in `server/server.js`.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Server configuration error: API key not configured" | Ensure `server/.env` exists with a valid `OPENAI_API_KEY` |
| Camera not working | Allow camera permissions; HTTPS is required |
| Speech recognition not working | Use Chrome/Edge/Safari; allow mic permissions; HTTPS required |
| CORS errors | Make sure both servers are running; check `vite.config.js` proxy |
| Cannot connect to LM Studio | Ensure LM Studio is open with local server enabled and a model loaded |
| AI response is truncated or empty | Increase `max_tokens` in `server/server.js` (thinking models use tokens for reasoning) |
| Port already in use | `lsof -ti:3001 \| xargs kill -9` and/or `lsof -ti:5173 \| xargs kill -9` |
