// 수집 → 탐지 → 이전 방문 매칭 → 사전 매칭.
import { resolveAiResults } from './ai-flow.js';
import { collectRoots, collectTargets } from './collector.js';
import { findIcon } from './ai-payload.js';
import { detectMissingNames } from './detector.js';
import { showOverlay } from './overlay.js';
import { pageCommon, matchItem, numberLabels } from './matcher.js';
import { createFingerprint } from './previous-fingerprint.js';
import { createPreviousLookup, matchPrevious } from './previous-matcher.js';
import { createLabelController } from './apply-labels.js';
import { createReportLogger } from './report-log.js';
import { svgFrameRoot } from './svg-animation.js';

// ③④ 단계에 넘길 문맥 정보(제안서 QnA 표 기준). AI 없이 DOM API만 사용.
function extractContext(el) {
  const icon = findIcon(el);
  const parent = el.parentElement;
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === 'string' ? el.className : el.getAttribute('class'),
    href: el.getAttribute('href'),
    iconClass: icon?.getAttribute('class') || null,
    iconSrc: icon?.getAttribute('src') || null,
    parentClass: parent?.getAttribute('class') || null,
    // ③ 슬라이드 점 판별용: 부모 위 두 단계의 class (예: <ol class="dot-navi"><li><a>0</a></li></ol>)
    ancestorClass: [parent?.parentElement, parent?.parentElement?.parentElement]
      .map((n) => n?.getAttribute('class') || '').join(' ').trim().slice(0, 200) || null,
    parentText: (parent?.innerText || '').trim().slice(0, 100),
    prevSiblingText: (el.previousElementSibling?.innerText || '').trim().slice(0, 50),
    nextSiblingText: (el.nextElementSibling?.innerText || '').trim().slice(0, 50),
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
const logReport = createReportLogger();
let generation = 0;
let timer = null;
const animationTimers = new Map();
let animationScanDue = false;
let processingScan = null;
let observedUrl = location.href;
let aiRetryTimer = null;
let aiRetried = false;
function scheduleAiRetry(retryAt, pageUrl) {
  if (!Number.isFinite(retryAt) || aiRetried || aiRetryTimer !== null) return;
  aiRetryTimer = setTimeout(() => {
    aiRetryTimer = null;
    if (location.href !== pageUrl || document.visibilityState !== 'visible') return;
    aiRetried = true;
    scheduleScan();
  }, Math.max(0, retryAt - Date.now()));
}

export async function scan(root = document) {
  clearTimeout(timer);
  timer = null;
  clearAnimationScan();
  const scanId = ++generation;
  processingScan = scanId;
  window.__focusBridge = null;
  const pageUrl = location.href;
  observeRoots();
  if (pageUrl !== observedUrl) labels.restoreAll();
  const t0 = performance.now();
  // Read native names synchronously, then keep the current labels during the lookup.
  const { targets, missing, report } = labels.withOriginalLabels(() => {
    const targets = collectTargets(root);
    const missing = detectMissingNames(targets);
    const report = missing.map((m) => ({
      status: m.status,
      role: m.role,
      currentName: m.name,
      reason: m.reason ?? null,
      hiddenText: m.hiddenText ?? null,
      selector: cssPath(m.element),
      context: extractContext(m.element),
    }));
    return { targets, missing, report };
  });
  labels.keepOnly(missing.map(({ element }) => element));
  const canLookupPrevious = missing.length > 0 && window === window.top;
  const previous = canLookupPrevious
    ? await lookupPrevious(pageUrl) : { status: 'skipped', records: [] };
  // 이전 검사나 다른 URL의 응답은 게시하지 않는다.
  if (scanId !== generation || location.href !== pageUrl) return null;
  // observer가 감지하지 못하는 checked 등의 프로퍼티 변경도 다시 확인한다.
  const fingerprints = canLookupPrevious
    ? labels.withOriginalLabels(() => {
      const currentMissing = detectMissingNames(collectTargets(root));
      if (currentMissing.length !== missing.length || currentMissing.some((m, i) =>
        m.element !== missing[i].element || m.status !== missing[i].status || m.name !== missing[i].name
        || m.role !== missing[i].role || (m.reason ?? null) !== report[i].reason
        || (m.hiddenText ?? null) !== report[i].hiddenText
        || JSON.stringify(report[i].context) !== JSON.stringify(extractContext(m.element)))) return null;
      // The lookup returns all records for this page. Match the exact current DOM once.
      return currentMissing.map(({ element }) => createFingerprint(element));
    }) : [];
  if (!fingerprints) { scheduleScan(); return null; }
  const common = pageCommon(report); // 전체 report 기준을 유지한다.
  for (let i = 0; i < report.length; i++) {
    const { x, y, width, height } = missing[i].element.getBoundingClientRect();
    report[i].context.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) };
    report[i].match = matchPrevious(fingerprints[i], previous.records)
      || matchItem(report[i], pageUrl, common);
  }
  numberLabels(report); // 광고 1, 광고 2… / 슬라이드 점 번호
  labels.keepOnly(missing.filter((_, index) => report[index].match.decision === 'confirm').map(({ element }) => element));
  labels.applyMatches(missing, report);
  const elapsed = performance.now() - t0;

  const frame = window === window.top ? 'TOP' : 'iframe';
  showOverlay(missing);
  const result = { targets, missing, report, pageUrl, scanId, previousStatus: previous.status,
    withOriginalLabels: labels.withOriginalLabels };
  window.__focusBridge = result;
  const isCurrent = () => scanId === generation && location.href === pageUrl;
  void resolveAiResults(result, fingerprints, isCurrent)
    .then((retryAt) => { if (isCurrent()) scheduleAiRetry(retryAt, pageUrl); })
    .catch(() => { result.aiStatus = 'unavailable'; })
    .finally(() => {
      if (isCurrent()) logReport(result, fingerprints, elapsed, frame);
      if (processingScan !== scanId) return;
      processingScan = null;
      runAnimationScan();
    });
  return result;
}

// 모든 관련 속성·텍스트 변경을 감지하되 확장 오버레이의 변경은 무시한다.
function ignored(node) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  return Boolean(element?.closest('[data-fb-ignore]'));
}
const observer = new MutationObserver((records) => {
  const pageRecords = records.filter((r) => !labels.ownMutation(r) && !ignored(r.target) && !(r.type === 'childList'
    && [...r.addedNodes, ...r.removedNodes].length
    && [...r.addedNodes, ...r.removedNodes].every(ignored)));
  const frameRoots = new Set(pageRecords.map(svgFrameRoot));
  if (frameRoots.has(null)) scheduleScan();
  else for (const svg of frameRoots) scheduleAnimationScan(svg);
});
const observedRoots = new Set();
function observeRoots() {
  const roots = collectRoots(document);
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
function clearAnimationScan() {
  for (const timeout of animationTimers.values()) clearTimeout(timeout);
  animationTimers.clear();
  animationScanDue = false;
}
function runAnimationScan() {
  if (animationScanDue && processingScan === null && timer === null) runScan();
}
function scheduleAnimationScan(svg) {
  clearTimeout(animationTimers.get(svg));
  // A lasting change in the icon still needs a scan, after the active one finishes.
  animationTimers.set(svg, setTimeout(() => {
    animationTimers.delete(svg);
    animationScanDue = true;
    runAnimationScan();
  }, 500));
}
function scheduleScan() {
  generation++; // 디바운스가 끝나기 전에 기존 응답부터 무효화한다.
  window.__focusBridge = null;
  clearAnimationScan();
  clearTimeout(timer);
  timer = setTimeout(runScan, 500);
}
function runScan() {
  window.__focusBridgeReady = scan();
}
function checkNavigation() {
  if (location.href !== observedUrl) {
    observedUrl = location.href;
    labels.restoreAll();
    clearTimeout(aiRetryTimer);
    aiRetryTimer = null;
    aiRetried = false;
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
