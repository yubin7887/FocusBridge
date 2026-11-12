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
  assert.ok(manifest.host_permissions.includes('https://api.groq.com/*'));
  manifest.content_scripts[0].js.push('probe.js');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const file of ['dist/content.js', 'src/options.js', 'src/ai-settings.js', 'src/ai-config.js', 'options.html', 'options.css']) {
    await copyFile(file, path.join(dir, file));
  }
  const background = await readFile('dist/background.js', 'utf8');
  await writeFile(path.join(dir, 'dist/background.js'), `
    globalThis.requests = [];
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
      const groq = url === 'https://api.groq.com/openai/v1/chat/completions';
      const inputs = JSON.parse(groq ? raw.messages.find(({ role }) => role === 'user').content
        : openai ? raw.input : raw.contents[0].parts[0].text);
      const authorized = groq || openai
        ? request.headers.Authorization === (groq ? 'Bearer groq-test-key' : 'Bearer openai-test-key') && !request.headers['x-goog-api-key']
        : request.headers['x-goog-api-key'] === 'local-test-key' && !request.headers.Authorization;
      requests.push({ url, inputs, authorized, model: raw.model, reasoning: raw.reasoning_effort ?? raw.reasoning?.effort,
        store: raw.store, format: raw.response_format?.type ?? raw.text?.format?.type,
        strict: raw.response_format?.json_schema?.strict, thinkingLevel: raw.generationConfig?.thinkingConfig?.thinkingLevel });
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
      const results = inputs.map(({ requestId, attributes, destination }) => {
        if (destination?.href === '#top') return { requestId, label: '맨 위로 이동' };
        let label = groq ? 'Groq 회전 설정' : openai ? 'GPT 회전 설정' : '회전 설정 열기';
        if (attributes?.['data-action'] === 'unknown') label = globalThis.returnUnusableLabel ? 'button' : null;
        return { requestId, label };
      });
      if (openai) return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ results }) }] }],
      });
      if (groq) return Response.json({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ results }) } }],
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
    ['Gemini 3.8 Flash', 'GPT-6 Luna', 'GPT-6.1 Terra', 'GPT-6.1 Sol', 'Groq · GPT-OSS 20B']);
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
  assert.ok(sent[0].url.endsWith('/gemini-3.8-flash:generateContent'));
  assert.equal(sent[0].thinkingLevel, 'LOW');
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
      && item.aiModel === 'gemini-3.8-flash' && item.aiRequestCount > 0));
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

  await modelSelect.selectOption('openai/gpt-oss-20b');
  await settings.getByLabel('Groq API 키').waitFor();
  await settings.getByRole('status').filter({ hasText: '등록된 API 키가 없습니다.' }).waitFor();
  const countBeforeGroq = await worker.evaluate(() => requests.length);
  await page.goto('https://example.com/groq');
  await probe('not-configured');
  assert.equal(await worker.evaluate(() => requests.length), countBeforeGroq);
  await settings.getByLabel('Groq API 키').fill('groq-test-key');
  await settings.getByRole('button', { name: '키 저장', exact: true }).click();
  await settings.getByRole('status').filter({ hasText: '키를 저장했습니다' }).waitFor();
  await page.reload();
  await probe('ok');
  const groq = await worker.evaluate(() => requests.at(-1));
  assert.equal(groq.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(groq.model, 'openai/gpt-oss-20b');
  assert.equal(groq.authorized, true);
  assert.equal(groq.reasoning, 'low');
  assert.equal(groq.format, 'json_schema');
  assert.equal(groq.strict, true);
  await waitForStorage('#spin', applyLabels ? 'saved' : 'not-applied');
  if (applyLabels) await page.getByRole('button', { name: 'Groq 회전 설정', exact: true }).waitFor();
  assert.deepEqual((await stored(page.url())).map(({ label }) => label), applyLabels ? ['Groq 회전 설정'] : []);
  console.log('PASS Groq 별도 키 설정, 모의 API 호출 및 라벨 처리');

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
  assert.equal(last.authorized, true);

  console.log('PASS 모델 선택·호출 옵션·기존 설정 호환·키 공유와 분리');

  if (applyLabels) {
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
