'use strict';
// Run:  node risk.test.js
// Fixtures are reconstructed from the NOTAM texts that appeared in the 04 OCT 2026 test briefings
// (E-lines approximated where the PDF showed only a summary). They exercise the rubric logic.
const assert = require('assert');
const R = require('./risk');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const N = (id, loc, b, c, e, extra) => ({
  notam_id: id + '/2026', location: loc, effective: '20' + b + '00'.slice(0, 0), expiration: c ? '20' + c : 'PERM',
  raw: `${id}/26 NOTAMN\n${extra && extra.q ? 'Q) ' + extra.q + '\n' : ''}A) ${loc} B) ${b} C) ${c || 'PERM'}\n${extra && extra.d ? 'D) ' + extra.d + '\n' : ''}E) ${e}`,
});
const NOW = new Date(Date.UTC(2026, 9, 4, 19, 30));       // 04 OCT 2026 19:30Z (time of the real tests)
const NOW_AM = new Date(Date.UTC(2026, 9, 4, 9, 0));      // 04 OCT 2026 09:00Z (before the OMDB closure window)

console.log('\n── unit tests ──');
test('rwyKey pairs reciprocals and sides', () => {
  assert.strictEqual(R.rwyKey('16L'), '16L/34R');
  assert.strictEqual(R.rwyKey('34R'), '16L/34R');
  assert.strictEqual(R.rwyKey('17R'), '17R/35L');
  assert.strictEqual(R.rwyKey('36'), '18/36');
  assert.strictEqual(R.rwyKey('18C'), '18C/36C');
});
test('runway closure parsing: modes and multiple runways', () => {
  const a = R.parseRunwayClosures('RWY 16L/34R CLSD TO LANDING TFC DUE TO CONST.');
  assert.deepStrictEqual(a, [{ key: '16L/34R', mode: 'landing' }]);
  const b = R.parseRunwayClosures('RWY 12R/30L CLSD.');
  assert.deepStrictEqual(b, [{ key: '12R/30L', mode: 'full' }]);
  const c = R.parseRunwayClosures('RWY 09L AND RWY 09R CLSD');
  assert.strictEqual(c.length, 2);
});
test('runway-related text that is NOT a closure is ignored', () => {
  assert.deepStrictEqual(R.parseRunwayClosures('RWY 18/36 MID RVR U/S.'), []);
  assert.deepStrictEqual(R.parseRunwayClosures('SEQUENCED FLASHING LIGHTS RWY 24L U/S BTN 690M AND 900M FM THR'), []);
  assert.deepStrictEqual(R.parseRunwayClosures('RWY 36R GP U/S'), []);
  assert.deepStrictEqual(R.parseRunwayClosures('RWY 18/36 ILS CAT II AND CAT III NOT AVBL.'), []);
});
test('fact classification: taxiway edge lights are minor, not critical', () => {
  const f = R.extractFact({ raw: 'J4178/26 NOTAMN\nQ) LTAA/QMXLT/IV/M/A/000/999/3654N03048E005\nA) LTAI B) 2610040000 C) 2610301400\nE) TWY M1 EDGE LGT U/S.' }, 'AD');
  assert.strictEqual(f.type, 'GROUND');
});
test('fact classification: assorted aerodrome items', () => {
  const t = s => (R.extractFact({ raw: `X/26 NOTAMN\nA) LTXX B) 2610040000 C) 2610301400\nE) ${s}` }, 'AD') || {}).type;
  assert.strictEqual(t('RWY 18/36 MID RVR U/S.'), 'RVR');
  assert.strictEqual(t('RWY 18/36 ILS CAT II AND CAT III NOT AVBL.'), 'CAT23');
  assert.strictEqual(t('ILS GP RWY 36R U/S'), 'ILS');
  assert.strictEqual(t('SEQUENCED FLASHING LIGHTS RWY 36L U/S'), 'LIGHTING');
  assert.strictEqual(t('OCA(H) FOR NDB Z RWY 36C RAISED TO 750 FT'), 'MINIMA');
  assert.strictEqual(t('CRANE OPR AT PSN 512911N 0002915W. MAX HGT 295FT AGL'), 'OBSTACLE');
  assert.strictEqual(t('TWY A1 CLSD TO TFC'), 'GROUND');
  assert.strictEqual(t('LLWAS U/S'), 'LLWAS');
  assert.strictEqual(t('AD CLSD DUE TO SNOW'), 'AD_CLOSED');
  assert.strictEqual(t('TOWER CRANES CAUSE RAISED LNAV/VNAV MINIMA RWY 12L'), 'MINIMA');
  assert.strictEqual(t('NET BARRIER REMOTE CONTROL U/S'), 'EQUIP_MINOR');
});
test('GNSS jamming vs routine GNSS wording', () => {
  assert.strictEqual(R.extractFact({ raw: 'A0403/26 NOTAMN\nA) ORBB B) 2610040000 C) 2610301400\nE) GPS JAMMING AND INTERFERENCE REPORTED IN ORBB FIR' }, 'FIR').type, 'GNSS_INTERFERENCE');
  assert.strictEqual(R.extractFact({ raw: 'A1/26 NOTAMN\nA) ORBB B) 2610040000 C) 2610301400\nE) GNSS RAIM OUTAGE PREDICTED' }, 'FIR').type, 'GNSS_OUTAGE');
});
test('window: continuous, scheduled-in-window, scheduled-out-of-window, expired, later', () => {
  const cfg = R.CONFIG;
  const sched = N('A3039', 'OMDB', '2610041130', '2610251300', 'RWY 12R/30L CLSD.', { d: '04 11 18 25 1130-1300' });
  assert.strictEqual(R.windowStatus(sched, NOW_AM, cfg).inWindow, true);
  assert.strictEqual(R.windowStatus(sched, NOW_AM, cfg).kind, 'scheduled');
  assert.strictEqual(R.windowStatus(sched, NOW, cfg).inWindow, false);              // window already passed, next date is 11 OCT
  const other = N('A3038', 'OMDB', '2610021100', '2610301400', 'RWY 12L/30R CLSD.', { d: '02 08 09 13 16 22 23 29 30 1100-1400' });
  assert.strictEqual(R.windowStatus(other, NOW_AM, cfg).inWindow, false);           // 04 OCT is not on its list
  const cont = N('D1950', 'LTAI', '2609010000', '2610241700', 'RWY 18R/36L CLSD.');
  assert.strictEqual(R.windowStatus(cont, NOW, cfg).kind, 'continuous');
  const expired = N('X1', 'LTAI', '2609010000', '2610031700', 'RWY 18R/36L CLSD.');
  assert.strictEqual(R.windowStatus(expired, NOW, cfg).inWindow, false);
  const later = N('X2', 'LTAI', '2610101000', '2610201700', 'RWY 18R/36L CLSD.');
  assert.strictEqual(R.windowStatus(later, NOW, cfg).inWindow, false);
});
test('weather: LIFR and TS are tier 2, mild IFR tier 3, good weather none', () => {
  assert.strictEqual(R.assessWeather('EGLL 041650Z 24008KT 0300 FG VV001 05/05 Q1020', R.CONFIG.weather).tier, 2);
  assert.strictEqual(R.assessWeather('LTAI 041650Z 18010KT 9999 TSRA BKN030CB 22/18 Q1012', R.CONFIG.weather).tier, 2);
  assert.strictEqual(R.assessWeather('LTAI 041650Z 18010KT 4000 BR OVC009 15/13 Q1012', R.CONFIG.weather).tier, 3);
  assert.strictEqual(R.assessWeather('LTFM 041650Z 36008KT 9999 FEW040 18/10 Q1020 NOSIG', R.CONFIG.weather), null);
});
test('level/score table', () => {
  const L = R.levelFromCounts;
  assert.deepStrictEqual(L(0, 0, 0, {}), { level: 'LOW', score: 0 });
  assert.deepStrictEqual(L(0, 0, 3, {}), { level: 'MEDIUM', score: 3 });
  assert.deepStrictEqual(L(0, 1, 0, {}), { level: 'MEDIUM', score: 4 });
  assert.deepStrictEqual(L(0, 3, 0, {}), { level: 'HIGH', score: 6 });
  assert.deepStrictEqual(L(0, 5, 0, {}), { level: 'HIGH', score: 8 });
  assert.deepStrictEqual(L(1, 0, 0, {}), { level: 'HIGH', score: 6 });
  assert.deepStrictEqual(L(1, 2, 0, {}), { level: 'HIGH', score: 7 });
  assert.deepStrictEqual(L(1, 3, 0, {}), { level: 'HIGH', score: 8 });
  assert.deepStrictEqual(L(2, 0, 0, {}), { level: 'CRITICAL', score: 9 });
  assert.deepStrictEqual(L(3, 0, 0, {}), { level: 'CRITICAL', score: 10 });
  assert.deepStrictEqual(L(0, 0, 0, { override: true }), { level: 'CRITICAL', score: 10 });
});


test('regression: "ADVISE ATC INSTRUCTION" in a taxiway NOTAM is not an ATC outage', () => {
  const f = R.extractFact({ raw: 'B3200/26 NOTAMR B2084/26\nA) LTFJ B) 2608121508 C) 2610281600\nE) TWY -A1- CLSD TO TFC.\nADVISE ATC INSTRUCTION.' }, 'AD');
  assert.strictEqual(f.type, 'GROUND');
});
test('regression: real ATC outage wording is detected', () => {
  const t = s => (R.extractFact({ raw: `X/26 NOTAMN\nA) LTXX B) 2610040000 C) 2610301400\nE) ${s}` }, 'AD') || {}).type;
  assert.strictEqual(t('TWR U/S. ATC SERVICES PROVIDED BY APP'), 'ATC_OUT');
  assert.strictEqual(t('AERODROME CONTROL CLSD'), 'ATC_OUT');
});
test('regression: equipment on a runway is not a runway closure (SFL, GP)', () => {
  assert.deepStrictEqual(R.parseRunwayClosures('SEQUENCED FLASHING LIGHTS RWY 24L U/S'), []);
  assert.deepStrictEqual(R.parseRunwayClosures('ILS GP RWY 36R U/S'), []);
});

console.log('\n── dynamic runway rule ──');
const closure = (id, rwy, loc) => N(id, loc, '2609010000', '2611010000', `RWY ${rwy} CLSD.`);
test('single-runway aerodrome, its runway closed -> aerodrome closed (override, NO-GO)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'DEP', notams: [closure('A1', '09/27', 'XXXX')], runwayInfo: { count: 1, trusted: true } }, { icao: 'YYYY', role: 'ARR', notams: [] }] });
  assert.strictEqual(r.override, true); assert.strictEqual(r.verdict, 'NO-GO'); assert.strictEqual(r.score, 10);
});
test('two runways, one closed -> only one remains -> Tier 1', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'DEP', notams: [closure('A1', '09L/27R', 'XXXX')], runwayInfo: { count: 2, trusted: true } }, { icao: 'YYYY', role: 'ARR', notams: [] }] });
  assert.strictEqual(r.counts.t1, 1); assert.strictEqual(r.level, 'HIGH'); assert.strictEqual(r.verdict, 'GO WITH CONDITIONS');
});
test('three runways, one closed -> capacity reduced -> Tier 2', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'DEP', notams: [closure('A1', '18R/36L', 'XXXX')], runwayInfo: { count: 3, trusted: true } }, { icao: 'YYYY', role: 'ARR', notams: [] }] });
  assert.strictEqual(r.counts.t1, 0); assert.strictEqual(r.counts.t2, 1);
});
test('unverified runway count falls back to conservative rule (>=2 closures = Tier 1)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'DEP', notams: [closure('A1', '09L/27R', 'XXXX'), closure('A2', '09R/27L', 'XXXX')], runwayInfo: null }, { icao: 'YYYY', role: 'ARR', notams: [] }] });
  assert.ok(r.counts.t1 >= 1 || r.override);
  assert.ok(r.unverifiedRunwayCount.includes('XXXX') || r.override);
});
test('landing-only closures of 2 of 2 runways still leave departures -> uses worst of landing/takeoff', () => {
  const l = (id, k) => N(id, 'XXXX', '2609010000', '2611010000', `RWY ${k} CLSD TO LANDING TFC.`);
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'ARR', notams: [l('A1', '09L/27R'), l('A2', '09R/27L')], runwayInfo: { count: 2, trusted: true } }] });
  assert.strictEqual(r.override, true);
});


console.log('\n── runway data sources ──');
test('resolver: no source -> unknown, untrusted', () => {
  const r = R.resolveRunwayCount([], 0);
  assert.strictEqual(r.trusted, false); assert.strictEqual(r.count, null);
});
test('resolver: one source -> trusted', () => {
  const r = R.resolveRunwayCount([{ name: 'ourairports', count: 5 }], 3);
  assert.strictEqual(r.trusted, true); assert.strictEqual(r.count, 5);
});
test('resolver: two agreeing sources -> trusted', () => {
  const r = R.resolveRunwayCount([{ name: 'ourairports', count: 3 }, { name: 'awc', count: 3 }], 2);
  assert.strictEqual(r.trusted, true); assert.strictEqual(r.source, 'ourairports+awc');
});
test('resolver: disagreeing sources -> smaller number, untrusted, disputed', () => {
  const r = R.resolveRunwayCount([{ name: 'ourairports', count: 5 }, { name: 'awc', count: 3 }], 2);
  assert.strictEqual(r.trusted, false); assert.strictEqual(r.disputed, true); assert.strictEqual(r.count, 3);
});
test('resolver: source below what NOTAMs reference -> use NOTAM floor, untrusted', () => {
  const r = R.resolveRunwayCount([{ name: 'awc', count: 1 }], 3);
  assert.strictEqual(r.trusted, false); assert.strictEqual(r.count, 3);
});
test('assessRisk uses runwaySources: 2 of 5 closed -> Tier 2; same closures with disputed 5-vs-3 -> conservative', () => {
  const cl = [closure('A1', '16L/34R', 'XXXX'), closure('A2', '17R/35L', 'XXXX')];
  const ok = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: cl, runwaySources: [{ name: 'ourairports', count: 5 }, { name: 'awc', count: 5 }] }] });
  assert.strictEqual(ok.counts.t1, 0); assert.strictEqual(ok.counts.t2, 1);
  const disputed = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: cl, runwaySources: [{ name: 'ourairports', count: 5 }, { name: 'awc', count: 3 }] }] });
  assert.strictEqual(disputed.counts.t1, 1);   // disputed count -> untrusted -> 2 closures = Tier 1 (conservative)
  assert.ok(disputed.unverifiedRunwayCount.includes('XXXX'));
});


console.log('\n── v0.3: simultaneity, disputed data, closed fraction, route relevance ──');
const dClosure = (id, rwy, d) => N(id, 'XXXX', '2609010000', '2611010000', `RWY ${rwy} CLSD.`, { d });
const sweepRisk = (list, count) => R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: list, runwayInfo: { count, trusted: true } }] });
test('sweep: two runways closed at DIFFERENT hours are never closed together -> only one remains, one tier lighter', () => {
  const r = sweepRisk([dClosure('A1', '09L/27R', 'DAILY 2200-0500'), dClosure('A2', '09R/27L', 'DAILY 0600-1000')], 2);
  const f = r.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(r.override, false);
  assert.strictEqual(f.tier, 2, f.label);
  assert.ok(/during scheduled windows/.test(f.label));
});
test('sweep: two runways closed at OVERLAPPING hours -> both closed together (scheduled: Tier 1, no NO-GO override)', () => {
  const r = sweepRisk([dClosure('A1', '09L/27R', 'DAILY 2200-0500'), dClosure('A2', '09R/27L', 'DAILY 2300-0300')], 2);
  const f = r.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(f.tier, 1, f.label); assert.strictEqual(r.override, false);
});
test('sweep: continuous closure + scheduled second closure -> baseline stays, extra severity only in windows', () => {
  const cont = N('A1', 'XXXX', '2609010000', '2611010000', 'RWY 09L/27R CLSD.');
  const r = sweepRisk([cont, dClosure('A2', '09R/27L', 'DAILY 2300-0300')], 3);
  const f = r.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(f.tier, 2, f.label);   // 1 of 3 closed continuously (T2); 2 of 3 in a window (T1 -> lighter = T2)
});
test('closed fraction: 3 of 5 closed is Tier 1 (2 remain); 2 of 5 stays Tier 2', () => {
  const c = (i, k) => N('A' + i, 'XXXX', '2609010000', '2611010000', `RWY ${k} CLSD.`);
  const t3 = sweepRisk([c(1, '16L/34R'), c(2, '16R/34L'), c(3, '17L/35R')], 5);
  assert.strictEqual(t3.factors.find(x => x.key === 'XXXX:RWY').tier, 1);
  const t2 = sweepRisk([c(1, '16L/34R'), c(2, '16R/34L')], 5);
  assert.strictEqual(t2.factors.find(x => x.key === 'XXXX:RWY').tier, 2);
});
test('disputed runway count never produces a NO-GO override (stale source cannot close an aerodrome)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: [closure('A1', '06R/24L', 'XXXX')], runwaySources: [{ name: 'ourairports', count: 2 }, { name: 'awc', count: 1 }] }] });
  assert.strictEqual(r.override, false); assert.notStrictEqual(r.verdict, 'NO-GO');
  const f = r.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(f.tier, 1); assert.ok(/possibly no usable runway/.test(f.label), f.label);
});
test('LTFM live case: 3 of 5 closed with disputed count (6 vs 5) -> Tier 1, no override', () => {
  const c = (id, k) => N(id, 'LTFM', '2607291506', '2611291400', `RWY ${k} CLSD TO LANDING TFC DUE TO CONST.`);
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: [c('B2991', '16L/34R'), c('B2990', '17R/35L'), c('B3742', '16R/34L')], runwaySources: [{ name: 'ourairports', count: 6 }, { name: 'awc', count: 5 }] }] });
  const f = r.factors.find(x => x.key === 'LTFM:RWY');
  assert.strictEqual(f.tier, 1); assert.strictEqual(r.override, false);
  assert.ok(/3 of 5 runways closed, 2 remain/.test(f.label), f.label);
});
test('resolver note names the runway only one source lists', () => {
  const r = R.resolveRunwayCount([{ name: 'ourairports', count: 3, keys: ['16L/34R', '16R/34L', '18/36'] }, { name: 'awc', count: 2, keys: ['16L/34R', '16R/34L'] }], 0);
  assert.ok(/only in ourairports: 18\/36/.test(r.note), r.note);
});

const IST = { lat: 41.275, lon: 28.754 }, LHR = { lat: 51.4706, lon: -0.4619 };
const mid = (() => { // spherical midpoint of the great circle
  const r = d => d * Math.PI / 180, dg = x => x * 180 / Math.PI;
  const p1 = r(IST.lat), l1 = r(IST.lon), p2 = r(LHR.lat), dl = r(LHR.lon - IST.lon);
  const bx = Math.cos(p2) * Math.cos(dl), by = Math.cos(p2) * Math.sin(dl);
  const p3 = Math.atan2(Math.sin(p1) + Math.sin(p2), Math.sqrt((Math.cos(p1) + bx) ** 2 + by ** 2));
  return { lat: dg(p3), lon: dg(l1 + Math.atan2(by, Math.cos(p1) + bx)) };
})();
const geoStr = (pt, rad) => {
  const la = Math.abs(pt.lat), lo = Math.abs(pt.lon);
  return String(Math.floor(la)).padStart(2, '0') + String(Math.round((la % 1) * 60)).padStart(2, '0') + (pt.lat >= 0 ? 'N' : 'S') +
         String(Math.floor(lo)).padStart(3, '0') + String(Math.round((lo % 1) * 60)).padStart(2, '0') + (pt.lon >= 0 ? 'E' : 'W') + String(rad).padStart(3, '0');
};
const areaAt = (pt, rad, lower, upper, id) => N(id || 'A9', 'LTBB', '2610010000', '2611010000', 'DANGER AREA ACTIVATED', { q: `LTBB/QRDCA/IV/BO/W/${lower}/${upper}/${geoStr(pt, rad)}` });
const route = { dep: IST, arr: LHR };
test('great-circle distance IST-LHR is about 1,300 NM and the midpoint is on the route', () => {
  const L = R.gcDist(IST, LHR);
  assert.ok(L > 1250 && L < 1450, String(L));
  assert.ok(R.trackDistances(mid, IST, LHR).cross < 2);
});
test('route relevance: on-route area is relevant; far-away area is not; FIR-wide and no-route are', () => {
  assert.strictEqual(R.routeRelevant(areaAt(mid, 10, '000', '600'), route, R.CONFIG), true);
  assert.strictEqual(R.routeRelevant(areaAt({ lat: 25, lon: 55 }, 10, '000', '600'), route, R.CONFIG), false);
  assert.strictEqual(R.routeRelevant(N('A9', 'LTBB', '2610010000', '2611010000', 'DANGER AREA', { q: 'LTBB/QRDCA/IV/BO/W/000/600/4057N02857E999' }), route, R.CONFIG), true);
  assert.strictEqual(R.routeRelevant(areaAt({ lat: 25, lon: 55 }, 10, '000', '600'), null, R.CONFIG), true);
});
test('route relevance: low-level area is relevant only near an aerodrome', () => {
  assert.strictEqual(R.routeRelevant(areaAt(mid, 5, '000', '050'), route, R.CONFIG), false);                    // mid-route, below FL150
  assert.strictEqual(R.routeRelevant(areaAt({ lat: 41.0, lon: 28.9 }, 9, '000', '100'), route, R.CONFIG), true); // 20 NM from LTFM
});
test('assessRisk: en-route restriction far from the route is not scored; one on the route is', () => {
  const base = { now: NOW, airports: [{ icao: 'LTFM', role: 'DEP', notams: [] }, { icao: 'EGLL', role: 'ARR', notams: [] }], route };
  const far = R.assessRisk(Object.assign({}, base, { enroute: [{ fir: 'OOMM', notams: [areaAt({ lat: 25, lon: 55 }, 10, '000', '600')] }] }));
  assert.ok(!far.factors.some(f => f.key === 'ROUTE:AIRSPACE'));
  const near = R.assessRisk(Object.assign({}, base, { enroute: [{ fir: 'LKAA', notams: [areaAt(mid, 10, '000', '600')] }] }));
  assert.ok(near.factors.some(f => f.key === 'ROUTE:AIRSPACE'));
});

console.log('\n── golden cases ──');
// Golden cases use expert-verified runway counts through the override table (production leaves it empty
// and resolves counts live per aerodrome).
Object.assign(R.CONFIG.runwayCountOverrides, { LTFM: 5, LTFJ: 2, LTAI: 3, OMDB: 2, EGLL: 2 });
const mk = (id, loc, b, c, e, extra) => N(id, loc, b, c, e, extra);

const LTFM = [
  mk('B3951', 'LTFM', '2610041656', '2610051400', 'RWY 18/36 MID RVR U/S.', { q: 'LTBB/QFTAS/I/BO/A/000/999/4117N02845E005' }),
  mk('B3952', 'LTFM', '2610041656', '2610051400', 'RWY 18/36 ILS CAT II AND CAT III NOT AVBL.', { q: 'LTBB/QIUAS/I/BO/A/000/999/4117N02845E005' }),
  mk('B2991', 'LTFM', '2607291506', '2610291400', 'RWY 16L/34R CLSD TO LANDING TFC DUE TO CONST.', { q: 'LTBB/QMRLT/IV/NBO/A/000/999/4117N02845E005' }),
  mk('B2990', 'LTFM', '2607291506', '2610291400', 'RWY 17R/35L CLSD TO LANDING TFC DUE TO CONST.', { q: 'LTBB/QMRLT/IV/NBO/A/000/999/4117N02845E005' }),
  mk('B3740', 'LTFM', '2609010000', '2611010000', 'TWY T1 AND TWY T12 CLSD.'),
  mk('B3746', 'LTFM', '2609010000', '2611010000', 'TWY N3 CLSD.'),
  mk('B3739', 'LTFM', '2609010000', '2611010000', 'TWY G SECTION CLSD.'),
  mk('B3510', 'LTFM', '2609010000', '2611020000', 'TOWER CRANES IN THE APPROACH SURFACE OF RWY 35L. OBST.', { q: 'LTBB/QOBCE/IV/M/AE/000/006/4117N02845E005' }),
];
const LTAI = [
  mk('D1950', 'LTAI', '2609151200', '2610241700', 'RWY 18R/36L CLSD.'),
  mk('J3165', 'LTAI', '2610010000', '2611010000', 'THE RADAR COMPONENT OF THE LLWAS IS U/S.'),
  mk('J3886', 'LTAI', '2610010000', '2611010000', 'THE LIDAR COMPONENT OF THE LLWAS IS U/S.'),
  mk('J4118', 'LTAI', '2610031200', '2610151430', 'ILS GP RWY 36R U/S.'),
  mk('D2013', 'LTAI', '2609151200', '2612311400', 'SEQUENCED FLASHING LIGHTS RWY 36L U/S.'),
  mk('J4178', 'LTAI', '2610040000', '2610301400', 'TWY M1 EDGE LGT U/S.'),
  mk('D2014', 'LTAI', '2609151200', '2612311400', 'RWY 36L NORTH NET BARRIER REMOTE CONTROL U/S.'),
  mk('J3226', 'LTAI', '2610011200', '2610231400', 'OCA(H) FOR NDB Z AND VOR Z RWY 36C/36L RAISED TO 750/760 FT.'),
];
const OMDB = [
  mk('A3039', 'OMDB', '2610041130', '2610251300', 'RWY 12R/30L CLSD.', { d: '04 11 18 25 1130-1300' }),
  mk('A3038', 'OMDB', '2610021100', '2610301400', 'RWY 12L/30R CLSD.', { d: '02 08 09 13 16 22 23 29 30 1100-1400' }),
  mk('A3037', 'OMDB', '2610011100', '2610281400', 'RWY 12L/30R CLSD.', { d: '01 06 07 14 15 20 21 27 28 1100-1400' }),
  mk('A3145', 'OMDB', '2610010300', '2610311500', 'CRANE ACTIVITY RAISES LNAV/VNAV MINIMA RWY 12L AND 12R.', { d: '01 02 03 04 05 06 07 0300-1500' }),
  mk('A3079', 'OMDB', '2610010800', '2610311600', 'TWY J5 BTN K AND TXL Z CLSD.', { d: '04 05 11 12 0800-1600' }),
  mk('A2909', 'OMDB', '2609200000', '2610241400', 'TWY M SECTION BTN M1C AND M2 CLSD.'),
];
const LTFJ = [
  mk('B3878', 'LTFJ', '2609291447', '2610291600', 'SEQUENCED FLASHING LIGHTS RWY 24L U/S BTN 690M AND 900M FM THR -DUE TO ELECTRICAL FAILURE-'),
  mk('B3421', 'LTFJ', '2608261410', '2610281600', 'TWY R2 CLSD TO TFC -DUE TO CONST WORKS-'),
  mk('B3200', 'LTFJ', '2608121508', '2610281600', 'TWY -A1- CLSD TO TFC. ADVISE ATC INSTRUCTION.'),
];
const FIR_OMDB = [
  { fir: 'ORBB', notams: [mk('A0403', 'ORBB', '2610010000', '2610311400', 'GPS JAMMING AND SPOOFING REPORTED IN ORBB FIR. EXPECT GNSS SIGNAL LOSS.')] },
  { fir: 'OMAE', notams: [mk('A3087', 'OMAE', '2610010000', '2610311400', 'GNSS INTERFERENCE IN UAE AIRSPACE. GNSS UNRELIABLE.')] },
  { fir: 'LTBB', notams: [
    mk('A4468', 'LTBB', '2610050700', '2610051100', 'PROHIBITED AREA ACTIVATED WI 9NM RADIUS OF 4057N02857E SFC-FL100', { q: 'LTBB/QRPCA/IV/BO/W/000/100/4057N02857E009' }),
    mk('A4317', 'LTBB', '2610010000', '2610311400', 'VOR/DME BIG U/S.') ] },
];

test('LTFM single airport (5 runways, 2 closed to landing) -> HIGH 6, OPEN WITH CONSTRAINTS', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: LTFM, metar: 'LTFM 041650Z 36008KT 9999 FEW040 18/10 Q1020 NOSIG' }] });
  console.log('        ->', r.level, r.score, r.verdict, JSON.stringify(r.counts));
  assert.strictEqual(r.counts.t1, 0);
  assert.strictEqual(r.level, 'HIGH'); assert.strictEqual(r.score, 6); assert.strictEqual(r.verdict, 'OPEN WITH CONSTRAINTS');
});
test('LTFM -> LTAI route -> CRITICAL 9 (LLWAS fully out + concentration at LTAI)', () => {
  const r = R.assessRisk({ now: NOW, airports: [
    { icao: 'LTFM', role: 'DEP', notams: LTFM, metar: 'LTFM 041650Z 36008KT 9999 FEW040 18/10 Q1020 NOSIG' },
    { icao: 'LTAI', role: 'ARR', notams: LTAI, metar: 'LTAI 041650Z 18008KT 9999 FEW040 24/14 Q1012 NOSIG' }] });
  console.log('        ->', r.level, r.score, r.verdict, JSON.stringify(r.counts), 'concentration:', r.concentration);
  assert.strictEqual(r.level, 'CRITICAL'); assert.strictEqual(r.score, 9); assert.strictEqual(r.concentration, 'LTAI');
});
test('LTFJ -> OMDB at 19:30Z -> CRITICAL 9 (two FIRs with GNSS interference)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB });
  console.log('        ->', r.level, r.score, r.verdict, JSON.stringify(r.counts));
  assert.strictEqual(r.level, 'CRITICAL'); assert.strictEqual(r.score, 9);
  assert.ok(!r.factors.some(f => (f.ids || []).includes('A3039/2026')), 'closure window already passed -> must not be scored');
});
test('OMDB at 09:00Z: runway closure window (11:30-13:00Z) is in the next 24h -> scored one tier lighter', () => {
  const r = R.assessRisk({ now: NOW_AM, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB });
  const rw = r.factors.find(f => f.key === 'OMDB:RWY');
  console.log('        ->', r.level, r.score, '| OMDB:RWY tier', rw && rw.tier, '|', rw && rw.label);
  assert.ok(rw); assert.strictEqual(rw.tier, 2);   // 1 of 2 runways closed in a window: T1 downgraded to T2
});
test('display severity: taxiway lights are not CRITICAL; LLWAS full is', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTAI', role: 'APT', notams: LTAI }] });
  assert.strictEqual(r.severityById.get('J4178/2026'), 'MEDIUM');
  assert.strictEqual(r.severityById.get('J3165/2026'), 'CRITICAL');
  assert.strictEqual(r.severityById.get('D1950/2026'), 'HIGH');
});
test('promptBlock renders level, score, verdict and factors', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: LTFM }] });
  const b = R.promptBlock(r);
  assert.ok(/LEVEL: HIGH/.test(b) && /SCORE: 6/.test(b) && /TIER 2 FACTORS/.test(b));
});
test('no NOTAMs -> LOW 0, GO', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'AAAA', role: 'DEP', notams: [] }, { icao: 'BBBB', role: 'ARR', notams: [] }] });
  assert.strictEqual(r.level, 'LOW'); assert.strictEqual(r.score, 0); assert.strictEqual(r.verdict, 'GO');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
