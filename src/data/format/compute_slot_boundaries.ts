import { Timeslot } from "../../types";
import { parseTimeString } from "../time/parse_time_string";
import { timeToString } from "../time/time_to_string";
import { isOffAction, isOnAction } from "./is_off_action";
import { computeActionColor } from "./compute_action_color";

export type SlotBoundary = {
  position: number; // px from the inline-start edge
  label: string;
  align: 'start' | 'middle' | 'end';
  state: string;
  color?: string;
  tier: number;
};

export type SlotBoundaries = {
  boundaries: SlotBoundary[];
  maxTier: number;
};

/**
 * Boundary tick marks (start/end time of each slot) for a slot bar of
 * `slotWidths` px (as returned by computeSlotWidths, same `gapPx`),
 * including overlap avoidance: labels that would touch stack onto extra
 * tiers, recomputed from scratch so tiers free up again once slots spread
 * apart. Shared between the full timeslot editor and the compact overview
 * bar so both always agree on where a boundary lands and how it's colored.
 */
export const computeSlotBoundaries = (
  slots: Timeslot[],
  slotWidths: number[],
  amPm: boolean,
  gapPx = 3,
  pendingSlot: number | null = null,
): SlotBoundaries => {
  // Each boundary label is tinted like the slot that STARTS at it, so the
  // time reads as "this is when that color takes effect". The final
  // (end-of-day) boundary has no starting slot and takes the ending slot's
  // color instead.
  const slotState = (slot: Timeslot): string => {
    if (pendingSlot !== null && slots[pendingSlot] === slot) return 'pending';
    if (!slot.actions.length) return 'empty';
    if (isOffAction(slot.actions[0])) return 'off';
    if (isOnAction(slot.actions[0])) return 'on';
    return '';
  };

  // Brightness/color-temp-tinted slots carry their exact color onto their
  // start label too.
  const slotColor = (slot: Timeslot): string | undefined => {
    const color = slot.actions.length ? computeActionColor(slot.actions[0]) : null;
    return color ? `rgba(${color.rgb.join(', ')}, ${color.alpha})` : undefined;
  };

  const boundaries: Omit<SlotBoundary, 'tier'>[] = [];

  let cursor = 0; // leading edge of the current slot's own box
  slots.forEach((slot, i) => {
    if (i === 0) {
      boundaries.push({
        position: cursor,
        label: timeToString(parseTimeString(slot.start), { seconds: false, am_pm: amPm }),
        align: 'start',
        state: slotState(slot),
        color: slotColor(slot),
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
        state: isLast ? slotState(slot) : slotState(slots[i + 1]),
        color: isLast ? slotColor(slot) : slotColor(slots[i + 1]),
      });
    }

    cursor = boxEnd + (isLast ? 0 : gapPx);
  });

  // Rough estimate of a label's rendered width, used to detect when two
  // neighbouring labels would overlap so one of them can be raised to a
  // second tier instead of clashing.
  const estimateLabelWidth = (label: string) => label.length * 7 + 6;

  // Assign each boundary to the lowest tier where it doesn't overlap
  // anything already placed there. Tiers are unbounded: a cluster of many
  // close boundaries just keeps stacking upward.
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

  return {
    boundaries: boundaries.map((b, i) => ({ ...b, tier: tiers[i] })),
    maxTier,
  };
};
