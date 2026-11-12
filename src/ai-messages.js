import { AI_BATCH_SIZE, MAX_AI_PAYLOAD, inferLabels } from './ai-client.js';
import { createPageKey } from './previous-fingerprint.js';

export const INFER_NAMES = 'focusbridge:ai:infer';
export const SAVE_NAMES = 'focusbridge:ai:save';

// Only an AI result returned to the same document can be saved.
export function createAiMessageHandler({ store, extensionId, readSettings, infer = inferLabels }) {
  const completed = new Map();
  async function handle(message, sender) {
    const pageKey = createPageKey(sender.url);
    if (sender.id !== extensionId || !Number.isInteger(sender.tab?.id)
      || sender.frameId !== 0 || !sender.documentId || !pageKey || pageKey !== message.pageKey) {
      return { status: 'invalid-request' };
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
    let response;
    try {
      response = { ...await infer(settings, payloads), model: settings.model };
    } catch (error) {
      return { status: error?.name === 'TimeoutError' ? 'timeout' : 'api-error', model: settings.model };
    }
    if (response.status !== 'ok') return response;
    const current = await readSettings();
    if (!current || current.model !== settings.model || current.apiKey !== settings.apiKey) {
      return { status: 'stale', model: settings.model };
    }
    for (const { requestId, label } of response.results) {
      const fingerprint = items.find(({ payload }) => payload.requestId === requestId)?.fingerprint;
      if (!label || !fingerprint) continue;
      if (completed.size >= 512) completed.delete(completed.keys().next().value);
      completed.set(prefix + requestId, { label, fingerprint, expires: Date.now() + 60000 });
    }
    return response;
  }
  return (message, sender, sendResponse) => {
    if (message?.type !== INFER_NAMES && message?.type !== SAVE_NAMES) return false;
    handle(message, sender).then(sendResponse, (error) => {
      sendResponse({ status: error?.name === 'TimeoutError' ? 'timeout' : 'api-error' });
    });
    return true;
  };
}
