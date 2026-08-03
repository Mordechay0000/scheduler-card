import { Suite, buildPage, withPage, segCentre, slotTimes, apiEndpoints, apiPayload } from './harness.mjs';

// 6 Jan 2026 is a Tuesday, so a Friday-only schedule must read as "not today".
const PAGE = buildPage({
  body: `
    <div style="width:860px;background:#fff">
      <scheduler-overview-daybar id="daybar"></scheduler-overview-daybar>
      <scheduler-overview-ruler id="ruler"></scheduler-overview-ruler>
      <scheduler-overview-row id="daily"></scheduler-overview-row>
      <scheduler-overview-row id="friday"></scheduler-overview-row>
    </div>`,
  script: `
    await customElements.whenDefined('scheduler-overview-daybar');
    const COND = { type:'and', items:[], track_changes:false };
    const A = s => ({ service:s, service_data:{}, target:{entity_id:'light.living_room'} });
    Object.assign(window.__hass.states, {
      'switch.s': { entity_id:'switch.s', state:'on', attributes:{} },
      'light.living_room': { entity_id:'light.living_room', attributes:{ friendly_name:'תאורת סלון' } },
    });
    window.__viewDate = new Date(2026, 0, 6);
    const slots = () => ([
      { start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off')], conditions:COND },
      { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on')], conditions:COND },
    ]);
    const mk = (id, weekdays) => {
      const r = document.getElementById(id);
      r.hass = window.__hass; r.config = {}; r.schedule_id = id;
      r.zoom = 1; r.panPx = 0; r.viewportWidth = 620; r.date = window.__viewDate;
      r.schedule = { entity_id:'switch.s', schedule_id:id, enabled:true, next_entries:[], timestamps:[],
        repeat_type:'repeat', entries:[{ weekdays, slots: slots() }] };
    };
    mk('daily', ['daily']);
    mk('friday', ['friday']);
    const daybar = document.getElementById('daybar');
    daybar.hass = window.__hass; daybar.date = window.__viewDate; daybar.spanDays = 1;
    const ruler = document.getElementById('ruler');
    ruler.hass = window.__hass; ruler.zoom = 1; ruler.panPx = 0; ruler.now = new Date(2026, 0, 6, 13, 20);
    await new Promise(r => setTimeout(r, 300));
    window.__done = true;`,
});

export default async function run() {
  const s = new Suite('day awareness, two-day view and shortcuts');

  await withPage(PAGE, async (page, pageErrors) => {
    s.ok(pageErrors.length === 0, `renders without page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);

    // A schedule still has an entry to draw on a day it does not run on -
    // the two cases must not look the same.
    const notToday = id => page.evaluate(i =>
      document.getElementById(i).shadowRoot.querySelector('.row').className.includes('not-today'), id);
    s.ok(!await notToday('daily'), 'a daily schedule reads as applying on the selected day');
    s.ok(await notToday('friday'), 'a Friday-only schedule reads as not applying on a Tuesday');
    s.ok(await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('friday').shadowRoot.querySelector('.bar-wrap')).opacity)) < 1,
      'a non-applying schedule is dimmed');

    s.ok(await page.evaluate(() =>
      document.getElementById('daybar').shadowRoot.querySelectorAll('.day').length) === 7,
      'the day picker offers a full week');
    s.ok(await page.evaluate(() =>
      !!document.getElementById('daybar').shadowRoot.querySelector('.day.today')),
      'today is marked within the week');

    // "Now" marker, positioned from the right under RTL.
    await page.evaluate(() => { document.getElementById('daily').now = new Date(2026, 0, 6, 13, 20); });
    await page.waitForTimeout(200);
    const nowFrac = await page.evaluate(() => {
      const bar = document.getElementById('daily').shadowRoot.querySelector('scheduler-overview-bar');
      const line = bar.shadowRoot.querySelector('.now-line');
      if (!line) return null;
      const strip = bar.shadowRoot.querySelector('.bar').getBoundingClientRect();
      return (strip.right - line.getBoundingClientRect().left) / strip.width;
    });
    s.ok(nowFrac !== null, 'a "now" marker is drawn when showing today');
    s.ok(nowFrac !== null && Math.abs(nowFrac - (13 + 20 / 60) / 24) < 0.02,
      `the marker sits at the current time (${nowFrac?.toFixed(3)})`);

    // Arrow keys nudge by exactly one step; under RTL, left means later.
    const before = await slotTimes(page, 'daily');
    const seg = await segCentre(page, 'daily', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(250);
    const after = await slotTimes(page, 'daily');
    s.ok(after !== before, `an arrow key nudges the selected boundary (${before} -> ${after})`);
    s.ok(after.includes('12:15:00'), 'the nudge moves exactly one time step');

    // Duplicate saves a copy the backend will treat as a new schedule.
    await page.evaluate(() => {
      window.__apiCalls = [];
      document.getElementById('daily').shadowRoot.querySelector('.duplicate').click();
    });
    await page.waitForTimeout(250);
    const copy = await apiPayload(page, 0);
    s.ok((await apiEndpoints(page))[0] === 'scheduler/add', 'duplicating creates via scheduler/add');
    s.ok(!!copy && copy.schedule_id === undefined, 'the duplicate carries no schedule_id');

    // Two-day comparison view.
    await page.evaluate(() => {
      document.getElementById('daily').spanDays = 2;
      const ruler = document.getElementById('ruler');
      ruler.spanDays = 2;
      ruler.dayLabels = ['שלישי', 'רביעי'];
    });
    await page.waitForTimeout(300);
    s.ok(await page.evaluate(() =>
      document.getElementById('daily').shadowRoot.querySelectorAll('scheduler-overview-bar').length) === 2,
      'the two-day view shows both days side by side');
    s.ok(await page.evaluate(() => {
      const bars = document.getElementById('daily').shadowRoot.querySelectorAll('scheduler-overview-bar');
      const a = bars[0].getBoundingClientRect(), b = bars[1].getBoundingClientRect();
      return a.width > 0 && Math.abs(a.width - b.width) < 2;
    }), 'each day gets an equal half of the width');
    s.ok(await page.evaluate(() =>
      document.getElementById('ruler').shadowRoot.querySelectorAll('.day-split .day-name').length) === 2,
      'the ruler names both days');
    s.ok(await page.evaluate(() =>
      !document.getElementById('ruler').shadowRoot.querySelector('.zoom-controls')),
      'zoom is withheld in the comparison view');

    // The ruler exists to label the bars, so its day boundary has to fall
    // exactly where the bars meet - any gap between them drifts the ticks.
    const seam = await page.evaluate(() => {
      const bars = document.getElementById('daily').shadowRoot.querySelectorAll('scheduler-overview-bar');
      const first = bars[0].getBoundingClientRect();
      const second = bars[1].getBoundingClientRect();
      const rulerBox = document.getElementById('ruler').shadowRoot.querySelector('.ruler').getBoundingClientRect();
      // Direction-agnostic: under RTL the first day sits on the right, so the
      // seam is whichever pair of edges is adjacent.
      const gapLtr = Math.abs(first.right - second.left);
      const gapRtl = Math.abs(second.right - first.left);
      const seamAt = gapRtl < gapLtr ? second.right : first.right;
      return { barsSeam: seamAt, rulerMid: rulerBox.left + rulerBox.width / 2, gap: Math.min(gapLtr, gapRtl) };
    });
    s.ok(seam.gap < 0.5, `the two day bars meet with no layout gap (${seam.gap.toFixed(2)}px)`);
    s.ok(Math.abs(seam.barsSeam - seam.rulerMid) < 1.5,
      `the ruler's day boundary lines up with where the bars meet (${Math.abs(seam.barsSeam - seam.rulerMid).toFixed(2)}px apart)`);
  });

  return s;
}
