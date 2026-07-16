import { LitElement, html, css, CSSResultGroup } from 'lit';
import { property, customElement, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { CardConfig, ScheduleEntry, Time, TimeMode } from '../types';
import { mdiUnfoldMoreVertical } from '@mdi/js';
import { roundTime } from '../data/time/round_time';
import { timeToString } from '../data/time/time_to_string';
import { computeActionIcon } from '../data/format/compute_action_icon';
import { formatActionDisplay } from '../data/format/format_action_display';
import { isOffAction, isOnAction } from '../data/format/is_off_action';
import { parseTimeString } from '../data/time/parse_time_string';
import { computeTimestamp } from '../data/time/compute_timestamp';
import { HomeAssistant } from '../lib/types';
import { computeTimeOffset } from '../data/time/compute_time_offset';
import { useAmPm } from '../lib/use_am_pm';
import { addTimeOffset } from '../data/time/add_time_offset';
import { DEFAULT_TIME_STEP } from '../const';

const SEC_PER_DAY = 24 * 3600;

const MIN_ZOOM = 1;
const MAX_ZOOM = 48; // 1440min / 48 = 30min visible at max zoom
const MINUTE_DRAG_ZOOM_THRESHOLD = 4; // switch to 1-minute drag snapping once the view is this focused
const ZOOM_BUTTON_FACTOR = 1.6;
const ZOOM_ANIMATION_MS = 220;

@customElement('scheduler-timeslot-editor')
export class SchedulerTimeslotEditor extends LitElement {
  public hass!: HomeAssistant;
  @property({ attribute: false }) public config!: CardConfig;

  @state() schedule?: ScheduleEntry;

  @state() selectedSlot: number | null = null;

  @state() private _width = 0;

  @state() private _zoom = MIN_ZOOM;

  @state() private _panPx = 0;

  private _resizeObserver?: ResizeObserver;

  private _zoomAnimationFrame?: number;

  private _panDrag?: { pointerId: number; startX: number; startPanPx: number };

  private _pinch?: { distance: number; midpointX: number; panPx: number; zoom: number };

  @property({ type: Boolean })
  large = false;

  private get _contentWidth() {
    return this._width * this._zoom;
  }

  connectedCallback() {
    super.connectedCallback();
    this._resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width !== this._width) {
          this._width = width;
          this._panPx = this._clampPan(this._panPx, this._zoom);
        }
      }
    });
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    if (this._zoomAnimationFrame) cancelAnimationFrame(this._zoomAnimationFrame);
  }

  private _clampPan(panPx: number, zoom: number) {
    const maxPan = Math.max(0, this._width * zoom - this._width);
    return Math.min(Math.max(panPx, 0), maxPan);
  }

  // Keep the content position under `anchorPx` (viewport-relative x) fixed
  // while changing zoom, the way map zoom controls behave.
  private _setZoom(newZoom: number, anchorPx: number) {
    const zoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
    const oldContentWidth = this._width * this._zoom;
    const contentX = this._panPx + anchorPx;
    const frac = oldContentWidth > 0 ? contentX / oldContentWidth : 0;
    const newContentWidth = this._width * zoom;
    const newPanPx = frac * newContentWidth - anchorPx;
    this._zoom = zoom;
    this._panPx = this._clampPan(newPanPx, zoom);
  }

  private _animateZoomBy(factor: number, anchorPx: number) {
    if (this._zoomAnimationFrame) cancelAnimationFrame(this._zoomAnimationFrame);
    const startZoom = this._zoom;
    const targetZoom = Math.min(Math.max(startZoom * factor, MIN_ZOOM), MAX_ZOOM);
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - startTime) / ZOOM_ANIMATION_MS, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const zoom = startZoom + (targetZoom - startZoom) * eased;
      this._setZoom(zoom, anchorPx);
      if (t < 1) {
        this._zoomAnimationFrame = requestAnimationFrame(step);
      } else {
        this._zoomAnimationFrame = undefined;
      }
    };
    this._zoomAnimationFrame = requestAnimationFrame(step);
  }

  private _handleZoomInClick() {
    this._animateZoomBy(ZOOM_BUTTON_FACTOR, this._width / 2);
  }

  private _handleZoomOutClick() {
    this._animateZoomBy(1 / ZOOM_BUTTON_FACTOR, this._width / 2);
  }

  private _handleZoomResetClick() {
    if (this._zoomAnimationFrame) cancelAnimationFrame(this._zoomAnimationFrame);
    const startZoom = this._zoom;
    const startPan = this._panPx;
    const startTime = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - startTime) / ZOOM_ANIMATION_MS, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this._zoom = startZoom + (MIN_ZOOM - startZoom) * eased;
      this._panPx = startPan + (0 - startPan) * eased;
      if (t < 1) {
        this._zoomAnimationFrame = requestAnimationFrame(step);
      } else {
        this._zoomAnimationFrame = undefined;
      }
    };
    this._zoomAnimationFrame = requestAnimationFrame(step);
  }

  private _handleWheel(ev: WheelEvent) {
    if (!this._width) return;
    const isZoomGesture = ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX);
    ev.preventDefault();

    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const anchorPx = ev.clientX - rect.left;

    if (isZoomGesture) {
      if (this._zoomAnimationFrame) {
        cancelAnimationFrame(this._zoomAnimationFrame);
        this._zoomAnimationFrame = undefined;
      }
      const factor = Math.pow(2, -ev.deltaY / 300);
      this._setZoom(this._zoom * factor, anchorPx);
    } else {
      this._panPx = this._clampPan(this._panPx + ev.deltaX, this._zoom);
    }
  }

  // Dragging on the time-bar ruler pans the view (only meaningful once
  // zoomed in). Kept separate from the slot bar so it never conflicts with
  // slot selection or the resize handles.
  private _handleRulerPanStart(ev: PointerEvent) {
    if (this._zoom <= MIN_ZOOM) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this._panDrag = { pointerId: ev.pointerId, startX: ev.clientX, startPanPx: this._panPx };
  }

  private _handleRulerPanMove(ev: PointerEvent) {
    if (!this._panDrag || this._panDrag.pointerId !== ev.pointerId) return;
    // The zoom-content box is forced to a fixed (LTR-anchored) layout
    // regardless of ambient direction (see the .zoom-content CSS comment),
    // so this stays a plain physical-pixel delta in both directions.
    const dx = ev.clientX - this._panDrag.startX;
    this._panPx = this._clampPan(this._panDrag.startPanPx - dx, this._zoom);
  }

  private _handleRulerPanEnd() {
    this._panDrag = undefined;
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
    const midpointX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left;
    this._pinch = {
      distance: this._touchDistance(ev.touches),
      midpointX,
      panPx: this._panPx,
      zoom: this._zoom,
    };
  }

  private _handlePinchMove(ev: TouchEvent) {
    if (!this._pinch || ev.touches.length !== 2) return;
    ev.preventDefault();
    const rect = this.getBoundingClientRect();
    const midpointX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left;
    const distance = this._touchDistance(ev.touches);
    const scale = distance / this._pinch.distance;

    // Re-derive from the gesture's start state each move (not the live
    // state) so the math stays stable even as clamping kicks in.
    const zoom = Math.min(Math.max(this._pinch.zoom * scale, MIN_ZOOM), MAX_ZOOM);
    const oldContentWidth = this._width * this._pinch.zoom;
    const contentX = this._pinch.panPx + this._pinch.midpointX;
    const frac = oldContentWidth > 0 ? contentX / oldContentWidth : 0;
    const newContentWidth = this._width * zoom;
    const panFromZoom = frac * newContentWidth - midpointX;
    // Also follow the two-finger midpoint drag (pan) alongside the pinch.
    const panShift = -(midpointX - this._pinch.midpointX);

    this._zoom = zoom;
    this._panPx = this._clampPan(panFromZoom + panShift, zoom);
  }

  private _handlePinchEnd(ev: TouchEvent) {
    if (ev.touches.length < 2) this._pinch = undefined;
  }

  render() {
    const zoomPct = Math.round(this._zoom * 100);

    // .zoom-content overflows .viewport (its containing block) in a
    // direction controlled by .viewport's own `direction`. .viewport is
    // forced to ltr in CSS so that anchor is fixed regardless of ambient
    // direction, keeping the pan/zoom pixel math direction-independent. The
    // true direction is restored explicitly on the children below so their
    // own (already RTL-aware) layout is unaffected.
    const trueDirection = getComputedStyle(this).direction;

    return html`
      <div class="zoom-controls">
        <ha-icon-button @click=${this._handleZoomOutClick} .disabled=${this._zoom <= MIN_ZOOM}>
          <ha-icon icon="mdi:magnify-minus-outline"></ha-icon>
        </ha-icon-button>
        <span class="zoom-level" @click=${this._handleZoomResetClick}>${zoomPct}%</span>
        <ha-icon-button @click=${this._handleZoomInClick} .disabled=${this._zoom >= MAX_ZOOM}>
          <ha-icon icon="mdi:magnify-plus-outline"></ha-icon>
        </ha-icon-button>
      </div>
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
          style=${styleMap({ width: `${this._contentWidth}px`, transform: `translateX(${-this._panPx}px)` })}
        >
          <div class="slots-wrapper" style=${styleMap({ direction: trueDirection })}>
            ${this.renderBoundaries()}
            <div class="bar">
              ${this.renderTimeslots()}
            </div>
          </div>
          <div
            class="time-bar"
            style=${styleMap({ direction: trueDirection, cursor: this._zoom > MIN_ZOOM ? 'grab' : 'default' })}
            @pointerdown=${this._handleRulerPanStart}
            @pointermove=${this._handleRulerPanMove}
            @pointerup=${this._handleRulerPanEnd}
            @pointercancel=${this._handleRulerPanEnd}
          >
            ${this.renderTimebar()}
          </div>
        </div>
      </div>
    `;
  }

  renderTimebar() {
    const fullWidth = this._contentWidth;
    const allowedStepSizes = [1, 2, 3, 4, 6, 8, 12];

    const amPm = useAmPm(this.hass.locale);

    const segmentWidth = amPm ? 130 : 100;
    if (!fullWidth) return html``;
    let stepSize = Math.ceil(24 / (fullWidth / segmentWidth));
    while (!allowedStepSizes.includes(stepSize)) stepSize++;

    const nums = [0, ...Array.from(Array(24 / stepSize - 1).keys()).map(e => (e + 1) * stepSize), 24];

    return nums.map((e, i) => {
      let w = (stepSize / 24) * 100;
      w = Math.floor(w * 100) / 100;

      let time: Time = { mode: TimeMode.Fixed, hours: e, minutes: 0 };
      //if (e == 24) time = { ...time, hours: 23, minutes: 59 };

      if (i == 0) return html`
        <span class="left" style=${styleMap({ width: `${w / 2}%` })}>${timeToString(time, { seconds: false, am_pm: amPm })}</span>
      `

      else if (i == (nums.length - 1)) return html`
        <span class="right" style=${styleMap({ width: `${w / 2}%` })}>${timeToString(time, { seconds: false, am_pm: amPm })}</span>
      `
      else return html`
        <span style=${styleMap({ width: `${w}%` })}>${timeToString(time, { seconds: false, am_pm: amPm })}</span>
      `;
    });
  }

  renderTimeslots() {
    //TODO: handle overlapping of tiemslots due to sun offset
    const slots = this.schedule!.slots;
    const slotWidths = this.computeSlotWidths();

    return slots.map((slot, i) => {
      const actionText = slot.actions.length ? formatActionDisplay(slot.actions[0], this.hass, this.config.customize, true, true) : '';

      const textWidth = actionText.length * 5 + 10;
      const leftMargin = i > 0 ? 15 : 0;
      const rightMargin = i < (slots.length - 1) ? 15 : 0;
      const slotWidth = slotWidths[i] - leftMargin - rightMargin;
      const nextSlot = slots[i + 1];
      const actionState = slot.actions.length
        ? isOffAction(slot.actions[0]) ? 'off' : isOnAction(slot.actions[0]) ? 'on' : ''
        : '';

      return html`
        <div
          class="slot ${this.selectedSlot == i ? 'selected' : ''} ${slot.actions.length ? actionState : 'empty'} ${slot.stop === undefined ? 'short' : ''}"
          style="${styleMap({ width: `${slotWidths[i]}px` })}"
          @click=${this._toggleSelectTimeslot}
          idx="${i}"
        >
          ${slot.stop || 1 == 1 ? '' : html`
            <div
              class="marker"
              @click=${this._toggleSelectTimeslot}
              idx="${i}"
            >
            </div>`}
          ${slot.actions.length
          ? actionText && (slotWidth > textWidth / 3 || slotWidth > 50) && slotWidth > 30
            ? html`<span style="margin-inline-start: ${leftMargin}px; margin-inline-end: ${rightMargin}px">${actionText}</span>`
            : slotWidth > 16
              ? html`<ha-icon icon="${computeActionIcon(slot.actions[0], this.config.customize)}"></ha-icon>`
              : ''
          : ''
        }
        </div>
        ${i < (slots.length - 1) && slot.stop ? html`
        <div idx="${i}" class="handle ${this.selectedSlot == (i + 1) || this.selectedSlot == i ? '' : 'hidden'} ${nextSlot && !nextSlot.stop ? 'center' : ''}">
          <span>
            <ha-icon-button
              .path=${mdiUnfoldMoreVertical}
              @mousedown=${this._handleDragStart}
              @touchstart=${this._handleDragStart}
            >
            </ha-icon-button>
          </span>
        </div>
        ` : ''}
      `;
    });
  }

  renderBoundaries() {
    if (!this._width) return html``;

    const slots = this.schedule!.slots;
    const slotWidths = this.computeSlotWidths();
    const amPm = useAmPm(this.hass.locale);

    type Boundary = { position: number; label: string; align: 'start' | 'middle' | 'end' };
    const boundaries: Boundary[] = [];

    let cursor = 0; // leading edge of the current slot's own box
    slots.forEach((slot, i) => {
      if (i === 0) {
        boundaries.push({
          position: cursor,
          label: timeToString(parseTimeString(slot.start), { seconds: false, am_pm: amPm }),
          align: 'start',
        });
      }

      const boxEnd = cursor + slotWidths[i];
      const isLast = i === slots.length - 1;

      // A slot without a stop visually merges into the next one, so its
      // boundary is not a real time and should not get a marker.
      if (slot.stop !== undefined) {
        boundaries.push({
          position: boxEnd,
          label: timeToString(parseTimeString(slot.stop), { seconds: false, am_pm: amPm }),
          align: isLast ? 'end' : 'middle',
        });
      }

      cursor = boxEnd + (isLast ? 0 : 3);
    });

    // Rough estimate of a label's rendered width, used to detect when two
    // neighbouring labels would overlap so one of them can be raised to a
    // second tier instead of clashing.
    const estimateLabelWidth = (label: string) => label.length * 7 + 6;

    // Assign each boundary to the lowest tier where it doesn't overlap
    // anything already placed there. Tiers are unbounded: a cluster of many
    // close boundaries just keeps stacking upward. Since this is recomputed
    // from scratch on every render, tiers free up again automatically once
    // slots are resized apart.
    const tierEdges: number[] = [];
    const tiers = boundaries.map(b => {
      const labelWidth = estimateLabelWidth(b.label);
      const startEdge = b.align === 'end' ? b.position - labelWidth : b.position - labelWidth / 2;
      const endEdge = b.align === 'start' ? b.position + labelWidth : b.position + labelWidth / 2;
      let tier = tierEdges.findIndex(edge => startEdge > edge);
      if (tier === -1) tier = tierEdges.length;
      tierEdges[tier] = endEdge;
      return tier;
    });
    const maxTier = tiers.reduce((max, t) => Math.max(max, t), 0);

    // `inset-inline-start` mirrors correctly under RTL, but `translateX(-50%)`
    // is a physical transform: it always shifts left, so under RTL (where the
    // inline-start edge is the box's own right edge) it doubles the offset
    // instead of centering it. Flip the sign to compensate.
    const isRtl = getComputedStyle(this).direction === 'rtl';
    const centerShift = isRtl ? '50%' : '-50%';

    const baseLineHeight = 7;
    const tierStep = 17;
    const labelHeight = 15;
    const containerHeight = labelHeight + baseLineHeight + maxTier * tierStep;

    return html`
      <div class="boundaries" style=${styleMap({ height: `${containerHeight}px` })}>
        ${boundaries.map((b, i) => html`
          <div
            class="boundary ${b.align}"
            style=${styleMap({
      ...(b.align === 'end'
        ? { insetInlineEnd: `${this._contentWidth - b.position}px` }
        : { insetInlineStart: `${b.position}px` }),
      ...(b.align === 'middle' ? { transform: `translateX(${centerShift})` } : {}),
    })}
          >
            <span class="boundary-label">${b.label}</span>
            <span
              class="boundary-line"
              style=${styleMap({ height: `${baseLineHeight + tiers[i] * tierStep}px` })}
            ></span>
          </div>
        `)}
      </div>
    `;
  }

  computeSlotWidths() {
    const fullWidth = this._contentWidth;

    const slots = this.schedule!.slots;

    const totalWidth = fullWidth - (slots.length - 1) * 3;

    const widthPct = slots.map((e, i) => {
      const ts_start = computeTimestamp(e.start, this.hass);
      let ts_stop: number;
      if (e.stop !== undefined) {
        ts_stop = computeTimestamp(e.stop, this.hass);
        if (!ts_stop && ts_start) ts_stop = SEC_PER_DAY;
      } else {
        // Slot without a stop time: visually span to the next slot's start
        const nextSlot = slots[i + 1];
        ts_stop = nextSlot
          ? (computeTimestamp(nextSlot.start, this.hass) || SEC_PER_DAY)
          : SEC_PER_DAY;
      }
      return (ts_stop - ts_start) / SEC_PER_DAY;
    });

    const minWidth = 5;
    const minPct = minWidth / totalWidth;
    const smallSlotCount = widthPct.filter(e => e < minPct).length;
    const availableWidth = totalWidth - smallSlotCount * minWidth;

    const slotWidths = widthPct.map(e => {
      if (e < minPct) return minWidth;
      return e * availableWidth;
    });

    return slotWidths;
  }

  _toggleSelectTimeslot(ev: Event) {
    let slot = ev.target as HTMLElement;
    if (slot.tagName.toLowerCase() != 'div') slot = slot.parentElement as HTMLElement;
    const num = Number(slot.getAttribute("idx"));
    this.selectedSlot = this.selectedSlot !== num ? num : null;
    const myEvent = new CustomEvent('update', { detail: { selectedSlot: this.selectedSlot } });
    this.dispatchEvent(myEvent);
    ev.stopPropagation();
  }

  _handleDragStart(ev: MouseEvent | TouchEvent) {
    ev.preventDefault();
    ev.stopPropagation();

    let el = ev.target as HTMLElement;
    while (el.tagName !== 'DIV') el = el.parentElement as HTMLElement;

    const trackElement = el.parentElement as HTMLElement;
    const trackBounds = trackElement.getBoundingClientRect();

    const slotIdx = Number(el.getAttribute("idx"));
    // Zoomed in far enough to see individual minutes clearly: drop the
    // configured step size and snap to exact minutes instead.
    const stepSize = this._zoom >= MINUTE_DRAG_ZOOM_THRESHOLD ? 1 : (this.config.time_step || DEFAULT_TIME_STEP);
    const stepSec = stepSize * 60;

    let ts_min = slotIdx > 0
      ? computeTimestamp(this.schedule!.slots[slotIdx - 1].stop || this.schedule!.slots[slotIdx - 1].start, this.hass) + stepSec
      : stepSec;

    let ts_max = (computeTimestamp(this.schedule!.slots[slotIdx + 1].stop || this.schedule!.slots[slotIdx + 1].start, this.hass) || SEC_PER_DAY) - stepSec;
    if (this.schedule!.slots[slotIdx + 1].stop === undefined) {
      ts_max = (computeTimestamp(this.schedule!.slots[slotIdx + 2].stop || this.schedule!.slots[slotIdx + 2].start, this.hass) || SEC_PER_DAY) - stepSec;
    }

    const timeInputMode = parseTimeString(this.schedule!.slots[slotIdx + 1].start).mode;

    if ([TimeMode.Sunrise, TimeMode.Sunset].includes(timeInputMode)) {
      let time = parseTimeString(this.schedule!.slots[slotIdx + 1].start);
      let maxOffsetTime = computeTimestamp({ ...time, hours: 4, minutes: 0 }, this.hass);
      let minOffsetTime = computeTimestamp({ ...time, hours: -4, minutes: 0 }, this.hass);
      if (minOffsetTime > ts_min) ts_min = minOffsetTime;
      if (maxOffsetTime < ts_max) ts_max = maxOffsetTime;
    }

    let mouseMoveHandler = (ev: MouseEvent | TouchEvent) => {
      ev.preventDefault();

      let mouseX;

      if (typeof TouchEvent !== 'undefined') {
        if (ev instanceof TouchEvent) mouseX = ev.changedTouches[0].pageX;
        else mouseX = ev.pageX;
      } else mouseX = (ev as MouseEvent).pageX;

      const isRTL = getComputedStyle(this).direction === 'rtl';

      // המר את מיקום הגרירה בהתאם לכיוון הכתיבה
      if (isRTL) {
        mouseX = trackBounds.right - (ev instanceof TouchEvent ? ev.changedTouches[0].pageX : (ev as MouseEvent).pageX);
      } else {
        mouseX = (ev instanceof TouchEvent ? ev.changedTouches[0].pageX : (ev as MouseEvent).pageX) - trackBounds.left;
      }

      // ודא שגבולות המיקום תקינים
      if (mouseX > trackBounds.width) mouseX = trackBounds.width;
      if (mouseX < 0) mouseX = 0;

      let ts = Math.round((mouseX / trackBounds.width) * SEC_PER_DAY);

      if (ts < ts_min) ts = ts_min;
      else if (ts > ts_max) ts = ts_max;

      const hours = Math.floor(ts / 3600);
      const minutes = Math.round((ts - hours * 3600) / 60);

      let time: Time = { mode: TimeMode.Fixed, hours: hours, minutes: minutes };

      if ([TimeMode.Sunrise, TimeMode.Sunset].includes(timeInputMode)) {
        const referenceTime = timeInputMode == TimeMode.Sunrise
          ? this.hass.states['sun.sun'].attributes['next_rising']
          : this.hass.states['sun.sun'].attributes['next_setting'];

        const offset = computeTimeOffset(time, referenceTime);
        time = { mode: timeInputMode, hours: offset.hours, minutes: offset.minutes };
      }
      time = roundTime(time, stepSize);

      const timeStr = timeToString(time);

      let slots = [... this.schedule!.slots];
      slots = Object.assign(slots, {
        [slotIdx]: { ...slots[slotIdx], stop: timeStr },
        [slotIdx + 1]: { ...slots[slotIdx + 1], start: timeToString(time) }
      });
      if (slots[slotIdx + 1].stop === undefined) {
        const timeStrNext = timeToString(addTimeOffset(time, { minutes: 1 }));
        slots = Object.assign(slots, {
          [slotIdx + 2]: { ...slots[slotIdx + 2], start: timeStrNext },
        });
      }

      this.schedule = { ...this.schedule!, slots: slots };
      const myEvent = new CustomEvent('update', { detail: { slots: slots } });
      this.dispatchEvent(myEvent);
    }


    const dragStartHandler = (ev: Event) => {
      ev.preventDefault();
    };

    const mouseUpHandler = () => {
      window.removeEventListener('mousemove', mouseMoveHandler);
      window.removeEventListener('touchmove', mouseMoveHandler);
      window.removeEventListener('mouseup', mouseUpHandler);
      window.removeEventListener('touchend', mouseUpHandler);
      window.removeEventListener('blur', mouseUpHandler);
      window.removeEventListener('dragstart', dragStartHandler);
      mouseMoveHandler = () => {
        /**/
      };
    };

    window.addEventListener('mouseup', mouseUpHandler);
    window.addEventListener('touchend', mouseUpHandler);
    window.addEventListener('blur', mouseUpHandler);
    window.addEventListener('dragstart', dragStartHandler);
    window.addEventListener('mousemove', mouseMoveHandler);
    window.addEventListener('touchmove', mouseMoveHandler);
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        max-width: 100%;
        overflow: hidden;
      }
      .zoom-controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        margin-bottom: 4px;
      }
      .zoom-level {
        font-size: 0.75rem;
        color: var(--secondary-text-color);
        min-width: 3em;
        text-align: center;
        cursor: pointer;
        user-select: none;
      }
      .viewport {
        width: 100%;
        overflow: hidden;
        position: relative;
        touch-action: none;
        /* A block wider than its container overflow-anchors based on its
           PARENT's direction (this element), not its own. Forcing ltr here
           gives zoom-content a fixed, direction-independent anchor; see the
           comment in render(). Real direction is restored further down. */
        direction: ltr;
      }
      .zoom-content {
        position: relative;
      }
      .slots-wrapper {
        width: 100%;
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
        font-size: 0.8rem;
        font-weight: 600;
        line-height: 1;
        white-space: nowrap;
        color: var(--primary-text-color);
        margin-bottom: 3px;
      }
      .boundary-line {
        display: block;
        width: 1px;
        background: var(--divider-color, rgba(127, 127, 127, 0.5));
        transition: height 0.15s ease-in-out;
      }
      .bar {
        width: 100%;
        height: 60px;
        display: flex;
      }
      .time-bar {
        width: 100%;
        height: 18px;
        display: flex;
      }
      .time-bar span {
        display: flex;
        justify-content: center;
        white-space: nowrap;
      }
      .time-bar span.left {
        justify-content: flex-start;
      }
      .time-bar span.right {
        justify-content: flex-end;
      }

      .slot {
        display: flex;
        height: 100%;
        box-sizing: border-box;
        cursor: pointer;
        background: rgba(var(--rgb-primary-color), 0.7);
        color: var(--text-primary-color);
        font-weight: 500;
        align-items: center;
        justify-content: center;
        word-break: break-all;
        white-space: normal;
        margin-inline-end: 3px;
      }
      .slot:hover {
        background: rgba(var(--rgb-primary-color), 0.85);
      }
      .slot.selected {
        border: 3px solid rgba(var(--rgb-primary-color), 0.85);
      }
      .slot.selected:hover {
        border: 3px solid rgba(var(--rgb-primary-color), 1);
      }
      .slot:first-child {
        border-start-start-radius: 10px;
        border-end-start-radius: 10px;
      }
      .slot:last-child {
        border-start-end-radius: 10px;
        border-end-end-radius: 10px;
        margin-inline-end: 0px;
      }
      .slot.on {
        background: rgba(var(--rgb-state-active-color, 67, 160, 71), 0.75);
      }
      .slot.on:hover {
        background: rgba(var(--rgb-state-active-color, 67, 160, 71), 0.9);
      }
      .slot.on.selected {
        border: 3px solid rgba(var(--rgb-state-active-color, 67, 160, 71), 0.9);
      }
      .slot.on.selected:hover {
        border: 3px solid rgba(var(--rgb-state-active-color, 67, 160, 71), 1);
      }
      .slot.off {
        background: rgba(211, 47, 47, 0.7);
      }
      .slot.off:hover {
        background: rgba(211, 47, 47, 0.85);
      }
      .slot.off.selected {
        border: 3px solid rgba(211, 47, 47, 0.85);
      }
      .slot.off.selected:hover {
        border: 3px solid rgba(211, 47, 47, 1);
      }
      .slot.empty {
        background: rgba(var(--rgb-secondary-text-color), 0.5);
      }
      .slot.empty:hover {
        background: rgba(var(--rgb-secondary-text-color), 0.65);
      }
      .slot.empty.selected {
        border: 3px solid rgba(var(--rgb-secondary-text-color), 0.65);
      }
      .slot.empty.selected:hover {
        border: 3px solid rgba(var(--rgb-secondary-text-color), 1);
      }
      .slot .marker {
        width: 24px;
        height: 24px;
        background: rgba(var(--rgb-primary-color), 0.85);
        margin-top: -80px;
        position: absolute;
        transform: rotate(45deg);
        border-radius: 12px 12px 0px 12px;
      }
      .slot .marker:hover {
        background: rgba(var(--rgb-primary-color), 1);
      }
      .slot.on .marker {
        background: rgba(var(--rgb-state-active-color, 67, 160, 71), 0.9);
      }
      .slot.on .marker:hover {
        background: rgba(var(--rgb-state-active-color, 67, 160, 71), 1);
      }
      .slot.off .marker {
        background: rgba(211, 47, 47, 0.85);
      }
      .slot.off .marker:hover {
        background: rgba(211, 47, 47, 1);
      }
      .slot.empty .marker {
        background: rgba(var(--rgb-secondary-text-color), 0.85);
      }
      .slot.empty .marker:hover {
        background: rgba(var(--rgb-secondary-text-color), 1);
      }
      .handle {
        display: flex;
        width: 36px;
        height: 100%;
        align-content: center;
        align-items: center;
        justify-content: center;
        margin-inline-start: -18px;
        margin-inline-end: -18px;
        visibility: visible;
      }
      .handle.hidden {
        visibility: hidden;
      }
      .handle span {
        background: var(--card-background-color);
        border-radius: 50%;
        width: 24px;
        height: 24px;
        display: flex;
        z-index: 5;
      }
      .handle ha-icon-button {
        --mdc-icon-button-size: 36px;
        margin-top: -12px;
        margin-inline-start: -12px;
      }
      .handle.center span {
        margin-inline-end: -2px;
      }
    `;
  }
}