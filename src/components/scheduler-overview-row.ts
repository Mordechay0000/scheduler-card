import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CardConfig, Schedule } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeEntityIcon } from '../data/format/compute_entity_icon';
import { computeEntityDisplay } from '../data/format/compute_entity_display';
import { computeDomain } from '../lib/entity';
import { pickEntryForWeekday } from '../data/schedule/pick_entry_for_weekday';
import { saveSchedule } from '../data/store/save_schedule';

import './scheduler-overview-bar';

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
          <div class="device" @click=${this._handleToggle}>
            <ha-icon icon="${icon}"></ha-icon>
            <span class="label">${label}</span>
          </div>
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

  private _handleSlotsChanged(ev: CustomEvent, entryIndex: number) {
    ev.stopPropagation();
    const slots = ev.detail.slots;
    const entries = Object.assign([...this.schedule.entries], {
      [entryIndex]: { ...this.schedule.entries[entryIndex], slots },
    });
    const updated: Schedule = { ...this.schedule, entries };
    saveSchedule(this.hass, updated);
    this.dispatchEvent(new CustomEvent('scheduleChanged', { detail: { schedule: updated } }));
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
      }
      .row {
        display: flex;
        align-items: center;
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
        cursor: pointer;
        border-radius: 6px;
        padding: 2px 4px;
        margin-inline-start: -4px;
      }
      .device:hover {
        background: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.06);
      }
      ha-icon {
        flex: 0 0 24px;
        color: var(--state-icon-color);
      }
      .label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.85rem;
        color: var(--primary-text-color);
      }
      .row.disabled ha-icon,
      .row.disabled .label {
        color: var(--disabled-text-color);
      }
      scheduler-overview-bar {
        flex: 1;
        min-width: 0;
      }
      .row.disabled scheduler-overview-bar {
        opacity: 0.5;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-row": SchedulerOverviewRow;
  }
}
