import { Suite, buildPage, withPage, segCentre, dragBy } from './harness.mjs';

// Deliberately awkward schedules: empty, minimal, open-ended, non on/off,
// and a read-only row.
const PAGE = buildPage({
  body: `
    <div style="width:820px;background:#fff">
      <scheduler-overview-row id="empty"></scheduler-overview-row>
      <scheduler-overview-row id="one"></scheduler-overview-row>
      <scheduler-overview-row id="two"></scheduler-overview-row>
      <scheduler-overview-row id="nostop"></scheduler-overview-row>
      <scheduler-overview-row id="script"></scheduler-overview-row>
      <scheduler-overview-row id="readonly"></scheduler-overview-row>
    </div>`,
  script: `
    const COND = { type:'and', items:[], track_changes:false };
    const A = s => ({ service:s, service_data:{}, target:{entity_id:'light.living_room'} });
    Object.assign(window.__hass.states, {
      'switch.s': { entity_id:'switch.s', state:'on', attributes:{} },
      'light.living_room': { entity_id:'light.living_room', attributes:{ friendly_name:'תאורת סלון' } },
    });
    const mk = (id, slots, extra={}) => {
      const r = document.getElementById(id);
      r.hass = window.__hass; r.config = {}; r.schedule_id = id;
      r.zoom = 1; r.panPx = 0; r.viewportWidth = 620;
      Object.assign(r, extra);
      r.schedule = { entity_id:'switch.s', schedule_id:id, enabled:true, next_entries:[], timestamps:[],
        repeat_type:'repeat', entries:[{ weekdays:['daily'], slots }] };
    };
    mk('empty', []);
    mk('one', [{ start:'00:00:00', stop:'00:00:00', actions:[A('light.turn_on')], conditions:COND }]);
    mk('two', [{ start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off')], conditions:COND },
               { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on')], conditions:COND }]);
    mk('nostop', [{ start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off')], conditions:COND },
                  { start:'12:00:00', actions:[A('light.turn_on')], conditions:COND },
                  { start:'12:01:00', stop:'24:00:00', actions:[A('light.turn_off')], conditions:COND }]);
    mk('script', [{ start:'00:00:00', stop:'12:00:00',
                    actions:[{ service:'script.foo', service_data:{}, target:{entity_id:'script.foo'} }], conditions:COND },
                  { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on')], conditions:COND }]);
    mk('readonly', [{ start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off')], conditions:COND },
                    { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on')], conditions:COND }], { editable:false });
    await new Promise(r => setTimeout(r, 300));
    window.__done = true;`,
});

const slotCount = (page, id) =>
  page.evaluate(i => document.getElementById(i).schedule.entries[0].slots.length, id);

export default async function run() {
  const s = new Suite('edge cases');

  await withPage(PAGE, async (page, pageErrors) => {
    s.ok(pageErrors.length === 0, `every edge-case row renders without errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);
    s.ok(await page.evaluate(() => !!document.getElementById('empty').shadowRoot),
      'a schedule with no slots does not crash the row');
    s.ok(await page.evaluate(() =>
      !!document.getElementById('one').shadowRoot.querySelector('scheduler-overview-bar')),
      'a single-slot schedule still renders');

    // Deleting must never empty the bar.
    let seg = await segCentre(page, 'two', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(150);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(250);
    s.ok(await slotCount(page, 'two') === 2, 'Delete refuses to leave fewer than two slots');

    // Open-ended slots have no stop time to merge into.
    seg = await segCentre(page, 'nostop', 1);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(150);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(250);
    s.ok(await slotCount(page, 'nostop') === 3, 'Delete is refused on open-ended slots rather than corrupting them');

    // A script action would be destroyed by the on/off buttons.
    seg = await segCentre(page, 'script', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(200);
    s.ok(await page.evaluate(() =>
      !document.getElementById('script').shadowRoot.querySelector('scheduler-overview-action-panel')),
      'no minimal panel for a script action');
    seg = await segCentre(page, 'script', 1);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(200);
    s.ok(await page.evaluate(() =>
      !!document.getElementById('script').shadowRoot.querySelector('scheduler-overview-action-panel')),
      'an on/off slot in the same schedule still gets the panel');

    // overview_editing: false
    const before = await page.evaluate(() =>
      JSON.stringify(document.getElementById('readonly').schedule.entries[0].slots.map(x => [x.start, x.stop])));
    seg = await segCentre(page, 'readonly', 0);
    await dragBy(page, seg, -50);
    await page.waitForTimeout(250);
    s.ok(await page.evaluate(() =>
      JSON.stringify(document.getElementById('readonly').schedule.entries[0].slots.map(x => [x.start, x.stop]))) === before,
      'editing disabled: dragging changes nothing');
    s.ok(await page.evaluate(() => !!document.getElementById('readonly').shadowRoot
      .querySelector('scheduler-overview-bar').shadowRoot.querySelector('.seg.selected')),
      'editing disabled: slots can still be selected');
    s.ok(await page.evaluate(() =>
      !document.getElementById('readonly').shadowRoot.querySelector('scheduler-overview-action-panel')),
      'editing disabled: no action panel');
  });

  return s;
}
