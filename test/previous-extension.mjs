// 실제 MV3 확장 저장소 검증. 저장 주입과 조회 probe는 임시 테스트 확장에만 존재한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'focusbridge-extension-'));
const extensionDir = path.join(tempRoot, 'extension');
let context;
try {
  await mkdir(path.join(extensionDir, 'dist'), { recursive: true });
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  manifest.content_scripts.push({ matches: ['https://example.com/*'], js: ['probe.js'], run_at: 'document_idle' });
  await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  for (const file of ['content.js', 'background.js']) {
    await copyFile(path.join('dist', file), path.join(extensionDir, 'dist', file));
  }
  await writeFile(path.join(extensionDir, 'probe.js'), `
    chrome.runtime.sendMessage({type:'focusbridge:previous:lookup',pageKey:location.href})
      .then(result => document.documentElement.setAttribute('data-previous-test', JSON.stringify(result)))
      .catch(error => document.documentElement.setAttribute('data-previous-test', JSON.stringify({error:error.message})));
    const output = document.createElement('div');
    output.setAttribute('data-fb-ignore', '');
    output.id = 'previous-test-report';
    document.documentElement.append(output);
    setInterval(() => {
      output.textContent = JSON.stringify(window.__focusBridge ? {
        pageUrl: window.__focusBridge.pageUrl,
        report: window.__focusBridge.report,
        previousStatus: window.__focusBridge.previousStatus,
      } : null);
    }, 100);
  `);
  const bundle = await build({ stdin: { contents: `export * from './src/previous-store.js';
    export * from './src/previous-fingerprint.js';`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', globalName: 'testPrevious', write: false });
  const launch = async () => {
    context = await chromium.launchPersistentContext(path.join(tempRoot, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html',
      body: '<header id="header"><button id="cart" data-action="cart"></button></header>' }));
    return context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  };
  let worker = await launch();
  assert.ok(worker.url().startsWith('chrome-extension://'));
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('Extension test page error:', error.message));
  page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto('https://example.com/shop');
  const response = async (p) => {
    try {
      await p.waitForFunction(() => document.documentElement.hasAttribute('data-previous-test'), null, { timeout: 15000, polling: 100 });
    } catch (error) {
      console.error('Test page:', await p.content());
      throw error;
    }
    return JSON.parse(await p.locator('html').getAttribute('data-previous-test'));
  };
  assert.deepEqual(await response(page), { ok: true, records: [] });
  console.log('PASS 실제 content script → Service Worker 첫 방문 조회');
  const report = async (p, source) => {
    await p.waitForFunction((source) => {
      const raw = document.getElementById('previous-test-report')?.textContent;
      const value = raw ? JSON.parse(raw) : null;
      return value?.pageUrl === location.href && value.report.length > 0
        && (source ? value.report[0].match.source === source : value.report[0].match.source !== 'previous');
    }, source, { timeout: 15000 });
    return JSON.parse(await p.locator('#previous-test-report').textContent());
  };
  assert.equal((await report(page)).report[0].match.label, '장바구니');
  console.log('PASS 첫 방문은 기존 사전 매칭으로 처리');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const fingerprint = await page.evaluate(() => testPrevious.createFingerprint(document.getElementById('cart')));
  await worker.evaluate(bundle.outputFiles[0].text);
  const stored = await worker.evaluate(async (fp) => {
    const store = testPrevious.createPreviousStore();
    const result = await store.saveAiResult({ fingerprint: fp, label: '장바구니', source: 'ai' });
    await store.close();
    return result;
  }, fingerprint);
  assert.equal(stored.status, 'saved');
  await page.reload();
  assert.equal((await response(page)).records[0].label, '장바구니');
  console.log('PASS 확장 프로그램 IndexedDB에 저장 후 실제 메시지로 조회');
  assert.equal((await report(page, 'previous')).report[0].match.pattern, 'P1');
  assert.equal(await page.locator('button').getAttribute('aria-label'), null);
  console.log('PASS 재방문 시 실제 탐지 결과에 이전 이름 재사용, DOM 이름은 수정하지 않음');
  await page.evaluate(() => {
    const button = document.querySelector('button');
    button.className = 'close'; button.setAttribute('data-action', 'close');
  });
  assert.equal((await report(page)).report[0].match.label, '닫기');
  console.log('PASS 저장 기록이 있어도 현재 요소가 달라지면 사전 매칭');
  await page.evaluate(() => {
    const button = document.querySelector('button');
    button.removeAttribute('class'); button.setAttribute('data-action', 'cart');
  });
  await report(page, 'previous');
  await page.evaluate(() => history.pushState(null, '', '/spa'));
  assert.equal((await report(page)).report[0].match.source, undefined);
  console.log('PASS DOM 변경 없는 SPA 주소 변경도 다른 페이지로 처리');
  await page.evaluate(() => history.replaceState(null, '', '/shop'));
  assert.equal((await report(page, 'previous')).report[0].match.label, '장바구니');
  console.log('PASS SPA 원래 주소 복귀 시 이전 매칭 복구');
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)), []);
  console.log('PASS 방문 사이트의 IndexedDB와 분리');
  await page.goto('https://example.com/other');
  assert.deepEqual((await response(page)).records, []);
  console.log('PASS 다른 페이지 기록을 공유하지 않음');
  await context.close(); context = null;
  worker = await launch();
  const revisited = await context.newPage();
  await revisited.goto('https://example.com/shop');
  assert.equal((await response(revisited)).records[0].label, '장바구니');
  assert.equal((await report(revisited, 'previous')).report[0].match.label, '장바구니');
  console.log('PASS 브라우저·Service Worker 재시작 후 기록 유지 및 이전 매칭\n\n10/10 passed');
} finally {
  if (context) await context.close();
  // 임시 디렉터리의 절대 경로가 의도한 범위에 있는지 확인 후 정리한다.
  const resolved = path.resolve(tempRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('focusbridge-extension-')) {
    throw new Error('Unexpected temporary directory');
  }
  await rm(resolved, { recursive: true, force: true });
}
