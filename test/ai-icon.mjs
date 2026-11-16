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
