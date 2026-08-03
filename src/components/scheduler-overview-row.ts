import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CardConfig, Schedule, Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeEntityIcon } from '../data/format/compute_entity_icon';
import { computeEntityDisplay } from '../data/format/compute_entity_display';
import { computeDomain } from '../lib/entity';
import { pickEntryForWeekday } from '../data/schedule/pick_entry_for_weekday';
import { entryAppliesOn } from '../data/schedule/entry_applies_on';
import { saveSchedule } from '../data/store/save_schedule';
import { updateSchedule } from '../data/store/update_schedule';
import { handleWebsocketError } from '../data/store/handle_websocket_error';
import { setLastOverviewUndo } from '../lib/overview_undo';
import { isOnAction, isOffAction } from '../data/format/is_off_action';
import { mdiContentCopy } from '@mdi/js';
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
  /** Passed through to the bar as the "now" marker (today only). */
  @property({ attribute: false }) now?: Date;
  /** 1 = a single day; 2 = this day plus the next, side by side. */
  @property({ type: Number }) spanDays = 1;

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
      // A schedule limited to e.g. Fridays still has an entry to draw, but
      // it does not run on a Tuesday - show that rather than drawing both
      // cases identically.
      const baseDate = this.date || new Date();
      const applies = entryAppliesOn(entry, baseDate);

      // Two-day view: the next day is drawn beside this one, so a schedule
      // running across midnight can be read in one go. It is a comparison
      // view - editing stays in the single-day view, where a drag maps to
      // exactly one day.
      const nextDate = new Date(baseDate.getTime() + 24 * 3600 * 1000);
      const next = this.spanDays === 2 ? pickEntryForWeekday(this.schedule.entries, nextDate) : null;
      const nextApplies = next ? entryAppliesOn(next.entry, nextDate) : false;
      // Exactly half each: the ruler splits its width 50/50, and any gap here
      // would drift the bars away from the hour ticks labelling them. The day
      // divider is drawn as an overlay instead, taking no layout space.
      const halfWidth = this.spanDays === 2 ? this.viewportWidth / 2 : this.viewportWidth;
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
        <div class="row ${disabled ? 'disabled' : ''} ${applies ? '' : 'not-today'}">
          <div class="device">
            <ha-icon
              icon="${icon}"
              class="toggle"
              title=${localize('ui.panel.overview.tap_icon_to_toggle', this.hass)}
              @click=${this._handleToggle}
            ></ha-icon>
            <span class="label" @click=${this._handleEditClick}>${label}</span>
            <ha-icon-button
              class="duplicate"
              .path=${mdiContentCopy}
              .label=${localize('ui.panel.overview.duplicate', this.hass)}
              title=${localize('ui.panel.overview.duplicate', this.hass)}
              @click=${this._handleDuplicate}
            ></ha-icon-button>
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
          <div class="bar-wrap ${this.spanDays === 2 ? 'split' : ''}">
            <scheduler-overview-bar
              .hass=${this.hass}
              .config=${this.config}
              .slots=${entry.slots}
              .zoom=${this.zoom}
              .panPx=${this.panPx}
              .viewportWidth=${halfWidth}
              .editable=${this.editable && this.spanDays === 1}
              .now=${this.now}
              @slots-changed=${(ev: CustomEvent) => this._handleSlotsChanged(ev, entryIndex)}
              @slot-selected=${this._handleSlotSelected}
            ></scheduler-overview-bar>
            ${next ? html`
              <scheduler-overview-bar
                class="${nextApplies ? '' : 'not-today'}"
                .hass=${this.hass}
                .config=${this.config}
                .slots=${next.entry.slots}
                .zoom=${this.zoom}
                .panPx=${this.panPx}
                .viewportWidth=${halfWidth}
                .editable=${false}
              ></scheduler-overview-bar>
            ` : ''}
            ${this.spanDays === 1 ? this._renderActionPanel(entry.slots, entryIndex) : ''}
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

  /** Saves a copy of this schedule (no schedule_id => the backend creates one). */
  private _handleDuplicate(ev: Event) {
    ev.stopPropagation();
    const copy = { ...this.schedule } as Partial<Schedule>;
    delete copy.schedule_id;
    delete copy.entity_id;
    Promise.resolve(saveSchedule(this.hass, copy as Schedule))
      .catch(e => handleWebsocketError(e, this, this.hass));
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
    // An existing schedule must go to scheduler/edit; scheduler/add is for
    // creating one, and the backend rejects it when the id already exists.
    const write = updated.schedule_id
      ? updateSchedule(this.hass, updated as Schedule & { schedule_id: string })
      : saveSchedule(this.hass, updated);
    return Promise.resolve(write)
      .then(() => { if (confirm) this._showSaved(); })
      .catch(e => {
        this._clearSaveState();
        handleWebsocketError(e, this, this.hass);
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
      .row.not-today .bar-wrap,
      .row.not-today .device {
        opacity: 0.45;
      }
      ha-icon-button.duplicate {
        flex: 0 0 auto;
        --mdc-icon-button-size: 26px;
        --mdc-icon-size: 15px;
        color: var(--secondary-text-color);
        opacity: 0;
        transition: opacity 0.12s ease-in-out;
      }
      .row:hover ha-icon-button.duplicate,
      ha-icon-button.duplicate:focus-visible {
        opacity: 1;
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
      .bar-wrap.split {
        display: flex;
        align-items: flex-end;
        gap: 0;
      }
      .bar-wrap.split::after {
        content: '';
        position: absolute;
        inset-inline-start: 50%;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--divider-color, rgba(127, 127, 127, 0.5));
        pointer-events: none;
      }
      .bar-wrap.split scheduler-overview-bar {
        flex: 1 1 0;
        min-width: 0;
      }
      .bar-wrap.split scheduler-overview-bar.not-today {
        opacity: 0.45;
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
