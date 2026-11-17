import { GoogleGenAI } from '@google/genai';
import type { ModelProvider } from './base.ts';
import type {
  ChatCompletionRequest,
  ChatStreamEvent,
  ProviderQueryOptions,
  ProviderStatus,
  UnifiedModelInfo,
} from '../types.ts';

const GOOGLE_MODELS: Omit<UnifiedModelInfo, 'available' | 'unavailableReason'>[] = [
  {
    id: 'gemini-3.8-live',
    name: 'Gemini 3.8 Live',
    provider: 'google',
    providerLabel: 'Google AI',
    subProvider: 'Google',
    hosting: 'cloud',
    contextLength: 128000,
    description: 'Low-latency native speech-to-speech Live Voice model (Recommended)',
    supportsStreaming: true,
    supportsNativeAudio: true,
  },
  {
    id: 'gemini-3.8-live-extended-thinking',
    name: 'Gemini 3.8 Live (Extended Thinking)',
    provider: 'google',
    providerLabel: 'Google AI',
    subProvider: 'Google',
    hosting: 'cloud',
    contextLength: 128000,
    description: 'Live Voice with reasoning depth for complex multi-step tasks',
    supportsStreaming: true,
    supportsNativeAudio: true,
  },
  {
    id: 'gemini-2.5-flash-native-audio-preview-09-2025',
    name: 'Gemini 2.5 Flash Native Audio',
    provider: 'google',
    providerLabel: 'Google AI',
    subProvider: 'Google',
    hosting: 'cloud',
    contextLength: 128000,
    description: 'Native audio Live Voice preview channel',
    supportsStreaming: true,
    supportsNativeAudio: true,
  },
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    provider: 'google',
    providerLabel: 'Google AI',
    subProvider: 'Google',
    hosting: 'cloud',
    contextLength: 1000000,
    description: 'Fast general-purpose Gemini 4 text model (uses STT/TTS pipeline for voice)',
    supportsStreaming: true,
    supportsNativeAudio: false,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    provider: 'google',
    providerLabel: 'Google AI',
    subProvider: 'Google',
    hosting: 'cloud',
    contextLength: 1000000,
    description: 'Ultra-fast lightweight Gemini model (uses STT/TTS pipeline for voice)',
    supportsStreaming: true,
    supportsNativeAudio: false,
  },
];

export function getGoogleApiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
}

export function createGoogleGenAIClient(apiVersion = 'v1beta'): GoogleGenAI | null {
  const apiKey = getGoogleApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export class GoogleProvider implements ModelProvider {
  readonly id = 'google' as const;
  readonly label = 'Google AI';
  readonly hosting = 'cloud' as const;

  async getStatus(_options?: ProviderQueryOptions): Promise<ProviderStatus> {
    const apiKey = getGoogleApiKey();
    const configured = Boolean(apiKey);
    return {
      id: this.id,
      label: this.label,
      hosting: this.hosting,
      configured,
      available: configured,
      statusMessage: configured
        ? 'Connected via server GEMINI_API_KEY'
        : 'GEMINI_API_KEY is not configured in server environment',
      error: configured ? undefined : 'Missing GEMINI_API_KEY in Settings > Secrets.',
      modelCount: GOOGLE_MODELS.length,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async listModels(options?: ProviderQueryOptions): Promise<{
    models: UnifiedModelInfo[];
    status: ProviderStatus;
  }> {
    const status = await this.getStatus(options);
    const models: UnifiedModelInfo[] = GOOGLE_MODELS.map((m) => ({
      ...m,
      available: status.available,
      unavailableReason: status.available ? undefined : status.error,
    }));
    return { models, status };
  }

  async testConnection(_options?: ProviderQueryOptions): Promise<ProviderStatus> {
    const apiKey = getGoogleApiKey();
    if (!apiKey) {
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: false,
        available: false,
        statusMessage: 'Missing GEMINI_API_KEY on server',
        error: 'Set GEMINI_API_KEY in Settings > Secrets.',
        modelCount: GOOGLE_MODELS.length,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    try {
      const ai = createGoogleGenAIClient('v1beta');
      if (!ai) throw new Error('Failed to initialize GoogleGenAI client');
      await ai.models.list({ config: { pageSize: 1 } });
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: true,
        available: true,
        statusMessage: 'Google AI connection verified',
        modelCount: GOOGLE_MODELS.length,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: true,
        available: false,
        statusMessage: 'Google AI connection failed',
        error: message,
        modelCount: GOOGLE_MODELS.length,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  async streamChat(
    request: ChatCompletionRequest,
    onChunk: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const ai = createGoogleGenAIClient('v1beta');
    if (!ai) {
      onChunk({
        type: 'error',
        code: 'MISSING_API_KEY',
        message: 'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.',
      });
      return;
    }

    const model = request.model || 'gemini-4-hydrogen';
    const contents = request.messages
      .filter((m) => m.role !== 'system' && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    if (contents.length === 0) {
      onChunk({ type: 'error', message: 'No message content provided.' });
      return;
    }

    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: request.systemPrompt
          ? { systemInstruction: request.systemPrompt }
          : undefined,
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          onChunk({ type: 'delta', text: chunk.text });
        }
      }
      onChunk({ type: 'done' });
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : String(err);
      try {
        const parsed = JSON.parse(msg) as { error?: { message?: string } };
        if (parsed?.error?.message) {
          try {
            const inner = JSON.parse(parsed.error.message) as { error?: { message?: string } };
            msg = inner?.error?.message || parsed.error.message;
          } catch {
            msg = parsed.error.message;
          }
        }
      } catch {
        // Keep original message if not JSON
      }
      onChunk({ type: 'error', message: msg });
    }
  }
}
