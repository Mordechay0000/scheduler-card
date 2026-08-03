import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { HomeAssistant } from '../lib/types';
import { computeStartOfWeek } from '../data/days';
import { localize } from '../localize/localize';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Day picker for overview mode. Overview always draws the entry a schedule
 * *would* run, so without this there is no way to tell which schedules
 * actually apply today, nor to look at another day.
 *
 * The two-day toggle exists for schedules that run across midnight (a
 * Friday evening schedule finishing on Saturday): it puts two consecutive
 * days side by side so the whole span is visible at once.
 */
@customElement('scheduler-overview-daybar')
export class SchedulerOverviewDaybar extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public date: Date = new Date();
  @property({ type: Number }) public spanDays = 1;

  private _select(date: Date) {
    this.dispatchEvent(new CustomEvent('date-changed', { detail: { date }, bubbles: true, composed: true }));
  }

  private _toggleSpan() {
    this.dispatchEvent(new CustomEvent('span-changed', {
      detail: { spanDays: this.spanDays === 2 ? 1 : 2 },
      bubbles: true, composed: true,
    }));
  }

  render() {
    if (!this.hass) return html``;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // The week Home Assistant itself starts on, so these chips read in the
    // same order as the weekday picker and the rest of the frontend.
    const startOfWeek = computeStartOfWeek(this.hass);
    const offset = (today.getDay() - startOfWeek + 7) % 7;
    const weekStart = new Date(today.getTime() - offset * DAY_MS);
    const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS));
    const selected = new Date(this.date);
    selected.setHours(0, 0, 0, 0);

    return html`
      <div class="daybar">
        <div class="days">
          ${days.map(day => {
      const isSelected = day.getTime() === selected.getTime();
      const isToday = day.getTime() === today.getTime();
      const label = day.toLocaleDateString(this.hass.locale?.language || undefined, { weekday: 'short' });
      return html`
              <button
                class="day ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}"
                title=${isToday ? localize('ui.panel.overview.today', this.hass) : ''}
                @click=${() => this._select(day)}
              >${label}</button>
            `;
    })}
        </div>
        <button class="span ${this.spanDays === 2 ? 'active' : ''}" @click=${this._toggleSpan}>
          ${localize('ui.panel.overview.two_days', this.hass)}
        </button>
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host { display: block; }
      .daybar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 6px;
      }
      .days {
        display: flex;
        gap: 3px;
        flex-wrap: wrap;
      }
      .day, .span {
        font-family: inherit;
        font-size: 0.68rem;
        line-height: 1;
        padding: 4px 8px;
        border-radius: 11px;
        border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.5));
        background: none;
        color: var(--secondary-text-color);
        cursor: pointer;
        white-space: nowrap;
      }
      /* Today keeps its place in the week rather than jumping to the front,
         so it needs marking out. */
      .day.today {
        font-weight: 700;
        color: var(--primary-text-color);
        border-color: var(--primary-color);
      }
      .day.today.selected {
        color: var(--text-primary-color, #fff);
      }
      .day.selected {
        background: var(--primary-color);
        border-color: transparent;
        color: var(--text-primary-color, #fff);
      }
      .span.active {
        background: var(--primary-color);
        border-color: transparent;
        color: var(--text-primary-color, #fff);
      }
      .day:hover, .span:hover {
        border-color: var(--primary-color);
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-daybar": SchedulerOverviewDaybar;
  }
}
