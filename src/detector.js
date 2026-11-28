// ② 이름 누락 탐지
// 브라우저가 스크린리더에 넘기는 "접근 가능한 이름(accessible name)"을
// W3C accname 명세대로 계산해, 비었거나 의미 없는 요소를 골라낸다.
import { computeAccessibleName, getRole, isInaccessible } from 'dom-accessibility-api';

// 생성된 이름은 요소의 기능을 설명해야 한다.
const GENERIC_NAMES = new Set([
  'button', 'btn', 'link', 'icon', 'image', 'img', 'click', 'click here',
  'more', 'here', '버튼', '링크', '아이콘', '이미지', '클릭', '여기',
  'undefined', 'null', '#', '...', '…', '>', '<', '×', 'x',
]);

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

export function isUnhelpfulGeneratedName(name) {
  return GENERIC_NAMES.has(name.toLowerCase()) || /^[\p{P}\p{S}\p{N}\s\uE000-\uF8FF]+$/u.test(name)
    || /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(name) || /^https?:\/\//i.test(name);
}

// 요소 안에서 스크린리더가 읽지 못하게 숨겨진 글자를 모은다 (display:none, visibility:hidden 등)
function hiddenText(el) {
  const parts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const parent = t.parentElement;
    if (!parent || parent.closest('script, style, template, noscript, svg')) continue;
    const text = normalize(t.textContent);
    if (text && isInaccessible(parent)) parts.push(text);
  }
  return parts.join(' ');
}

// 라이브러리는 자식 요소의 title을 이름에 넣지 않지만, 크롬은 제목(h1~h6)·이미지처럼
// 역할이 있는 자식 요소의 title을 이름으로 쓴다. (일반 span·div의 title은 크롬도 쓰지 않음)
// 예: <a href="/"><h1 title="Bing 검색으로 돌아가기"></h1></a> → 크롬 이름 "Bing 검색으로 돌아가기"
function titleFromChildren(el) {
  for (const c of el.querySelectorAll('[title]')) {
    const t = normalize(c.getAttribute('title'));
    if (!t || isInaccessible(c)) continue;
    const r = getRole(c);
    if (r && r !== 'generic' && r !== 'presentation' && r !== 'none') return t;
  }
  return '';
}

/**
 * 하나의 요소에 대해 이름 상태를 판정
 * @returns {{ status: 'ok'|'empty'|'meaningless', name: string, role: string }}
 */
export function checkName(el) {
  const role = getRole(el);
  let name = normalize(computeAccessibleName(el));
  if (name === '') name = titleFromChildren(el);
  const authorNamed =
  normalize(el.getAttribute('aria-label')) !== '' || el.hasAttribute('aria-labelledby');

  if (name === '') return { status: 'empty', name, role };
  if (name.length <= 3 && !authorNamed) {
    const hidden = hiddenText(el);
    // 둘 중 하나가 다른 쪽을 포함하면 같은 이름의 다른 버전(PC/모바일 등)으로 본다
    if (hidden && !name.includes(hidden) && !hidden.includes(name)) {
      return { status: 'empty', name, role, reason: 'hidden-name', hiddenText: hidden };
    }
  }

  // 숫자로만 된 이름: 슬라이드 점('0', '1' …). matcher.js의 슬라이드 점 이름 붙이기가 사용
  if (/^\d+$/.test(name)) return { status: 'meaningless', name, role };

  return { status: 'ok', name, role };
}

/**
 * 검사 대상 중 이름이 누락된 요소만 반환
 * @param {Element[]} targets  collectTargets()의 결과
 * @param {{ includeMeaningless?: boolean }} opts
 */
export function detectMissingNames(targets, { includeMeaningless = false } = {}) {
  const missing = [];
  for (const el of targets) {
    const r = checkName(el);
    if (r.status === 'empty' || (includeMeaningless && r.status === 'meaningless')) {
      missing.push({ element: el, ...r });
    }
  }
  return missing;
}
