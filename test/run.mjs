// fixture.html에 빌드된 content script를 주입해 data-expect와 결과를 비교
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e));
await page.goto('file://' + path.join(dir, 'fixture.html'));
await page.addScriptTag({ path: path.join(dir, '../dist/content.js') });

const rows = await page.evaluate(() => {
  const { targets, missing } = window.__focusBridge;
  const status = new Map(missing.map((m) => [m.element, m.status]));
  const all = [...document.querySelectorAll('[data-expect]'),
               ...document.getElementById('host').shadowRoot.querySelectorAll('[data-expect]')];
  return all.map((el) => {
    const actual = !targets.includes(el) ? 'skip' : (status.get(el) || 'ok');
    return { expect: el.dataset.expect, actual, html: el.outerHTML.slice(0, 70) };
  });
});

let fail = 0;
for (const r of rows) {
  const ok = r.expect === r.actual;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expect=${r.expect.padEnd(11)} actual=${r.actual.padEnd(11)} ${r.html}`);
}
console.log(`\n${rows.length - fail}/${rows.length} passed`);
await browser.close();
process.exit(fail ? 1 : 0);
