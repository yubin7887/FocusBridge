import { createPageKey } from './previous-fingerprint.js';

export const LOOKUP_PREVIOUS = 'focusbridge:previous:lookup';

// 이 메시지는 저장된 이름 조회만 처리한다.
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
