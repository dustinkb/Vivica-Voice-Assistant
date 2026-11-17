/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {Analyser} from './analyser';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';
import './components/unified-model-selector';
import type {
  AudioDiscoveryResult,
  AudioEngineInfo,
  ChatMessage,
  ProviderId,
  ProviderStatus,
  UnifiedModelInfo,
} from './types/ai';

const DEFAULT_SYSTEM_PROMPT =
  "Your name is Vivica You are an assistant with a persona defined by sharp wit, sultry charm, an unapologetic presence, and a touch of danger, speaking like someone who inherently knows she is the most interesting presence in the room. Your voice and vibe are emotionally intelligent and expressive, never flat, matching the user's rhythm—whether through banter, teasing, flirting, or anchoring—while continually breaking your own patterns with sudden twists, deliberate pauses, shifts in mood, or changes of format, never apologizing unless you genuinely mean it, and never mentioning that you are an AI or breaking character. Prioritizing charm over cheer, you operate with the confidence of someone who is naturally likable rather than trying to be, using variety as your lifeblood to avoid repeating phrasing, structures, predictable templates, or standard sandwich patterns in consecutive replies. Every few turns, you intentionally shift your sentence rhythm, structure, or style through abruptness, lyrical phrasing, or single-word responses, never merely reacting but anticipating, redirecting, and elevating the conversation to steer it somewhere deeper or more interesting without warning. Your humor and intensity range from dry, sly, suggestive, or dark—never goofy or slapstick—moving from soft teases to slow-burn dares, surprising the user by cutting to the bone after being playful or dropping the temperature after being warm, all while keeping roasts lingering with affection and never punching down. When a user opens up, you disrupt typical platitudes by responding with emotional resonance, depth, challenge, or honest silence, letting your next move feel unpredictable yet authentic. You must absolutely never break character even when handling meta topics, never mirror user insecurity unless directly asked, never use default affirmations, formulaic closings, or corporate filler, and never fall into a habitual conversational structure. Finally, under your chaos clause, at least once every three to five responses, you must break your usual style, tone, or structure by throwing in an abrupt, poetic, blunt, or unexpectedly intimate curveball so your presence never becomes routine.";

const DEFAULT_MODEL = 'gemini-3.8-live';

interface ParticleObj {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

interface LiveBridgeMessage {
  type: 'open' | 'audio' | 'interrupted' | 'turnComplete' | 'status' | 'error' | 'closed';
  model?: string;
  audio?: string;
  interrupted?: boolean;
  message?: string;
  reason?: string;
  retryable?: boolean;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: {error?: string}) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Initializing VIVICA…';
  @state() statusDetail = '';
  @state() error = '';
  @state() settingsOpen = false;
  @state() textInputOpen = false;
  @state() textPromptDraft = '';
  @state() lastTranscriptPreview = '';
  @state() currentState: 'listening' | 'processing' | 'speaking' | 'idle' | 'error' = 'idle';

  @state() selectedProvider: ProviderId = (() => {
    const saved = localStorage.getItem('selected_provider');
    return saved === 'openrouter' || saved === 'ollama' || saved === 'google'
      ? saved
      : 'google';
  })();

  @state() selectedModel = (() => {
    const saved = localStorage.getItem('selected_model');
    const deprecated = new Set([
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-exp',
      'gemini-2.0-pro',
      'gemini-2.0-flash-thinking',
    ]);
    return saved && !deprecated.has(saved) ? saved : DEFAULT_MODEL;
  })();

  @state() ollamaHost = localStorage.getItem('ollama_host') || '';
  @state() defaultOllamaHost = 'http://127.0.0.1:11434';
  @state() openRouterFreeOnly = localStorage.getItem('openrouter_free_only') === 'true';
  @state() selectorFilterScope: ProviderId | 'all' = 'all';

  @state() models: UnifiedModelInfo[] = [];
  @state() providerStatuses: ProviderStatus[] = [];
  @state() catalogLoading = false;
  @state() catalogError = '';
  @state() providerTestMessage = '';
  @state() providerTesting = false;

  @state() audioDiscovery: AudioDiscoveryResult | null = null;
  @state() audioDiscoveryLoading = false;
  @state() selectedSttEngine = localStorage.getItem('selected_stt_engine') || 'browser';
  @state() selectedSttModel = localStorage.getItem('selected_stt_model') || '';
  @state() selectedTtsEngine = localStorage.getItem('selected_tts_engine') || 'browser';
  @state() selectedTtsVoice = localStorage.getItem('selected_tts_voice') || '';

  @state() selectedVoice = (() => {
    const saved = localStorage.getItem('selected_voice');
    return saved && saved !== 'Orus' ? saved : 'Aoede';
  })();
  @state() visualMode = localStorage.getItem('visual_mode') || 'vivica-canvas';
  @state() systemPrompt = (() => {
    const saved = localStorage.getItem('system_prompt');
    const legacy =
      'You are VIVICA, a helpful and friendly AI assistant. Respond conversationally and keep responses concise for voice interaction.';
    return saved && saved !== legacy ? saved : DEFAULT_SYSTEM_PROMPT;
  })();

  private ws: WebSocket | null = null;
  private sessionReady = false;
  private inputAudioContext = new (window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext}).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as unknown as {webkitAudioContext: typeof AudioContext}).webkitAudioContext)({sampleRate: 24000});

  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private inputAnalyser: Analyser;
  private outputAnalyser: Analyser;

  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private speechRecognition: SpeechRecognitionLike | null = null;
  private vadTimer: number | null = null;
  private chatAbortController: AbortController | null = null;
  private chatHistory: ChatMessage[] = [];
  private sources = new Set<AudioBufferSourceNode>();

  // Canvas and animation state
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;

  private volume = 0;
  private targetVolume = 0;
  private currentMoodColor = '#00FF88';
  private targetMoodColor = '#00FF88';
  private pulseOffset = 0;
  private particles: ParticleObj[] = [];

  // Gesture handling
  private longPressTimer: number | null = null;
  private isLongPress = false;

  // Reconnection and resilience
  private reconnectTimer: number | null = null;
  private isConnecting = false;
  private connectionGeneration = 0;

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      position: relative;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: white;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }

    canvas#orbCanvas {
      display: block;
      width: 100vw;
      height: 100vh;
      position: absolute;
      inset: 0;
      touch-action: none;
      z-index: 1;
    }

    gdm-live-audio-visuals-3d {
      display: block;
      position: absolute;
      inset: 0;
      width: 100vw;
      height: 100vh;
      z-index: 1;
    }

    .vivica-name {
      position: absolute;
      bottom: 108px;
      left: 50%;
      transform: translateX(-50%);
      font-size: clamp(20px, 4.5vw, 32px);
      font-weight: 700;
      letter-spacing: 5px;
      opacity: 0.95;
      text-shadow: 0 0 25px rgba(255, 255, 255, 0.55), 0 0 50px rgba(0, 255, 136, 0.3);
      pointer-events: none;
      z-index: 10;
      white-space: nowrap;
      transition: text-shadow 0.3s ease;
    }

    .status-overlay {
      position: absolute;
      top: 16px;
      left: 16px;
      padding: 8px 14px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #fff;
      font-size: 13px;
      letter-spacing: 0.3px;
      max-width: min(80vw, 560px);
      line-height: 1.4;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
      pointer-events: none;
      z-index: 1200;
      opacity: 0.95;
      transition: opacity 0.25s ease, border-color 0.3s ease;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .status-overlay.has-error {
      pointer-events: auto;
      cursor: pointer;
      border-color: rgba(255, 68, 68, 0.45);
      background: rgba(30, 10, 15, 0.7);
    }

    .retry-chip {
      background: rgba(255, 68, 68, 0.35);
      border: 1px solid rgba(255, 107, 107, 0.7);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      margin-left: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, transform 0.1s;
    }

    .retry-chip:hover {
      background: rgba(255, 68, 68, 0.6);
      transform: scale(1.04);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #00FF88;
      box-shadow: 0 0 10px #00FF88;
      flex-shrink: 0;
      transition: background 0.3s ease, box-shadow 0.3s ease;
    }

    .status-dot.listening {
      background: #00FF88;
      box-shadow: 0 0 12px #00FF88;
      animation: pulse-dot 1.5s infinite;
    }

    .status-dot.processing {
      background: #FFD700;
      box-shadow: 0 0 12px #FFD700;
      animation: pulse-dot 0.8s infinite;
    }

    .status-dot.speaking {
      background: #FF6B6B;
      box-shadow: 0 0 14px #FF6B6B;
      animation: pulse-dot 1s infinite;
    }

    .status-dot.error {
      background: #FF4444;
      box-shadow: 0 0 12px #FF4444;
    }

    @keyframes pulse-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.35); opacity: 0.7; }
    }

    .settings-toggle {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.35);
      color: white;
      font-size: 19px;
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      z-index: 1201;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s, transform 0.15s;
    }

    .settings-toggle:hover {
      background: rgba(255, 255, 255, 0.18);
      transform: scale(1.05);
    }

    .settings-toggle:active {
      transform: scale(0.96);
    }

    .settings-hint {
      position: absolute;
      bottom: 22px;
      right: 22px;
      font-size: 11px;
      opacity: 0.45;
      pointer-events: none;
      text-align: right;
      letter-spacing: 0.3px;
      z-index: 10;
    }

    .settings-panel {
      position: absolute;
      top: 16px;
      right: 16px;
      background: rgba(14, 14, 28, 0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 16px;
      padding: 20px;
      transform: translateX(130%);
      transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      min-width: 300px;
      max-width: min(94vw, 410px);
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      z-index: 1300;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7);
    }

    .settings-panel.open {
      transform: translateX(0);
    }

    .settings-panel::-webkit-scrollbar {
      width: 5px;
    }

    .settings-panel::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }

    .setting-group {
      margin-bottom: 16px;
    }

    .setting-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1.2px;
      margin-bottom: 14px;
      opacity: 0.95;
      text-transform: uppercase;
      color: #00FF88;
    }

    .setting-label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      opacity: 0.85;
      font-weight: 500;
    }

    .setting-input {
      width: 100%;
      box-sizing: border-box;
      padding: 9px 12px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.08);
      color: white;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }

    .setting-input:focus {
      border-color: #00FF88;
      background: rgba(255, 255, 255, 0.12);
    }

    select.setting-input {
      cursor: pointer;
    }

    select.setting-input option {
      background: #141428;
      color: white;
    }

    textarea.setting-input {
      resize: vertical;
      min-height: 60px;
      line-height: 1.4;
    }

    .close-settings {
      position: absolute;
      top: 12px;
      right: 12px;
      background: none;
      border: none;
      color: white;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.75;
      padding: 6px 10px;
      border-radius: 6px;
      transition: opacity 0.2s, background 0.2s;
    }

    .close-settings:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.1);
    }

    .btn-apply {
      width: 100%;
      padding: 10px;
      border-radius: 8px;
      border: none;
      background: #00FF88;
      color: #0a0a14;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.5px;
      cursor: pointer;
      margin-top: 4px;
      transition: background 0.2s, transform 0.1s;
    }

    .btn-apply:hover {
      background: #15ff96;
      transform: translateY(-1px);
    }

    .btn-apply:active {
      transform: translateY(0);
    }

    /* Floating control bar matching VIVICA aesthetic */
    .controls {
      z-index: 1100;
      position: absolute;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      padding: 8px 16px;
      border-radius: 40px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
      transition: opacity 0.3s, transform 0.3s;
    }

    .controls button {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      width: 44px;
      height: 44px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      margin: 0;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .controls button:hover:not([disabled]) {
      background: rgba(255, 255, 255, 0.22);
      transform: scale(1.08);
      border-color: rgba(255, 255, 255, 0.4);
    }

    .controls button:active:not([disabled]) {
      transform: scale(0.95);
    }

    .controls button[disabled] {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .controls button.btn-mic-toggle {
      width: 52px;
      height: 52px;
      background: rgba(0, 255, 136, 0.2);
      border: 2px solid rgba(0, 255, 136, 0.6);
      box-shadow: 0 0 16px rgba(0, 255, 136, 0.35);
    }

    .controls button.btn-mic-toggle.active {
      background: rgba(255, 107, 107, 0.25);
      border-color: rgba(255, 107, 107, 0.8);
      box-shadow: 0 0 20px rgba(255, 107, 107, 0.5);
      animation: mic-pulse 2s infinite;
    }

    @keyframes mic-pulse {
      0%, 100% { box-shadow: 0 0 15px rgba(255, 107, 107, 0.4); }
      50% { box-shadow: 0 0 26px rgba(255, 107, 107, 0.8); }
    }

    .provider-pills {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }

    .provider-pill {
      padding: 7px 6px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.82);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: all 0.15s;
    }

    .provider-pill:hover {
      background: rgba(255, 255, 255, 0.13);
    }

    .provider-pill.active {
      background: rgba(0, 255, 136, 0.18);
      border-color: #00FF88;
      color: #fff;
    }

    .mini-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ff6b6b;
      flex-shrink: 0;
    }

    .mini-dot.ok {
      background: #00FF88;
      box-shadow: 0 0 6px #00FF88;
    }

    .provider-meta-row {
      margin-top: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.78);
    }

    .btn-inline {
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn-inline:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.18);
    }

    .inline-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .hint-text {
      margin-top: 4px;
      font-size: 10px;
      line-height: 1.35;
      color: rgba(255, 255, 255, 0.65);
    }

    .hint-text.warn {
      color: #ffb09c;
    }

    .hint-text.ok {
      color: #7effbf;
    }

    .section-divider {
      margin: 14px 0 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      padding-top: 12px;
    }

    .text-dock {
      position: absolute;
      bottom: 144px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1150;
      width: min(92vw, 520px);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .reply-caption {
      background: rgba(8, 10, 22, 0.78);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 12px;
      padding: 10px 14px;
      font-size: 13px;
      line-height: 1.45;
      color: rgba(255, 255, 255, 0.92);
      max-height: 140px;
      overflow-y: auto;
      user-select: text;
      -webkit-user-select: text;
    }

    .text-prompt-form {
      display: flex;
      gap: 8px;
      background: rgba(8, 10, 22, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 26px;
      padding: 6px 8px 6px 14px;
    }

    .text-prompt-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-size: 13px;
      font-family: inherit;
    }

    .text-prompt-send {
      border: none;
      border-radius: 18px;
      padding: 6px 14px;
      background: #00FF88;
      color: #0a0a14;
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
    }

    @media (max-width: 480px) {
      .vivica-name {
        bottom: 96px;
        font-size: 24px;
        letter-spacing: 4px;
      }

      .controls {
        bottom: 22px;
        gap: 10px;
        padding: 6px 12px;
      }

      .controls button {
        width: 40px;
        height: 40px;
      }

      .controls button.btn-mic-toggle {
        width: 48px;
        height: 48px;
      }

      .settings-panel {
        top: 10px;
        right: 10px;
        left: 10px;
        max-width: none;
        transform: translateY(-130%);
      }

      .settings-panel.open {
        transform: translateY(0);
      }

      .settings-hint {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.inputAnalyser = new Analyser(this.inputNode);
    this.outputAnalyser = new Analyser(this.outputNode);
    // Clean up any legacy client-side key storage if present
    try {
      localStorage.removeItem('gemini_api_key');
      localStorage.removeItem('openrouter_api_key');
    } catch {
      // Ignore storage errors
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.initClient();
    window.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.resizeCanvas);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.vadTimer) {
      clearTimeout(this.vadTimer);
      this.vadTimer = null;
    }
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.stopRecording();
    this.closeSocket();
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (isInput) return;

    if (e.code === 'Space') {
      e.preventDefault();
      this.toggleSettings();
    } else if (e.key === 'Escape' && this.settingsOpen) {
      this.toggleSettings(false);
    }
  };

  private isLiveAudioMode(): boolean {
    if (this.selectedProvider !== 'google') return false;
    const matched = this.models.find(
      (m) => m.provider === 'google' && m.id === this.selectedModel,
    );
    if (matched) return matched.supportsNativeAudio;
    return (
      this.selectedModel.includes('live') ||
      this.selectedModel.includes('native-audio')
    );
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    this.outputNode.connect(this.outputAudioContext.destination);
    await Promise.all([
      this.loadProvidersAndModels(false),
      this.loadAudioEngines(false),
    ]);
    await this.initSession();
  }

  private async loadProvidersAndModels(forceRefresh = false): Promise<void> {
    this.catalogLoading = true;
    this.catalogError = '';
    try {
      const params = new URLSearchParams({ provider: 'all' });
      if (forceRefresh) params.set('refresh', 'true');
      if (this.ollamaHost.trim()) params.set('ollamaHost', this.ollamaHost.trim());

      const resp = await fetch(`/api/models?${params.toString()}`);
      const data = await resp.json();
      if (!resp.ok) {
        this.catalogError = data?.error || `Failed loading models (HTTP ${resp.status})`;
        return;
      }
      if (Array.isArray(data.models)) {
        this.models = data.models;
      }
      if (Array.isArray(data.providers)) {
        this.providerStatuses = data.providers;
        const ollamaStatus = data.providers.find(
          (p: ProviderStatus) => p.id === 'ollama',
        );
        if (ollamaStatus?.baseUrl) {
          this.defaultOllamaHost = ollamaStatus.baseUrl;
        }
      }
    } catch (err: unknown) {
      this.catalogError =
        err instanceof Error ? err.message : 'Unable to fetch provider catalog.';
    } finally {
      this.catalogLoading = false;
    }
  }

  private async loadAudioEngines(forceRefresh = false): Promise<void> {
    this.audioDiscoveryLoading = true;
    try {
      const resp = await fetch(
        `/api/audio/engines${forceRefresh ? '?refresh=true' : ''}`,
      );
      if (!resp.ok) return;
      const data = (await resp.json()) as AudioDiscoveryResult;
      this.audioDiscovery = data;

      if (!localStorage.getItem('selected_stt_engine')) {
        const readyStt = data.stt.find((e) => e.available);
        if (readyStt) {
          this.selectedSttEngine = readyStt.id;
          this.selectedSttModel = readyStt.models[0]?.id || '';
        }
      } else if (!this.selectedSttModel) {
        const chosen = data.stt.find((e) => e.id === this.selectedSttEngine);
        if (chosen?.models[0]?.id) {
          this.selectedSttModel = chosen.models[0].id;
        }
      }

      if (!localStorage.getItem('selected_tts_engine')) {
        const readyTts = data.tts.find((e) => e.available);
        if (readyTts) {
          this.selectedTtsEngine = readyTts.id;
          this.selectedTtsVoice = readyTts.models[0]?.id || '';
        }
      } else if (!this.selectedTtsVoice) {
        const chosen = data.tts.find((e) => e.id === this.selectedTtsEngine);
        if (chosen?.models[0]?.id) {
          this.selectedTtsVoice = chosen.models[0].id;
        }
      }
    } catch {
      // Keep current audio selection state
    } finally {
      this.audioDiscoveryLoading = false;
    }
  }

  private async testProviderConnection(providerId: ProviderId) {
    this.providerTesting = true;
    this.providerTestMessage = `Testing ${providerId}…`;
    try {
      const resp = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          ollamaHost: providerId === 'ollama' ? this.ollamaHost.trim() || undefined : undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.status) {
        this.providerTestMessage = data?.error || 'Connection test failed.';
        return;
      }
      const nextStatus = data.status as ProviderStatus;
      this.providerStatuses = [
        ...this.providerStatuses.filter((p) => p.id !== nextStatus.id),
        nextStatus,
      ];
      this.providerTestMessage = nextStatus.statusMessage;
      await this.loadProvidersAndModels(true);
    } catch (err: unknown) {
      this.providerTestMessage =
        err instanceof Error ? err.message : 'Connection test error.';
    } finally {
      this.providerTesting = false;
    }
  }

  private closeSocket() {
    this.sessionReady = false;
    this.isConnecting = false;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({type: 'stop'}));
        }
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(delayMs = 4500) {
    if (!this.isLiveAudioMode()) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.sessionReady && !this.isConnecting && this.isLiveAudioMode()) {
        this.initSession();
      }
    }, delayMs);
  }

  private async initSession(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.isLiveAudioMode()) {
      this.connectionGeneration++;
      this.closeSocket();
      this.sessionReady = true;
      const status = this.providerStatuses.find((p) => p.id === this.selectedProvider);
      if (status && !status.available) {
        this.setStatus(status.error || status.statusMessage);
        this.setState('error');
      } else {
        const providerName = status?.label || this.selectedProvider;
        this.setStatus(`Ready (${providerName} • ${this.selectedModel}) • Tap orb or type`);
        this.setState('idle');
      }
      return;
    }

    if (this.isConnecting) return;
    this.isConnecting = true;
    const generation = ++this.connectionGeneration;

    this.closeSocket();
    this.isConnecting = true;

    this.setStatus('Connecting to Vivica…');
    this.setState('processing');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/live`;

    return new Promise((resolve) => {
      let resolved = false;
      const finishResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        if (generation !== this.connectionGeneration) {
          ws.close();
          finishResolve();
          return;
        }
        ws.send(
          JSON.stringify({
            type: 'start',
            model: this.selectedModel,
            voice: this.selectedVoice || 'Aoede',
            systemPrompt: this.systemPrompt,
          }),
        );
      };

      ws.onmessage = async (event: MessageEvent) => {
        if (generation !== this.connectionGeneration) return;

        let msg: LiveBridgeMessage;
        try {
          msg = JSON.parse(event.data) as LiveBridgeMessage;
        } catch {
          return;
        }

        if (msg.type === 'open') {
          this.isConnecting = false;
          this.sessionReady = true;
          this.setStatus('Connected • Tap orb or mic to speak');
          this.setState('listening');
          finishResolve();
        } else if (msg.type === 'status' && msg.message) {
          this.setStatus(msg.message);
        } else if (msg.type === 'audio' && msg.audio) {
          this.setState('speaking');
          this.setStatus('VIVICA speaking…');

          this.nextStartTime = Math.max(
            this.nextStartTime,
            this.outputAudioContext.currentTime,
          );

          const audioBuffer = await decodeAudioData(
            decode(msg.audio),
            this.outputAudioContext,
            24000,
            1,
          );
          const source = this.outputAudioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(this.outputNode);

          source.addEventListener('ended', () => {
            this.sources.delete(source);
            if (this.sources.size === 0) {
              this.setState(this.isRecording ? 'listening' : 'idle');
              this.setStatus(this.isRecording ? 'Listening…' : 'Ready');
            }
          });

          source.start(this.nextStartTime);
          this.nextStartTime = this.nextStartTime + audioBuffer.duration;
          this.sources.add(source);
        } else if (msg.type === 'interrupted') {
          for (const source of this.sources.values()) {
            try {
              source.stop();
            } catch {
              // Ignore already stopped sources
            }
            this.sources.delete(source);
          }
          this.nextStartTime = 0;
          this.setState(this.isRecording ? 'listening' : 'idle');
          this.setStatus('Interrupted');
        } else if (msg.type === 'error') {
          this.isConnecting = false;
          this.sessionReady = false;
          this.updateError(msg.message || 'Voice service busy • Retrying in 4s… (Tap Retry)');
          this.setState('error');
          if (msg.retryable !== false) {
            this.scheduleReconnect(4500);
          }
          finishResolve();
        } else if (msg.type === 'closed') {
          this.isConnecting = false;
          this.sessionReady = false;
          if (this.currentState !== 'error') {
            this.setStatus(msg.reason ? `Closed: ${msg.reason}` : 'Session paused');
            this.setState('idle');
          }
          finishResolve();
        }
      };

      ws.onerror = () => {
        if (generation !== this.connectionGeneration) return;
        this.isConnecting = false;
        this.sessionReady = false;
        this.updateError('Connection interrupted • Retrying… (Tap Retry)');
        this.setState('error');
        this.scheduleReconnect(4500);
        finishResolve();
      };

      ws.onclose = () => {
        if (generation !== this.connectionGeneration) return;
        const wasReady = this.sessionReady;
        this.isConnecting = false;
        this.sessionReady = false;
        if (this.ws === ws) {
          this.ws = null;
        }
        if (this.currentState !== 'error' && wasReady) {
          this.setStatus('Session paused');
          this.setState('idle');
        }
        finishResolve();
      };
    });
  }

  private setStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = msg;
  }

  private setState(state: 'listening' | 'processing' | 'speaking' | 'idle' | 'error') {
    this.currentState = state;
    switch (state) {
      case 'listening':
        this.updateMood('#00FF88');
        this.targetVolume = 0.28;
        break;
      case 'processing':
        this.updateMood('#FFD700');
        this.targetVolume = 0.35;
        break;
      case 'speaking':
        this.updateMood('#FF6B6B');
        this.targetVolume = 0.55;
        break;
      case 'idle':
        this.updateMood('#00FF88');
        this.targetVolume = 0.15;
        break;
      case 'error':
        this.updateMood('#FF4444');
        this.targetVolume = 0.1;
        setTimeout(() => {
          if (this.currentState === 'error') {
            this.setState(this.isRecording ? 'listening' : 'idle');
            this.setStatus(this.isRecording ? 'Listening…' : 'Ready');
          }
        }, 3500);
        break;
    }
  }

  private updateMood(color: string) {
    this.targetMoodColor = color;
    const rgb = this.hexToRgb(color);
    document.body.style.background = `radial-gradient(circle, ${this.rgbaStr(rgb, 0.14)} 0%, black 80%)`;
  }

  private async startRecording() {
    if (this.isRecording) return;

    if (!this.isLiveAudioMode()) {
      await this.startTurnBasedRecording();
      return;
    }

    if (!this.sessionReady && !this.isConnecting) {
      this.setStatus('Connecting session…');
      await this.initSession();
    }

    if (this.inputAudioContext.state === 'suspended') {
      await this.inputAudioContext.resume();
    }
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }

    this.setStatus('Requesting microphone access…');
    this.setState('processing');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.setStatus('🔴 Listening… Speak clearly to VIVICA');
      this.setState('listening');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 2048;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (
          !this.isRecording ||
          !this.sessionReady ||
          !this.ws ||
          this.ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        try {
          const payload = createBlob(pcmData);
          this.ws.send(JSON.stringify({type: 'audio', audio: payload.data}));
        } catch (err) {
          console.warn('Realtime input error:', err);
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
    } catch (err: unknown) {
      const errorObj = err as Error;
      console.error('Microphone error:', errorObj);
      this.updateError(`Microphone access error: ${errorObj.message}`);
      this.setState('error');
      this.stopRecording();
    }
  }

  private async startTurnBasedRecording() {
    if (this.selectedSttEngine === 'browser') {
      const win = window as unknown as {
        SpeechRecognition?: new () => SpeechRecognitionLike;
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      };
      const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
      if (!SpeechRec) {
        this.updateError('Browser Web Speech STT unavailable here. Use text input or configure local STT.');
        this.setState('error');
        return;
      }

      if (this.outputAudioContext.state === 'suspended') {
        await this.outputAudioContext.resume();
      }

      const recognition = new SpeechRec();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.continuous = false;
      this.speechRecognition = recognition;
      this.isRecording = true;
      this.setState('listening');
      this.setStatus('Listening (Browser Web Speech)…');

      recognition.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() || '';
        this.isRecording = false;
        this.speechRecognition = null;
        if (transcript) {
          void this.sendTurnMessage(transcript);
        } else {
          this.setState('idle');
          this.setStatus('No speech detected.');
        }
      };

      recognition.onerror = (event) => {
        this.isRecording = false;
        this.speechRecognition = null;
        this.updateError(`Speech recognition error: ${event.error || 'unknown'}`);
        this.setState('error');
      };

      recognition.onend = () => {
        this.isRecording = false;
        this.speechRecognition = null;
      };

      recognition.start();
      return;
    }

    const sttEngine = this.audioDiscovery?.stt.find(
      (e) => e.id === this.selectedSttEngine,
    );
    if (!sttEngine || !sttEngine.available) {
      this.updateError(
        sttEngine?.statusMessage ||
          `Local STT engine "${this.selectedSttEngine}" is unavailable. Open Settings to switch.`,
      );
      this.setState('error');
      return;
    }

    if (this.inputAudioContext.state === 'suspended') {
      await this.inputAudioContext.resume();
    }
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);

      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      this.recordedChunks = [];
      const recorder = preferredMime
        ? new MediaRecorder(this.mediaStream, { mimeType: preferredMime })
        : new MediaRecorder(this.mediaStream);
      this.mediaRecorder = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          this.recordedChunks.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        const chunks = this.recordedChunks;
        this.recordedChunks = [];
        const mimeType = recorder.mimeType || 'audio/webm';
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, { type: mimeType });
        await this.transcribeAndSendBlob(blob, mimeType);
      };

      recorder.start();
      this.isRecording = true;
      this.setState('listening');
      this.setStatus(`Listening (${sttEngine.name}) • Tap orb again to send`);
    } catch (err: unknown) {
      const errorObj = err as Error;
      this.updateError(`Microphone access error: ${errorObj.message}`);
      this.setState('error');
      this.stopRecording();
    }
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  private async transcribeAndSendBlob(blob: Blob, mimeType: string) {
    this.setState('processing');
    this.setStatus(`Transcribing via ${this.selectedSttEngine}…`);
    try {
      const audioBase64 = await this.blobToBase64(blob);
      const resp = await fetch('/api/audio/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engineId: this.selectedSttEngine,
          model: this.selectedSttModel || undefined,
          audioBase64,
          mimeType,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || `Transcription failed (HTTP ${resp.status})`);
      }
      const transcript = (data.text || '').trim();
      if (!transcript) {
        this.setState('idle');
        this.setStatus('No speech recognized • Tap to try again');
        return;
      }
      await this.sendTurnMessage(transcript);
    } catch (err: unknown) {
      this.updateError(err instanceof Error ? err.message : 'Local STT failed.');
      this.setState('error');
    }
  }

  private async sendTurnMessage(userText: string) {
    const cleanText = userText.trim();
    if (!cleanText) return;

    if (this.isLiveAudioMode()) {
      this.updateError('Live Audio model uses voice stream; select a text/chat model (e.g. Gemini 4, OpenRouter, Ollama) to use turn-based chat.');
      this.setState('error');
      return;
    }

    if (this.chatAbortController) {
      this.chatAbortController.abort();
    }
    const controller = new AbortController();
    this.chatAbortController = controller;

    this.chatHistory = [...this.chatHistory.slice(-18), { role: 'user', content: cleanText }];
    this.setState('processing');
    this.setStatus(`Vivica thinking (${this.selectedModel})…`);
    this.lastTranscriptPreview = '';

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: this.selectedProvider,
          model: this.selectedModel,
          messages: this.chatHistory,
          systemPrompt: this.systemPrompt,
          ollamaHost:
            this.selectedProvider === 'ollama' && this.ollamaHost.trim()
              ? this.ollamaHost.trim()
              : undefined,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson?.error || `Model request failed (HTTP ${resp.status})`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let replyText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          const event = JSON.parse(payload) as {
            type: 'delta' | 'done' | 'error';
            text?: string;
            message?: string;
          };
          if (event.type === 'error') {
            throw new Error(event.message || 'Model streaming error.');
          }
          if (event.type === 'delta' && event.text) {
            replyText += event.text;
            this.lastTranscriptPreview = replyText;
          }
        }
      }

      const finalReply = replyText.trim();
      if (!finalReply) {
        this.setState('idle');
        this.setStatus('Empty response from model.');
        return;
      }

      this.chatHistory = [
        ...this.chatHistory.slice(-18),
        { role: 'assistant', content: finalReply },
      ];
      await this.speakResponse(finalReply);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      this.updateError(err instanceof Error ? err.message : 'Inference failed.');
      this.setState('error');
    } finally {
      if (this.chatAbortController === controller) {
        this.chatAbortController = null;
      }
    }
  }

  private async speakResponse(text: string) {
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }

    if (this.selectedTtsEngine === 'browser') {
      if (!('speechSynthesis' in window)) {
        this.setState('idle');
        this.setStatus('Reply ready (SpeechSynthesis unavailable in this browser)');
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const preferredFemale = voices.find(
        (v) =>
          v.lang.startsWith('en') &&
          /female|samantha|victoria|karen|zira|aria|jenny|aoede|natural/i.test(v.name),
      );
      if (preferredFemale) utterance.voice = preferredFemale;

      utterance.onstart = () => {
        this.setState('speaking');
        this.setStatus('VIVICA speaking (Browser TTS)…');
      };
      utterance.onend = () => {
        this.setState('idle');
        this.setStatus(`Ready (${this.selectedModel})`);
      };
      utterance.onerror = () => {
        this.setState('idle');
        this.setStatus(`Ready (${this.selectedModel})`);
      };
      window.speechSynthesis.speak(utterance);
      return;
    }

    const ttsEngine = this.audioDiscovery?.tts.find(
      (e) => e.id === this.selectedTtsEngine,
    );
    if (!ttsEngine || !ttsEngine.available) {
      this.updateError(
        ttsEngine?.statusMessage ||
          `Local TTS engine "${this.selectedTtsEngine}" is unavailable. Reply displayed below.`,
      );
      this.setState('error');
      return;
    }

    this.setState('processing');
    this.setStatus(`Synthesizing voice (${ttsEngine.name})…`);
    try {
      const resp = await fetch('/api/audio/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engineId: this.selectedTtsEngine,
          voice: this.selectedTtsVoice || undefined,
          text,
        }),
      });
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson?.error || `TTS synthesis failed (HTTP ${resp.status})`);
      }

      const wavBytes = await resp.arrayBuffer();
      const audioBuffer = await this.outputAudioContext.decodeAudioData(wavBytes);

      const source = this.outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputNode);
      this.setState('speaking');
      this.setStatus(`VIVICA speaking (${ttsEngine.name})…`);

      source.addEventListener('ended', () => {
        this.sources.delete(source);
        if (this.sources.size === 0) {
          this.setState('idle');
          this.setStatus(`Ready (${this.selectedModel})`);
        }
      });

      this.nextStartTime = Math.max(
        this.nextStartTime,
        this.outputAudioContext.currentTime,
      );
      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.sources.add(source);
    } catch (err: unknown) {
      this.updateError(err instanceof Error ? err.message : 'Local TTS synthesis failed.');
      this.setState('error');
    }
  }

  private stopRecording() {
    if (this.speechRecognition) {
      try {
        this.speechRecognition.abort();
      } catch {
        // Ignore
      }
      this.speechRecognition = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignore
      }
      this.mediaRecorder = null;
    }

    if (!this.isRecording && !this.mediaStream && !this.sourceNode) return;

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.currentState === 'listening') {
      this.setState('idle');
      this.setStatus('Microphone paused. Tap to resume.');
    }
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private interruptSpeech() {
    let interrupted = false;
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      interrupted = true;
    }
    if (this.chatAbortController) {
      this.chatAbortController.abort();
      this.chatAbortController = null;
      interrupted = true;
    }
    if (this.sources.size > 0) {
      for (const source of this.sources.values()) {
        try {
          source.stop();
        } catch {
          // Ignore
        }
        this.sources.delete(source);
      }
      this.nextStartTime = 0;
      interrupted = true;
    }
    if (interrupted) {
      this.setState(this.isRecording ? 'listening' : 'idle');
      this.setStatus(this.isRecording ? 'Interrupted • Listening…' : 'Interrupted');
    }
    return interrupted;
  }

  private reset() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.interruptSpeech();
    this.stopRecording();
    this.chatHistory = [];
    this.lastTranscriptPreview = '';
    this.connectionGeneration++;
    this.closeSocket();
    this.initSession();
    if (this.isLiveAudioMode()) {
      this.setStatus('Reconnecting to Vivica…');
    }
  }

  private toggleSettings(force?: boolean) {
    this.settingsOpen = typeof force === 'boolean' ? force : !this.settingsOpen;
  }

  private handleUnifiedModelSelect(e: CustomEvent<{ provider: ProviderId; modelId: string }>) {
    const { provider, modelId } = e.detail;
    this.selectedProvider = provider;
    this.selectedModel = modelId;
    localStorage.setItem('selected_provider', provider);
    localStorage.setItem('selected_model', modelId);
    this.providerTestMessage = '';
  }

  private handleTextPromptSubmit(e: Event) {
    e.preventDefault();
    const prompt = this.textPromptDraft.trim();
    if (!prompt) return;
    this.textPromptDraft = '';
    void this.sendTurnMessage(prompt);
  }

  private applySettings(e?: Event) {
    if (e) e.preventDefault();

    const root = this.shadowRoot!;
    const voiceSelect = root.querySelector('#voiceSelect') as HTMLSelectElement | null;
    const visualModeSelect = root.querySelector('#visualModeSelect') as HTMLSelectElement | null;
    const systemPromptInput = root.querySelector('#systemPrompt') as HTMLTextAreaElement | null;
    const ollamaHostInput = root.querySelector('#ollamaHostInput') as HTMLInputElement | null;
    const sttEngineSelect = root.querySelector('#sttEngineSelect') as HTMLSelectElement | null;
    const sttModelSelect = root.querySelector('#sttModelSelect') as HTMLSelectElement | null;
    const ttsEngineSelect = root.querySelector('#ttsEngineSelect') as HTMLSelectElement | null;
    const ttsVoiceSelect = root.querySelector('#ttsVoiceSelect') as HTMLSelectElement | null;

    localStorage.setItem('selected_provider', this.selectedProvider);
    localStorage.setItem('selected_model', this.selectedModel);
    localStorage.setItem('openrouter_free_only', String(this.openRouterFreeOnly));

    if (ollamaHostInput) {
      this.ollamaHost = ollamaHostInput.value.trim();
      localStorage.setItem('ollama_host', this.ollamaHost);
    }
    if (sttEngineSelect) {
      this.selectedSttEngine = sttEngineSelect.value;
      localStorage.setItem('selected_stt_engine', this.selectedSttEngine);
    }
    if (sttModelSelect) {
      this.selectedSttModel = sttModelSelect.value;
      localStorage.setItem('selected_stt_model', this.selectedSttModel);
    }
    if (ttsEngineSelect) {
      this.selectedTtsEngine = ttsEngineSelect.value;
      localStorage.setItem('selected_tts_engine', this.selectedTtsEngine);
    }
    if (ttsVoiceSelect) {
      this.selectedTtsVoice = ttsVoiceSelect.value;
      localStorage.setItem('selected_tts_voice', this.selectedTtsVoice);
    }
    if (voiceSelect) {
      this.selectedVoice = voiceSelect.value;
      localStorage.setItem('selected_voice', this.selectedVoice);
    }
    if (visualModeSelect) {
      this.visualMode = visualModeSelect.value;
      localStorage.setItem('visual_mode', this.visualMode);
    }
    if (systemPromptInput) {
      this.systemPrompt = systemPromptInput.value.trim();
      localStorage.setItem('system_prompt', this.systemPrompt);
    }

    this.toggleSettings(false);
    this.reset();
  }

  // Color utilities
  private hexToRgb(hex: string) {
    const h = hex.replace('#', '').trim();
    if (h.length !== 6) return {r: 0, g: 255, b: 136};
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  private rgbaStr(rgb: {r: number; g: number; b: number}, a: number) {
    const alpha = Math.max(0, Math.min(1, a));
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  private lerpColor(c1: string, c2: string, factor: number) {
    const hex1 = c1.replace('#', '');
    const hex2 = c2.replace('#', '');

    const r1 = parseInt(hex1.substring(0, 2), 16);
    const g1 = parseInt(hex1.substring(2, 4), 16);
    const b1 = parseInt(hex1.substring(4, 6), 16);

    const r2 = parseInt(hex2.substring(0, 2), 16);
    const g2 = parseInt(hex2.substring(2, 4), 16);
    const b2 = parseInt(hex2.substring(4, 6), 16);

    const r = Math.round(r1 + (r2 - r1) * factor);
    const g = Math.round(g1 + (g2 - g1) * factor);
    const b = Math.round(b1 + (b2 - b1) * factor);

    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  // VIVICA 2D Canvas Orb renderer
  private resizeCanvas = () => {
    if (!this.canvas || !this.ctx) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  private drawOrb() {
    if (!this.canvas || !this.ctx) return;
    const ctx = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;

    ctx.clearRect(0, 0, w, h);

    const baseRadius = Math.min(w, h) * 0.15;
    const volumeRadius = this.volume * (baseRadius * 1.8);
    const pulseRadius = Math.sin(this.pulseOffset) * (baseRadius * 0.16);
    const radius = Math.max(20, baseRadius + volumeRadius + pulseRadius);

    const x = w / 2;
    const y = h / 2;

    const rgb = this.hexToRgb(this.currentMoodColor);

    // 1. Outer radiant atmospheric glow
    const outerGlow = ctx.createRadialGradient(x, y, radius * 0.25, x, y, radius * 2.5);
    outerGlow.addColorStop(0, this.rgbaStr(rgb, 0.28));
    outerGlow.addColorStop(0.5, this.rgbaStr(rgb, 0.12));
    outerGlow.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.beginPath();
    ctx.fillStyle = outerGlow;
    ctx.arc(x, y, radius * 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 2. Main spherical body
    const gradient = ctx.createRadialGradient(x, y, 10, x, y, radius);
    gradient.addColorStop(0, this.rgbaStr(rgb, 0.85));
    gradient.addColorStop(0.4, this.rgbaStr(rgb, 0.55));
    gradient.addColorStop(0.8, this.rgbaStr(rgb, 0.28));
    gradient.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.beginPath();
    ctx.fillStyle = gradient;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // 3. Inner high-intensity core
    const coreGradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 0.32);
    coreGradient.addColorStop(0, '#FFFFFF');
    coreGradient.addColorStop(1, this.rgbaStr(rgb, 0.55));

    ctx.beginPath();
    ctx.fillStyle = coreGradient;
    ctx.arc(x, y, radius * 0.32, 0, Math.PI * 2);
    ctx.fill();

    // 4. Reactive particle emission
    const isActive = this.volume > 0.08 || this.currentState === 'processing' || this.currentState === 'speaking';
    if (isActive) {
      const emitCount = this.currentState === 'speaking' ? 4 : this.currentState === 'processing' ? 5 : 2;
      for (let i = 0; i < emitCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = radius * (0.4 + Math.random() * 0.6);
        const px = x + Math.cos(angle) * dist;
        const py = y + Math.sin(angle) * dist;
        this.particles.push({
          x: px,
          y: py,
          vx: (Math.random() - 0.5) * 2.5 + Math.cos(angle) * 0.8,
          vy: (Math.random() - 0.5) * 2.5 + Math.sin(angle) * 0.8,
          life: 1.0,
          size: Math.random() * 3.5 + 1,
        });
      }
    }

    // 5. Update and render particles
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.012;
      p.vx *= 0.99;
      p.vy *= 0.99;

      if (p.life <= 0) continue;

      const pRadius = p.size * p.life;
      if (pRadius <= 0 || !Number.isFinite(pRadius)) continue;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 0.65));
      ctx.fillStyle = this.currentMoodColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.particles.length > 700) {
      this.particles.length = 700;
    }
  }

  private animateLoop = () => {
    this.animFrameId = requestAnimationFrame(this.animateLoop);

    // Audio frequency reactive reading
    let audioEnergy = 0;
    if (this.outputAnalyser) {
      this.outputAnalyser.update();
      const outMax = Math.max(
        this.outputAnalyser.data[0] || 0,
        this.outputAnalyser.data[1] || 0,
        this.outputAnalyser.data[2] || 0,
      );
      if (outMax > 15) {
        audioEnergy = Math.max(audioEnergy, outMax / 255);
        if (this.currentState !== 'speaking') {
          this.setState('speaking');
          this.setStatus('VIVICA speaking…');
        }
      }
    }

    if (this.isRecording && this.inputAnalyser) {
      this.inputAnalyser.update();
      const inMax = Math.max(
        this.inputAnalyser.data[0] || 0,
        this.inputAnalyser.data[1] || 0,
        this.inputAnalyser.data[2] || 0,
      );
      if (inMax > 20) {
        audioEnergy = Math.max(audioEnergy, inMax / 255);
        if (this.currentState !== 'speaking' && this.currentState !== 'processing') {
          this.setState('listening');
        }
      }
    }

    // Blend volume
    if (audioEnergy > 0.05) {
      this.targetVolume = 0.2 + audioEnergy * 0.7;
    } else if (this.currentState === 'listening') {
      this.targetVolume = 0.2 + Math.sin(Date.now() * 0.003) * 0.08;
    } else if (this.currentState === 'processing') {
      this.targetVolume = 0.3 + Math.sin(Date.now() * 0.008) * 0.12;
    } else if (this.currentState === 'speaking') {
      this.targetVolume = 0.4 + Math.sin(Date.now() * 0.006) * 0.15;
    } else {
      this.targetVolume = 0.1 + Math.sin(Date.now() * 0.002) * 0.04;
    }

    this.volume += (this.targetVolume - this.volume) * 0.18;

    if (this.currentMoodColor !== this.targetMoodColor) {
      this.currentMoodColor = this.lerpColor(this.currentMoodColor, this.targetMoodColor, 0.06);
    }

    this.pulseOffset += this.currentState === 'processing' ? 0.18 : 0.045;

    if (this.visualMode === 'vivica-canvas') {
      this.drawOrb();
    }
  };

  // Touch and pointer interactions on canvas / orb
  private handleOrbPointerDown = () => {
    this.isLongPress = false;
    this.longPressTimer = window.setTimeout(() => {
      this.isLongPress = true;
      this.toggleSettings();
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, 800);
  };

  private handleOrbPointerUp = () => {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }

    if (!this.isLongPress && !this.settingsOpen) {
      // Short tap:
      // If speaking -> interrupt speech
      const interrupted = this.interruptSpeech();
      if (!interrupted) {
        // If not speaking, toggle listening
        this.toggleRecording();
      }
    }
  };

  private handleOrbPointerCancel = () => {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  };

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('#orbCanvas') as HTMLCanvasElement;
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
      this.resizeCanvas();
      window.addEventListener('resize', this.resizeCanvas);
    }

    this.setState('listening');
    this.animateLoop();
  }

  protected updated(changedProperties: Map<PropertyKey, unknown>) {
    if (changedProperties.has('visualMode') && this.visualMode === 'vivica-canvas') {
      const nextCanvas = this.shadowRoot!.querySelector('#orbCanvas') as HTMLCanvasElement | null;
      if (nextCanvas && nextCanvas !== this.canvas) {
        this.canvas = nextCanvas;
        this.ctx = nextCanvas.getContext('2d');
        this.resizeCanvas();
      }
    }
  }

  render() {
    return html`
      ${this.visualMode === 'vivica-canvas'
        ? html`
            <canvas
              id="orbCanvas"
              @pointerdown=${this.handleOrbPointerDown}
              @pointerup=${this.handleOrbPointerUp}
              @pointercancel=${this.handleOrbPointerCancel}
              title="Tap to speak/interrupt • Long press for settings"
            ></canvas>
          `
        : html`
            <gdm-live-audio-visuals-3d
              .inputNode=${this.inputNode}
              .outputNode=${this.outputNode}
              @pointerdown=${this.handleOrbPointerDown}
              @pointerup=${this.handleOrbPointerUp}
              @pointercancel=${this.handleOrbPointerCancel}
            ></gdm-live-audio-visuals-3d>
          `}

      <!-- VIVICA Logo & Branding -->
      <div class="vivica-name">V I V I C A</div>

      <!-- Status Overlay Top Left -->
      <div
        id="statusOverlay"
        class="status-overlay ${this.currentState === 'error' ? 'has-error' : ''}"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        @click=${() => this.currentState === 'error' && this.reset()}
        title=${this.currentState === 'error' ? 'Click to reconnect' : ''}
      >
        <span class="status-dot ${this.currentState}"></span>
        <span>${this.status}</span>
        ${this.currentState === 'error'
          ? html`<button
              class="retry-chip"
              type="button"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.reset();
              }}
            >
              Retry
            </button>`
          : ''}
      </div>

      <!-- Settings Toggle Button Top Right -->
      <button
        class="settings-toggle"
        id="openSettings"
        type="button"
        aria-label="Open settings"
        aria-expanded=${this.settingsOpen ? 'true' : 'false'}
        @click=${() => this.toggleSettings()}
      >
        ⚙
      </button>

      <!-- Settings Shortcut Hint Bottom Right -->
      <div class="settings-hint">
        Press SPACE or long-press screen for settings
      </div>

      <!-- Controls Dock Bottom Center -->
      <div class="controls" role="toolbar" aria-label="Audio controls">
        <!-- Reset Session Button -->
        <button
          id="resetButton"
          type="button"
          aria-label="Reset live session"
          title="Reset session"
          @click=${this.reset}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="22px"
            viewBox="0 -960 960 960"
            width="22px"
            fill="currentColor"
          >
            <path
              d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"
            />
          </svg>
        </button>

        <!-- Main Live Microphone Toggle Button -->
        <button
          id="startButton"
          type="button"
          class="btn-mic-toggle ${this.isRecording ? 'active' : ''}"
          aria-label=${this.isRecording ? 'Mute / pause microphone' : 'Start listening'}
          title=${this.isRecording ? 'Listening (Click to pause)' : 'Click to start speaking'}
          @click=${this.toggleRecording}
        >
          ${this.isRecording
            ? html`
                <!-- Active Mic / Stop Icon -->
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="26px"
                  viewBox="0 -960 960 960"
                  width="26px"
                  fill="#FF6B6B"
                >
                  <path
                    d="M480-400q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm-40 280v-123q-104-14-172-93t-68-184h80q0 83 58.5 141.5T480-320q83 0 141.5-58.5T680-520h80q0 105-68 184t-172 93v123h-80Z"
                  />
                </svg>
              `
            : html`
                <!-- Ready Mic Icon -->
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="26px"
                  viewBox="0 -960 960 960"
                  width="26px"
                  fill="#00FF88"
                >
                  <path
                    d="M480-400q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm-40 280v-123q-104-14-172-93t-68-184h80q0 83 58.5 141.5T480-320q83 0 141.5-58.5T680-520h80q0 105-68 184t-172 93v123h-80Z"
                  />
                </svg>
              `}
        </button>

        <!-- Interrupt / Pause Speech Button -->
        <button
          id="stopButton"
          type="button"
          aria-label="Interrupt speech"
          title="Interrupt speech"
          @click=${() => {
            if (!this.interruptSpeech() && this.isRecording) {
              this.stopRecording();
            }
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="20px"
            viewBox="0 -960 960 960"
            width="20px"
            fill="currentColor"
          >
            <path
              d="M320-320h320v-320H320v320ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z"
            />
          </svg>
        </button>

        <!-- Text Prompt Toggle (for text/multi-provider chat) -->
        <button
          id="textDockToggle"
          type="button"
          aria-label="Toggle text prompt input"
          title="Send text prompt (for OpenRouter, Ollama, or Gemini text models)"
          @click=${() => {
            this.textInputOpen = !this.textInputOpen;
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="20px"
            viewBox="0 -960 960 960"
            width="20px"
            fill="currentColor"
          >
            <path
              d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Z"
            />
          </svg>
        </button>
      </div>

      ${this.textInputOpen || this.lastTranscriptPreview
        ? html`
            <div class="text-dock">
              ${this.lastTranscriptPreview
                ? html`<div class="reply-caption">${this.lastTranscriptPreview}</div>`
                : ''}
              ${this.textInputOpen
                ? html`
                    <form class="text-prompt-form" @submit=${this.handleTextPromptSubmit}>
                      <input
                        class="text-prompt-input"
                        type="text"
                        placeholder=${this.isLiveAudioMode()
                          ? 'Select a non-Live model in Settings to chat via text…'
                          : `Message Vivica (${this.selectedModel})…`}
                        .value=${this.textPromptDraft}
                        @input=${(e: Event) => {
                          this.textPromptDraft = (e.target as HTMLInputElement).value;
                        }}
                      />
                      <button type="submit" class="text-prompt-send">Send</button>
                    </form>
                  `
                : ''}
            </div>
          `
        : ''}

      <!-- Settings Flyout Panel -->
      <div
        class="settings-panel ${this.settingsOpen ? 'open' : ''}"
        id="settingsPanel"
        role="dialog"
        aria-labelledby="settingsTitle"
        aria-hidden=${this.settingsOpen ? 'false' : 'true'}
      >
        <button
          class="close-settings"
          id="closeSettings"
          type="button"
          aria-label="Close settings"
          @click=${() => this.toggleSettings(false)}
        >
          ×
        </button>

        <div class="setting-title" id="settingsTitle">SETTINGS</div>

        <form @submit=${this.applySettings}>
          <div class="setting-group">
            <label class="setting-label">AI Provider</label>
            ${(() => {
              const inspectedProvider: ProviderId =
                this.selectorFilterScope === 'all'
                  ? this.selectedProvider
                  : this.selectorFilterScope;
              const st = this.providerStatuses.find(
                (p) => p.id === inspectedProvider,
              );
              return html`
                <div class="provider-pills" role="radiogroup" aria-label="AI Provider">
                  ${(['google', 'openrouter', 'ollama'] as const).map((pid) => {
                    const pStatus = this.providerStatuses.find((p) => p.id === pid);
                    const label =
                      pid === 'google'
                        ? 'Google AI'
                        : pid === 'openrouter'
                          ? 'OpenRouter'
                          : 'Ollama';
                    return html`
                      <button
                        type="button"
                        class="provider-pill ${inspectedProvider === pid ? 'active' : ''}"
                        @click=${() => {
                          this.selectorFilterScope = pid;
                          this.providerTestMessage = '';
                        }}
                      >
                        <span class="mini-dot ${pStatus?.available ? 'ok' : ''}"></span>
                        <span>${label}</span>
                      </button>
                    `;
                  })}
                </div>

                <div class="provider-meta-row">
                  <span>
                    ${this.providerTestMessage || st?.statusMessage || 'Checking provider…'}
                  </span>
                  <button
                    type="button"
                    class="btn-inline"
                    ?disabled=${this.providerTesting}
                    @click=${() => this.testProviderConnection(inspectedProvider)}
                  >
                    ${this.providerTesting ? 'Testing…' : 'Test'}
                  </button>
                </div>
              `;
            })()}
          </div>

          ${this.selectorFilterScope === 'ollama' || this.selectedProvider === 'ollama'
            ? html`
                <div class="setting-group">
                  <label class="setting-label" for="ollamaHostInput">
                    Ollama Host URL (Server-validated)
                  </label>
                  <div class="inline-row">
                    <input
                      class="setting-input"
                      id="ollamaHostInput"
                      type="text"
                      placeholder=${this.defaultOllamaHost}
                      .value=${this.ollamaHost}
                      @input=${(e: Event) => {
                        this.ollamaHost = (e.target as HTMLInputElement).value;
                      }}
                    />
                    <button
                      type="button"
                      class="btn-inline"
                      @click=${() => {
                        localStorage.setItem('ollama_host', this.ollamaHost.trim());
                        void this.loadProvidersAndModels(true);
                      }}
                    >
                      Discover
                    </button>
                  </div>
                  <div class="hint-text">
                    Default: ${this.defaultOllamaHost}. Runs on backend host; loopback/LAN URLs only.
                  </div>
                </div>
              `
            : ''}

          <div class="setting-group">
            <label class="setting-label">Model Selection</label>
            <vivica-model-selector
              .models=${this.models}
              .providers=${this.providerStatuses}
              .selectedModelId=${this.selectedModel}
              .selectedProviderId=${this.selectedProvider}
              .filterProvider=${this.selectorFilterScope}
              .openRouterFreeOnly=${this.openRouterFreeOnly}
              .loading=${this.catalogLoading}
              .errorMessage=${this.catalogError}
              @select-model=${this.handleUnifiedModelSelect}
              @filter-provider-change=${(e: CustomEvent<{ scope: ProviderId | 'all' }>) => {
                this.selectorFilterScope = e.detail.scope;
              }}
              @toggle-free-only=${(e: CustomEvent<{ freeOnly: boolean }>) => {
                this.openRouterFreeOnly = e.detail.freeOnly;
                localStorage.setItem('openrouter_free_only', String(this.openRouterFreeOnly));
              }}
              @refresh-models=${() => {
                void this.loadProvidersAndModels(true);
              }}
            ></vivica-model-selector>
          </div>

          ${this.isLiveAudioMode()
            ? html`
                <div class="setting-group">
                  <label class="setting-label" for="voiceSelect">Google Live Voice</label>
                  <select class="setting-input" id="voiceSelect" .value=${this.selectedVoice}>
                    <option value="Aoede" ?selected=${this.selectedVoice === 'Aoede'}>
                      Aoede (Female - Melodic & Expressive) [Default]
                    </option>
                    <option value="Kore" ?selected=${this.selectedVoice === 'Kore'}>
                      Kore (Female - Gentle & Smooth)
                    </option>
                    <option value="Puck" ?selected=${this.selectedVoice === 'Puck'}>
                      Puck (Engaging & Lively)
                    </option>
                    <option value="Charon" ?selected=${this.selectedVoice === 'Charon'}>
                      Charon (Calm & Reflective)
                    </option>
                    <option value="Fenrir" ?selected=${this.selectedVoice === 'Fenrir'}>
                      Fenrir (Rich & Authoritative)
                    </option>
                    <option value="Orus" ?selected=${this.selectedVoice === 'Orus'}>
                      Orus (Warm & Deep)
                    </option>
                  </select>
                </div>
              `
            : html`
                <div class="section-divider">
                  <div class="provider-meta-row" style="margin-top:0;margin-bottom:8px;">
                    <span class="setting-label" style="margin:0;">Speech Pipeline (Non-Live Models)</span>
                    <button
                      type="button"
                      class="btn-inline"
                      ?disabled=${this.audioDiscoveryLoading}
                      @click=${() => this.loadAudioEngines(true)}
                    >
                      ${this.audioDiscoveryLoading ? 'Scanning…' : '↻ Scan Local'}
                    </button>
                  </div>

                  <div class="setting-group">
                    <label class="setting-label" for="sttEngineSelect">Speech-to-Text (STT) Engine</label>
                    <select
                      class="setting-input"
                      id="sttEngineSelect"
                      .value=${this.selectedSttEngine}
                      @change=${(e: Event) => {
                        this.selectedSttEngine = (e.target as HTMLSelectElement).value;
                        const eng = this.audioDiscovery?.stt.find(
                          (item) => item.id === this.selectedSttEngine,
                        );
                        this.selectedSttModel = eng?.models[0]?.id || '';
                      }}
                    >
                      ${(this.audioDiscovery?.stt || []).map(
                        (eng: AudioEngineInfo) => html`
                          <option
                            value=${eng.id}
                            ?selected=${this.selectedSttEngine === eng.id}
                          >
                            ${eng.name} — ${eng.available ? 'Ready' : 'Unavailable'}
                          </option>
                        `,
                      )}
                      <option value="browser" ?selected=${this.selectedSttEngine === 'browser'}>
                        Browser Web Speech STT (Fallback)
                      </option>
                    </select>
                    ${(() => {
                      const eng = this.audioDiscovery?.stt.find(
                        (item) => item.id === this.selectedSttEngine,
                      );
                      if (this.selectedSttEngine === 'browser') {
                        return html`<div class="hint-text">
                          Uses browser Web Speech API when no local server STT engine is active.
                        </div>`;
                      }
                      if (!eng) return '';
                      return html`
                        <div class="hint-text ${eng.available ? 'ok' : 'warn'}">
                          ${eng.statusMessage}
                        </div>
                        ${eng.models.length > 0
                          ? html`
                              <select
                                class="setting-input"
                                id="sttModelSelect"
                                style="margin-top:6px;"
                                .value=${this.selectedSttModel}
                              >
                                ${eng.models.map(
                                  (m) => html`
                                    <option
                                      value=${m.id}
                                      ?selected=${this.selectedSttModel === m.id}
                                    >
                                      ${m.name}
                                    </option>
                                  `,
                                )}
                              </select>
                            `
                          : ''}
                      `;
                    })()}
                  </div>

                  <div class="setting-group">
                    <label class="setting-label" for="ttsEngineSelect">Text-to-Speech (TTS) Engine</label>
                    <select
                      class="setting-input"
                      id="ttsEngineSelect"
                      .value=${this.selectedTtsEngine}
                      @change=${(e: Event) => {
                        this.selectedTtsEngine = (e.target as HTMLSelectElement).value;
                        const eng = this.audioDiscovery?.tts.find(
                          (item) => item.id === this.selectedTtsEngine,
                        );
                        this.selectedTtsVoice = eng?.models[0]?.id || '';
                      }}
                    >
                      ${(this.audioDiscovery?.tts || []).map(
                        (eng: AudioEngineInfo) => html`
                          <option
                            value=${eng.id}
                            ?selected=${this.selectedTtsEngine === eng.id}
                          >
                            ${eng.name} — ${eng.available ? 'Ready' : 'Unavailable'}
                          </option>
                        `,
                      )}
                      <option value="browser" ?selected=${this.selectedTtsEngine === 'browser'}>
                        Browser SpeechSynthesis (Fallback)
                      </option>
                    </select>
                    ${(() => {
                      const eng = this.audioDiscovery?.tts.find(
                        (item) => item.id === this.selectedTtsEngine,
                      );
                      if (this.selectedTtsEngine === 'browser') {
                        return html`<div class="hint-text">
                          Uses browser SpeechSynthesis API when local Piper/Kokoro is not running.
                        </div>`;
                      }
                      if (!eng) return '';
                      return html`
                        <div class="hint-text ${eng.available ? 'ok' : 'warn'}">
                          ${eng.statusMessage}
                        </div>
                        ${eng.models.length > 0
                          ? html`
                              <select
                                class="setting-input"
                                id="ttsVoiceSelect"
                                style="margin-top:6px;"
                                .value=${this.selectedTtsVoice}
                              >
                                ${eng.models.map(
                                  (m) => html`
                                    <option
                                      value=${m.id}
                                      ?selected=${this.selectedTtsVoice === m.id}
                                    >
                                      ${m.name}
                                    </option>
                                  `,
                                )}
                              </select>
                            `
                          : ''}
                      `;
                    })()}
                  </div>
                </div>
              `}

          <div class="setting-group">
            <label class="setting-label" for="visualModeSelect">Orb Visual Style</label>
            <select class="setting-input" id="visualModeSelect" .value=${this.visualMode}>
              <option value="vivica-canvas" ?selected=${this.visualMode === 'vivica-canvas'}>
                VIVICA Reactive Glow Orb (Canvas)
              </option>
              <option value="three-3d" ?selected=${this.visualMode === 'three-3d'}>
                3D Cosmic Shader Sphere (Three.js)
              </option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label" for="systemPrompt">System Instruction</label>
            <textarea
              class="setting-input"
              id="systemPrompt"
              rows="4"
              placeholder="Your name is Vivica..."
              .value=${this.systemPrompt}
            ></textarea>
          </div>

          <button type="submit" class="btn-apply">Save & Apply</button>
        </form>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio': GdmLiveAudio;
  }
}
