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
export const OVERVIEW_SPACER_WIDTH = 158;

/**
 * Hour ruler shared by every row in overview mode, aligned with
 * scheduler-overview-row's icon+label column so it lines up with the bars
 * beneath it. Also owns the zoom UI (+/- buttons) and reports raw gestures
 * (wheel, pinch, drag) up to the card, which owns the actual shared
 * zoom/pan state - every row zooms/pans together.
 */
@customElement('scheduler-overview-ruler')
export class SchedulerOverviewRuler extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: Number }) public zoom = 1;
  @property({ type: Number }) public panPx = 0;
  @property({ type: Number }) public minZoom = 1;
  @property({ type: Number }) public maxZoom = 48;

  @state() private _width = 0;

  private _resizeObserver?: ResizeObserver;

  private _panDrag?: { pointerId: number; startX: number };

  private _pinch?: { distance: number; midpointX: number };

  private get _contentWidth() {
    return this._width * this.zoom;
  }

  connectedCallback() {
    super.connectedCallback();
    // Observe the host itself so this doesn't depend on an early render
    // succeeding (a render before `hass` is set would otherwise leave the
    // observer never attached).
    this._resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = Math.max(0, entry.contentRect.width - OVERVIEW_SPACER_WIDTH);
        if (width !== this._width) {
          this._width = width;
          this.dispatchEvent(new CustomEvent('viewport-width-changed', { detail: { width }, bubbles: true, composed: true }));
        }
      }
    });
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
  }

  private _fireZoom(detail: { anchorPx: number; factor?: number; absolute?: number; animate?: boolean }) {
    this.dispatchEvent(new CustomEvent('overview-zoom', { detail, bubbles: true, composed: true }));
  }

  private _fireReset() {
    this.dispatchEvent(new CustomEvent('overview-zoom-reset', { bubbles: true, composed: true }));
  }

  private _handleWheel(ev: WheelEvent) {
    if (!this._width) return;
    const isZoomGesture = ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX);
    ev.preventDefault();
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const anchorPx = ev.clientX - rect.left;

    if (isZoomGesture) {
      const factor = Math.pow(2, -ev.deltaY / 300);
      this._fireZoom({ anchorPx, factor });
    } else {
      this.dispatchEvent(new CustomEvent('overview-pan', { detail: { deltaPx: ev.deltaX }, bubbles: true, composed: true }));
    }
  }

  private _handlePanStart(ev: PointerEvent) {
    if (this.zoom <= this.minZoom) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this._panDrag = { pointerId: ev.pointerId, startX: ev.clientX };
  }

  private _handlePanMove(ev: PointerEvent) {
    if (!this._panDrag || this._panDrag.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - this._panDrag.startX;
    this._panDrag.startX = ev.clientX;
    this.dispatchEvent(new CustomEvent('overview-pan', { detail: { deltaPx: -dx }, bubbles: true, composed: true }));
  }

  private _handlePanEnd() {
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
    this._pinch = {
      distance: this._touchDistance(ev.touches),
      midpointX: (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left - OVERVIEW_SPACER_WIDTH,
    };
  }

  private _handlePinchMove(ev: TouchEvent) {
    if (!this._pinch || ev.touches.length !== 2) return;
    ev.preventDefault();
    const distance = this._touchDistance(ev.touches);
    const scale = distance / this._pinch.distance;
    this._fireZoom({ anchorPx: this._pinch.midpointX, factor: scale });
    this._pinch.distance = distance;
  }

  private _handlePinchEnd(ev: TouchEvent) {
    if (ev.touches.length < 2) this._pinch = undefined;
  }

  render() {
    if (!this.hass) return html``;
    const amPm = useAmPm(this.hass.locale);
    const ticks = computeHourTicks(this._contentWidth, amPm);
    const zoomPct = Math.round(this.zoom * 100);

    return html`
      <div class="zoom-controls">
        <ha-icon-button
          .disabled=${this.zoom <= this.minZoom}
          @click=${() => this._fireZoom({ anchorPx: this._width / 2, factor: 1 / 1.6, animate: true })}
        >
          <ha-icon icon="mdi:magnify-minus-outline"></ha-icon>
        </ha-icon-button>
        <span class="zoom-level" @click=${this._fireReset}>${zoomPct}%</span>
        <ha-icon-button
          .disabled=${this.zoom >= this.maxZoom}
          @click=${() => this._fireZoom({ anchorPx: this._width / 2, factor: 1.6, animate: true })}
        >
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
        <div class="spacer"></div>
        <div
          class="ruler-viewport"
          style=${styleMap({ cursor: this.zoom > this.minZoom ? 'grab' : 'default' })}
          @pointerdown=${this._handlePanStart}
          @pointermove=${this._handlePanMove}
          @pointerup=${this._handlePanEnd}
          @pointercancel=${this._handlePanEnd}
        >
          <div class="ruler" style=${styleMap({ width: `${this._contentWidth}px`, transform: `translateX(${-this.panPx}px)` })}>
            ${ticks.map(tick => {
      const time: Time = { mode: TimeMode.Fixed, hours: tick.hour, minutes: 0 };
      const label = timeToString(time, { seconds: false, am_pm: amPm });
      const cls = tick.align === 'left' ? 'left' : tick.align === 'right' ? 'right' : '';
      return html`
                <span class="${cls}" style=${styleMap({ width: `${tick.widthPct}%` })}>${label}</span>
              `;
    })}
          </div>
        </div>
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        width: 100%;
      }
      .zoom-controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        margin-bottom: 2px;
      }
      .zoom-level {
        font-size: 0.72rem;
        color: var(--secondary-text-color);
        min-width: 3em;
        text-align: center;
        cursor: pointer;
        user-select: none;
      }
      .viewport {
        display: flex;
        width: 100%;
        font-size: 0.72rem;
        color: var(--secondary-text-color);
        padding-bottom: 2px;
        touch-action: none;
      }
      .spacer {
        flex: 0 0 158px;
      }
      .ruler-viewport {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        position: relative;
        /* Forces a fixed, direction-independent overflow anchor for the
           scaled .ruler (see scheduler-overview-bar for the full
           explanation); true direction restored on the ruler itself. */
        direction: ltr;
      }
      .ruler {
        display: flex;
        position: relative;
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

  updated() {
    // Restore the true reading direction on the ruler content itself (the
    // viewport around it is forced ltr for the zoom/pan anchor math).
    const ruler = this.shadowRoot?.querySelector('.ruler') as HTMLElement | null;
    if (ruler) ruler.style.direction = getComputedStyle(this).direction;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scheduler-overview-ruler": SchedulerOverviewRuler;
  }
}
