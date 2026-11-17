import type { ModelProvider } from './base.ts';
import type {
  ChatCompletionRequest,
  ChatStreamEvent,
  ModelPricing,
  ProviderQueryOptions,
  ProviderStatus,
  UnifiedModelInfo,
} from '../types.ts';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface OpenRouterApiModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    request?: string | number;
    image?: string | number;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterApiModel[];
}

export function getOpenRouterApiKey(): string {
  return (process.env.OPENROUTER_API_KEY || '').trim();
}

export function isOpenRouterModelFree(pricing?: OpenRouterApiModel['pricing']): boolean {
  if (!pricing) return false;
  if (pricing.prompt === undefined || pricing.completion === undefined) {
    return false;
  }
  const promptCost = Number(pricing.prompt);
  const completionCost = Number(pricing.completion);
  const requestCost = pricing.request !== undefined ? Number(pricing.request) : 0;

  return (
    Number.isFinite(promptCost) &&
    Number.isFinite(completionCost) &&
    Number.isFinite(requestCost) &&
    promptCost === 0 &&
    completionCost === 0 &&
    requestCost === 0
  );
}

function formatSubProvider(modelId: string): string {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx <= 0) return 'OpenRouter';
  const raw = modelId.slice(0, slashIdx);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function normalizePricing(pricing?: OpenRouterApiModel['pricing']): ModelPricing | undefined {
  if (!pricing) return undefined;
  return {
    prompt: pricing.prompt !== undefined ? String(pricing.prompt) : undefined,
    completion: pricing.completion !== undefined ? String(pricing.completion) : undefined,
    request: pricing.request !== undefined ? String(pricing.request) : undefined,
    isFree: isOpenRouterModelFree(pricing),
  };
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = 'openrouter' as const;
  readonly label = 'OpenRouter';
  readonly hosting = 'cloud' as const;

  private cachedRawModels: OpenRouterApiModel[] | null = null;
  private cacheTimestamp = 0;

  private isCacheValid(): boolean {
    return (
      this.cachedRawModels !== null &&
      Date.now() - this.cacheTimestamp < CATALOG_CACHE_TTL_MS
    );
  }

  private async fetchCatalog(forceRefresh = false): Promise<{
    rawModels: OpenRouterApiModel[];
    cached: boolean;
    error?: string;
  }> {
    if (!forceRefresh && this.isCacheValid() && this.cachedRawModels) {
      return {
        rawModels: this.cachedRawModels,
        cached: true,
      };
    }

    const apiKey = getOpenRouterApiKey();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(
          `OpenRouter catalog returned HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 140)}` : ''}`,
        );
      }

      const json = (await response.json()) as OpenRouterModelsResponse;
      const list = Array.isArray(json.data) ? json.data : [];

      this.cachedRawModels = list;
      this.cacheTimestamp = Date.now();

      return {
        rawModels: list,
        cached: false,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Timed out fetching OpenRouter model catalog.'
          : err instanceof Error
            ? err.message
            : String(err);

      if (this.cachedRawModels) {
        return {
          rawModels: this.cachedRawModels,
          cached: true,
          error: message,
        };
      }

      return {
        rawModels: [],
        cached: false,
        error: message,
      };
    }
  }

  async getStatus(options?: ProviderQueryOptions): Promise<ProviderStatus> {
    const apiKey = getOpenRouterApiKey();
    const configured = Boolean(apiKey);
    const { rawModels, cached, error } = await this.fetchCatalog(options?.forceRefresh);

    let statusMessage = '';
    if (!configured && error) {
      statusMessage = `Missing OPENROUTER_API_KEY • Catalog error: ${error}`;
    } else if (!configured) {
      statusMessage = `Catalog loaded (${rawModels.length} models) • Set OPENROUTER_API_KEY on server for inference`;
    } else if (error && rawModels.length === 0) {
      statusMessage = `Catalog unreachable: ${error}`;
    } else if (error) {
      statusMessage = `Using cached catalog (${rawModels.length} models) • Refresh error: ${error}`;
    } else {
      statusMessage = `Connected • ${rawModels.length} models${cached ? ' (cached)' : ''}`;
    }

    return {
      id: this.id,
      label: this.label,
      hosting: this.hosting,
      configured,
      available: configured && rawModels.length > 0 && (!error || cached),
      statusMessage,
      error: !configured
        ? 'OPENROUTER_API_KEY is not configured in server environment.'
        : error,
      baseUrl: OPENROUTER_BASE_URL,
      modelCount: rawModels.length,
      lastCheckedAt: new Date().toISOString(),
      cached,
    };
  }

  async listModels(options?: ProviderQueryOptions): Promise<{
    models: UnifiedModelInfo[];
    status: ProviderStatus;
  }> {
    const apiKey = getOpenRouterApiKey();
    const configured = Boolean(apiKey);
    const { rawModels, cached, error } = await this.fetchCatalog(options?.forceRefresh);

    const models: UnifiedModelInfo[] = rawModels.map((m) => {
      const pricing = normalizePricing(m.pricing);
      const contextLength = m.context_length ?? m.top_provider?.context_length;
      return {
        id: m.id,
        name: m.name || m.id,
        provider: this.id,
        providerLabel: this.label,
        subProvider: formatSubProvider(m.id),
        hosting: this.hosting,
        contextLength,
        pricing,
        description: m.description,
        supportsStreaming: true,
        supportsNativeAudio: false,
        available: configured,
        unavailableReason: configured
          ? undefined
          : 'Set OPENROUTER_API_KEY on the server to enable OpenRouter models.',
      };
    });

    const status: ProviderStatus = {
      id: this.id,
      label: this.label,
      hosting: this.hosting,
      configured,
      available: configured && models.length > 0,
      statusMessage: !configured
        ? `Catalog loaded (${models.length} models) • Set OPENROUTER_API_KEY on server to enable`
        : error && models.length === 0
          ? `OpenRouter unavailable: ${error}`
          : `Ready • ${models.length} models${cached ? ' (cached)' : ''}`,
      error: !configured
        ? 'OPENROUTER_API_KEY is not set in server environment.'
        : error,
      baseUrl: OPENROUTER_BASE_URL,
      modelCount: models.length,
      lastCheckedAt: new Date().toISOString(),
      cached,
    };

    return { models, status };
  }

  async testConnection(options?: ProviderQueryOptions): Promise<ProviderStatus> {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: false,
        available: false,
        statusMessage: 'OPENROUTER_API_KEY is missing on the server',
        error: 'Configure OPENROUTER_API_KEY in server environment variables.',
        baseUrl: OPENROUTER_BASE_URL,
        modelCount: this.cachedRawModels?.length ?? 0,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const keyResp = await fetch(`${OPENROUTER_BASE_URL}/auth/key`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (keyResp.status === 401 || keyResp.status === 403) {
        return {
          id: this.id,
          label: this.label,
          hosting: this.hosting,
          configured: true,
          available: false,
          statusMessage: 'OpenRouter API key rejected (Unauthorized)',
          error: 'Verify OPENROUTER_API_KEY on the server.',
          baseUrl: OPENROUTER_BASE_URL,
          modelCount: this.cachedRawModels?.length ?? 0,
          lastCheckedAt: new Date().toISOString(),
        };
      }

      const { rawModels, error } = await this.fetchCatalog(options?.forceRefresh ?? true);
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: true,
        available: keyResp.ok && rawModels.length > 0,
        statusMessage: keyResp.ok
          ? `OpenRouter verified • ${rawModels.length} models`
          : `OpenRouter returned HTTP ${keyResp.status}`,
        error: keyResp.ok ? error : `HTTP ${keyResp.status}`,
        baseUrl: OPENROUTER_BASE_URL,
        modelCount: rawModels.length,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: this.id,
        label: this.label,
        hosting: this.hosting,
        configured: true,
        available: false,
        statusMessage: 'Unable to reach OpenRouter',
        error: message,
        baseUrl: OPENROUTER_BASE_URL,
        modelCount: this.cachedRawModels?.length ?? 0,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  async streamChat(
    request: ChatCompletionRequest,
    onChunk: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      onChunk({
        type: 'error',
        code: 'MISSING_API_KEY',
        message: 'OPENROUTER_API_KEY is not configured on the server.',
      });
      return;
    }

    if (!request.model) {
      onChunk({ type: 'error', message: 'No OpenRouter model selected.' });
      return;
    }

    const messages = [
      ...(request.systemPrompt
        ? [{ role: 'system' as const, content: request.systemPrompt }]
        : []),
      ...request.messages.filter((m) => m.role !== 'system' && m.content.trim().length > 0),
    ];

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 45000);
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Vivica Voice Assistant',
        },
        body: JSON.stringify({
          model: request.model,
          messages,
          stream: true,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        let errDetail = `OpenRouter error (HTTP ${response.status})`;
        try {
          const errJson = (await response.json()) as { error?: { message?: string } };
          if (errJson?.error?.message) {
            errDetail = errJson.error.message;
          }
        } catch {
          // Ignore JSON parse fallback
        }
        if (response.status === 401) {
          errDetail = 'OpenRouter rejected OPENROUTER_API_KEY (401 Unauthorized).';
        } else if (response.status === 402) {
          errDetail = 'OpenRouter account has insufficient credits for this model (402).';
        } else if (response.status === 429) {
          errDetail = 'OpenRouter rate limit reached (429). Try another model or wait briefly.';
        }
        onChunk({ type: 'error', message: errDetail, code: `HTTP_${response.status}` });
        return;
      }

      if (!response.body) {
        onChunk({ type: 'error', message: 'Empty response stream from OpenRouter.' });
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
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            onChunk({ type: 'done' });
            return;
          }

          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              error?: { message?: string };
            };
            if (parsed.error?.message) {
              onChunk({ type: 'error', message: parsed.error.message });
              return;
            }
            const deltaText = parsed.choices?.[0]?.delta?.content;
            if (deltaText) {
              onChunk({ type: 'delta', text: deltaText });
            }
          } catch {
            // Skip partial JSON frames
          }
        }
      }

      onChunk({ type: 'done' });
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? 'OpenRouter request timed out or was cancelled.'
          : err instanceof Error
            ? err.message
            : String(err);
      onChunk({ type: 'error', message: msg });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
