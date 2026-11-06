// ③ 기능 사전 매칭
// ②가 만든 report 항목 하나를 받아, AI 없이 이름을 확정할 수 있는지 판별한다.
// DOM을 읽지 않는 순수 함수라서 브라우저 없이 Node에서도 테스트할 수 있다.
//
// 판별 순서 (위에서부터, 걸리면 멈춤)
//   [0] 콘텐츠형 가려내기  주소에 5자리 이상 숫자 → AI로
//   [1] F1 다른 사이트     도메인 목록에 있으면 확정
//   [2] F2 홈              지금 사이트와 같은 곳의 첫 화면이면 확정
//   [3] F3 사전 점수       직접 단서가 있고 35점 이상, 2등과 15점 이상 차이 → 확정
//   그 밖에는 AI로 (상위 후보를 함께 넘김)
//
// 페이지 공통 단어: 같은 페이지의 누락 항목 절반 이상에 나오는 단어는 점수에서 뺀다.
//   (예: UI 라이브러리가 모든 버튼에 붙이는 'mantine-next-…'의 next를 "다음"으로 오해하지 않게)
//   class 쪽과 data- 속성 쪽은 따로 센다.
//
// data- 속성(0.3.0): 요소 자신의 data- 값도 직접 단서로 쓴다 (예: data-type="next" → 다음, data-button-name="검색창" → 검색)
import DICT from './dictionary.json' with { type: 'json' };
import { tokenize, fileStem } from './tokenizer.js';

const W = DICT.weights;
const T = DICT.thresholds;
const DIRECT = new Set(DICT.direct);
const FILENAME_RE = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const CONTENT_RE = new RegExp(`\\d{${T.contentDigits},}`);

// www.coupang.com, news.coupang.com → coupang.com  (대략적인 "같은 회사" 판정)
function registrable(host) {
  const parts = (host || '').split('.');
  if (parts.length >= 3 && ['co', 'or', 'go', 'ac', 'ne'].includes(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');   // naver.co.kr 같은 국가 도메인
  }
  return parts.slice(-2).join('.');
}

// 토큰과 사전 단어가 맞는가: 완전 일치, 또는 5자 이상 단어는 앞부분 일치 ('searchbar' ⊃ 'search')
function hit(token, keyword) {
  return token === keyword || (keyword.length >= T.prefixMinLen && token.startsWith(keyword));
}

function anyHit(tokens, keywords) {
  return tokens.some((t) => keywords.some((k) => hit(t, k)));
}

function parseUrl(href, pageUrl) {
  try { return new URL(href, pageUrl); } catch { return null; }
}

const result = (decision, pattern, label = null, score = 0, candidates = []) =>
  ({ decision, pattern, label, score, candidates });

/**
 * 페이지 공통 단어 찾기: report 전체를 보고, 항목 절반 이상의 class에 나오는 단어 모음을 돌려준다.
 * 어느 버튼에나 붙는 단어는 "무슨 버튼인지"를 구별해 주지 못하므로 불용어처럼 취급한다.
 * 항목이 너무 적으면(4개 미만) 비율이 의미 없으므로 빈 모음을 돌려준다.
 *
 * 출처별로 따로 센다: class에서 흔한 'next'(라이브러리 이름)가 data-type="next"까지 지우면 안 되기 때문.
 * @returns {{ cls: Set<string>, data: Set<string> }}  cls = class 쪽 흔한 단어, data = data- 속성 쪽 흔한 단어
 */
export function pageCommon(report) {
  return {
    cls: commonWords(report, (c) => [...tokenize(c.id), ...tokenize(c.className), ...tokenize(c.iconClass), ...tokenize(c.parentClass)]),
    data: commonWords(report, (c) => dataTokens(c.dataAttrs)),
  };
}

function commonWords(report, wordsOf) {
  const out = new Set();
  if (report.length < T.commonMinItems) return out;
  const count = new Map();
  for (const item of report) {
    // 한 항목 안에서 여러 번 나와도 한 번만 센다 (Set)
    for (const w of new Set(wordsOf(item.context || {}))) count.set(w, (count.get(w) || 0) + 1);
  }
  for (const [w, n] of count) {
    if (n / report.length >= T.commonRatio) out.add(w);
  }
  return out;
}

// data- 속성 값들 → 토큰 ('{ id: 'cart' }' → ['cart'], 'search_window' → ['search', 'window'])
function dataTokens(dataAttrs) {
  return Object.values(dataAttrs || {}).flatMap((v) => tokenize(v));
}

const NO_COMMON = { cls: new Set(), data: new Set() };

/**
 * @param {object} item     report 항목 { status, role, currentName, context }
 * @param {string} pageUrl  지금 페이지 주소 (location.href)
 * @param {{cls: Set<string>, data: Set<string>}} common  pageCommon()이 찾은 페이지 공통 단어 (없으면 빈 모음)
 * @returns {{ decision: 'confirm'|'ai'|'content', pattern: string|null, label: string|null,
 *             score: number, candidates: {label, score, evidence}[] }}
 */
export function matchItem(item, pageUrl, common = NO_COMMON) {
  const c = item.context || {};
  const role = item.role;
  const href = (c.href || '').trim();
  // 실제 주소가 있는 링크인가 ('#', 'javascript:'는 링크처럼 보이게 하려는 빈 주소)
  const realUrl = href !== '' && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:');
  const url = realUrl ? parseUrl(href, pageUrl) : null;
  const pageHost = parseUrl(pageUrl)?.hostname || '';

  // [0] 콘텐츠형 가려내기
  if (realUrl && CONTENT_RE.test(href)) return result('content', 'C');

  if (url && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
    const host = url.hostname.toLowerCase();
    if (registrable(host) !== registrable(pageHost)) {
      // [1] F1 다른 사이트 링크
      for (const [domain, label] of Object.entries(DICT.domains)) {
        if (host === domain || host.endsWith('.' + domain)) return result('confirm', 'F1', label, 100);
      }
    } else if (host.replace(/^www\./, '') === pageHost.replace(/^www\./, '')
               && (url.pathname === '' || url.pathname === '/') && url.search === '') {
      // [2] F2 자기 사이트 첫 화면
      return result('confirm', 'F2', '홈', 100);
    }
  }

  // [3] F3 사전 점수 - 출처별로 토큰 모으기
  const sameSite = url && registrable(url.hostname || pageHost) === registrable(pageHost);
  const notCommon = (t) => !common.cls.has(t);   // 페이지 공통 단어 빼기 (class 쪽)
  const src = {
    path: sameSite ? tokenize(url.pathname) : [],
    self: [...tokenize(c.id), ...tokenize(c.className)].filter(notCommon),
    icon: [...tokenize(c.iconClass).filter(notCommon), ...tokenize(fileStem(c.iconSrc))],
    data: dataTokens(c.dataAttrs).filter((t) => !common.data.has(t)),   // data- 속성 쪽은 따로
  };
  const dataValues = Object.values(c.dataAttrs || {});   // 한국어 값 비교용 ('검색창')
  const name = item.currentName || '';
  if (item.status === 'meaningless' && FILENAME_RE.test(name)) {
    src.icon.push(...tokenize(name.replace(/\.[^.]*$/, '')));   // 'ic_search.png'은 아이콘 파일명과 같다
  }
  const nearTexts = [c.prevSiblingText, c.nextSiblingText, c.parentText]
    .filter((t) => t && [...t].length <= T.nearMaxLen);          // 짧은 이웃 글자만
  const nearClass = tokenize(c.parentClass).filter(notCommon);

  const scored = [];
  for (const f of DICT.functions) {
    // 역할 거름망: 페이지 안 기능(메뉴·닫기 등)은 실제 주소가 있는 링크일 수 없다
    if (f.kind === 'toggle' && role === 'link' && realUrl) continue;
    const evidence = {};
    for (const cat of ['path', 'self', 'icon', 'data']) {
      if (anyHit(src[cat], f.tokens)) evidence[cat] = W[cat];   // 같은 출처 안에서는 한 번만
    }
    if (dataValues.some((v) => f.texts.some((tx) => v.includes(tx)))) evidence.data = W.data;
    if (DICT.symbols[name.trim()] === f.id) evidence.symbol = W.symbol;
    if (nearTexts.some((t) => f.texts.some((tx) => t.includes(tx))) || anyHit(nearClass, f.tokens)) {
      evidence.near = W.near;
    }
    const score = Object.values(evidence).reduce((a, b) => a + b, 0);
    if (score > 0) scored.push({ label: f.label, score, evidence });
  }
  if (scored.length === 0) return result('ai', null);

  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const hasDirect = Object.keys(best.evidence).some((k) => DIRECT.has(k));
  const top = scored.slice(0, 3);                                // AI에 넘길 상위 후보
  if (hasDirect && best.score >= T.confirm && best.score - (second?.score || 0) >= T.margin) {
    return result('confirm', 'F3', best.label, best.score, top);
  }
  return result('ai', null, null, 0, top);
}

/** report 전체에 매칭 결과를 붙인다 (각 항목에 match 필드 추가) */
export function matchAll(report, pageUrl) {
  const common = pageCommon(report);
  for (const item of report) item.match = matchItem(item, pageUrl, common);
  return report;
}
