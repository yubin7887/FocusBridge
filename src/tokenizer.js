// ③ 기능 사전 매칭 - 토큰화
// class·id·주소·파일명 같은 글자를 비교하기 좋은 영어 단어 조각(토큰)으로 자른다.
import DICT from './dictionary.json' with { type: 'json' };

const STOP = new Set(DICT.stopwords);

/**
 * 'btn-nobtn btn-notification' → ['nobtn', 'notification']
 * 'iconSearchBtn'              → ['search']
 * 'fw-h-[36px]'                → []
 */
export function tokenize(text) {
  if (!text) return [];
  // camelCase 경계에 공백 넣기: 'iconSearchBtn' → 'icon Search Btn'
  const spaced = String(text).replace(/([a-z])([A-Z])/g, '$1 $2');
  const out = [];
  // 영어·숫자가 아닌 글자(공백, -, _, ., / 등)를 기준으로 자르기
  for (const raw of spaced.split(/[^A-Za-z0-9]+/)) {
    const t = raw.toLowerCase();
    if (t.length <= 2) continue;   // 한두 글자: f, b, w, sm, lg …
    if (/\d/.test(t)) continue;    // 숫자 섞인 조각: 48px, 해시(07e45e52), s1024 …
    if (STOP.has(t)) continue;     // 불용어: btn, icon, png …
    out.push(t);
  }
  return out;
}

/**
 * 그림 주소 → 확장자를 뺀 파일 이름
 * 'https://cdn.x.com/img/ico_search_24.png?v=3' → 'ico_search_24'
 */
export function fileStem(src) {
  if (!src || src.startsWith('data:')) return '';   // data: 주소는 그림을 글자로 통째로 넣은 것이라 이름이 없음
  let pathname;
  try {
    pathname = new URL(src, 'http://local/').pathname; // 상대 주소도 해석할 수 있게 임시 기준 주소를 줌
  } catch {
    return '';
  }
  const name = pathname.split('/').pop();
  return name.replace(/\.[^.]*$/, '');                 // 마지막 '.확장자' 제거
}
