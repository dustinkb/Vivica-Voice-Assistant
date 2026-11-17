import type {
  ChatCompletionRequest,
  ChatStreamEvent,
  HostingType,
  ProviderId,
  ProviderQueryOptions,
  ProviderStatus,
  UnifiedModelInfo,
} from '../types.ts';

export interface ModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly hosting: HostingType;

  getStatus(options?: ProviderQueryOptions): Promise<ProviderStatus>;

  listModels(options?: ProviderQueryOptions): Promise<{
    models: UnifiedModelInfo[];
    status: ProviderStatus;
  }>;

  testConnection(options?: ProviderQueryOptions): Promise<ProviderStatus>;

  streamChat(
    request: ChatCompletionRequest,
    onChunk: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}
