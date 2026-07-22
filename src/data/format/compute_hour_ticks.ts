export type HourTick = {
  hour: number;
  widthPct: number;
  align: 'left' | 'right' | 'center';
};

/**
 * Pick an hour-ruler step (1/2/3/4/6/8/12h) so labels are as dense as
 * possible without touching their neighbours, given the available width.
 * Shared between the full timeslot editor's ruler and the overview mode's
 * shared ruler, so both use identical density rules.
 */
export const computeHourTicks = (fullWidth: number, amPm: boolean): HourTick[] => {
  if (!fullWidth) return [];

  const allowedStepSizes = [1, 2, 3, 4, 6, 8, 12];
  // Width one label needs to render without touching its neighbours; kept
  // tight so the ruler shows every hour whenever it fits.
  const segmentWidth = amPm ? 88 : 56;

  let stepSize = Math.ceil(24 / (fullWidth / segmentWidth));
  while (!allowedStepSizes.includes(stepSize)) stepSize++;

  const nums = [0, ...Array.from(Array(24 / stepSize - 1).keys()).map(e => (e + 1) * stepSize), 24];

  return nums.map((hour, i) => {
    let widthPct = (stepSize / 24) * 100;
    widthPct = Math.floor(widthPct * 100) / 100;
    if (i === 0 || i === nums.length - 1) widthPct = widthPct / 2;
    return {
      hour,
      widthPct,
      align: i === 0 ? 'left' : i === nums.length - 1 ? 'right' : 'center',
    };
  });
};
