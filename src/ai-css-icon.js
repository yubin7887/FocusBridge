import { imageSize } from './ai-images.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const RASTER_TYPE = /^image\/(?:png|jpeg|gif|webp|avif)$/i;
const MAX_ASSET_BYTES = 256 * 1024;
const imageProperties = ['background-image', 'mask-image'];
const paintProperties = [
  'background-color', 'background-position', 'background-size', 'background-repeat', 'background-origin', 'background-clip',
  'mask-position', 'mask-size', 'mask-repeat', 'mask-origin', 'mask-clip', 'mask-mode', 'mask-composite',
  'border', 'border-radius', 'padding', 'opacity',
];
const pseudoProperties = [
  'display', 'position', 'inset', 'width', 'height', 'box-sizing', 'margin', 'transform', 'transform-origin', 'z-index',
];

async function readAsset(url) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(500) });
  if (!response.ok || !RASTER_TYPE.test(response.headers.get('Content-Type')?.split(';')[0] ?? '')
    || Number(response.headers.get('Content-Length')) > MAX_ASSET_BYTES) return null;
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_ASSET_BYTES) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reader.onabort = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function embedImage(value, base, assets) {
  if (value === 'none') return value;
  if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(value)
    && !/(?:url|image(?:-set)?|element|paint|cross-fade)\s*\(/i.test(value)) return value;
  const source = /^url\("([^"\\]+)"\)$/i.exec(value)?.[1];
  if (!source) return null;
  const url = new URL(source, base);
  if (url.protocol === 'data:') {
    return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(source)
      && source.length <= MAX_ASSET_BYTES * 4 / 3 ? value : null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (!assets.has(url.href)) assets.set(url.href, readAsset(url.href).catch(() => null));
  const data = await assets.get(url.href);
  return data ? `url("${data}")` : null;
}

function copyProperties(to, from, properties) {
  for (const property of properties) to.setProperty(property, from.getPropertyValue(property));
}

export async function cssIconSource(icon, { width, height }, assets) {
  const style = getComputedStyle(icon);
  const pseudos = ['::before', '::after'].map((name) => getComputedStyle(icon, name))
    .filter(({ content, display, visibility, opacity }) => content !== 'none' && content !== 'normal'
      && display !== 'none' && visibility === 'visible' && Number(opacity) > 0);
  const styles = [style, ...pseudos];
  const colorSwatch = icon.localName === 'button' && icon.hasAttribute('aria-pressed')
    && icon.style.backgroundColor && !icon.textContent.trim() && !icon.children.length;
  if (pseudos.some(({ content, position }) => content !== '""' || position === 'fixed' || position === 'sticky')
    || (!colorSwatch && !styles.some((layer) => imageProperties.some((property) => layer.getPropertyValue(property) !== 'none')))) {
    return null;
  }

  // Serialize only empty boxes and the paint properties needed for backgrounds and sprites.
  const doc = icon.ownerDocument;
  const layers = await Promise.all(styles.map(async (layer, index) => {
    const node = doc.createElementNS(HTML_NS, 'div');
    copyProperties(node.style, layer, paintProperties);
    if (index) copyProperties(node.style, layer, pseudoProperties);
    for (const property of imageProperties) {
      const image = await embedImage(layer.getPropertyValue(property), icon.baseURI, assets);
      if (image === null) return null;
      node.style.setProperty(property, image);
    }
    return node;
  }));
  if (layers.some((node) => !node)) return null;
  const [root, ...children] = layers;
  Object.assign(root.style, { width: `${width}px`, height: `${height}px`, boxSizing: 'border-box', position: 'relative',
    overflow: 'hidden' });
  root.append(...children);

  const svg = doc.createElementNS(SVG_NS, 'svg');
  const size = imageSize(width, height);
  svg.setAttribute('width', size.width);
  svg.setAttribute('height', size.height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const foreign = doc.createElementNS(SVG_NS, 'foreignObject');
  foreign.setAttribute('width', width);
  foreign.setAttribute('height', height);
  foreign.append(root);
  svg.append(foreign);
  return 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
}
