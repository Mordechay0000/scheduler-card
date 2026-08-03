import { Suite, buildPage, withPage } from './harness.mjs';

// Drives <scheduler-card> itself, so the wiring between the card and the
// overview components is covered too: the header, the day picker, the shared
// ruler and the config options that gate them.
//
// The fixture stubs the few Home Assistant frontend pieces the card waits on
// during startup, so it initialises and loads its schedules for real.
const page = (config, { schedules = 1 } = {}) => buildPage({
  body: `<home-assistant></home-assistant><div id="host" style="width:900px"></div>`,
  script: `
    await customElements.whenDefined('scheduler-card');
    // firstUpdated waits for these Home Assistant frontend elements before it
    // loads any schedules; defining stubs lets the card initialise for real.
    for (const tag of ['ha-checkbox', 'ha-slider', 'ha-generic-picker']) {
      if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {});
    }
    document.querySelector('home-assistant')._loadFragmentTranslations = () => {};
    const legacy = (id, entity) => ({
      schedule_id: id, entity_id: entity, enabled: true, timestamps: [], next_entries: [],
      repeat_type: 'repeat', weekdays: ['daily'],
      timeslots: [
        { start: '00:00:00', stop: '12:00:00', actions: [{ service: 'light.turn_off', entity_id: 'light.living_room', service_data: {} }] },
        { start: '12:00:00', stop: '00:00:00', actions: [{ service: 'light.turn_on', entity_id: 'light.living_room', service_data: {} }] },
      ],
    });
    const items = ${schedules} ? [legacy('sched1', 'switch.schedule_1')] : [];
    Object.assign(window.__hass.states, {
      'switch.schedule_1': { entity_id:'switch.schedule_1', state:'on', attributes:{ friendly_name:'תזמון' } },
      'light.living_room': { entity_id:'light.living_room', attributes:{ friendly_name:'תאורת סלון' } },
    });
    window.__hass.callWS = req => Promise.resolve(req && req.type === 'scheduler' ? items : []);
    window.__hass.connection = { subscribeMessage: () => Promise.resolve(() => {}) };

    // Home Assistant configures the card before putting it in the document,
    // so do the same here rather than letting it render without a hass.
    const card = document.createElement('scheduler-card');
    card.id = 'card';
    card.setConfig(${JSON.stringify(config)});
    card.hass = window.__hass;
    document.getElementById('host').appendChild(card);
    await new Promise(r => setTimeout(r, 700));
    window.__done = true;`,
});

const has = (p, selector) => p.evaluate(s => !!document.getElementById('card').shadowRoot.querySelector(s), selector);

export default async function run() {
  const s = new Suite('card wiring');

  await withPage(page({}), async (p, pageErrors) => {
    const fatal = pageErrors.filter(e => !/_loadFragmentTranslations|partial-panel-resolver/.test(e));
    s.ok(fatal.length === 0, `the card renders without errors${fatal.length ? ': ' + fatal[0] : ''}`);
    s.ok(await has(p, '.card-header'), 'the header renders');
    s.ok(await has(p, '.clock'), 'the clock is shown by default');
    s.ok(await has(p, 'scheduler-overview-daybar'), 'the day picker is shown');
    s.ok(await has(p, 'scheduler-overview-ruler'), 'the shared ruler is shown');
    s.ok(await has(p, 'scheduler-overview-row'), 'schedules render as overview rows by default');
    s.ok(await has(p, 'scheduler-overview-add-row'), 'the quick-add row is shown');

    const clock = await p.evaluate(() =>
      document.getElementById('card').shadowRoot.querySelector('.clock').textContent.trim());
    s.ok(/^\d{1,2}:\d{2}$/.test(clock), `the clock shows a time (${clock})`);

    // Selecting another day must reach the rows.
    await p.evaluate(() => {
      const bar = document.getElementById('card').shadowRoot.querySelector('scheduler-overview-daybar');
      bar.shadowRoot.querySelectorAll('.day')[3].click();
    });
    await p.waitForTimeout(200);
    s.ok(await p.evaluate(() => {
      const card = document.getElementById('card').shadowRoot;
      const picked = card.querySelector('scheduler-overview-daybar').shadowRoot.querySelectorAll('.day')[3];
      return picked.classList.contains('selected')
        && !!card.querySelector('scheduler-overview-row').date;
    }), 'choosing a day propagates to the rows');

    // The two-day toggle must reach both the ruler and the rows.
    await p.evaluate(() => {
      const bar = document.getElementById('card').shadowRoot.querySelector('scheduler-overview-daybar');
      bar.shadowRoot.querySelector('.span').click();
    });
    await p.waitForTimeout(250);
    s.ok(await p.evaluate(() => {
      const card = document.getElementById('card').shadowRoot;
      return card.querySelector('scheduler-overview-ruler').spanDays === 2
        && card.querySelector('scheduler-overview-row').shadowRoot
          .querySelectorAll('scheduler-overview-bar').length === 2;
    }), 'the two-day toggle reaches the ruler and the rows');
  });

  // Config options must actually gate what they claim to.
  await withPage(page({ default_view: 'list', show_clock: false, show_quick_add: false, show_view_toggle: false }), async p => {
    s.ok(!await has(p, 'scheduler-overview-row'), 'default_view: list starts in the list view');
    s.ok(await has(p, 'scheduler-item-row'), 'the list view renders list rows');
    s.ok(!await has(p, '.clock'), 'show_clock: false hides the clock');
    s.ok(!await has(p, 'scheduler-overview-add-row'), 'show_quick_add: false hides the quick-add row');
    s.ok(!await has(p, 'ha-icon-button'), 'show_view_toggle: false hides the view switcher');
  });

  // With nothing scheduled yet, the first schedule still has to be creatable.
  await withPage(page({}, { schedules: 0 }), async p => {
    s.ok(await has(p, 'scheduler-overview-add-row'), 'the quick-add row is offered when there are no schedules yet');
    s.ok(await has(p, 'scheduler-overview-ruler'), 'the ruler is shown so the add row has a time axis');
  });

  return s;
}
