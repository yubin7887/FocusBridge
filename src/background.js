import { createPreviousStore } from './previous-store.js';
import { createPreviousMessageHandler } from './previous-messages.js';
import { createAiMessageHandler } from './ai-messages.js';
import { readAiSettings, restrictKeyAccess } from './ai-settings.js';

const store = createPreviousStore();
chrome.runtime.onMessage.addListener(createPreviousMessageHandler(store, chrome.runtime.id));
const keyStorage = restrictKeyAccess().catch(() => null);
chrome.runtime.onMessage.addListener(createAiMessageHandler({
  store,
  extensionId: chrome.runtime.id,
  storageReady: keyStorage,
  readSettings: async () => {
    const storage = await keyStorage;
    return storage ? readAiSettings(storage) : null;
  },
}));
