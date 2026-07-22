import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { isOffAction, isOnAction } from '../data/format/is_off_action';
import { computeActionColor } from '../data/format/compute_action_color';
import { computeSlotWidths } from '../data/time/compute_slot_widths';
import { computeSlotBoundaries } from '../data/format/compute_slot_boundaries';
import { useAmPm } from '../lib/use_am_pm';

const GAP_PX = 2;

/**
 * A compact, read-only rendering of a slot list: same color language AND
 * the same start/end time markers as the full timeslot editor, just
 * smaller and without any of the interactive machinery (selection,
 * dragging, zoom).
 */
@customElement('scheduler-overview-bar')
export class SchedulerOverviewBar extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public slots!: Timeslot[];

  @state() private _width = 0;

  private _resizeObserver?: ResizeObserver;

  connectedCallback() {
    super.connectedCallback();
    // Observe the host directly (not an inner element found after first
    // render): a first render that throws before hass/slots are set would
    // otherwise leave the ResizeObserver never attached.
    this._resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
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
    if (!this.hass || !this.slots?.length || !this._width) return html``;

    const slotWidths = computeSlotWidths(this.slots, this.hass, this._width, GAP_PX);
    const amPm = useAmPm(this.hass.locale);
    const { boundaries, maxTier } = computeSlotBoundaries(this.slots, slotWidths, amPm, GAP_PX);

    const isRtl = getComputedStyle(this).direction === 'rtl';
    const centerShift = isRtl ? '50%' : '-50%';

    const baseLineHeight = 4;
    const tierStep = 13;
    const labelHeight = 11;
    const boundariesHeight = labelHeight + baseLineHeight + maxTier * tierStep;

    return html`
      <div class="boundaries" style=${styleMap({ height: `${boundariesHeight}px` })}>
        ${boundaries.map(b => html`
          <div
            class="boundary ${b.align}"
            style=${styleMap({
      ...(b.align === 'end'
        ? { insetInlineEnd: `${this._width - b.position}px` }
        : { insetInlineStart: `${b.position}px` }),
      ...(b.align === 'middle' ? { transform: `translateX(${centerShift})` } : {}),
    })}
          >
            <span class="boundary-label ${b.state}" style=${styleMap(b.color ? { color: b.color } : {})}>${b.label}</span>
            <span
              class="boundary-line"
              style=${styleMap({ height: `${baseLineHeight + b.tier * tierStep}px` })}
            ></span>
          </div>
        `)}
      </div>
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
        width: `${slotWidths[i]}px`,
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
      .boundaries {
        position: relative;
        width: 100%;
        transition: height 0.15s ease-in-out;
      }
      .boundary {
        position: absolute;
        bottom: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
      }
      .boundary.start {
        align-items: flex-start;
      }
      .boundary.end {
        align-items: flex-end;
      }
      .boundary-label {
        font-size: 0.62rem;
        font-weight: 600;
        line-height: 1;
        white-space: nowrap;
        color: var(--primary-text-color);
        margin-bottom: 2px;
      }
      .boundary-label.on {
        color: rgb(var(--rgb-state-active-color, 67, 160, 71));
      }
      .boundary-label.off {
        color: rgb(211, 47, 47);
      }
      .boundary-label.empty {
        color: var(--secondary-text-color);
      }
      .boundary-line {
        display: block;
        width: 1px;
        background: var(--divider-color, rgba(127, 127, 127, 0.5));
        transition: height 0.15s ease-in-out;
      }
      .bar {
        display: flex;
        width: 100%;
        height: 22px;
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
