// ① 검사 대상 수집
// "화면에 보이는가"가 아니라 "접근성 트리에 들어가는가"를 기준으로 거른다.
// (opacity:0, 화면 밖, 0x0 크기 요소도 스크린리더는 읽기 때문)
import { getRole, isInaccessible } from 'dom-accessibility-api';

// 1차 후보: 스크린리더가 "버튼/링크"류로 안내하는 요소
const CANDIDATE_SELECTOR = [
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="image"]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="option"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// 2차 필터: 최종 계산된 role이 이 중 하나여야 검사 대상
export const TARGET_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'switch', 'checkbox', 'option',
]);

// open shadow root까지 포함해 탐색할 루트들을 모은다.
// (querySelectorAll은 shadow DOM 안을 보지 못함)
export function collectRoots(root) {
  const roots = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    if (n.shadowRoot) roots.push(...collectRoots(n.shadowRoot));
  }
  return roots;
}

function isInAccessibilityTree(el) {
  if (isInaccessible(el)) return false;          // display:none, visibility:hidden, hidden, aria-hidden=true
  if (el.closest('[inert]')) return false;       // inert 서브트리
  return true;
}

/**
 * root(기본 document) 아래의 검사 대상 요소 배열을 반환
 * @param {Document|Element|ShadowRoot} root
 */
export function collectTargets(root = document) {
  const result = new Set();
  for (const r of collectRoots(root)) {
    // root 자신도 후보일 수 있음 (MutationObserver로 추가된 노드 재검사 시)
    if (r instanceof Element && r.matches(CANDIDATE_SELECTOR)) result.add(r);
    r.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => result.add(el));
  }

  return [...result].filter((el) => {
    if (el.closest('[data-fb-ignore]')) return false;   // 확장 프로그램 자체 UI 제외용
    const role = getRole(el);
    if (!role || !TARGET_ROLES.has(role)) return false; // tabindex만 있는 div 등은 role이 없으므로 제외
    return isInAccessibilityTree(el);
  });
}
