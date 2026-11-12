// 수집 → 탐지 → 이전 방문 매칭 → 실패 항목 사전 매칭. AI·이름 적용은 아직 연결하지 않는다.
import { collectTargets } from './collector.js';
import { detectMissingNames } from './detector.js';
import { showOverlay } from './overlay.js';
import { pageCommon, matchItem } from './matcher.js';
import { createFingerprint, exactFingerprintMatch } from './previous-fingerprint.js';
import { createPreviousLookup, matchPrevious } from './previous-matcher.js';
import { createLabelController } from './apply-labels.js';

// ③④ 단계에 넘길 문맥 정보(제안서 QnA 표 기준). AI 없이 DOM API만 사용.
function extractContext(el) {
  const icon = el.querySelector('svg, img, i, [class*="icon"]');
  const parent = el.parentElement;
  const rect = el.getBoundingClientRect();
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === 'string' ? el.className : el.getAttribute('class'),
    href: el.getAttribute('href'),
    iconClass: icon?.getAttribute('class') || null,
    iconSrc: icon?.getAttribute('src') || null,
    parentClass: parent?.getAttribute('class') || null,
    parentText: (parent?.innerText || '').trim().slice(0, 100),
    prevSiblingText: (el.previousElementSibling?.innerText || '').trim().slice(0, 50),
    nextSiblingText: (el.nextElementSibling?.innerText || '').trim().slice(0, 50),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    // ③ 기능 사전 매칭용: 요소 자신의 data- 속성 (최대 10개, 값은 50자까지). 예: { "data-type": "next" }
    dataAttrs: Object.fromEntries(
      [...el.attributes]
        .filter((a) => a.name.startsWith('data-'))
        .slice(0, 10)
        .map((a) => [a.name, a.value.slice(0, 50)])
    ),
  };
}

// 요소를 다시 찾기 위한 CSS 경로 (재방문 매칭/디버깅용 간이 버전)
function cssPath(el) {
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && n !== document.body) {
    if (n.id) {
      parts.unshift(`#${CSS.escape(n.id)}`);
      const root = n.getRootNode();
      if (root instanceof ShadowRoot) { parts.unshift('::shadow'); n = root.host; continue; }
      break;
    }
    const parent = n.parentNode; // Element 또는 ShadowRoot
    const idx = [...parent.children].filter((c) => c.tagName === n.tagName).indexOf(n) + 1;
    parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${idx})`);
    if (parent instanceof ShadowRoot) { parts.unshift('::shadow'); n = parent.host; }
    else n = parent;
  }
  return parts.join(' > ');
}

const lookupPrevious = createPreviousLookup();
const labels = createLabelController();
let generation = 0;
let timer = null;
let observedUrl = location.href;

export async function scan(root = document) {
  clearTimeout(timer);
  const scanId = ++generation;
  window.__focusBridge = null;
  const pageUrl = location.href;
  observeRoots();
  labels.restoreAll();
  const t0 = performance.now();
  const targets = collectTargets(root);
  const missing = detectMissingNames(targets);


  const report = missing.map((m) => ({
    status: m.status,
    role: m.role,
    currentName: m.name,
    selector: cssPath(m.element),
    context: extractContext(m.element),
  }));
  const fingerprints = window === window.top ? missing.map((m) => createFingerprint(m.element)) : [];
  const previous = missing.length && window === window.top
    ? await lookupPrevious(pageUrl) : { status: 'skipped', records: [] };
  // 이전 검사나 다른 URL의 응답은 게시하지 않는다.
  if (scanId !== generation || location.href !== pageUrl) return null;
  // observer가 감지하지 못하는 checked 등의 프로퍼티 변경도 다시 확인한다.
  const currentMissing = detectMissingNames(collectTargets(root));
  const changed = currentMissing.length !== missing.length || currentMissing.some((m, i) => {
    if (m.element !== missing[i].element || m.status !== missing[i].status
      || m.name !== missing[i].name || m.role !== missing[i].role) return true;
    const { rect: oldRect, ...oldContext } = report[i].context;
    const { rect: newRect, ...newContext } = extractContext(m.element);
    if (JSON.stringify(oldContext) !== JSON.stringify(newContext)) return true;
    return fingerprints[i]?.eligible && !exactFingerprintMatch(fingerprints[i], createFingerprint(m.element));
  });
  if (changed) { scheduleScan(); return null; }
  const common = pageCommon(report); // 전체 report 기준을 유지한다.
  for (let i = 0; i < report.length; i++) {
    report[i].match = matchPrevious(fingerprints[i], previous.records)
      || matchItem(report[i], pageUrl, common);
  }
  labels.applyMatches(missing, report);
  const elapsed = performance.now() - t0;

  console.groupCollapsed(
    `[FocusBridge] 대상 ${targets.length}개 / 이름 누락 ${missing.length}개 (${elapsed.toFixed(1)}ms)`
  );
  console.table(report.map((r, i) => ({
    no: i + 1, status: r.status, role: r.role, name: r.currentName,
    previousMatch: previous.status === 'skipped' ? 'skipped'
      : !fingerprints[i]?.eligible ? 'ineligible'
      : previous.status !== 'ok' ? previous.status
      : r.match.source === 'previous' ? 'hit' : 'miss',
    match: r.match.decision, label: r.match.label, // ③ 결과: confirm(확정)/ai/content
    selector: r.selector,
  })));
  missing.forEach((m, i) => console.log(`#${i + 1}`, m.status, m.element));
  console.groupEnd();

  showOverlay(missing);
  const result = { targets, missing, report, pageUrl, scanId, previousStatus: previous.status,
    withOriginalLabels: labels.withOriginalLabels };
  window.__focusBridge = result;
  return result;
}

// 모든 관련 속성·텍스트 변경을 감지하되 확장 오버레이의 변경은 무시한다.
function ignored(node) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  return Boolean(element?.closest('[data-fb-ignore]'));
}
const observer = new MutationObserver((records) => {
  const pageRecords = records.filter((record) => !labels.ownMutation(record));
  if (pageRecords.some((r) => !ignored(r.target) && !(r.type === 'childList'
    && [...r.addedNodes, ...r.removedNodes].length
    && [...r.addedNodes, ...r.removedNodes].every(ignored)))) scheduleScan();
});
const observedRoots = new Set();
function observeRoots() {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const changed = roots.length !== observedRoots.size || roots.some((r) => !observedRoots.has(r));
  if (changed) {
    observer.disconnect();
    observedRoots.clear();
    for (const root of roots) {
      observedRoots.add(root);
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true });
    }
  }
  return changed;
}
function scheduleScan() {
  generation++; // 디바운스가 끝나기 전에 기존 응답부터 무효화한다.
  labels.restoreAll();
  window.__focusBridge = null;
  clearTimeout(timer);
  timer = setTimeout(runScan, 500);
}
function runScan() {
  window.__focusBridgeReady = scan();
}
function checkNavigation() {
  if (location.href !== observedUrl) {
    observedUrl = location.href;
    scheduleScan();
  }
}
function start() {
  window.addEventListener('focusbridge:ai-labels-ready', () => {
    const result = window.__focusBridge;
    if (result?.scanId === generation && result.pageUrl === location.href) labels.applyMatches(result.missing, result.report);
  });
  runScan();
  window.addEventListener('popstate', checkNavigation);
  window.addEventListener('hashchange', checkNavigation);
  // 페이지의 history 함수를 덮어쓰지 않고 pushState/replaceState와 새 shadow root를 발견한다.
  setInterval(() => {
    checkNavigation();
    if (observeRoots()) scheduleScan();
  }, 500);
  document.addEventListener('change', scheduleScan, true);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
