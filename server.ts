import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { Modality, ThinkingLevel } from '@google/genai';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { LiveServerMessage, Session } from '@google/genai';
import {
  createGoogleGenAIClient,
  getGoogleApiKey,
} from './server/providers/google.ts';
import { getOpenRouterApiKey } from './server/providers/openrouter.ts';
import { getDefaultOllamaHost } from './server/providers/ollama.ts';
import { providerRegistry } from './server/providers/registry.ts';
import { validateLocalProviderUrl } from './server/url-validation.ts';
import {
  discoverAudioEngines,
  synthesizeSpeech,
  transcribeAudio,
} from './server/audio/engines.ts';
import type { ChatMessage, ProviderId } from './server/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load local environment files if present (host-injected env vars take precedence)
for (const envFile of ['.env.local', '.env']) {
  const envPath = path.join(__dirname, envFile);
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Ignore if already set or unreadable
    }
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const DEFAULT_MODEL = 'gemini-3.8-live';
const FALLBACK_MODELS = [
  'gemini-3.8-live',
  'gemini-2.5-flash-native-audio-preview-09-2025',
];
const DEPRECATED_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
]);

function createGeminiClient(apiVersion = 'v1beta') {
  return createGoogleGenAIClient(apiVersion);
}

interface ClientControlMessage {
  type: 'start' | 'audio' | 'stop';
  model?: string;
  voice?: string;
  systemPrompt?: string;
  audio?: string;
}

interface ServerControlMessage {
  type: 'open' | 'audio' | 'interrupted' | 'turnComplete' | 'status' | 'error' | 'closed';
  model?: string;
  audio?: string;
  interrupted?: boolean;
  message?: string;
  reason?: string;
  retryable?: boolean;
}

function sendJson(ws: WebSocket, payload: ServerControlMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function formatErrorMessage(rawMsg: string): { message: string; retryable: boolean } {
  const lower = rawMsg.toLowerCase();
  if (
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('api key not valid') ||
    lower.includes('403') ||
    lower.includes('401')
  ) {
    return {
      message: 'Gemini API key is invalid or missing. Please check Settings > Secrets.',
      retryable: false,
    };
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return {
      message: 'API quota reached • Retrying shortly…',
      retryable: true,
    };
  }
  if (
    lower.includes('unavailable') ||
    lower.includes('503') ||
    lower.includes('failed to fetch') ||
    lower.includes('not_found') ||
    lower.includes('404')
  ) {
    return {
      message: 'Voice service busy • Retrying in 4s…',
      retryable: true,
    };
  }
  return {
    message: rawMsg || 'Connection interrupted • Retrying…',
    retryable: true,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    const hasGoogleKey = Boolean(getGoogleApiKey());
    const hasOpenRouterKey = Boolean(getOpenRouterApiKey());
    res.json({
      ok: true,
      hasApiKey: hasGoogleKey,
      defaultOllamaHost: getDefaultOllamaHost(),
      providers: {
        google: hasGoogleKey,
        openrouter: hasOpenRouterKey,
        ollama: true,
      },
    });
  });

  app.get('/api/providers', async (req, res) => {
    try {
      const ollamaHost = typeof req.query.ollamaHost === 'string' ? req.query.ollamaHost : undefined;
      if (ollamaHost) {
        const check = validateLocalProviderUrl(ollamaHost, 'Ollama host');
        if (!check.valid) {
          res.status(400).json({ error: check.error || 'Invalid Ollama host URL.' });
          return;
        }
      }
      const forceRefresh = req.query.refresh === 'true';
      const statuses = await providerRegistry.getAllStatuses({ forceRefresh, ollamaHost });
      res.json({
        providers: statuses,
        defaultOllamaHost: getDefaultOllamaHost(),
      });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/providers/test', async (req, res) => {
    try {
      const { provider: providerId, ollamaHost } = (req.body || {}) as {
        provider?: string;
        ollamaHost?: string;
      };
      const provider = providerRegistry.getProvider(providerId || '');
      if (!provider) {
        res.status(400).json({ error: `Unknown provider: ${String(providerId || '')}` });
        return;
      }
      if (provider.id === 'ollama' && ollamaHost) {
        const check = validateLocalProviderUrl(ollamaHost, 'Ollama host');
        if (!check.valid) {
          res.status(400).json({ error: check.error || 'Invalid Ollama host URL.' });
          return;
        }
      }
      const status = await provider.testConnection({
        forceRefresh: true,
        ollamaHost,
      });
      res.json({ status });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/models', async (req, res) => {
    try {
      const providerFilter =
        typeof req.query.provider === 'string' ? req.query.provider : 'all';
      const forceRefresh = req.query.refresh === 'true';
      const ollamaHost =
        typeof req.query.ollamaHost === 'string' ? req.query.ollamaHost : undefined;

      if (ollamaHost) {
        const check = validateLocalProviderUrl(ollamaHost, 'Ollama host');
        if (!check.valid) {
          res.status(400).json({ error: check.error || 'Invalid Ollama host URL.' });
          return;
        }
      }

      if (
        providerFilter !== 'all' &&
        !providerRegistry.getProvider(providerFilter)
      ) {
        res.status(400).json({ error: `Unknown provider: ${providerFilter}` });
        return;
      }

      const result = await providerRegistry.listModels(providerFilter, {
        forceRefresh,
        ollamaHost,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/ollama/models', async (req, res) => {
    try {
      const customHost =
        typeof req.query.host === 'string'
          ? req.query.host
          : typeof req.query.ollamaHost === 'string'
            ? req.query.ollamaHost
            : undefined;

      if (customHost) {
        const check = validateLocalProviderUrl(customHost, 'Ollama host');
        if (!check.valid) {
          res.status(400).json({
            error: check.error || 'Invalid Ollama host URL.',
            models: [],
          });
          return;
        }
      }

      const ollama = providerRegistry.getProvider('ollama')!;
      const result = await ollama.listModels({
        forceRefresh: req.query.refresh === 'true',
        ollamaHost: customHost,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        models: [],
      });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const body = (req.body || {}) as {
      provider?: string;
      model?: string;
      messages?: ChatMessage[];
      systemPrompt?: string;
      ollamaHost?: string;
      stream?: boolean;
    };

    const provider = providerRegistry.getProvider(body.provider || '');
    if (!provider) {
      res.status(400).json({ error: `Unsupported provider: ${String(body.provider || '')}` });
      return;
    }

    if (!body.model || typeof body.model !== 'string') {
      res.status(400).json({ error: 'Model ID is required.' });
      return;
    }

    if (
      provider.id === 'google' &&
      (body.model.includes('live') || body.model.includes('native-audio'))
    ) {
      res.status(400).json({
        error: `Model "${body.model}" uses the bidirectional Live Audio WebSocket (/live), not text /api/chat.`,
      });
      return;
    }

    if (provider.id === 'ollama' && body.ollamaHost) {
      const check = validateLocalProviderUrl(body.ollamaHost, 'Ollama host');
      if (!check.valid) {
        res.status(400).json({ error: check.error || 'Invalid Ollama host URL.' });
        return;
      }
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const wantStream = body.stream !== false;
    const abortController = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let ended = false;
      await provider.streamChat(
        {
          provider: provider.id as ProviderId,
          model: body.model,
          messages,
          systemPrompt: body.systemPrompt,
          ollamaHost: body.ollamaHost,
        },
        (event) => {
          if (ended || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'done' || event.type === 'error') {
            ended = true;
            res.end();
          }
        },
        abortController.signal,
      );

      if (!ended && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      }
      return;
    }

    let fullText = '';
    let streamError: { message: string; code?: string } | null = null;
    await provider.streamChat(
      {
        provider: provider.id as ProviderId,
        model: body.model,
        messages,
        systemPrompt: body.systemPrompt,
        ollamaHost: body.ollamaHost,
      },
      (event) => {
        if (event.type === 'delta' && event.text) {
          fullText += event.text;
        } else if (event.type === 'error') {
          streamError = {
            message: event.message || 'Model inference error.',
            code: event.code,
          };
        }
      },
      abortController.signal,
    );

    if (streamError) {
      const errInfo = streamError as { message: string; code?: string };
      const status =
        errInfo.code === 'MISSING_API_KEY'
          ? 400
          : errInfo.code === 'HTTP_401'
            ? 401
            : errInfo.code === 'HTTP_429'
              ? 429
              : 502;
      res.status(status).json({ error: errInfo.message, code: errInfo.code });
      return;
    }

    res.json({
      provider: provider.id,
      model: body.model,
      text: fullText,
    });
  });

  app.get('/api/audio/engines', async (req, res) => {
    try {
      const refresh = req.query.refresh === 'true';
      const result = await discoverAudioEngines(refresh);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/audio/transcribe', async (req, res) => {
    try {
      const { engineId, model, audioBase64, mimeType } = (req.body || {}) as {
        engineId?: string;
        model?: string;
        audioBase64?: string;
        mimeType?: string;
      };
      if (!engineId || !audioBase64) {
        res.status(400).json({ error: 'engineId and audioBase64 are required.' });
        return;
      }
      const result = await transcribeAudio({
        engineId,
        model,
        audioBase64,
        mimeType,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/audio/synthesize', async (req, res) => {
    try {
      const { engineId, voice, text } = (req.body || {}) as {
        engineId?: string;
        voice?: string;
        text?: string;
      };
      if (!engineId || !text) {
        res.status(400).json({ error: 'engineId and text are required.' });
        return;
      }
      const result = await synthesizeSpeech({ engineId, voice, text });
      res.setHeader('Content-Type', result.contentType);
      res.send(result.audioBuffer);
    } catch (err: unknown) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/live') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (clientWs: WebSocket) => {
    let liveSession: Session | null = null;
    let sessionOpen = false;
    let clientClosed = false;
    let connectionGeneration = 0;

    const closeLiveSession = () => {
      sessionOpen = false;
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          // Ignore close errors
        }
        liveSession = null;
      }
    };

    const connectLive = async (
      requestedModel: string,
      voice: string,
      systemPrompt: string,
      attemptIndex = 0,
      generation = ++connectionGeneration,
    ) => {
      if (clientClosed || generation !== connectionGeneration) return;

      const ai = createGeminiClient();
      if (!ai) {
        sendJson(clientWs, {
          type: 'error',
          message: 'Server Gemini API key is not configured. Check Settings > Secrets.',
          retryable: false,
        });
        return;
      }

      const normalizedRequested =
        requestedModel && !DEPRECATED_MODELS.has(requestedModel)
          ? requestedModel
          : DEFAULT_MODEL;

      const modelsToTry = [normalizedRequested, ...FALLBACK_MODELS].filter(
        (m, idx, arr) => m && arr.indexOf(m) === idx,
      );

      const modelToUse = modelsToTry[attemptIndex % modelsToTry.length];

      closeLiveSession();

      let openedThisAttempt = false;
      let handledFailure = false;

      const config: Record<string, unknown> = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice || 'Aoede' },
          },
        },
      };

      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      if (modelToUse === 'gemini-3.8-live-extended-thinking') {
        config.thinkingConfig = {
          thinkingLevel: ThinkingLevel.LOW,
        };
      }

      try {
        const session = await ai.live.connect({
          model: modelToUse,
          config,
          callbacks: {
            onopen: () => {
              if (clientClosed || generation !== connectionGeneration) {
                try {
                  session.close();
                } catch {
                  // Ignore
                }
                return;
              }
              openedThisAttempt = true;
              sessionOpen = true;
              sendJson(clientWs, { type: 'open', model: modelToUse });
            },
            onmessage: (message: LiveServerMessage) => {
              if (clientClosed || generation !== connectionGeneration) return;

              for (const part of message.serverContent?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) {
                  sendJson(clientWs, {
                    type: 'audio',
                    audio: part.inlineData.data,
                  });
                }
              }

              if (message.serverContent?.interrupted) {
                sendJson(clientWs, {
                  type: 'interrupted',
                  interrupted: true,
                });
              }

              if (message.serverContent?.turnComplete) {
                sendJson(clientWs, { type: 'turnComplete' });
              }
            },
            onerror: (e: unknown) => {
              if (clientClosed || generation !== connectionGeneration || handledFailure) return;
              handledFailure = true;

              const rawMsg =
                e instanceof Error
                  ? e.message
                  : typeof e === 'object' && e !== null && 'message' in e
                    ? String((e as { message: unknown }).message)
                    : String(e || '');

              console.error('Gemini Live session error with model', modelToUse, rawMsg);
              closeLiveSession();

              const lower = rawMsg.toLowerCase();
              const canFallback =
                (lower.includes('unavailable') ||
                  lower.includes('503') ||
                  lower.includes('not_found') ||
                  lower.includes('404') ||
                  lower.includes('failed to fetch') ||
                  lower.includes('resource_exhausted')) &&
                attemptIndex < modelsToTry.length - 1;

              if (canFallback) {
                sendJson(clientWs, {
                  type: 'status',
                  message: 'Server busy • Trying alternative channel…',
                });
                setTimeout(() => {
                  connectLive(requestedModel, voice, systemPrompt, attemptIndex + 1, generation);
                }, 800);
                return;
              }

              const formatted = formatErrorMessage(rawMsg);
              sendJson(clientWs, {
                type: 'error',
                message: formatted.message,
                retryable: formatted.retryable,
              });
            },
            onclose: (e: { reason?: string }) => {
              if (clientClosed || generation !== connectionGeneration || handledFailure) return;
              sessionOpen = false;
              liveSession = null;
              if (!openedThisAttempt && attemptIndex < modelsToTry.length - 1) {
                handledFailure = true;
                sendJson(clientWs, {
                  type: 'status',
                  message: 'Switching to alternative channel…',
                });
                setTimeout(() => {
                  connectLive(requestedModel, voice, systemPrompt, attemptIndex + 1, generation);
                }, 800);
                return;
              }
              sendJson(clientWs, {
                type: 'closed',
                reason: e?.reason || '',
              });
            },
          },
        });

        if (clientClosed || generation !== connectionGeneration) {
          try {
            session.close();
          } catch {
            // Ignore
          }
          return;
        }

        liveSession = session;
      } catch (err: unknown) {
        if (clientClosed || generation !== connectionGeneration || handledFailure) return;
        handledFailure = true;

        const rawMsg = err instanceof Error ? err.message : String(err || '');
        console.error('Gemini Live connect failed with model', modelToUse, rawMsg);
        closeLiveSession();

        const lower = rawMsg.toLowerCase();
        const canFallback =
          (lower.includes('unavailable') ||
            lower.includes('503') ||
            lower.includes('not_found') ||
            lower.includes('404') ||
            lower.includes('failed to fetch')) &&
          attemptIndex < modelsToTry.length - 1;

        if (canFallback) {
          sendJson(clientWs, {
            type: 'status',
            message: 'Switching to alternative channel…',
          });
          setTimeout(() => {
            connectLive(requestedModel, voice, systemPrompt, attemptIndex + 1, generation);
          }, 800);
          return;
        }

        const formatted = formatErrorMessage(rawMsg);
        sendJson(clientWs, {
          type: 'error',
          message: formatted.message,
          retryable: formatted.retryable,
        });
      }
    };

    clientWs.on('message', (rawData) => {
      if (clientClosed) return;
      let msg: ClientControlMessage;
      try {
        msg = JSON.parse(rawData.toString()) as ClientControlMessage;
      } catch {
        return;
      }

      if (msg.type === 'start') {
        connectLive(
          msg.model || DEFAULT_MODEL,
          msg.voice || 'Aoede',
          msg.systemPrompt || '',
        );
      } else if (msg.type === 'audio' && msg.audio) {
        if (liveSession && sessionOpen) {
          try {
            liveSession.sendRealtimeInput({
              audio: {
                data: msg.audio,
                mimeType: 'audio/pcm;rate=16000',
              },
            });
          } catch (err) {
            console.warn('Failed forwarding audio frame to Gemini Live:', err);
          }
        }
      } else if (msg.type === 'stop') {
        connectionGeneration++;
        closeLiveSession();
      }
    });

    clientWs.on('close', () => {
      clientClosed = true;
      connectionGeneration++;
      closeLiveSession();
    });

    clientWs.on('error', () => {
      clientClosed = true;
      connectionGeneration++;
      closeLiveSession();
    });
  });

  const distDir = path.join(__dirname, 'dist');
  const isDev =
    process.env.NODE_ENV === 'development' ||
    (!fs.existsSync(path.join(distDir, 'index.html')) &&
      process.env.NODE_ENV !== 'production');

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === 'GET') {
        res.sendFile(path.join(distDir, 'index.html'));
      } else {
        next();
      }
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`Vivica server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Vivica server:', err);
  process.exit(1);
});
