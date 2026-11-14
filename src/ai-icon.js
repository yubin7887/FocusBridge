import { findIcon } from './ai-payload.js';
import { drawIcon, ICON_SIZE, MAX_AI_IMAGES, pngData } from './ai-images.js';

const svgTags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const svgAttributes = ['viewBox', 'preserveAspectRatio', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'transform'];
const svgStyles = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'visibility', 'display', 'transform', 'transform-origin'];
const actionWords = /(?:^|[^a-z])(?:search|close|delete|menu|cart|share|play|pause|download|upload|print|save|edit|logout|login|home|next|previous|back|forward|refresh|settings|filter|zoom|expand|collapse)(?:$|[^a-z])/i;
const sensitive = 'input, textarea, select, [contenteditable], iframe, video, canvas, object, embed';
const privateGlyph = /^[\uE000-\uF8FF]$/u;

function iconCanHelp({ text, attributes, destination, icon }) {
  if ((text && !privateGlyph.test(text)) || attributes?.title || attributes?.['aria-description']
    || icon?.alt || icon?.title) return false;
  if (destination?.href?.toLowerCase() === '#top' || destination?.formAction) return false;
  return ![attributes?.['data-action'], attributes?.['data-command'], attributes?.id, attributes?.class,
    destination?.href, icon?.reference, icon?.className, icon?.src].some((value) => actionWords.test(value ?? ''));
}

function boxFor(icon) {
  const { x, y, width, height } = icon.getBoundingClientRect();
  const style = getComputedStyle(icon);
  if (width < 2 || height < 2 || width > 96 || height > 96 || style.visibility !== 'visible'
    || Number(style.opacity) === 0 || icon.closest('[hidden], [data-fb-ignore]')) return null;
  return { x, y, width, height };
}

function cssIcon(element) {
  if (/^url\(/.test(getComputedStyle(element).backgroundImage)) return true;
  return ['::before', '::after'].some((pseudo) => {
    const { content, backgroundImage, maskImage } = getComputedStyle(element, pseudo);
    return !['none', 'normal'].includes(content)
      && (content !== '""' || backgroundImage !== 'none' || maskImage !== 'none');
  });
}

function simpleSvg(svg, width, height) {
  const shapes = [svg, ...svg.querySelectorAll('*')];
  if (shapes.length < 2 || shapes.length > 48 || shapes.some((node) => !svgTags.has(node.localName))) return null;
  const copy = svg.cloneNode(true);
  const nodes = [copy, ...copy.querySelectorAll('*')];
  for (const [i, node] of nodes.entries()) {
    const original = shapes[i];
    for (const attr of [...node.attributes]) node.removeAttributeNode(attr);
    for (const attr of svgAttributes) {
      if (original.hasAttribute(attr)) node.setAttribute(attr, original.getAttribute(attr));
    }
    const style = getComputedStyle(original);
    for (const property of svgStyles) {
      const value = style.getPropertyValue(property);
      if (value.includes('url(')) return null;
      if (value) node.style.setProperty(property, value);
    }
  }
  copy.setAttribute('width', width);
  copy.setAttribute('height', height);
  copy.style.removeProperty('transform');
  copy.style.removeProperty('transform-origin');
  const xml = new XMLSerializer().serializeToString(copy);
  return xml.length <= 12000 ? 'data:image/svg+xml,' + encodeURIComponent(xml) : null;
}

async function directImage(icon, { width, height }) {
  let image = icon;
  try {
    if (icon.localName === 'svg') {
      const source = simpleSvg(icon, width, height);
      if (!source) return null;
      image = new Image();
      image.src = source;
      await Promise.race([image.decode(), new Promise((resolve) => setTimeout(resolve, 500))]);
    } else if (icon.localName !== 'img') return null;
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_SIZE;
    drawIcon(canvas, image, 0, 0, image.naturalWidth, image.naturalHeight);
    return pngData(canvas.toDataURL('image/png'));
  } catch { return null; }
}

function visibleCrop(element, icon, viewport) {
  const text = icon.textContent.trim();
  if (document.visibilityState !== 'visible' || !element.isConnected || !icon.isConnected
    || element.matches(sensitive) || icon.matches(sensitive) || icon.querySelector(sensitive)
    || element.closest(sensitive) || (text && !privateGlyph.test(text))) return null;
  const box = boxFor(icon);
  if (!box) return null;
  const { x, y, width, height } = box;
  if (x < 0 || y < 0 || x + width > viewport.width || y + height > viewport.height) return null;
  const root = icon.getRootNode();
  for (const dx of [1, width / 2, width - 1]) {
    for (const dy of [1, height / 2, height - 1]) {
      const hit = root.elementFromPoint(x + dx, y + dy);
      if (!hit || !(icon.contains(hit) || (element.contains(hit) && hit.contains(icon)))) return null;
    }
  }
  return box;
}

function currentViewport() {
  const viewport = window.visualViewport;
  if (viewport && (viewport.scale !== 1 || viewport.offsetLeft || viewport.offsetTop)) return null;
  return { width: innerWidth, height: innerHeight, scrollX, scrollY, pixelRatio: devicePixelRatio };
}

export async function collectAiIcons(work, capture) {
  const candidates = [];
  for (const { element, request } of work) {
    if (!iconCanHelp(request.payload) || !element.isConnected) continue;
    const icon = findIcon(element) || [...element.children].slice(0, 12).find(cssIcon)
      || (cssIcon(element) ? element : null);
    const box = icon && boxFor(icon);
    if (!box || icon.matches(sensitive) || icon.closest(sensitive)) continue;
    candidates.push({ element, icon, box, requestId: request.payload.requestId });
    if (candidates.length === MAX_AI_IMAGES) break;
  }
  const results = new Map();
  const fallback = [];
  const direct = await Promise.all(candidates.map(({ icon, box }) => directImage(icon, box)));
  for (const [i, candidate] of candidates.entries()) {
    if (direct[i]) results.set(candidate.requestId, () => candidate.icon.isConnected ? direct[i] : undefined);
    else fallback.push(candidate);
  }
  const viewport = fallback.length && currentViewport();
  if (!viewport || !capture) return results;
  const crops = fallback.flatMap((candidate) => {
    const rect = visibleCrop(candidate.element, candidate.icon, viewport);
    return rect ? [{ ...candidate, rect }] : [];
  });
  if (!crops.length) return results;
  try {
    const images = await capture(viewport, crops.map(({ rect }) => rect));
    if (!Array.isArray(images)) return results;
    for (const [i, { element, icon, rect, requestId }] of crops.entries()) {
      if (!images[i]) continue;
      results.set(requestId, () => {
        if (JSON.stringify(currentViewport()) === JSON.stringify(viewport)
          && JSON.stringify(visibleCrop(element, icon, viewport)) === JSON.stringify(rect)) return images[i];
      });
    }
  } catch { /* Keep the text evidence when capture is unavailable. */ }
  return results;
}
