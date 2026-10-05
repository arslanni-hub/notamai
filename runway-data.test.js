'use strict';
// Run:  node runway-data.test.js
const assert = require('assert');
const RD = require('./runway-data');
const R = require('./risk');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

const HEAD = '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';
const row = (id, ident, surf, closed, le, he) => `${id},1,"${ident}",9000,150,"${surf}",1,${closed},"${le}",,,,,,"${he}",,,,,`;
const CSV = [
  HEAD,
  row(1, 'LTFM', 'ASP, CON', 0, '16L', '34R'),
  row(2, 'LTFM', 'ASP', 0, '16R', '34L'),
  row(3, 'LTFM', 'ASP', 0, '17L', '35R'),
  row(4, 'LTFM', 'ASP', 0, '17R', '35L'),
  row(5, 'LTFM', 'ASP', 0, '18', '36'),
  row(6, 'LTFM', 'ASP', 1, '09', '27'),          // permanently closed -> not counted
  row(7, 'LTFJ', 'ASP', 0, '06L', '24R'),
  row(8, 'LTFJ', 'ASP', 0, '06R', '24L'),
  row(9, 'LTFJ', 'GRASS', 0, 'H1', ''),          // helipad -> ignored
  row(10, 'LTFJ', 'ASP', 0, '24R', '06L'),       // duplicate pair written the other way round -> not double counted
  row(11, 'XXXX', 'ASP', 0, '09', '27'),
  row(12, 'ZZZZ', 'ASP', 0, '16L', '34R'),
  row(13, 'ZZZZ', 'ASP', 0, '16R', '34L'),
  row(14, 'ZZZZ', 'ASP', 0, '17L', '35R'),
  row(15, 'ZZZZ', 'ASP', 0, '17R', '35L'),
  row(16, 'ZZZZ', 'ASP', 0, '18', '36'),
].join('\n') + '\n';

(async () => {
  console.log('\n── runway-data tests ──');
  await test('CSV parser handles quoted commas', () => {
    const rows = RD._parseCsv('"a","b,c","d""e"\n1,2,3\n');
    assert.deepStrictEqual(rows[0], ['a', 'b,c', 'd"e']);
    assert.deepStrictEqual(rows[1], ['1', '2', '3']);
  });
  await test('buildTable: counts open runway pairs per aerodrome', () => {
    const t = RD._buildTable(CSV);
    assert.strictEqual(t.get('LTFM').keys.size, 5);
    assert.strictEqual(t.get('LTFJ').keys.size, 2);   // helipad ignored, duplicate pair merged
    assert.strictEqual(t.get('XXXX').keys.size, 1);
  });
  await test('buildTable: rejects an unexpected header instead of returning wrong data', () => {
    assert.throws(() => RD._buildTable('"foo","bar"\n1,2\n'));
  });
  await test('AWC parsing: pair ids, separate ends, and missing data', () => {
    assert.strictEqual(RD._awcCountFromData([{ runways: [{ id: '16L/34R' }, { id: '16R/34L' }] }]), 2);
    assert.strictEqual(RD._awcCountFromData([{ runways: [{ id: '16L' }, { id: '34R' }, { id: '16R' }, { id: '34L' }] }]), 2);
    assert.strictEqual(RD._awcCountFromData([{ runways: [{ id: '18/36' }] }]), 1);
    assert.strictEqual(RD._awcCountFromData([{ name: 'X' }]), null);
    assert.strictEqual(RD._awcCountFromData([]), null);
    assert.strictEqual(RD._awcCountFromData(null), null);
  });
  await test('getRunwaySources: both sources answer', async () => {
    RD._setTable(RD._buildTable(CSV)); RD._clearAwcCache();
    const s = await RD.getRunwaySources('ltfm', { fetchJson: async () => [{ runways: ['16L/34R', '16R/34L', '17L/35R', '17R/35L', '18/36'].map(id => ({ id })) }] });
    assert.deepStrictEqual(s.map(x => [x.name, x.count]), [['ourairports', 5], ['awc', 5]]);
    assert.ok(Array.isArray(s[0].keys) && s[0].keys.includes('16L/34R'));
    const res = R.resolveRunwayCount(s, 3);
    assert.strictEqual(res.trusted, true); assert.strictEqual(res.count, 5);
  });
  await test('getRunwaySources: a failing live source is omitted, not fatal', async () => {
    RD._setTable(RD._buildTable(CSV)); RD._clearAwcCache();
    const s = await RD.getRunwaySources('LTFJ', { fetchJson: async () => { throw new Error('boom'); } });
    assert.deepStrictEqual(s.map(x => [x.name, x.count]), [['ourairports', 2]]);
  });
  await test('getRunwaySources: unknown aerodrome -> no sources (rubric then uses conservative rule)', async () => {
    RD._setTable(RD._buildTable(CSV)); RD._clearAwcCache();
    const s = await RD.getRunwaySources('QQQQ', { fetchJson: async () => [] });
    assert.deepStrictEqual(s, []);
  });
  await test('getRunwaySources: disagreeing sources are reported as-is and resolved safely', async () => {
    RD._setTable(RD._buildTable(CSV)); RD._clearAwcCache();
    const s = await RD.getRunwaySources('LTFM', { fetchJson: async () => [{ runways: [{ id: '16L/34R' }, { id: '18/36' }] }] });
    const res = R.resolveRunwayCount(s, 3);
    assert.strictEqual(res.disputed, true); assert.strictEqual(res.trusted, false); assert.strictEqual(res.count, 3);
  });
  await test('end to end: an aerodrome with 5 runways (live-style sources), 2 closed to landing -> Tier 2 (not Tier 1)', async () => {
    RD._setTable(RD._buildTable(CSV)); RD._clearAwcCache();
    const sources = await RD.getRunwaySources('ZZZZ', { fetchJson: async () => [{ runways: ['16L/34R', '16R/34L', '17L/35R', '17R/35L', '18/36'].map(id => ({ id })) }] });
    const cl = (id, k) => ({ notam_id: id + '/2026', location: 'ZZZZ', effective: '202607291506', expiration: '202610291400', raw: `${id}/26 NOTAMN\nA) ZZZZ B) 2607291506 C) 2610291400\nE) RWY ${k} CLSD TO LANDING TFC DUE TO CONST.` });
    const r = R.assessRisk({ now: new Date(Date.UTC(2026, 9, 4, 19, 30)), airports: [{ icao: 'ZZZZ', role: 'APT', notams: [cl('B2991', '16L/34R'), cl('B2990', '17R/35L')], runwaySources: sources }] });
    assert.strictEqual(r.counts.t1, 0); assert.strictEqual(r.counts.t2, 1);
  });
  await test('disputed sources: note names the runway that only one source lists', async () => {
    RD._setTable(RD._buildTable(CSV)); RD._clearAwcCache();
    const s = await RD.getRunwaySources('LTFM', { fetchJson: async () => [{ runways: ['16L/34R', '16R/34L', '17L/35R', '17R/35L'].map(id => ({ id })) }] });
    const res = R.resolveRunwayCount(s, 3);
    assert.strictEqual(res.disputed, true); assert.strictEqual(res.count, 4);
    assert.ok(/only in ourairports: 18\/36/.test(res.note), res.note);
  });
  await test('airport position: from runway-end coordinates, else from the AWC record, else null', async () => {
    const H = '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';
    const csv = [H, '1,1,"LTFM",1,1,"ASP",1,0,"18",41.0,28.0,,,,"36",41.2,28.2,,,'].join('\n') + '\n';
    RD._setTable(RD._buildTable(csv)); RD._clearAwcCache();
    const p1 = await RD.getAirportPosition('LTFM', {});
    assert.ok(Math.abs(p1.lat - 41.1) < 1e-9 && Math.abs(p1.lon - 28.1) < 1e-9);
    const p2 = await RD.getAirportPosition('EGLL', { fetchJson: async () => [{ lat: 51.47, lon: -0.46, runways: [] }] });
    assert.deepStrictEqual(p2, { lat: 51.47, lon: -0.46 });
    assert.strictEqual(await RD.getAirportPosition('QQQQ', { fetchJson: async () => [] }), null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
