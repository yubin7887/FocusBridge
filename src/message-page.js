import { createPageKey } from './previous-fingerprint.js';

export async function isCurrentMessagePage(pageKey, sender, extensionId,
  getFrame = (details) => globalThis.chrome?.webNavigation?.getFrame(details)) {
  const originalPage = createPageKey(sender?.url);
  if (sender?.id !== extensionId || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0
    || sender.frameId !== 0 || typeof sender.documentId !== 'string' || !sender.documentId
    || (sender.documentLifecycle && sender.documentLifecycle !== 'active')
    || typeof pageKey !== 'string' || pageKey.length > 16000
    || !originalPage || createPageKey(pageKey) !== pageKey
    || new URL(originalPage).origin !== new URL(pageKey).origin) return false;

  try {
    // sender.url can retain the original URL after a same-document navigation.
    const frame = await getFrame({ tabId: sender.tab.id, frameId: 0 });
    return frame?.documentId === sender.documentId && frame.documentLifecycle === 'active'
      && !frame.errorOccurred && createPageKey(frame.url) === pageKey;
  } catch {
    return false;
  }
}
