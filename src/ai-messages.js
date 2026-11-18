import { AI_BATCH_SIZE, MAX_AI_PAYLOAD, inferLabels } from './ai-client.js';
import { AI_MODELS } from './ai-config.js';
import { isCurrentMessagePage } from './message-page.js';
import { captureIconCrops } from './ai-capture.js';
import { buildIconSheet, iconImageData } from './ai-images.js';

export const INFER_NAMES = 'focusbridge:ai:infer';
export const SAVE_NAMES = 'focusbridge:ai:save';
export const CAPTURE_ICONS = 'focusbridge:ai:capture-icons';

// Only an AI result returned to the same document can be saved.
export function createAiMessageHandler({ store, extensionId, readSettings, storageReady, infer = inferLabels, getFrame }) {
  const completed = new Map();
  const providers = new Map();

  function requestAi(settings, payloads, images, imageStatus, iconSheet, isCurrent) {
    const { model } = settings;
    const { provider } = AI_MODELS[model];
    if (!providers.has(provider)) providers.set(provider, { queue: Promise.resolve(), requestCount: 0 });
    const state = providers.get(provider);
    const storageKey = `focusbridgeAiBlockedUntil:${provider}`;

    // Requests from multiple tabs share the provider's cooldown.
    const run = state.queue.then(async () => {
      const storage = await storageReady;
      if (!state.loaded) {
        const saved = await storage?.get(storageKey).catch(() => null);
        const block = saved?.[storageKey];
        if (Number.isFinite(block) && block > Date.now()) {
          state.block = { status: 'rate-limited', httpStatus: 429, retryAt: block };
        } else if (block?.httpStatus === 503 && Number.isFinite(block.retryAt) && block.retryAt > Date.now()) {
          state.block = { status: 'service-unavailable', httpStatus: 503, retryAt: block.retryAt };
        }
        state.loaded = true;
      }
      if (state.block?.retryAt > Date.now()) return { ...state.block, model, requestCount: state.requestCount };

      const current = await readSettings();
      if (current?.model !== model || current?.apiKey !== settings.apiKey) return { status: 'stale', model };
      if (!await isCurrent()) return { status: 'stale', model };

      const requestCount = ++state.requestCount;
      let response;
      try {
        response = await infer(settings, payloads, undefined, images, iconSheet);
      } catch (error) {
        response = { status: error?.name === 'TimeoutError' ? 'timeout' : 'api-error' };
      }
      if (Number.isFinite(response.retryAt)) {
        state.block = response;
        if (response.status === 'rate-limited') {
          await storage?.set({ [storageKey]: response.retryAt }).catch(() => {});
        } else if (provider === 'google' && response.httpStatus === 503) {
          await storage?.set({ [storageKey]: { httpStatus: 503, retryAt: response.retryAt } }).catch(() => {});
        }
      }
      console.info('[FocusBridge AI] API 요청', {
        model, requestCount, elements: payloads.length, images: iconSheet ? 1 : images.size, icons: images.size,
        imageStatus: images.size === payloads.length ? 'attached' : imageStatus,
        http: response.httpStatus ?? null, status: response.status,
      });
      return { ...response, model, requestCount };
    });
    state.queue = run.then(() => {}, () => {});
    return run;
  }

  async function handle(message, sender) {
    const pageKey = message.pageKey;
    const isCurrent = () => isCurrentMessagePage(pageKey, sender, extensionId, getFrame);
    if (!await isCurrent()) {
      return { status: 'invalid-request' };
    }
    if (message.type === CAPTURE_ICONS) {
      const settings = await readSettings();
      if (!settings?.apiKey) return { images: [], status: 'not-configured' };
      return captureIconCrops(sender, pageKey, message.viewport, message.rects, await storageReady, isCurrent)
        .catch(() => ({ images: [], status: 'capture-error' }));
    }
    const prefix = `${sender.tab.id}:${sender.documentId}:`;
    const now = Date.now();
    for (const [token, entry] of completed) {
      if (entry.expires <= now) completed.delete(token);
    }
    if (message.type === SAVE_NAMES) {
      if (!Array.isArray(message.ids) || message.ids.length > AI_BATCH_SIZE) return { status: 'invalid-request' };
      const results = [];
      for (const requestId of message.ids) {
        const token = prefix + requestId;
        const entry = completed.get(token);
        if (!entry || entry.fingerprint.pageKey !== pageKey) continue;
        completed.delete(token);
        try {
          const outcome = await store.saveAiResult({ fingerprint: entry.fingerprint, label: entry.label, source: 'ai' });
          results.push({ requestId, status: outcome.status });
        } catch { results.push({ requestId, status: 'storage-error' }); }
      }
      return { status: 'ok', results };
    }
    const items = message.items;
    if (!Array.isArray(items) || !items.length || items.length > AI_BATCH_SIZE) return { status: 'invalid-request' };
    const ids = new Set();
    for (const { payload, fingerprint } of items) {
      if (!payload || !/^[\da-f]{32}$/i.test(payload.requestId) || ids.has(payload.requestId)
        || (fingerprint && (fingerprint.eligible !== true || fingerprint.pageKey !== pageKey
          || typeof fingerprint.canonical !== 'string' || fingerprint.canonical.length > 16000))) {
        return { status: 'invalid-request' };
      }
      ids.add(payload.requestId);
    }
    const payloads = items.map(({ payload }) => payload);
    if (JSON.stringify(payloads).length > MAX_AI_PAYLOAD) return { status: 'invalid-request' };
    const settings = await readSettings();
    if (settings === null) return { status: 'storage-unavailable' };
    if (!settings.apiKey) return { status: 'not-configured', model: settings.model };
    const { maxImages = Infinity } = AI_MODELS[settings.model];
    const allImages = new Map(items.filter(({ image }) => iconImageData(image))
      .map(({ payload, image }) => [payload.requestId, image]));
    const iconSheet = allImages.size > 2 ? await buildIconSheet(allImages).catch(() => null) : null;
    const batches = [];
    let batch = { payloads: [], images: new Map() };
    for (const payload of payloads) {
      const image = allImages.get(payload.requestId);
      if (image) {
        if (!iconSheet && batch.images.size === maxImages) {
          batches.push(batch);
          batch = { payloads: [], images: new Map() };
        }
        batch.images.set(payload.requestId, image);
      }
      batch.payloads.push(payload);
    }
    batches.push(batch);
    let response;
    const results = [];
    for (const { payloads, images } of batches) {
      response = await requestAi(settings, payloads, images, message.imageStatus, iconSheet, isCurrent);
      if (response.status !== 'ok') break;
      for (const row of response.results) {
        results.push({ ...row, httpStatus: response.httpStatus, requestCount: response.requestCount });
      }
    }
    if (!results.length) return response;
    const current = await readSettings();
    if (!current || current.model !== settings.model || current.apiKey !== settings.apiKey || !await isCurrent()) {
      return { status: 'stale', model: settings.model };
    }
    for (const { requestId, label } of results) {
      const fingerprint = items.find(({ payload }) => payload.requestId === requestId)?.fingerprint;
      if (!label || !fingerprint) continue;
      if (completed.size >= 512) completed.delete(completed.keys().next().value);
      completed.set(prefix + requestId, { label, fingerprint, expires: Date.now() + 60000 });
    }
    return { ...response, results };
  }
  return (message, sender, sendResponse) => {
    if (![INFER_NAMES, SAVE_NAMES, CAPTURE_ICONS].includes(message?.type)) return false;
    handle(message, sender).then(sendResponse, (error) => {
      sendResponse({ status: error?.name === 'TimeoutError' ? 'timeout' : 'api-error' });
    });
    return true;
  };
}
