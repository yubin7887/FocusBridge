import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'focusbridge-ai-'));
const dir = path.join(tmp, 'extension');
const applyLabels = process.env.FOCUSBRIDGE_TEST_APPLY_LABELS === '1';
let browser;
try {
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'src'));
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  assert.ok(!manifest.host_permissions.includes('https://api.groq.com/*'));
  assert.ok(manifest.optional_host_permissions.includes('<all_urls>'));
  // Grant the optional host access to this test extension without a browser prompt.
  manifest.host_permissions.push('<all_urls>');
  delete manifest.optional_host_permissions;
  manifest.content_scripts[0].js.push('probe.js');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const file of ['dist/content.js', 'src/options.js', 'src/ai-settings.js', 'src/ai-config.js', 'options.html', 'options.css']) {
    await copyFile(file, path.join(dir, file));
  }
  const background = await readFile('dist/background.js', 'utf8');
  await writeFile(path.join(dir, 'dist/background.js'), `
    globalThis.requests = [];
    globalThis.captureCount = 0;
    const captureVisibleTab = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = (...args) => {
      globalThis.captureCount++;
      return captureVisibleTab(...args);
    };
    const originalNow = Date.now;
    Date.now = () => globalThis.aiTestNow ?? originalNow();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms) => {
      globalThis.requestTimeoutMs = ms;
      return originalTimeout(globalThis.simulateTimeout ? 1000 : ms);
    };
    globalThis.fetch = async (url, request) => {
      const raw = JSON.parse(request.body);
      const openai = url === 'https://api.openai.com/v1/responses';
      const parts = typeof raw.input === 'string' ? []
        : openai ? raw.input[0].content : raw.contents[0].parts;
      const inputs = JSON.parse(typeof raw.input === 'string' ? raw.input : parts[0].text);
      const images = parts.flatMap((part, i) => {
        const data = part.inlineData?.data || part.image_url?.split(',', 2)[1];
        return data ? [{ requestId: parts[i - 1].text.split(' ').at(-1), data }] : [];
      });
      const authorized = openai
        ? request.headers.Authorization === 'Bearer openai-test-key' && !request.headers['x-goog-api-key']
        : request.headers['x-goog-api-key'] === 'local-test-key' && !request.headers.Authorization;
      requests.push({ url, inputs, images, authorized, model: raw.model, reasoning: raw.reasoning?.effort,
        store: raw.store, format: raw.text?.format?.type, thinkingLevel: raw.generationConfig?.thinkingConfig?.thinkingLevel });
      if (globalThis.holdResponse) await new Promise((resolve) => { globalThis.releaseResponse = resolve; });
      if (globalThis.rejectRequest) return Response.json({
        error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] },
      }, { status: 429, headers: { 'Retry-After': '10' } });
      if (globalThis.unavailableRemaining > 0) {
        globalThis.unavailableRemaining--;
        return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
      }
      if (globalThis.simulateTimeout) {
        request.signal.throwIfAborted();
        await new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      }
      const results = inputs.map(({ requestId, attributes, destination, visual, page }) => {
        if (destination?.href === '#top') return { requestId, label: '맨 위로 이동' };
        if (page?.title === '무료 이미지 배경 지우기') {
          const label = visual?.pattern === 'checkerboard' ? '투명 배경 선택'
            : visual?.pattern === 'conic gradient' ? '배경 색상 선택'
            : visual?.backgroundColor === 'rgb(255, 255, 255)' ? '흰색 배경 선택' : null;
          return { requestId, label };
        }
        let label = openai ? 'GPT 회전 설정' : '회전 설정 열기';
        if (attributes?.['data-action'] === 'unknown') label = globalThis.returnUnusableLabel ? 'button' : null;
        return { requestId, label };
      });
      if (openai) return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ results }) }] }],
      });
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(results) }] } }] });
    };
  ` + background);
  await writeFile(path.join(dir, 'probe.js'), `
    const originalNow = Date.now;
    Date.now = () => Number(document.documentElement.dataset.aiTestNow) || originalNow();
    const output = document.createElement('pre');
    output.id = 'ai-test-report';
    output.hidden = true;
    output.dataset.fbIgnore = '';
    document.documentElement.append(output);
    setInterval(() => {
      const result = window.__focusBridge;
      output.textContent = JSON.stringify(result ? { report: result.report, aiStatus: result.aiStatus, scanId: result.scanId } : null);
    }, 50);
  `);
  browser = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionUrl = new URL(worker.url()).origin === 'null' ? worker.url().split('/').slice(0, 3).join('/') : new URL(worker.url()).origin;
  const settings = await browser.newPage();
  await settings.goto(extensionUrl + '/options.html');
  await settings.getByRole('status').filter({ hasText: '등록된 API 키가 없습니다.' }).waitFor();
  const modelSelect = settings.getByLabel('AI 모델');
  assert.deepEqual(await modelSelect.locator('option').allTextContents(),
    ['Gemini 3.5 Flash-Lite', 'Gemini 3.8 Flash', 'GPT-6 Luna', 'GPT-6.1 Terra', 'GPT-6.1 Sol']);
  assert.equal(await modelSelect.inputValue(), 'gemini-3.5-flash-lite');
  const page = await browser.newPage();
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>상품</title></head><body>
    <header><button id="lookup" class="search"></button>
    <button id="spin" data-action="quantumspin" aria-controls="panel"><svg><use href="#symbol-rotate"></use></svg></button>
    <button id="unknown" data-action="unknown"></button></header>
    <section id="panel" aria-label="회전 옵션"><input value="NEVER_SEND_PRIVATE_INPUT"><p>NEVER_SEND_PANEL_BODY</p></section>
    </body></html>`;
  await browser.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const read = (fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 15000 });
  const probe = (status, target = page) => target.waitForFunction((status) =>
    JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')?.aiStatus === status, status);
  const waitForStorage = (selector, status) => read(({ selector, status }) =>
    JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
      ?.report.some((item) => item.selector === selector && item.aiStorage === status), { selector, status });
  await page.goto('https://example.com/shop?token=DO_NOT_SEND');
  await probe('not-configured');
  assert.equal(await worker.evaluate(() => requests.length), 0);
  await settings.getByLabel('Gemini API 키').fill('local-test-key');
  await settings.getByRole('button', { name: '키 저장', exact: true }).click();
  await settings.getByRole('status').filter({ hasText: '키를 저장했습니다' }).waitFor();
  assert.equal(await settings.getByLabel('Gemini API 키').inputValue(), '');
  await worker.evaluate(() => { globalThis.returnUnusableLabel = true; });
  await page.reload();
  await probe('ok');
  const sent = await worker.evaluate(() => requests);
  assert.equal(sent.length, 1);
  assert.equal(await worker.evaluate(() => globalThis.requestTimeoutMs), 25000);
  assert.ok(sent[0].url.endsWith('/gemini-3.5-flash-lite:generateContent'));
  assert.equal(sent[0].thinkingLevel, 'MINIMAL');
  assert.equal(sent[0].authorized, true);
  const spin = sent[0].inputs.find((item) => item.attributes?.id === 'spin');
  assert.equal(spin.controls[0].name, '회전 옵션');
  assert.equal(sent[0].inputs.some((item) => item.attributes?.id === 'lookup'), false);
  assert.doesNotMatch(JSON.stringify(sent[0].inputs), /NEVER_SEND|DO_NOT_SEND|fingerprint|dictionaryCandidates/);
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.some((item) => item.match.source === 'ai' && item.match.label === '회전 설정 열기'));
  if (applyLabels) {
    await page.getByRole('button', { name: '회전 설정 열기', exact: true }).waitFor();
    const cdp = await browser.newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument');
    for (const [selector, expected] of [['#lookup', '검색'], ['#spin', '회전 설정 열기']]) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      assert.equal(nodes[0]?.name?.value, expected);
    }
    await cdp.detach();
    console.log('PASS Chromium 접근성 트리에 사전 및 Gemini 이름 적용');
  }
  const storeBundle = (await import('esbuild')).buildSync({
    stdin: { contents: 'export { createPreviousStore } from "./src/previous-store.js";', resolveDir: process.cwd() },
    bundle: true, format: 'iife', globalName: 'testStore', write: false,
  }).outputFiles[0].text;
  await worker.evaluate(storeBundle);
  const stored = async (url) => worker.evaluate(async (url) => {
    const store = testStore.createPreviousStore();
    try { return await store.lookupPage(url); } finally { await store.close(); }
  }, url);
  await waitForStorage('#spin', applyLabels ? 'saved' : 'not-applied');
  await waitForStorage('#unknown', 'not-applied');
  const { report } = JSON.parse(await page.locator('#ai-test-report').textContent());
  const rejected = report.find((item) => item.selector === '#unknown');
  assert.equal(rejected.match.label, 'button');
  assert.equal(rejected.labelApplied, false);
  assert.equal(await page.locator('#unknown').getAttribute('aria-label'), null);
  assert.deepEqual((await stored(page.url())).map(({ label }) => label), applyLabels ? ['회전 설정 열기'] : []);
  let scanId = JSON.parse(await page.locator('#ai-test-report').textContent()).scanId;
  for (const minutes of [2, 3]) {
    await page.evaluate((minutes) => { document.documentElement.dataset.aiTestNow = Date.now() + minutes * 60000; }, minutes);
    await read((previousScanId) => {
      const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
      return result?.scanId > previousScanId && result.aiStatus === 'ok';
    }, scanId);
    scanId = JSON.parse(await page.locator('#ai-test-report').textContent()).scanId;
  }
  assert.equal(await worker.evaluate(() => requests.length), 1);
  console.log('PASS 동일 요소 DOM 재검사에서 추가 API 요청 방지');
  await worker.evaluate(() => { globalThis.returnUnusableLabel = false; });
  if (applyLabels) {
    await page.reload();
    await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
      ?.report.some((item) => item.match.source === 'previous' && item.match.label === '회전 설정 열기'));
  }
  console.log('PASS 적용에 성공한 AI 이름만 IndexedDB에 저장');

  await worker.evaluate(() => { globalThis.holdResponse = true; });
  await page.goto('https://example.com/stale');
  for (let i = 0; i < 100 && !(await worker.evaluate(() => Boolean(globalThis.releaseResponse))); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(await worker.evaluate(() => Boolean(globalThis.releaseResponse)));
  await page.locator('#spin').evaluate((el) => { el.setAttribute('aria-label', '사이트가 제공한 이름'); });
  await worker.evaluate(() => { globalThis.holdResponse = false; globalThis.releaseResponse(); });
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.every((item) => item.selector !== '#spin'));
  assert.equal(await page.locator('#spin').getAttribute('aria-label'), '사이트가 제공한 이름');
  assert.deepEqual(await stored(page.url()), []);

  const rateLimitStart = await worker.evaluate(() => {
    globalThis.aiTestNow = Date.parse('2026-11-13T20:00:00Z');
    globalThis.rejectRequest = true;
    globalThis.holdResponse = true;
    globalThis.releaseResponse = null;
    return requests.length;
  });
  const otherPage = await browser.newPage();
  const logged = page.waitForEvent('console', { predicate: (message) => message.text() === '[FocusBridge AI] 응답 결과' });
  await Promise.all([page.goto('https://example.com/rate-limit'), otherPage.goto('https://example.com/rate-limit-other-tab')]);
  for (let i = 0; i < 100 && !(await worker.evaluate(() => Boolean(globalThis.releaseResponse))); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await worker.evaluate(() => { globalThis.holdResponse = false; globalThis.releaseResponse(); });
  await Promise.all([probe('rate-limited'), probe('rate-limited', otherPage)]);
  await logged;
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.some((item) => item.aiStatus === 'rate-limited' && item.aiHttpStatus === 429
      && item.aiModel === 'gemini-3.5-flash-lite' && item.aiRequestCount > 0));
  assert.equal(await worker.evaluate(() => requests.length), rateLimitStart + 1);
  assert.deepEqual(await stored(page.url()), []);
  await otherPage.close();
  const reset = Date.parse('2026-11-14T08:00:00Z');
  const storedReset = await worker.evaluate(async () => {
    const key = 'focusbridgeAiBlockedUntil:google';
    return (await chrome.storage.local.get(key))[key];
  });
  assert.equal(storedReset, reset);
  await worker.evaluate((reset) => { globalThis.rejectRequest = false; globalThis.aiTestNow = reset - 1; }, reset);
  await page.goto('https://example.com/before-quota-reset');
  await probe('rate-limited');
  assert.equal(await worker.evaluate(() => requests.length), rateLimitStart + 1);
  await worker.evaluate((reset) => { globalThis.aiTestNow = reset; }, reset);
  await page.goto('https://example.com/after-quota-reset');
  await probe('ok');
  assert.equal(await worker.evaluate(() => requests.length), rateLimitStart + 2);
  console.log('PASS 429 후 다른 탭 차단, 일일 초기화 시각 보관 및 초기화 후 재개');

  const unavailableStart = await worker.evaluate(() => { globalThis.unavailableRemaining = 2; return requests.length; });
  await page.goto('https://example.com/unavailable');
  await probe('service-unavailable');
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.some((item) => item.aiStatus === 'service-unavailable' && item.aiHttpStatus === 503));
  assert.equal(await worker.evaluate(() => requests.length), unavailableStart + 1);
  assert.deepEqual(await stored(page.url()), []);
  await page.goto('https://example.com/unavailable-during-cooldown');
  await probe('service-unavailable');
  assert.equal(await worker.evaluate(() => requests.length), unavailableStart + 1);
  await worker.evaluate(() => {
    globalThis.aiTestNow += 60000;
    globalThis.unavailableRemaining = 0;
    globalThis.simulateTimeout = true;
  });
  await page.goto('https://example.com/timeout');
  await probe('timeout');
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.some((item) => item.aiStatus === 'timeout' && item.aiHttpStatus === undefined && item.match.label === null));
  assert.equal(await worker.evaluate(() => requests.length), unavailableStart + 2);
  assert.deepEqual(await stored(page.url()), []);
  await worker.evaluate(() => { globalThis.simulateTimeout = false; });
  console.log('PASS 503 자동 재시도 중단, HTTP 상태 표시, Timeout 발생 시 저장 방지');

  // Changing providers keeps the first key and never forwards it to the other API.
  await worker.evaluate(() => chrome.storage.local.set({ aiProvider: 'openai' }));
  await settings.reload();
  await settings.getByLabel('GPT API 키').waitFor();
  assert.equal(await modelSelect.inputValue(), 'gpt-6-luna');
  const countBeforeGpt = await worker.evaluate(() => requests.length);
  await page.goto('https://example.com/gpt');
  await probe('not-configured');
  assert.equal(await worker.evaluate(() => requests.length), countBeforeGpt);
  await settings.getByLabel('GPT API 키').fill('openai-test-key');
  await settings.getByRole('button', { name: '키 저장', exact: true }).click();
  await settings.getByRole('status').filter({ hasText: '키를 저장했습니다' }).waitFor();
  await settings.reload();
  await settings.getByRole('status').filter({ hasText: 'API 키가 등록되어 있습니다.' }).waitFor();
  assert.equal(await modelSelect.inputValue(), 'gpt-6-luna');
  assert.equal(await settings.getByLabel('GPT API 키').inputValue(), '');
  await page.reload();
  await probe('ok');
  const gpt = await worker.evaluate(() => requests.find((item) => item.url === 'https://api.openai.com/v1/responses'));
  assert.equal(gpt.authorized, true);
  assert.equal(gpt.model, 'gpt-6-luna');
  assert.equal(gpt.reasoning, 'none');
  assert.equal(gpt.store, false);
  assert.equal(gpt.format, 'json_schema');
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.some((item) => item.match.source === 'ai' && item.match.label === 'GPT 회전 설정'));
  if (applyLabels) {
    await page.getByRole('button', { name: 'GPT 회전 설정', exact: true }).waitFor();
  }
  await waitForStorage('#spin', applyLabels ? 'saved' : 'not-applied');
  assert.deepEqual((await stored(page.url())).map(({ label }) => label), applyLabels ? ['GPT 회전 설정'] : []);

  for (const [model, reasoning] of [['gpt-6.1-terra', 'none'], ['gpt-6.1-sol', 'low']]) {
    await modelSelect.selectOption(model);
    await settings.waitForFunction(() => !document.querySelector('#ai-provider-select').disabled);
    await settings.getByRole('status').filter({ hasText: 'API 키가 등록되어 있습니다.' }).waitFor();
    await page.goto(`https://example.com/${model}`);
    await probe('ok');
    const request = await worker.evaluate(() => requests.at(-1));
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.model, model);
    assert.equal(request.reasoning, reasoning);
    assert.equal(request.authorized, true);
  }
  await settings.reload();
  await settings.getByRole('status').filter({ hasText: 'API 키가 등록되어 있습니다.' }).waitFor();
  assert.equal(await modelSelect.inputValue(), 'gpt-6.1-sol');

  await worker.evaluate(() => chrome.storage.local.set({ aiModel: 'openai/gpt-oss-20b' }));
  await settings.reload();
  await settings.getByLabel('Gemini API 키').waitFor();
  assert.equal(await modelSelect.inputValue(), 'gemini-3.5-flash-lite');
  await page.goto('https://example.com/removed-model');
  await probe('ok');
  assert.ok(await worker.evaluate(() => requests.at(-1).url.endsWith('/gemini-3.5-flash-lite:generateContent')));
  console.log('PASS 제거된 모델이 저장되어 있으면 기존 Gemini 키로 기본 모델 사용');

  await modelSelect.selectOption('gpt-6.1-sol');
  await settings.getByLabel('GPT API 키').waitFor();
  await settings.getByRole('status').filter({ hasText: 'API 키가 등록되어 있습니다.' }).waitFor();
  await settings.getByRole('button', { name: '등록한 키 삭제' }).click();
  await settings.getByRole('status').filter({ hasText: '키를 삭제했습니다' }).waitFor();
  await modelSelect.selectOption('gpt-6-luna');
  await settings.getByRole('status').filter({ hasText: '등록된 API 키가 없습니다.' }).waitFor();
  await page.goto('https://example.com/no-gpt-key');
  await probe('not-configured');
  await modelSelect.selectOption('gemini-3.8-flash');
  await settings.getByLabel('Gemini API 키').waitFor();
  await settings.getByRole('status').filter({ hasText: 'API 키가 등록되어 있습니다.' }).waitFor();
  await page.goto('https://example.com/gemini-again');
  await probe('ok');
  const last = await worker.evaluate(() => requests.at(-1));
  assert.ok(last.url.endsWith('/gemini-3.8-flash:generateContent'));
  assert.equal(last.thinkingLevel, 'LOW');
  assert.equal(last.authorized, true);

  console.log('PASS 모델 선택·호출 옵션·기존 설정 호환·키 공유와 분리');

  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
  const icons = `<!doctype html><html lang="ko"><head><style>
    button { margin: 12px; padding: 10px; }
    .glyph, i { display: block; width: 18px; height: 18px; }
    #glyph-a::before, #glyph-b::before { content: ''; display: block; width: 100%; height: 100%; }
    #glyph-a::before { background: rgb(12, 34, 56); mask-image: linear-gradient(black, black); }
    #glyph-b { color: transparent; background: rgb(87, 65, 43); }
    #offscreen { position: absolute; top: 300vh; }
    </style></head><body>
    <button id="shape"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/></svg></button>
    <button id="glyph-first"><span class="glyph" id="glyph-a"></span></button>
    <button id="glyph-second"><i id="glyph-b" aria-hidden="true">&#xE001;</i></button>
    <button id="bitmap"><img width="20" height="20" alt="" src="${pixel}"></button>
    <button id="offscreen"><span class="icon" style="display:block;width:20px;height:20px"></span></button>
    <a id="with-clue" href="#top"><svg aria-hidden="true" width="20" height="20"><circle cx="10" cy="10" r="7"/></svg></a>
    </body></html>`;
  await browser.route('https://example.com/icons-*', (route) => route.fulfill({ contentType: 'text/html', body: icons }));
  const inspectIcons = () => worker.evaluate(async () => {
    const { inputs, images } = requests.at(-1);
    return Promise.all(images.map(async ({ requestId, data }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(64, 64);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const { width, height } = image;
      image.close();
      return { id: inputs.find((row) => row.requestId === requestId)?.attributes.id, width, height,
        color: [...context.getImageData(32, 32, 1, 1).data] };
    }));
  });
  await page.bringToFront();
  await page.goto('https://example.com/icons-direct');
  await probe('ok');
  assert.deepEqual((await inspectIcons()).map(({ id, width, height }) => [id, width, height]),
    [['shape', 64, 64], ['bitmap', 64, 64], ['with-clue', 64, 64]]);
  assert.equal(await worker.evaluate(() => captureCount), 0);

  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: true }));
  await page.goto('https://example.com/icons-capture');
  await probe('ok');
  const captured = await inspectIcons();
  assert.deepEqual(captured.map(({ id }) => id), ['shape', 'glyph-first', 'glyph-second', 'bitmap', 'with-clue']);
  assert.deepEqual(captured.find(({ id }) => id === 'glyph-first').color, [12, 34, 56, 255]);
  assert.deepEqual(captured.find(({ id }) => id === 'glyph-second').color, [87, 65, 43, 255]);
  assert.equal(await worker.evaluate(() => captureCount), 1);

  await worker.evaluate(() => chrome.storage.local.set({ aiModel: 'gpt-6-luna', openAiApiKey: 'openai-test-key' }));
  await page.goto('https://example.com/icons-gpt');
  await probe('ok');
  assert.deepEqual((await inspectIcons()).map(({ id }) => id), captured.map(({ id }) => id));
  await worker.evaluate(() => chrome.storage.local.set({ aiModel: 'gemini-3.8-flash' }));
  console.log('PASS 직접 추출, 한 번 캡처한 아이콘의 픽셀, 모델별 이미지 입력');

  const batchIcons = Array.from({ length: 10 }, (_, index) =>
    `<button id="tile-${index}" style="width:32px;height:32px;background-color:rgb(${index * 20}, 40, 80)"></button>`);
  await browser.route('https://example.com/batch-images', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><style>body{display:flex;gap:12px}button{appearance:none;border:0}</style>' + batchIcons.join(''),
  }));
  const beforeBatchImages = await worker.evaluate(() => ({ calls: requests.length, captures: captureCount }));
  await page.goto('https://example.com/batch-images');
  await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
    ?.report.filter((item) => item.aiStatus === 'label-ready').length === 10);
  assert.deepEqual(await worker.evaluate(({ calls, captures }) => ({
    images: requests.slice(calls).map(({ inputs, images }) => images.map(({ requestId }) =>
      inputs.find((item) => item.requestId === requestId).attributes.id)),
    captures: captureCount - captures,
  }), beforeBatchImages), {
    images: [Array.from({ length: 8 }, (_, i) => `tile-${i}`), ['tile-8', 'tile-9']], captures: 2,
  });
  console.log('PASS 두 묶음에 걸쳐 추출한 이미지 10개 모두 첨부');

  const swatches = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>무료 이미지 배경 지우기</title><style>
    button { width: 40px; height: 40px; border: 1px solid black; border-radius: 50%; }
    .bg-damier-medium { background-image: repeating-conic-gradient(#ccc 0% 25%, white 0% 50%); background-size: 12px 12px; }
    .wheel { background-image: radial-gradient(white, transparent), conic-gradient(red, yellow, lime, blue, red); }
    </style></head><body><main><h1>무료 이미지 배경 지우기</h1>
    <button id="swatch-a" class="before:-top-px bg-damier-medium" style="background-color: white" aria-pressed="true"></button>
    <button id="swatch-b" class="before:-top-px" style="background-color: white" aria-pressed="false"></button>
    <button id="swatch-c" class="wheel" aria-haspopup="dialog" aria-expanded="false"></button>
    </main></body></html>`;
  await browser.route('https://example.com/swatches-*', (route) => route.fulfill({ contentType: 'text/html', body: swatches }));
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: false }));
  await page.goto('https://example.com/swatches-text');
  await probe('ok');
  const swatchEvidence = await worker.evaluate(() => requests.at(-1).inputs.map(({ attributes, visual }) => [attributes.id, visual]));
  assert.deepEqual(swatchEvidence, [
    ['swatch-a', { pattern: 'checkerboard' }],
    ['swatch-b', { backgroundColor: 'rgb(255, 255, 255)' }],
    ['swatch-c', { pattern: 'conic gradient' }],
  ]);
  assert.deepEqual(await inspectIcons(), []);
  if (applyLabels) {
    for (const name of ['투명 배경 선택', '흰색 배경 선택', '배경 색상 선택']) {
      await page.getByRole('button', { name, exact: true }).waitFor();
    }
  }
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: true }));
  await page.goto('https://example.com/swatches-capture');
  await probe('ok');
  assert.deepEqual((await inspectIcons()).map(({ id, width, height }) => [id, width, height]),
    ['swatch-a', 'swatch-b', 'swatch-c'].map((id) => [id, 64, 64]));
  console.log('PASS CSS 위치 클래스 오탐 방지 및 체크무늬·흰색·색상 원의 AI 단서 전달');

  if (applyLabels) {
    const storeLinks = '<section><a class="store-badge" href="/page/mlink?store=appstore"></a>'
      + '<a class="store-badge" href="/page/mlink?store=playstore"></a></section>';
    await browser.route('https://example.com/store-links', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="ko"><body>' + storeLinks + storeLinks + '</body></html>',
    }));
    const beforeLinks = await worker.evaluate(() => requests.length);
    await page.goto('https://example.com/store-links');
    const readLinks = async (previousScanId) => {
      const snapshot = await read((scanId) => {
        const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
        return result?.scanId > scanId && result.report.length === 4
          && result.report.every((item) => item.aiStorage === 'ineligible' && item.labelApplied) && result;
      }, previousScanId);
      return snapshot.jsonValue();
    };
    let linkScan = await readLinks(0);
    assert.equal(await worker.evaluate(() => requests.at(-1).inputs.length), 2);
    assert.equal(linkScan.report.filter((item) => item.aiReused).length, 2);
    for (let pass = 0; pass < 2; pass++) {
      // Replace both sets of anchors as a page framework would during a re-render.
      await page.evaluate((html) => {
        for (const section of document.querySelectorAll('section')) section.outerHTML = html;
      }, storeLinks);
      linkScan = await readLinks(linkScan.scanId);
      assert.ok(linkScan.report.every((item) => item.aiReused));
      assert.equal(await worker.evaluate(() => requests.length), beforeLinks + 1);
    }
    await page.locator('a[href$="appstore"]').evaluateAll((links) => {
      for (const link of links) link.href = '/page/mlink?store=appstore-changed';
    });
    await readLinks(linkScan.scanId);
    assert.equal(await worker.evaluate(() => requests.length), beforeLinks + 2);
    const newInputs = await worker.evaluate(() => requests.at(-1).inputs);
    assert.equal(newInputs.length, 1);
    assert.equal(newInputs[0].destination.href, '/page/mlink');
    assert.deepEqual(await stored(page.url()), []);
    console.log('PASS 같은 중복 링크는 재생성 뒤에도 AI 결과 재사용, 변경된 목적지만 새 요청');

    await browser.route('https://example.com/widget-reflow', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><div class="header-stack"><header><a id="brand-mark" href="/ko">
        <svg><path d="M1 1h4"/></svg></a></header></div><div><main><div class="samples">
        <button id="sample-1"><img alt="" src="/sample-1.webp"></button>
        <button id="sample-2"><img alt="" src="/sample-2.webp"></button></div></main></div>`,
    }));
    const beforeWidgets = await worker.evaluate(() => requests.length);
    await page.goto('https://example.com/widget-reflow');
    for (const id of ['#brand-mark', '#sample-1', '#sample-2']) await waitForStorage(id, 'saved');
    const firstRecords = await stored(page.url());
    assert.equal(firstRecords.length, 3);
    for (const id of ['consent-host', 'popup-host']) {
      const scanId = JSON.parse(await page.locator('#ai-test-report').textContent()).scanId;
      await page.evaluate((id) => document.body.prepend(Object.assign(document.createElement('div'), { id })), id);
      await read((previousScanId) => {
        const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
        return result?.scanId > previousScanId && result.report.length === 3 && result.report.every((item) =>
          item.match.source === 'previous' && item.labelApplied);
      }, scanId);
      assert.equal(await worker.evaluate(() => requests.length), beforeWidgets + 1);
      assert.deepEqual(await stored(page.url()), firstRecords);
    }
    console.log('PASS 최상위 위젯 삽입 후에도 링크와 샘플 라벨을 재사용하고 DB 중복 방지');
    for (const disabled of [true, false]) {
      const scanId = JSON.parse(await page.locator('#ai-test-report').textContent()).scanId;
      await page.locator('.samples button').evaluateAll((buttons, disabled) => {
        for (const button of buttons) {
          button.disabled = disabled;
          button.classList.toggle('opacity-50', disabled);
          if (!button.className) button.removeAttribute('class');
        }
      }, disabled);
      await read((previousScanId) => {
        const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
        return result?.scanId > previousScanId && result.report.length === 3 && result.report.every((item) =>
          item.match.source === 'previous' && item.labelApplied);
      }, scanId);
      assert.equal(await worker.evaluate(() => requests.length), beforeWidgets + 1);
      assert.deepEqual(await stored(page.url()), firstRecords);
    }
    console.log('PASS 샘플 이미지 처리 중 비활성화와 복귀 후에도 DB 기록 수 및 요청 횟수 유지');

    await browser.route('https://example.com/sticky-menu', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="ko"><body class="coursemos-coursepage-main coursemos-headroom-pin" style="min-height:250vh">
        <header id="site-header" class="fixed-top headroom headroom--pinned headroom--top headroom--not-bottom" style="position:sticky;top:0">
          <button id="toggle" class="navbar-toggler"><svg aria-hidden="true" width="16" height="16"><path d="M0 2h16 M0 8h16 M0 14h16"/></svg></button>
        </header>
        <script>
          let previousScroll = 0;
          addEventListener('scroll', () => {
            const pinned = scrollY <= previousScroll;
            document.body.className = 'coursemos-coursepage-main ' + (pinned ? 'coursemos-headroom-pin' : 'coursemos-headroom-unpin');
            document.querySelector('header').className = 'headroom headroom--not-bottom '
              + (pinned ? 'headroom--pinned ' : 'headroom--unpinned ')
              + (scrollY === 0 ? 'headroom--top' : 'headroom--not-top');
            previousScroll = scrollY;
          });
        </script>
        </body></html>`,
    }));
    const beforeMenu = await worker.evaluate(() => requests.length);
    await page.goto('https://example.com/sticky-menu');
    await waitForStorage('#toggle', 'saved');
    for (const scrollTop of [500, 250, 0, 800]) {
      const scanId = JSON.parse(await page.locator('#ai-test-report').textContent()).scanId;
      await page.evaluate((top) => scrollTo(0, top), scrollTop);
      await read((previousScanId) => {
        const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
        return result?.scanId > previousScanId && result.report.some((item) => item.selector === '#toggle'
          && item.match.source === 'previous' && item.labelApplied);
      }, scanId);
      assert.equal(await worker.evaluate(() => requests.length), beforeMenu + 1);
      assert.equal((await stored(page.url())).length, 1);
    }
    console.log('PASS 스크롤 재검사에서 같은 메뉴 이름 재사용 및 AI 요청·DB 저장 횟수 유지');

    await browser.route('https://example.com/fragment-link', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="ko"><body><footer><a id="fragment-link" href="#top"></a></footer></body></html>',
    }));
    await page.goto('https://example.com/fragment-link');
    await waitForStorage('#fragment-link', 'saved');
    const topLink = page.getByRole('link', { name: '맨 위로 이동', exact: true });
    await topLink.waitFor({ state: 'attached' });
    assert.deepEqual((await stored(page.url())).map(({ label }) => label), ['맨 위로 이동']);
    const countBeforeRevisit = await worker.evaluate(() => requests.length);
    await page.reload();
    await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
      ?.report.some((item) => item.selector === '#fragment-link' && item.match.source === 'previous'));
    await topLink.waitFor({ state: 'attached' });
    assert.equal(await worker.evaluate(() => requests.length), countBeforeRevisit);
    console.log('PASS #top 링크에 AI 이름 적용 및 IndexedDB 저장 후 재방문에서 재사용');
  }
} finally {
  try { await browser?.close(); }
  finally {
    if (path.dirname(path.resolve(tmp)) === path.resolve(os.tmpdir()) && path.basename(tmp).startsWith('focusbridge-ai-')) {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
