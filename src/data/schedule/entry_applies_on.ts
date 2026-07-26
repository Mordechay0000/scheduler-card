import { ScheduleEntry, TWeekday } from "../../types";

export const JS_DAY_TO_WEEKDAY: TWeekday[] = [
  TWeekday.Sunday,
  TWeekday.Monday,
  TWeekday.Tuesday,
  TWeekday.Wednesday,
  TWeekday.Thursday,
  TWeekday.Friday,
  TWeekday.Saturday,
];

/**
 * Whether an entry actually runs on a given date.
 *
 * Note this is genuinely different from pickEntryForWeekday, which always
 * returns *something* to draw. A schedule limited to Fridays still has an
 * entry to render, but it does not apply on a Tuesday - the overview uses
 * this to tell the two cases apart instead of drawing them identically.
 *
 * 'workday' and 'weekend' are resolved the same way the rest of the card
 * treats them (Fri/Sat as the weekend); the backend owns the real
 * evaluation, this is display-only.
 */
export const entryAppliesOn = (entry: ScheduleEntry, date: Date): boolean => {
  const dayOfWeek = JS_DAY_TO_WEEKDAY[date.getDay()];
  const isWeekend = dayOfWeek === TWeekday.Friday || dayOfWeek === TWeekday.Saturday;

  if (entry.weekdays.includes(TWeekday.Daily)) return true;
  if (entry.weekdays.includes(dayOfWeek)) return true;
  if (isWeekend && entry.weekdays.includes(TWeekday.Weekend)) return true;
  if (!isWeekend && entry.weekdays.includes(TWeekday.Workday)) return true;
  return false;
};
