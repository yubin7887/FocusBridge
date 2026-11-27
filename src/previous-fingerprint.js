// Previous Matching 1단계: DOM을 수정하거나 저장하지 않고 비교용 스냅샷만 만든다.
import { checkName } from './detector.js';
import { collectRoots } from './collector.js';
import { buildAiEvidence } from './ai-payload.js';

export const FINGERPRINT_VERSION = 2;
const MAX_NODES = 200;
const MAX_LENGTH = 16000;
const MAX_CANDIDATES = 2000;
const ATTRS = new Set([
  'id', 'class', 'role', 'type', 'href', 'xlink:href', 'src', 'srcset', 'alt',
  'title', 'name', 'target', 'rel', 'download', 'form', 'action', 'formaction',
  'method', 'formmethod', 'disabled', 'hidden', 'inert', 'tabindex', 'lang', 'dir',
  'data-action', 'data-command', 'data-type',
  'd', 'points', 'viewBox', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height',
  'x1', 'x2', 'y1', 'y2', 'fill', 'stroke', 'transform',
]);
const REFERENCES = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'form'];
const DIRECT_ICON = 'img[src], svg path[d], svg polygon[points], svg rect[width][height], svg circle[r], svg line[x2][y2], svg polyline[points]';
const ICON = `${DIRECT_ICON}, svg use[href], svg use[xlink\\:href], i[class], [class*="icon"]`;
const SHARED_LINK_ATTRIBUTES = new Set(['href', 'class', 'target', 'rel', 'lang', 'dir', 'title', 'tabindex', 'aria-label', 'aria-description']);
const LINK_GRAPHICS = 'span, img, picture, source, svg, g, path, polygon, polyline, circle, ellipse, rect, line, use, title, desc';
// These classes describe scroll positioning on containers, not the control's action.
const SCROLL_LAYOUT_CLASSES = new Set([
  'scrolled', 'is-scrolled', 'is-sticky', 'sticky-top', 'fixed-top',
  'coursemos-coursepage-courseheader-show',
  'coursemos-headroom-pin', 'coursemos-headroom-unpin',
  'headroom--pinned', 'headroom--unpinned', 'headroom--top', 'headroom--not-top',
  'headroom--bottom', 'headroom--not-bottom',
]);
const fail = (reason) => ({ eligible: false, reason });
const classTokens = (value) => [...new Set(value.split(/\s+/).filter(Boolean))].sort();

/** 쿼리·해시·순서를 유지하고 다른 페이지와 기록을 공유하지 않는다. */
export function createPageKey(href) {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function attributes(el, ancestor, disabledImageButton) {
  return [...el.attributes]
    .filter((a) => (ATTRS.has(a.name) || a.name.startsWith('aria-'))
      && !(disabledImageButton && a.name === 'disabled'))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .flatMap((a) => {
      if (a.name !== 'class') return [[a.name, a.value]];
      const tokens = classTokens(a.value).filter((token) => !disabledImageButton || token !== 'opacity-50');
      if (!tokens.length && disabledImageButton) return [];
      if (!ancestor) return [[a.name, tokens]];
      const stable = tokens.filter((token) => !SCROLL_LAYOUT_CLASSES.has(token));
      return stable.length ? [[a.name, stable]] : [];
    });
}

function describe(el, ancestor = false, allowInvalidUrls = false) {
  // An image-only button still selects the same image when processing briefly disables it.
  const disabledImageButton = el.matches('button[disabled]') && el.children.length === 1
    && el.firstElementChild.matches('img[src]') && !el.textContent.trim()
    && el.classList.contains('opacity-50');
  return {
    tag: el.localName,
    namespace: el.namespaceURI,
    attributes: attributes(el, ancestor, disabledImageButton),
    // 입력 내용(value)은 수집하지 않고 조작 상태만 비교한다.
    state: {
      disabled: disabledImageButton ? false : 'disabled' in el ? el.disabled : null,
      checked: 'checked' in el ? el.checked : null,
      selected: 'selected' in el ? el.selected : null,
      open: 'open' in el ? el.open : null,
    },
    urls: ['href', 'src', 'action', 'formaction'].filter((a) => el.hasAttribute(a)).map((a) => {
      try { return [a, new URL(el.getAttribute(a), el.baseURI).href]; }
      catch (error) {
        if (!allowInvalidUrls) throw error;
        return [a, null]; // The original value is still present in attributes.
      }
    }),
  };
}

// 크기 초과 시 잘라내지 않고 실패한다. 입력 내용과 확장 UI는 수집하지 않는다.
function tree(el, { context = false, allowInvalidUrls = false } = {}) {
  let count = 0;
  function visit(node) {
    if (++count > MAX_NODES) throw new Error('context-too-large');
    if (node.nodeType === 3) return { text: node.data };
    if (node.nodeType !== 1) return null;
    if (node.hasAttribute('data-fb-ignore')) return null;
    if (node.matches('script, style, template')) return null;
    if (node.isContentEditable || node.matches('input, textarea, select')) {
      if (context) return { ...describe(node, false, allowInvalidUrls), editable: true };
      throw new Error('editable-context');
    }
    // 외부 문서·그림·수집하지 않은 shadow subtree는 같다고 추측하지 않는다.
    if (node.matches('iframe, canvas, object, embed') || node.shadowRoot) {
      throw new Error('unsupported-context');
    }
    return { ...describe(node, false, allowInvalidUrls), children: [...node.childNodes].map(visit).filter(Boolean) };
  }
  const result = visit(el);
  if (JSON.stringify(result).length > MAX_LENGTH) throw new Error('context-too-large');
  return result;
}

function pathOf(el) {
  if (el.id && el.getRootNode().querySelectorAll(`#${CSS.escape(el.id)}`).length !== 1) {
    throw new Error('duplicate-id');
  }
  const path = [];
  for (let node = el; node; ) {
    const root = node.getRootNode();
    // Ancestor IDs are context attributes. The full path also records each node's position.
    const description = describe(node, node !== el);
    if (node !== el && node.parentElement === node.ownerDocument.body) {
      // Independently mounted widgets can shift a page wrapper's absolute index.
      const signature = JSON.stringify(description);
      let matchingSiblingIndex = 0;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName && !sibling.hasAttribute('data-fb-ignore')
          && JSON.stringify(describe(sibling, true, true)) === signature) matchingSiblingIndex++;
      }
      path.unshift({ ...description, matchingSiblingIndex });
    } else {
      const siblings = node.parentNode?.children;
      path.unshift({ ...description, index: siblings ? [...siblings].indexOf(node) : 0 });
    }
    if (path.length > 64) throw new Error('context-too-large');
    if (node.parentElement) node = node.parentElement;
    else if (root.host) { path.unshift({ boundary: 'shadow' }); node = root.host; }
    else node = null;
  }
  return path;
}

function referenceContext(el) {
  const root = el.getRootNode();
  return REFERENCES.filter((attr) => el.hasAttribute(attr)).map((attr) => ({
    attr,
    targets: el.getAttribute(attr).trim().split(/\s+/).filter(Boolean).map((id) => {
      const matches = root.querySelectorAll(`#${CSS.escape(id)}`);
      if (matches.length !== 1) throw new Error('ambiguous-reference');
      return tree(matches[0], { context: true });
    }),
  }));
}

function hasIconIdentity(el) {
  const parent = el.parentElement || el.getRootNode().host;
  return ['id', 'class'].some((a) => el.getAttribute(a)?.trim())
    && ['id', 'class', 'role'].some((a) => parent?.getAttribute(a)?.trim());
}

function explicitAction(el) {
  return ['data-action', 'data-command'].some((a) => el.getAttribute(a)?.trim());
}

function navigationUrl(el) {
  if (!el.matches('a[href]')) return null;
  const raw = el.getAttribute('href').trim();
  if (!raw || raw.startsWith('#')) return null;
  const url = new URL(raw, el.baseURI);
  return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
}

function hasActionEvidence(el, destination) {
  // 명시적 동작 정보 또는 서로 다른 종류의 식별 단서 조합을 요구한다.
  return destination || explicitAction(el) || (hasIconIdentity(el) && !!el.querySelector(ICON));
}

function hasUniqueParentId(el) {
  const parent = el.parentElement;
  return !!parent?.id && el.getRootNode().querySelectorAll(`#${CSS.escape(parent.id)}`).length === 1;
}

function graphicsOf(style, allowGradient) {
  const { backgroundImage, maskImage } = style;
  const background = backgroundImage.includes('url(') || (allowGradient && backgroundImage.includes('gradient('))
    ? [backgroundImage, style.backgroundPosition, style.backgroundSize, style.backgroundRepeat] : null;
  const mask = maskImage !== 'none' ? [maskImage, style.maskPosition, style.maskSize, style.maskRepeat] : null;
  return background || mask ? { background, mask } : null;
}

function cssButtonEvidence(el) {
  const win = el.ownerDocument.defaultView;
  const style = win.getComputedStyle(el);
  const toggle = /^(true|false)$/.test(el.getAttribute('aria-pressed'));
  const popup = /^(true|menu|listbox|tree|grid|dialog)$/.test(el.getAttribute('aria-haspopup'));
  const swatch = toggle || popup;
  const color = toggle && el.style.backgroundColor && /^rgb\(\d+, \d+, \d+\)$/.test(style.backgroundColor)
    ? style.backgroundColor : null;
  const pseudoGraphic = (node, pseudo) => {
    const pseudoStyle = win.getComputedStyle(node, pseudo);
    return ['none', 'normal'].includes(pseudoStyle.content) ? null : graphicsOf(pseudoStyle, swatch);
  };
  const graphics = [graphicsOf(style, swatch), pseudoGraphic(el, '::before'), pseudoGraphic(el, '::after')];
  if (el.children.length === 1) {
    const child = el.firstElementChild;
    graphics.push(graphicsOf(win.getComputedStyle(child), swatch), pseudoGraphic(child, '::before'), pseudoGraphic(child, '::after'));
  }
  return color || graphics.some(Boolean) ? { color, graphics } : null;
}

function samePageFragment(link, pageUrl) {
  try {
    const url = new URL(link.getAttribute('href'), link.baseURI);
    const raw = url.hash.slice(1);
    url.hash = '';
    return raw && url.href === pageUrl ? { raw, decoded: decodeURIComponent(raw) } : null;
  } catch { return null; }
}

function fragmentEvidenceFailure(el, pageKey) {
  if (!el.matches('a[href]:not([download])')) return 'insufficient-evidence';
  const doc = el.ownerDocument;
  const pageUrl = pageKey.split('#', 1)[0];
  const destination = samePageFragment(el, pageUrl);
  if (!destination || destination.decoded.includes(':~:')) return 'insufficient-evidence';

  const targetSelector = [destination.raw, destination.decoded].map((id) => {
    const escaped = CSS.escape(id);
    return `[id="${escaped}"], a[name="${escaped}"]`;
  }).join(', ');
  const targets = doc.querySelectorAll(targetSelector);
  // HTML의 #top은 대상 요소가 없어도 문서의 시작을 가리킨다.
  const isTop = destination.decoded.toLowerCase() === 'top';
  if (targets.length > 1) return 'ambiguous-reference';
  if (!targets.length && !isTop) return 'insufficient-evidence';

  let candidateCount = 0;
  for (const root of collectRoots(doc)) {
    const links = root.querySelectorAll('a[href]');
    candidateCount += links.length;
    if (candidateCount > MAX_CANDIDATES) return 'too-many-candidates';
    for (const other of links) {
      if (other === el || other.closest('[data-fb-ignore]')) continue;
      const fragment = samePageFragment(other, pageUrl)?.decoded;
      if (fragment === destination.decoded || (isTop && fragment?.toLowerCase() === 'top')) {
        return 'ambiguous-element';
      }
    }
  }
  return null;
}

function nearbyContext(el, hasExplicitAction) {
  const parent = el.parentElement;
  const siblingContext = (sibling) => {
    if (!sibling) return null;
    try { return tree(sibling, { context: true, allowInvalidUrls: true }); }
    catch (error) {
      if (!hasExplicitAction || !sibling.matches('[hidden], [aria-hidden="true"]')
        || !['context-too-large', 'unsupported-context'].includes(error.message)) throw error;
      return { ...describe(sibling, false, true), omittedHiddenContents: true };
    }
  };
  return {
    parent: parent ? describe(parent, true) : null,
    // 부모 전체 하위 트리 대신 직접 텍스트와 바로 앞뒤 요소만 비교한다.
    parentText: parent ? [...parent.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data) : [],
    previous: siblingContext(el.previousElementSibling),
    next: siblingContext(el.nextElementSibling),
  };
}

function sharedLinkEvidence(el, name) {
  return {
    evidence: buildAiEvidence(el, { ...name, currentName: name.name }),
    visual: cssButtonEvidence(el),
    language: el.closest('[lang]')?.getAttribute('lang') ?? null,
  };
}

function canShareLink(el, destination, name) {
  return destination && !destination.includes('#') && createPageKey(destination) && name.role === 'link'
    && el.getRootNode() === el.ownerDocument
    && [...el.attributes].every(({ name }) => SHARED_LINK_ATTRIBUTES.has(name))
    && [...el.querySelectorAll('*')].every((child) => child.matches(LINK_GRAPHICS)
      && [...child.attributes].every(({ name }) => (ATTRS.has(name) && !['role', 'tabindex', 'data-action', 'data-command', 'data-type'].includes(name))
        || name === 'aria-hidden' || name === 'xmlns'));
}

/**
 * eligible:false는 다음 매칭으로 넘긴다는 뜻이다. 이름이나 DOM은 변경하지 않는다.
 * 관찰한 DOM의 일치이며, 이벤트 핸들러의 기능까지 같다는 보장은 없다.
 */
export function createFingerprint(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return fail('detached');
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win || win !== win.top) return fail('iframe');
  const pageKey = createPageKey(win.location.href);
  if (!pageKey) return fail('unsupported-page');
  try {
    const name = checkName(el);
    if (name.status === 'ok') return fail('already-named');
    const destination = navigationUrl(el);
    let visual;
    if (!hasActionEvidence(el, destination)) {
      const button = el.localName === 'button' || name.role === 'button';
      const uniqueParent = button && hasUniqueParentId(el);
      if (button && (hasIconIdentity(el) || uniqueParent)) visual = cssButtonEvidence(el);
      if (!visual && !(uniqueParent && el.querySelector(DIRECT_ICON))) {
        const reason = fragmentEvidenceFailure(el, pageKey);
        if (reason) return fail(reason);
      }
    }
    const element = tree(el);
    const identity = JSON.stringify(element);
    const visualIdentity = visual ? JSON.stringify(visual) : null;
    // Element descriptions already require the raw href to match exactly.
    const href = el.getAttribute('href');
    const selector = destination && !href.includes('\0') ? `a[href="${CSS.escape(href)}"]` : el.localName;
    const candidates = el.getRootNode().querySelectorAll(selector);
    if (candidates.length > MAX_CANDIDATES) return fail('too-many-candidates');
    const description = JSON.stringify(describe(el));
    let linkGroup;
    // Only equivalent navigation links can share one record across locations.
    for (const other of candidates) {
      if (other === el || other.closest('[data-fb-ignore]')) continue;
      try {
        if (JSON.stringify(describe(other, false, true)) !== description) continue;
        if (JSON.stringify(tree(other)) !== identity) continue;
        if (visualIdentity && JSON.stringify(cssButtonEvidence(other)) !== visualIdentity) continue;
        if (other.outerHTML !== el.outerHTML) return fail('ambiguous-element');
        if (!linkGroup) {
          if (!canShareLink(el, destination, name)) return fail('ambiguous-element');
          linkGroup = sharedLinkEvidence(el, name);
        }
        if (JSON.stringify(sharedLinkEvidence(other, checkName(other))) !== JSON.stringify(linkGroup)) return fail('ambiguous-element');
      } catch {
        // 읽지 못하는 후보를 다르다고 가정하지 않는다.
        return fail('ambiguous-candidate');
      }
    }
    const path = pathOf(el);
    const references = referenceContext(el);
    const payload = {
      pageKey,
      version: FINGERPRINT_VERSION,
      name,
      element,
      ...(linkGroup ? { path: [], linkGroup, references } : {
        ...(visual ? { visual } : {}), path, context: nearbyContext(el, destination || explicitAction(el)), references,
      }),
    };
    const canonical = JSON.stringify(payload);
    if (canonical.length > MAX_LENGTH) return fail('context-too-large');
    return { eligible: true, version: FINGERPRINT_VERSION, pageKey, canonical, ...(linkGroup ? { sharedLink: true } : {}) };
  } catch (error) {
    return fail(error.message || 'unsupported-context');
  }
}

/** DB 연결 전 완전 일치 비교. 만료·출처·충돌 확인은 저장소와 매칭 모듈의 역할이다. */
export function exactFingerprintMatch(saved, current) {
  return Boolean(saved?.eligible === true && current?.eligible === true
    && saved.version === FINGERPRINT_VERSION && current.version === FINGERPRINT_VERSION
    && typeof saved.pageKey === 'string' && saved.pageKey === current.pageKey
    && typeof saved.canonical === 'string' && saved.canonical.length > 0
    && saved.canonical === current.canonical);
}
