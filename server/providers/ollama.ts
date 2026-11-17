import { validateLocalProviderUrl } from '../url-validation.ts';
import type { ModelProvider } from './base.ts';
import type {
  ChatCompletionRequest,
  ChatStreamEvent,
  ProviderQueryOptions,
  ProviderStatus,
  UnifiedModelInfo,
} from '../types.ts';

interface OllamaTagModel {
  name: string;
  model?: string;
  size?: number;
  modified_at?: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

export function getDefaultOllamaHost(): string {
  return (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
}

function formatBytes(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes)) return undefined;
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama (Local)';
  readonly hosting = 'local' as const;

  private resolveHost(customHost?: string): {
    ok: boolean;
    baseUrl?: string;
    error?: string;
  } {
    const raw = (customHost || '').trim() || getDefaultOllamaHost();
    const validation = validateLocalProviderUrl(raw, 'Ollama host');
    if (!validation.valid || !validation.normalizedUrl) {
      return { ok: false, error: validation.error || 'Invalid Ollama host URL.' };
    }
    return { ok: true, baseUrl: validation.normalizedUrl };
  }

  private async fetchTags(baseUrl: string): Promise<{
    models: OllamaTagModel[];
    error?: string;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        return {
          models: [],
          error: `Ollama returned HTTP ${response.status} at ${baseUrl}.`,
        };
      }

      const data = (await response.json()) as OllamaTagsResponse;
      return {
        models: Array.isArray(data.models) ? data.models : [],
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const detail = err instanceof Error ? err.message : String(err);
      const msg = isTimeout
        ? `Timed out reaching Ollama at ${baseUrl}.`
        : `Ollama not reachable at ${baseUrl} (${detail}). Start Ollama or set OLLAMA_HOST.`;
      return {
        models: [],
        error: msg,
      };
    }
  }

  async getStatus(options?: ProviderQueryOptions): Promise<ProviderStatus> {
    const resolved = this.resolveHost(options?.ollamaHost);
    if (!resolved.ok || !resolved.baseUrl) {
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: false,
        available: false,
        statusMessage: resolved.error || 'Invalid Ollama host',
        error: resolved.error,
        modelCount: 0,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    const { models, error } = await this.fetchTags(resolved.baseUrl);
    return {
      id: this.id,
      label: this.label,
      hosting: this.hosting,
      configured: true,
      available: !error,
      statusMessage: error
        ? `Ollama unavailable at ${resolved.baseUrl}`
        : models.length > 0
          ? `Connected to ${resolved.baseUrl} • ${models.length} local model(s)`
          : `Connected to ${resolved.baseUrl} • No models installed (run \`ollama pull <model>\`)`,
      error,
      baseUrl: resolved.baseUrl,
      modelCount: models.length,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async listModels(options?: ProviderQueryOptions): Promise<{
    models: UnifiedModelInfo[];
    status: ProviderStatus;
  }> {
    const resolved = this.resolveHost(options?.ollamaHost);
    if (!resolved.ok || !resolved.baseUrl) {
      return {
        models: [],
        status: {
          id: this.id,
          label: this.label,
          hosting: this.hosting,
          configured: false,
          available: false,
          statusMessage: resolved.error || 'Invalid Ollama host',
          error: resolved.error,
          modelCount: 0,
          lastCheckedAt: new Date().toISOString(),
        },
      };
    }

    const { models: rawModels, error } = await this.fetchTags(resolved.baseUrl);
    const models: UnifiedModelInfo[] = rawModels.map((m) => {
      const sizeStr = formatBytes(m.size);
      const paramStr = m.details?.parameter_size;
      const quantStr = m.details?.quantization_level;
      const parts = [m.details?.family, paramStr, quantStr, sizeStr].filter(Boolean);

      return {
        id: m.name,
        name: m.name,
        provider: this.id,
        providerLabel: this.label,
        subProvider: m.details?.family || 'Local',
        hosting: this.hosting,
        sizeBytes: m.size,
        parameterSize: paramStr,
        quantization: quantStr,
        description: parts.length > 0 ? parts.join(' • ') : 'Locally hosted Ollama model',
        supportsStreaming: true,
        supportsNativeAudio: false,
        available: true,
      };
    });

    const status: ProviderStatus = {
      id: this.id,
      label: this.label,
      hosting: this.hosting,
      configured: true,
      available: !error,
      statusMessage: error
        ? `Ollama offline (${resolved.baseUrl})`
        : models.length > 0
          ? `Connected • ${models.length} local model(s)`
          : `Connected • No models pulled yet`,
      error,
      baseUrl: resolved.baseUrl,
      modelCount: models.length,
      lastCheckedAt: new Date().toISOString(),
    };

    return { models, status };
  }

  async testConnection(options?: ProviderQueryOptions): Promise<ProviderStatus> {
    return this.getStatus(options);
  }

  async streamChat(
    request: ChatCompletionRequest,
    onChunk: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const resolved = this.resolveHost(request.ollamaHost);
    if (!resolved.ok || !resolved.baseUrl) {
      onChunk({
        type: 'error',
        code: 'INVALID_HOST',
        message: resolved.error || 'Invalid Ollama host configuration.',
      });
      return;
    }

    if (!request.model) {
      onChunk({ type: 'error', message: 'No local Ollama model selected.' });
      return;
    }

    const messages = [
      ...(request.systemPrompt
        ? [{ role: 'system' as const, content: request.systemPrompt }]
        : []),
      ...request.messages.filter((m) => m.role !== 'system' && m.content.trim().length > 0),
    ];

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 60000);
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(`${resolved.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages,
          stream: true,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        let errDetail = `Ollama error (HTTP ${response.status})`;
        try {
          const errJson = (await response.json()) as { error?: string };
          if (errJson?.error) {
            errDetail = errJson.error;
          }
        } catch {
          // Ignore
        }
        onChunk({ type: 'error', message: errDetail, code: `HTTP_${response.status}` });
        return;
      }

      if (!response.body) {
        onChunk({ type: 'error', message: 'Empty stream from Ollama.' });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
              error?: string;
            };
            if (parsed.error) {
              onChunk({ type: 'error', message: parsed.error });
              return;
            }
            if (parsed.message?.content) {
              onChunk({ type: 'delta', text: parsed.message.content });
            }
            if (parsed.done) {
              onChunk({ type: 'done' });
              return;
            }
          } catch {
            // Skip malformed NDJSON chunk
          }
        }
      }

      onChunk({ type: 'done' });
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? `Ollama request timed out or was cancelled (${resolved.baseUrl}).`
          : `Unable to reach Ollama at ${resolved.baseUrl}: ${err instanceof Error ? err.message : String(err)}`;
      onChunk({ type: 'error', message: msg });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
