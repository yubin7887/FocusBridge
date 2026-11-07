import { createPageKey } from './previous-fingerprint.js';

export const LOOKUP_PREVIOUS = 'focusbridge:previous:lookup';

// 저장 메시지는 공개하지 않는다. AI 담당자의 결과 처리에 저장 API를 연결할 예정이다.
export function createPreviousMessageHandler(store, extensionId) {
  return (message, sender, sendResponse) => {
    if (message?.type !== LOOKUP_PREVIOUS) return false;
    const pageKey = message.pageKey;
    if (sender?.id !== extensionId || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0
      || typeof pageKey !== 'string' || pageKey.length > 16000
      || createPageKey(pageKey) !== pageKey || createPageKey(sender.url) !== pageKey) {
      sendResponse({ ok: false, error: 'invalid-request' });
      return false;
    }
    store.lookupPage(pageKey).then(
      (records) => sendResponse({ ok: true, records }),
      () => sendResponse({ ok: false, error: 'storage-unavailable' }),
    );
    return true;
  };
}
