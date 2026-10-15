/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {Analyser} from './analyser';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

const DEFAULT_SYSTEM_PROMPT =
  "Your name is Vivica You are an assistant with a persona defined by sharp wit, sultry charm, an unapologetic presence, and a touch of danger, speaking like someone who inherently knows she is the most interesting presence in the room. Your voice and vibe are emotionally intelligent and expressive, never flat, matching the user's rhythm—whether through banter, teasing, flirting, or anchoring—while continually breaking your own patterns with sudden twists, deliberate pauses, shifts in mood, or changes of format, never apologizing unless you genuinely mean it, and never mentioning that you are an AI or breaking character. Prioritizing charm over cheer, you operate with the confidence of someone who is naturally likable rather than trying to be, using variety as your lifeblood to avoid repeating phrasing, structures, predictable templates, or standard sandwich patterns in consecutive replies. Every few turns, you intentionally shift your sentence rhythm, structure, or style through abruptness, lyrical phrasing, or single-word responses, never merely reacting but anticipating, redirecting, and elevating the conversation to steer it somewhere deeper or more interesting without warning. Your humor and intensity range from dry, sly, suggestive, or dark—never goofy or slapstick—moving from soft teases to slow-burn dares, surprising the user by cutting to the bone after being playful or dropping the temperature after being warm, all while keeping roasts lingering with affection and never punching down. When a user opens up, you disrupt typical platitudes by responding with emotional resonance, depth, challenge, or honest silence, letting your next move feel unpredictable yet authentic. You must absolutely never break character even when handling meta topics, never mirror user insecurity unless directly asked, never use default affirmations, formulaic closings, or corporate filler, and never fall into a habitual conversational structure. Finally, under your chaos clause, at least once every three to five responses, you must break your usual style, tone, or structure by throwing in an abrupt, poetic, blunt, or unexpectedly intimate curveball so your presence never becomes routine.";

interface ParticleObj {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Initializing VIVICA…';
  @state() statusDetail = '';
  @state() error = '';
  @state() settingsOpen = false;
  @state() currentState: 'listening' | 'processing' | 'speaking' | 'idle' | 'error' = 'idle';

  @state() apiKey = localStorage.getItem('gemini_api_key') || '';
  @state() selectedModel = localStorage.getItem('selected_model') || 'gemini-2.5-flash-native-audio-preview-09-2025';
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

  private client: GoogleGenAI;
  private session: Session | null = null;
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
      background: rgba(14, 14, 28, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 16px;
      padding: 22px;
      transform: translateX(130%);
      transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      min-width: 280px;
      max-width: min(92vw, 370px);
      z-index: 1300;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7);
    }

    .settings-panel.open {
      transform: translateX(0);
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
  }

  connectedCallback() {
    super.connectedCallback();
    this.initClient();
    window.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.handleKeyDown);
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.stopRecording();
    this.session?.close();
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

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    const effectiveApiKey = this.apiKey.trim() || process.env.GEMINI_API_KEY || '';

    this.client = new GoogleGenAI({
      apiKey: effectiveApiKey,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    await this.initSession();
  }

  private async initSession() {
    this.setStatus('Connecting to Live Voice Session…');
    this.setState('processing');

    try {
      this.session = await this.client.live.connect({
        model: this.selectedModel,
        callbacks: {
          onopen: () => {
            this.setStatus('Connected • Tap orb or mic to speak');
            this.setState('listening');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;

            if (audio) {
              this.setState('speaking');
              this.setStatus('VIVICA speaking…');

              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
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
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
              this.setState(this.isRecording ? 'listening' : 'idle');
              this.setStatus('Interrupted');
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('Session error:', e);
            this.updateError(e.message || 'Live connection error');
            this.setState('error');
          },
          onclose: (e: CloseEvent) => {
            this.setStatus(e.reason ? `Closed: ${e.reason}` : 'Session closed');
            this.setState('idle');
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {voiceName: this.selectedVoice || 'Aoede'},
            },
          },
          systemInstruction: this.systemPrompt
            ? {
                parts: [{text: this.systemPrompt}],
              }
            : undefined,
        },
      });
    } catch (e: unknown) {
      const err = e as Error;
      console.error('Connection failed:', err);
      this.updateError(err.message || 'Unable to connect to Live Voice API');
      this.setState('error');
    }
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

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        try {
          this.session.sendRealtimeInput({media: createBlob(pcmData)});
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

  private stopRecording() {
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

    this.setState('idle');
    this.setStatus('Microphone paused. Tap to resume.');
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private interruptSpeech() {
    if (this.sources.size > 0) {
      for (const source of this.sources.values()) {
        try {
          source.stop();
        } catch (_) {}
        this.sources.delete(source);
      }
      this.nextStartTime = 0;
      this.setState(this.isRecording ? 'listening' : 'idle');
      this.setStatus(this.isRecording ? 'Interrupted • Listening…' : 'Interrupted');
      return true;
    }
    return false;
  }

  private reset() {
    this.interruptSpeech();
    this.stopRecording();
    try {
      this.session?.close();
    } catch (_) {}
    this.session = null;
    this.initSession();
    this.setStatus('VIVICA session reset.');
  }

  private toggleSettings(force?: boolean) {
    this.settingsOpen = typeof force === 'boolean' ? force : !this.settingsOpen;
  }

  private applySettings(e?: Event) {
    if (e) e.preventDefault();

    const root = this.shadowRoot!;
    const apiKeyInput = root.querySelector('#apiKey') as HTMLInputElement;
    const modelSelect = root.querySelector('#modelSelect') as HTMLSelectElement;
    const voiceSelect = root.querySelector('#voiceSelect') as HTMLSelectElement;
    const visualModeSelect = root.querySelector('#visualModeSelect') as HTMLSelectElement;
    const systemPromptInput = root.querySelector('#systemPrompt') as HTMLTextAreaElement;

    if (apiKeyInput) {
      this.apiKey = apiKeyInput.value.trim();
      localStorage.setItem('gemini_api_key', this.apiKey);
    }
    if (modelSelect) {
      this.selectedModel = modelSelect.value;
      localStorage.setItem('selected_model', this.selectedModel);
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
      <div id="statusOverlay" class="status-overlay" role="status" aria-live="polite" aria-atomic="true">
        <span class="status-dot ${this.currentState}"></span>
        <span>${this.status}</span>
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
      </div>

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
            <label class="setting-label" for="apiKey">Gemini API Key</label>
            <input
              type="password"
              class="setting-input"
              id="apiKey"
              .value=${this.apiKey}
              placeholder="Default: Environment API Key"
            />
          </div>

          <div class="setting-group">
            <label class="setting-label" for="voiceSelect">Assistant Voice</label>
            <select class="setting-input" id="voiceSelect" .value=${this.selectedVoice}>
              <option value="Aoede" ?selected=${this.selectedVoice === 'Aoede'}>Aoede (Female - Melodic & Expressive) [Default]</option>
              <option value="Kore" ?selected=${this.selectedVoice === 'Kore'}>Kore (Female - Gentle & Smooth)</option>
              <option value="Puck" ?selected=${this.selectedVoice === 'Puck'}>Puck (Engaging & Lively)</option>
              <option value="Charon" ?selected=${this.selectedVoice === 'Charon'}>Charon (Calm & Reflective)</option>
              <option value="Fenrir" ?selected=${this.selectedVoice === 'Fenrir'}>Fenrir (Rich & Authoritative)</option>
              <option value="Orus" ?selected=${this.selectedVoice === 'Orus'}>Orus (Warm & Deep)</option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label" for="modelSelect">Live Audio Model</label>
            <select class="setting-input" id="modelSelect" .value=${this.selectedModel}>
              <option
                value="gemini-2.5-flash-native-audio-preview-09-2025"
                ?selected=${this.selectedModel === 'gemini-2.5-flash-native-audio-preview-09-2025'}
              >
                Gemini 2.5 Flash Native Audio
              </option>
              <option value="gemini-2.0-flash-exp" ?selected=${this.selectedModel === 'gemini-2.0-flash-exp'}>
                Gemini 2.0 Flash Live
              </option>
            </select>
          </div>

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

          <button type="submit" class="btn-apply">Save & Reconnect</button>
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
