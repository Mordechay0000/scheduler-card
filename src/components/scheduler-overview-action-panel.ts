import { LitElement, html, css, CSSResultGroup, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { mdiPower, mdiPowerOff } from '@mdi/js';
import { Action } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeDomain } from '../lib/entity';
import { isOnAction, isOffAction } from '../data/format/is_off_action';
import { localize } from '../localize/localize';

/**
 * The minimal action editor shared by overview mode's inline editing and its
 * add-schedule flow: pick turn_on / turn_off for the selected slot, and for
 * lights adjust brightness, colour temperature and colour. Anything more
 * involved still belongs in the full dialog.
 *
 * Emits `action-changed` with the replacement Action; the parent owns the
 * slots and decides when to persist them.
 */
@customElement('scheduler-overview-action-panel')
export class SchedulerOverviewActionPanel extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public action?: Action;
  @property() public entityId!: string;

  private _fire(action: Action) {
    this.dispatchEvent(new CustomEvent('action-changed', { detail: { action } }));
  }

  private _setOnOff(on: boolean) {
    const domain = computeDomain(this.entityId);
    this._fire({
      service: `${domain}.${on ? 'turn_on' : 'turn_off'}`,
      service_data: {},
      target: { entity_id: this.entityId },
    });
  }

  // Live-updates the parameters of a turn_on action: the bar re-tints itself
  // from these, so moving a slider previews the setting straight away.
  private _setParam(key: string, value: number) {
    if (!this.action) return;
    const service_data: Record<string, any> = { ...this.action.service_data, [key]: value };
    // A colour temperature and an explicit colour are mutually exclusive.
    if (key === 'color_temp_kelvin') delete service_data.rgb_color;
    this._fire({ ...this.action, service_data });
  }

  private _setColor(hex: string) {
    if (!this.action) return;
    const rgb = [1, 3, 5].map(o => parseInt(hex.substr(o, 2), 16));
    const service_data: Record<string, any> = { ...this.action.service_data, rgb_color: rgb };
    delete service_data.color_temp_kelvin;
    this._fire({ ...this.action, service_data });
  }

  private _renderParams() {
    const action = this.action;
    if (!action || computeDomain(action.service) !== 'light' || !isOnAction(action)) return nothing;

    const supported: string[] = this.hass.states[this.entityId]?.attributes?.supported_color_modes || [];
    const supportsTemp = supported.includes('color_temp');
    const supportsColor = ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].some(m => supported.includes(m));

    const data = action.service_data || {};
    const rgb = data.rgb_color;
    const hex = Array.isArray(rgb) && rgb.length >= 3
      ? '#' + rgb.slice(0, 3).map((v: number) => Math.round(v).toString(16).padStart(2, '0')).join('')
      : '#ffb46b';

    return html`
      <div class="params">
        <label>
          <span>${localize('ui.panel.overview.brightness', this.hass)}</span>
          <input
            type="range" min="1" max="255"
            .value=${String(data.brightness ?? 255)}
            @input=${(ev: Event) => this._setParam('brightness', Number((ev.target as HTMLInputElement).value))}
          />
        </label>
        ${supportsTemp ? html`
          <label>
            <span>${localize('ui.panel.overview.color_temp', this.hass)}</span>
            <input
              type="range" min="2000" max="6500" step="100"
              .value=${String(data.color_temp_kelvin ?? 4000)}
              @input=${(ev: Event) => this._setParam('color_temp_kelvin', Number((ev.target as HTMLInputElement).value))}
            />
          </label>
        ` : nothing}
        ${supportsColor ? html`
          <label>
            <span>${localize('ui.panel.overview.color', this.hass)}</span>
            <input
              type="color"
              .value=${hex}
              @input=${(ev: Event) => this._setColor((ev.target as HTMLInputElement).value)}
            />
          </label>
        ` : nothing}
      </div>
    `;
  }

  render() {
    if (!this.hass || !this.entityId) return html``;
    const on = this.action ? isOnAction(this.action) : false;
    const off = this.action ? isOffAction(this.action) : false;

    return html`
      <div class="action-panel">
        <div class="act-group">
          <button class="act on ${on ? 'active' : ''}" @click=${() => this._setOnOff(true)}>
            <ha-svg-icon .path=${mdiPower}></ha-svg-icon>
            ${localize('ui.panel.overview.turn_on', this.hass)}
          </button>
          <button class="act off ${off ? 'active' : ''}" @click=${() => this._setOnOff(false)}>
            <ha-svg-icon .path=${mdiPowerOff}></ha-svg-icon>
            ${localize('ui.panel.overview.turn_off', this.hass)}
          </button>
        </div>
        ${this._renderParams()}
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host { display: block; }
      /* One panel directly under the selected slot's bar, so the action and
         its settings read as a single popover attached to that slot. */
      .action-panel {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px 14px;
        margin-top: 8px;
        padding: 7px 10px;
        border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.5));
        border-radius: 10px;
        background: var(--card-background-color);
      }
      .act-group {
        display: flex;
        gap: 4px;
      }
      .act {
        display: flex;
        align-items: center;
        gap: 2px;
        font-family: inherit;
        font-size: 0.62rem;
        border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.5));
        border-radius: 12px;
        padding: 1px 8px 1px 4px;
        cursor: pointer;
        background: var(--card-background-color);
        color: var(--secondary-text-color);
      }
      .act ha-svg-icon {
        --mdc-icon-size: 13px;
      }
      .act.on.active {
        background: rgb(var(--rgb-state-active-color, 67, 160, 71));
        border-color: transparent;
        color: var(--text-primary-color, #fff);
      }
      .act.off.active {
        background: rgb(211, 47, 47);
        border-color: transparent;
        color: var(--text-primary-color, #fff);
      }
      .params {
        display: flex;
        gap: 14px;
        align-items: center;
        flex-wrap: wrap;
      }
      .params label {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 0.62rem;
        color: var(--secondary-text-color);
      }
      .params input[type='range'] {
        width: 92px;
        accent-color: var(--primary-color);
      }
      .params input[type='color'] {
        width: 26px;
        height: 18px;
        padding: 0;
        border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.5));
        border-radius: 4px;
        background: none;
        cursor: pointer;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-action-panel": SchedulerOverviewActionPanel;
  }
}
