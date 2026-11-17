# Vivica — Multi-Provider Voice Assistant

Vivica is a reactive voice-first AI assistant with a Lit + Three.js / Canvas frontend and an Express + WebSocket Node.js backend. All API keys and model/audio integrations run strictly on the server.

## Supported Providers

1. **Google AI (`google`)**
   - **Live Audio Models** (`gemini-3.8-live`, `gemini-3.8-live-extended-thinking`, `gemini-2.5-flash-native-audio-preview-09-2025`): Bidirectional real-time voice via `/live` WebSocket proxy.
   - **Text Streaming Models** (`gemini-4-hydrogen`, `gemini-3.1-flash-lite`): Server-side streaming via `POST /api/chat` paired with the STT/TTS speech pipeline.
   - Server env var: `GEMINI_API_KEY`

2. **OpenRouter (`openrouter`)**
   - Dynamic catalog fetched from `https://openrouter.ai/api/v1/models` with 5-minute server cache + manual refresh.
   - Displays provider, context length, and pricing metadata.
   - **Free Models Only** filter checks strict numeric pricing (`prompt == 0 && completion == 0 && request == 0`).
   - Server env var: `OPENROUTER_API_KEY`

3. **Local Ollama (`ollama`)**
   - Automatic model discovery via `GET /api/ollama/models` -> Ollama `/api/tags`.
   - Configurable host URL (default `http://127.0.0.1:11434`), validated by an SSRF guard allowing only loopback, private RFC1918 LAN, `.local`, or hosts listed in `ALLOWED_LOCAL_HOSTS`.
   - Direct streaming chat via `POST /api/chat` -> Ollama `/api/chat`.

## Local Speech Pipeline (STT & TTS)

For non-Live models (OpenRouter, Ollama, and Google text models), Vivica discovers server-side local speech engines at `GET /api/audio/engines`:

- **STT Engines (`POST /api/audio/transcribe`)**:
  - `whisper.cpp` (`WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`, `WHISPER_MODELS_DIR`)
  - `faster-whisper` (`WHISPER_PYTHON_BIN`, `FASTER_WHISPER_MODEL`, `WHISPER_MODELS_DIR`)
  - `whisper-http` (`LOCAL_STT_URL`)
  - Browser Web Speech API (explicitly labeled fallback)

- **TTS Engines (`POST /api/audio/synthesize`)**:
  - `piper` (`PIPER_BIN`, `PIPER_MODEL`, `PIPER_VOICES_DIR`)
  - `kokoro` (`KOKORO_URL` or `kokoro_onnx` + `KOKORO_MODEL` / `KOKORO_VOICES`)
  - `piper-http` (`LOCAL_TTS_URL`)
  - Browser `speechSynthesis` API (explicitly labeled fallback)

## Runtime & Deployment Note

Local Ollama, Whisper, Piper, and Kokoro run on the **backend server host**. When Vivica is accessed in a remote cloud preview, the server cannot reach binaries on your personal desktop unless you run Vivica locally or expose an explicitly allowed host (`ALLOWED_LOCAL_HOSTS`).

## Development

```bash
npm install
npm run dev
```
