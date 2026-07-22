import { HomeAssistant } from "../../lib/types";
import { Timeslot } from "../../types";
import { computeTimestamp } from "./compute_timestamp";

const SEC_PER_DAY = 24 * 3600;

/**
 * Pixel width of each slot within a bar of `fullWidth` px, leaving `gapPx`
 * between consecutive slots. Slots that would round below `minWidth` are
 * boosted to stay visible/clickable, borrowing space from the rest.
 */
export const computeSlotWidths = (slots: Timeslot[], hass: HomeAssistant, fullWidth: number, gapPx = 3, minWidth = 5): number[] => {
  const totalWidth = fullWidth - (slots.length - 1) * gapPx;

  const widthPct = slots.map((e, i) => {
    const ts_start = computeTimestamp(e.start, hass);
    let ts_stop: number;
    if (e.stop !== undefined) {
      ts_stop = computeTimestamp(e.stop, hass);
      if (!ts_stop && ts_start) ts_stop = SEC_PER_DAY;
    } else {
      // Slot without a stop time: visually span to the next slot's start
      const nextSlot = slots[i + 1];
      ts_stop = nextSlot
        ? (computeTimestamp(nextSlot.start, hass) || SEC_PER_DAY)
        : SEC_PER_DAY;
    }
    return (ts_stop - ts_start) / SEC_PER_DAY;
  });

  const minPct = minWidth / totalWidth;
  const smallSlotCount = widthPct.filter(e => e < minPct).length;
  const availableWidth = totalWidth - smallSlotCount * minWidth;

  return widthPct.map(e => {
    if (e < minPct) return minWidth;
    return e * availableWidth;
  });
};
