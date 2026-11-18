import { createPageKey } from './previous-fingerprint.js';

export async function isCurrentMessagePage(pageKey, sender, extensionId,
  getFrame = (details) => globalThis.chrome?.webNavigation?.getFrame(details)) {
  if (sender?.id !== extensionId || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0
    || sender.frameId !== 0 || typeof sender.documentId !== 'string' || !sender.documentId
    || typeof pageKey !== 'string' || pageKey.length > 16000
    || createPageKey(pageKey) !== pageKey) return false;

  try {
    // Sender metadata and prior navigation errors can outlive the state they describe.
    // The browser's current top-level document must own this exact URL and document ID.
    const frame = await getFrame({ tabId: sender.tab.id, frameId: 0 });
    return frame?.documentId === sender.documentId && frame.documentLifecycle === 'active'
      && createPageKey(frame.url) === pageKey;
  } catch {
    return false;
  }
}
