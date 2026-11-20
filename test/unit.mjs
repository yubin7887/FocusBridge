// ③ 기능 사전 매칭 단위 테스트 (브라우저 없이 Node로 실행)
import assert from 'node:assert/strict';
import { tokenize, fileStem } from '../src/tokenizer.js';
import { matchItem, matchAll, pageCommon, numberAds, numberLabels } from '../src/matcher.js';

let pass = 0, fail = 0;
function check(title, fn) {
  try { fn(); pass++; console.log('PASS ', title); }
  catch (e) { fail++; console.log('FAIL ', title, '\n      ', e.message.split('\n')[0]); }
}

// ── 토큰화 ──
check('kebab-case 자르기 + 불용어 제거', () =>
  assert.deepEqual(tokenize('btn-nobtn btn-notification'), ['nobtn', 'notification']));
check('camelCase 자르기', () => assert.deepEqual(tokenize('iconSearchBtn'), ['search']));
check('snake_case + 확장자', () => assert.deepEqual(tokenize('ic_search.png'), ['search']));
check('디자인 도구 class는 전부 버림', () =>
  assert.deepEqual(tokenize('fw-h-[36px] s1024:fw-w-[44px] _15fGuLwC'), []));
check('자동 생성 class 속 의미 단어는 살림', () =>
  assert.ok(tokenize('Searchbar__TextFieldWrap-sc-dzagxs-2').includes('searchbar')));
check('빈 값', () => assert.deepEqual(tokenize(null), []));
check('그림 주소 → 파일 이름', () =>
  assert.equal(fileStem('https://cdn.x.com/img/ico_search_24.png?v=3'), 'ico_search_24'));
check('해시 붙은 파일 이름', () => assert.deepEqual(tokenize(fileStem('/media/person.07e45e52.png')), ['person']));
check('data: 주소는 무시', () => assert.equal(fileStem('data:image/png;base64,AAAA'), ''));

// ── 매칭 ──
const PAGE = 'https://www.example.com/';
const item = (context, extra = {}) => ({ status: 'empty', role: 'button', currentName: '', ...extra, context });

check('[0] 주소에 5자리 숫자 → 콘텐츠형', () =>
  assert.equal(matchItem(item({ href: '/products/7481213' }, { role: 'link' }), PAGE).decision, 'content'));
check('[0] 주소가 로그인이어도 배너 번호가 있으면 콘텐츠형', () =>
  assert.equal(matchItem(item({ href: '/login?trcid=812431326273' }, { role: 'link' }), PAGE).decision, 'content'));
// #17: 주소에 숫자가 있어도 요소 자신의 단서가 기능을 분명히 가리키면 그 기능
const ECLASS = 'https://eclass.dongguk.edu/course/view.php?id=12345';
check('[0] #17 e-class 게시판 "+" 링크: 주소에 id 숫자가 있어도 btn-more + fa-plus → 더보기', () => {
  const r = matchItem(item({ href: 'https://eclass.dongguk.edu/mod/ubboard/view.php?id=147981',
    className: 'btn btn-default btn-more', iconClass: 'fa fa-plus' }, { role: 'link' }), ECLASS);
  assert.equal(r.decision, 'confirm'); assert.equal(r.label, '더보기');
});
check('[0] #17 숫자 주소에서는 주소 단어(login)를 단서로 쓰지 않는다 → 콘텐츠형 유지', () =>
  assert.equal(matchItem(item({ href: '/login?trcid=812431326273', className: 'banner-img' }, { role: 'link' }), PAGE).decision, 'content'));
check('[0] #17 이웃 글자만 있는 숫자 주소 링크는 콘텐츠형 유지', () =>
  assert.equal(matchItem(item({ href: '/products/7481213', parentText: '더보기' }, { role: 'link' }), PAGE).decision, 'content'));
check('[0] #17 숫자 주소 링크에도 거름망 유지 (close class라도 닫기가 아님)', () =>
  assert.equal(matchItem(item({ href: '/notice/view?id=55555', className: 'close' }, { role: 'link' }), PAGE).decision, 'content'));
check('[0] #17 숫자 주소 링크에서 두 기능이 동점이면 콘텐츠형', () =>
  assert.equal(matchItem(item({ href: '/v/123456', className: 'cart more' }, { role: 'link' }), PAGE).decision, 'content'));

// 0.6.0: 큰 요소(배너·카드)는 주소를 단서로 쓰지 않는다 (카피킬러 인용 검증 배너가 "로그인"으로 붙던 문제)
const BIG = { x: 12, y: 300, w: 780, h: 320 };
check('[0] 큰 배너의 주소 /login은 단서로 쓰지 않음 → AI로', () =>
  assert.equal(matchItem(item({ href: '/login?success_return_url=/citation-verify', className: 'mhItem-banner', rect: BIG }, { role: 'link' }),
    'https://dongguk.copykiller.com/').decision, 'ai'));
check('[0] 작은 /login 링크는 그대로 로그인', () =>
  assert.equal(matchItem(item({ href: '/login', rect: { x: 0, y: 0, w: 60, h: 24 } }, { role: 'link' }), PAGE).label, '로그인'));
check('[0] 큰 배너가 다른 사이트(인스타그램)로 가도 인스타그램으로 확정하지 않음', () =>
  assert.equal(matchItem(item({ href: 'https://www.instagram.com/x', rect: BIG }, { role: 'link' }), PAGE).decision, 'ai'));
check('[0] 큰 요소라도 요소 자신의 단서가 분명하면 확정', () =>
  assert.equal(matchItem(item({ href: '/notice', className: 'btn-more', rect: BIG }, { role: 'link' }), PAGE).label, '더보기'));
check('[0] 큰 요소의 숫자 주소는 계속 콘텐츠형 (큰 상품 사진 링크)', () =>
  assert.equal(matchItem(item({ href: '/product/7481213', rect: BIG, iconSrc: '/img/goods/7481213.jpg' }, { role: 'link' }), PAGE).decision, 'content'));
check('[0] 넓은 검색창(712×36)은 큰 요소가 아님', () =>
  assert.equal(matchItem(item({ className: 'search-bar', rect: { x: 0, y: 0, w: 712, h: 36 } }), PAGE).label, '검색'));

check('[1] 다른 사이트: 인스타그램', () =>
  assert.equal(matchItem(item({ href: 'https://www.instagram.com/x' }, { role: 'link' }), PAGE).label, '인스타그램'));
check('[1] 기호 x보다 주소(X 트위터)가 우선', () =>
  assert.equal(matchItem(item({ href: 'https://twitter.com/a' }, { role: 'link', status: 'meaningless', currentName: 'x' }), PAGE).label, 'X(트위터)'));
check('[2] 같은 사이트 첫 화면 → 홈 (www 차이 무시)', () =>
  assert.equal(matchItem(item({ href: 'https://example.com' }, { role: 'link' }), PAGE).label, '홈'));
check('[2] 같은 회사 다른 서비스 첫 화면은 홈이 아님', () =>
  assert.notEqual(matchItem(item({ href: 'https://news.example.com/' }, { role: 'link' }), PAGE).label, '홈'));
check('[3] 아이콘 class 하나로 확정', () => {
  const r = matchItem(item({ iconClass: 'fa fa-search' }), PAGE);
  assert.equal(r.decision, 'confirm'); assert.equal(r.label, '검색');
});
check('[3] 이웃 글자만으로는 확정하지 않음', () =>
  assert.equal(matchItem(item({ nextSiblingText: '알림' }), PAGE).decision, 'ai'));
check('[3] 닫기 class가 옆의 "알림" 글자를 이김', () =>
  assert.equal(matchItem(item({ className: 'close', prevSiblingText: '알림' }), PAGE).label, '닫기'));
check('[3] 거름망: 실제 주소가 있는 링크는 메뉴가 될 수 없음', () =>
  assert.equal(matchItem(item({ className: 'menu-bar-logo', href: '/membership' }, { role: 'link' }), PAGE).decision, 'ai'));
check('[3] 거름망: 주소가 #인 링크는 메뉴 가능', () =>
  assert.equal(matchItem(item({ className: 'btn_sidemenu', href: '#' }, { role: 'link' }), PAGE).label, '메뉴'));
check('[3] 두 기능이 동점이면 AI로', () =>
  assert.equal(matchItem(item({ className: 'search close' }), PAGE).decision, 'ai'));
check('[3] CSS 위치 클래스 top을 맨 위로 기능으로 확정하지 않음', () => {
  const className = "rounded-full before:-top-px after:-top-px top-0 sm:top-[3px]";
  assert.equal(matchItem(item({ className }), PAGE).decision, 'ai');
  assert.equal(matchItem(item({ className: 'back-to-top fixed top-0' }), PAGE).label, '맨 위로');
});
check('[3] AI로 넘길 때 후보를 함께 준다', () =>
  assert.equal(matchItem(item({ className: 'search close' }), PAGE).candidates.length, 2));
check('단서가 전혀 없으면 AI로', () => assert.equal(matchItem(item({}), PAGE).decision, 'ai'));

// ── 페이지 공통 단어 (최종 시험 1차: 인프런 Mantine 라이브러리 함정 / 0.4.0: 비율 → 종류 수) ──
// 실제 인프런처럼 부품 종류(class)가 서로 다른 Mantine 버튼들. 모두 mantine-next-… 를 가진다.
const MANTINE_KINDS = ['ActionIcon-root', 'Carousel-control', 'Pagination-control', 'Chip-root', 'Badge-root'];
const mantine = (kind) => item({ className: `mantine-focus-auto mantine-next-${kind}`,
  parentClass: 'mantine-next-Group-root' });
const mantinePage = () => MANTINE_KINDS.map(mantine);
check('라이브러리 이름 속 next가 서로 다른 종류의 버튼에 두루 있으면 공통 단어로 뺀다', () =>
  assert.ok(pageCommon(mantinePage()).cls.has('next')));
check('공통 단어로 빠지면 "다음"으로 확정하지 않는다', () => {
  const report = mantinePage();
  matchAll(report, PAGE);
  assert.ok(report.every((r) => r.match.decision === 'ai'));
});
check('공통 단어가 아니면 그대로 쓴다 (5개 중 1개만 next)', () => {
  const report = [item({ className: 'btn-next' }), item({ className: 'a1' }), item({ className: 'b1' }),
    item({ className: 'c1' }), item({ className: 'd1' })];
  matchAll(report, PAGE);
  assert.equal(report[0].match.label, '다음');
});
check('서로 다른 종류가 3가지 미만이면 공통 단어로 보지 않는다', () =>
  assert.equal(pageCommon(MANTINE_KINDS.slice(0, 2).map(mantine)).cls.has('next'), false));
check('같은 종류의 버튼이 반복되는 단어는 기능 단어로 남긴다 (더보기 링크 6개)', () => {
  const more = () => item({ className: 'btn-more', href: '#', parentClass: 'section-head' }, { role: 'link' });
  const report = [more(), more(), more(), more(), more(), more(), item({ className: 'navbar-toggler' })];
  matchAll(report, PAGE);
  assert.ok(report.slice(0, 6).every((r) => r.match.label === '더보기'));
});
check('e-class 이슈: 누락 요소가 3개에서 4개(#top 추가)가 돼도 btn-action-more 결과가 같다', () => {
  const nav = () => item({ className: 'navbar-toggler', iconClass: 'fa fa-bars' });
  const more = () => item({ className: 'btn-action-more', href: '#', parentClass: 'card-header' }, { role: 'link' });
  const top = () => item({ className: 'scroll-to-top', href: '#top', iconClass: 'fa fa-angle-up' }, { role: 'link' });
  const three = [nav(), more(), more()];
  const four = [nav(), more(), more(), top()];
  matchAll(three, PAGE); matchAll(four, PAGE);
  for (const i of [1, 2]) {
    assert.equal(three[i].match.label, '더보기');
    assert.equal(four[i].match.label, '더보기');
  }
});
check('흔한 단어가 없는 요소를 추가해도 기존 요소의 결과는 바뀌지 않는다 (인프런 + 상관없는 요소 15개)', () => {
  const report = mantinePage();
  const filler = Array.from({ length: 15 }, (_, i) => item({ className: `card-link-${String.fromCharCode(97 + i)}x`, href: '#' }, { role: 'link' }));
  const mixed = [...mantinePage(), ...filler];
  matchAll(report, PAGE); matchAll(mixed, PAGE);
  report.forEach((r, i) => assert.equal(mixed[i].match.decision, r.match.decision));
  assert.ok(mixed.slice(0, 5).every((r) => r.match.label !== '다음'));
});

// ── data- 속성 (0.3.0) ──
check('data-type="next" → 다음', () =>
  assert.equal(matchItem(item({ dataAttrs: { 'data-type': 'next' } }), PAGE).label, '다음'));
check('한국어 data- 값 "검색창" → 검색', () =>
  assert.equal(matchItem(item({ dataAttrs: { 'data-button-name': '검색창' } }), PAGE).label, '검색'));
check('JSON 모양 값 속 단어도 읽음 { id: \'cart\' }', () =>
  assert.equal(matchItem(item({ dataAttrs: { 'data-log': "{ id: 'cart' }" } }, { role: 'link' }), PAGE).label, '장바구니'));
check('상태 표시 값(true, default)은 무시', () =>
  assert.equal(matchItem(item({ dataAttrs: { 'data-disabled': 'true', 'data-variant': 'default' } }), PAGE).decision, 'ai'));
check('class에서 흔한 next가 data-type="next"까지 지우지 않음 (출처별로 따로 셈)', () => {
  const report = mantinePage();
  report[0].context.dataAttrs = { 'data-type': 'next' };
  report[1].context.dataAttrs = { 'data-type': 'previous' };
  matchAll(report, PAGE);
  assert.equal(report[0].match.label, '다음');
  assert.equal(report[1].match.label, '이전');
  assert.equal(report[2].match.decision, 'ai');
});

// ── 상태 data- 속성 (0.5.0, 이슈 #13: Photoroom 색상 선택 버튼에 "닫기") ──
const PHOTOROOM_SWATCH = "interaction-transition relative box-border flex h-10 w-10 items-center justify-center rounded-full outline-hidden transition-all bg-[radial-gradient(50%_50%_at_50%_50%,#FFF_7.29%,rgba(255,255,255,0.00)_100%),conic-gradient(from_180deg_at_50%_50%,#FF4040_0deg,#FFDF40_60.00000178813934deg,#3DF297_120.00000357627869deg,#40DFFF_180deg,#6040FF_240.00000715255737deg,#FF40FF_299.9999928474426deg,#FF4040_360deg)] hover:border-neutral-alpha-300 before:interaction-transition before:absolute before:rounded-full before:content-[''] before:h-full before:w-full before:start-0 before:top-0 active:before:bg-neutral-alpha-300 after:interaction-transition after:absolute after:rounded-full after:content-[''] after:misc-border-size-default after:h-full after:w-full after:start-0 after:top-0 focus-visible:ring-misc-focus-indicator focus-visible:misc-border-size-focus-ring after:border-misc-border";
check('이슈 #13: 팝업을 여는 버튼의 data-state="closed"는 "닫기"가 아니다 (실제 Photoroom 버튼)', () =>
  assert.equal(matchItem(item({ className: PHOTOROOM_SWATCH, dataAttrs: { 'data-state': 'closed' } }), 'https://www.photoroom.com/ko/tools/background-remover').decision, 'ai'));
check('상태 data- 속성의 다른 값(open, checked …)도 단서로 쓰지 않는다', () => {
  for (const v of ['open', 'checked', 'unchecked', 'active', 'on']) {
    assert.equal(matchItem(item({ dataAttrs: { 'data-state': v } }), PAGE).decision, 'ai', v);
  }
});
check('다른 이름의 속성이나 class에 들어온 상태 단어 closed도 "닫기"가 아니다', () => {
  assert.equal(matchItem(item({ dataAttrs: { 'data-status': 'closed' } }), PAGE).decision, 'ai');
  assert.equal(matchItem(item({ className: 'dropdown is-closed' }), PAGE).decision, 'ai');
});
check('상태 속성과 함께 있는 기능 단서는 그대로 쓴다 (data-state + data-type="next")', () =>
  assert.equal(matchItem(item({ dataAttrs: { 'data-state': 'closed', 'data-type': 'next' } }), PAGE).label, '다음'));
check('진짜 닫기 단서는 그대로 닫기 (data-testid="close-button", class="modal-close")', () => {
  assert.equal(matchItem(item({ dataAttrs: { 'data-testid': 'close-button' } }), PAGE).label, '닫기');
  assert.equal(matchItem(item({ className: 'modal-close' }), PAGE).label, '닫기');
});

// ── 광고 (0.6.0, #16): 링크 자신에 광고 표시가 있으면 "광고 N" (AI 없이) ──
const CP = 'https://www.coupang.com/';
const adLink = (href, extra = {}) => item({ href, ...extra }, { role: 'link' });
check('광고: 주소의 adType=DA → 광고', () =>
  assert.equal(matchItem(adLink('/np/campaigns/82?adType=DA&eventId=6FcSyADwoVn7xuT5'), CP).pattern, 'AD'));
check('광고: 주소 값의 display_ads → 광고 (숫자 주소라도 콘텐츠형보다 우선)', () =>
  assert.equal(matchItem(adLink('https://shop.coupang.com/ottogi/294249?source=brandstore_display_ads'), CP).label, '광고'));
check('광고: data-adsplatform 속성 → 광고', () =>
  assert.equal(matchItem(adLink('/x', { dataAttrs: { 'data-adsplatform': '{}' } }), CP).pattern, 'AD'));
check('광고 아님: 광고 표시 없는 자체 기획전 (promotion-banner 안)', () =>
  assert.notEqual(matchItem(adLink('https://www.coupang.com/np/campaigns/1440', { parentClass: 'promotion-banner' }), CP).pattern, 'AD'));
check('광고 아님: utm_medium=non_paid, from=home_ad_banner, data-add-to-cart', () => {
  assert.notEqual(matchItem(adLink('https://wing.coupang.com/signup?utm_medium=non_paid'), CP).pattern, 'AD');
  assert.notEqual(matchItem(adLink('/p?from=home_ad_banner'), CP).pattern, 'AD');
  assert.notEqual(matchItem(adLink('/x', { dataAttrs: { 'data-add-to-cart': '1' } }), CP).pattern, 'AD');
});
check('광고 아님: 버튼은 광고 표시가 있어도 대상 아님 (광고 닫기·이전·다음 버튼 보호)', () =>
  assert.notEqual(matchItem(item({ className: 'close', dataAttrs: { 'data-ad-slot': '1' } }), CP).pattern, 'AD'));
check('광고 번호: 광고만 페이지 순서대로 광고 1, 광고 2', () => {
  const report = [adLink('/a?adType=DA'), adLink('//cart.coupang.com/cartView.pang'), adLink('/b?adType=DA')];
  matchAll(report, CP);
  assert.deepEqual(report.map((r) => r.match.label), ['광고 1', '장바구니', '광고 2']);
});
check('광고 번호: numberAds를 다시 불러도 1부터 다시 센다', () => {
  const report = [adLink('/a?adType=DA'), adLink('/b?adType=DA')];
  matchAll(report, CP); numberAds(report);
  assert.deepEqual(report.map((r) => r.match.label), ['광고 1', '광고 2']);
});

// ── 슬라이드 점 (0.6.0, #16 쿠팡 AI 요청 횟수): 숫자 이름 + 점 묶음 class → "슬라이드 N" ──
const dot = (n, extra = {}) => item({ href: '#', ancestorClass: 'dot-navi best-product-list', ...extra },
  { role: 'link', status: 'meaningless', currentName: String(n) });
check('슬라이드 점: 쿠팡 dot-navi의 0~7 → 슬라이드 1~8, 묶음이 바뀌면 다시 1부터', () => {
  const report = [...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => dot(n)), ...[0, 1, 2].map((n) => dot(n))];
  matchAll(report, CP);
  assert.deepEqual(report.map((r) => r.match.label),
    ['슬라이드 1', '슬라이드 2', '슬라이드 3', '슬라이드 4', '슬라이드 5', '슬라이드 6', '슬라이드 7', '슬라이드 8', '슬라이드 1', '슬라이드 2', '슬라이드 3']);
});
check('슬라이드 점: 1부터 시작하는 묶음은 그대로 (slick-dots 1, 2, 3)', () => {
  const report = [1, 2, 3].map((n) => item({ parentClass: 'slick-dots' }, { status: 'meaningless', currentName: String(n) }));
  matchAll(report, CP);
  assert.deepEqual(report.map((r) => r.match.label), ['슬라이드 1', '슬라이드 2', '슬라이드 3']);
});
check('슬라이드 점 아님: 쪽 번호(pagination)와 실제 주소가 있는 숫자 링크', () => {
  assert.notEqual(matchItem(item({ href: '#', ancestorClass: 'pagination' }, { role: 'link', status: 'meaningless', currentName: '2' }), CP).pattern, 'DOT');
  assert.notEqual(matchItem(dot(2, { href: '/list?page=2' }), CP).pattern, 'DOT');
});
check('슬라이드 점 아님: 점 묶음 안이라도 이름이 숫자가 아니면 (빈 이름)', () =>
  assert.notEqual(matchItem(item({ href: '#', ancestorClass: 'dot-navi' }, { role: 'link' }), CP).pattern, 'DOT'));
check('numberLabels는 광고와 슬라이드 점 번호를 함께 붙인다', () => {
  const report = [adLink('/a?adType=DA'), dot(0), dot(1), adLink('/b?adType=DA')];
  matchAll(report, CP); numberLabels(report);
  assert.deepEqual(report.map((r) => r.match.label), ['광고 1', '슬라이드 1', '슬라이드 2', '광고 2']);
});

// ── 콘텐츠형 중 배너 (0.7.0): 그림만 있고 옆 글자 없음 + 배너 단서 → "배너 이미지 N" ──
const bannerLink = (href, extra = {}) => item({ href, iconSrc: 'https://image.coupangcdn.com/image/displayitem/x.jpg', ...extra }, { role: 'link' });
check('배너: 쿠팡 날개 영역(promotion-banner) 자체 기획전 → 배너 이미지', () =>
  assert.equal(matchItem(bannerLink('https://pages.coupang.com/p/179723', { ancestorClass: 'promotion-banner wa-sidebar' }), CP).pattern, 'BANNER'));
check('배너: 그림 주소의 /banner/ 도 단서', () =>
  assert.equal(matchItem(bannerLink('/mlp/web/mlp-landing-page?landingId=5418&trcid=812431344920',
    { iconSrc: 'https://image4.coupangcdn.com/image/ccm/banner/73ae37c9.png' }), CP).pattern, 'BANNER'));
check('배너 번호: 광고와 따로 세어 배너 이미지 1, 2', () => {
  const report = [bannerLink('https://pages.coupang.com/p/179723', { parentClass: 'promo' }), adLink('/a?adType=DA'),
    bannerLink('https://pages.coupang.com/p/164807', { parentClass: 'promo' })];
  matchAll(report, CP);
  assert.deepEqual(report.map((r) => r.match.label), ['배너 이미지 1', '광고 1', '배너 이미지 2']);
});
check('배너: 그림 없는 큰 투명 링크 (쿠팡 오늘의 쇼핑 제안 today-image, 1020×450)', () =>
  assert.equal(matchItem(item({ href: 'https://www.coupang.com/mlp/web/mlp-landing-page?landingId=5418&trcid=812431344920',
    className: 'today-image', rect: { x: 135, y: 222, w: 1020, h: 450 } }, { role: 'link' }), CP).pattern, 'BANNER'));
check('배너 아님: 그림 없는 작은 링크, 또는 옆에 제목이 있는 큰 투명 링크(카드 덮개)', () => {
  assert.equal(matchItem(item({ href: '/p/179723', rect: { x: 0, y: 0, w: 100, h: 40 } }, { role: 'link' }), CP).decision, 'content');
  assert.equal(matchItem(item({ href: '/p/179723', rect: { x: 0, y: 0, w: 300, h: 300 }, nextSiblingText: '상품 이름' }, { role: 'link' }), CP).decision, 'content');
});
check('배너 아님: 옆에 제목 글자가 있는 사진 링크 (뉴스 사진·상품 카드)', () =>
  assert.equal(matchItem(bannerLink('https://pages.coupang.com/p/179723', { ancestorClass: 'promotion-banner', prevSiblingText: '기사 제목' }), CP).decision, 'content'));
check('배너 아님: 배너 단서가 없는 그림 링크 (상품 사진)', () =>
  assert.equal(matchItem(bannerLink('https://www.musinsa.com/products/4012345'), 'https://www.musinsa.com/').decision, 'content'));
check('배너 아님: 그림이 없는 링크', () =>
  assert.equal(matchItem(item({ href: 'https://pages.coupang.com/p/179723', ancestorClass: 'promotion-banner' }, { role: 'link' }), CP).decision, 'content'));
check('배너 아님: AI로 가는 항목은 그대로 AI (숫자 4자리 /np/campaigns/1440)', () =>
  assert.equal(matchItem(bannerLink('https://www.coupang.com/np/campaigns/1440', { ancestorClass: 'promotion-banner' }), CP).decision, 'ai'));

// ── 숨겨진 진짜 이름 (0.8.0): ②가 넘긴 hiddenText가 짧은 이름 모양이면 그대로 쓴다 ──
const hiddenItem = (name, hiddenText, context = {}, extra = {}) =>
  ({ status: 'empty', role: 'link', currentName: name, reason: 'hidden-name', hiddenText, context, ...extra });
check('숨겨진 이름: 넥슨 "N" 배지 + 숨겨진 "넥슨현대카드" → 넥슨현대카드', () => {
  const r = matchItem(hiddenItem('N', '넥슨현대카드', { href: 'https://www.nexon.com/card' }), 'https://www.nexon.com/Home/Game');
  assert.equal(r.pattern, 'H'); assert.equal(r.label, '넥슨현대카드');
});
check('숨겨진 이름: 사전 단서보다 우선 (장바구니 배지 "0" + 숨겨진 "장바구니 담기")', () =>
  assert.equal(matchItem(hiddenItem('0', '장바구니 담기', { href: '//cart.coupang.com/cartView.pang' }), CP).label, '장바구니 담기'));
check('숨겨진 이름: 광고 표시가 있어도 사이트가 붙인 진짜 이름이 우선', () =>
  assert.equal(matchItem(hiddenItem('N', '오뚜기 브랜드관', { href: '/a?adType=DA' }), CP).label, '오뚜기 브랜드관'));
check('숨겨진 이름: 공백은 하나로 정리', () =>
  assert.equal(matchItem(hiddenItem('N', '  새   알림 ', {}, { role: 'button' }), PAGE).label, '새 알림'));
check('숨겨진 이름 안 씀: 숨겨진 하위 메뉴처럼 긴 글 (단어 6개 이상 / 30자 초과) → 평소 판별', () => {
  assert.notEqual(matchItem(hiddenItem('N', '홈 게임 커뮤니티 고객센터 이벤트 쿠폰', {}, { role: 'button' }), PAGE).pattern, 'H');
  assert.notEqual(matchItem(hiddenItem('N', '가'.repeat(31), {}, { role: 'button' }), PAGE).pattern, 'H');
});
check('숨겨진 이름 안 씀: 글자 없이 숫자·기호뿐', () =>
  assert.notEqual(matchItem(hiddenItem('N', '1,234 / 99+', {}, { role: 'button' }), PAGE).pattern, 'H'));
check('숨겨진 이름 안 씀: reason이 hidden-name이 아니면 hiddenText가 있어도 무시', () =>
  assert.notEqual(matchItem({ ...hiddenItem('N', '알림'), reason: null }, PAGE).pattern, 'H'));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
