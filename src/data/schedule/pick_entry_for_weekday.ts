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
 * Pick the entry that applies on a given date (defaults to today). Falls
 * back to the first entry if none match explicitly (e.g. workday/weekend
 * groups, which aren't resolved here - this is a display-only pick for the
 * overview, not the actual triggering logic).
 */
export const pickEntryForWeekday = (entries: ScheduleEntry[], date: Date = new Date()): ScheduleEntry => {
  const dayOfWeek = JS_DAY_TO_WEEKDAY[date.getDay()];
  const isWeekend = dayOfWeek === TWeekday.Friday || dayOfWeek === TWeekday.Saturday;

  const match = entries.find(entry => entry.weekdays.includes(dayOfWeek))
    || entries.find(entry => isWeekend
      ? entry.weekdays.includes(TWeekday.Weekend)
      : entry.weekdays.includes(TWeekday.Workday))
    || entries.find(entry => entry.weekdays.includes(TWeekday.Daily));

  return match || entries[0];
};
