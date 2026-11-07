import { createPreviousStore } from './previous-store.js';
import { createPreviousMessageHandler } from './previous-messages.js';

const store = createPreviousStore();
chrome.runtime.onMessage.addListener(createPreviousMessageHandler(store, chrome.runtime.id));
