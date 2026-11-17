export type ProviderId = 'google' | 'openrouter' | 'ollama';
export type HostingType = 'cloud' | 'local';

export interface ModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  isFree: boolean;
}

export interface UnifiedModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  providerLabel: string;
  subProvider?: string;
  hosting: HostingType;
  contextLength?: number;
  pricing?: ModelPricing;
  description?: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  supportsStreaming: boolean;
  supportsNativeAudio: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  hosting: HostingType;
  configured: boolean;
  available: boolean;
  statusMessage: string;
  error?: string;
  baseUrl?: string;
  modelCount: number;
  lastCheckedAt: string;
  cached?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AudioModelOption {
  id: string;
  name: string;
  path?: string;
  sizeBytes?: number;
  metadata?: string;
}

export interface AudioEngineInfo {
  id: string;
  kind: 'stt' | 'tts';
  name: string;
  hosting: HostingType;
  installed: boolean;
  available: boolean;
  statusMessage: string;
  binaryPath?: string;
  serviceUrl?: string;
  models: AudioModelOption[];
  installHint?: string;
}

export interface AudioDiscoveryResult {
  stt: AudioEngineInfo[];
  tts: AudioEngineInfo[];
  checkedAt: string;
  runtimeNote: string;
}
