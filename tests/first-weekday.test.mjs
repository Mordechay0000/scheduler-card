import { Suite, buildPage, withPage } from './harness.mjs';

// One day picker per first_weekday setting, so the ordering can be compared
// directly against what Home Assistant is configured to use.
const PAGE = buildPage({
  dir: 'ltr',
  body: `
    <div style="width:900px;background:#fff">
      <dialog-select-weekdays id="picker-mon"></dialog-select-weekdays>
      <dialog-select-weekdays id="picker-sun"></dialog-select-weekdays>
      <scheduler-overview-daybar id="monday"></scheduler-overview-daybar>
      <scheduler-overview-daybar id="sunday"></scheduler-overview-daybar>
      <scheduler-overview-daybar id="saturday"></scheduler-overview-daybar>
      <scheduler-overview-daybar id="language"></scheduler-overview-daybar>
      <scheduler-overview-daybar id="bogus"></scheduler-overview-daybar>
    </div>`,
  script: `
    await customElements.whenDefined('scheduler-overview-daybar');
    const mk = (id, firstWeekday) => {
      const el = document.getElementById(id);
      el.hass = { ...window.__hass, locale: { ...window.__hass.locale, language: 'en', first_weekday: firstWeekday } };
      el.date = new Date();
      el.spanDays = 1;
    };
    mk('monday', 'monday');
    mk('sunday', 'sunday');
    mk('saturday', 'saturday');
    mk('language', 'language');
    mk('bogus', 'not-a-day');

    // The weekday picker used when choosing which days a schedule runs on.
    if (customElements.get('dialog-select-weekdays')) {
      const openPicker = async (id, firstWeekday) => {
        const el = document.getElementById(id);
        el.hass = { ...window.__hass, locale: { ...window.__hass.locale, language: 'en', first_weekday: firstWeekday } };
        // Pre-selected specific days put it straight into the per-day list.
        await el.showDialog({ weekdays: ['monday'], cancel: () => {}, confirm: () => {} });
      };
      await openPicker('picker-mon', 'monday');
      await openPicker('picker-sun', 'sunday');
    }
    await new Promise(r => setTimeout(r, 300));
    window.__done = true;`,
});

const labels = (page, id) => page.evaluate(i =>
  [...document.getElementById(i).shadowRoot.querySelectorAll('.day')].map(e => e.textContent.trim()), id);

export default async function run() {
  const s = new Suite('first day of week');

  await withPage(PAGE, async (page, pageErrors) => {
    s.ok(pageErrors.length === 0, `renders without page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);

    const monday = await labels(page, 'monday');
    s.ok(monday.length === 7, 'the picker shows a full week');
    s.ok(monday[0] === 'Mon' && monday[6] === 'Sun',
      `first_weekday: monday starts the week on Monday (${monday.join(' ')})`);

    const sunday = await labels(page, 'sunday');
    s.ok(sunday[0] === 'Sun' && sunday[6] === 'Sat',
      `first_weekday: sunday starts the week on Sunday (${sunday.join(' ')})`);

    const saturday = await labels(page, 'saturday');
    s.ok(saturday[0] === 'Sat' && saturday[6] === 'Fri',
      `first_weekday: saturday starts the week on Saturday (${saturday.join(' ')})`);

    // 'language' is Home Assistant's default: derive it from the locale.
    const language = await labels(page, 'language');
    s.ok(language.length === 7 && new Set(language).size === 7,
      `first_weekday: language still yields a full, ordered week (${language.join(' ')})`);

    // An unrecognised value must not mangle the list, which is what a -1
    // rotation index would do.
    const bogus = await labels(page, 'bogus');
    s.ok(bogus.length === 7 && new Set(bogus).size === 7,
      `an unknown first_weekday falls back cleanly (${bogus.join(' ')})`);

    // Today keeps its real position in the week and is still marked.
    const todayInfo = await page.evaluate(() => {
      const root = document.getElementById('monday').shadowRoot;
      const chips = [...root.querySelectorAll('.day')];
      const todayChip = root.querySelector('.day.today');
      const expected = new Date().toLocaleDateString('en', { weekday: 'short' });
      return { index: chips.indexOf(todayChip), label: todayChip?.textContent.trim(), expected };
    });
    s.ok(todayInfo.label === todayInfo.expected,
      `today is marked on the correct weekday (${todayInfo.label})`);
    s.ok(todayInfo.index >= 0 && todayInfo.index <= 6, 'today sits in its real place in the week');

    // Each chip must hand back the date for its own weekday.
    const picked = await page.evaluate(() => {
      const el = document.getElementById('monday');
      let got = null;
      el.addEventListener('date-changed', ev => { got = ev.detail.date.getDay(); });
      el.shadowRoot.querySelectorAll('.day')[2].click();
      return got;
    });
    s.ok(picked === 3, `clicking the third chip selects Wednesday when the week starts on Monday (got day ${picked})`);

    // The weekday picker for choosing which days a schedule runs must follow
    // the same setting.
    const options = id => page.evaluate(i => {
      const el = document.getElementById(i);
      if (!el || !el.shadowRoot) return null;
      return [...el.shadowRoot.querySelectorAll('[option]')].map(e => e.getAttribute('option'));
    }, id);

    const pickerMon = await options('picker-mon');
    const pickerSun = await options('picker-sun');
    s.ok(Array.isArray(pickerMon) && pickerMon[0] === 'monday' && pickerMon[6] === 'sunday',
      `the weekday picker starts on Monday too (${(pickerMon || []).join(' ')})`);
    s.ok(Array.isArray(pickerSun) && pickerSun[0] === 'sunday' && pickerSun[6] === 'saturday',
      `the weekday picker follows a Sunday start as well (${(pickerSun || []).join(' ')})`);
  });

  return s;
}
