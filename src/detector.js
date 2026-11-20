// ② 이름 누락 탐지
// 브라우저가 스크린리더에 넘기는 "접근 가능한 이름(accessible name)"을
// W3C accname 명세대로 계산해, 비었거나 의미 없는 요소를 골라낸다.
import { computeAccessibleName, getRole , isInaccessible } from 'dom-accessibility-api';

// 이름이 있긴 하지만 기능을 전혀 알려주지 못하는 값들
// (확장 시 기능 사전 단계와 공유하도록 분리해도 됨)
const MEANINGLESS = new Set([
  'button', 'btn', 'link', 'icon', 'image', 'img', 'click', 'click here',
  'more', 'here', '버튼', '링크', '아이콘', '이미지', '클릭', '여기',
  'undefined', 'null', '#', '...', '…', '>', '<', '×', 'x',
]);

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// 파일명/URL 형태 이름 (img alt 없을 때 src가 새는 경우 등)
function looksLikeFilename(name) {
  return /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(name) || /^https?:\/\//i.test(name);
}

// 요소 안에서 스크린리더가 읽지 못하게 숨겨진 글자를 모은다 (display:none, visibility:hidden 등)
function hiddenText(el) {
  const parts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const parent = t.parentElement;
    if (!parent || parent.closest('script, style, template, noscript')) continue;
    const text = normalize(t.textContent);
    if (text && isInaccessible(parent)) parts.push(text);
  }
  return parts.join(' ');
}

// 넓은 meaningless 규칙(단어 목록·기호·파일명). 오탐이 많아 비활성화
const USE_BROAD_RULES = false;

/**
 * 하나의 요소에 대해 이름 상태를 판정
 * @returns {{ status: 'ok'|'empty'|'meaningless', name: string, role: string }}
 */
export function checkName(el) {
  const role = getRole(el);
  const name = normalize(computeAccessibleName(el));

  if (name === '') return { status: 'empty', name, role };

  // 진짜 이름은 숨겨지고 배지·상태 글자("N", "OFF")만 이름으로 남은 경우 → 이름이 없는 것과 같음
  if (name.length <= 3) {
    const hidden = hiddenText(el);
    if (hidden && !name.includes(hidden)) {
      return { status: 'empty', name, role, reason: 'hidden-name', hiddenText: hidden };
    }
  }

  // 숫자로만 된 이름: 슬라이드 점('0', '1' …). matcher.js의 슬라이드 점 이름 붙이기가 사용
  if (/^\d+$/.test(name)) return { status: 'meaningless', name, role };

  if (USE_BROAD_RULES) {
    const lower = name.toLowerCase();
    const onlySymbols = /^[\p{P}\p{S}\p{N}\s\uE000-\uF8FF]+$/u.test(name);
    const visibleText = normalize(el.innerText).toLowerCase();
    const isVisibleLabel = visibleText === lower;
    const badWord = MEANINGLESS.has(lower) && !isVisibleLabel;
    if (badWord || onlySymbols || looksLikeFilename(name)) {
      return { status: 'meaningless', name, role };
    }
  }
  return { status: 'ok', name, role };
}

// 링크가 글자 사이에 끼어 문장의 일부로 읽히는지 (예: "Merge pull request #15 from ...")
function inSentence(el) {
  if (!getComputedStyle(el).display.startsWith('inline')) return false;
  const around = adjacentText(el, 'previousSibling') + adjacentText(el, 'nextSibling');
  return /\p{L}/u.test(around); // 양옆 노드에 글자(한글·영문 등)가 있으면 문장으로 판단
}
// 공백만 있는 노드는 건너뛰고, 글자가 있는 첫 이웃 노드의 텍스트를 가져온다
function adjacentText(el, dir) {
  let n = el[dir];
  while (n && normalize(n.textContent) === '') n = n[dir];
  return normalize(n?.textContent);
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
