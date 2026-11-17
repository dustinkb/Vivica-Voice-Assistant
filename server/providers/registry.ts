import { GoogleProvider } from './google.ts';
import { OpenRouterProvider } from './openrouter.ts';
import { OllamaProvider } from './ollama.ts';
import type { ModelProvider } from './base.ts';
import type {
  ProviderId,
  ProviderQueryOptions,
  ProviderStatus,
  UnifiedModelInfo,
} from '../types.ts';

export class ProviderRegistry {
  private readonly providers: Record<ProviderId, ModelProvider>;

  constructor() {
    this.providers = {
      google: new GoogleProvider(),
      openrouter: new OpenRouterProvider(),
      ollama: new OllamaProvider(),
    };
  }

  getProvider(id: string): ModelProvider | undefined {
    if (id === 'google' || id === 'openrouter' || id === 'ollama') {
      return this.providers[id];
    }
    return undefined;
  }

  getAllProviders(): ModelProvider[] {
    return [this.providers.google, this.providers.openrouter, this.providers.ollama];
  }

  async getAllStatuses(options?: ProviderQueryOptions): Promise<ProviderStatus[]> {
    return Promise.all(
      this.getAllProviders().map((provider) => provider.getStatus(options)),
    );
  }

  async listModels(
    providerFilter?: string,
    options?: ProviderQueryOptions,
  ): Promise<{
    models: UnifiedModelInfo[];
    providers: ProviderStatus[];
    fetchedAt: string;
  }> {
    if (providerFilter && providerFilter !== 'all') {
      const target = this.getProvider(providerFilter);
      if (!target) {
        throw new Error(`Unknown provider: ${providerFilter}`);
      }
      const { models, status } = await target.listModels(options);
      return {
        models,
        providers: [status],
        fetchedAt: new Date().toISOString(),
      };
    }

    const results = await Promise.all(
      this.getAllProviders().map((provider) => provider.listModels(options)),
    );

    return {
      models: results.flatMap((r) => r.models),
      providers: results.map((r) => r.status),
      fetchedAt: new Date().toISOString(),
    };
  }
}

export const providerRegistry = new ProviderRegistry();
