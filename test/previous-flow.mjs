import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createPreviousLookup, matchPrevious } from '../src/previous-matcher.js';

let passed = 0;
function check(title, value) { assert.ok(value, title); console.log('PASS', title); passed++; }
const fp = { eligible: true, pageKey: 'https://example.com/shop', version: 2, canonical: 'snapshot' };
const record = { pageKey: fp.pageKey, fingerprintVersion: 2, fingerprintCanonical: fp.canonical,
  status: 'active', source: 'ai', label: '상품 검색', expiresAt: 100 };
check('원본 정확 일치 기록 재사용', matchPrevious(fp, [record], 99)?.source === 'previous');
check('기존 verification 메타데이터는 판정에 사용하지 않음',
  matchPrevious(fp, [{ ...record, verification: { status: 'pending' } }], 99)?.source === 'previous');
check('만료 경계에서 재사용 거부', !matchPrevious(fp, [record], 100));
check('중복 기록 재사용 거부', !matchPrevious(fp, [record, record], 99));
check('충돌 기록 재사용 거부', !matchPrevious(fp, [{ ...record, status: 'conflict' }], 99));
check('다른 원본 재사용 거부', !matchPrevious(fp, [{ ...record, fingerprintCanonical: 'other' }], 99));
check('API 없는 환경에서도 실패 응답', (await createPreviousLookup({ runtime: {} })(fp.pageKey)).status === 'unavailable');
check('통신 오류를 실패로 반환', (await createPreviousLookup({ runtime: { sendMessage: () => { throw Error(); } } })(fp.pageKey)).status === 'error');
check('응답 없는 조회는 제한 시간 후 종료', (await createPreviousLookup({ runtime: { sendMessage: () => new Promise(() => {}) }, timeoutMs: 10 })(fp.pageKey)).status === 'timeout');
let resolveLookup, calls = 0;
const lookup = createPreviousLookup({ runtime: { sendMessage: () => { calls++; return new Promise((resolve) => { resolveLookup = resolve; }); } } });
const a = lookup(fp.pageKey), b = lookup(fp.pageKey);
await Promise.resolve();
resolveLookup({ ok: true, records: [] });
await Promise.all([a, b]);
check('진행 중 같은 페이지 조회 공유', calls === 1 && a === b);

const bundle = await build({ stdin: { contents: `export * from './src/content.js';
  export * from './src/previous-fingerprint.js';`, resolveDir: process.cwd() },
  bundle: true, format: 'iife', globalName: 'flow', write: false });
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const page = await browser.newPage();
  const fixture = '<header id="header"><button id="search" class="search" data-action="search"></button></header>';
  await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.addInitScript(() => {
    window.requests = [];
    window.chrome = { runtime: { sendMessage: (message) => new Promise((resolve, reject) => requests.push({ message, resolve, reject })) } };
  });
  const start = async (html) => {
    await page.goto(fp.pageKey);
    if (html) await page.evaluate((value) => { document.body.innerHTML = value; }, html);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => requests.length === 1);
  };
  const finish = async (stored = false) => {
    await page.evaluate((stored) => {
      const fingerprint = flow.createFingerprint(document.querySelector('button'));
      const record = { pageKey: fingerprint.pageKey, fingerprintVersion: fingerprint.version,
        fingerprintCanonical: fingerprint.canonical, status: 'active', source: 'ai',
        label: '상품 검색', expiresAt: Date.now() + 60000 };
      requests.shift().resolve({ ok: true, records: stored ? [record] : [] });
    }, stored);
    await page.waitForFunction(() => window.__focusBridge?.report);
    return page.evaluate(() => __focusBridge.report);
  };
  await start();
  check('기록 없는 첫 방문은 사전 매칭', (await finish())[0].match.label === '검색');
  await start();
  const previous = await finish(true);
  check('이전 매칭이 사전 결과보다 우선', previous[0].match.label === '상품 검색' && previous[0].match.source === 'previous');
  check('이전 기록 이름을 실제 버튼에 적용', await page.getByRole('button', { name: '상품 검색', exact: true }).count() === 1);
  await start();
  await page.evaluate(() => requests.shift().reject(Error('DB failure')));
  await page.waitForFunction(() => window.__focusBridge?.report);
  check('조회 오류에도 사전 매칭 실행', (await page.evaluate(() => __focusBridge.report[0].match.label)) === '검색');
  await start();
  await page.waitForFunction(() => window.__focusBridge?.previousStatus === 'timeout');
  check('조회 시간 초과에도 사전 매칭 실행', (await page.evaluate(() => __focusBridge.report[0].match.label)) === '검색');
  await start();
  await page.evaluate(() => { document.querySelector('button').setAttribute('aria-label', '정상 이름'); requests.shift().resolve({ ok: true, records: [] }); });
  await page.waitForFunction(() => window.__focusBridge?.report.length === 0);
  check('조회 중 정상 이름이 생긴 요소는 결과에서 제외', await page.locator('button').getAttribute('aria-label') === '정상 이름');
  await start();
  await page.evaluate(() => { document.querySelector('button').remove(); requests.shift().resolve({ ok: true, records: [] }); });
  await page.waitForFunction(() => window.__focusBridge?.report.length === 0);
  check('조회 중 제거된 요소의 결과 폐기', true);
  await start();
  await page.evaluate(() => {
    window.oldRequest = requests.shift();
    history.pushState(null, '', '/other');
  });
  await page.waitForFunction(() => requests.length === 1 && requests[0].message.pageKey.endsWith('/other'));
  await finish();
  const currentId = await page.evaluate(() => __focusBridge.scanId);
  await page.evaluate(() => oldRequest.resolve({ ok: true, records: [] }));
  check('SPA 전환 후 늦은 이전 응답이 최신 결과를 덮어쓰지 않음', await page.evaluate((id) => __focusBridge.scanId === id && __focusBridge.pageUrl.endsWith('/other'), currentId));
  await start('<header id="header"><button id="a" class="next" data-action="a"></button><button id="b" class="next" data-action="b"></button><button id="c" data-action="c"></button><button id="d" data-action="d"></button></header>');
  const common = await finish(true);
  check('이전 매칭 성공 항목을 포함한 전체 공통 단어 기준 유지', common[0].match.source === 'previous' && common[1].match.decision === 'ai');
  await start();
  await finish();
  await page.evaluate(() => { document.querySelector('button').className = 'close'; document.querySelector('button').setAttribute('data-action', 'close'); });
  await page.waitForFunction(() => requests.length === 1);
  check('class 변경 후 다시 탐지·매칭', (await finish())[0].match.label === '닫기');
  check('페이지가 바뀌면 확장이 부여한 이름도 갱신', await page.getByRole('button', { name: '닫기', exact: true }).count() === 1);
  await page.locator('button').evaluate((el) => el.setAttribute('aria-label', '사이트 검색'));
  await page.waitForFunction(() => window.__focusBridge?.report.length === 0);
  check('사이트가 직접 지정한 새 이름은 유지', await page.getByRole('button', { name: '사이트 검색', exact: true }).count() === 1);
  await start('<header id="header"><span id="old" hidden>버튼</span><button id="search" class="search" data-action="search" aria-labelledby="old"></button></header>');
  await finish();
  check('의미 없는 aria-labelledby보다 복구 이름을 적용', await page.getByRole('button', { name: '검색', exact: true }).count() === 1);
  await page.locator('#old').evaluate((el) => { el.textContent = '상품 찾기'; });
  await page.waitForFunction(() => window.__focusBridge?.report.length === 0);
  check('원래 참조가 의미 있는 이름을 제공하면 복원', await page.getByRole('button', { name: '상품 찾기', exact: true }).count() === 1
    && await page.locator('button').getAttribute('aria-labelledby') === 'old');
  await start();
  await page.evaluate(() => {
    window.latest = flow.scan(); // 같은 페이지의 진행 중 조회 공유
    requests.shift().resolve({ ok: true, records: [] });
  });
  await page.waitForFunction(() => window.__focusBridge?.report);
  check('동일 페이지 연속 검사에서 최신 검사만 게시', await page.evaluate(async () => (await latest).scanId === __focusBridge.scanId));
  await start();
  await finish();
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'shadow-host'; document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<header id="shadow-header"><button class="close" data-action="close"></button></header>';
  });
  await page.waitForFunction(() => requests.length === 1);
  check('새 열린 Shadow DOM도 탐지·매칭', (await finish()).some((r) => r.selector.includes('::shadow') && r.match.label === '닫기'));
  await page.evaluate(() => {
    const button = document.getElementById('shadow-host').shadowRoot.querySelector('button');
    button.className = 'search'; button.setAttribute('data-action', 'search');
  });
  await page.waitForFunction(() => requests.length === 1);
  check('Shadow DOM 내부 속성 변경도 재검사', (await finish()).some((r) => r.selector.includes('::shadow') && r.match.label === '검색'));
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.id = 'test-frame';
    frame.srcdoc = '<button class="search" data-action="search"></button>';
    document.body.append(frame);
  });
  await page.waitForFunction(() => document.getElementById('test-frame').contentDocument?.querySelector('button'));
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.addScriptTag({ content: bundle.outputFiles[0].text });
  await frame.waitForFunction(() => window.__focusBridge?.report);
  check('iframe은 이전 매칭 없이 기존 사전 매칭 유지', await frame.evaluate(() => __focusBridge.previousStatus === 'skipped'
    && __focusBridge.report[0].match.label === '검색' && requests.length === 0));
} finally { await browser.close(); }
console.log(`\n${passed}/${passed} passed`);
