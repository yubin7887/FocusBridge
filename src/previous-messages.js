import { isCurrentMessagePage } from './message-page.js';

export const LOOKUP_PREVIOUS = 'focusbridge:previous:lookup';

// 이 메시지는 저장된 이름 조회만 처리한다.
export function createPreviousMessageHandler(store, extensionId, { getFrame } = {}) {
  async function handle(message, sender) {
    const pageKey = message.pageKey;
    if (!await isCurrentMessagePage(pageKey, sender, extensionId, getFrame)) {
      return { ok: false, error: 'invalid-request' };
    }
    try {
      return { ok: true, records: await store.lookupPage(pageKey) };
    } catch {
      return { ok: false, error: 'storage-unavailable' };
    }
  }
  return (message, sender, sendResponse) => {
    if (message?.type !== LOOKUP_PREVIOUS) return false;
    handle(message, sender).then(
      sendResponse,
      () => sendResponse({ ok: false, error: 'storage-unavailable' }),
    );
    return true;
  };
}
