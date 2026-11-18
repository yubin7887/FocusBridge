import { findIcon } from './ai-payload.js';
import { drawIcon, imageSize, pngData } from './ai-images.js';
import { cssIconSource } from './ai-css-icon.js';

const svgTags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const svgAttributes = ['viewBox', 'preserveAspectRatio', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'transform'];
const svgStyles = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'visibility', 'display', 'transform', 'transform-origin'];
const sensitive = 'input, textarea, select, [contenteditable], iframe, video, canvas, object, embed';

function boxFor(icon) {
  const { x, y, width, height } = icon.getBoundingClientRect();
  const style = getComputedStyle(icon);
  if (width < 2 || height < 2 || style.visibility !== 'visible'
    || Number(style.opacity) === 0 || icon.closest('[hidden], [data-fb-ignore]')) return null;
  return { x, y, width, height };
}

function cssIcon(element) {
  const { backgroundImage, maskImage } = getComputedStyle(element);
  if (backgroundImage !== 'none' || maskImage !== 'none') return true;
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
  if (!copy.hasAttribute('viewBox')) copy.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const size = imageSize(width, height);
  copy.setAttribute('width', size.width);
  copy.setAttribute('height', size.height);
  copy.style.removeProperty('transform');
  copy.style.removeProperty('transform-origin');
  const xml = new XMLSerializer().serializeToString(copy);
  return xml.length <= 12000 ? 'data:image/svg+xml,' + encodeURIComponent(xml) : null;
}

function decodeBriefly(image) {
  return Promise.race([image.decode(), new Promise((resolve) => setTimeout(resolve, 500))]);
}

function iconPng(image, requireVisible = false) {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null;
  const canvas = document.createElement('canvas');
  Object.assign(canvas, imageSize(image.naturalWidth, image.naturalHeight));
  drawIcon(canvas, image, 0, 0, image.naturalWidth, image.naturalHeight);
  if (requireVisible && !canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    .some((value, index) => index % 4 === 3 && value > 0)) return null;
  return pngData(canvas.toDataURL('image/png'));
}

async function directImage(icon, { width, height }) {
  let image = icon;
  try {
    if (icon.localName === 'svg') {
      const source = simpleSvg(icon, width, height);
      if (!source) return null;
      image = new Image();
      image.src = source;
    } else if (icon.localName !== 'img') return null;
    // Give a visible img that's still loading the same short decode window as SVGs.
    if (image !== icon || !image.complete) await decodeBriefly(image);
    try {
      return iconPng(image);
    } catch (error) {
      if (error.name !== 'SecurityError' || image.localName !== 'img' || image !== icon) return null;
      const source = new URL(icon.currentSrc || icon.src);
      if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password
        || source.origin === location.origin) return null;
      // A public CDN image can be read if its server permits anonymous CORS.
      image = new Image();
      image.crossOrigin = 'anonymous';
      image.referrerPolicy = icon.referrerPolicy;
      image.src = source.href;
      await decodeBriefly(image);
      return iconPng(image);
    }
  } catch { return null; }
}

async function cssImage(icon, box, assets) {
  if (icon.localName === 'img' || icon.localName === 'svg' || icon.querySelector(sensitive)) return null;
  try {
    const source = await cssIconSource(icon, box, assets);
    if (!source) return null;
    const image = new Image();
    image.src = source;
    await decodeBriefly(image);
    return iconPng(image, true);
  } catch { return null; }
}

function visibleCrop(element, icon, viewport) {
  if (document.visibilityState !== 'visible' || !element.isConnected || !icon.isConnected
    || element.matches(sensitive) || icon.matches(sensitive) || icon.querySelector(sensitive)
    || element.closest(sensitive)) return null;
  let box = boxFor(icon);
  if (!box) return null;
  if (icon === element && getComputedStyle(icon).borderTopLeftRadius !== '0px') {
    // Keep the crop inside rounded controls so that its corners don't include the page behind them.
    const { x, y, width, height } = box;
    box = { x: x + width * 0.16, y: y + height * 0.16, width: width * 0.68, height: height * 0.68 };
  }
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const width = Math.min(viewport.width, box.x + box.width) - left;
  const height = Math.min(viewport.height, box.y + box.height) - top;
  if (width < 2 || height < 2) return null;
  const root = icon.getRootNode();
  for (const dx of [1, width / 2, width - 1]) {
    for (const dy of [1, height / 2, height - 1]) {
      const hit = root.elementFromPoint(left + dx, top + dy);
      if (!hit || hit.closest(sensitive) || !(icon.contains(hit) || (element.contains(hit) && hit.contains(icon)))) return null;
    }
  }
  return { x: left, y: top, width, height };
}

function currentViewport() {
  const viewport = window.visualViewport;
  if (viewport && (viewport.scale !== 1 || viewport.offsetLeft || viewport.offsetTop)) return null;
  return { width: innerWidth, height: innerHeight, scrollX, scrollY, pixelRatio: devicePixelRatio };
}

export async function collectAiIcons(work, capture, loadImages) {
  const candidates = [];
  const usable = (node) => node.closest(sensitive) ? null : boxFor(node);
  for (const { element, request } of work) {
    if (!element.isConnected) continue;
    const icon = [...element.querySelectorAll('img, svg')].find(usable) || findIcon(element, usable)
      || [...element.children].find((child) => usable(child) && cssIcon(child)) || element;
    const box = usable(icon);
    if (!box) continue;
    candidates.push({ element, icon, box, requestId: request.payload.requestId });
  }
  const results = new Map();
  const fallback = [];
  const assets = new Map();
  const direct = await Promise.all(candidates.map(async ({ icon, box }) => {
    const original = await directImage(icon, box);
    if (original) return { data: original, source: icon.localName };
    const css = await cssImage(icon, box, assets);
    return css ? { data: css, source: 'css' } : null;
  }));
  for (const [i, candidate] of candidates.entries()) {
    if (direct[i]) results.set(candidate.requestId, () => candidate.icon.isConnected ? direct[i] : undefined);
    else fallback.push(candidate);
  }
  if (loadImages) {
    const sources = fallback.filter(({ icon }) => icon.localName === 'img')
      .map(({ icon, requestId }) => ({ requestId, url: icon.currentSrc || icon.src }));
    const loaded = sources.length ? await loadImages(sources).catch(() => null) : null;
    for (const { requestId, data } of loaded?.images ?? []) {
      const candidate = fallback.find((item) => item.requestId === requestId);
      if (!candidate || !data) continue;
      const source = sources.find((item) => item.requestId === requestId)?.url;
      if ((candidate.icon.currentSrc || candidate.icon.src) !== source) continue;
      results.set(requestId, () => candidate.icon.isConnected && (candidate.icon.currentSrc || candidate.icon.src) === source
        ? { data, source: 'img' } : undefined);
    }
    for (let index = fallback.length - 1; index >= 0; index--) {
      if (results.has(fallback[index].requestId)) fallback.splice(index, 1);
    }
  }
  if (!fallback.length) return { images: results, status: candidates.length === work.length ? 'direct' : 'no-visible-element' };
  if (document.visibilityState !== 'visible') return { images: results, status: 'page-hidden' };
  const viewport = currentViewport();
  if (!viewport || !capture) return { images: results, status: 'viewport-unavailable' };
  let offscreen = 0;
  const crops = fallback.flatMap((candidate) => {
    const { element, icon, requestId } = candidate;
    const { left, top, right, bottom } = element.getBoundingClientRect();
    if (right <= 0 || bottom <= 0 || left >= viewport.width || top >= viewport.height) {
      offscreen++;
      return [];
    }
    const rect = visibleCrop(element, icon, viewport);
    if (rect) return [{ element, icon, rect, requestId }];
    const elementRect = icon !== element && visibleCrop(element, element, viewport);
    return elementRect ? [{ element, icon: element, rect: elementRect, requestId }] : [];
  });
  const rejected = fallback.length - offscreen - crops.length;
  const skipStatus = rejected ? 'element-covered' : offscreen ? 'element-outside-viewport' : null;
  if (!crops.length) return { images: results, status: skipStatus };
  try {
    const { images, status } = await capture(viewport, crops.map(({ rect }) => rect));
    if (!Array.isArray(images)) return { images: results, status: 'capture-error' };
    for (const [i, { element, icon, rect, requestId }] of crops.entries()) {
      if (!images[i]) continue;
      results.set(requestId, () => {
        if (JSON.stringify(currentViewport()) === JSON.stringify(viewport)
          && JSON.stringify(visibleCrop(element, icon, viewport)) === JSON.stringify(rect)) {
          return { data: images[i], source: 'capture' };
        }
      });
    }
    return { images: results, status: status === 'captured' && skipStatus ? skipStatus : status };
  } catch { return { images: results, status: 'capture-error' }; }
}
