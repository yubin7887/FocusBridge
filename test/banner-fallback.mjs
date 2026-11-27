// 사전 0.10.0: 배너는 AI 먼저, "배너 이미지 N"은 대신 쓸 이름(fallback)
// AI 응답 전에는 "배너 이미지 N"이 붙어 있고, AI가 쓸 만한 이름을 주면 그 이름으로 바뀌며,
// AI가 null이나 쓸 수 없는 이름("링크")을 주면 "배너 이미지 N"이 그대로 남는지 실제 브라우저에서 확인한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let passed = 0;
function check(title, value) { assert.ok(value, title); console.log('PASS', title); passed++; }

const bundle = await build({ stdin: { contents: "export { scan } from './src/content.js';", resolveDir: process.cwd() },
  bundle: true, format: 'iife', globalName: 'flow', write: false });
// 그림만 있고 옆 글자 없음 + 부모 class에 배너 단어(promo-banner) + 주소에 5자리 숫자 → 배너
const html = '<!doctype html><html lang="ko"><body><main><div class="promo-banner">'
  + '<a id="banner" href="/p/179723"><img src="/img/b1.png" alt="" width="120" height="90"></a>'
  + '</div></main></body></html>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  // aiLabel: AI가 돌려줄 이름. undefined면 확장 프로그램 밖처럼 AI가 아예 돌지 않는다(runtime.id 없음)
  const open = async (aiLabel) => {
    const page = await browser.newPage();
    await page.route('https://example.com/**', (route) => route.request().resourceType() === 'image'
      ? route.fulfill({ contentType: 'image/png', body: PNG })
      : route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript((aiLabel) => {
      window.inferred = 0;
      window.chrome = { runtime: { ...(aiLabel === undefined ? {} : { id: 'test-extension' }), sendMessage: async (message) => {
        if (message.type === 'focusbridge:previous:lookup') return { ok: true, records: [] };
        if (message.type === 'focusbridge:ai:infer') {
          inferred++;
          // AI 응답은 release()를 부를 때까지 붙잡아 둔다 (응답 전 상태를 확인하기 위해)
          await new Promise((resolve) => { window.release = resolve; });
          return { status: 'ok', model: 'test', httpStatus: 200, requestCount: inferred,
            results: message.items.map(({ payload }) => ({ requestId: payload.requestId, label: aiLabel })) };
        }
        if (message.type === 'focusbridge:ai:save') return { results: message.ids.map((requestId) => ({ requestId, status: 'saved' })) };
        return { images: [], status: 'capture-disabled' };
      } } };
    }, aiLabel);
    await page.goto('https://example.com/shop');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => window.__focusBridge?.report?.length === 1);
    return page;
  };
  const label = (page) => page.locator('#banner').getAttribute('aria-label');
  const answer = async (page) => {
    await page.waitForFunction(() => typeof window.release === 'function');
    await page.evaluate(() => window.release());
    await page.waitForFunction(() => window.__focusBridge?.report[0].aiStatus);
  };

  let page = await open('우리은행');
  const match = await page.evaluate(() => __focusBridge.report[0].match);
  check('배너는 판정 ai로 AI에 보내고 대신 쓸 이름은 "배너 이미지 1"',
    match.decision === 'ai' && match.pattern === 'BANNER' && match.label === null && match.fallback === '배너 이미지 1');
  check('AI 응답 전에는 "배너 이미지 1"을 먼저 붙임', await label(page) === '배너 이미지 1');
  await answer(page);
  check('AI가 이름을 주면 그 이름으로 바꿔 끼움', await label(page) === '우리은행'
    && await page.getByRole('link', { name: '우리은행', exact: true }).count() === 1);
  await page.close();

  page = await open(null);
  await answer(page);
  check('AI가 null이면 "배너 이미지 1" 유지', await label(page) === '배너 이미지 1'
    && await page.evaluate(() => __focusBridge.report[0].aiStatus) === 'no-label');
  await page.close();

  page = await open('링크');
  await answer(page);
  check('AI가 쓸 수 없는 이름("링크")을 주면 "배너 이미지 1" 유지', await label(page) === '배너 이미지 1'
    && await page.evaluate(() => __focusBridge.report[0].aiStorage) === 'not-applied');
  await page.close();

  page = await open(undefined);
  check('AI가 돌지 않는 환경(키 없음·file:// 등)에서도 "배너 이미지 1"', await label(page) === '배너 이미지 1'
    && await page.evaluate(() => window.inferred) === 0);
  await page.close();
} finally { await browser.close(); }
console.log(`\n${passed}/${passed} passed`);
