import { LitElement, html, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { CardConfig, Time, TimeMode, Timeslot } from '../types';
import { HomeAssistant } from '../lib/types';
import { isOffAction, isOnAction, invertOnOffAction } from '../data/format/is_off_action';
import { carveTimeslot } from '../data/schedule/carve_timeslot';
import { mergeEqualAdjacentSlots } from '../data/schedule/merge_equal_slots';
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

// A slot selection anywhere clears every other bar's selection: each bar
// broadcasts on select and listens for everyone else's broadcasts.
const SELECT_EVENT = 'scheduler-overview-slot-select';

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
  @property({ type: Boolean }) public editable = true;
  /** Draws a "now" marker across the bar; omit when not showing today. */
  @property({ attribute: false }) public now?: Date;

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

  private _pinch?: { distance: number; midpointX: number };

  private _bodyResizeDrag?: { startClientX: number; slotIdx: number; active: boolean };

  private _lastSegTap?: { time: number; x: number };

  // Double-click/tap-and-drag carves a new slot out of the existing ones,
  // the same gesture the full editor uses.
  private _createDrag?: { ts0: number; active: boolean };

  @state() private _createRange?: { ts0: number; ts1: number };

  private _onExternalSelect = (ev: Event) => {
    if ((ev as CustomEvent).detail?.source !== this && this.selectedSlot !== null) {
      this.selectedSlot = null;
      this.dispatchEvent(new CustomEvent('slot-selected', { detail: { index: null }, bubbles: true, composed: true }));
    }
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(SELECT_EVENT, this._onExternalSelect);
    window.addEventListener('keydown', this._handleKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(SELECT_EVENT, this._onExternalSelect);
    window.removeEventListener('keydown', this._handleKeyDown);
  }

  // Delete/Backspace removes the selected slot, exactly as in the full
  // editor: its range is merged into a neighbour, and if that leaves two
  // neighbours with identical effects they collapse into one.
  private _handleKeyDown = (ev: KeyboardEvent) => {
    if (!this.editable) return;
    if (this.selectedSlot === null) return;
    const isArrow = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
    if (ev.key !== 'Delete' && ev.key !== 'Backspace' && !isArrow) return;
    const origin = ev.composedPath()[0];
    if (origin instanceof HTMLElement
      && (['input', 'textarea', 'select'].includes(origin.tagName.toLowerCase()) || origin.isContentEditable)) return;

    if (isArrow) {
      ev.preventDefault();
      this._nudgeSelected(ev.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    const slots = this._slots;
    // Never leave the bar with fewer than two slots, and leave schedules
    // that use open-ended slots (single-timer style) to the full dialog -
    // merging those would need a stop time that does not exist.
    if (slots.length <= 2) return;
    const slotIdx = this.selectedSlot;
    const cutIndex = slotIdx === slots.length - 1 ? slotIdx - 1 : slotIdx;
    if (slots[cutIndex]?.stop === undefined || slots[cutIndex + 1]?.stop === undefined) return;
    ev.preventDefault();
    let newSlots = [
      ...slots.slice(0, cutIndex),
      { ...slots[cutIndex + 1], start: slots[cutIndex].start, stop: slots[cutIndex + 1].stop! },
      ...slots.slice(cutIndex + 2),
    ];
    newSlots = mergeEqualAdjacentSlots(newSlots);

    this._liveSlots = newSlots;
    this.selectedSlot = null;
    this.dispatchEvent(new CustomEvent('slot-selected', { detail: { index: null }, bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent('slots-changed', { detail: { slots: newSlots }, bubbles: true, composed: true }));
  };

  /**
   * Moves the selected slot's boundary by one step, for precise adjustment
   * without dragging. Directions are visual: under RTL, "right" is earlier.
   */
  private _nudgeSelected(direction: 1 | -1) {
    const slots = this._slots;
    const i = this.selectedSlot!;
    const isRtl = getComputedStyle(this).direction === 'rtl';
    const later = isRtl ? direction < 0 : direction > 0;

    // Adjust the boundary at the visual edge the key points at: the slot's
    // own stop, or - for the last slot - its start.
    const boundaryIdx = i < slots.length - 1 ? i : i - 1;
    if (boundaryIdx < 0 || !slots[boundaryIdx]?.stop || !slots[boundaryIdx + 1]) return;
    if ([TimeMode.Sunrise, TimeMode.Sunset].includes(parseTimeString(slots[boundaryIdx + 1].start).mode)) return;

    const stepSec = this._dragStepSize * 60;
    const current = computeTimestamp(slots[boundaryIdx].stop!, this.hass);
    const min = boundaryIdx > 0 ? computeTimestamp(slots[boundaryIdx - 1].stop || slots[boundaryIdx - 1].start, this.hass) + stepSec : stepSec;
    const maxRef = computeTimestamp(slots[boundaryIdx + 1].stop || slots[boundaryIdx + 1].start, this.hass) || SEC_PER_DAY;
    const max = maxRef - stepSec;

    const ts = Math.min(Math.max(current + (later ? stepSec : -stepSec), min), max);
    if (ts === current) return;

    const time: Time = { mode: TimeMode.Fixed, hours: Math.floor(ts / 3600), minutes: Math.round((ts % 3600) / 60) };
    const timeStr = timeToString(roundTime(time, this._dragStepSize));
    const newSlots = Object.assign([...slots], {
      [boundaryIdx]: { ...slots[boundaryIdx], stop: timeStr },
      [boundaryIdx + 1]: { ...slots[boundaryIdx + 1], start: timeStr },
    });
    this._liveSlots = newSlots;
    this.dispatchEvent(new CustomEvent('slots-changed', { detail: { slots: newSlots }, bubbles: true, composed: true }));
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('slots')) this._liveSlots = undefined;
    // Restore the true reading direction on the content (the .viewport
    // around it is forced ltr for the zoom/pan anchor math).
    const inner = this.shadowRoot?.querySelector('.content-inner') as HTMLElement | null;
    if (inner) inner.style.direction = getComputedStyle(this).direction;
  }

  private _handleWheel(ev: WheelEvent) {
    if (!this.viewportWidth || !this.editable) return;
    const isZoomGesture = ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX);
    ev.preventDefault();
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const anchorPx = ev.clientX - rect.left;

    if (isZoomGesture) {
      // More sensitive than a typical wheel-zoom map so it doesn't take a
      // lot of scrolling to get anywhere.
      const factor = Math.pow(2, -ev.deltaY / 60);
      this.dispatchEvent(new CustomEvent('overview-zoom', { detail: { anchorPx, factor }, bubbles: true, composed: true }));
    } else {
      this.dispatchEvent(new CustomEvent('overview-pan', { detail: { deltaPx: ev.deltaX }, bubbles: true, composed: true }));
    }
  }

  private _touchDistance(t: TouchList) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
  }

  private _handlePinchStart(ev: TouchEvent) {
    if (ev.touches.length !== 2) return;
    ev.preventDefault();
    const rect = this.getBoundingClientRect();
    this._pinch = {
      distance: this._touchDistance(ev.touches),
      midpointX: (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left,
    };
  }

  private _handlePinchMove(ev: TouchEvent) {
    if (!this._pinch || ev.touches.length !== 2) return;
    ev.preventDefault();
    const distance = this._touchDistance(ev.touches);
    const scale = distance / this._pinch.distance;
    this.dispatchEvent(new CustomEvent('overview-zoom', { detail: { anchorPx: this._pinch.midpointX, factor: scale }, bubbles: true, composed: true }));
    this._pinch.distance = distance;
  }

  private _handlePinchEnd(ev: TouchEvent) {
    if (ev.touches.length < 2) this._pinch = undefined;
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
      <div
        class="viewport"
        @wheel=${this._handleWheel}
        @touchstart=${this._handlePinchStart}
        @touchmove=${this._handlePinchMove}
        @touchend=${this._handlePinchEnd}
        @touchcancel=${this._handlePinchEnd}
      >
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
                    @pointerdown=${(ev: PointerEvent) => this._handleSegPointerDown(ev, i)}
                  ></div>
                  ${i < slots.length - 1 && slot.stop ? html`
                    <div
                      class="handle ${this.selectedSlot === i || this.selectedSlot === i + 1 ? '' : 'hidden'} ${nextSlot && !nextSlot.stop ? 'center' : ''}"
                      @mousedown=${(ev: MouseEvent) => this._handleDragStart(ev, i)}
                      @touchstart=${(ev: TouchEvent) => this._handleDragStart(ev, i)}
                    >
                      <span><ha-svg-icon .path=${mdiUnfoldMoreVertical}></ha-svg-icon></span>
                    </div>
                  ` : ''}
                `;
    })}
              ${this.now !== undefined ? html`
                <div
                  class="now-line"
                  style=${styleMap({
      insetInlineStart: `${((this.now.getHours() * 3600 + this.now.getMinutes() * 60 + this.now.getSeconds()) / SEC_PER_DAY) * this._contentWidth}px`,
    })}
                ></div>
              ` : ''}
              ${this._createRange ? html`
                <div
                  class="create-overlay"
                  style=${styleMap({
      insetInlineStart: `${(this._createRange.ts0 / SEC_PER_DAY) * this._contentWidth}px`,
      width: `${((this._createRange.ts1 - this._createRange.ts0) / SEC_PER_DAY) * this._contentWidth}px`,
    })}
                ></div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private _selectSlot(ev: Event, i: number) {
    ev.stopPropagation();
    this.selectedSlot = this.selectedSlot === i ? null : i;
    if (this.selectedSlot !== null) {
      document.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { source: this } }));
    }
    this.dispatchEvent(new CustomEvent('slot-selected', { detail: { index: this.selectedSlot }, bubbles: true, composed: true }));
  }

  // Pressing down on a slot's body and dragging sideways resizes it from
  // whichever edge the drag moves toward (consuming space from that
  // neighbour); a plain click (no meaningful movement) still selects it.
  private _clientXToTs(clientX: number) {
    const bar = this.shadowRoot!.querySelector('.bar') as HTMLElement;
    const bounds = bar.getBoundingClientRect();
    const isRtl = getComputedStyle(this).direction === 'rtl';
    let x = isRtl ? bounds.right - clientX : clientX - bounds.left;
    if (x < 0) x = 0;
    if (x > bounds.width) x = bounds.width;
    const stepSec = this._dragStepSize * 60;
    return Math.round(Math.round((x / bounds.width) * SEC_PER_DAY) / stepSec) * stepSec;
  }

  private _handleSegPointerDown(ev: PointerEvent, i: number) {
    if (ev.button !== undefined && ev.button !== 0) return;

    // A second press in quick succession at the same spot starts a
    // carve-a-new-slot drag; a single press resizes (mouse) or pans (touch).
    const now = performance.now();
    const isDouble = this._lastSegTap !== undefined
      && now - this._lastSegTap.time < 400
      && Math.abs(ev.clientX - this._lastSegTap.x) < (ev.pointerType === 'touch' ? 50 : 10);
    this._lastSegTap = { time: now, x: ev.clientX };
    if (isDouble) {
      if (this.editable) this._startCreateDrag(ev);
      return;
    }
    if (ev.pointerType === 'touch') {
      this._startTouchPan(ev);
      return;
    }

    const startClientX = ev.clientX;
    if (!this.editable) { this._selectSlot(ev, i); return; }
    this._bodyResizeDrag = { startClientX, slotIdx: i, active: false };

    const moveHandler = (mv: PointerEvent) => {
      if (!this._bodyResizeDrag) return;
      const dx = mv.clientX - this._bodyResizeDrag.startClientX;
      if (this._bodyResizeDrag.active || Math.abs(dx) < 5) return;
      this._bodyResizeDrag.active = true;
      window.removeEventListener('pointermove', moveHandler);
      window.removeEventListener('pointerup', upHandler);
      window.removeEventListener('pointercancel', upHandler);

      const slots = this._slots;
      const isRtl = getComputedStyle(this).direction === 'rtl';
      const movingRight = dx > 0;
      const dragSlotIdx = movingRight === !isRtl ? i : i - 1;
      this._bodyResizeDrag = undefined;
      if (dragSlotIdx < 0 || dragSlotIdx > slots.length - 2 || slots[dragSlotIdx + 1].stop === undefined) return;
      this._startBoundaryDrag(dragSlotIdx);
    };
    const upHandler = () => {
      window.removeEventListener('pointermove', moveHandler);
      window.removeEventListener('pointerup', upHandler);
      window.removeEventListener('pointercancel', upHandler);
      if (!this._bodyResizeDrag?.active) this._selectSlot(ev, i);
      this._bodyResizeDrag = undefined;
    };
    window.addEventListener('pointermove', moveHandler);
    window.addEventListener('pointerup', upHandler);
    window.addEventListener('pointercancel', upHandler);
  }

  // Single-finger drag on the bar pans the zoomed view (the card owns the
  // shared pan state), leaving double-tap-and-drag free to create a slot.
  private _startTouchPan(ev: PointerEvent) {
    let lastX = ev.clientX;
    const moveHandler = (mv: PointerEvent) => {
      if (this._pinch) return;
      const dx = mv.clientX - lastX;
      lastX = mv.clientX;
      this.dispatchEvent(new CustomEvent('overview-pan', { detail: { deltaPx: -dx }, bubbles: true, composed: true }));
    };
    const upHandler = () => {
      window.removeEventListener('pointermove', moveHandler);
      window.removeEventListener('pointerup', upHandler);
      window.removeEventListener('pointercancel', upHandler);
    };
    window.addEventListener('pointermove', moveHandler);
    window.addEventListener('pointerup', upHandler);
    window.addEventListener('pointercancel', upHandler);
  }

  private _startCreateDrag(ev: PointerEvent) {
    const startClientX = ev.clientX;
    this._createDrag = { ts0: this._clientXToTs(ev.clientX), active: false };

    const moveHandler = (mv: PointerEvent) => {
      if (!this._createDrag) return;
      if (!this._createDrag.active && Math.abs(mv.clientX - startClientX) < 5) return;
      this._createDrag.active = true;
      const ts = this._clientXToTs(mv.clientX);
      this._createRange = {
        ts0: Math.min(this._createDrag.ts0, ts),
        ts1: Math.max(this._createDrag.ts0, ts),
      };
    };
    const dragStartHandler = (e: Event) => e.preventDefault();
    const upHandler = () => {
      window.removeEventListener('pointermove', moveHandler);
      window.removeEventListener('pointerup', upHandler);
      window.removeEventListener('pointercancel', upHandler);
      window.removeEventListener('dragstart', dragStartHandler);
      const drag = this._createDrag;
      const range = this._createRange;
      this._createDrag = undefined;
      this._createRange = undefined;
      if (!drag?.active || !range) return;
      if (range.ts1 - range.ts0 < this._dragStepSize * 60) return;
      this._commitCreate(range.ts0, range.ts1);
    };
    window.addEventListener('pointermove', moveHandler);
    window.addEventListener('pointerup', upHandler);
    window.addEventListener('pointercancel', upHandler);
    window.addEventListener('dragstart', dragStartHandler);
  }

  private _commitCreate(ts0: number, ts1: number) {
    let [slots, newIdx] = carveTimeslot(this._slots, ts0, ts1, this.hass);
    // Default the carved slot to the opposite of a neighbour's on/off action,
    // so it is immediately meaningful (and saveable) without the full dialog.
    const reference = [slots[newIdx - 1], slots[newIdx + 1]]
      .find(s => s?.actions?.length && invertOnOffAction(s.actions[0]) !== null);
    const defaultAction = reference ? invertOnOffAction(reference.actions[0]) : null;
    if (!defaultAction) return;
    slots = Object.assign([...slots], { [newIdx]: { ...slots[newIdx], actions: [defaultAction] } });

    this._liveSlots = slots;
    this.selectedSlot = newIdx;
    document.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { source: this } }));
    this.dispatchEvent(new CustomEvent('slot-selected', { detail: { index: newIdx }, bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent('slots-changed', { detail: { slots }, bubbles: true, composed: true }));
  }

  private get _dragStepSize() {
    return this.zoom >= MINUTE_DRAG_ZOOM_THRESHOLD ? 1 : (this.config?.time_step || DEFAULT_TIME_STEP);
  }

  private _handleDragStart(ev: MouseEvent | TouchEvent, slotIdx: number) {
    ev.preventDefault();
    ev.stopPropagation();
    this._startBoundaryDrag(slotIdx);
  }

  private _startBoundaryDrag(slotIdx: number) {
    if (!this.editable) return;
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

    // Without this the browser can start a native HTML5 drag mid-gesture,
    // which fires pointercancel and swallows the mouseup entirely - the
    // boundary would move on screen and then never commit.
    const dragStartHandler = (e: Event) => e.preventDefault();

    const upHandler = () => {
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('touchmove', moveHandler);
      window.removeEventListener('mouseup', upHandler);
      window.removeEventListener('touchend', upHandler);
      window.removeEventListener('pointercancel', upHandler);
      window.removeEventListener('dragstart', dragStartHandler);
      if (this._liveSlots) {
        this.dispatchEvent(new CustomEvent('slots-changed', { detail: { slots: this._liveSlots }, bubbles: true, composed: true }));
      }
    };

    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('touchmove', moveHandler);
    window.addEventListener('mouseup', upHandler);
    window.addEventListener('touchend', upHandler);
    window.addEventListener('pointercancel', upHandler);
    window.addEventListener('dragstart', dragStartHandler);
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
        touch-action: none;
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
        /* No selectable text here - a stray selection lets the browser
           start a native drag that cancels an in-progress edit. */
        user-select: none;
        -webkit-user-select: none;
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
        width: 14px;
        height: 100%;
        align-items: center;
        justify-content: center;
        margin-inline-start: -7px;
        margin-inline-end: -7px;
        visibility: visible;
        z-index: 4;
        cursor: ew-resize;
      }
      .handle.hidden {
        visibility: hidden;
      }
      .now-line {
        position: absolute;
        top: -3px;
        bottom: -3px;
        width: 2px;
        margin-inline-start: -1px;
        background: var(--primary-color);
        border-radius: 1px;
        pointer-events: none;
        z-index: 5;
      }
      .now-line::before {
        content: '';
        position: absolute;
        top: -3px;
        inset-inline-start: -2px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--primary-color);
      }
      .create-overlay {
        position: absolute;
        top: 0;
        height: 100%;
        background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.35);
        border: 1px solid var(--primary-color);
        box-sizing: border-box;
        border-radius: 4px;
        pointer-events: none;
        z-index: 6;
      }
      .handle span {
        background: var(--card-background-color);
        border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.5));
        border-radius: 50%;
        width: 12px;
        height: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        z-index: 5;
      }
      .handle:hover span {
        border-color: var(--primary-color);
      }
      .handle ha-svg-icon {
        --mdc-icon-size: 10px;
        width: 10px;
        height: 10px;
        color: var(--secondary-text-color);
      }
      .handle.center span {
        margin-inline-end: -1px;
      }
    `;
  }

}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-bar": SchedulerOverviewBar;
  }
}
