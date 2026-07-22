import { Schedule } from "../../types";
import { mergeEqualAdjacentSlots } from "./merge_equal_slots";

export const removeTimeslot = (schedule: Schedule, entry: number, slotIdx: number): Schedule => {
  let slots = [...schedule.entries[entry].slots];

  const cutIndex = slotIdx == (slots.length - 1) ? slotIdx - 1 : slotIdx;

  slots = [
    ...slots.slice(0, cutIndex),
    {
      ...slots[cutIndex! + 1],
      start: slots[cutIndex!].start,
      stop: slots[cutIndex! + 1].stop!,
    },
    ...slots.slice(cutIndex + 2),
  ];

  // If the merge left the remaining slot with the exact same effect as its
  // OWN neighbour (e.g. deleting the middle of on/dim/on collapses into a
  // single "on"), fold those together too.
  slots = mergeEqualAdjacentSlots(slots);

  schedule = {
    ...schedule,
    entries: Object.assign(
      schedule.entries,
      {
        [entry]: { ...schedule.entries[entry], slots: slots }
      }
    )
  }
  return schedule;
}