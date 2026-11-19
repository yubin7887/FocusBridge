// ② 이름 누락 탐지
// 브라우저가 스크린리더에 넘기는 "접근 가능한 이름(accessible name)"을
// W3C accname 명세대로 계산해, 비었거나 의미 없는 요소를 골라낸다.
import { computeAccessibleName, getRole } from 'dom-accessibility-api';

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


/**
 * 하나의 요소에 대해 이름 상태를 판정
 * @returns {{ status: 'ok'|'empty'|'meaningless', name: string, role: string }}
 */
 /*
export function checkName(el) {
  const role = getRole(el);
  const name = normalize(computeAccessibleName(el));

  if (name === '') return { status: 'empty', name, role };

  const lower = name.toLowerCase();  
  // 기호만 있는 이름: ")", "|", ">", 아이콘 폰트 문자 → 문맥과 무관하게 의미 없음
  const onlySymbols = /^[\p{P}\p{S}\s\uE000-\uF8FF]+$/u.test(name);
  // 숫자가 섞인 짧은 식별자: "#15", "0", "3/10" → 문장 속에 있으면 문맥으로 이해 가능
  const numericId = !onlySymbols && /^[\p{P}\p{S}\p{N}\s]+$/u.test(name);

  // 이름이 화면에 보이는 글자와 같으면, 일부러 붙인 메뉴 이름으로 보고 단어 목록 검사를 건너뜀
  const visibleText = normalize(el.innerText).toLowerCase();
  const isVisibleLabel = visibleText === lower;
  const badWord = MEANINGLESS.has(lower) && !isVisibleLabel;

  if (badWord || onlySymbols || looksLikeFilename(name)) {
    return { status: 'meaningless', name, role };
  }
  if (numericId && !inSentence(el)) {
    return { status: 'meaningless', name, role };
  }
  return { status: 'ok', name, role };
}
*/
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
