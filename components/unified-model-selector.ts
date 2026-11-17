import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ProviderId, ProviderStatus, UnifiedModelInfo } from '../types/ai';

function formatContextLength(ctx?: number): string {
  if (!ctx || !Number.isFinite(ctx)) return '';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}k ctx`;
  return `${ctx} ctx`;
}

function formatPricePerMillion(raw?: string): string {
  if (raw === undefined) return '?';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const perM = n * 1_000_000;
  if (perM === 0) return '$0';
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  return `$${perM.toFixed(2)}`;
}

function formatBytesShort(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

@customElement('vivica-model-selector')
export class VivicaModelSelector extends LitElement {
  @property({ type: Array }) models: UnifiedModelInfo[] = [];
  @property({ type: Array }) providers: ProviderStatus[] = [];
  @property({ type: String }) selectedModelId = '';
  @property({ type: String }) selectedProviderId: ProviderId = 'google';
  @property({ type: String }) filterProvider: ProviderId | 'all' = 'all';
  @property({ type: Boolean }) openRouterFreeOnly = false;
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) errorMessage = '';

  @state() private isOpen = false;
  @state() private searchQuery = '';

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
    }

    .trigger {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.2s, background 0.2s;
    }

    .trigger:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.4);
    }

    .trigger.open {
      border-color: #00ff88;
      background: rgba(255, 255, 255, 0.13);
    }

    .trigger-main {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }

    .trigger-top {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .trigger-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .trigger-sub {
      font-size: 10px;
      opacity: 0.7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .badge {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.5px;
      padding: 2px 5px;
      border-radius: 4px;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .badge-cloud {
      background: rgba(0, 180, 255, 0.2);
      border: 1px solid rgba(0, 180, 255, 0.45);
      color: #7ee0ff;
    }

    .badge-local {
      background: rgba(0, 255, 136, 0.18);
      border: 1px solid rgba(0, 255, 136, 0.45);
      color: #7effbf;
    }

    .badge-free {
      background: rgba(0, 255, 136, 0.2);
      border: 1px solid rgba(0, 255, 136, 0.5);
      color: #00ff88;
    }

    .badge-live {
      background: rgba(255, 180, 0, 0.18);
      border: 1px solid rgba(255, 180, 0, 0.45);
      color: #ffd166;
    }

    .dropdown {
      margin-top: 6px;
      background: rgba(12, 13, 26, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 10px;
      padding: 8px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .search-input {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.07);
      color: #fff;
      font-size: 12px;
      font-family: inherit;
      outline: none;
    }

    .search-input:focus {
      border-color: #00ff88;
    }

    .btn-mini {
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }

    .btn-mini:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.18);
    }

    .btn-mini:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .scope-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      justify-content: space-between;
    }

    .scope-tabs {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .scope-tab {
      padding: 3px 7px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: transparent;
      color: rgba(255, 255, 255, 0.72);
      font-size: 10px;
      cursor: pointer;
    }

    .scope-tab.active {
      background: rgba(0, 255, 136, 0.18);
      border-color: rgba(0, 255, 136, 0.55);
      color: #00ff88;
      font-weight: 600;
    }

    .free-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.88);
      cursor: pointer;
      padding: 2px 4px;
      user-select: none;
    }

    .free-toggle input {
      accent-color: #00ff88;
      cursor: pointer;
    }

    .list {
      max-height: 240px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-right: 2px;
    }

    .list::-webkit-scrollbar {
      width: 5px;
    }

    .list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.22);
      border-radius: 4px;
    }

    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.65);
      padding: 4px 4px 2px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .group-status {
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
      font-size: 10px;
    }

    .group-status.ok {
      color: #7effbf;
    }

    .group-status.warn {
      color: #ff9f7f;
    }

    .model-item {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 7px 8px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s;
    }

    .model-item:hover:not(.disabled) {
      background: rgba(255, 255, 255, 0.11);
      border-color: rgba(255, 255, 255, 0.28);
    }

    .model-item.selected {
      background: rgba(0, 255, 136, 0.14);
      border-color: rgba(0, 255, 136, 0.6);
    }

    .model-item.disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }

    .model-row-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .model-name {
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .model-badges {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .model-meta {
      font-size: 10px;
      opacity: 0.72;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .state-box {
      font-size: 11px;
      padding: 10px 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.78);
      text-align: center;
    }

    .state-box.error {
      background: rgba(255, 68, 68, 0.14);
      border: 1px solid rgba(255, 68, 68, 0.35);
      color: #ffb3b3;
    }
  `;

  private getSelectedModel(): UnifiedModelInfo | undefined {
    return (
      this.models.find(
        (m) => m.id === this.selectedModelId && m.provider === this.selectedProviderId,
      ) || this.models.find((m) => m.id === this.selectedModelId)
    );
  }

  private getProviderStatus(id: ProviderId): ProviderStatus | undefined {
    return this.providers.find((p) => p.id === id);
  }

  private handleSelect(model: UnifiedModelInfo) {
    if (!model.available) return;
    this.isOpen = false;
    this.dispatchEvent(
      new CustomEvent('select-model', {
        detail: {
          provider: model.provider,
          modelId: model.id,
          model,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleScopeChange(scope: ProviderId | 'all') {
    this.dispatchEvent(
      new CustomEvent('filter-provider-change', {
        detail: { scope },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleToggleFreeOnly(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(
      new CustomEvent('toggle-free-only', {
        detail: { freeOnly: checked },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleRefresh() {
    this.dispatchEvent(
      new CustomEvent('refresh-models', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderModelMeta(model: UnifiedModelInfo) {
    const parts: string[] = [];
    if (model.subProvider) parts.push(model.subProvider);
    const ctx = formatContextLength(model.contextLength);
    if (ctx) parts.push(ctx);

    if (model.provider === 'openrouter' && model.pricing) {
      if (model.pricing.isFree) {
        parts.push('Free ($0 / $0)');
      } else {
        parts.push(
          `${formatPricePerMillion(model.pricing.prompt)} in / ${formatPricePerMillion(model.pricing.completion)} out per 1M`,
        );
      }
    }

    if (model.provider === 'ollama') {
      if (model.parameterSize) parts.push(model.parameterSize);
      if (model.quantization) parts.push(model.quantization);
      const sz = formatBytesShort(model.sizeBytes);
      if (sz) parts.push(sz);
    }

    if (!model.available && model.unavailableReason) {
      parts.push(`Unavailable: ${model.unavailableReason}`);
    }

    return parts.join(' • ');
  }

  render() {
    const current = this.getSelectedModel();
    const currentHosting =
      current?.hosting || (this.selectedProviderId === 'ollama' ? 'local' : 'cloud');
    const displayLabel = current?.name || this.selectedModelId || 'Select a model…';
    const providerLabel =
      current?.providerLabel ||
      this.getProviderStatus(this.selectedProviderId)?.label ||
      this.selectedProviderId;

    const query = this.searchQuery.trim().toLowerCase();
    const showFreeToggle =
      this.filterProvider === 'openrouter' ||
      this.selectedProviderId === 'openrouter' ||
      this.filterProvider === 'all';

    const filtered = this.models.filter((m) => {
      if (this.filterProvider !== 'all' && m.provider !== this.filterProvider) {
        return false;
      }
      if (this.openRouterFreeOnly && m.provider === 'openrouter' && !m.pricing?.isFree) {
        return false;
      }
      if (!query) return true;
      const haystack = [
        m.name,
        m.id,
        m.providerLabel,
        m.subProvider || '',
        m.description || '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    const providerOrder: ProviderId[] =
      this.filterProvider === 'all'
        ? ['google', 'openrouter', 'ollama']
        : [this.filterProvider];

    return html`
      <button
        type="button"
        class="trigger ${this.isOpen ? 'open' : ''}"
        aria-expanded=${this.isOpen ? 'true' : 'false'}
        @click=${() => {
          this.isOpen = !this.isOpen;
        }}
      >
        <div class="trigger-main">
          <div class="trigger-top">
            <span class="badge ${currentHosting === 'local' ? 'badge-local' : 'badge-cloud'}">
              ${currentHosting}
            </span>
            <span class="trigger-name">${displayLabel}</span>
          </div>
          <div class="trigger-sub">
            ${providerLabel}${current?.id && current.id !== current.name ? ` • ${current.id}` : ''}
          </div>
        </div>
        <span>${this.isOpen ? '▲' : '▼'}</span>
      </button>

      ${this.isOpen
        ? html`
            <div
              class="dropdown"
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  this.isOpen = false;
                }
              }}
            >
              <div class="toolbar">
                <input
                  class="search-input"
                  type="search"
                  placeholder="Search models, providers..."
                  .value=${this.searchQuery}
                  @input=${(e: Event) => {
                    this.searchQuery = (e.target as HTMLInputElement).value;
                  }}
                />
                <button
                  type="button"
                  class="btn-mini"
                  ?disabled=${this.loading}
                  @click=${this.handleRefresh}
                  title="Refresh model catalog"
                >
                  ${this.loading ? '…' : '↻ Refresh'}
                </button>
              </div>

              <div class="scope-row">
                <div class="scope-tabs">
                  ${(['all', 'google', 'openrouter', 'ollama'] as const).map(
                    (scope) => html`
                      <button
                        type="button"
                        class="scope-tab ${this.filterProvider === scope ? 'active' : ''}"
                        @click=${() => this.handleScopeChange(scope)}
                      >
                        ${scope === 'all'
                          ? 'All'
                          : scope === 'google'
                            ? 'Google'
                            : scope === 'openrouter'
                              ? 'OpenRouter'
                              : 'Ollama'}
                      </button>
                    `,
                  )}
                </div>

                ${showFreeToggle
                  ? html`
                      <label class="free-toggle" title="Strictly filter OpenRouter models with $0 pricing">
                        <input
                          type="checkbox"
                          .checked=${this.openRouterFreeOnly}
                          @change=${this.handleToggleFreeOnly}
                        />
                        <span>Free Models Only</span>
                      </label>
                    `
                  : ''}
              </div>

              ${this.errorMessage
                ? html`<div class="state-box error">${this.errorMessage}</div>`
                : ''}

              <div class="list" role="listbox" aria-label="Available AI models">
                ${this.loading && filtered.length === 0
                  ? html`<div class="state-box">Loading model catalog…</div>`
                  : ''}

                ${!this.loading && filtered.length === 0
                  ? html`
                      <div class="state-box">
                        ${this.searchQuery
                          ? `No models matching "${this.searchQuery}".`
                          : this.openRouterFreeOnly && this.filterProvider === 'openrouter'
                            ? 'No free OpenRouter models match.'
                            : 'No models available for this provider.'}
                      </div>
                    `
                  : ''}

                ${providerOrder.map((pid) => {
                  const groupModels = filtered.filter((m) => m.provider === pid);
                  const status = this.getProviderStatus(pid);
                  if (groupModels.length === 0 && this.filterProvider === 'all') {
                    if (!this.searchQuery && status) {
                      return html`
                        <div>
                          <div class="group-header">
                            <span>${status.label}</span>
                            <span class="group-status warn">${status.statusMessage}</span>
                          </div>
                        </div>
                      `;
                    }
                    return '';
                  }

                  const groupLabel =
                    status?.label ||
                    (pid === 'google'
                      ? 'Google AI'
                      : pid === 'openrouter'
                        ? 'OpenRouter'
                        : 'Ollama (Local)');

                  return html`
                    <div>
                      <div class="group-header">
                        <span>${groupLabel} (${groupModels.length})</span>
                        ${status
                          ? html`<span class="group-status ${status.available ? 'ok' : 'warn'}">
                              ${status.available ? 'Ready' : status.error || status.statusMessage}
                            </span>`
                          : ''}
                      </div>
                      ${groupModels.map((model) => {
                        const isSelected =
                          model.id === this.selectedModelId &&
                          model.provider === this.selectedProviderId;
                        return html`
                          <button
                            type="button"
                            role="option"
                            aria-selected=${isSelected ? 'true' : 'false'}
                            aria-disabled=${!model.available ? 'true' : 'false'}
                            class="model-item ${isSelected ? 'selected' : ''} ${!model.available ? 'disabled' : ''}"
                            @click=${() => this.handleSelect(model)}
                          >
                            <div class="model-row-top">
                              <span class="model-name">${model.name}</span>
                              <div class="model-badges">
                                ${model.supportsNativeAudio
                                  ? html`<span class="badge badge-live">LIVE AUDIO</span>`
                                  : ''}
                                ${model.pricing?.isFree
                                  ? html`<span class="badge badge-free">FREE</span>`
                                  : ''}
                                <span
                                  class="badge ${model.hosting === 'local' ? 'badge-local' : 'badge-cloud'}"
                                >
                                  ${model.hosting}
                                </span>
                              </div>
                            </div>
                            <div class="model-meta">${this.renderModelMeta(model)}</div>
                          </button>
                        `;
                      })}
                    </div>
                  `;
                })}
              </div>
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vivica-model-selector': VivicaModelSelector;
  }
}
