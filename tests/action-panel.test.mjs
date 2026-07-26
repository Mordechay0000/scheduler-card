import { Suite, buildPage, withPage, segCentre, apiEndpoints, apiPayload } from './harness.mjs';

const PAGE = buildPage({
  body: `
    <div style="width:860px;background:#fff">
      <scheduler-overview-row id="row1"></scheduler-overview-row>
      <scheduler-overview-add-row id="add"></scheduler-overview-add-row>
    </div>`,
  script: `
    await customElements.whenDefined('scheduler-overview-add-row');
    const COND = { type:'and', items:[], track_changes:false };
    const A = s => ({ service:s, service_data:{}, target:{entity_id:'light.living_room'} });
    Object.assign(window.__hass.states, {
      'switch.s1': { entity_id:'switch.s1', state:'on', attributes:{} },
      'light.living_room': { entity_id:'light.living_room',
        attributes:{ friendly_name:'תאורת סלון', supported_color_modes:['color_temp','hs'] } },
      'light.salon': { entity_id:'light.salon',
        attributes:{ friendly_name:'סלון', supported_color_modes:['color_temp','hs'] } },
    });
    const r = document.getElementById('row1');
    r.hass = window.__hass; r.config = {}; r.schedule_id = 'row1';
    r.zoom = 1; r.panPx = 0; r.viewportWidth = 620;
    r.schedule = { entity_id:'switch.s1', schedule_id:'row1', enabled:true, next_entries:[], timestamps:[], repeat_type:'repeat',
      entries:[{ weekdays:['daily'], slots:[
        { start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off')], conditions:COND },
        { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on')], conditions:COND },
      ]}]};
    const add = document.getElementById('add');
    add.hass = window.__hass; add.config = {}; add.zoom = 1; add.panPx = 0; add.viewportWidth = 620;
    await new Promise(r => setTimeout(r, 250));
    window.__done = true;`,
});

const panelOf = (page, host) => page.evaluate(id =>
  !!document.getElementById(id).shadowRoot.querySelector('scheduler-overview-action-panel'), host);

const inPanel = (page, host, selector) => page.evaluate(([id, sel]) => {
  const p = document.getElementById(id).shadowRoot.querySelector('scheduler-overview-action-panel');
  return p ? !!p.shadowRoot.querySelector(sel) : false;
}, [host, selector]);

export default async function run() {
  const s = new Suite('minimal action panel');

  await withPage(PAGE, async page => {
    // --- existing schedule ---
    let seg = await segCentre(page, 'row1', 1);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(200);
    s.ok(await panelOf(page, 'row1'), 'selecting a slot opens the action panel');

    const labels = await page.evaluate(() => {
      const p = document.getElementById('row1').shadowRoot.querySelector('scheduler-overview-action-panel');
      return [...p.shadowRoot.querySelectorAll('.params label span')].map(e => e.textContent);
    });
    s.ok(labels.length === 3, `brightness, colour temperature and colour are all offered (${labels.join(', ')})`);

    await page.evaluate(() => {
      const p = document.getElementById('row1').shadowRoot.querySelector('scheduler-overview-action-panel');
      const i = p.shadowRoot.querySelector(".params input[type='range']");
      i.value = '90'; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    s.ok(await page.evaluate(() =>
      document.getElementById('row1').schedule.entries[0].slots[1].actions[0].service_data.brightness) === 90,
      'moving the brightness slider writes to the schedule');
    s.ok((await apiEndpoints(page)).includes('scheduler/edit'),
      'editing an existing schedule goes to scheduler/edit');
    s.ok(await page.evaluate(() => !!document.getElementById('row1').shadowRoot.querySelector('.save-pill')),
      'it goes through the same save/undo path as a drag');

    await page.evaluate(() => {
      const p = document.getElementById('row1').shadowRoot.querySelector('scheduler-overview-action-panel');
      p.shadowRoot.querySelector('.act.off').click();
    });
    await page.waitForTimeout(250);
    s.ok(await page.evaluate(() =>
      document.getElementById('row1').schedule.entries[0].slots[1].actions[0].service) === 'light.turn_off',
      'the on/off buttons change the slot action');

    // --- add flow, same panel ---
    await page.evaluate(() => document.getElementById('add').shadowRoot.querySelector('.add-affordance').click());
    await page.waitForTimeout(120);
    await page.evaluate(() => document.getElementById('add').shadowRoot.querySelector('scheduler-entity-picker')
      .dispatchEvent(new CustomEvent('value-changed', { detail: { value: ['light.salon'] }, bubbles: true, composed: true })));
    await page.waitForTimeout(250);
    s.ok(await page.evaluate(() => document.getElementById('add')._slots.length) === 3,
      'picking an entity drafts a schedule split into three');

    seg = await segCentre(page, 'add', 0);
    await page.mouse.click(seg.x, seg.y);
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('add').shadowRoot
      .querySelector('scheduler-overview-action-panel').shadowRoot.querySelector('.act.on').click());
    await page.waitForTimeout(200);
    s.ok(await inPanel(page, 'add', ".params input[type='color']"), 'a colour picker is offered for colour-capable lights');

    await page.evaluate(() => {
      const p = document.getElementById('add').shadowRoot.querySelector('scheduler-overview-action-panel');
      const c = p.shadowRoot.querySelector(".params input[type='color']");
      c.value = '#ff8c1a'; c.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    s.ok(await page.evaluate(() =>
      (document.getElementById('add')._slots[0].actions[0].service_data.rgb_color || []).join()) === '255,140,26',
      'choosing a colour writes rgb_color');
    s.ok(await page.evaluate(() => {
      const bar = document.getElementById('add').shadowRoot.querySelector('scheduler-overview-bar');
      return getComputedStyle(bar.shadowRoot.querySelectorAll('.seg')[0]).backgroundColor;
    }) === 'rgba(255, 140, 26, 0.75)', 'the slot is tinted with the chosen colour');

    await page.evaluate(() => { window.__apiCalls = []; document.getElementById('add').shadowRoot.querySelector('.confirm').click(); });
    await page.waitForTimeout(300);
    const saved = await apiPayload(page, 0);
    s.ok((await apiEndpoints(page))[0] === 'scheduler/add', 'saving a new draft goes to scheduler/add');
    s.ok(!!saved && saved.schedule_id === undefined, 'the new schedule is sent without a schedule_id');
    s.ok(saved.timeslots[saved.timeslots.length - 1].stop === '00:00:00',
      'end of day is written as 00:00:00, the form the backend expects');
    s.ok(await page.evaluate(() => document.getElementById('add')._entityId) === null, 'the add row resets after saving');
  });

  return s;
}
