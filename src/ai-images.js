export const ICON_SIZE = 64;
const MAX_ICON_DATA = 24000;
const ICON_TILE_SIZE = 88;
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

export async function buildIconSheet(images) {
  const columns = 2;
  const canvas = new OffscreenCanvas(columns * ICON_TILE_SIZE, Math.ceil(images.size / columns) * ICON_TILE_SIZE);
  const context = canvas.getContext('2d');
  context.fillStyle = '#b8bdc6';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#1c212a';
  context.font = 'bold 12px sans-serif';
  context.textAlign = 'center';

  for (const [index, data] of [...images.values()].entries()) {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const x = index % columns * ICON_TILE_SIZE;
    const y = Math.floor(index / columns) * ICON_TILE_SIZE;
    try {
      context.fillText(String(index + 1), x + ICON_TILE_SIZE / 2, y + 13);
      context.drawImage(bitmap, x + (ICON_TILE_SIZE - ICON_SIZE) / 2, y + 20, ICON_SIZE, ICON_SIZE);
    } finally {
      bitmap.close();
    }
  }

  const png = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await png.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(binary);
}
