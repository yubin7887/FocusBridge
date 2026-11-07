// Previous Matching 1단계: DOM을 수정하거나 저장하지 않고 비교용 스냅샷만 만든다.
import { checkName } from './detector.js';

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

function attributes(el) {
  return [...el.attributes]
    .filter((a) => ATTRS.has(a.name) || a.name.startsWith('aria-'))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map((a) => [a.name, a.name === 'class' ? classTokens(a.value) : a.value]);
}

function describe(el) {
  return {
    tag: el.localName,
    namespace: el.namespaceURI,
    attributes: attributes(el),
    // 입력 내용(value)은 수집하지 않고 조작 상태만 비교한다.
    state: {
      disabled: 'disabled' in el ? el.disabled : null,
      checked: 'checked' in el ? el.checked : null,
      selected: 'selected' in el ? el.selected : null,
      open: 'open' in el ? el.open : null,
    },
    urls: ['href', 'src', 'action', 'formaction'].filter((a) => el.hasAttribute(a))
      .map((a) => [a, new URL(el.getAttribute(a), el.baseURI).href]),
  };
}

// 크기 초과 시 잘라내지 않고 실패한다. 입력 내용과 확장 UI는 수집하지 않는다.
function tree(el, { context = false } = {}) {
  let count = 0;
  function visit(node) {
    if (++count > MAX_NODES) throw new Error('context-too-large');
    if (node.nodeType === 3) return { text: node.data };
    if (node.nodeType !== 1) return null;
    if (node.hasAttribute('data-fb-ignore')) return null;
    if (node.matches('script, style, template')) return null;
    if (node.isContentEditable || node.matches('input, textarea, select')) {
      if (context) return { ...describe(node), editable: true };
      throw new Error('editable-context');
    }
    // 외부 문서·그림·수집하지 않은 shadow subtree는 같다고 추측하지 않는다.
    if (node.matches('iframe, canvas, object, embed') || node.shadowRoot) {
      throw new Error('unsupported-context');
    }
    return { ...describe(node), children: [...node.childNodes].map(visit).filter(Boolean) };
  }
  const result = visit(el);
  if (JSON.stringify(result).length > MAX_LENGTH) throw new Error('context-too-large');
  return result;
}

function pathOf(el) {
  const path = [];
  for (let node = el; node; ) {
    const root = node.getRootNode();
    if (node.id && root.querySelectorAll(`#${CSS.escape(node.id)}`).length !== 1) {
      throw new Error('duplicate-id');
    }
    const siblings = node.parentNode?.children;
    path.unshift({ ...describe(node), index: siblings ? [...siblings].indexOf(node) : 0 });
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

function hasActionEvidence(el) {
  // 명시적 동작 정보 또는 서로 다른 종류의 식별 단서 조합을 요구한다.
  if (['data-action', 'data-command'].some((a) => el.getAttribute(a)?.trim())) return true;
  if (el.localName === 'a' && el.hasAttribute('href')) {
    const raw = el.getAttribute('href').trim();
    if (raw && !raw.startsWith('#')
      && ['http:', 'https:'].includes(new URL(raw, el.baseURI).protocol)) return true;
  }
  const identified = (node) => node && ['id', 'class', 'role'].some((a) => node.getAttribute(a)?.trim());
  const selfIdentity = ['id', 'class'].some((a) => el.getAttribute(a)?.trim());
  const parentIdentity = identified(el.parentElement || el.getRootNode().host);
  const icon = el.querySelector(
    'img[src], svg use[href], svg use[xlink\\:href], svg path[d], svg polygon[points], i[class], [class*="icon"]'
  );
  // 빈 svg나 위치 하나는 근거로 세지 않는다. 실제 유일성은 아래에서 별도 검사한다.
  return Boolean(selfIdentity && parentIdentity && icon);
}

function nearbyContext(el) {
  const parent = el.parentElement;
  return {
    parent: parent ? describe(parent) : null,
    // 부모 전체 하위 트리 대신 직접 텍스트와 바로 앞뒤 요소만 비교한다.
    parentText: parent ? [...parent.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data) : [],
    previous: el.previousElementSibling ? tree(el.previousElementSibling, { context: true }) : null,
    next: el.nextElementSibling ? tree(el.nextElementSibling, { context: true }) : null,
  };
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
    if (!hasActionEvidence(el)) return fail('insufficient-evidence');
    const element = tree(el);
    const identity = JSON.stringify(element);
    const candidates = el.getRootNode().querySelectorAll(el.localName);
    if (candidates.length > MAX_CANDIDATES) return fail('too-many-candidates');
    // 같은 root에 동일 서명이 두 개 있으면 위치로 억지로 구분하지 않는다.
    for (const other of candidates) {
      if (other === el || other.closest('[data-fb-ignore]')) continue;
      if (JSON.stringify(describe(other)) !== JSON.stringify(describe(el))) continue;
      try {
        if (JSON.stringify(tree(other)) === identity) return fail('ambiguous-element');
      } catch {
        // 읽지 못하는 후보를 다르다고 가정하지 않는다.
        return fail('ambiguous-candidate');
      }
    }
    const payload = {
      pageKey,
      version: FINGERPRINT_VERSION,
      name,
      element,
      path: pathOf(el),
      context: nearbyContext(el),
      references: referenceContext(el),
    };
    const canonical = JSON.stringify(payload);
    if (canonical.length > MAX_LENGTH) return fail('context-too-large');
    return { eligible: true, version: FINGERPRINT_VERSION, pageKey, canonical };
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
