import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { CardConfig, Schedule } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeEntityIcon } from '../data/format/compute_entity_icon';
import { computeEntityDisplay } from '../data/format/compute_entity_display';
import { computeDomain } from '../lib/entity';
import { pickEntryForWeekday } from '../data/schedule/pick_entry_for_weekday';

import './scheduler-overview-bar';

@customElement('scheduler-overview-row')
export class SchedulerOverviewRow extends LitElement {
  @property() hass!: HomeAssistant;
  @property() schedule_id!: string;
  @property() schedule!: Schedule;
  @property() config!: CardConfig;
  @property({ attribute: false }) date?: Date;

  render() {
    try {
      const stateObj = this.hass.states[this.schedule.entity_id!];
      if (!stateObj) return html``;
      const disabled = ['off', 'completed'].includes(stateObj.state);

      const entry = pickEntryForWeekday(this.schedule.entries, this.date);
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
        <div class="row ${disabled ? 'disabled' : ''}" @click=${this._handleClick}>
          <ha-icon icon="${icon}"></ha-icon>
          <span class="label">${label}</span>
          <scheduler-overview-bar .hass=${this.hass} .slots=${entry.slots}></scheduler-overview-bar>
        </div>
      `;
    } catch (e) {
      return html``;
    }
  }

  private _handleClick() {
    const myEvent = new CustomEvent('editClick', { detail: { schedule_id: this.schedule_id } });
    this.dispatchEvent(myEvent);
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
        cursor: pointer;
      }
      .row:hover {
        background: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.04);
      }
      ha-icon {
        flex: 0 0 24px;
        color: var(--state-icon-color);
      }
      .label {
        flex: 0 0 110px;
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
