export const ICON_SIZE = 64;
export const MAX_AI_IMAGES = 4;
const MAX_ICON_DATA = 24000;
export const PNG_PREFIX = 'data:image/png;base64,';

export function iconImageData(value) {
  return typeof value === 'string' && value.length <= MAX_ICON_DATA
    && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value);
}

export function drawIcon(canvas, image, x, y, width, height) {
  const scale = ICON_SIZE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, x, y, width, height, (ICON_SIZE - w) / 2, (ICON_SIZE - h) / 2, w, h);
}

export function pngData(url) {
  if (!url.startsWith(PNG_PREFIX)) return null;
  const data = url.slice(PNG_PREFIX.length);
  return iconImageData(data) ? data : null;
}
