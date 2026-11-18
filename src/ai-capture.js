import { AI_BATCH_SIZE } from './ai-client.js';
import { blobBase64, drawIcon, iconImageData, imageSize, PNG_PREFIX } from './ai-images.js';
import { ICON_CAPTURE_KEY } from './ai-settings.js';

// Chrome allows up to two calls per second, shared across tabs.
const CAPTURE_INTERVAL_MS = 550;
let nextCaptureAt = 0;
const skipped = (status) => ({ status, images: [] });

export async function captureIconCrops(sender, pageKey, viewport, rects, storage, isCurrent) {
  const { width, height, pixelRatio } = viewport ?? {};
  if (![width, height, pixelRatio].every((value) => Number.isFinite(value) && value > 0)
    || !Array.isArray(rects) || !rects.length || rects.length > AI_BATCH_SIZE) return skipped('invalid-viewport');
  if (rects.some((r) => !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)
    || r.x < 0 || r.y < 0 || r.width < 2 || r.height < 2
    || r.x + r.width > width || r.y + r.height > height)) return skipped('invalid-crop');
  const { id, windowId } = sender.tab;
  if (!Number.isInteger(windowId)) return skipped('inactive-tab');
  if (!(await storage?.get(ICON_CAPTURE_KEY))?.[ICON_CAPTURE_KEY]) return skipped('capture-disabled');
  if (!await chrome.permissions.contains({ origins: ['<all_urls>'] })) return skipped('capture-permission-missing');
  const isSourceTab = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    return active?.id === id && active.url === pageKey && !active.pendingUrl && await isCurrent();
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
    while (true) {
      if (invalidated || !await isSourceTab() || invalidated) return skipped('tab-changed');
      const wait = nextCaptureAt - performance.now();
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    nextCaptureAt = performance.now() + CAPTURE_INTERVAL_MS;
    const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (invalidated || !await isSourceTab() || invalidated) return skipped('tab-changed');
    if (!screenshot?.startsWith(PNG_PREFIX)) return skipped('invalid-screenshot');
    const bytes = Uint8Array.from(atob(screenshot.slice(PNG_PREFIX.length)), (char) => char.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    if (Math.abs(bitmap.width - width * pixelRatio) > 2 || Math.abs(bitmap.height - height * pixelRatio) > 2) {
      return skipped('viewport-size-mismatch');
    }
    const scaleX = bitmap.width / width;
    const scaleY = bitmap.height / height;
    const images = await Promise.all(rects.map(async (rect) => {
      const x = Math.ceil(rect.x * scaleX);
      const y = Math.ceil(rect.y * scaleY);
      const w = Math.floor((rect.x + rect.width) * scaleX) - x;
      const h = Math.floor((rect.y + rect.height) * scaleY) - y;
      if (w < 1 || h < 1) return null;
      const { width, height } = imageSize(w, h);
      const canvas = new OffscreenCanvas(width, height);
      drawIcon(canvas, bitmap, x, y, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const data = await blobBase64(blob);
      return iconImageData(data) ? data : null;
    }));
    return { status: images.every(Boolean) ? 'captured' : 'invalid-crop', images };
  } finally {
    bitmap?.close();
    chrome.tabs.onActivated.removeListener(onActivate);
    chrome.tabs.onUpdated.removeListener(onUpdate);
  }
}
