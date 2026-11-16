import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLabels } from '../src/ai-client.js';
import { createAiMessageHandler, INFER_NAMES, SAVE_NAMES } from '../src/ai-messages.js';
import { readAiSettings } from '../src/ai-settings.js';

const MODEL = 'qwen/qwen3.8-27b';
const PAGE = 'https://example.com/shop';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=';
const sender = { id: 'test-extension', tab: { id: 1 }, frameId: 0, documentId: 'doc', url: PAGE };
const items = Array.from({ length: 8 }, (_, index) => ({
  payload: { requestId: (index + 1).toString(16).padStart(32, '0') },
  fingerprint: { eligible: true, pageKey: PAGE, canonical: '{}' },
  image: PNG,
}));

function fixture({ rateLimitAt } = {}) {
  const state = { aiModel: MODEL, groqApiKey: 'test-groq-key', geminiApiKey: 'test-gemini-key' };
  const storage = {
    get: async (keys) => Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, state[key]])) : { [keys]: state[keys] },
    set: async (values) => Object.assign(state, values),
  };
  const requests = [];
  const saved = [];
  const fetchImpl = async (url, { headers, body }) => {
    const request = JSON.parse(body);
    requests.push({ url, headers, request });
    if (requests.length === rateLimitAt) return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
    const groq = request.model === MODEL;
    const content = groq ? request.messages[1].content : request.contents[0].parts;
    const inputs = JSON.parse(typeof content === 'string' ? content : content[0].text);
    const results = inputs.map(({ requestId }) => ({ requestId, label: '메뉴 열기' }));
    if (groq) {
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] });
    }
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(results) }] } }] });
  };
  const handler = createAiMessageHandler({
    extensionId: sender.id,
    store: { saveAiResult: async (result) => { saved.push(result); return { status: 'saved' }; } },
    storageReady: Promise.resolve(storage),
    readSettings: () => readAiSettings(storage),
    infer: (settings, payloads, _, images) => inferLabels(settings, payloads, fetchImpl, images),
  });
  const send = (type, fields) => new Promise((resolve) => handler({ type, pageKey: PAGE, ...fields }, sender, resolve));
  return { state, requests, saved, send };
}

test('Groq sends all eight icons in batches of three, with the correct IDs and key', async () => {
  const { requests, saved, send } = fixture();
  const response = await send(INFER_NAMES, { items });
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.results.map(({ requestId }) => requestId), items.map(({ payload }) => payload.requestId));
  assert.deepEqual(response.results.map(({ requestCount }) => requestCount), [1, 1, 1, 2, 2, 2, 3, 3]);
  const imageCounts = requests.map(({ url, headers, request }) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(headers.Authorization, 'Bearer test-groq-key');
    assert.equal(headers['x-goog-api-key'], undefined);
    assert.equal(request.model, MODEL);
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    const parts = request.messages[1].content;
    const ids = JSON.parse(parts[0].text).map(({ requestId }) => requestId);
    const images = parts.filter(({ type }) => type === 'image_url');
    assert.ok(images.every(({ image_url }) => image_url.url === 'data:image/png;base64,' + PNG));
    assert.deepEqual(parts.slice(1).filter(({ type }) => type === 'text').map(({ text }) => text.split(' ').at(-1)), ids);
    return images.length;
  });
  assert.deepEqual(imageCounts, [3, 3, 2]);
  assert.equal(saved.length, 0);
  const outcome = await send(SAVE_NAMES, { ids: response.results.map(({ requestId }) => requestId) });
  assert.equal(outcome.results.filter(({ status }) => status === 'saved').length, 8);
});

test('Groq keeps eight elements with only two valid images in one request', async () => {
  const { requests, send } = fixture();
  const sparseImages = items.map((item, index) => ({ ...item, image: index < 2 ? PNG : undefined }));
  const response = await send(INFER_NAMES, { items: sparseImages });
  assert.equal(response.status, 'ok');
  assert.equal(response.results.length, 8);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.messages[1].content.filter(({ type }) => type === 'image_url').length, 2);
});

test('Groq 429 stops later batches, retains earlier results, and leaves Gemini available', async () => {
  const { state, requests, send } = fixture({ rateLimitAt: 2 });
  const response = await send(INFER_NAMES, { items });
  assert.equal(response.status, 'rate-limited');
  assert.equal(response.httpStatus, 429);
  assert.deepEqual(response.results.map(({ httpStatus }) => httpStatus), [200, 200, 200]);
  assert.deepEqual(response.results.map(({ requestId }) => requestId), items.slice(0, 3).map(({ payload }) => payload.requestId));
  assert.equal((await send(INFER_NAMES, { items })).status, 'rate-limited');
  assert.equal(requests.length, 2);

  delete state.aiModel;
  const gemini = await send(INFER_NAMES, { items });
  assert.equal(gemini.model, 'gemini-3.5-flash-lite');
  assert.equal(gemini.status, 'ok');
  assert.equal(gemini.results.length, 8);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].headers['x-goog-api-key'], 'test-gemini-key');
  assert.equal(requests[2].request.contents[0].parts.filter(({ inlineData }) => inlineData).length, 8);
});
