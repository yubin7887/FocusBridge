// ③ 기능 사전 매칭
// ②가 만든 report 항목 하나를 받아, AI 없이 이름을 확정할 수 있는지 판별한다.
// DOM을 읽지 않는 순수 함수라서 브라우저 없이 Node에서도 테스트할 수 있다.
//
// 판별 순서 (위에서부터, 걸리면 멈춤)
//   [H] 숨겨진 진짜 이름 (0.8.0) ②가 찾은 숨겨진 이름(hiddenText)이 짧은 이름 모양이면 그대로 쓴다
//   [A] 광고 (0.6.0)       링크 자신의 주소·data- 속성에 광고 표시가 있으면 "광고 1", "광고 2"… (AI 없이 확정)
//       콘텐츠형 중 배너 (0.7.0)       그림만 있고 옆 글자 없음 + 배너 단서 → "배너 이미지 1"…
//   [D] 슬라이드 점 (0.6.0) 숫자만 있는 이름('0', '1'…) + 점 묶음 class(dot·bullet·indicator) → "슬라이드 1"…
//   [0] 콘텐츠형 가려내기  주소에 5자리 이상 숫자 → 콘텐츠형 (요소 자신의 단서로 [3] 확정이 되면 그 기능)
//       큰 요소(배너·카드, 0.6.0)        주소는 단서로 쓰지 않음 → 자기 단서로 확정이 안 되면 AI로
//   [1] F1 다른 사이트     도메인 목록에 있으면 확정
//   [2] F2 홈              지금 사이트와 같은 곳의 첫 화면이면 확정
//   [3] F3 사전 점수       직접 단서가 있고 35점 이상, 2등과 15점 이상 차이 → 확정
//   그 밖에는 AI로 (상위 후보를 함께 넘김)
//
// 페이지 공통 단어: 같은 페이지에서 서로 다른 종류(class)의 누락 요소 3개 이상에 두루 붙은 단어는 점수에서 뺀다.
//   (예: UI 라이브러리가 모든 버튼에 붙이는 'mantine-next-…'의 next를 "다음"으로 오해하지 않게)
//   class 쪽과 data- 속성 쪽은 따로 센다.
//
// data- 속성(0.3.0): 요소 자신의 data- 값도 직접 단서로 쓴다 (예: data-type="next" → 다음, data-button-name="검색창" → 검색)
//   단, 상태·모양만 나타내는 속성(data-state="closed" 등, dictionary.json의 ignoredDataAttrs)은 읽지 않는다 (0.5.0)
import DICT from './dictionary.json' with { type: 'json' };
import { tokenize, fileStem } from './tokenizer.js';

const W = DICT.weights;
const T = DICT.thresholds;
const DIRECT = new Set(DICT.direct);
const FILENAME_RE = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const CONTENT_RE = new RegExp(`\\d{${T.contentDigits},}`);
const TOP_POSITION_CLASS = /(?:^|:)-?top-(?:\d[\d./]*|px|auto|full|\[[^\]]+\]|\([^)]*\))!?$/i;

function classTokens(className) {
  // CSS offsets such as before:-top-px describe placement, not a scroll action.
  return tokenize((className || '').split(/\s+/).filter((name) => !TOP_POSITION_CLASS.test(name)).join(' '));
}

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
 * 페이지 공통 단어 찾기: "서로 다른 종류의 요소 여러 개에 두루 붙은 단어"를 모은다.
 * UI 라이브러리 이름(예: mantine-next-ActionIcon-root, mantine-next-Pagination-control의 next)처럼
 * 종류가 다른 부품마다 붙는 단어는 "무슨 버튼인지"를 구별해 주지 못하므로 불용어처럼 취급한다.
 * 같은 종류의 버튼이 반복될 때 겹치는 단어(btn-action-more 두 개의 more)는 진짜 기능 단어이므로 남긴다.
 *
 * 기준 (0.4.0): 그 단어가 commonMinItems개 이상의 항목에 있고, 그 항목들의 class 종류가
 *   commonMinKinds가지 이상일 때. 종류 = 요소 자신의 class 값(순서·중복 무시).
 * 비율(전체 중 몇 %)을 쓰지 않으므로, 그 단어가 없는 요소가 페이지에 추가되거나 빠져도
 * 결과가 바뀌지 않는다. (0.3.0의 "절반 이상" 규칙은 누락 요소 3개 ↔ 4개에서 결과가 뒤집혔다.)
 *
 * 출처별로 따로 센다: class에서 흔한 'next'(라이브러리 이름)가 data-type="next"까지 지우면 안 되기 때문.
 * @returns {{ cls: Set<string>, data: Set<string> }}  cls = class 쪽 흔한 단어, data = data- 속성 쪽 흔한 단어
 */
export function pageCommon(report) {
  return {
    cls: commonWords(report, (c) => [...tokenize(c.id), ...classTokens(c.className), ...classTokens(c.iconClass), ...classTokens(c.parentClass)]),
    data: commonWords(report, (c) => dataTokens(c.dataAttrs)),
  };
}

// 요소의 "종류": 자신의 class 값을 순서·중복 없이 정리한 것. class가 같으면 같은 종류의 버튼으로 본다.
function kindOf(context) {
  return [...new Set((context.className || '').split(/\s+/).filter(Boolean))].sort().join(' ');
}

function commonWords(report, wordsOf) {
  const items = new Map();   // 단어 → 그 단어가 나온 항목 수
  const kinds = new Map();   // 단어 → 그 항목들의 class 종류 모음
  for (const item of report) {
    const c = item.context || {};
    // 한 항목 안에서 여러 번 나와도 한 번만 센다 (Set)
    for (const w of new Set(wordsOf(c))) {
      items.set(w, (items.get(w) || 0) + 1);
      if (!kinds.has(w)) kinds.set(w, new Set());
      kinds.get(w).add(kindOf(c));
    }
  }
  const out = new Set();
  for (const [w, n] of items) {
    if (n >= T.commonMinItems && kinds.get(w).size >= T.commonMinKinds) out.add(w);
  }
  return out;
}

// 단서로 쓸 data- 속성 값들. 상태·모양만 나타내는 속성(data-state="closed" 등)은 뺀다.
// (사전 0.5.0: Radix 팝업 버튼의 data-state="closed"가 "닫기"로 확정되던 문제, 이슈 #13)
const IGNORED_DATA = new Set(DICT.ignoredDataAttrs || []);
function dataValuesOf(dataAttrs) {
  return Object.entries(dataAttrs || {})
    .filter(([name]) => !IGNORED_DATA.has(name.toLowerCase()))
    .map(([, value]) => value);
}

// data- 속성 값들 → 토큰 ('{ id: 'cart' }' → ['cart'], 'search_window' → ['search', 'window'])
function dataTokens(dataAttrs) {
  return dataValuesOf(dataAttrs).flatMap((v) => tokenize(v));
}

// 광고 표시 (0.6.0): 사이트가 직접 붙인 표시만 믿는다. 부모 영역의 banner·promotion 같은 단어는 쓰지 않는다
//   (쿠팡 자체 기획전도 promotion-banner 안에 있어서 광고와 구별되지 않음).
//   - 주소의 광고 파라미터 이름: ?adType=DA (쿠팡 디스플레이 광고)
//   - 주소 파라미터 값 속 광고 단어: source=brandstore_display_ads
//   - 광고 data- 속성: data-adsplatform(쿠팡), data-ad-slot(구글 애드센스)
const AD = DICT.ads;
const AD_KEYS = new Set(AD.paramKeys);
const AD_WORD_RE = new RegExp(`(?:^|[_\\-.])(?:${AD.valueWords.join('|')})(?:[_\\-.]|$)`, 'i');
function isAd(url, dataAttrs) {
  if (url) {
    for (const [key, value] of url.searchParams) {
      if (AD_KEYS.has(key.toLowerCase()) && value.trim() !== '') return true;
      if (AD_WORD_RE.test(value)) return true;
    }
  }
  return Object.keys(dataAttrs || {}).some((name) => AD.dataAttrPrefixes.some((p) => name.toLowerCase().startsWith(p)));
}

/**
 * 광고 번호 붙이기: [A]로 확정된 항목에 페이지 순서대로 "광고 1", "광고 2"…를 붙인다.
 * 광고는 자주 바뀌므로 내용 대신 "광고라는 사실"과 자리만 알려 준다 (사용자가 건너뛸 수 있게).
 */
export function numberAds(report) {
  let n = 0;
  for (const item of report) {
    if (item.match?.pattern === 'AD') item.match.label = `${AD.label} ${++n}`;
  }
  return report;
}

// 슬라이드 점 (0.6.0): 슬라이드 아래의 작은 점 버튼. 이름이 '0', '1'처럼 숫자뿐이라 의미 없는 이름으로 잡힌다.
//   (쿠팡 카테고리 베스트: <ol class="dot-navi"><li><a href="#" title="0">0</a></li>… 18묶음 × 8개 = 144개가 매번 AI로 갔다)
//   요소·부모·그 위 두 단계 class에 점 단어가 있을 때만 본다. 'pagination'은 목록의 쪽 번호일 수 있어 쓰지 않는다.
const DOTS = DICT.slideDots;
const DOT_WORDS = new Set(DOTS.classWords);
const NUMBER_NAME_RE = /^\d{1,2}$/;

/**
 * 광고·배너·슬라이드 점 번호 붙이기. matchItem은 항목 하나만 보므로, 순서가 필요한 이름은 report 전체를 보고 정한다.
 * - 광고: 페이지 순서대로 "광고 1", "광고 2"…
 * - 배너: 페이지 순서대로 "배너 이미지 1", "배너 이미지 2"… (광고와 번호를 따로 센다)
 * - 슬라이드 점: 화면의 숫자를 그대로 쓰되, 0부터 시작하는 묶음(0, 1, 2…)은 1을 더해 "슬라이드 1"부터 읽히게 한다.
 *   숫자가 1씩 늘어나는 동안을 한 묶음으로 본다 (쿠팡은 카테고리마다 0~7이 반복된다).
 */
export function numberLabels(report) {
  numberAds(report);
  let banners = 0;
  for (const item of report) {
    if (item.match?.pattern === 'BANNER') item.match.label = `${BANNER.label} ${++banners}`;
  }
  let group = [];
  const flush = () => {
    const base = Number(group[0]?.currentName) === 0 ? 1 : 0;
    for (const item of group) item.match.label = `${DOTS.label} ${Number(item.currentName) + base}`;
    group = [];
  };
  for (const item of report) {
    if (item.match?.pattern !== 'DOT') continue;
    const last = group.at(-1);
    if (last && Number(item.currentName) !== Number(last.currentName) + 1) flush();
    group.push(item);
  }
  flush();
  return report;
}

// 콘텐츠형 중 배너 (0.7.0): 콘텐츠형은 사전도 AI도 이름을 붙이지 않아 화면 읽기에서 "링크"로만 읽혔다.
//   그중 누가 봐도 배너인 것만 "배너 이미지 N"으로 알려 준다 (쿠팡 날개 영역의 자체 기획전 배너 등).
//   조건을 모두 만족할 때만: 이름 없음(글자 없음) + 링크 안에 그림 + 옆·부모에 대신 읽을 글자 없음
//   + 요소·부모·위 두 단계 class나 그림 주소에 배너 단어. 뉴스 사진·상품 카드처럼 옆에 제목이 있는 것은 제외한다.
//   AI로 가는 항목(판정 ai)은 건드리지 않는다: AI가 그림을 보고 더 나은 이름을 붙일 수 있기 때문.
const BANNER = DICT.bannerImages;
const BANNER_WORDS = new Set(BANNER.words);
//   또 하나: 안에 그림도 글자도 없는 큰 링크(배경 그림 위에 덮은 투명 링크, 예: 쿠팡 "오늘의 쇼핑 제안" 큰 그림)도 배너로 본다.
function contentResult(item, c) {
  const hasClue = (tokens) => tokens.some((t) => BANNER_WORDS.has(t));
  const r = c.rect;
  const noNear = ![c.prevSiblingText, c.nextSiblingText, c.parentText].some((t) => (t || '').trim());
  const imageBanner = Boolean(c.iconSrc)
    && ([c.id, c.className, c.parentClass, c.ancestorClass, c.iconClass].some((v) => hasClue(classTokens(v)))
      || hasClue(tokenize(c.iconSrc)));
  const overlay = !c.iconSrc && !c.iconClass && Boolean(r) && r.w >= T.largeMinWidth && r.h >= T.largeMinHeight;
  const banner = item.status === 'empty' && noNear && (imageBanner || overlay);
  return banner ? result('confirm', 'BANNER', BANNER.label, 100) : result('content', 'C');
}

// 숨겨진 진짜 이름 (0.8.0): 진짜 이름은 화면 읽기에서 숨겨지고 배지·상태 글자("N", "0", "OFF")만 읽히는 요소.
//   ②가 reason: 'hidden-name'과 숨겨진 글자(hiddenText)를 넘겨 준다 (예: 넥슨 "N" 배지 + 숨겨진 "넥슨현대카드").
//   사이트가 직접 붙여 둔 이름이라 사전 추측보다 정확하므로 가장 먼저 본다.
//   다만 짧은 이름 모양일 때만: 글자가 있고, hiddenNameMaxLen자 이하, hiddenNameMaxWords단어 이하.
//   (숨겨진 하위 메뉴 전체처럼 긴 글은 이름이 아니므로 평소 판별로 넘긴다)
function hiddenName(item) {
  if (item.reason !== 'hidden-name') return null;
  const text = (item.hiddenText || '').replace(/\s+/g, ' ').trim();
  if (!text || !/\p{L}/u.test(text)) return null;
  if ([...text].length > T.hiddenNameMaxLen || text.split(' ').length > T.hiddenNameMaxWords) return null;
  return text;
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

  // [H] 숨겨진 진짜 이름 (0.8.0)
  const hidden = hiddenName(item);
  if (hidden) return result('confirm', 'H', hidden, 100);

  // [A] 광고 (0.6.0): 실제 주소가 있는 링크만. 광고 영역 안의 닫기·이전·다음 버튼은 해당하지 않는다.
  if (role === 'link' && realUrl && isAd(url, c.dataAttrs)) return result('confirm', 'AD', AD.label, 100);

  // [D] 슬라이드 점 (0.6.0): 실제 주소가 없는(페이지 안에서 동작하는) 숫자 이름 요소만
  if (!realUrl && NUMBER_NAME_RE.test((item.currentName || '').trim())
      && [c.className, c.parentClass, c.ancestorClass].some((cls) => classTokens(cls).some((t) => DOT_WORDS.has(t)))) {
    return result('confirm', 'DOT', DOTS.label, 100);
  }

  // [0] 콘텐츠형 가려내기 (#17): 주소에 5자리 이상 숫자가 있으면 콘텐츠형 후보.
  //   다만 요소 자신(class·id·아이콘·data-)이 기능을 분명히 가리키면 그 기능으로 확정한다.
  //   (예: e-class 게시판 "+" 링크 view.php?id=147981 + class btn-more → 더보기)
  //   주소 단어는 쓰지 않는다: '/login?trcid=812431326273' 같은 배너는 계속 콘텐츠형.
  const contentLike = realUrl && CONTENT_RE.test(href);
  // 큰 요소 (0.6.0): 배너·카드는 주소가 "어디로 가는지"만 말하고 "무엇인지"는 말해 주지 않는다.
  //   (예: 카피킬러 인용 검증 배너 href="/login?success_return_url=/citation-verify" → "로그인"이 아님)
  //   그래서 주소(F1·F2·경로 단어)는 쓰지 않고 요소 자신의 단서로만 판단하며, 확정이 안 되면 AI로 넘긴다.
  //   기능 버튼은 작다: 수집 데이터 161개 중 사전으로 확정된 요소는 높이가 모두 60px 이하였다.
  const r = c.rect;
  const large = Boolean(r) && r.w >= T.largeMinWidth && r.h >= T.largeMinHeight;
  const urlUnusable = contentLike || large;

  if (!urlUnusable && url && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
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
    path: sameSite && !urlUnusable ? tokenize(url.pathname) : [],
    self: [...tokenize(c.id), ...classTokens(c.className)].filter(notCommon),
    icon: [...classTokens(c.iconClass).filter(notCommon), ...tokenize(fileStem(c.iconSrc))],
    data: dataTokens(c.dataAttrs).filter((t) => !common.data.has(t)),   // data- 속성 쪽은 따로
  };
  const dataValues = dataValuesOf(c.dataAttrs);   // 한국어 값 비교용 ('검색창')
  const name = item.currentName || '';
  if (item.status === 'meaningless' && FILENAME_RE.test(name)) {
    src.icon.push(...tokenize(name.replace(/\.[^.]*$/, '')));   // 'ic_search.png'은 아이콘 파일명과 같다
  }
  const nearTexts = [c.prevSiblingText, c.nextSiblingText, c.parentText]
    .filter((t) => t && [...t].length <= T.nearMaxLen);          // 짧은 이웃 글자만
  const nearClass = classTokens(c.parentClass).filter(notCommon);

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
  if (scored.length === 0) return contentLike ? contentResult(item, c) : result('ai', null);

  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const hasDirect = Object.keys(best.evidence).some((k) => DIRECT.has(k));
  const top = scored.slice(0, 3);                                // AI에 넘길 상위 후보
  if (hasDirect && best.score >= T.confirm && best.score - (second?.score || 0) >= T.margin) {
    return result('confirm', 'F3', best.label, best.score, top);
  }
  if (contentLike) return contentResult(item, c);
  return result('ai', null, null, 0, top);
}

/** report 전체에 매칭 결과를 붙인다 (각 항목에 match 필드 추가) */
export function matchAll(report, pageUrl) {
  const common = pageCommon(report);
  for (const item of report) item.match = matchItem(item, pageUrl, common);
  return numberLabels(report);
}
