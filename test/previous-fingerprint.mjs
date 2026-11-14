import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createPageKey, exactFingerprintMatch } from '../src/previous-fingerprint.js';

let passed = 0;
function check(title, actual, expected = true) {
  assert.deepEqual(actual, expected, title);
  console.log('PASS', title);
  passed++;
}
check('쿼리·해시 유지', createPageKey('https://example.com/shop?q=1#cart'), 'https://example.com/shop?q=1#cart');
check('잘못된 URL 거부', createPageKey('bad'), null);
check('로컬 파일 제외', createPageKey('file:///test.html'), null);
check('자격 증명 포함 URL 제외', createPageKey('https://user:pass@example.com'), null);
check('빈 비교 데이터 거부', exactFingerprintMatch({}, {}), false);

const bundle = await build({
  stdin: {
    contents: "export * from './src/previous-fingerprint.js';",
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'iife', globalName: 'fingerprints', write: false,
});
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const page = await browser.newPage();
  await page.route('https://example.com/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto('https://example.com/shop');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(() => {
    const { createFingerprint: capture, exactFingerprintMatch: match } = fingerprints;
    const output = [];
    const fixture = '<header id="header"><span>메뉴</span><button id="cart" class="action cart" data-action="cart" aria-expanded="false"><svg><use href="#cart-icon"></use></svg></button></header>';
    const reset = (html = fixture) => {
      history.replaceState(null, '', '/shop');
      document.body.innerHTML = html;
      return document.getElementById('cart');
    };
    const record = (title, value) => output.push([title, value]);
    let el = reset();
    const saved = capture(el);
    record('명시적 동작 정보가 있는 버튼 수집', saved.eligible);
    record('같은 DOM을 다시 만들어도 일치', match(saved, capture(reset())));
    el = reset();
    el.className = 'cart action action';
    record('class 순서·중복·공백 정규화', match(saved, capture(el)));
    el = reset();
    el.style.marginTop = '100px';
    record('화면 위치 변화 허용', match(saved, capture(el)));
    el = reset();
    document.body.className = 'coursemos-coursepage-main coursemos-coursepage-courseheader-show coursemos-headroom-pin';
    el.parentElement.className = 'fixed-top headroom headroom--top headroom--pinned headroom--not-bottom';
    const courseHeader = capture(el);
    document.body.className = 'coursemos-coursepage-main coursemos-headroom-unpin is-scrolled';
    el.parentElement.className = 'headroom headroom--not-top headroom--unpinned headroom--bottom';
    el.parentElement.classList.add('sticky-top');
    record('스크롤로 바뀐 상위 레이아웃 클래스는 같은 지문으로 처리', match(courseHeader, capture(el)));
    el.classList.add('is-scrolled');
    record('요소 자체의 클래스 변경은 비교에 포함', !match(courseHeader, capture(el)));
    el.classList.remove('is-scrolled');
    el.parentElement.classList.replace('sticky-top', 'different-header');
    record('상위 영역의 일반 클래스가 바뀌면 불일치', !match(courseHeader, capture(el)));
    document.body.removeAttribute('class');
    el = reset();
    el.parentElement.classList.add('sticky-top');
    el.parentElement.classList.remove('sticky-top');
    record('스크롤 클래스가 제거된 뒤 남은 빈 상위 class 속성은 무시', match(saved, capture(el)));
    for (const [title, mutate] of [
      ['동작 변경 거부', (node) => node.setAttribute('data-action', 'delete')],
      ['상태 변경 거부', (node) => node.setAttribute('aria-expanded', 'true')],
      ['아이콘 변경 거부', (node) => node.querySelector('use').setAttribute('href', '#delete-icon')],
      ['주변 문맥 변경 거부', (node) => node.previousElementSibling.textContent = '다른 메뉴'],
      ['역할 변경 거부', (node) => node.setAttribute('role', 'switch')],
      ['부모 변경 거부', (node) => node.parentElement.id = 'other'],
      ['정상 이름이 생기면 제외', (node) => node.setAttribute('aria-label', '장바구니')],
      ['분리된 요소 거부', (node) => node.remove()],
      ['중복 ID 거부', (node) => { const x = document.createElement('div'); x.id = node.id; document.body.append(x); }],
    ]) {
      el = reset(); mutate(el);
      record(title, !match(saved, capture(el)));
    }
    for (const url of ['/other', '/shop?a=1', '/shop#other']) {
      el = reset(); history.replaceState(null, '', url);
      record(`다른 페이지 제외: ${url}`, !match(saved, capture(el)));
    }
    el = reset(); el.removeAttribute('data-action');
    const iconOnly = capture(el);
    record('명시적 동작 없이 자기 식별자·아이콘·부모 단서 조합 허용', iconOnly.eligible);
    record('명시적 동작 없는 버튼도 재수집하면 정확히 일치', match(iconOnly, capture(el)));
    el.querySelector('use').setAttribute('href', '#delete-icon');
    record('완화된 후보도 아이콘 변경 시 거부', !match(iconOnly, capture(el)));
    el = reset(); el.removeAttribute('data-action'); el.querySelector('svg').remove();
    record('ID·class·위치만 있는 빈 버튼 거부', capture(el).reason === 'insufficient-evidence');
    el = reset(); el.removeAttribute('data-action'); el.parentElement.removeAttribute('id');
    record('부모 식별 단서 없는 아이콘 버튼 제외', capture(el).reason === 'insufficient-evidence');
    el = reset(); el.removeAttribute('data-action'); el.removeAttribute('id'); el.after(el.cloneNode(true));
    record('완화된 후보도 중복되면 거부', capture(el).reason === 'ambiguous-element');
    el = reset(); el.removeAttribute('id'); el.after(el.cloneNode(true));
    record('위치만 다른 동일 버튼 거부', capture(el).reason === 'ambiguous-element');
    el = reset(); el.previousElementSibling.textContent = 'x'.repeat(17000);
    record('긴 문맥은 잘라서 비교하지 않음', capture(el).reason === 'context-too-large');
    el = reset(); el.parentElement.append(document.createElement('input'));
    const withInput = capture(el);
    record('주변에 입력창이 있어도 비교 가능', withInput.eligible);
    el.nextElementSibling.value = 'private search text';
    el.nextElementSibling.setAttribute('value', 'private attribute');
    record('입력값을 수집하지 않고 입력에 따라 결과도 달라지지 않음',
      match(withInput, capture(el)) && !capture(el).canonical.includes('private'));
    el.nextElementSibling.setAttribute('name', 'other-search');
    record('입력창 식별 속성이 바뀌면 불일치', !match(withInput, capture(el)));
    el = reset();
    el.parentElement.insertAdjacentHTML('beforeend', '<span>로그인</span><aside>공지 1</aside>');
    const localContext = capture(el);
    el.parentElement.querySelector('aside').textContent = '공지 2';
    record('앞뒤 문맥 밖의 다른 영역 텍스트 변경 허용', match(localContext, capture(el)));
    el.nextElementSibling.textContent = '로그아웃';
    record('바로 옆 문맥 변경은 여전히 거부', !match(localContext, capture(el)));
    el = reset('<nav><a id="cart" href="/cart"></a></nav>');
    const link = capture(el);
    record('실제 목적지가 있는 링크 수집', link.eligible);
    el.href = '/delete';
    record('링크 목적지 변경 거부', !match(link, capture(el)));
    const topLink = '<footer><a id="cart" href="#top"></a></footer>';
    const top = capture(reset(topLink));
    record('페이지에서 유일한 #top 링크 수집', top.eligible);
    record('같은 #top 링크를 다시 수집하면 정확히 일치', match(top, capture(reset(topLink))));
    el = reset('<section id="details"></section><footer><a id="cart" href="#details"></a></footer>');
    const fragmentLink = capture(el);
    record('문서에 유일한 대상이 있는 앵커 링크 수집', fragmentLink.eligible);
    document.querySelector('#details').remove();
    record('앵커의 대상이 사라지면 수집하지 않음', capture(el).reason === 'insufficient-evidence');
    document.body.insertAdjacentHTML('afterbegin', '<section id="details"></section><section id="details"></section>');
    record('앵커 대상이 중복되면 수집하지 않음', capture(el).reason === 'ambiguous-reference');
    el = reset('<a name="상세"></a><footer><a id="cart" href="#%EC%83%81%EC%84%B8"></a></footer>');
    record('인코딩된 앵커 주소가 기존 name 대상과 일치하면 수집', capture(el).eligible);
    el = reset(`${topLink}<aside><a id="other-top" href="/shop#%54OP">맨 위</a></aside>`);
    record('다른 위치와 표기라도 같은 목적지의 링크가 있으면 수집하지 않음', capture(el).reason === 'ambiguous-element');
    el = reset(`${topLink}<div id="duplicate-host"></div>`);
    document.querySelector('#duplicate-host').attachShadow({ mode: 'open' }).innerHTML = '<a href="#top"></a>';
    record('열린 Shadow DOM에 같은 목적지의 링크가 있어도 수집하지 않음', capture(el).reason === 'ambiguous-element');
    el = reset('<nav><a id="cart" href="#"></a></nav>');
    record('빈 앵커 링크는 수집하지 않음', capture(el).reason === 'insufficient-evidence');
    el = reset(`<base href="/other">${topLink}`);
    record('base 때문에 다른 문서를 가리키는 앵커 링크는 새 규칙으로 수집하지 않음', capture(el).reason === 'insufficient-evidence');
    el = reset();
    const target = document.createElement('section'); target.id = 'panel'; target.textContent = '장바구니';
    document.body.append(target); el.setAttribute('aria-controls', 'panel');
    const reference = capture(el);
    record('참조 대상 수집', reference.eligible);
    target.textContent = '삭제';
    record('참조 대상 문맥 변경 거부', !match(reference, capture(el)));
    target.remove();
    record('사라진 참조 대상 거부', capture(el).reason === 'ambiguous-reference');
    el = reset();
    record('Fingerprint 버전 변경 거부', !match({ ...saved, version: 0 }, capture(el)));
    const frame = document.createElement('iframe'); document.body.append(frame);
    frame.contentDocument.body.innerHTML = fixture;
    record('iframe 요소 제외', capture(frame.contentDocument.getElementById('cart')).reason === 'iframe');
    reset('<div id="host"></div>');
    const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = fixture;
    const shadowButton = shadow.getElementById('cart');
    const shadowSaved = capture(shadowButton);
    record('열린 Shadow DOM의 경계 기록', shadowSaved.eligible && shadowSaved.canonical.includes('boundary'));
    document.getElementById('host').id = 'new-host';
    record('Shadow host 변경 거부', !match(shadowSaved, capture(shadowButton)));
    return output;
  });
  for (const [title, value] of results) check(title, value);
} finally { await browser.close(); }
console.log(`\n${passed}/${passed} passed`);
