// ③ 기능 사전 매칭 - 실제 사이트 수집 데이터 채점
// test/data/real/*-main.json(수집 결과)과 labels.json(정답)을 비교한다.
// 틀린 이름(확정 오답)이 하나라도 있으면 실패로 끝난다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchItem, pageCommon } from '../src/matcher.js';
import { withDataAttrs } from './lib/html-data-attrs.mjs';

// 채점할 폴더: 인자로 주면 그 폴더 (예: node test/match-eval.mjs test/data/final), 없으면 test/data/real
const dir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/real');
const labels = new Map(JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'))
  .map((o) => [`${o.site}#${o.no}`, o]));

const tally = { '확정 정답': 0, '확정 오답': 0, '콘텐츠 가려냄': 0, 'AI로 (정답)': 0, 'AI로 (놓침)': 0 };
const problems = [];
for (const fn of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'labels.json').sort()) {
  const site = fn.replace(/(-main)?\.json$/, '');
  const data = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8'));
  const items = withDataAttrs(data.items);   // 옛 데이터는 html에서 data- 속성 보충
  const common = pageCommon(items);          // 확장 프로그램(matchAll)과 똑같이 페이지마다 계산
  for (const it of items) {
    const r = matchItem(it, data.url, common);
    const exp = labels.get(`${site}#${it.no}`).expected;
    let verdict;
    if (r.decision === 'confirm') verdict = Array.isArray(exp) && exp.includes(r.label) ? '확정 정답' : '확정 오답';
    else if (r.decision === 'content') verdict = exp === 'content' ? '콘텐츠 가려냄' : 'AI로 (놓침)';
    else verdict = Array.isArray(exp) ? 'AI로 (놓침)' : 'AI로 (정답)';
    tally[verdict]++;
    if (verdict === '확정 오답' || verdict === 'AI로 (놓침)') problems.push(`${site}#${it.no} 결과=${r.label ?? r.decision} 기대=${exp}`);
  }
}
for (const [k, v] of Object.entries(tally)) console.log(k.padEnd(10), String(v).padStart(3));
problems.forEach((p) => console.log('  ', p));
const total = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`\n총 ${total}개 중 AI 없이 확정 ${tally['확정 정답'] + tally['확정 오답']}개, 틀린 이름 ${tally['확정 오답']}개`);
process.exit(tally['확정 오답'] ? 1 : 0);
