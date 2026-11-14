import { drawIcon, iconImageData, ICON_SIZE, MAX_AI_IMAGES, PNG_PREFIX } from './ai-images.js';
import { ICON_CAPTURE_KEY } from './ai-settings.js';

let lastCapture = -Infinity;

export async function captureIconCrops(sender, pageKey, viewport, rects, storage) {
  const { width, height, pixelRatio } = viewport ?? {};
  if (![width, height, pixelRatio].every((value) => Number.isFinite(value) && value > 0)
    || !Array.isArray(rects) || !rects.length || rects.length > MAX_AI_IMAGES) return [];
  if (rects.some((r) => !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)
    || r.x < 0 || r.y < 0 || r.width < 2 || r.height < 2 || r.width > 96 || r.height > 96
    || r.x + r.width > width || r.y + r.height > height)) return [];
  const { id, windowId } = sender.tab;
  if (!Number.isInteger(windowId) || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return [];
  if (!(await storage?.get(ICON_CAPTURE_KEY))?.[ICON_CAPTURE_KEY]
    || !await chrome.permissions.contains({ origins: ['<all_urls>'] })) return [];
  const isSourceTab = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    return active?.id === id && active.url === pageKey && !active.pendingUrl;
  };
  let invalidated = false;
  const onActivate = (info) => { if (info.windowId === windowId) invalidated = true; };
  const onUpdate = (tabId, changes) => {
    if (tabId === id && (changes.url || changes.status === 'loading')) invalidated = true;
  };
  chrome.tabs.onActivated.addListener(onActivate);
  chrome.tabs.onUpdated.addListener(onUpdate);
  let bitmap;
  try {
    if (!await isSourceTab() || invalidated || performance.now() - lastCapture < 1000) return [];
    lastCapture = performance.now();
    const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (invalidated || !await isSourceTab() || invalidated) return [];
    if (!screenshot.startsWith(PNG_PREFIX)) return [];
    const bytes = Uint8Array.from(atob(screenshot.slice(PNG_PREFIX.length)), (char) => char.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    if (Math.abs(bitmap.width - width * pixelRatio) > 2 || Math.abs(bitmap.height - height * pixelRatio) > 2) return [];
    const scaleX = bitmap.width / width;
    const scaleY = bitmap.height / height;
    return await Promise.all(rects.map(async (rect) => {
      const x = Math.ceil(rect.x * scaleX);
      const y = Math.ceil(rect.y * scaleY);
      const w = Math.floor((rect.x + rect.width) * scaleX) - x;
      const h = Math.floor((rect.y + rect.height) * scaleY) - y;
      if (w < 1 || h < 1) return null;
      const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
      drawIcon(canvas, bitmap, x, y, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > ICON_SIZE * ICON_SIZE * 4 + 1024) return null;
      const data = btoa(String.fromCharCode(...bytes));
      return iconImageData(data) ? data : null;
    }));
  } finally {
    bitmap?.close();
    chrome.tabs.onActivated.removeListener(onActivate);
    chrome.tabs.onUpdated.removeListener(onUpdate);
  }
}
