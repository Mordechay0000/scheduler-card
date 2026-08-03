import { LitElement, html, css, CSSResultGroup, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { mdiPlus, mdiClose, mdiCheck } from '@mdi/js';
import { CardConfig, Action, Schedule, TConditionLogicType, TRepeatType, TWeekday, Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeDomain } from '../lib/entity';
import { saveSchedule } from '../data/store/save_schedule';
import { handleWebsocketError } from '../data/store/handle_websocket_error';
import { localize } from '../localize/localize';

import './scheduler-overview-bar';
import './scheduler-overview-action-panel';
import './scheduler-entity-picker';

const conditions = () => ({ type: TConditionLogicType.Or, items: [], track_changes: false });

const onAction = (entityId: string): Action => ({
  service: `${computeDomain(entityId)}.turn_on`,
  service_data: {},
  target: { entity_id: entityId },
});

const offAction = (entityId: string): Action => ({
  service: `${computeDomain(entityId)}.turn_off`,
  service_data: {},
  target: { entity_id: entityId },
});

/**
 * A minimal, inline "add schedule" flow living at the bottom of the
 * overview list. Click "add" where a device would normally show to open a
 * small searchable entity picker; after picking an entity a draft schedule
 * appears (split into three, on/off/on by default) as an editable overview
 * bar. Select a slot and a floating on/off control assigns its action; the
 * check button saves it. Anything more advanced still goes through the full
 * dialog.
 */
@customElement('scheduler-overview-add-row')
export class SchedulerOverviewAddRow extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public config!: CardConfig;
  @property({ type: Number }) zoom = 1;
  @property({ type: Number }) panPx = 0;
  @property({ type: Number }) viewportWidth = 0;
  @property({ type: Boolean }) editable = true;

  @state() private _picking = false;
  @state() private _entityId: string | null = null;
  @state() private _slots: Timeslot[] = [];
  @state() private _selectedSlot: number | null = null;
  @state() private _saving = false;

  private _reset() {
    this._picking = false;
    this._entityId = null;
    this._slots = [];
    this._selectedSlot = null;
  }

  private _startPicking() {
    this._picking = true;
  }

  private _handleEntityPicked(ev: CustomEvent) {
    const value = ev.detail?.value;
    const entityId = Array.isArray(value) ? value[value.length - 1] : value;
    if (!entityId) return;
    this._entityId = entityId;
    this._picking = false;
    // Start divided into three (on during the middle of the day), same
    // spirit as the full editor's default, but immediately valid to save.
    // The backend represents end-of-day as 00:00:00, not 24:00:00.
    this._slots = [
      { start: '00:00:00', stop: '08:00:00', actions: [offAction(entityId)], conditions: conditions() },
      { start: '08:00:00', stop: '16:00:00', actions: [onAction(entityId)], conditions: conditions() },
      { start: '16:00:00', stop: '00:00:00', actions: [offAction(entityId)], conditions: conditions() },
    ];
    this._selectedSlot = null;
  }

  private _handleSlotsChanged(ev: CustomEvent) {
    ev.stopPropagation();
    this._slots = ev.detail.slots;
  }

  private _handleSlotSelected(ev: CustomEvent) {
    ev.stopPropagation();
    this._selectedSlot = ev.detail.index;
  }

  private _handleActionChanged(ev: CustomEvent) {
    const i = this._selectedSlot;
    if (i === null) return;
    this._slots = Object.assign([...this._slots], {
      [i]: { ...this._slots[i], actions: [ev.detail.action] },
    });
  }

  private async _save() {
    if (!this._slots.length) return;
    this._saving = true;
    const schedule: Schedule = {
      entries: [{ weekdays: [TWeekday.Daily], slots: this._slots }],
      repeat_type: TRepeatType.Repeat,
      next_entries: [],
      timestamps: [],
      enabled: true,
    };
    try {
      await saveSchedule(this.hass, schedule);
      this._reset();
    } catch (e) {
      // Keep the draft on screen so the work is not lost, and say why.
      handleWebsocketError(e as any, this, this.hass);
    } finally {
      this._saving = false;
    }
  }

  render() {
    if (!this.hass) return html``;

    const selected = this._selectedSlot;

    return html`
      <div class="row">
        <div class="device">
          ${this._entityId === null && !this._picking ? html`
            <button class="add-affordance" @click=${this._startPicking}>
              <ha-svg-icon .path=${mdiPlus}></ha-svg-icon>
              <span>${localize('ui.panel.overview.add_schedule', this.hass)}</span>
            </button>
          ` : this._picking ? html`
            <scheduler-entity-picker
              .hass=${this.hass}
              .config=${this.config}
              @value-changed=${this._handleEntityPicked}
            ></scheduler-entity-picker>
          ` : html`
            <div class="draft-device">
              <span class="draft-label">${this.hass.states[this._entityId!]?.attributes.friendly_name || this._entityId}</span>
              <ha-icon-button .path=${mdiClose} @click=${this._reset} class="cancel"></ha-icon-button>
              <ha-icon-button
                .path=${mdiCheck}
                @click=${this._save}
                .disabled=${this._saving}
                class="confirm"
              ></ha-icon-button>
            </div>
          `}
        </div>
        <div class="bar-wrap">
          ${this._slots.length ? html`
            <scheduler-overview-bar
              .hass=${this.hass}
              .config=${this.config}
              .slots=${this._slots}
              .zoom=${this.zoom}
              .panPx=${this.panPx}
              .viewportWidth=${this.viewportWidth}
              .editable=${this.editable}
              @slots-changed=${this._handleSlotsChanged}
              @slot-selected=${this._handleSlotSelected}
            ></scheduler-overview-bar>
            ${selected !== null ? html`
              <scheduler-overview-action-panel
                .hass=${this.hass}
                .entityId=${this._entityId!}
                .action=${this._slots[selected]?.actions[0]}
                @action-changed=${this._handleActionChanged}
              ></scheduler-overview-action-panel>
            ` : nothing}
          ` : nothing}
        </div>
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host { display: block; }
      .row {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        padding: 7px 0;
      }
      .device {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 146px;
        min-width: 0;
        padding-bottom: 2px;
      }
      .add-affordance {
        display: flex;
        align-items: center;
        gap: 8px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        color: var(--primary-color);
        font-family: inherit;
        font-size: 0.85rem;
      }
      .add-affordance ha-svg-icon {
        --mdc-icon-size: 22px;
        border-radius: 50%;
        border: 1px dashed currentColor;
        padding: 1px;
      }
      .add-affordance span {
        white-space: nowrap;
      }
      scheduler-entity-picker {
        flex: 1;
        min-width: 0;
      }
      .draft-device {
        display: flex;
        align-items: center;
        gap: 2px;
        width: 100%;
      }
      .draft-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.85rem;
        color: var(--primary-text-color);
      }
      .draft-device ha-icon-button {
        --mdc-icon-button-size: 30px;
        --mdc-icon-size: 20px;
      }
      .draft-device .confirm {
        color: rgb(var(--rgb-state-active-color, 67, 160, 71));
      }
      .draft-device .cancel {
        color: var(--secondary-text-color);
      }
      .bar-wrap {
        flex: 1;
        min-width: 0;
        position: relative;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-add-row": SchedulerOverviewAddRow;
  }
}
