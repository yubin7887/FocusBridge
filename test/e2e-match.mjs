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
  '넥슨현대카드', // 7 보이는 배지 "N" + 숨겨진 진짜 이름 → 숨겨진 이름을 그대로 씀 (0.8.0)
  null,     // 8 화면 밖 빈 버튼
  null,     // 9 Shadow DOM 빈 버튼
];

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e));
await page.goto('file://' + path.join(dir, 'fixture.html'));
await page.addScriptTag({ path: path.join(dir, '../dist/content.js') });
await page.waitForFunction(() => window.__focusBridge?.report);
const got = await page.evaluate(() => window.__focusBridge.report.map((r) => ({
  decision: r.match.decision, label: r.match.label,
})));
await browser.close();

const countMatches = got.length === EXPECT.length;
if (!countMatches) console.log(`FAIL  항목 수가 다름: 기대 ${EXPECT.length}, 실제 ${got.length}`);
let passed = 0;
EXPECT.forEach((exp, i) => {
  const r = got[i] || {};
  const ok = exp === null ? r.decision === 'ai' : (r.decision === 'confirm' && r.label === exp);
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  #${String(i + 1).padEnd(2)} 기대=${exp ?? 'AI'}  실제=${r.label ?? r.decision}`);
});
console.log(`\n${passed}/${EXPECT.length} passed`);
process.exit(countMatches && passed === EXPECT.length ? 0 : 1);
