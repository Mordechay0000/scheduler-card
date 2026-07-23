import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CardConfig, Schedule, Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeEntityIcon } from '../data/format/compute_entity_icon';
import { computeEntityDisplay } from '../data/format/compute_entity_display';
import { computeDomain } from '../lib/entity';
import { pickEntryForWeekday } from '../data/schedule/pick_entry_for_weekday';
import { saveSchedule } from '../data/store/save_schedule';
import { setLastOverviewUndo } from '../lib/overview_undo';
import { localize } from '../localize/localize';

import './scheduler-overview-bar';

const SAVED_LABEL_MS = 2500;

@customElement('scheduler-overview-row')
export class SchedulerOverviewRow extends LitElement {
  @property() hass!: HomeAssistant;
  @property() schedule_id!: string;
  @property() schedule!: Schedule;
  @property() config!: CardConfig;
  @property({ attribute: false }) date?: Date;
  @property({ type: Number }) zoom = 1;
  @property({ type: Number }) panPx = 0;
  @property({ type: Number }) viewportWidth = 0;

  @state() private _saveState: 'saved' | 'reset' | null = null;

  private _undoSlots?: Timeslot[];
  private _undoEntryIndex?: number;
  private _saveStateTimer?: number;

  render() {
    try {
      const stateObj = this.hass.states[this.schedule.entity_id!];
      if (!stateObj) return html``;
      const disabled = ['off', 'completed'].includes(stateObj.state);

      const { entry, index: entryIndex } = pickEntryForWeekday(this.schedule.entries, this.date);
      const firstAction = entry.slots.find(e => e.actions.length)?.actions[0];

      let icon = 'mdi:calendar-clock';
      if (firstAction) {
        let entityId = [firstAction.target?.entity_id || []].flat().shift();
        if (['script', 'notify'].includes(computeDomain(firstAction.service))) entityId = firstAction.service;
        if (entityId) icon = computeEntityIcon(entityId, this.config.customize, this.hass);
      }

      const label = firstAction
        ? computeEntityDisplay(
          ['script', 'notify'].includes(computeDomain(firstAction.service))
            ? firstAction.service
            : [firstAction.target?.entity_id || []].flat()[0] || '',
          this.hass, this.config.customize
        )
        : (this.schedule.name || this.schedule.entity_id);

      return html`
        <div class="row ${disabled ? 'disabled' : ''}">
          <div class="device">
            <ha-icon
              icon="${icon}"
              class="toggle"
              title=${localize('ui.panel.overview.tap_icon_to_toggle', this.hass)}
              @click=${this._handleToggle}
            ></ha-icon>
            <span class="label" @click=${this._handleEditClick}>${label}</span>
          </div>
          <div class="bar-wrap">
            ${this._saveState ? html`
              <button class="save-pill ${this._saveState}" @click=${this._performUndo}>
                ${this._saveState === 'saved'
        ? localize('ui.panel.overview.saved', this.hass)
        : localize('ui.panel.overview.undo', this.hass)}
              </button>
            ` : ''}
            <scheduler-overview-bar
              .hass=${this.hass}
              .config=${this.config}
              .slots=${entry.slots}
              .zoom=${this.zoom}
              .panPx=${this.panPx}
              .viewportWidth=${this.viewportWidth}
              @slots-changed=${(ev: CustomEvent) => this._handleSlotsChanged(ev, entryIndex)}
            ></scheduler-overview-bar>
          </div>
        </div>
      `;
    } catch (e) {
      return html``;
    }
  }

  private _handleToggle(ev: Event) {
    ev.stopPropagation();
    const stateObj = this.hass.states[this.schedule.entity_id!];
    if (!stateObj) return;
    const turnOn = ['off', 'completed'].includes(stateObj.state);
    this.hass.callService('switch', turnOn ? 'turn_on' : 'turn_off', { entity_id: this.schedule.entity_id });
  }

  private _handleEditClick(ev: Event) {
    ev.stopPropagation();
    this.dispatchEvent(new CustomEvent('editClick', { detail: { schedule_id: this.schedule_id } }));
  }

  private _handleSlotsChanged(ev: CustomEvent, entryIndex: number) {
    ev.stopPropagation();
    const previousSlots = this.schedule.entries[entryIndex].slots;
    const slots = ev.detail.slots;
    this._saveAndSet(entryIndex, slots);

    this._undoSlots = previousSlots;
    this._undoEntryIndex = entryIndex;
    setLastOverviewUndo(() => this._performUndo());
    this._showSaved();
  }

  private _saveAndSet(entryIndex: number, slots: Timeslot[]) {
    const entries = Object.assign([...this.schedule.entries], {
      [entryIndex]: { ...this.schedule.entries[entryIndex], slots },
    });
    const updated: Schedule = { ...this.schedule, entries };
    saveSchedule(this.hass, updated);
    this.dispatchEvent(new CustomEvent('scheduleChanged', { detail: { schedule: updated } }));
  }

  private _showSaved() {
    clearTimeout(this._saveStateTimer);
    this._saveState = 'saved';
    this._saveStateTimer = window.setTimeout(() => { this._saveState = 'reset'; }, SAVED_LABEL_MS);
  }

  private _performUndo() {
    if (this._undoSlots === undefined || this._undoEntryIndex === undefined) return;
    this._saveAndSet(this._undoEntryIndex, this._undoSlots);
    this._undoSlots = undefined;
    this._undoEntryIndex = undefined;
    setLastOverviewUndo(null);
    clearTimeout(this._saveStateTimer);
    this._saveState = null;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
      }
      .row {
        display: flex;
        /* The bar's own boundary-marker row sits above its colored strip,
           making it taller than the device label - bottom-align so the
           label lines up with the colored strip itself, not the middle of
           the whole (taller) block. */
        align-items: flex-end;
        gap: 12px;
        padding: 7px 0;
      }
      .device {
        display: flex;
        align-items: center;
        gap: 8px;
        /* Must add up (with the .row gap) to OVERVIEW_SPACER_WIDTH in
           scheduler-overview-ruler, so the ruler and every bar line up. */
        flex: 0 0 146px;
        min-width: 0;
        padding-bottom: 2px;
      }
      ha-icon.toggle {
        flex: 0 0 24px;
        color: var(--state-icon-color);
        cursor: pointer;
        border-radius: 50%;
        padding: 3px;
        margin: -3px;
        box-sizing: content-box;
      }
      ha-icon.toggle:hover {
        background: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.08);
      }
      .label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.85rem;
        color: var(--primary-text-color);
        cursor: pointer;
      }
      .label:hover {
        text-decoration: underline;
      }
      .row.disabled ha-icon,
      .row.disabled .label {
        color: var(--disabled-text-color);
      }
      .bar-wrap {
        flex: 1;
        min-width: 0;
        position: relative;
      }
      .row.disabled .bar-wrap {
        opacity: 0.5;
      }
      .save-pill {
        position: absolute;
        top: -18px;
        inset-inline-end: 0;
        font-size: 0.62rem;
        font-family: inherit;
        color: var(--secondary-text-color);
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        z-index: 6;
      }
      .save-pill.saved {
        color: rgb(var(--rgb-state-active-color, 67, 160, 71));
        animation: save-pulse 1.6s ease-in-out;
      }
      .save-pill.reset {
        text-decoration: underline;
      }
      @keyframes save-pulse {
        0% { opacity: 0.35; }
        50% { opacity: 1; }
        100% { opacity: 0.75; }
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-row": SchedulerOverviewRow;
  }
}
