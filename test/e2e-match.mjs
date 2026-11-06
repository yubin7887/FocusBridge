// ③ 기능 사전 매칭 - 연동 테스트
// 빌드된 dist/content.js를 fixture.html에 넣고, report 항목마다 붙은 match 결과를 확인한다.
// (사전 JSON이 빌드에 제대로 들어갔는지, content.js에 제대로 연결됐는지 확인하는 용도)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// fixture.html의 이름 누락 요소 순서대로, 확정되어야 할 이름 (null = AI로 넘겨야 함)
const EXPECT = [
  '알림',   // 1 <a class="btn-notification" href="/notification">
  null,     // 2 class 없는 svg 버튼 (옆 형제 글자 "알림"뿐)
  '알림',   // 3 svg.bell-icon, 부모 header-notification
  '닫기',   // 4 div.close (앞 형제 글자 "알림")
  null,     // 5 logo.png 링크 (주소가 첫 화면이 아님)
  '검색',   // 6 i.fa-search
  null,     // 7 글자 "button"
  '더보기', // 8 href="/more"
  null,     // 9 aria-label="아이콘"
  '검색',   // 10 alt="ic_search.png"
  null,     // 11 화면 밖 빈 버튼
  null,     // 12 Shadow DOM 빈 버튼
];

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e));
await page.goto('file://' + path.join(dir, 'fixture.html'));
await page.addScriptTag({ path: path.join(dir, '../dist/content.js') });
const got = await page.evaluate(() => window.__focusBridge.report.map((r) => ({
  decision: r.match.decision, label: r.match.label,
})));
await browser.close();

let fail = got.length === EXPECT.length ? 0 : 1;
if (fail) console.log(`FAIL  항목 수가 다름: 기대 ${EXPECT.length}, 실제 ${got.length}`);
EXPECT.forEach((exp, i) => {
  const r = got[i] || {};
  const ok = exp === null ? r.decision === 'ai' : (r.decision === 'confirm' && r.label === exp);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${String(i + 1).padEnd(2)} 기대=${exp ?? 'AI'}  실제=${r.label ?? r.decision}`);
});
console.log(`\n${EXPECT.length - fail}/${EXPECT.length} passed`);
process.exit(fail ? 1 : 0);
