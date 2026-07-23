import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { CardConfig, Time, TimeMode, Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { isOffAction, isOnAction } from '../data/format/is_off_action';
import { computeActionColor } from '../data/format/compute_action_color';
import { computeSlotWidths } from '../data/time/compute_slot_widths';
import { computeSlotBoundaries } from '../data/format/compute_slot_boundaries';
import { useAmPm } from '../lib/use_am_pm';
import { parseTimeString } from '../data/time/parse_time_string';
import { computeTimestamp } from '../data/time/compute_timestamp';
import { timeToString } from '../data/time/time_to_string';
import { roundTime } from '../data/time/round_time';
import { DEFAULT_TIME_STEP } from '../const';
import { mdiUnfoldMoreVertical } from '@mdi/js';

const SEC_PER_DAY = 24 * 3600;
const GAP_PX = 2;
const MINUTE_DRAG_ZOOM_THRESHOLD = 4;

/**
 * A compact rendering of a slot list: same color language AND start/end
 * time markers as the full timeslot editor, sharing the card-wide
 * zoom/pan, with minimal inline editing - select a slot, drag its
 * boundary handles to adjust the time. No creating/deleting/action
 * assignment here; that still goes through the full dialog.
 */
@customElement('scheduler-overview-bar')
export class SchedulerOverviewBar extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public config!: CardConfig;
  @property({ attribute: false }) public slots!: Timeslot[];
  @property({ type: Number }) public zoom = 1;
  @property({ type: Number }) public panPx = 0;
  @property({ type: Number }) public viewportWidth = 0;

  @state() private selectedSlot: number | null = null;

  // Local, live-dragged copy so the bar can give immediate visual feedback
  // without waiting for the parent to round-trip an update.
  @state() private _liveSlots?: Timeslot[];

  private get _slots() {
    return this._liveSlots || this.slots;
  }

  private get _contentWidth() {
    return this.viewportWidth * this.zoom;
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('slots')) this._liveSlots = undefined;
    // Restore the true reading direction on the content (the .viewport
    // around it is forced ltr for the zoom/pan anchor math).
    const inner = this.shadowRoot?.querySelector('.content-inner') as HTMLElement | null;
    if (inner) inner.style.direction = getComputedStyle(this).direction;
  }

  render() {
    if (!this.hass || !this.slots?.length || !this.viewportWidth) return html``;

    const slots = this._slots;
    const slotWidths = computeSlotWidths(slots, this.hass, this._contentWidth, GAP_PX);
    const amPm = useAmPm(this.hass.locale);
    const { boundaries, maxTier } = computeSlotBoundaries(slots, slotWidths, amPm, GAP_PX);

    const isRtl = getComputedStyle(this).direction === 'rtl';
    const centerShift = isRtl ? '50%' : '-50%';

    const baseLineHeight = 4;
    const tierStep = 13;
    const labelHeight = 11;
    const boundariesHeight = labelHeight + baseLineHeight + maxTier * tierStep;

    return html`
      <div class="viewport">
        <div
          class="zoom-content"
          style=${styleMap({ width: `${this._contentWidth}px`, transform: `translateX(${-this.panPx}px)` })}
        >
          <div class="content-inner">
            <div class="boundaries" style=${styleMap({ height: `${boundariesHeight}px` })}>
              ${boundaries.map(b => html`
                <div
                  class="boundary ${b.align}"
                  style=${styleMap({
      ...(b.align === 'end'
        ? { insetInlineEnd: `${this._contentWidth - b.position}px` }
        : { insetInlineStart: `${b.position}px` }),
      ...(b.align === 'middle' ? { transform: `translateX(${centerShift})` } : {}),
    })}
                >
                  <span class="boundary-label ${b.state}" style=${styleMap(b.color ? { color: b.color } : {})}>${b.label}</span>
                  <span class="boundary-line" style=${styleMap({ height: `${baseLineHeight + b.tier * tierStep}px` })}></span>
                </div>
              `)}
            </div>
            <div class="bar">
              ${slots.map((slot, i) => {
      const state = !slot.actions.length ? 'empty'
        : isOffAction(slot.actions[0]) ? 'off'
          : isOnAction(slot.actions[0]) ? 'on' : '';
      const color = slot.actions.length ? computeActionColor(slot.actions[0]) : null;
      const nextSlot = slots[i + 1];
      return html`
                  <div
                    class="seg ${state} ${this.selectedSlot === i ? 'selected' : ''}"
                    style=${styleMap({
        width: `${slotWidths[i]}px`,
        ...(color ? { background: `rgba(${color.rgb.join(', ')}, ${color.alpha})` } : {}),
      })}
                    @click=${(ev: Event) => this._selectSlot(ev, i)}
                  ></div>
                  ${i < slots.length - 1 && slot.stop ? html`
                    <div
                      class="handle ${this.selectedSlot === i || this.selectedSlot === i + 1 ? '' : 'hidden'} ${nextSlot && !nextSlot.stop ? 'center' : ''}"
                      @mousedown=${(ev: MouseEvent) => this._handleDragStart(ev, i)}
                      @touchstart=${(ev: TouchEvent) => this._handleDragStart(ev, i)}
                    >
                      <span><ha-icon-button .path=${mdiUnfoldMoreVertical}></ha-icon-button></span>
                    </div>
                  ` : ''}
                `;
    })}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private _selectSlot(ev: Event, i: number) {
    ev.stopPropagation();
    this.selectedSlot = this.selectedSlot === i ? null : i;
  }

  private get _dragStepSize() {
    return this.zoom >= MINUTE_DRAG_ZOOM_THRESHOLD ? 1 : (this.config?.time_step || DEFAULT_TIME_STEP);
  }

  private _handleDragStart(ev: MouseEvent | TouchEvent, slotIdx: number) {
    ev.preventDefault();
    ev.stopPropagation();

    const slots = this._slots;
    // Only fixed-time boundaries support quick dragging here; sunrise/sunset
    // offsets need the full dialog.
    if ([TimeMode.Sunrise, TimeMode.Sunset].includes(parseTimeString(slots[slotIdx + 1].start).mode)) return;

    const bar = this.shadowRoot!.querySelector('.bar') as HTMLElement;
    const trackBounds = bar.getBoundingClientRect();

    const stepSize = this._dragStepSize;
    const stepSec = stepSize * 60;

    let ts_min = slotIdx > 0
      ? computeTimestamp(slots[slotIdx - 1].stop || slots[slotIdx - 1].start, this.hass) + stepSec
      : stepSec;
    let ts_max = (computeTimestamp(slots[slotIdx + 1].stop || slots[slotIdx + 1].start, this.hass) || SEC_PER_DAY) - stepSec;
    if (slots[slotIdx + 1].stop === undefined) {
      ts_max = (computeTimestamp(slots[slotIdx + 2].stop || slots[slotIdx + 2].start, this.hass) || SEC_PER_DAY) - stepSec;
    }

    const isRtl = getComputedStyle(this).direction === 'rtl';

    const moveHandler = (mv: MouseEvent | TouchEvent) => {
      mv.preventDefault();
      const clientX = mv instanceof TouchEvent ? mv.changedTouches[0].clientX : (mv as MouseEvent).clientX;
      let x = isRtl ? trackBounds.right - clientX : clientX - trackBounds.left;
      if (x > trackBounds.width) x = trackBounds.width;
      if (x < 0) x = 0;

      let ts = Math.round((x / trackBounds.width) * SEC_PER_DAY);
      if (ts < ts_min) ts = ts_min;
      else if (ts > ts_max) ts = ts_max;

      const hours = Math.floor(ts / 3600);
      const minutes = Math.round((ts - hours * 3600) / 60);
      let time: Time = { mode: TimeMode.Fixed, hours, minutes };
      time = roundTime(time, stepSize);
      const timeStr = timeToString(time);

      let newSlots = [...slots];
      newSlots = Object.assign(newSlots, {
        [slotIdx]: { ...newSlots[slotIdx], stop: timeStr },
        [slotIdx + 1]: { ...newSlots[slotIdx + 1], start: timeStr },
      });
      this._liveSlots = newSlots;
    };

    const upHandler = () => {
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('touchmove', moveHandler);
      window.removeEventListener('mouseup', upHandler);
      window.removeEventListener('touchend', upHandler);
      if (this._liveSlots) {
        this.dispatchEvent(new CustomEvent('slots-changed', { detail: { slots: this._liveSlots }, bubbles: true, composed: true }));
      }
    };

    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('touchmove', moveHandler);
    window.addEventListener('mouseup', upHandler);
    window.addEventListener('touchend', upHandler);
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        width: 100%;
      }
      .viewport {
        width: 100%;
        overflow: hidden;
        position: relative;
        /* A block wider than its container overflow-anchors based on its
           PARENT's direction, not its own - force ltr here for a fixed,
           direction-independent anchor for the pan/zoom math, then restore
           the true direction on .content-inner below. */
        direction: ltr;
      }
      .zoom-content {
        position: relative;
      }
      .content-inner {
        position: relative;
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
        position: relative;
      }
      .seg {
        height: 100%;
        cursor: pointer;
        box-sizing: border-box;
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
      .seg:first-child {
        border-start-start-radius: 6px;
        border-end-start-radius: 6px;
      }
      .seg:last-child {
        border-start-end-radius: 6px;
        border-end-end-radius: 6px;
      }
      .seg.selected {
        border: 2px solid var(--primary-color);
      }
      .handle {
        display: flex;
        width: 22px;
        height: 100%;
        align-items: center;
        justify-content: center;
        margin-inline-start: -11px;
        margin-inline-end: -11px;
        visibility: visible;
        z-index: 4;
      }
      .handle.hidden {
        visibility: hidden;
      }
      .handle span {
        background: var(--card-background-color);
        border-radius: 50%;
        width: 16px;
        height: 16px;
        display: flex;
        z-index: 5;
      }
      .handle ha-icon-button {
        --mdc-icon-button-size: 22px;
        --mdc-icon-size: 14px;
        margin-top: -3px;
        margin-inline-start: -3px;
      }
      .handle.center span {
        margin-inline-end: -2px;
      }
    `;
  }

}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-bar": SchedulerOverviewBar;
  }
}
