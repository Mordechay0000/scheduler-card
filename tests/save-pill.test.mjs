import { Suite, buildPage, withPage, segCentre, dragBy, slotTimes } from './harness.mjs';

const PAGE = buildPage({
  body: `<div style="width:820px;background:#fff"><scheduler-overview-row id="row1"></scheduler-overview-row></div>`,
  script: `
    const COND = { type:'and', items:[], track_changes:false };
    const A = s => ({ service:s, service_data:{}, target:{entity_id:'light.living_room'} });
    Object.assign(window.__hass.states, {
      'switch.s1': { entity_id:'switch.s1', state:'on', attributes:{} },
      'light.living_room': { entity_id:'light.living_room', attributes:{ friendly_name:'תאורת סלון' } },
    });
    // Deliberately slow so the test can observe the in-flight window.
    window.__hass.callApi = (method, endpoint, data) => {
      window.__apiCalls = window.__apiCalls || [];
      window.__apiCalls.push({ method, endpoint, data });
      return new Promise(r => setTimeout(() => r(true), 300));
    };
    const r = document.getElementById('row1');
    r.hass = window.__hass; r.config = {}; r.schedule_id = 'row1';
    r.zoom = 1; r.panPx = 0; r.viewportWidth = 620;
    r.schedule = { entity_id:'switch.s1', schedule_id:'row1', enabled:true, next_entries:[], timestamps:[], repeat_type:'repeat',
      entries:[{ weekdays:['daily'], slots:[
        { start:'00:00:00', stop:'12:00:00', actions:[A('light.turn_off')], conditions:COND },
        { start:'12:00:00', stop:'24:00:00', actions:[A('light.turn_on')], conditions:COND },
      ]}]};
    await new Promise(r => setTimeout(r, 250));
    window.__done = true;`,
});

const readPill = page => page.evaluate(() => {
  const p = document.getElementById('row1').shadowRoot.querySelector('.save-pill');
  if (!p) return null;
  const cs = getComputedStyle(p);
  return { text: p.textContent.trim(), cls: p.className, bg: cs.backgroundColor };
});

export default async function run() {
  const s = new Suite('save / reset pill');

  await withPage(PAGE, async page => {
    const original = await slotTimes(page, 'row1');

    const seg = await segCentre(page, 'row1', 0);
    await dragBy(page, seg, -50);

    // The confirmation must describe a save that actually happened.
    await page.waitForTimeout(120);
    s.ok(await readPill(page) === null, 'no "saved" label while the request is still in flight');
    s.ok(await page.evaluate(() => (window.__apiCalls || []).length) > 0, 'the save request goes out immediately');

    await page.waitForTimeout(320);
    let pill = await readPill(page);
    s.ok(pill?.cls.includes('saved'), 'the "saved" label appears once the backend accepted it');
    s.ok(pill?.bg.startsWith('rgb(67, 160, 71'), 'the saved pill is a solid, prominent chip');

    await page.waitForTimeout(700);
    pill = await readPill(page);
    s.ok(pill?.cls.includes('reset'), 'it turns into a reset button shortly after');
    s.ok(pill?.bg.startsWith('rgb(3, 169, 244'), 'the reset pill is a solid, prominent button');

    // It sits beside the device, never over the bar's time labels.
    s.ok(await page.evaluate(() => {
      const root = document.getElementById('row1').shadowRoot;
      const p = root.querySelector('.save-pill').getBoundingClientRect();
      const bar = root.querySelector('.bar-wrap').getBoundingClientRect();
      return p.right <= bar.left || p.left >= bar.right;
    }), 'the pill never overlaps the bar');

    await page.evaluate(() => document.getElementById('row1').shadowRoot.querySelector('.save-pill').click());
    await page.waitForTimeout(500);
    s.ok(await slotTimes(page, 'row1') === original, 'clicking it restores the original times');
    s.ok(await readPill(page) === null, 'the pill clears after resetting');
  });

  return s;
}
