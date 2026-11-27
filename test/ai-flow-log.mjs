import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

async function checkPendingReuse(pending) {
  const bundle = await build({
    stdin: { contents: "export { scan } from './src/content.js';", resolveDir: process.cwd() },
    bundle: true, format: 'iife', globalName: 'flow', write: false,
  });
  const browser = await chromium.launch(process.env.CHROME
    ? { executablePath: process.env.CHROME } : { channel: 'chromium' });
  try {
    const page = await browser.newPage();
    const link = '<section><a class="store-badge" data-track="store" href="/page/mlink?store=appstore">'
      + '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/></svg></a></section>';
    await page.route('https://example.com/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html lang="ko"><body>' + link + link + '</body></html>',
    }));
    await page.addInitScript((holdDecode) => {
      window.aiTables = [];
      window.inferMessages = [];
      if (holdDecode) {
        const decode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = async function () {
          if (this.src.startsWith('data:image/svg+xml,') && !window.releaseDecode) {
            await new Promise((resolve) => { window.releaseDecode = resolve; });
          }
          return decode.call(this);
        };
      }
      let detailGroup = false;
      const group = console.groupCollapsed.bind(console);
      const table = console.table.bind(console);
      const end = console.groupEnd.bind(console);
      console.groupCollapsed = (title, ...args) => {
        detailGroup = title === '[FocusBridge AI] 응답 결과';
        group(title, ...args);
      };
      console.table = (rows, ...args) => {
        if (detailGroup) aiTables.push(rows.map((row) => ({ ...row })));
        table(rows, ...args);
      };
      console.groupEnd = () => { detailGroup = false; end(); };
      window.chrome = { runtime: { id: 'test-extension', sendMessage: async (message) => {
        if (message.type === 'focusbridge:previous:lookup') return { ok: true, records: [] };
        if (message.type === 'focusbridge:ai:infer') {
          inferMessages.push(message);
          return new Promise((resolve) => {
            window.releaseInference = () => resolve({ status: 'ok', model: 'gemini-3.5-flash-lite',
              httpStatus: 200, requestCount: inferMessages.length,
              results: message.items.map(({ payload }) => ({ requestId: payload.requestId, label: '포털 열기' })) });
          });
        }
        if (message.type === 'focusbridge:ai:save') return { results: message.ids.map((requestId) => ({ requestId, status: 'saved' })) };
        return { images: [], status: 'capture-disabled' };
      } } };
    }, pending === 'image preparation');
    await page.goto('https://example.com/first-log');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    if (pending === 'image preparation') {
      await page.waitForFunction(() => typeof window.releaseDecode === 'function');
      await page.evaluate(async () => { await flow.scan(); releaseDecode(); });
    }
    await page.waitForFunction(() => typeof releaseInference === 'function');
    assert.equal(await page.evaluate(() => aiTables.length), 0);

    if (pending === 'API response') await page.evaluate(async () => { await flow.scan(); });
    await page.evaluate(() => releaseInference());
    await page.waitForFunction(() => window.__focusBridge?.report.length === 2
      && __focusBridge.report.every((row) => row.aiReused === true && row.labelApplied)
      && aiTables.length > 0);
    const first = await page.evaluate(() => ({ tables: aiTables, requests: inferMessages.length,
      images: inferMessages[0].items.filter((item) => item.image).length,
      storage: __focusBridge.report.map((row) => row.aiStorage) }));
    assert.equal(first.requests, 1);
    assert.equal(first.images, 1);
    assert.deepEqual(first.storage, ['ineligible', 'ineligible']);
    assert.equal(first.tables.length, 1);
    assert.equal(first.tables[0].length, 1);
    assert.equal(first.tables[0][0].imageSource, 'svg');
    assert.equal(first.tables[0][0].reused, true);
    assert.equal(first.tables[0][0].requests, 1);
    assert.equal(first.tables[0][0].label, '포털 열기');

    await page.evaluate(async () => { await flow.scan(); });
    await page.waitForFunction(() => __focusBridge.report.every((row) => row.aiReused === true && row.labelApplied));
    assert.equal(await page.evaluate(() => aiTables.length), 1);
    assert.equal(await page.evaluate(() => inferMessages.length), 1);
  } finally { await browser.close(); }
}

for (const pending of ['image preparation', 'API response']) {
  test(`a newer scan reuses pending ${pending} and logs the image source once`, () => checkPendingReuse(pending));
}
