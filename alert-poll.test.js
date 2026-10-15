'use strict';
const assert = require('assert');
const A = require('./alert-poll');
let pass = 0, fail = 0;
function test(n, f) { try { f(); pass++; console.log('  PASS ', n); } catch (e) { fail++; console.log('  FAIL ', n, '\n       ', e.message); } }
const MIN = 60 * 1000;

test('interval follows the highest plan among subscribers (max 30 min, pro-only 60 min)', () => {
  assert.strictEqual(A.intervalMsFor(['pro', 'pro']), 60 * MIN);
  assert.strictEqual(A.intervalMsFor(['pro', 'max']), 30 * MIN);
  assert.strictEqual(A.intervalMsFor(['admin']), 30 * MIN);
  assert.strictEqual(A.intervalMsFor(['weird']), 60 * MIN);
  assert.strictEqual(A.intervalMsFor([]), 60 * MIN);
});
test('planAction: not due -> skip; due -> fetch; fresh stored response from another source -> diff-stored (no provider call)', () => {
  const now = 1_000_000_000;
  const iv = 60 * MIN;
  assert.strictEqual(A.planAction({ now, intervalMs: iv, state: { lastCheckedAt: now - 20 * MIN }, stored: null }), 'skip');
  assert.strictEqual(A.planAction({ now, intervalMs: iv, state: { lastCheckedAt: now - 61 * MIN }, stored: null }), 'fetch');
  assert.strictEqual(A.planAction({ now, intervalMs: iv, state: { lastCheckedAt: now - 61 * MIN }, stored: { t: now - 5 * MIN } }), 'diff-stored');
  assert.strictEqual(A.planAction({ now, intervalMs: iv, state: { lastCheckedAt: now - 20 * MIN }, stored: { t: now - 5 * MIN } }), 'diff-stored');
  assert.strictEqual(A.planAction({ now, intervalMs: iv, state: { lastCheckedAt: now - 3 * MIN }, stored: { t: now - 10 * MIN } }), 'skip', 'stored response older than the last diff is not re-diffed');
  assert.strictEqual(A.planAction({ now, intervalMs: iv, state: null, stored: null }), 'fetch', 'never checked -> fetch');
});
test('diff: first sight is a silent baseline; every new id is reported (not just the latest)', () => {
  assert.deepStrictEqual(A.diffIds(null, ['A1/26', 'A2/26']), { baseline: true, fresh: [] });
  const d = A.diffIds(['A1/26'], ['A1/26', 'A2/26', 'A3/26']);
  assert.deepStrictEqual(d.fresh, ['A2/26', 'A3/26']); assert.strictEqual(d.baseline, false);
  assert.deepStrictEqual(A.diffIds(['A1/26'], ['A1/26']).fresh, []);
});
test('extractIds: notam_id, id, or the id inside raw text; duplicates removed', () => {
  const ids = A.extractIds([{ notam_id: 'A0001/26' }, { id: 'B0002/26' }, { raw: 'A0003/26 NOTAMN\nQ) ...' }, { notam_id: 'A0001/26' }, {}]);
  assert.deepStrictEqual(ids, ['A0001/26', 'B0002/26', 'A0003/26']);
});
test('mergeKnown keeps the union and caps its size (oldest dropped)', () => {
  assert.deepStrictEqual(A.mergeKnown(['A'], ['B']), ['A', 'B']);
  const big = Array.from({ length: 700 }, (_, i) => 'X' + i);
  const m = A.mergeKnown(big, ['NEW']);
  assert.strictEqual(m.length, 600); assert.strictEqual(m[m.length - 1], 'NEW');
});
test('digestText lists up to 5 new NOTAMs and counts the rest', () => {
  const n = Array.from({ length: 7 }, (_, i) => ({ notam_id: 'A' + i + '/26', raw: 'RAW' + i }));
  const t = A.digestText(n);
  assert.ok(t.includes('RAW0') && t.includes('RAW4') && !t.includes('RAW5'));
  assert.ok(/\+2 more/.test(t));
  assert.strictEqual(A.digestText([n[0]]), 'RAW0');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
