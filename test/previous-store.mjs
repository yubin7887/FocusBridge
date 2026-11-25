import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: { contents: `export * from './src/previous-store.js';
    export * from './src/previous-fingerprint.js';
    export * from './src/previous-messages.js';
    export { createPreviousLookup, matchPrevious } from './src/previous-matcher.js';`, resolveDir: process.cwd() },
  bundle: true, format: 'iife', globalName: 'previous', write: false,
});
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const page = await browser.newPage();
  await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html',
    body: '<header id="header"><button id="cart" data-action="cart"></button></header>' }));
  await page.goto('https://example.com/shop');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    const { createPreviousStore, createFingerprint, RECORD_TTL_MS,
      createPreviousMessageHandler, LOOKUP_PREVIOUS, createPreviousLookup, matchPrevious } = previous;
    const rows = [];
    const check = (title, value) => { rows.push([title, Boolean(value)]); };
    const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
    const fingerprint = createFingerprint(document.getElementById('cart'));
    check('실제 DOM에서 저장 가능한 Fingerprint 생성', fingerprint.eligible);
    let time = 1000000000;
    const dbName = 'focusbridge-test';
    let store = createPreviousStore({ dbName, now: () => time });
    const seedLegacyConflict = async (name, record) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('confirmedLabels', 'readwrite');
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          tx.objectStore('confirmedLabels').put({ ...record, status: 'conflict' });
        });
      } finally { db.close(); }
    };
    const input = { fingerprint, label: '장바구니', source: 'ai' };
    check('처음 방문한 페이지는 빈 기록', (await store.lookupPage(fingerprint.pageKey)).length === 0);
    check('사전 매칭 결과 저장 거부', await rejects(() => store.saveAiResult({ ...input, source: 'dictionary' })));
    check('빈 이름 저장 거부', await rejects(() => store.saveAiResult({ ...input, label: '  ' })));
    check('다른 페이지로 위조한 Fingerprint 거부', await rejects(() => store.saveAiResult({ ...input,
      fingerprint: { ...fingerprint, pageKey: 'https://example.com/other' } })));
    const first = await store.saveAiResult(input);
    check('검증 메타데이터 없이 AI 결과 저장 가능', first.status === 'saved');
    let records = await store.lookupPage(fingerprint.pageKey);
    check('확정 이름과 원본 Fingerprint 조회', records.length === 1
      && records[0].label === '장바구니' && records[0].fingerprintCanonical === fingerprint.canonical);
    check('7일 만료 시각과 SHA-256 키', records[0].expiresAt === time + RECORD_TTL_MS
      && /^[a-f0-9]{64}$/.test(records[0].fingerprintHash));
    check('다른 페이지와 공유하지 않음', (await store.lookupPage('https://example.com/other')).length === 0);
    time += 1000;
    check('중복 저장은 만료 연장하지 않음', (await store.saveAiResult(input)).expiresAt === first.expiresAt);
    await store.close();
    store = createPreviousStore({ dbName, now: () => time });
    check('연결을 다시 열어도 기록 유지', (await store.lookupPage(fingerprint.pageKey)).length === 1);
    time = first.expiresAt - 1;
    check('만료 직전 조회 가능', (await store.lookupPage(fingerprint.pageKey)).length === 1);
    time++;
    check('만료 시각부터 재사용 제외', (await store.lookupPage(fingerprint.pageKey)).length === 0);
    check('만료 후에도 빈 이름 교체는 거부', await rejects(() => store.saveAiResult({ ...input, label: '  ' })));
    const replaced = await store.saveAiResult({ ...input, label: '주문하기' });
    check('만료된 이름은 새 AI 이름으로 교체', replaced.status === 'saved'
      && (await store.lookupPage(fingerprint.pageKey))[0]?.label === '주문하기');
    check('교체 시점부터 새로운 7일 적용', replaced.expiresAt === time + RECORD_TTL_MS);
    const beforeTimeout = (await store.lookupPage(fingerprint.pageKey))[0];
    const lookup = createPreviousLookup({ timeoutMs: 5, runtime: { sendMessage: () => new Promise(() => {}) } });
    const timedOut = await lookup(fingerprint.pageKey);
    check('조회 타임아웃이면 그 검사에서는 저장 이름을 받지 못함', timedOut.status === 'timeout' && timedOut.records.length === 0);
    time += 1000;
    const lateSave = await store.saveAiResult({ ...input, label: '주문하기 버튼 열기' });
    const nextVisit = await store.lookupPage(fingerprint.pageKey);
    check('조회 지연 후 다른 AI 이름이 도착해도 기존 이름으로 다음 방문에 hit', lateSave.status === 'unchanged'
      && matchPrevious(fingerprint, nextVisit, time)?.label === '주문하기');
    check('뒤늦은 저장이 기존 기록의 시각을 바꾸지 않음', lateSave.expiresAt === beforeTimeout.expiresAt
      && nextVisit[0]?.updatedAt === beforeTimeout.updatedAt);
    await seedLegacyConflict(dbName, beforeTimeout);
    check('충돌 기록은 조회 결과에서 제외', (await store.lookupPage(fingerprint.pageKey)).length === 0);
    check('유효기간 중 재저장으로 충돌이 풀리지 않음', (await store.saveAiResult(input)).status === 'conflict');
    time += RECORD_TTL_MS * 2;
    check('시간 경과만으로 충돌 기록을 재사용하지 않음', (await store.lookupPage(fingerprint.pageKey)).length === 0);
    check('만료된 충돌 기록도 새 AI 결과로 교체', (await store.saveAiResult(input)).status === 'saved'
      && (await store.lookupPage(fingerprint.pageKey))[0]?.label === '장바구니');
    time += RECORD_TTL_MS;
    check('만료 후 같은 이름도 새 AI 결과로 갱신', (await store.saveAiResult(input)).status === 'saved');
    const concurrent = createPreviousStore({ dbName: 'focusbridge-concurrent', now: () => time });
    const candidates = [input, { ...input, label: '장바구니 열기' }];
    const outcomes = await Promise.all(candidates.map((candidate) => concurrent.saveAiResult(candidate)));
    const firstSaved = candidates[outcomes.findIndex(({ status }) => status === 'saved')];
    const concurrentRecords = await concurrent.lookupPage(fingerprint.pageKey);
    check('동시 저장에서 먼저 저장된 이름 한 개를 유지', outcomes.some(({ status }) => status === 'unchanged')
      && concurrentRecords.length === 1 && concurrentRecords[0].label === firstSaved?.label);
    const cleanupName = 'focusbridge-cleanup';
    const cleanupStore = createPreviousStore({ dbName: cleanupName, now: () => time });
    const otherPage = 'https://example.com/other';
    const otherFingerprint = { ...fingerprint, pageKey: otherPage,
      canonical: JSON.stringify({ ...JSON.parse(fingerprint.canonical), pageKey: otherPage }) };
    await cleanupStore.saveAiResult(input);
    await seedLegacyConflict(cleanupName, (await cleanupStore.lookupPage(fingerprint.pageKey))[0]);
    time += 1000;
    await cleanupStore.saveAiResult({ ...input, fingerprint: otherFingerprint });
    const countRecords = async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(cleanupName, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('confirmedLabels').objectStore('confirmedLabels').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    };
    check('유효한 충돌 기록은 자동 정리하지 않음', await countRecords() === 2);
    time += RECORD_TTL_MS - 1000;
    await cleanupStore.lookupPage(otherPage);
    check('조회 시 다른 페이지의 만료된 충돌 기록도 실제 삭제', await countRecords() === 1);
    check('자동 정리 후 유효한 기록 유지', (await cleanupStore.lookupPage(otherPage))[0]?.label === '장바구니');
    time += 1000;
    await cleanupStore.saveAiResult(input);
    check('저장 시에도 만료 기록을 삭제하고 새 기록만 유지', await countRecords() === 1
      && (await cleanupStore.lookupPage(fingerprint.pageKey))[0]?.label === '장바구니');
    await cleanupStore.close();
    const snapshotStore = createPreviousStore({ dbName: 'focusbridge-snapshot', now: () => time });
    const mutable = { ...input, fingerprint: { ...fingerprint } };
    const saving = snapshotStore.saveAiResult(mutable);
    mutable.fingerprint.canonical = '{}';
    mutable.fingerprint.pageKey = 'https://example.com/changed';
    await saving;
    const snapshot = (await snapshotStore.lookupPage(fingerprint.pageKey))[0];
    check('저장 중 원본 객체가 변해도 호출 당시 정보 유지', snapshot?.fingerprintCanonical === fingerprint.canonical
      && !Object.hasOwn(snapshot, 'verification'));
    await snapshotStore.close();

    const sender = { id: 'extension-test', tab: { id: 1 }, frameId: 0, url: fingerprint.pageKey, documentId: 'document-test' };
    const navigation = { getFrame: async () => ({ url: fingerprint.pageKey, documentId: sender.documentId, documentLifecycle: 'active' }) };
    const handler = createPreviousMessageHandler(store, sender.id, navigation);
    const message = { type: LOOKUP_PREVIOUS, pageKey: fingerprint.pageKey };
    const dispatch = (msg = message, from = sender, handle = handler) => new Promise((resolve) => handle(msg, from, resolve));
    check('정상 최상위 문서 조회 메시지 처리', (await dispatch()).ok);
    check('iframe 메시지 거부', !(await dispatch(message, { ...sender, frameId: 1 })).ok);
    check('다른 확장 발신자 거부', !(await dispatch(message, { ...sender, id: 'other' })).ok);
    check('다른 페이지 기록 요청 거부', !(await dispatch({ ...message, pageKey: 'https://example.com/other' })).ok);
    check('탭 없는 발신자 거부', !(await dispatch(message, { ...sender, tab: undefined })).ok);
    check('저장 메시지는 공개하지 않음', handler({ type: 'focusbridge:previous:save', ...input }, sender, () => {}) === false);
    const broken = createPreviousMessageHandler({ lookupPage: async () => { throw new Error('db failure'); } }, sender.id, navigation);
    check('DB 실패를 정해진 오류 응답으로 반환', (await dispatch(message, sender, broken)).error === 'storage-unavailable');
    await concurrent.close();
    await store.close();
    // 새 페이지/스크립트에서도 확인할 영속 기록을 남긴다.
    const persisted = createPreviousStore({ dbName: 'focusbridge-persistence' });
    await persisted.saveAiResult(input);
    await persisted.close();
    return rows;
  });
  for (const [title, passed] of results) { assert.ok(passed, title); console.log('PASS', title); }
  await page.reload();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  assert.equal(await page.evaluate(async () => {
    const store = previous.createPreviousStore({ dbName: 'focusbridge-persistence' });
    const rows = await store.lookupPage(location.href);
    await store.close();
    return rows[0]?.label;
  }), '장바구니');
  console.log(`PASS 페이지 재로드 뒤에도 기록 유지\n\n${results.length + 1}/${results.length + 1} passed`);
} finally { await browser.close(); }
