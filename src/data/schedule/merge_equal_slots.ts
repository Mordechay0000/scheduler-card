import { Action, Timeslot } from "../../types";

const normalize = (obj: Record<string, any> | undefined) =>
  JSON.stringify(Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b))));

const actionsEqual = (a: Action[], b: Action[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((actionA, i) => {
    const actionB = b[i];
    return actionA.service === actionB.service
      && normalize(actionA.service_data) === normalize(actionB.service_data)
      && normalize(actionA.target) === normalize(actionB.target);
  });
};

/**
 * Collapse consecutive slots that would have the exact same effect (same
 * actions, e.g. a light turned on at the same brightness/color, and the
 * same conditions) into a single slot spanning their combined range.
 */
export const mergeEqualAdjacentSlots = (slots: Timeslot[]): Timeslot[] => {
  const out: Timeslot[] = [];
  for (const slot of slots) {
    const prev = out[out.length - 1];
    if (
      prev
      && prev.stop !== undefined
      && actionsEqual(prev.actions, slot.actions)
      && JSON.stringify(prev.conditions) === JSON.stringify(slot.conditions)
    ) {
      out[out.length - 1] = { ...prev, stop: slot.stop };
    } else {
      out.push(slot);
    }
  }
  return out;
};
