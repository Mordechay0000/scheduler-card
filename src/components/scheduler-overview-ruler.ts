import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { HomeAssistant } from '../lib/types';
import { Time, TimeMode } from '../types';
import { timeToString } from '../data/time/time_to_string';
import { useAmPm } from '../lib/use_am_pm';
import { computeHourTicks } from '../data/format/compute_hour_ticks';

// Must match scheduler-overview-row's icon+gap+label+gap width, so the
// ruler's ticks line up with the bars beneath it.
const RULER_SPACER_WIDTH = 158;

/**
 * Hour ruler shared by every row in overview mode, aligned with
 * scheduler-overview-row's icon+label column so it lines up with the bars
 * beneath it.
 */
@customElement('scheduler-overview-ruler')
export class SchedulerOverviewRuler extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _width = 0;

  private _resizeObserver?: ResizeObserver;

  connectedCallback() {
    super.connectedCallback();
    // Observe the host itself (not an inner element found after first
    // render) so this doesn't depend on an early render succeeding -
    // matches the pattern in scheduler-timeslot-editor.
    this._resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = Math.max(0, entry.contentRect.width - RULER_SPACER_WIDTH);
        if (width !== this._width) this._width = width;
      }
    });
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
  }

  render() {
    if (!this.hass) return html``;
    const amPm = useAmPm(this.hass.locale);
    const ticks = computeHourTicks(this._width, amPm);

    return html`
      <div class="spacer"></div>
      <div class="ruler">
        ${ticks.map(tick => {
      const time: Time = { mode: TimeMode.Fixed, hours: tick.hour, minutes: 0 };
      const label = timeToString(time, { seconds: false, am_pm: amPm });
      const cls = tick.align === 'left' ? 'left' : tick.align === 'right' ? 'right' : '';
      return html`
            <span class="${cls}" style=${styleMap({ width: `${tick.widthPct}%` })}>${label}</span>
          `;
    })}
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: flex;
        width: 100%;
        font-size: 0.72rem;
        color: var(--secondary-text-color);
        padding-bottom: 2px;
      }
      .spacer {
        flex: 0 0 158px;
      }
      .ruler {
        flex: 1;
        min-width: 0;
        display: flex;
      }
      .ruler span {
        display: flex;
        justify-content: center;
        white-space: nowrap;
      }
      .ruler span.left {
        justify-content: flex-start;
      }
      .ruler span.right {
        justify-content: flex-end;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-ruler": SchedulerOverviewRuler;
  }
}
