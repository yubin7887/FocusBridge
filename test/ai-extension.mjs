import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'focusbridge-ai-'));
const dir = path.join(tmp, 'extension');
const applyLabels = process.env.FOCUSBRIDGE_TEST_APPLY_LABELS === '1';
let browser;
let imageServer;
try {
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'src'));
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.ok(manifest.host_permissions.includes('https://api.groq.com/*'));
  assert.ok(manifest.optional_host_permissions.includes('<all_urls>'));
  // Grant the optional host access to this test extension without a browser prompt.
  manifest.host_permissions.push('<all_urls>');
  delete manifest.optional_host_permissions;
  manifest.content_scripts[0].js.push('probe.js');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const file of ['src/options.js', 'src/ai-settings.js', 'src/ai-config.js', 'options.html', 'options.css']) {
    await copyFile(file, path.join(dir, file));
  }
  const content = await readFile('dist/content.js', 'utf8');
  await writeFile(path.join(dir, 'dist/content.js'), `
    if (location.pathname === '/retry-text-only') {
      const setTimer = globalThis.setTimeout.bind(globalThis);
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay < 55000) return setTimer(callback, delay, ...args);
        const output = document.getElementById('ai-test-report');
        output.dataset.retryDelay = delay;
        output.dataset.retryTimers = Number(output.dataset.retryTimers || 0) + 1;
        document.addEventListener('test-ai-fire-retry', () => callback(...args), { once: true });
        return 0;
      };
    }
  ` + content);
  const background = await readFile('dist/background.js', 'utf8');
  await writeFile(path.join(dir, 'dist/background.js'), `
    globalThis.requests = [];
    globalThis.captureCount = 0;
    globalThis.imageStatusLog = [];
    const addMessageListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener = (listener) => addMessageListener((message, sender, respond) => {
      if (globalThis.simulateStaleNotionSender && sender.url?.startsWith('https://app.notion.com/')) {
        sender = { ...sender, url: 'https://www.notion.so/', documentLifecycle: 'cached' };
      }
      return listener(message, sender, respond);
    });
    const info = console.info.bind(console);
    console.info = (...args) => {
      if (args[0] === '[FocusBridge AI] API 요청') imageStatusLog.push(args[1].imageStatus);
      info(...args);
    };
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
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (url, request) => {
      if (!request?.body) return nativeFetch(url, request);
      const raw = JSON.parse(request.body);
      const openai = url === 'https://api.openai.com/v1/responses';
      const groq = url === 'https://api.groq.com/openai/v1/chat/completions';
      const input = groq ? raw.messages[1].content
        : openai ? (typeof raw.input === 'string' ? raw.input : raw.input[0].content) : raw.contents[0].parts;
      const parts = typeof input === 'string' ? [] : input;
      const inputs = JSON.parse(typeof input === 'string' ? input : parts[0].text);
      const images = parts.flatMap((part, i) => {
        const imageUrl = groq ? part.image_url?.url : part.image_url;
        const data = part.inlineData?.data || imageUrl?.split(',', 2)[1];
        if (!data) return [];
        const reference = parts[i - 1].text;
        const sheetPrefix = 'Match each numbered icon tile to its element using this mapping. ';
        return [reference.startsWith(sheetPrefix)
          ? { tiles: JSON.parse(reference.slice(sheetPrefix.length)), data }
          : { requestId: reference.split(' ').at(-1), data }];
      });
      const authorized = groq ? request.headers.Authorization === 'Bearer local-groq-test-key' && !request.headers['x-goog-api-key'] : openai
        ? request.headers.Authorization === 'Bearer openai-test-key' && !request.headers['x-goog-api-key']
        : request.headers['x-goog-api-key'] === 'local-test-key' && !request.headers.Authorization;
      requests.push({ url, inputs, images, authorized, imageDetails: parts.flatMap((part) => part.detail ? [part.detail] : []),
        model: raw.model, reasoning: raw.reasoning?.effort,
        store: raw.store, format: raw.text?.format?.type, thinkingLevel: raw.generationConfig?.thinkingConfig?.thinkingLevel });
      if (globalThis.holdResponse) await new Promise((resolve) => { globalThis.releaseResponse = resolve; });
      if (globalThis.rejectRequest) return Response.json({
        error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] },
      }, { status: 429, headers: { 'Retry-After': '10' } });
      if (globalThis.unavailableRemaining > 0) {
        globalThis.unavailableRemaining--;
        return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
      }
      if (images.length > globalThis.maxWorkingImages) {
        return new Response(null, { status: 503, headers: { 'Retry-After': '75' } });
      }
      if (globalThis.simulateTimeout) {
        request.signal.throwIfAborted();
        await new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      }
      const results = inputs.map(({ requestId, attributes, destination, visual, page }) => {
        if (destination?.href === '#top') return { requestId, label: '맨 위로 이동' };
        if (page?.title === 'YouTube 키보드 테스트') return { requestId, label: '가상 키보드' };
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
      if (groq) return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }],
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
    const output = document.createElement('pre');
    Date.now = () => Number(output.dataset.now || document.documentElement.dataset.aiTestNow) || originalNow();
    output.id = 'ai-test-report';
    output.hidden = true;
    output.dataset.fbIgnore = '';
    document.documentElement.append(output);
    setInterval(() => {
      const result = window.__focusBridge;
      output.textContent = JSON.stringify(result ? { report: result.report, aiStatus: result.aiStatus, scanId: result.scanId,
        pageUrl: result.pageUrl, previousStatus: result.previousStatus } : null);
    }, 50);
    document.addEventListener('test-spa-message', async () => {
      output.dataset.reply = JSON.stringify(await chrome.runtime.sendMessage(JSON.parse(output.dataset.message)));
    });
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
    ['Gemini 3.5 Flash-Lite', 'Gemini 3.8 Flash', 'GPT-6 Luna', 'GPT-6.1 Terra', 'GPT-6.1 Sol', 'Qwen 3.8 27B (Groq)']);
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
  await modelSelect.selectOption('qwen/qwen3.8-27b');
  await settings.getByLabel('Groq API 키').fill('local-groq-test-key');
  await settings.getByRole('button', { name: '키 저장', exact: true }).click();
  await settings.getByRole('status').filter({ hasText: '키를 저장했습니다' }).waitFor();
  await browser.route('https://example.com/groq-preview', (route) => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="ko"><button id="groq-sample"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/></svg></button></html>',
  }));
  await page.goto('https://example.com/groq-preview');
  await probe('ok');
  if (applyLabels) await page.getByRole('button', { name: '회전 설정 열기', exact: true }).waitFor();
  const groqRequest = await worker.evaluate(() => requests.at(-1));
  assert.equal(groqRequest.model, 'qwen/qwen3.8-27b');
  assert.equal(groqRequest.authorized, true);
  assert.equal(groqRequest.images.length, 1);
  assert.equal(groqRequest.images[0].requestId, groqRequest.inputs[0].requestId);
  console.log('PASS Groq 모델 선택, 아이콘 전송, 모의 응답 적용');
  await worker.evaluate(async () => {
    await chrome.storage.local.remove(['aiModel', 'groqApiKey']);
    requests.length = 0;
  });
  await settings.reload();
  await settings.getByLabel('Gemini API 키').waitFor();

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
  await probe('ok');

  await browser.route('https://www.nexon.com/Home/Game*', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ko"><header><button id="spa-control" data-action="quantumspin">'
      + '<i style="display:block;width:20px;height:20px;color:transparent;background:rgb(12,34,56)">&#xE001;</i>'
      + '</button></header></html>',
  }));
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: true }));
  await page.bringToFront();
  const beforeSpa = await worker.evaluate(() => requests.length);
  await page.goto('https://www.nexon.com/Home/Game');
  const readSpa = (source) => read((source) => {
    const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
    return result?.pageUrl === location.href && result.previousStatus === 'ok'
      && result.report.some((item) => item.selector === '#spa-control' && item.match.source === source);
  }, source);
  await readSpa('ai');
  await waitForStorage('#spa-control', applyLabels ? 'saved' : 'not-applied');
  const initialDocument = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    return chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
  });
  const spaUrls = [page.url()];
  for (const [method, url] of [['hash', '#today'], ['pushState', '/Home/Game/next?panel=2#today'],
    ['replaceState', '/Home/Game/next?panel=3#today']]) {
    await page.evaluate(([method, url]) => {
      if (method === 'hash') location.hash = url;
      else history[method]({}, '', url);
    }, [method, url]);
    await readSpa('ai');
    await waitForStorage('#spa-control', applyLabels ? 'saved' : 'not-applied');
    spaUrls.push(page.url());
  }
  const spaRequests = await worker.evaluate((start) => requests.slice(start), beforeSpa);
  assert.equal(spaRequests.length, 4);
  assert.ok(spaRequests.every(({ images }) => images.length === 1));
  for (const url of spaUrls) assert.equal((await stored(url)).length, applyLabels ? 1 : 0);
  const currentDocument = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    return chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
  });
  assert.equal(currentDocument.documentId, initialDocument.documentId);
  assert.equal(currentDocument.url, page.url());
  console.log('PASS 넥슨 형식 URL의 해시·경로·쿼리 변경 후 이전 조회, 캡처, AI 추론 및 URL별 저장');

  for (const type of ['focusbridge:previous:lookup', 'focusbridge:ai:infer', 'focusbridge:ai:save', 'focusbridge:ai:capture-icons', 'focusbridge:ai:load-images']) {
    await page.evaluate((message) => {
      const output = document.querySelector('#ai-test-report');
      delete output.dataset.reply;
      output.dataset.message = JSON.stringify(message);
      document.dispatchEvent(new Event('test-spa-message'));
    }, { type, pageKey: spaUrls[0], items: [], ids: [] });
    await read(() => document.querySelector('#ai-test-report')?.dataset.reply);
    const reply = JSON.parse(await page.locator('#ai-test-report').getAttribute('data-reply'));
    assert.equal(reply.error ?? reply.status, 'invalid-request');
  }
  assert.equal(await worker.evaluate(() => requests.length), beforeSpa + 4);
  if (applyLabels) {
    await page.evaluate((url) => history.replaceState({}, '', url), spaUrls[1]);
    await readSpa('previous');
    assert.equal(await worker.evaluate(() => requests.length), beforeSpa + 4);
    await page.getByRole('button', { name: '회전 설정 열기', exact: true }).waitFor();
  }
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ iconCaptureEnabled: false });
    captureCount = 0;
  });
  console.log('PASS 현재 URL과 다른 페이지를 사칭한 조회·추론·저장·캡처 거부 및 원래 URL 복귀 시 hit');

  await browser.route('https://app.notion.com/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ko"><main><div id="notion-toolbar">'
      + Array.from({ length: 3 }, (_, index) => '<div role="button" tabindex="0" id="notion-control-' + index
        + '" data-action="quantumspin" style="display:inline-block;margin:8px;width:32px;height:32px">'
        + '<i style="display:block;width:20px;height:20px;color:transparent;background:rgb(12,34,56)">&#xE001;</i></div>').join('')
      + '</div></main></html>',
  }));
  await worker.evaluate(async () => {
    globalThis.simulateStaleNotionSender = true;
    await chrome.storage.local.set({ iconCaptureEnabled: true });
  });
  const beforeNotion = await worker.evaluate(() => requests.length);
  const notionUrls = [
    'https://app.notion.com/p/' + 'a'.repeat(32),
    'https://app.notion.com/p/' + 'b'.repeat(32) + '?view=board',
    'https://app.notion.com/p/' + 'c'.repeat(32) + '?view=list#toolbar',
  ];
  await page.goto(notionUrls[0]);
  await page.bringToFront();
  const readNotion = async (source) => {
    await read((source) => {
      const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
      return result?.pageUrl === location.href && result.previousStatus === 'ok' && result.report.length === 3
        && result.report.every((item) => item.match.source === source
          && (source !== 'ai' || item.aiStorage === (item.labelApplied ? 'saved' : 'not-applied')));
    }, source);
  };
  await readNotion('ai');
  await page.evaluate((url) => history.pushState({}, '', url), notionUrls[1]);
  await readNotion('ai');
  await page.evaluate((url) => history.replaceState({}, '', url), notionUrls[2]);
  await readNotion('ai');
  const notionRequests = await worker.evaluate((start) => requests.slice(start), beforeNotion);
  assert.equal(notionRequests.length, 3);
  assert.ok(notionRequests.every(({ inputs, images }) => inputs.length === 3 && images.length === 1));
  for (const url of notionUrls) assert.equal((await stored(url)).length, applyLabels ? 3 : 0);
  if (applyLabels) {
    await page.evaluate((url) => history.replaceState({}, '', url), notionUrls[0]);
    await readNotion('previous');
    assert.equal(await worker.evaluate(() => requests.length), beforeNotion + 3);
  }
  await worker.evaluate(async () => {
    globalThis.simulateStaleNotionSender = false;
    await chrome.storage.local.set({ iconCaptureEnabled: false });
    captureCount = 0;
  });
  console.log('PASS Notion 형식 URL에서 오래된 발신 메타데이터에도 조회·캡처·추론·저장 및 재방문 hit');

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
  console.log('PASS 503 대기 중 추가 호출 차단, HTTP 상태 표시, Timeout 발생 시 저장 방지');

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
  const sprite = await worker.evaluate(async () => {
    const canvas = new OffscreenCanvas(40, 20);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ca2c36';
    context.fillRect(0, 0, 20, 20);
    context.fillStyle = '#176bb5';
    context.fillRect(20, 0, 20, 20);
    return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())];
  });
  await browser.route('https://example.com/icon-sprite.png', (route) => route.fulfill({
    contentType: 'image/png', body: Buffer.from(sprite),
  }));
  const icons = `<!doctype html><html lang="ko"><head><style>
    button { margin: 12px; padding: 10px; }
    .glyph, i { display: block; width: 18px; height: 18px; }
    #glyph-a::before, #glyph-b::before { content: ''; display: block; width: 100%; height: 100%; }
    #glyph-a::before { background: rgb(12, 34, 56); mask-image: linear-gradient(black, black); }
    #glyph-b { color: transparent; background: rgb(87, 65, 43); }
    #offscreen { position: absolute; top: 300vh; }
    #sprite-offscreen { position: absolute; top: 350vh; }
    .sprite-icon { display: block; width: 20px; height: 20px; }
    .sprite-icon::before { content: ''; display: block; width: 20px; height: 20px;
      background: url('/icon-sprite.png') -20px 0 / 40px 20px no-repeat; }
    </style></head><body>
    <button id="shape"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/></svg></button>
    <button id="glyph-first"><span class="glyph" id="glyph-a"></span></button>
    <button id="glyph-second"><i id="glyph-b" aria-hidden="true">&#xE001;</i></button>
    <button id="bitmap"><img width="20" height="20" alt="" src="${pixel}"></button>
    <button id="offscreen"><span class="icon" style="display:block;width:20px;height:20px"></span></button>
    <a id="with-clue" href="#top"><svg aria-hidden="true" width="20" height="20"><circle cx="10" cy="10" r="7"/></svg></a>
    <button id="sprite-offscreen"><span class="sprite-icon"></span></button>
    </body></html>`;
  await browser.route('https://example.com/icons-*', (route) => route.fulfill({ contentType: 'text/html', body: icons }));
  const inspectIcons = () => worker.evaluate(async () => {
    const { inputs, images } = requests.at(-1);
    const decoded = await Promise.all(images.map(async ({ requestId, data, tiles }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const { width, height } = image;
      try {
        return (tiles ?? [{ requestId, x: 0, y: 0, width, height }]).map(({ requestId: id, x, y, width: w, height: h }) => {
          if (x < 0 || y < 0 || x + w > width || y + h > height) throw new Error('Invalid tile bounds');
          const canvas = new OffscreenCanvas(w, h);
          const context = canvas.getContext('2d');
          context.drawImage(image, x, y, w, h, 0, 0, w, h);
          return { id: inputs.find((row) => row.requestId === id)?.attributes.id, width: w, height: h,
            color: [...context.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data] };
        });
      } finally {
        image.close();
      }
    }));
    return decoded.flat();
  });
  await page.bringToFront();
  await page.goto('https://example.com/icons-direct');
  await probe('ok');
  const directIcons = await inspectIcons();
  assert.deepEqual(directIcons.map(({ id, width, height }) => [id, width, height]),
    ['shape', 'glyph-first', 'bitmap', 'with-clue', 'sprite-offscreen'].map((id) => [id, 64, 64]));
  assert.deepEqual(directIcons.find(({ id }) => id === 'sprite-offscreen').color, [23, 107, 181, 255]);
  assert.equal(await worker.evaluate(() => captureCount), 0);
  console.log('PASS 화면 밖 CSS 가상 요소에서 스프라이트의 올바른 영역 추출');

  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: true }));
  await page.goto('https://example.com/icons-capture');
  await probe('ok');
  const captured = await inspectIcons();
  assert.deepEqual(captured.map(({ id }) => id), ['shape', 'glyph-first', 'glyph-second', 'bitmap', 'with-clue', 'sprite-offscreen']);
  assert.deepEqual(captured.find(({ id }) => id === 'glyph-first').color, [12, 34, 56, 255]);
  assert.deepEqual(captured.find(({ id }) => id === 'glyph-second').color, [87, 65, 43, 255]);
  assert.equal(await worker.evaluate(() => captureCount), 1);
  const iconReport = JSON.parse(await page.locator('#ai-test-report').textContent()).report;
  assert.deepEqual(Object.fromEntries(iconReport.map(({ selector, aiImageSource }) => [selector, aiImageSource])), {
    '#shape': 'svg', '#glyph-first': 'css', '#glyph-second': 'capture', '#bitmap': 'img', '#offscreen': 'none',
    '#with-clue': 'svg', '#sprite-offscreen': 'css',
  });
  assert.equal(await worker.evaluate(() => requests.at(-1).inputs.some(({ attributes }) => attributes.id === 'offscreen')), true);
  assert.equal(await worker.evaluate(() => imageStatusLog.at(-1)), 'element-outside-viewport');
  console.log('PASS 화면 밖 요소는 대기 없이 같은 요청에 텍스트 단서 포함');

  await worker.evaluate(() => chrome.storage.local.set({ aiModel: 'gpt-6-luna', openAiApiKey: 'openai-test-key' }));
  await page.goto('https://example.com/icons-gpt');
  await probe('ok');
  assert.deepEqual((await inspectIcons()).map(({ id }) => id), captured.map(({ id }) => id));
  await worker.evaluate(() => chrome.storage.local.set({ aiModel: 'gemini-3.8-flash' }));
  console.log('PASS 직접 추출, 한 번 캡처한 아이콘의 픽셀, 모델별 이미지 입력');

  const imageBody = Buffer.from(pixel.split(',', 2)[1], 'base64');
  await browser.route('https://images.example.test/**', (route) => route.fulfill({
    contentType: 'image/png',
    body: imageBody,
    // A supplied origin header prevents Playwright from adding an automatic CORS allowance.
    headers: { 'access-control-allow-origin': route.request().url().endsWith('/public.png') ? '*' : 'https://elsewhere.test' },
  }));
  await browser.route((url) => url.origin === 'https://example.com' && url.pathname === '/image-links', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><style>a {display:block;margin:12px;width:240px}img {display:block}</style>
      <a id="large-picture" href="/portfolio/a"><svg aria-hidden="true" style="display:none"><rect width="8" height="8"/></svg>
        <img src="${pixel}" width="240" height="120" alt=""></a>
      <a id="public-cdn" href="/portfolio/b"><img src="https://images.example.test/public.png" width="120" height="40" alt=""></a>
      <a id="restricted-cdn" href="/portfolio/c"><img src="https://images.example.test/restricted.png"
        width="120" height="40" alt="" style="background:rgb(41,82,123)"></a>
      <a id="url-link" href="/portfolio/d" style="height:48px;position:relative;left:-28px;background:rgb(53,106,159)">https://example.com/d</a>`,
  }));
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: false }));
  await page.goto('https://example.com/image-links');
  await probe('ok');
  assert.equal(await worker.evaluate(() => requests.at(-1).images.length), 2);
  assert.deepEqual((await inspectIcons()).map(({ id, width, height }) => [id, width, height]),
    ['large-picture', 'public-cdn'].map((id) => [id, 64, 64]));
  assert.equal(await worker.evaluate(() => imageStatusLog.at(-1)), 'capture-disabled');
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: true }));
  await page.goto('https://example.com/image-links?capture=1');
  await probe('ok');
  const imageLinks = await inspectIcons();
  assert.deepEqual(imageLinks.map(({ id }) => id), ['large-picture', 'public-cdn', 'restricted-cdn', 'url-link']);
  assert.deepEqual(imageLinks[2].color, [41, 82, 123, 255]);
  assert.deepEqual(imageLinks[3].color, [53, 106, 159, 255]);
  assert.equal(await worker.evaluate(() => imageStatusLog.at(-1)), 'attached');
  console.log('PASS 큰 이미지, CDN 이미지, 화면에 일부 보이는 텍스트 링크의 PNG 첨부');

  const banner = await worker.evaluate(async () => {
    const canvas = new OffscreenCanvas(496, 37);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e0f5ff';
    ctx.fillRect(0, 0, 496, 37);
    ctx.fillStyle = '#123456';
    ctx.font = '15px sans-serif';
    ctx.fillText('Campus portal - original image', 100, 24);
    // Single-pixel stripes make any resampling detectable.
    for (let x = 0; x < 80; x += 2) ctx.fillRect(x, 0, 1, 37);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  let sourceReads = 0;
  imageServer = createServer((_req, res) => {
    sourceReads++;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(banner, 'base64'));
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  const imageUrl = `http://127.0.0.1:${imageServer.address().port}/banner.png`;
  await browser.route('http://example.com/original-buttons?*', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><style>a{display:block;margin-top:1500px;width:496px}img{display:block}</style>'
      + ['a', 'b', 'c'].map((id) => `<a id="original-${id}" href="/portal/${id}"><img src="${imageUrl}" width="496" height="37" alt=""></a>`).join(''),
  }));
  for (const model of ['gemini-3.5-flash-lite', 'gpt-6-luna', 'qwen/qwen3.8-27b']) {
    const before = await worker.evaluate(async (model) => {
      await chrome.storage.local.set({ aiModel: model, groqApiKey: 'local-groq-test-key' });
      return { calls: requests.length, captures: captureCount };
    }, model);
    await page.goto('http://example.com/original-buttons?model=' + encodeURIComponent(model));
    await probe('ok');
    const outbound = await worker.evaluate((start) => requests.slice(start), before.calls);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].inputs.length, 3);
    assert.equal(outbound[0].images.length, 1);
    if (model.startsWith('gpt-')) assert.deepEqual(outbound[0].imageDetails, ['high']);
    assert.deepEqual((await inspectIcons()).map(({ width, height }) => [width, height]), [[496, 37], [496, 37], [496, 37]]);
    assert.equal(await worker.evaluate(() => captureCount), before.captures);
    const report = JSON.parse(await page.locator('#ai-test-report').textContent()).report;
    assert.ok(report.every(({ aiImageSource }) => aiImageSource === 'img'));
    const unchangedPixels = await worker.evaluate(async ({ original, sheet }) => {
      const decode = (data) => createImageBitmap(new Blob([Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))], { type: 'image/png' }));
      const source = await decode(original);
      const atlas = await decode(sheet.data);
      try {
        const canvas = new OffscreenCanvas(496, 37);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0);
        const expected = ctx.getImageData(0, 0, 496, 37).data;
        return sheet.tiles.every(({ x, y, width, height }) => {
          ctx.clearRect(0, 0, 496, 37);
          ctx.drawImage(atlas, x, y, width, height, 0, 0, width, height);
          return ctx.getImageData(0, 0, 496, 37).data.every((value, index) => value === expected[index]);
        });
      } finally { source.close(); atlas.close(); }
    }, { original: banner, sheet: outbound[0].images[0] });
    assert.equal(unchangedPixels, true);
  }
  assert.ok(sourceReads > 0);
  await worker.evaluate(() => chrome.storage.local.set({ aiModel: 'gemini-3.8-flash' }));
  console.log('PASS CORS 미허용·화면 밖 원본 이미지 496×37을 모든 제공자에 픽셀 손실 없이 한 장으로 전송');

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
    icons: requests.slice(calls).map(({ inputs, images }) => images.flatMap(({ requestId, tiles }) => tiles ?? [{ requestId }]).map(({ requestId }) =>
      inputs.find((item) => item.requestId === requestId).attributes.id)),
    imageParts: requests.slice(calls).map(({ images }) => images.length),
    captures: captureCount - captures,
  }), beforeBatchImages), {
    icons: [Array.from({ length: 8 }, (_, i) => `tile-${i}`), ['tile-8', 'tile-9']], imageParts: [1, 2], captures: 2,
  });
  console.log('PASS 두 묶음에 걸쳐 추출한 이미지 10개 모두 첨부');

  await browser.route('https://example.com/combined-icons?*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><style>body{display:flex;gap:12px}button{appearance:none;border:0}</style>'
      + batchIcons.slice(0, 8).join(''),
  }));
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'qwen/qwen3.8-27b']) {
    const beforeCombined = await worker.evaluate(async (model) => {
      await chrome.storage.local.set({ aiModel: model, groqApiKey: 'local-groq-test-key' });
      globalThis.maxWorkingImages = 2;
      return requests.length;
    }, model);
    await page.goto('https://example.com/combined-icons?model=' + encodeURIComponent(model));
    await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
      ?.report.filter((item) => item.aiStatus === 'label-ready').length === 8);
    const combined = await worker.evaluate((start) => requests.slice(start), beforeCombined);
    assert.equal(combined.length, 1);
    assert.equal(combined[0].authorized, true);
    assert.equal(combined[0].images.length, 1);
    assert.deepEqual(combined[0].images[0].tiles.map(({ tile, requestId }) => ({ tile, requestId })),
      combined[0].inputs.map(({ requestId }, index) => ({ tile: index + 1, requestId })));
    assert.deepEqual((await inspectIcons()).map(({ color }) => color),
      Array.from({ length: 8 }, (_, index) => [index * 20, 40, 80, 255]));
  }
  await worker.evaluate(async () => {
    delete globalThis.maxWorkingImages;
    await chrome.storage.local.set({ aiModel: 'gemini-3.8-flash' });
  });
  console.log('PASS 모든 모델이 아이콘 8개를 번호 및 요청 ID와 함께 PNG 한 장에 담아 한 번 호출');

  const retryPage = await browser.newPage();
  const retryTime = Date.now();
  await browser.route('https://example.com/retry-text-only', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><button id="retry-text" data-action="quantumspin"></button>',
  }));
  const beforeTextRetry = await worker.evaluate((now) => {
    globalThis.aiTestNow = now;
    globalThis.unavailableRemaining = 2;
    return requests.length;
  }, retryTime);
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: false }));
  await retryPage.goto('https://example.com/retry-text-only');
  await retryPage.bringToFront();
  await probe('service-unavailable', retryPage);
  const { beforeRetryScan, retryDelay } = await retryPage.locator('#ai-test-report[data-retry-delay]').evaluate((node) => ({
    beforeRetryScan: JSON.parse(node.textContent).scanId, retryDelay: Number(node.dataset.retryDelay),
  }));
  assert.ok(retryDelay >= 55000 && retryDelay <= 60000);
  assert.equal(await worker.evaluate(() => requests.length), beforeTextRetry + 1);
  await worker.evaluate(() => { globalThis.aiTestNow += 60000; });
  await retryPage.evaluate((now) => {
    document.querySelector('#ai-test-report').dataset.now = now;
    document.dispatchEvent(new Event('test-ai-fire-retry'));
  }, retryTime + 60000);
  await retryPage.waitForFunction((before) => {
    const result = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null');
    return result?.scanId > before && result.aiStatus === 'service-unavailable';
  }, beforeRetryScan);
  assert.deepEqual(await worker.evaluate((start) => requests.slice(start).map(({ images }) => images.length), beforeTextRetry), [0, 0]);
  assert.equal(await retryPage.locator('#ai-test-report').getAttribute('data-retry-timers'), '1');
  assert.equal(await worker.evaluate(() => requests.length), beforeTextRetry + 2);
  await retryPage.close();
  await worker.evaluate(() => { globalThis.aiTestNow += 60000; });
  console.log('PASS 이미지 없는 Gemini 503도 대기 후 자동으로 한 번만 재검사');

  const swatches = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>무료 이미지 배경 지우기</title><style>
    button { width: 40px; height: 40px; border: 1px solid black; border-radius: 50%; }
    .bg-damier-medium { background-image: repeating-conic-gradient(#ccc 0% 25%, white 0% 50%); background-size: 12px 12px; }
    .wheel { background-image: radial-gradient(white, transparent), conic-gradient(red, yellow, lime, blue, red); }
    </style></head><body><main><h1>무료 이미지 배경 지우기</h1><div class="swatches">
    <button id="swatch-a" class="before:-top-px bg-damier-medium" style="background-color: white" aria-pressed="true"></button>
    <button id="swatch-b" class="before:-top-px" style="background-color: white" aria-pressed="false"></button>
    <button id="swatch-c" class="wheel" aria-haspopup="dialog" aria-expanded="false"></button>
    </div></main></body></html>`;
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
  const swatchImages = await inspectIcons();
  assert.deepEqual(swatchImages.map(({ id }) => id), ['swatch-a', 'swatch-b', 'swatch-c']);
  assert.deepEqual(swatchImages[1].color, [255, 255, 255, 255]);
  assert.notDeepEqual(swatchImages[0].color, swatchImages[2].color);
  if (applyLabels) {
    for (const name of ['투명 배경 선택', '흰색 배경 선택', '배경 색상 선택']) {
      await page.getByRole('button', { name, exact: true }).waitFor();
    }
    for (const selector of ['#swatch-a', '#swatch-b', '#swatch-c']) {
      await waitForStorage(selector, 'saved');
    }
    const requestsBeforeRevisit = await worker.evaluate(() => requests.length);
    await page.reload();
    await read(() => {
      const report = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')?.report;
      return report?.length === 3 && report.every((row) => row.match.source === 'previous' && row.labelApplied);
    });
    assert.equal(await worker.evaluate(() => requests.length), requestsBeforeRevisit);
    console.log('PASS CSS 배경 버튼별 저장, 같은 URL 재방문 시 AI 호출 없이 이름 적용');
  }
  await worker.evaluate(() => chrome.storage.local.set({ iconCaptureEnabled: true }));
  await page.goto('https://example.com/swatches-capture');
  await probe('ok');
  assert.deepEqual((await inspectIcons()).map(({ id, width, height }) => [id, width, height]),
    ['swatch-a', 'swatch-b', 'swatch-c'].map((id) => [id, 64, 64]));
  console.log('PASS CSS 위치 클래스 오탐 방지 및 체크무늬·흰색·색상 원의 AI 단서 전달');

  if (applyLabels) {
    await browser.route('https://example.com/keyboard-revisit', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>YouTube 키보드 테스트</title></head><body>'
        + '<header><div id="center"><input aria-label="동영상 검색">'
        + '<button class="ytdTextInputAssistantButton"><svg aria-hidden="true" width="16" height="10">'
        + '<rect width="16" height="10"/></svg></button></div></header><main><div id="center"></div></main></body></html>',
    }));
    await page.goto('https://example.com/keyboard-revisit');
    await page.getByRole('button', { name: '가상 키보드', exact: true }).waitFor();
    await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
      ?.report.some(({ aiStorage }) => aiStorage === 'saved'));
    const requestsBeforeKeyboardRevisit = await worker.evaluate(() => requests.length);
    await page.reload();
    await page.getByRole('button', { name: '가상 키보드', exact: true }).waitFor();
    await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')
      ?.report.some(({ match }) => match.source === 'previous' && match.label === '가상 키보드'));
    assert.equal(await worker.evaluate(() => requests.length), requestsBeforeKeyboardRevisit);
    console.log('PASS 중복 컨테이너 ID가 있는 가상 키보드 저장 및 재방문 재사용');

    const storeLinks = '<section><a class="store-badge" href="/page/mlink?store=appstore"></a>'
      + '<a class="store-badge" href="/page/mlink?store=playstore"></a></section>';
    await browser.route('https://example.com/store-links', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="ko"><body>' + storeLinks + storeLinks + '</body></html>',
    }));
    const beforeLinks = await worker.evaluate(() => requests.length);
    const summaryTables = [];
    const detailTables = [];
    const loggedTables = [];
    let logGroup;
    const collectConsole = (message) => {
      if (message.type() === 'startGroupCollapsed') logGroup = message.text();
      if (message.type() !== 'table') return;
      const tables = logGroup === '[FocusBridge AI] 응답 결과' ? detailTables
        : logGroup?.startsWith('[FocusBridge] TOP https://example.com/store-links ') ? summaryTables : null;
      if (tables) loggedTables.push(message.args()[0].jsonValue().then((rows) => tables.push(rows)));
    };
    page.on('console', collectConsole);
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
    await Promise.all(loggedTables);
    assert.equal(await worker.evaluate(() => requests.at(-1).inputs.length), 2);
    assert.equal(linkScan.report.filter((item) => item.aiReused).length, 2);
    assert.equal(summaryTables.length, 1);
    assert.ok(summaryTables[0].every((row) => row.previousMatch === 'ineligible'
      && row.match === 'ai' && row.label === '회전 설정 열기'));
    assert.deepEqual(summaryTables[0].map((row) => row.reused), [false, false, true, true]);
    assert.equal(detailTables.length, 1);
    assert.equal(detailTables[0].length, 2);
    assert.ok(detailTables[0].every((row) => row.reused === false));
    for (let pass = 0; pass < 2; pass++) {
      // Replace both sets of anchors as a page framework would during a re-render.
      await page.evaluate((html) => {
        for (const section of document.querySelectorAll('section')) section.outerHTML = html;
      }, storeLinks);
      linkScan = await readLinks(linkScan.scanId);
      await Promise.all(loggedTables);
      assert.ok(linkScan.report.every((item) => item.aiReused));
      assert.equal(await worker.evaluate(() => requests.length), beforeLinks + 1);
      assert.equal(summaryTables.length, 2);
      assert.ok(summaryTables[1].every((row) => row.reused === true));
      assert.equal(detailTables.length, 1);
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
    await Promise.all(loggedTables);
    assert.equal(summaryTables.length, 3);
    assert.equal(summaryTables[2].filter((row) => row.reused === false).length, 1);
    assert.equal(detailTables.length, 2);
    assert.equal(detailTables[1].length, 1);
    assert.equal(detailTables[1][0].reused, false);
    console.log('PASS 같은 중복 링크는 재생성 뒤에도 AI 결과 재사용, 변경된 목적지만 새 요청');

    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'extra-control';
      button.className = 'search';
      document.body.append(button);
    });
    await read(() => {
      const report = JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')?.report;
      return report?.length === 5 && report.find((row) => row.selector === '#extra-control')?.match.label === '검색'
        && report.every((row) => row.labelApplied);
    });
    await Promise.all(loggedTables);
    assert.equal(summaryTables.length, 4);
    assert.equal(summaryTables[3].length, 5);
    assert.equal(summaryTables[3].find((row) => row.selector === '#extra-control').match, 'rule');
    assert.equal(summaryTables[3].find((row) => row.selector === '#extra-control').reused, '-');
    await page.locator('#extra-control').evaluate((element) => { element.className = 'close'; });
    await read(() => JSON.parse(document.querySelector('#ai-test-report')?.textContent || 'null')?.report
      .find((row) => row.selector === '#extra-control')?.match.label === '닫기');
    await Promise.all(loggedTables);
    assert.equal(summaryTables.length, 5);
    assert.equal(summaryTables[4].find((row) => row.selector === '#extra-control').label, '닫기');
    assert.equal(detailTables.length, 2);
    assert.equal(await worker.evaluate(() => requests.length), beforeLinks + 2);
    page.off('console', collectConsole);
    console.log('PASS ineligible 최종 라벨 출력, 재사용 상세 및 동일 전체표 생략, 탐지·매칭 변경 시 전체표 갱신');

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
    imageServer?.closeAllConnections();
    if (imageServer) await new Promise((resolve) => imageServer.close(resolve));
    if (path.dirname(path.resolve(tmp)) === path.resolve(os.tmpdir()) && path.basename(tmp).startsWith('focusbridge-ai-')) {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
