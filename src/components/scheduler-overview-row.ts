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
import { isOnAction, isOffAction } from '../data/format/is_off_action';
import { localize } from '../localize/localize';

import './scheduler-overview-bar';
import './scheduler-overview-action-panel';

// How long the confirmation reads "saved" before turning into the reset
// button. Deliberately short: the label is an acknowledgement, not a status.
const SAVED_LABEL_MS = 500;

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
  @property({ type: Boolean }) editable = true;

  @state() private _saveState: 'saved' | 'reset' | null = null;

  @state() private _selectedSlot: number | null = null;

  // Every change since this card was opened, oldest first. Ctrl/Cmd+Z steps
  // back one entry; the "reset" button jumps all the way back to the first
  // one (the state the schedule had before any overview editing).
  private _undoStack: { slots: Timeslot[]; entryIndex: number }[] = [];
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
            ${this._saveState ? html`
              <button
                class="save-pill ${this._saveState}"
                ?disabled=${this._saveState !== 'reset'}
                title=${this._saveState === 'reset' ? localize('ui.panel.overview.reset_hint', this.hass) : ''}
                @click=${this._handlePillClick}
              >
                ${this._saveState === 'saved'
        ? localize('ui.panel.overview.saved', this.hass)
        : localize('ui.panel.overview.undo', this.hass)}
              </button>
            ` : ''}
          </div>
          <div class="bar-wrap">
            <scheduler-overview-bar
              .hass=${this.hass}
              .config=${this.config}
              .slots=${entry.slots}
              .zoom=${this.zoom}
              .panPx=${this.panPx}
              .viewportWidth=${this.viewportWidth}
              .editable=${this.editable}
              @slots-changed=${(ev: CustomEvent) => this._handleSlotsChanged(ev, entryIndex)}
              @slot-selected=${this._handleSlotSelected}
            ></scheduler-overview-bar>
            ${this._renderActionPanel(entry.slots, entryIndex)}
          </div>
        </div>
      `;
    } catch (e) {
      return html``;
    }
  }

  private _handleSlotSelected(ev: CustomEvent) {
    ev.stopPropagation();
    this._selectedSlot = ev.detail.index;
  }

  // Same minimal action editor the add-schedule flow offers, for a slot of
  // an existing schedule. Only shown for plain on/off actions: anything
  // richer (scripts, climate setpoints, ...) would be destroyed by the
  // on/off buttons, so those keep going through the full dialog.
  private _renderActionPanel(slots: Timeslot[], entryIndex: number) {
    const i = this._selectedSlot;
    if (!this.editable || i === null || !slots[i]) return '';
    const action = slots[i].actions[0];
    if (action && !isOnAction(action) && !isOffAction(action)) return '';

    const entityId = [action?.target?.entity_id || []].flat()[0]
      || [slots.find(s => s.actions.length)?.actions[0]?.target?.entity_id || []].flat()[0];
    if (!entityId) return '';

    return html`
      <scheduler-overview-action-panel
        .hass=${this.hass}
        .entityId=${entityId}
        .action=${action}
        @action-changed=${(ev: CustomEvent) => this._handleActionChanged(ev, slots, entryIndex)}
      ></scheduler-overview-action-panel>
    `;
  }

  private _handleActionChanged(ev: CustomEvent, slots: Timeslot[], entryIndex: number) {
    ev.stopPropagation();
    const i = this._selectedSlot;
    if (i === null) return;
    const newSlots = Object.assign([...slots], {
      [i]: { ...slots[i], actions: [ev.detail.action] },
    });
    this._handleSlotsChanged(
      new CustomEvent('slots-changed', { detail: { slots: newSlots } }),
      entryIndex
    );
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
    // Capture the pre-change state BEFORE saving, so undo/reset has
    // something to go back to even if the save itself fails.
    this._undoStack.push({ slots: this.schedule.entries[entryIndex].slots, entryIndex });
    setLastOverviewUndo(() => this._performUndo());

    this._saveAndSet(entryIndex, ev.detail.slots, true);
  }

  /**
   * Persists the slots and, for a user edit, confirms it afterwards: the
   * "saved" label only appears once the backend has actually accepted the
   * change, so it never claims a save that failed.
   */
  private _saveAndSet(entryIndex: number, slots: Timeslot[], confirm = false) {
    const entries = Object.assign([...this.schedule.entries], {
      [entryIndex]: { ...this.schedule.entries[entryIndex], slots },
    });
    const updated: Schedule = { ...this.schedule, entries };
    // Hold the edit locally too: the backend round-trip is asynchronous, and
    // without this the bar snaps back to the old slots on the next render.
    this.schedule = updated;
    this.dispatchEvent(new CustomEvent('scheduleChanged', { detail: { schedule: updated } }));
    return Promise.resolve(saveSchedule(this.hass, updated))
      .then(() => { if (confirm) this._showSaved(); })
      .catch(e => {
        // eslint-disable-next-line no-console
        console.error('scheduler-card: could not save schedule', e);
        this._clearSaveState();
      });
  }

  private _showSaved() {
    clearTimeout(this._saveStateTimer);
    this._saveState = 'saved';
    this._saveStateTimer = window.setTimeout(() => { this._saveState = 'reset'; }, SAVED_LABEL_MS);
  }

  private _handlePillClick() {
    // Only the "reset" state is actionable; while it still reads "saved"
    // the pill is just a confirmation of the change that was written.
    if (this._saveState === 'reset') this._performReset();
  }

  // Ctrl/Cmd+Z: step back one change.
  private _performUndo() {
    const previous = this._undoStack.pop();
    if (!previous) return;
    if (this._undoStack.length) setLastOverviewUndo(() => this._performUndo());
    else this._clearSaveState();
    this._saveAndSet(previous.entryIndex, previous.slots);
  }

  // "Reset": discard every overview edit made since the card was opened,
  // going back to the very first recorded state rather than one step.
  private _performReset() {
    const original = this._undoStack[0];
    if (!original) return;
    this._undoStack = [];
    this._clearSaveState();
    this._saveAndSet(original.entryIndex, original.slots);
  }

  private _clearSaveState() {
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
        /* Lives in the device column, not over the bar: the bar's own
           boundary time labels occupy every free spot above it, and the
           strip itself must not be covered. */
        flex: 0 0 auto;
        font-size: 0.68rem;
        font-weight: 500;
        font-family: inherit;
        line-height: 1;
        color: var(--text-primary-color, #fff);
        border: none;
        border-radius: 11px;
        padding: 4px 9px;
        cursor: default;
        white-space: nowrap;
        z-index: 6;
      }
      .save-pill.saved {
        background: rgb(var(--rgb-state-active-color, 67, 160, 71));
        animation: save-pulse 1.6s ease-in-out;
        opacity: 1;
      }
      .save-pill.reset {
        cursor: pointer;
        background: var(--primary-color);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      }
      .save-pill.reset:hover {
        filter: brightness(1.1);
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
