const SVG_NS = 'http://www.w3.org/2000/svg';
const LOTTIE_DEFINITION = 'defs [id^="__lottie_element_"]';
const FRAME_ATTRIBUTES = new Set(['transform', 'opacity', 'fill-opacity', 'stroke-opacity', 'd', 'fill', 'stroke', 'stroke-width']);
const FRAME_NODES = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const SEMANTIC_NODES = 'a, text, title, desc, [role], [tabindex], [aria-label], [aria-labelledby]';

export function animatedSvgs(element) {
  return [...element.querySelectorAll('svg')].filter((svg) => svg.querySelector(LOTTIE_DEFINITION));
}

export function svgFrameRoot({ type, target, attributeName, oldValue }) {
  if (type !== 'attributes' || target.namespaceURI !== SVG_NS || !FRAME_NODES.has(target.localName)
    || target.matches(SEMANTIC_NODES)) return null;
  const svg = target.closest('svg');
  if (!svg?.querySelector(LOTTIE_DEFINITION)) return null;
  if (attributeName === 'style') {
    const displayOnly = (style) => !style?.trim() || /^\s*display\s*:\s*(?:block|none)\s*;?\s*$/i.test(style);
    return target.localName === 'g' && displayOnly(oldValue) && displayOnly(target.getAttribute('style'))
      && !target.querySelector(SEMANTIC_NODES) ? svg : null;
  }
  return FRAME_ATTRIBUTES.has(attributeName) ? svg : null;
}

// Compare the stable parts of an existing fingerprint only for an in-page AI request.
export function withoutSvgFrames(canonical) {
  if (!canonical?.includes('__lottie_element_')) return canonical;
  function lottieDefinition(node, insideDefs = false) {
    return (insideDefs && node.attributes?.some(([name, value]) => name === 'id'
      && typeof value === 'string' && value.startsWith('__lottie_element_')))
      || node.children?.some((child) => lottieDefinition(child, insideDefs || node.tag === 'defs'));
  }
  function visit(node, animated = false) {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'svg') animated = lottieDefinition(node);
    if (animated && node.namespace === SVG_NS && FRAME_NODES.has(node.tag)) {
      node.attributes = node.attributes.filter(([name]) => !FRAME_ATTRIBUTES.has(name));
    }
    for (const value of Object.values(node)) visit(value, animated);
  }
  const snapshot = JSON.parse(canonical);
  visit(snapshot);
  return JSON.stringify(snapshot);
}
