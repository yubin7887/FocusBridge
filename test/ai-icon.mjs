import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('a visible PNG still loading during the scan is attached after decoding', async () => {
  const bundle = await build({
    stdin: { contents: "export { collectAiIcons } from './src/ai-icon.js';", resolveDir: process.cwd() },
    bundle: true, format: 'iife', globalName: 'icons', write: false,
  });
  const browser = await chromium.launch(process.env.CHROME
    ? { executablePath: process.env.CHROME } : { channel: 'chromium' });
  try {
    const page = await browser.newPage();
    let holdImage;
    const imageRequest = new Promise((resolve) => { holdImage = resolve; });
    await page.route('https://example.test/keyboard.png', holdImage);
    await page.route('https://example.test/demo', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><button><img src="/keyboard.png" width="20" height="20" alt=""></button>',
    }));
    await page.goto('https://example.test/demo', { waitUntil: 'domcontentloaded' });
    const pngRoute = await imageRequest;
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    await page.exposeFunction('finishFixtureImage', () => pngRoute.fulfill({ contentType: 'image/png', body: pixel }));
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const { startedUnloaded, icon } = await page.evaluate(async () => {
      const element = document.querySelector('button');
      const startedUnloaded = !element.querySelector('img').complete;
      const pending = icons.collectAiIcons([{ element, request: { payload: { requestId: 'keyboard' } } }]);
      await window.finishFixtureImage();
      const { images } = await pending;
      return { startedUnloaded, icon: images.get('keyboard')?.() };
    });
    assert.equal(startedUnloaded, true);
    assert.equal(icon.source, 'img');
    assert.match(icon.data, /^iVBORw0KGgo/);
    const bytes = Buffer.from(icon.data, 'base64');
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [64, 64]);
  } finally {
    await browser.close();
  }
});

for (const workerLoaded of [true, false]) {
  test(workerLoaded ? 'a worker image skips the redundant anonymous-CORS request'
    : 'anonymous-CORS image extraction still works when worker host access is unavailable', async () => {
    const bundle = await build({
      stdin: { contents: "export { collectAiIcons } from './src/ai-icon.js';", resolveDir: process.cwd() },
      bundle: true, format: 'iife', globalName: 'icons', write: false,
    });
    const browser = await chromium.launch(process.env.CHROME
      ? { executablePath: process.env.CHROME } : { channel: 'chromium' });
    try {
      const page = await browser.newPage();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
      let corsRequests = 0;
      await page.route('https://images.example.test/icon.png', (route) => {
        if (route.request().headers().origin) corsRequests++;
        return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'),
          headers: { 'access-control-allow-origin': workerLoaded ? 'https://elsewhere.test' : '*' } });
      });
      await page.route('https://example.test/demo', (route) => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button><img src="https://images.example.test/icon.png" width="20" height="20" alt=""></button>',
      }));
      await page.goto('https://example.test/demo');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const result = await page.evaluate(async ({ workerLoaded, png }) => {
        let loads = 0;
        const { images } = await icons.collectAiIcons([{ element: document.querySelector('button'),
          request: { payload: { requestId: 'external' } } }], undefined, async (sources) => {
          loads++;
          return { images: workerLoaded ? [{ requestId: sources[0].requestId, data: png }] : [] };
        });
        return { loads, icon: images.get('external')?.() };
      }, { workerLoaded, png });
      assert.equal(result.loads, 1);
      assert.equal(result.icon.source, 'img');
      assert.equal(corsRequests, workerLoaded ? 0 : 1);
    } finally { await browser.close(); }
  });
}
