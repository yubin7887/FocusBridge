// Content script 진입점: 수집 → 탐지 → (다음 단계로 넘길) 결과 생성
// 이후 ③ 기능 사전 매칭, ④ AI 추론 단계가 이 결과를 입력으로 받는다.
import { collectTargets } from './collector.js';
import { detectMissingNames } from './detector.js';
import { showOverlay } from './overlay.js';
import { matchAll } from './matcher.js'; // ③ 기능 사전 매칭

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
    if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
    const parent = n.parentNode; // Element 또는 ShadowRoot
    const idx = [...parent.children].filter((c) => c.tagName === n.tagName).indexOf(n) + 1;
    parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${idx})`);
    if (parent instanceof ShadowRoot) { parts.unshift('::shadow'); n = parent.host; }
    else n = parent;
  }
  return parts.join(' > ');
}

export function scan(root = document) {
  const t0 = performance.now();
  const targets = collectTargets(root);
  const missing = detectMissingNames(targets);
  const elapsed = performance.now() - t0;

  const report = missing.map((m) => ({
    status: m.status,
    role: m.role,
    currentName: m.name,
    selector: cssPath(m.element),
    context: extractContext(m.element),
  }));
  matchAll(report, location.href); // ③ 각 항목에 match { decision, pattern, label, score, candidates } 추가

  console.groupCollapsed(
    `[FocusBridge] 대상 ${targets.length}개 / 이름 누락 ${missing.length}개 (${elapsed.toFixed(1)}ms)`
  );
  console.table(report.map((r, i) => ({
    no: i + 1, status: r.status, role: r.role, name: r.currentName,
    match: r.match.decision, label: r.match.label, // ③ 결과: confirm(확정)/ai/content
    selector: r.selector,
  })));
  missing.forEach((m, i) => console.log(`#${i + 1}`, m.status, m.element));
  console.groupEnd();

  showOverlay(missing);
  const result = { targets, missing, report };
  window.__focusBridge = result;
  return result;
}

// SPA 대응: DOM 변화가 멈추면 다시 검사 (디바운스)
let timer = null;
const observer = new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(() => scan(), 500);
});

function start() {
  window.__focusBridge = scan(); // 개발 중 콘솔에서 확인용
  observer.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['aria-label', 'aria-labelledby', 'aria-hidden', 'hidden', 'title', 'alt', 'role'],
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
