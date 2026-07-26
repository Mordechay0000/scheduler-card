/**
 * Runs the browser test suites against the built bundle.
 *
 * These drive the real custom elements in a real browser, because almost
 * everything worth testing here is layout and pointer behaviour: RTL
 * positioning, drag gestures that must survive the browser's own native
 * drag, and edits that must actually reach the backend.
 *
 * Usage: npm test   (build first, or use npm run test:build)
 */
import fs from 'node:fs';
import path from 'node:path';
import { TESTS_DIR, REPO_ROOT } from './harness.mjs';

const files = fs.readdirSync(TESTS_DIR)
  .filter(f => f.endsWith('.test.mjs'))
  .sort();

const bundle = path.join(REPO_ROOT, 'dist', 'scheduler-card.js');
if (!fs.existsSync(bundle)) {
  console.error(`\nNo build found at ${path.relative(REPO_ROOT, bundle)}.`);
  console.error('Run "npm run rollup" first, or "npm run test:build" to do both.\n');
  process.exit(1);
}

let passed = 0;
let failed = 0;

for (const file of files) {
  const { default: run } = await import(path.join(TESTS_DIR, file));
  const suite = await run();
  console.log(`\n${suite.name}: ${suite.passed} passed, ${suite.failed} failed`);
  passed += suite.passed;
  failed += suite.failed;
}

console.log(`\n${'-'.repeat(48)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
