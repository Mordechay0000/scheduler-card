import { ScheduleEntry, TWeekday } from "../../types";

const JS_DAY_TO_WEEKDAY: TWeekday[] = [
  TWeekday.Sunday,
  TWeekday.Monday,
  TWeekday.Tuesday,
  TWeekday.Wednesday,
  TWeekday.Thursday,
  TWeekday.Friday,
  TWeekday.Saturday,
];

/**
 * Pick the entry (and its index) that applies on a given date (defaults to
 * today). Falls back to the first entry if none match explicitly (e.g.
 * workday/weekend groups, which aren't resolved here - this is a
 * display-only pick for the overview, not the actual triggering logic).
 */
export const pickEntryForWeekday = (entries: ScheduleEntry[], date: Date = new Date()): { entry: ScheduleEntry; index: number } => {
  const dayOfWeek = JS_DAY_TO_WEEKDAY[date.getDay()];
  const isWeekend = dayOfWeek === TWeekday.Friday || dayOfWeek === TWeekday.Saturday;

  const index = entries.findIndex(entry => entry.weekdays.includes(dayOfWeek));
  const fallbackIndex = index >= 0 ? index : entries.findIndex(entry => isWeekend
    ? entry.weekdays.includes(TWeekday.Weekend)
    : entry.weekdays.includes(TWeekday.Workday));
  const dailyIndex = fallbackIndex >= 0 ? fallbackIndex : entries.findIndex(entry => entry.weekdays.includes(TWeekday.Daily));
  const finalIndex = dailyIndex >= 0 ? dailyIndex : 0;

  return { entry: entries[finalIndex], index: finalIndex };
};
