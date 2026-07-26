import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TESTS_DIR, '..');
const BUNDLE = path.join(REPO_ROOT, 'dist', 'scheduler-card.js');

/** Minimal `hass` stand-in. Service calls and API writes are recorded so a
 *  test can assert on what the card actually sent. */
export const HASS_STUB = `{
  language: 'he',
  locale: { time_format: 'twenty_four', language: 'he' },
  states: {},
  callService: (domain, service, data) => {
    window.__serviceCalls = window.__serviceCalls || [];
    window.__serviceCalls.push({ domain, service, data });
  },
  callApi: (method, endpoint, data) => {
    window.__apiCalls = window.__apiCalls || [];
    window.__apiCalls.push(data);
    return Promise.resolve(true);
  },
  callWS: () => Promise.resolve({}),
}`;

const THEME_VARS = `
  :root {
    --primary-color: #03a9f4; --rgb-primary-color: 3,169,244;
    --text-primary-color: #fff; --primary-text-color: #212121;
    --secondary-text-color: #727272; --rgb-secondary-text-color: 114,114,114;
    --rgb-state-active-color: 67,160,71; --divider-color: rgba(0,0,0,.2);
    --card-background-color: #fff; --state-icon-color: #44739e;
    --disabled-text-color: #bdbdbd;
  }
  body { margin: 0; padding: 20px; }
`;

/**
 * Builds a page around the real, built card bundle. `body` is markup and
 * `script` is module code run after the custom elements are defined; it
 * should set `window.__done = true` when the fixture is ready.
 */
export function buildPage({ body, script, dir = 'rtl' }) {
  return `<!DOCTYPE html>
<html dir="${dir}"><head><meta charset="utf-8"><style>${THEME_VARS}</style></head>
<body>
${body}
<script type="module">
import './scheduler-card.js';
await customElements.whenDefined('scheduler-overview-row');
window.__hass = ${HASS_STUB};
${script}
</script>
</body></html>`;
}

/** Slot/schedule fixtures shared by the suites. */
export const COND = { type: 'and', items: [], track_changes: false };

export function action(service, service_data = {}, entity_id = 'light.living_room') {
  return { service, service_data, target: { entity_id } };
}

export function schedule(id, slots, { weekdays = ['daily'], entity_id = 'switch.schedule' } = {}) {
  return {
    entity_id, schedule_id: id, enabled: true, next_entries: [], timestamps: [],
    repeat_type: 'repeat', entries: [{ weekdays, slots }],
  };
}

export class Suite {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = 0;
  }

  ok(condition, message) {
    if (condition) {
      this.passed++;
      console.log(`  ✓ ${message}`);
    } else {
      this.failed++;
      console.log(`  ✗ ${message}`);
    }
  }
}

/**
 * Serves the test page next to the built bundle and hands the caller a
 * ready page. Everything is torn down afterwards, including on failure.
 */
export async function withPage(html, fn) {
  if (!fs.existsSync(BUNDLE)) {
    throw new Error(`missing ${BUNDLE} - run "npm run rollup" first`);
  }

  const files = {
    '/index.html': { body: html, type: 'text/html' },
    '/scheduler-card.js': { body: fs.readFileSync(BUNDLE), type: 'text/javascript' },
  };

  const server = http.createServer((req, res) => {
    const file = files[req.url === '/' ? '/index.html' : req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': file.type });
    res.end(file.body);
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  // CHROMIUM_PATH lets an image with a preinstalled browser be used as-is
  // instead of downloading one.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.__done === true, { timeout: 15000 });
    return await fn(page, pageErrors);
  } finally {
    await browser.close();
    server.close();
  }
}

/** Centre of the nth `.seg` of a row's bar, in page coordinates. */
export function segCentre(page, rowId, index, barIndex = 0) {
  return page.evaluate(([id, i, b]) => {
    const bar = document.getElementById(id).shadowRoot.querySelectorAll('scheduler-overview-bar')[b];
    const rect = bar.shadowRoot.querySelectorAll('.seg')[i].getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, [rowId, index, barIndex]);
}

/** Drags horizontally from a point by `dx`, as a real pointer would. */
export async function dragBy(page, from, dx) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y, { steps: 6 });
  await page.mouse.up();
}

export function slotTimes(page, rowId) {
  return page.evaluate(id =>
    JSON.stringify(document.getElementById(id).schedule.entries[0].slots.map(s => [s.start, s.stop])), rowId);
}
