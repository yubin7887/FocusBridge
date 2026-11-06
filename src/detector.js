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
export function checkName(el) {
  const role = getRole(el);
  const name = normalize(computeAccessibleName(el));

  if (name === '') return { status: 'empty', name, role };

  const lower = name.toLowerCase();
  // 기호/숫자 한 글자, 아이콘 폰트의 Private Use Area 문자(Font Awesome 등)
  const onlySymbols = /^[\p{P}\p{S}\p{N}\s-]+$/u.test(name);
  if (MEANINGLESS.has(lower) || onlySymbols || looksLikeFilename(name)) {
    return { status: 'meaningless', name, role };
  }
  return { status: 'ok', name, role };
}

/**
 * 검사 대상 중 이름이 누락된 요소만 반환
 * @param {Element[]} targets  collectTargets()의 결과
 * @param {{ includeMeaningless?: boolean }} opts
 */
export function detectMissingNames(targets, { includeMeaningless = true } = {}) {
  const missing = [];
  for (const el of targets) {
    const r = checkName(el);
    if (r.status === 'empty' || (includeMeaningless && r.status === 'meaningless')) {
      missing.push({ element: el, ...r });
    }
  }
  return missing;
}
