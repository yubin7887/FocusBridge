import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportLogger } from '../src/report-log.js';

function fixture() {
  const tables = [];
  const log = createReportLogger({ groupCollapsed() {}, groupEnd() {}, log() {}, table: (rows) => tables.push(rows) });
  const result = { targets: [{}], missing: [{ status: 'empty', element: {} }], pageUrl: 'https://example.com/page',
    previousStatus: 'ok', report: [{ status: 'empty', role: 'button', currentName: '', selector: '#control',
      labelApplied: true, match: { decision: 'confirm', source: 'ai', label: '좋아요 수' } }] };
  const fingerprints = [{ eligible: false, reason: 'insufficient-evidence' }];
  return { tables, log, result, fingerprints };
}

test('the summary shows the final AI label even when previous matching is ineligible', () => {
  const { tables, log, result, fingerprints } = fixture();
  assert.equal(log(result, fingerprints, 10, 'TOP'), true);
  assert.equal(tables[0][0].previousMatch, 'ineligible');
  assert.equal(tables[0][0].label, '좋아요 수');
  assert.equal(tables[0][0].match, 'ai');
  assert.equal(result.report[0].match.decision, 'confirm');
});

test('dictionary confirmations display rule, while previous matches display previous', () => {
  const { tables, log, result, fingerprints } = fixture();
  delete result.report[0].match.source;
  log(result, fingerprints, 10, 'TOP');
  assert.equal(tables[0][0].match, 'rule');
  result.report[0].match.source = 'previous';
  fingerprints[0] = { eligible: true };
  log(result, fingerprints, 20, 'TOP');
  assert.equal(tables[1][0].match, 'previous');
  assert.equal(tables[1][0].previousMatch, 'hit');
  assert.equal(result.report[0].match.decision, 'confirm');
});

test('identical results are suppressed despite new DOM objects, timing, geometry, and cache metadata', () => {
  const { tables, log, result, fingerprints } = fixture();
  log(result, fingerprints, 10, 'TOP');
  const repeated = structuredClone(result);
  Object.assign(repeated, { scanId: 25, aiStatus: 'ok' });
  Object.assign(repeated.report[0], { aiReused: true, aiRequestCount: 20, aiStorage: 'already-saved',
    context: { rect: { x: 300, y: 400 } } });
  assert.equal(log(repeated, fingerprints, 200, 'TOP'), false);
  assert.equal(tables.length, 1);
});

for (const [name, change] of [
  ['label', (result) => { result.report[0].match.label = '댓글 수'; }],
  ['detected name', (result) => { result.report[0].currentName = '12'; }],
  ['status', (result) => { result.report[0].status = 'meaningless'; }],
  ['role', (result) => { result.report[0].role = 'link'; }],
  ['decision', (result) => { result.report[0].match = { decision: 'content', label: null }; }],
  ['match source', (result) => { delete result.report[0].match.source; }],
  ['selector', (result) => { result.report[0].selector = '#other'; }],
  ['target count', (result) => { result.targets.push({}); }],
  ['missing element removed', (result) => { result.missing = []; result.report = []; }],
  ['page URL', (result) => { result.pageUrl += '#next'; }],
  ['previous state', (result, fingerprints) => { fingerprints[0] = { eligible: true }; }],
  ['previous reason', (_result, fingerprints) => { fingerprints[0].reason = 'ambiguous-element'; }],
]) {
  test(`a changed ${name} prints once and subsequent identical scans are suppressed`, () => {
    const { tables, log, result, fingerprints } = fixture();
    log(result, fingerprints, 10, 'TOP');
    change(result, fingerprints);
    assert.equal(log(result, fingerprints, 20, 'TOP'), true);
    assert.equal(log(result, fingerprints, 30, 'TOP'), false);
    assert.equal(tables.length, 2);
  });
}
