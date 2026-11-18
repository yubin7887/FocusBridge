import { blobBase64, drawIcon, iconImageData, imageSize } from './ai-images.js';

const RASTER_TYPE = /^image\/(?:png|jpeg|gif|webp|avif)$/i;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function imageSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

async function readImage(response) {
  const type = response.headers.get('Content-Type')?.split(';')[0].trim();
  if (!response.ok || !RASTER_TYPE.test(type ?? '')
    || Number(response.headers.get('Content-Length')) > MAX_SOURCE_BYTES || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_SOURCE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return size ? new Blob(chunks, { type }) : null;
}

export async function loadSourceImages(items, isCurrent, {
  fetchImpl = fetch, permissions = globalThis.chrome?.permissions,
} = {}) {
  if (!await isCurrent()) return { images: [] };
  const sources = new Map();
  const images = await Promise.all(items.map(async ({ requestId, url: value }) => {
    const url = imageSourceUrl(value);
    if (!url) return null;
    if (!sources.has(url.href)) sources.set(url.href, (async () => {
      let bitmap;
      try {
        if (!await permissions?.contains({ origins: [url.origin + '/*'] })) return null;
        const response = await fetchImpl(url.href, {
          credentials: 'omit', redirect: 'error', cache: 'force-cache', signal: AbortSignal.timeout(5000),
        });
        const blob = await readImage(response);
        if (!blob) return null;
        bitmap = await createImageBitmap(blob);
        if (bitmap.width * bitmap.height > 16 * 1024 * 1024) return null;
        const { width, height } = imageSize(bitmap.width, bitmap.height);
        const canvas = new OffscreenCanvas(width, height);
        drawIcon(canvas, bitmap, 0, 0, bitmap.width, bitmap.height);
        const data = await blobBase64(await canvas.convertToBlob({ type: 'image/png' }));
        return iconImageData(data) ? data : null;
      } catch { return null; }
      finally { bitmap?.close(); }
    })());
    const data = await sources.get(url.href);
    return data ? { requestId, data } : null;
  }));
  return { images: await isCurrent() ? images.filter(Boolean) : [] };
}
