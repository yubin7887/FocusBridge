// ③ 기능 사전 매칭 단위 테스트 (브라우저 없이 Node로 실행)
import assert from 'node:assert/strict';
import { tokenize, fileStem } from '../src/tokenizer.js';
import { matchItem, matchAll, pageCommon } from '../src/matcher.js';

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
check('[3] AI로 넘길 때 후보를 함께 준다', () =>
  assert.equal(matchItem(item({ className: 'search close' }), PAGE).candidates.length, 2));
check('단서가 전혀 없으면 AI로', () => assert.equal(matchItem(item({}), PAGE).decision, 'ai'));

// ── 페이지 공통 단어 (최종 시험 1차: 인프런 Mantine 라이브러리 함정) ──
const mantine = (extra) => item({ className: `mantine-focus-auto mantine-next-Pagination-control ${extra}`,
  parentClass: 'mantine-next-Group-root' });
check('라이브러리 이름 속 next가 모든 버튼에 있으면 공통 단어로 뺀다', () =>
  assert.ok(pageCommon([mantine(''), mantine(''), mantine(''), mantine(''), mantine('')]).cls.has('next')));
check('공통 단어로 빠지면 "다음"으로 확정하지 않는다', () => {
  const report = [mantine(''), mantine(''), mantine(''), mantine(''), mantine('')];
  matchAll(report, PAGE);
  assert.ok(report.every((r) => r.match.decision === 'ai'));
});
check('공통 단어가 아니면 그대로 쓴다 (5개 중 1개만 next)', () => {
  const report = [item({ className: 'btn-next' }), item({ className: 'a1' }), item({ className: 'b1' }),
    item({ className: 'c1' }), item({ className: 'd1' })];
  matchAll(report, PAGE);
  assert.equal(report[0].match.label, '다음');
});
check('항목이 4개 미만이면 공통 단어를 찾지 않는다', () =>
  assert.equal(pageCommon([mantine(''), mantine(''), mantine('')]).cls.size, 0));

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
  const report = [mantine(''), mantine(''), mantine(''), mantine(''), mantine('')];
  report[0].context.dataAttrs = { 'data-type': 'next' };
  report[1].context.dataAttrs = { 'data-type': 'previous' };
  matchAll(report, PAGE);
  assert.equal(report[0].match.label, '다음');
  assert.equal(report[1].match.label, '이전');
  assert.equal(report[2].match.decision, 'ai');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
