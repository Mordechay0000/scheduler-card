import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { computeTimestamp } from '../data/time/compute_timestamp';
import { isOffAction, isOnAction } from '../data/format/is_off_action';
import { computeActionColor } from '../data/format/compute_action_color';

const SEC_PER_DAY = 24 * 3600;

/**
 * A compact, read-only rendering of a slot list: same color language as the
 * full timeslot editor (on/off/tinted/empty), but without any of the
 * interactive machinery (selection, dragging, zoom).
 */
@customElement('scheduler-overview-bar')
export class SchedulerOverviewBar extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public slots!: Timeslot[];

  render() {
    const widths = this.slots.map((slot, i) => {
      const start = computeTimestamp(slot.start, this.hass);
      let stop: number;
      if (slot.stop !== undefined) {
        stop = computeTimestamp(slot.stop, this.hass) || SEC_PER_DAY;
      } else {
        const next = this.slots[i + 1];
        stop = next ? (computeTimestamp(next.start, this.hass) || SEC_PER_DAY) : SEC_PER_DAY;
      }
      return ((stop - start) / SEC_PER_DAY) * 100;
    });

    return html`
      <div class="bar">
        ${this.slots.map((slot, i) => {
      const state = !slot.actions.length ? 'empty'
        : isOffAction(slot.actions[0]) ? 'off'
          : isOnAction(slot.actions[0]) ? 'on' : '';
      const color = slot.actions.length ? computeActionColor(slot.actions[0]) : null;
      return html`
            <div
              class="seg ${state}"
              style=${styleMap({
        width: `${widths[i]}%`,
        ...(color ? { background: `rgba(${color.rgb.join(', ')}, ${color.alpha})` } : {}),
      })}
            ></div>
          `;
    })}
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        width: 100%;
      }
      .bar {
        display: flex;
        width: 100%;
        height: 26px;
        border-radius: 6px;
        overflow: hidden;
      }
      .seg {
        height: 100%;
      }
      .seg.on {
        background: rgba(var(--rgb-state-active-color, 67, 160, 71), 0.75);
      }
      .seg.off {
        background: rgba(211, 47, 47, 0.7);
      }
      .seg.empty {
        background: rgba(var(--rgb-secondary-text-color), 0.4);
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-bar": SchedulerOverviewBar;
  }
}
