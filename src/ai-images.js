export const ICON_SIZE = 64;
const MAX_ICON_DATA = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 512;
export const PNG_PREFIX = 'data:image/png;base64,';

export function iconImageData(value) {
  return typeof value === 'string' && value.length <= MAX_ICON_DATA
    && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value);
}

export function drawIcon(canvas, image, x, y, width, height) {
  const scale = Math.min(canvas.width / width, canvas.height / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, x, y, width, height, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

export function imageSize(width, height) {
  // Keep text in wide image buttons readable instead of shrinking everything to a 64px square.
  if (Math.max(width, height) <= 96) return { width: ICON_SIZE, height: ICON_SIZE };
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function pngData(url) {
  if (!url.startsWith(PNG_PREFIX)) return null;
  const data = url.slice(PNG_PREFIX.length);
  return iconImageData(data) ? data : null;
}

export async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(binary);
}

export async function buildIconSheet(images) {
  const decoded = [];
  try {
    for (const [requestId, data] of images) {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      decoded.push({ requestId, bitmap: await createImageBitmap(new Blob([bytes], { type: 'image/png' })) });
    }
    const columns = [ICON_SIZE + 24, ICON_SIZE + 24];
    const rows = Array(Math.ceil(decoded.length / 2)).fill(ICON_SIZE + 24);
    for (const [index, { bitmap }] of decoded.entries()) {
      columns[index % 2] = Math.max(columns[index % 2], bitmap.width + 24);
      rows[Math.floor(index / 2)] = Math.max(rows[Math.floor(index / 2)], bitmap.height + 24);
    }
    const canvas = new OffscreenCanvas(columns[0] + columns[1], rows.reduce((sum, size) => sum + size, 0));
    const context = canvas.getContext('2d');
    context.fillStyle = '#b8bdc6';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#1c212a';
    context.font = 'bold 12px sans-serif';
    context.textAlign = 'center';
    const tiles = [];
    let top = 0;
    for (const [index, { requestId, bitmap }] of decoded.entries()) {
      const column = index % 2;
      const left = column ? columns[0] : 0;
      const x = left + Math.floor((columns[column] - bitmap.width) / 2);
      const y = top + 20;
      context.fillText(String(index + 1), left + columns[column] / 2, top + 13);
      context.drawImage(bitmap, x, y);
      tiles.push({ tile: index + 1, requestId, x, y, width: bitmap.width, height: bitmap.height });
      if (column) top += rows[Math.floor(index / 2)];
    }
    return { data: await blobBase64(await canvas.convertToBlob({ type: 'image/png' })),
      width: canvas.width, height: canvas.height, tiles };
  } finally {
    for (const { bitmap } of decoded) bitmap.close();
  }
}
