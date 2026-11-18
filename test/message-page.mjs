import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviousMessageHandler, LOOKUP_PREVIOUS } from '../src/previous-messages.js';
import { createAiMessageHandler, INFER_NAMES, SAVE_NAMES, CAPTURE_ICONS } from '../src/ai-messages.js';
import { isCurrentMessagePage } from '../src/message-page.js';

const PAGE = 'https://example.com/Home/Game';
const sender = { id: 'test-extension', tab: { id: 7 }, frameId: 0, documentId: 'original-document',
  documentLifecycle: 'active', url: PAGE };
const requestId = '1'.repeat(32);

function fixture() {
  const frame = { url: PAGE, documentId: sender.documentId, documentLifecycle: 'active' };
  const lookedUp = [];
  const inferred = [];
  const saved = [];
  const getFrame = async (details) => {
    assert.deepEqual(details, { tabId: 7, frameId: 0 });
    return { ...frame };
  };
  const store = {
    lookupPage: async (pageKey) => { lookedUp.push(pageKey); return []; },
    saveAiResult: async (result) => { saved.push(result); return { status: 'saved' }; },
  };
  const previous = createPreviousMessageHandler(store, sender.id, { getFrame });
  let infer = async (_settings, inputs) => ({ status: 'ok', httpStatus: 200,
    results: inputs.map(({ requestId }) => ({ requestId, label: '메뉴 열기' })) });
  const ai = createAiMessageHandler({ store, extensionId: sender.id, getFrame,
    readSettings: async () => ({ model: 'gemini-3.5-flash-lite', apiKey: 'test-key' }),
    storageReady: Promise.resolve(null),
    infer: async (...args) => { inferred.push(args[1]); return infer(...args); },
  });
  const send = (message, from = sender) => new Promise((resolve) => {
    (message.type === LOOKUP_PREVIOUS ? previous : ai)(message, from, resolve);
  });
  const inferMessage = (pageKey) => ({ type: INFER_NAMES, pageKey, items: [{ payload: { requestId },
    fingerprint: { eligible: true, pageKey, canonical: '{}' } }] });
  return { frame, lookedUp, inferred, saved, send, inferMessage, setInfer: (fn) => { infer = fn; } };
}

for (const suffix of ['#today', '?panel=new#today', '/category?tab=all#today']) {
  test(`same-document URL change ${suffix} permits lookup, inference, and saving`, async () => {
    const { frame, send, inferMessage, lookedUp, inferred, saved } = fixture();
    frame.url = PAGE + suffix;
    assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey: frame.url })).ok, true);
    assert.deepEqual(lookedUp, [frame.url]);
    const response = await send(inferMessage(frame.url));
    assert.equal(response.status, 'ok');
    assert.equal(inferred.length, 1);
    assert.equal(response.results[0].label, '메뉴 열기');
    const stored = await send({ type: SAVE_NAMES, pageKey: frame.url, ids: [requestId] });
    assert.equal(stored.results[0].status, 'saved');
    assert.equal(saved[0].fingerprint.pageKey, frame.url);
  });
}

test('forged pages, frames, and documents cannot reach the store, capture, or AI', async () => {
  const { frame, send, inferMessage, lookedUp, inferred, saved } = fixture();
  frame.url = PAGE + '#today';
  const cases = [
    [PAGE, sender],
    [PAGE + '#another', sender],
    ['https://other.example/Home/Game#today', sender],
    [frame.url, { ...sender, id: 'other-extension' }],
    [frame.url, { ...sender, frameId: 1 }],
    [frame.url, { ...sender, tab: undefined }],
    [frame.url, { ...sender, documentId: undefined }],
    [frame.url, { ...sender, documentId: 'different-document' }],
  ];
  for (const [pageKey, from] of cases) {
    assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey }, from)).error, 'invalid-request');
    for (const message of [inferMessage(pageKey), { type: SAVE_NAMES, pageKey, ids: [requestId] },
      { type: CAPTURE_ICONS, pageKey }]) {
      assert.equal((await send(message, from)).status, 'invalid-request');
    }
  }
  frame.documentLifecycle = 'cached';
  assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey: frame.url })).error, 'invalid-request');
  assert.equal((await send(inferMessage(frame.url))).status, 'invalid-request');
  assert.equal(lookedUp.length + inferred.length + saved.length, 0);
});

test('a response from an earlier URL cannot issue a save ticket after SPA navigation', async () => {
  const { frame, send, inferMessage, saved, setInfer } = fixture();
  setInfer(async () => {
    frame.url = PAGE + '#today';
    return { status: 'ok', httpStatus: 200, results: [{ requestId, label: '메뉴 열기' }] };
  });
  assert.equal((await send(inferMessage(PAGE))).status, 'stale');
  const response = await send({ type: SAVE_NAMES, pageKey: frame.url, ids: [requestId] });
  assert.deepEqual(response.results, []);
  assert.equal(saved.length, 0);
});

test('reloading the same URL invalidates the former document and its save tickets', async () => {
  const { frame, send, inferMessage, saved } = fixture();
  assert.equal((await send(inferMessage(PAGE))).status, 'ok');
  frame.documentId = 'new-document';
  assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey: PAGE })).error, 'invalid-request');
  assert.equal((await send(inferMessage(PAGE))).status, 'invalid-request');
  const response = await send({ type: SAVE_NAMES, pageKey: PAGE, ids: [requestId] }, { ...sender, documentId: frame.documentId });
  assert.deepEqual(response.results, []);
  assert.equal(saved.length, 0);
});

test('a queued request is discarded if its document navigates before inference starts', async () => {
  const { frame, send, inferMessage, inferred, setInfer } = fixture();
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  setInfer(async (_settings, inputs) => {
    started();
    await pending;
    return { status: 'ok', httpStatus: 200, results: inputs.map(({ requestId }) => ({ requestId, label: '메뉴 열기' })) };
  });
  const first = send(inferMessage(PAGE));
  await running;
  const second = send(inferMessage(PAGE));
  await new Promise(setImmediate);
  frame.url = PAGE + '#today';
  release();
  assert.equal((await first).status, 'stale');
  assert.equal((await second).status, 'stale');
  assert.equal(inferred.length, 1);
});

test('unavailable browser frame information rejects the request', async () => {
  assert.equal(await isCurrentMessagePage(PAGE, sender, sender.id, async () => undefined), false);
  assert.equal(await isCurrentMessagePage(PAGE, sender, sender.id, async () => { throw new Error('closed tab'); }), false);
});

test('current document identity accepts stale sender metadata and a prior navigation error', async () => {
  const { frame, send, inferMessage, saved } = fixture();
  frame.url = 'https://app.notion.com/p/' + 'a'.repeat(32);
  frame.errorOccurred = true;
  for (const original of [
    { ...sender, url: 'https://www.notion.so/', documentLifecycle: 'prerender' },
    { ...sender, url: 'about:blank', documentLifecycle: 'cached' },
    { ...sender, url: undefined },
  ]) {
    assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey: frame.url }, original)).ok, true);
    assert.equal((await send(inferMessage(frame.url), original)).status, 'ok');
    assert.equal((await send({ type: SAVE_NAMES, pageKey: frame.url, ids: [requestId] }, original)).results[0].status, 'saved');
  }
  assert.equal(saved.length, 3);

  frame.documentId = 'replacement-document';
  assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey: frame.url })).error, 'invalid-request');
  assert.equal((await send(inferMessage(frame.url))).status, 'invalid-request');
});

test('stale sender metadata never authorizes a URL that the current document does not own', async () => {
  const { frame, send, inferMessage, lookedUp, inferred } = fixture();
  const original = { ...sender, url: 'https://app.notion.com/p/old', documentLifecycle: 'cached' };
  frame.url = 'https://app.notion.com/p/current';
  for (const pageKey of ['https://app.notion.com/p/old', 'https://app.notion.com/p/other',
    'https://www.notion.so/p/current', 'https://other.example/']) {
    assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey }, original)).error, 'invalid-request');
    assert.equal((await send(inferMessage(pageKey), original)).status, 'invalid-request');
  }
  frame.documentLifecycle = 'prerender';
  assert.equal((await send({ type: LOOKUP_PREVIOUS, pageKey: frame.url }, original)).error, 'invalid-request');
  assert.equal((await send(inferMessage(frame.url), original)).status, 'invalid-request');
  assert.equal(lookedUp.length + inferred.length, 0);
});
