import { Suite, buildPage, withPage, segCentre, dragBy, slotTimes, apiEndpoints } from './harness.mjs';

// Two rows sharing a ruler, the same arrangement overview mode renders.
const PAGE = buildPage({
  body: `
    <div style="width:820px;background:#fff">
      <scheduler-overview-ruler id="ruler"></scheduler-overview-ruler>
      <scheduler-overview-row id="row1"></scheduler-overview-row>
      <scheduler-overview-row id="row2"></scheduler-overview-row>
    </div>`,
  script: `
    const COND = { type:'and', items:[], track_changes:false };
    const A = (svc, data={}, e='light.living_room') => ({ service:svc, service_data:data, target:{entity_id:e} });
    Object.assign(window.__hass.states, {
      'switch.s1': { entity_id:'switch.s1', state:'on', attributes:{} },
      'switch.s2': { entity_id:'switch.s2', state:'on', attributes:{} },
      'light.living_room': { entity_id:'light.living_room', attributes:{ friendly_name:'תאורת סלון' } },
      'switch.plate': { entity_id:'switch.plate', attributes:{ friendly_name:'פלטת שבת' } },
    });
    const ruler = document.getElementById('ruler');
    ruler.hass = window.__hass; ruler.zoom = 1; ruler.panPx = 0;
    const mk = (id, sw, ent) => {
      const r = document.getElementById(id);
      r.hass = window.__hass; r.config = {}; r.schedule_id = id;
      r.zoom = 1; r.panPx = 0; r.viewportWidth = 620;
      r.schedule = { entity_id:sw, schedule_id:id, enabled:true, next_entries:[], timestamps:[], repeat_type:'repeat',
        entries:[{ weekdays:['daily'], slots:[
          { start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off',{},ent)], conditions:COND },
          { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on',{brightness:255},ent)], conditions:COND },
        ]}]};
      r.addEventListener('editClick', ev => { window.__editClicks = window.__editClicks || []; window.__editClicks.push(ev.detail); });
      return r;
    };
    mk('row1','switch.s1','light.living_room');
    mk('row2','switch.s2','switch.plate');
    await new Promise(r => setTimeout(r, 250));
    window.__done = true;`,
});

export default async function run() {
  const s = new Suite('overview editing');

  await withPage(PAGE, async (page, pageErrors) => {
    s.ok(pageErrors.length === 0, `renders without page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);

    // Click regions: icon toggles, label opens the dialog.
    await page.evaluate(() => document.getElementById('row1').shadowRoot.querySelector('.toggle').click());
    await page.waitForTimeout(80);
    s.ok(await page.evaluate(() => (window.__serviceCalls || []).length) === 1, 'icon click calls a toggle service');
    s.ok(await page.evaluate(() => !window.__editClicks), 'icon click does not open the edit dialog');

    await page.evaluate(() => document.getElementById('row1').shadowRoot.querySelector('.label').click());
    await page.waitForTimeout(80);
    s.ok(await page.evaluate(() => (window.__editClicks || []).length) === 1, 'label click opens the edit dialog');

    // The device label must line up with the bar's coloured strip.
    const aligned = await page.evaluate(() => {
      const row = document.getElementById('row1').shadowRoot;
      const device = row.querySelector('.device').getBoundingClientRect();
      const strip = row.querySelector('scheduler-overview-bar').shadowRoot.querySelector('.bar').getBoundingClientRect();
      return Math.abs(device.bottom - strip.bottom) < 2;
    });
    s.ok(aligned, 'device label is level with the bar strip');

    const original = await slotTimes(page, 'row1');

    // Body drag resizes. Under RTL, dragging slot 0 left consumes from its neighbour.
    let seg = await segCentre(page, 'row1', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(600);
    await dragBy(page, seg, -50);
    await page.waitForTimeout(250);
    const edited = await slotTimes(page, 'row1');
    s.ok(edited !== original, `dragging the slot body resizes it (${original} -> ${edited})`);
    const endpoints = await apiEndpoints(page);
    s.ok(endpoints.length > 0, 'the resize is persisted');
    s.ok(endpoints.every(e => e === 'scheduler/edit'),
      `an existing schedule is updated via scheduler/edit, never scheduler/add (${endpoints.join(', ')})`);

    // A second consecutive drag must also commit. This used to be swallowed by
    // the browser starting a native drag, which cancels the pointer sequence.
    await page.waitForTimeout(600);
    seg = await segCentre(page, 'row1', 0);
    await dragBy(page, seg, -30);
    await page.waitForTimeout(250);
    s.ok(await slotTimes(page, 'row1') !== edited, 'a second consecutive drag also commits (no native-drag cancellation)');

    // Reset returns to the state before any overview edit, not just one step.
    await page.waitForTimeout(700);
    const pill = await page.evaluate(() => {
      const p = document.getElementById('row1').shadowRoot.querySelector('.save-pill');
      return p ? { text: p.textContent.trim(), cls: p.className, disabled: p.disabled } : null;
    });
    s.ok(pill && pill.cls.includes('reset') && !pill.disabled, 'the pill becomes an enabled reset button');
    await page.evaluate(() => document.getElementById('row1').shadowRoot.querySelector('.save-pill').click());
    await page.waitForTimeout(300);
    s.ok(await slotTimes(page, 'row1') === original, 'reset reverts every change made since the card opened');
    s.ok(await page.evaluate(() => !document.getElementById('row1').shadowRoot.querySelector('.save-pill')),
      'the pill disappears once reset');

    // Create by double-click + drag, then delete with the keyboard.
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => document.getElementById('row1').schedule.entries[0].slots.length);
    seg = await segCentre(page, 'row1', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(80);
    await dragBy(page, seg, -70);
    await page.waitForTimeout(300);
    const created = await page.evaluate(() => document.getElementById('row1').schedule.entries[0].slots.length);
    s.ok(created > before, `double-click and drag carves a new slot (${before} -> ${created})`);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    s.ok(await page.evaluate(() => document.getElementById('row1').schedule.entries[0].slots.length) < created,
      'Delete removes the selected slot');

    // Selection is exclusive across rows.
    seg = await segCentre(page, 'row2', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(150);
    s.ok(await page.evaluate(() => {
      const sel = id => !!document.getElementById(id).shadowRoot
        .querySelector('scheduler-overview-bar').shadowRoot.querySelector('.seg.selected');
      return sel('row2') && !sel('row1');
    }), 'selecting a slot clears the selection in other schedules');
  });

  return s;
}
