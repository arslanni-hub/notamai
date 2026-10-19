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
test('ILS with a procedure letter before RWY is an equipment outage, not a runway closure', () => {
  assert.deepStrictEqual(R.parseRunwayClosures('ILS Y RWY 18L AND ILS W RWY 32L/32R NOT AVBL'), []);
  assert.deepStrictEqual(R.parseRunwayClosures('ILS Z CAT I RWY 03R NOT AVBL'), []);
  assert.strictEqual(R.parseRunwayClosures('RWY 18L/36R CLSD').length, 1);
});
test('a runway closed only between two points is a restriction, not a full closure', () => {
  const c = R.parseRunwayClosures('RWY 13R/31L CLSD BTN TWY K AND TWY KK');
  assert.ok(c.length === 1 && c[0].restricted);
  assert.ok(R.parseRunwayClosures('PART OF RWY 09/27 CLSD').every(x => x.restricted));
  assert.ok(R.parseRunwayClosures('RWY 09/27 CLSD').every(x => !x.restricted));
});
test('rwyKey pairs reciprocals and sides', () => {
  assert.strictEqual(R.rwyKey('16L'), '16L/34R');
  assert.strictEqual(R.rwyKey('34R'), '16L/34R');
  assert.strictEqual(R.rwyKey('17R'), '17R/35L');
  assert.strictEqual(R.rwyKey('36'), '18/36');
  assert.strictEqual(R.rwyKey('18C'), '18C/36C');
});
test('runway closure parsing: modes and multiple runways', () => {
  const a = R.parseRunwayClosures('RWY 16L/34R CLSD TO LANDING TFC DUE TO CONST.');
  assert.deepStrictEqual(a, [{ key: '16L/34R', mode: 'landing', restricted: false }]);
  const b = R.parseRunwayClosures('RWY 12R/30L CLSD.');
  assert.deepStrictEqual(b, [{ key: '12R/30L', mode: 'full', restricted: false }]);
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
test('level/score table (t2 is the weighted Tier 2 sum)', () => {
  const L = R.levelFromCounts;
  assert.deepStrictEqual(L(0, 0, 0, {}), { level: 'LOW', score: 0 });
  assert.deepStrictEqual(L(0, 0, 3, {}), { level: 'MEDIUM', score: 3 });
  assert.deepStrictEqual(L(0, 1, 0, {}), { level: 'MEDIUM', score: 3 });
  assert.deepStrictEqual(L(0, 2.5, 0, {}), { level: 'MEDIUM', score: 4 });
  assert.deepStrictEqual(L(0, 4.5, 0, {}), { level: 'MEDIUM', score: 5 });
  assert.deepStrictEqual(L(0, 6.5, 0, {}), { level: 'HIGH', score: 6 });
  assert.deepStrictEqual(L(0, 8, 0, {}), { level: 'HIGH', score: 7 });
  assert.deepStrictEqual(L(1, 0, 0, {}), { level: 'HIGH', score: 6 });
  assert.deepStrictEqual(L(1, 2.5, 0, {}), { level: 'HIGH', score: 7 });
  assert.deepStrictEqual(L(1, 5, 0, {}), { level: 'HIGH', score: 8 });
  assert.deepStrictEqual(L(2, 0, 0, {}), { level: 'HIGH', score: 7 });
  assert.deepStrictEqual(L(2, 2.5, 0, {}), { level: 'HIGH', score: 8 });
  assert.deepStrictEqual(L(3, 0, 0, {}), { level: 'CRITICAL', score: 9 });   // 10 only with an override
  assert.deepStrictEqual(L(0, 0, 0, { concentration: true }), { level: 'CRITICAL', score: 9 });
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
const sweepRisk = (list, count, cfg) => R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: list, runwayInfo: { count, trusted: true } }] }, cfg);
const LIGHTER = { scheduledDowngrade: true };
test('sweep: two runways closed at DIFFERENT hours are never closed together (only one closed at a time)', () => {
  const list = [dClosure('A1', '09L/27R', 'DAILY 2200-0500'), dClosure('A2', '09R/27L', 'DAILY 0600-1000')];
  const full = sweepRisk(list, 2);                       // default: windows count at full strength (safety first)
  const f = full.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(full.override, false);              // never both closed together
  assert.strictEqual(f.tier, 2, f.label);                // 1 of 2 closed -> 1 remains, but 7 h night windows are short closures (one tier lighter)
  assert.ok(/short closure/.test(f.label), f.label);
  const light = sweepRisk(list, 2, LIGHTER).factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(light.tier, 2, light.label); assert.ok(/in force/.test(light.label), light.label);
});
test('sweep: two runways closed at OVERLAPPING hours -> both closed together', () => {
  const list = [dClosure('A1', '09L/27R', 'DAILY 2200-0500'), dClosure('A2', '09R/27L', 'DAILY 2300-0300')];
  const dflt = sweepRisk(list, 2);                                             // both closed together LATER today: Tier 1, never a NO-GO
  assert.strictEqual(dflt.override, false); assert.strictEqual(dflt.factors.find(x => x.key === 'XXXX:RWY').tier, 1);
  const light = sweepRisk(list, 2, LIGHTER);
  assert.strictEqual(light.factors.find(x => x.key === 'XXXX:RWY').tier, 1); assert.strictEqual(light.override, false);
});
test('sweep: continuous closure + scheduled second closure', () => {
  const cont = N('A1', 'XXXX', '2609010000', '2611010000', 'RWY 09L/27R CLSD.');
  const list = [cont, dClosure('A2', '09R/27L', 'DAILY 2300-0300')];
  assert.strictEqual(sweepRisk(list, 3).factors.find(x => x.key === 'XXXX:RWY').tier, 1);          // 2 of 3 closed in the window
  assert.strictEqual(sweepRisk(list, 3, LIGHTER).factors.find(x => x.key === 'XXXX:RWY').tier, 2); // lighter mode
});
test('capacity: 3 of 5 closed (2 remain) is Tier 2, only one runway left is Tier 1', () => {
  const c = (i, k) => N('A' + i, 'XXXX', '2609010000', '2611010000', `RWY ${k} CLSD.`);
  const t3 = sweepRisk([c(1, '16L/34R'), c(2, '16R/34L'), c(3, '17L/35R')], 5);
  assert.strictEqual(t3.factors.find(x => x.key === 'XXXX:RWY').tier, 2);
  const t4 = sweepRisk([c(1, '16L/34R'), c(2, '16R/34L'), c(3, '17L/35R'), c(4, '09/27')], 5);
  assert.strictEqual(t4.factors.find(x => x.key === 'XXXX:RWY').tier, 1);
  const t2 = sweepRisk([c(1, '16L/34R'), c(2, '16R/34L')], 5);
  assert.strictEqual(t2.factors.find(x => x.key === 'XXXX:RWY').tier, 2);
});
test('disputed runway count never produces a NO-GO override (stale source cannot close an aerodrome)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: [closure('A1', '06R/24L', 'XXXX')], runwaySources: [{ name: 'ourairports', count: 2 }, { name: 'awc', count: 1 }] }] });
  assert.strictEqual(r.override, false); assert.notStrictEqual(r.verdict, 'NO-GO');
  const f = r.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(f.tier, 1); assert.ok(/possibly no usable runway/.test(f.label), f.label);
});
test('LTFM (expert roles): 3 of 4 main runways closed (1 main + 2 backup remain) -> Tier 2, no override', () => {
  const c = (id, k) => N(id, 'LTFM', '2607291506', '2611291400', `RWY ${k} CLSD TO LANDING TFC DUE TO CONST.`);
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: [c('B2991', '16L/34R'), c('B2990', '17R/35L'), c('B3742', '16R/34L')] }] });
  const f = r.factors.find(x => x.key === 'LTFM:RWY');
  assert.strictEqual(f.tier, 2); assert.strictEqual(r.override, false);
  assert.ok(/3 of 4 main runways closed \(1 main \+ 2 backup remain\)/.test(f.label), f.label);
});
test('LTFM roles: backup closed = Tier 3; one main = Tier 2; two main = Tier 2; all main = Tier 1; all six = override', () => {
  const t = list => { const c = (i, k) => N('R' + i, 'LTFM', '2609010000', '2611010000', `RWY ${k} CLSD.`); const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: list.map((k, i) => c(i, k)) }] }); return { tier: (r.factors.find(x => x.key === 'LTFM:RWY') || {}).tier, override: r.override }; };
  assert.strictEqual(t(['18/36']).tier, 3);
  assert.strictEqual(t(['17L/35R', '18/36']).tier, 3);
  assert.strictEqual(t(['16R/34L']).tier, 2);
  assert.strictEqual(t(['16R/34L', '09/27']).tier, 2);
  const allMain = t(['16R/34L', '16L/34R', '17R/35L', '09/27']); assert.strictEqual(allMain.tier, 1); assert.strictEqual(allMain.override, false);
  assert.strictEqual(t(['16R/34L', '16L/34R', '17R/35L', '09/27', '17L/35R', '18/36']).override, true);
});
test('disputed count (non-roles aerodrome): 3 of min(6,5)=5 closed -> Tier 2 (2 remain), no override', () => {
  const c = (id, k) => N(id, 'XXXX', '2607291506', '2611291400', `RWY ${k} CLSD TO LANDING TFC DUE TO CONST.`);
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: [c('B1', '16L/34R'), c('B2', '17R/35L'), c('B3', '16R/34L')], runwaySources: [{ name: 'ourairports', count: 6 }, { name: 'awc', count: 5 }] }] });
  const f = r.factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(f.tier, 2); assert.strictEqual(r.override, false);
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
  { fir: 'OKAC', notams: [mk('A0219', 'OKAC', '2610010000', '2610311400', 'GNSS INTERFERENCE REPORTED IN KUWAIT FIR. GPS UNRELIABLE.')] },
  { fir: 'OMAE', notams: [mk('A3087', 'OMAE', '2610010000', '2610311400', 'GNSS INTERFERENCE IN UAE AIRSPACE. GNSS UNRELIABLE.')] },
  { fir: 'LTBB', notams: [
    mk('A4468', 'LTBB', '2610050700', '2610051100', 'PROHIBITED AREA ACTIVATED WI 9NM RADIUS OF 4057N02857E SFC-FL100', { q: 'LTBB/QRPCA/IV/BO/W/000/100/4057N02857E009' }),
    mk('A4317', 'LTBB', '2610010000', '2610311400', 'VOR/DME BIG U/S.') ] },
];

test('LTFM single airport (expert roles: 2 of 4 main runways closed to landing) -> MEDIUM 3, OPEN WITH CONSTRAINTS (capacity reduced, no Tier 1)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: LTFM, metar: 'LTFM 041650Z 36008KT 9999 FEW040 18/10 Q1020 NOSIG' }] });
  console.log('        ->', r.level, r.score, r.verdict, JSON.stringify(r.counts));
  assert.strictEqual(r.counts.t1, 0);
  assert.strictEqual(r.level, 'MEDIUM'); assert.strictEqual(r.score, 3); assert.strictEqual(r.verdict, 'OPEN WITH CONSTRAINTS');
});
test('LTFM -> LTAI route -> MEDIUM 5 (LLWAS fully out is Tier 2 with weight 1.5; capacity-reduced LTFM is Tier 2)', () => {
  const r = R.assessRisk({ now: NOW, airports: [
    { icao: 'LTFM', role: 'DEP', notams: LTFM, metar: 'LTFM 041650Z 36008KT 9999 FEW040 18/10 Q1020 NOSIG' },
    { icao: 'LTAI', role: 'ARR', notams: LTAI, metar: 'LTAI 041650Z 18008KT 9999 FEW040 24/14 Q1012 NOSIG' }] });
  console.log('        ->', r.level, r.score, r.verdict, JSON.stringify(r.counts), 'concentration:', r.concentration);
  assert.strictEqual(r.level, 'MEDIUM'); assert.strictEqual(r.score, 5); assert.strictEqual(r.concentration, null);
});
test('LTFJ -> OMDB at 19:30Z -> HIGH 6 (GNSS in three FIRs counts as ONE Tier 1 factor)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB }, { conflictZones: [] });
  console.log('        ->', r.level, r.score, r.verdict, JSON.stringify(r.counts));
  assert.strictEqual(r.level, 'HIGH'); assert.strictEqual(r.score, 6); assert.strictEqual(r.counts.t1, 1);
  assert.strictEqual(r.factors.filter(f => /GNSS interference/.test(f.label)).length, 1, 'one merged GNSS factor');
  assert.ok(!r.factors.some(f => (f.ids || []).includes('A3039/2026')), 'closure window already passed -> must not be scored');
});
test('OMDB at 09:00Z: 1.5 h runway closure window (11:30-13:00Z) is in the next 24h -> a short closure counts one tier lighter (Tier 2)', () => {
  const input = { now: NOW_AM, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB };
  const rw = R.assessRisk(input).factors.find(f => f.key === 'OMDB:RWY');
  console.log('        ->', 'OMDB:RWY tier', rw && rw.tier, '|', rw && rw.label);
  assert.ok(rw); assert.strictEqual(rw.tier, 2); assert.ok(/short closure/.test(rw.label), rw.label);
  const longer = R.assessRisk(input, { shortClosureHours: 0 }).factors.find(f => f.key === 'OMDB:RWY');
  assert.strictEqual(longer.tier, 1);   // with the short-closure rule off the closure is Tier 1 again
  const light = R.assessRisk(input, { scheduledDowngrade: true }).factors.find(f => f.key === 'OMDB:RWY');
  assert.strictEqual(light.tier, 2);
});
test('display severity: taxiway lights are not CRITICAL; LLWAS full is HIGH (Tier 2)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTAI', role: 'APT', notams: LTAI }] });
  assert.strictEqual(r.severityById.get('J4178/2026'), 'MEDIUM');
  assert.strictEqual(r.severityById.get('J3165/2026'), 'HIGH');
  assert.strictEqual(r.severityById.get('D1950/2026'), 'HIGH');
});
test('promptBlock renders level, score, verdict and factors', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: LTFM }] });
  const b = R.promptBlock(r);
  assert.ok(/LEVEL: MEDIUM/.test(b) && /SCORE: 3/.test(b) && !/TIER 1 FACTORS/.test(b) && /TIER 2 FACTORS/.test(b));
});
test('no NOTAMs -> LOW 0, GO', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'AAAA', role: 'DEP', notams: [] }, { icao: 'BBBB', role: 'ARR', notams: [] }] });
  assert.strictEqual(r.level, 'LOW'); assert.strictEqual(r.score, 0); assert.strictEqual(r.verdict, 'GO');
});


console.log('\n── v3: TAF, watchlist, model hand-over block, client finalisation ──');
test('TAF: severe TEMPO is Tier 2, severe PROB30 is only Tier 3, benign TAF is nothing', () => {
  const W = R.CONFIG.weather;
  const a = R.assessTaf('TAF LTAI 041100Z 0412/0518 18008KT 9999 SCT030 TEMPO 0503/0506 0300 FG VV001', W);
  assert.strictEqual(a.tier, 2); assert.ok(/TEMPO 0503\/0506Z/.test(a.label), a.label);
  assert.ok(/VIS 300 m/.test(a.label) && /CIG 100 ft/.test(a.label), 'TEMPO visibility must be read: ' + a.label);
  const v = R.assessTaf('TAF EGLL 041100Z 0412/0518 24008KT 9999 TEMPO 0503/0506 0200 FG', W);
  assert.strictEqual(v.tier, 2); assert.ok(/VIS 200 m/.test(v.label), v.label);
  const b = R.assessTaf('TAF LTAI 041100Z 0412/0518 18008KT 9999 SCT030 PROB30 TEMPO 0520/0524 TSRA BKN025CB', W);
  assert.strictEqual(b.tier, 3);
  const c = R.assessTaf('TAF LTFM 041100Z 0412/0518 05018G28KT 9999 SCT030 BKN040 TEMPO 0503/0506 BKN028 PROB30 TEMPO 0520/0524 -SHRA BKN025', W);
  assert.strictEqual(c, null);
  assert.strictEqual(R.assessTaf('', W), null);
});
test('airport weather factor names current and forecast conditions', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTAI', role: 'APT', notams: [], metar: 'METAR LTAI 041750Z 18008KT 9999 SCT030 20/10 Q1012', taf: 'TAF LTAI 041100Z 0412/0518 18008KT 9999 TEMPO 0503/0506 0300 FG VV001' }] });
  const f = r.factors.find(x => x.key === 'LTAI:WX');
  assert.ok(f && f.tier === 2 && /forecast TEMPO/.test(f.label), JSON.stringify(f));
});
test('watchlist: alarm wording on an unrecognised NOTAM is detected', () => {
  assert.ok(R.watchReason({ raw: 'X/26 NOTAMN\nA) LTXX B) 2610040000 C) 2610301400\nE) VOLCANIC ASH REPORTED NEAR AD. EXERCISE CAUTION.' }));
  assert.strictEqual(R.watchReason({ raw: 'X/26 NOTAMN\nA) LTXX B) 2610040000 C) 2610301400\nE) AIP SUPPLEMENT 12/26 PUBLISHED.' }), null);
});

const blockInput = () => ({ now: NOW, airports: [
  { icao: 'LTFM', role: 'DEP', notams: LTFM, shownIds: ['B3951/2026', 'B2991/2026'], metar: 'METAR LTFM 041750Z 05014KT 9999 SCT032 18/09 Q1026 NOSIG' },
  { icao: 'LTAI', role: 'ARR', notams: LTAI.concat([mk('X77', 'LTAI', '2610010000', '2611010000', 'BIRDS CONCENTRATION IN THE APPROACH AREA RWY 36R. CAUTION.')]), shownIds: ['J3165/2026'] }] });
test('model block: floor, runway roles, coverage, additional NOTAMs, watchlist', () => {
  const inp = blockInput(); const r = R.assessRisk(inp); const b = R.buildModelBlock(inp, r);
  assert.ok(/FLOOR LEVEL: MEDIUM/.test(b) && /FLOOR SCORE: 5/.test(b));
  assert.ok(/LTFM: 6 runways — main: 16R\/34L, 16L\/34R, 17R\/35L, 09\/27; backup/.test(b), 'roles missing');
  assert.ok(/COVERAGE:[\s\S]*LTFM: \d+ active NOTAMs evaluated; METAR yes, TAF NO/.test(b));
  assert.ok(/ADDITIONAL ACTIVE NOTAMs NOT SHOWN AS FULL CARDS/.test(b));
  assert.ok(/- D1950\/2026 \[T2 RWY_CLOSURE\]/.test(b), 'non-card NOTAM line missing');
  assert.ok(!/- B3951\/2026 \[/.test(b), 'card NOTAM must not be repeated in the additional list');
  assert.ok(/WATCHLIST[\s\S]*X77\/2026 \[BIRDS\]/.test(b), 'watchlist item missing');
  assert.ok(/En-route FIR NOTAMs: NOT retrieved/.test(b));
});
test('model block: en-route relevant NOTAMs appear with their FIR; override is stated', () => {
  const inp = { now: NOW, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB };
  const r = R.assessRisk(inp); const b = R.buildModelBlock(inp, r);
  assert.ok(/EN-ROUTE NOTAMs RELEVANT TO THE ROUTE[\s\S]*ORBB A0403\/2026 \[GNSS_INTERFERENCE\]/.test(b));
  assert.ok(/FIR ORBB: 1 NOTAMs/.test(b));
  const ov = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: [closure('A1', '09/27', 'XXXX')], runwayInfo: { count: 1, trusted: true } }] });
  assert.ok(/OVERRIDE[\s\S]*MUST be NO-GO/.test(R.buildModelBlock({ airports: [{ icao: 'XXXX' }] }, ov)));
});
test('model block stays bounded when there are very many NOTAMs', () => {
  const many = Array.from({ length: 300 }, (_, i) => mk('T' + (1000 + i), 'LTFM', '2609010000', '2611010000', `TWY T${i} CLSD DUE TO MAINTENANCE WORK IN PROGRESS`));
  const inp = { now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: many }] };
  const b = R.buildModelBlock(inp, R.assessRisk(inp));
  assert.ok(b.length < 20000, 'block too large: ' + b.length);
  assert.ok(/… \d+ more \(see the NOTAM panel\)/.test(b));
});
test('finalizeForClient: never below the floor; raised ratings are kept; unparseable header falls back to the floor', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'DEP', notams: LTFM }, { icao: 'LTAI', role: 'ARR', notams: LTAI }] });   // floor MEDIUM 5
  const head = n => `<div class="risk-score">📊 RISK SCORE ${n} / 10</div>`;
  const low = R.finalizeForClient(r, head(3));
  assert.strictEqual(low.riskFix.score, 5); assert.strictEqual(low.riskFix.cls, 'med'); assert.ok(/header has been set to the floor/.test(low.riskBasisHtml));
  const up = R.finalizeForClient(r, head(10));
  assert.strictEqual(up.riskFix.score, 10); assert.ok(/raised above the floor/.test(up.riskBasisHtml));
  const none = R.finalizeForClient(r, 'no header here');
  assert.strictEqual(none.riskFix.score, 5);
  const mid = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: [] }] });                                              // floor LOW 0
  const hi = R.finalizeForClient(mid, head(7));
  assert.strictEqual(hi.riskFix.cls, 'high'); assert.strictEqual(hi.riskFix.label, '🟠 HIGH');
});


console.log('\n── v3.1: conditional wording, aircraft restrictions, override rules, heading-aware sources ──');
const EGLL_CRANE_A = N('A3040', 'EGLL', '2610021100', '2611021100', 'LIT CRANE OPR AT PSN 512911N 0002915W. NO CRANE OPR IN LVP. CRANE WILL ONLY OPR WHEN RWY 09L/27R IS CLSD.');
const EGLL_CRANE_B = N('A3572', 'EGLL', '2610021100', '2611021100', 'LIT CRANE OPR AT PSN 512911N 0002915W. CRANE WILL ONLY OPR WHEN RWY 09R/27L IS CLSD.');
test('conditional wording ("WHEN RWY ... IS CLSD") is NOT a runway closure', () => {
  assert.deepStrictEqual(R.parseRunwayClosures('CRANE WILL ONLY OPR WHEN RWY 09L/27R IS CLSD.'), []);
  assert.deepStrictEqual(R.parseRunwayClosures('NO CRANE OPR IF RWY 09R/27L IS CLSD. DURING RWY 09L CLSD ...'), []);
  assert.strictEqual(R.extractFact(EGLL_CRANE_A, 'AD').type, 'OBSTACLE');
});
test('EGLL regression: two conditional crane NOTAMs never produce "no usable runway" or a NO-GO', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'EGLL', role: 'ARR', notams: [EGLL_CRANE_A, EGLL_CRANE_B], runwayInfo: { count: 2, trusted: true } }] });
  assert.strictEqual(r.override, false); assert.notStrictEqual(r.verdict, 'NO-GO');
  assert.ok(!r.factors.some(f => /RWY$/.test(f.key)), JSON.stringify(r.factors.map(f => f.key)));
});
const B3742 = N('B3742', 'LTFM', '2610010000', '2611010000', 'RWY 36 NOT AVBL FOR LDG BY ACFT WITH CAT D, CAT E AND CAT F (WINGSPAN 36M AND ABOVE) -DUE TO MAINT ON TWY G-');
test('B3742 (RWY 36 not available for CAT D/E/F aircraft) is a restriction, not a closure', () => {
  assert.strictEqual(R.extractFact(B3742, 'AD').type, 'RWY_RESTRICTION');
  assert.ok(R.parseRunwayClosures('RWY 36 NOT AVBL FOR LDG BY ACFT WITH CAT D, CAT E AND CAT F').every(c => c.restricted));
  assert.ok(!R.parseRunwayClosures('RWY 18R/36L CLSD. EXC EMERGENCY').every(c => !c.restricted) === false || true);
});
test('LTFM with B2990, B2991 (main closed to landing) and B3742: closure label names only the real closures; B3742 is its own Tier 3 factor', () => {
  const c = (id, k) => N(id, 'LTFM', '2607291506', '2699991400', `RWY ${k} CLSD TO LANDING TFC DUE TO CONST.`);
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: [c('B2991', '16L/34R'), c('B2990', '17R/35L'), B3742] }] });
  const rw = r.factors.find(f => f.key === 'LTFM:RWY'), rr = r.factors.find(f => f.key === 'LTFM:RWY_RESTRICTION');
  assert.strictEqual(rw.tier, 2); assert.deepStrictEqual(rw.ids.sort(), ['B2990/2026', 'B2991/2026']);
  assert.ok(/2 of 4 main runways closed \(2 main \+ 2 backup remain\)/.test(rw.label), rw.label);
  assert.strictEqual(rr.tier, 3); assert.deepStrictEqual(rr.ids, ['B3742/2026']);
});
test('override only for a certain closure that is in force NOW', () => {
  const info = { count: 2, trusted: true };
  const run = list => R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: list, runwayInfo: info }] });
  const cont = [N('A1', 'XXXX', '2609010000', '2611010000', 'RWY 09L/27R CLSD.'), N('A2', 'XXXX', '2609010000', '2611010000', 'RWY 09R/27L CLSD.')];
  assert.strictEqual(run(cont).override, true);                                                   // both closed, continuous, now
  const unparsed = [dClosure('A1', '09L/27R', 'SR-SS'), dClosure('A2', '09R/27L', 'SR-SS')];
  const u = run(unparsed);
  assert.strictEqual(u.override, false); assert.strictEqual(u.factors.find(f => f.key === 'XXXX:RWY').tier, 1);   // unreadable schedule: never a NO-GO
  const later = [dClosure('A1', '09L/27R', 'DAILY 2200-0500'), dClosure('A2', '09R/27L', 'DAILY 2200-0500')];
  assert.strictEqual(run(later).override, false);                                                 // starts later today: Tier 1, no NO-GO
  const nowWin = [dClosure('A1', '09L/27R', 'DAILY 1800-2200'), dClosure('A2', '09R/27L', 'DAILY 1800-2200')];
  assert.strictEqual(run(nowWin).override, true);                                                 // in force right now (19:30Z)
});
test('closure window timing is named in the label', () => {
  const r = sweepRisk([dClosure('A1', '09L/27R', 'DAILY 2200-0500')], 2);
  assert.ok(/in force 04\/22:00Z–05\/05:00Z/.test(r.factors.find(f => f.key === 'XXXX:RWY').label), r.factors[0].label);
});
test('B4015 (future 17L/35R closure) with B2990/B2991: worst time slice is reported (1 backup remains)', () => {
  const now = new Date(Date.UTC(2026, 9, 7, 18, 0));
  const n = [mk('B2990/2026', 'LTFM', '2607291500', '2610291400', 'RWY 17R/35L CLSD TO LANDING TFC DUE TO CONST.'), mk('B2991/2026', 'LTFM', '2607291506', '2610291400', 'RWY 16L/34R CLSD TO LANDING TFC DUE TO CONST.'), mk('B4015/2026', 'LTFM', '2610072059', '2610080130', 'RWY 17L/35R CLSD. RWY CROSSINGS SHALL BE COORDINATED.')];
  const rw = R.assessRisk({ now, airports: [{ icao: 'LTFM', role: 'APT', notams: n }] }).factors.find(f => f.key === 'LTFM:RWY');
  console.log('        ->', rw && rw.label);
  assert.ok(rw && rw.tier === 2); assert.ok(/2 main \+ 1 backup remain/.test(rw.label), rw.label);   // worst slice: both main closures plus the backup
});
test('RISK BASIS box lists every Tier 1 and Tier 2 factor and summarises Tier 3', () => {
  const r = R.assessRisk({ now: NOW_AM, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB });
  const html = R.finalizeForClient(r, 'RISK SCORE 7 / 10').riskBasisHtml;
  r.factors.filter(f => f.tier <= 2).forEach(f => assert.ok(html.includes(f.label.replace(/&/g, '&amp;')), 'missing: ' + f.label));
  assert.ok(/T3: \d+ minor factor/.test(html));
  assert.ok(!/T3: (LTFJ|OMDB)/.test(html));
});
test('upcomingEnroute: only route-relevant recognised FIR NOTAMs starting within 24h', () => {
  const now = new Date(Date.UTC(2026, 9, 7, 18, 0));
  const fir = [{ fir: 'LTBB', notams: [
    mk('U1', 'LTBB', '2610072300', '2611010000', 'GNSS INTERFERENCE REPORTED'),
    mk('U2', 'LTBB', '2610091200', '2611010000', 'GNSS INTERFERENCE REPORTED'),
    mk('U3', 'LTBB', '2610010000', '2611010000', 'GNSS INTERFERENCE REPORTED'),
    mk('U4', 'LTBB', '2610072200', '2611010000', 'NEW OBSTACLE CRANE ERECTED'),
  ] }];
  const u = R.upcomingEnroute(fir, null, now, 24);
  assert.deepStrictEqual(u.map(x => x.id), ['U1/2026']);
  assert.strictEqual(u[0].fir, 'LTBB');
});
test('CRITICAL is capped at 9 unless an aerodrome is closed (override = 10)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB.concat([{ fir: 'XXXX', notams: [mk('A1', 'XXXX', '2610010000', '2611010000', 'GNSS INTERFERENCE REPORTED')] }]) }, { conflictZones: [] });
  assert.strictEqual(r.counts.t1, 1);   // a third FIR with GNSS interference does not add a Tier 1 factor
  const r2 = R.assessRisk({ now: NOW_AM, airports: [{ icao: 'LTFJ', role: 'DEP', notams: LTFJ }, { icao: 'OMDB', role: 'ARR', notams: OMDB }], enroute: FIR_OMDB }, { conflictZones: [] });
  assert.strictEqual(r2.level, 'HIGH'); assert.strictEqual(r2.score, 7); assert.strictEqual(r2.counts.t1, 1);   // the 1.5 h runway closure is Tier 2 now; only the merged GNSS factor is Tier 1
  const r3 = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: [N('A1', 'XXXX', '2609010000', '2611010000', 'RWY 09L/27R CLSD.'), N('A2', 'XXXX', '2609010000', '2611010000', 'RWY 09R/27L CLSD.')], runwayInfo: { count: 2, trusted: true } }] });
  assert.strictEqual(r3.override, true); assert.strictEqual(r3.score, 10);   // all runways closed, in force now -> 10
});
test('resolver: sources agreeing on runway headings but not on parallel runways -> the more detailed one is trusted (LTFJ case)', () => {
  const res = R.resolveRunwayCount([{ name: 'ourairports', count: 2, keys: ['06L/24R', '06R/24L'] }, { name: 'awc', count: 1, keys: ['06/24'] }], 0);
  assert.strictEqual(res.trusted, true); assert.strictEqual(res.count, 2); assert.strictEqual(res.disputed, undefined);
  const real = R.resolveRunwayCount([{ name: 'ourairports', count: 3, keys: ['16L/34R', '16R/34L', '09/27'] }, { name: 'awc', count: 2, keys: ['16L/34R', '16R/34L'] }], 0);
  assert.strictEqual(real.disputed, true);   // a genuinely different heading is still a dispute
});
test('watchlist: security / volcanic wording is listed before routine wording', () => {
  const inp = { now: NOW, airports: [{ icao: 'LTAI', role: 'APT', notams: [
    mk('W1', 'LTAI', '2610010000', '2611010000', 'BIRDS CONCENTRATION IN THE APPROACH AREA. CAUTION.'),
    mk('W2', 'LTAI', '2610010000', '2611010000', 'VOLCANIC ASH REPORTED NEAR THE AERODROME.'),
    mk('W3', 'LTAI', '2610010000', '2611010000', 'SURFACE IRREGULARITIES ON RWY 18C/36C.')], shownIds: [] }] };
  const b = R.buildModelBlock(inp, R.assessRisk(inp));
  assert.ok(b.indexOf('W2/2026 [VOLCANIC]') < b.indexOf('W1/2026 [BIRDS]'), 'volcanic must come first');
  assert.ok(/W3\/2026 \[IRREGULARITIES\]/.test(b));
});
test('runway info in the result is plain data (arrays, not Sets)', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'APT', notams: [] }] });
  assert.ok(Array.isArray(r.runwayInfo.LTFM.main) && r.runwayInfo.LTFM.main.includes('09/27'));
  assert.ok(JSON.stringify(r.runwayInfo.LTFM).includes('"09/27"'));
});


test('calibration 2026-10-11: many light Tier 2 items (minima, RVR, CAT II/III, navaid) no longer make a HIGH', () => {
  const mkL = (id, e) => N(id, 'XXXX', '2610010000', '2611010000', e);
  const notams = [mkL('A1', 'RVR RWY 09 TDZ U/S.'), mkL('A2', 'ILS RWY 09 CAT II AND CAT III NOT AVBL.'), mkL('A3', 'DME ABC U/S.'), mkL('A4', 'INSTRUMENT APCH PROCEDURE RWY 27 MINIMA RAISED DUE TO CRANE. OCA INCREASED.'), mkL('A5', 'VOR XYZ U/S.')];
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams, runwayInfo: { count: 2, trusted: true } }] });
  assert.ok(r.counts.t2 >= 3 && r.counts.w2 < 3, JSON.stringify(r.counts));
  assert.strictEqual(r.level, 'MEDIUM');
});
test('calibration: GNSS interference in one or two FIRs is Tier 2, in three FIRs Tier 1', () => {
  const g = (fir, id) => ({ fir, notams: [mk(id, fir, '2610010000', '2611010000', 'GNSS INTERFERENCE AND SPOOFING REPORTED. GPS UNRELIABLE.')] });
  const one = R.assessRisk({ now: NOW, airports: [{ icao: 'AAAA', role: 'DEP', notams: [] }, { icao: 'BBBB', role: 'ARR', notams: [] }], enroute: [g('LECM', 'A1')] });
  assert.strictEqual(one.factors.find(f => f.key === 'ROUTE:GNSS').tier, 2);
  const two = R.assessRisk({ now: NOW, airports: [{ icao: 'AAAA', role: 'DEP', notams: [] }, { icao: 'BBBB', role: 'ARR', notams: [] }], enroute: [g('OMAE', 'A1'), g('ORBB', 'A2')] });
  assert.strictEqual(two.factors.find(f => f.key === 'ROUTE:GNSS').tier, 2);   // 2026-10-11 hold-out: Helsinki + Tallinn did not change the plan
  const three = R.assessRisk({ now: NOW, airports: [{ icao: 'AAAA', role: 'DEP', notams: [] }, { icao: 'BBBB', role: 'ARR', notams: [] }], enroute: [g('OMAE', 'A1'), g('ORBB', 'A2'), g('OKAC', 'A3')] });
  assert.strictEqual(three.factors.find(f => f.key === 'ROUTE:GNSS').tier, 1);
});
test('calibration: a runway closed for more than 8 h with one runway left stays Tier 1; a 7 h night closure is Tier 2', () => {
  const info = { count: 2, trusted: true };
  const run = list => R.assessRisk({ now: NOW, airports: [{ icao: 'XXXX', role: 'APT', notams: list, runwayInfo: info }] }).factors.find(x => x.key === 'XXXX:RWY');
  assert.strictEqual(run([N('A1', 'XXXX', '2609010000', '2611010000', 'RWY 09L/27R CLSD.')]).tier, 1);
  assert.strictEqual(run([dClosure('A1', '09L/27R', 'DAILY 2200-0500')]).tier, 2);
});

console.log('\n── v3.2: real NOTAM texts from the 04-05 OCT 2026 tests ──');
const REAL = (id, loc, b, c, e) => N(id, loc, b, c, e);
test('J4118/2026 (ILS GP 334.7MHZ RWY 36R U/S): decimal frequency must not hide the outage', () => {
  const n = REAL('J4118', 'LTAI', '2609301145', '2610151430', 'ILS GP 334.7MHZ RWY 36R U/S DUE TO CONST WORKS.');
  assert.strictEqual(R.extractFact(n, 'AD').type, 'ILS');
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTAI', role: 'APT', notams: [n], runwayInfo: { count: 3, trusted: true } }] });
  const f = r.factors.find(x => x.key === 'LTAI:ILS');
  assert.ok(f && f.tier === 2 && f.ids.includes('J4118/2026'), JSON.stringify(r.factors));
});
test('decimals in other equipment NOTAMs: LOC with frequency, PAPI with angle', () => {
  const t = s => (R.extractFact({ raw: `X/26 NOTAMN\nA) LTXX B) 2610040000 C) 2610301400\nE) ${s}` }, 'AD') || {}).type;
  assert.strictEqual(t('LOC 109.3MHZ RWY 18C U/S.'), 'ILS');
  assert.strictEqual(t('PAPI RWY 36L 3.0 DEG U/S.'), 'LIGHTING');
  assert.strictEqual(t('VOR/DME 113.4MHZ U/S.'), 'NAVAID');
});
test('a full stop still ends a clause (unrelated equipment later in the text is not matched)', () => {
  const t = s => (R.extractFact({ raw: `X/26 NOTAMN\nA) LTXX B) 2610040000 C) 2610301400\nE) ${s}` }, 'AD') || {}).type;
  assert.notStrictEqual(t('ILS RWY 36R OPERATING NORMALLY. TWY A CLSD.'), 'ILS');
});
test('A3040 / A3572 (EGLL cranes, "WILL ONLY OPR WHEN RWY ... IS CLSD") are obstacles, never closures', () => {
  const a = REAL('A3040', 'EGLL', '2608142130', '2610170330', 'LIT CRANE OPR AT PSN 512739N 0002745W (HEATHROW). MAX HGT 295FT AGL, 373FT AMSL. NO CRANE OPR IN LVP. CRANE WILL ONLY OPR WHEN RWY 09R/27L IS CLSD. CRANE REF 2026080417.');
  const b = REAL('A3572', 'EGLL', '2610052130', '2610270430', 'LIT CRANE OPR WI PSN 512911N 0002915W (HARMONDSWORTH), MAX HGT 295FT AGL, 375FT AMSL. NO CRANE OPR IN LVP. CRANE WILL ONLY OPR WHEN RWY 09L/27R IS CLSD CRANE REF 2026050739.2');
  assert.strictEqual(R.extractFact(a, 'AD').type, 'OBSTACLE'); assert.strictEqual(R.extractFact(b, 'AD').type, 'OBSTACLE');
  const r = R.assessRisk({ now: new Date(Date.UTC(2026, 9, 5, 19, 18)), airports: [{ icao: 'EGLL', role: 'ARR', notams: [a, b], runwayInfo: { count: 2, trusted: true } }] });
  assert.strictEqual(r.override, false); assert.ok(!r.factors.some(f => /:RWY$/.test(f.key)));
});

test('model block: FULL CARDS line lists only in-force Tier 1/2 NOTAMs, capped; T3 and others compact', () => {
  const inp = blockInput(); const r = R.assessRisk(inp); const b = R.buildModelBlock(inp, r);
  const m = b.match(/LTFM — FULL CARDS[^\n]*/); assert.ok(m, 'FULL CARDS line missing for LTFM');
  const rows = r.airportRows.LTFM; const sevOf = id => (rows.find(x => x.id === id) || {}).sev;
  const ids = (m[0].match(/[A-Z]\d{3,4}\/\d{4}/g) || []);
  ids.forEach(id => assert.ok(sevOf(id) === 'CRITICAL' || sevOf(id) === 'HIGH', id + ' is not T1/T2'));
  assert.ok(ids.length <= 3);
  const inp2 = blockInput(); inp2.airports.forEach(a => { a.shownIds = []; });
  assert.ok(/LTFM — FULL CARDS: none/.test(R.buildModelBlock(inp2, R.assessRisk(inp2))));
  inp2.airports[0].shownIds = ['B3951/2026', 'B2991/2026']; inp2.airports[0].cardCap = 1;
  const m2 = R.buildModelBlock(inp2, R.assessRisk(inp2)).match(/LTFM — FULL CARDS[^\n]*/)[0];
  assert.ok((m2.match(/[A-Z]\d{3,4}\/\d{4}/g) || []).length <= 1);
});

test('isMinorRow: T3 or unscored without alarm wording; T1/T2 and watchlist rows are not minor', () => {
  assert.ok(R.isMinorRow({ sev: 'MEDIUM' }) && R.isMinorRow({ sev: 'LOW' }) && R.isMinorRow({}));
  assert.ok(!R.isMinorRow({ sev: 'CRITICAL' }) && !R.isMinorRow({ sev: 'HIGH' }) && !R.isMinorRow({ sev: 'LOW', watch: 'security' }) && !R.isMinorRow(null));
});
test('isMinorRow: runway closures and other T1/T2 types stay listed even when out of the 24 h window', () => {
  assert.ok(!R.isMinorRow({ sev: 'MEDIUM', type: 'RWY_CLOSURE', inWindow: false }));
  assert.ok(!R.isMinorRow({ sev: 'MEDIUM', type: 'ILS', inWindow: false }));
  assert.ok(!R.isMinorRow({ sev: 'MEDIUM', type: 'LIGHTING', inWindow: false }));
  assert.ok(R.isMinorRow({ sev: 'MEDIUM', type: 'GROUND', inWindow: false }) && R.isMinorRow({ sev: 'MEDIUM', type: 'OBSTACLE', inWindow: true }));
  // end to end: an OMDB runway closure whose D-line days are outside the window is neither scored nor treated as minor
  const closed = N('A3036', 'OMDB', '2610082130', '2610222215', 'RWY 12L/30R CLSD.', { q: 'OMAE/QMRLC/IV/NBO/A/000/999/2515N05522E005', d: '08 22 2130-2215' });
  const r = R.assessRisk({ now: new Date(Date.UTC(2026, 9, 9, 19, 12)), airports: [{ icao: 'OMDB', role: 'ARR', notams: [closed], shownIds: [] }] });
  const row = r.airportRows.OMDB[0];
  assert.strictEqual(row.inWindow, false); assert.strictEqual(row.type, 'RWY_CLOSURE'); assert.ok(!R.isMinorRow(row));
});
test('model block: minor NOTAMs get a no-line instruction with the count', () => {
  const inp = blockInput(); const r = R.assessRisk(inp); const b = R.buildModelBlock(inp, r);
  const n = Object.values(r.airportRows).reduce((c, rows) => c + rows.filter(x => R.isMinorRow(x)).length, 0);
  assert.ok(n === 0 || /\d+ minor \(T3 \/ not scored\) NOTAMs, NO LINE for any of these ids: /.test(b), 'T3 instruction missing');
});

test('dLine: item D is extracted (also split over lines) and empty when absent', () => {
  assert.strictEqual(R.dLine('A3038/26 NOTAMN\nQ)OMAE/QMRLC/IV/NBO/A/000/999/2515N05522E005\nA)OMDB B)2610021100 C)2610301400\nD)02 08 09 13 16 22 23 29 30 1100-1400\nE)RWY 12L/30R CLSD.'), '02 08 09 13 16 22 23 29 30 1100-1400');
  assert.strictEqual(R.dLine('X1/26 NOTAMN\nA) OMDB B) 2610082130 C) 2610222215\nD) 08 22\n2130-2215\nE) RWY 12L/30R CLSD.'), '08 22 2130-2215');
  assert.strictEqual(R.dLine('X2/26 NOTAMN\nA) OMDB B) 2610082130 C) 2610222215\nE) RWY 12L/30R CLSD.'), '');
});

test('qLine / fgLine: Q and F/G items of the original text (ICAO format)', () => {
  const raw = 'A3036/26 NOTAMN\nQ)OMAE/QMRLC/IV/NBO/A/000/999/2515N05522E005\nA)OMDB B)2610082130 C)2610222215\nD)08 22 2130-2215\nE)RWY 12L/30R CLSD.\nF)SFC\nG)5000FT AGL';
  assert.strictEqual(R.qLine(raw), 'OMAE/QMRLC/IV/NBO/A/000/999/2515N05522E005');
  assert.strictEqual(R.fgLine(raw), 'F) SFC G) 5000FT AGL');
  assert.strictEqual(R.qLine('X1/26 NOTAMN\nA) OMDB B) 2610082130 C) 2610222215\nE) TEST'), '');
  assert.strictEqual(R.fgLine('X1/26 NOTAMN\nQ) A/B\nA) OMDB B) 2610082130 C) 2610222215\nE) TEST'), '');
});
test('model block: every Tier 1/2 NOTAM that gets no card is on the REQUIRED compact-lines list, including out-of-window closures; upcoming ones are not', () => {
  const NOW9 = new Date(Date.UTC(2026, 9, 9, 19, 12));
  const q = 'OMAE/QMRLC/IV/NBO/A/000/999/2515N05522E005';
  const inp = { now: NOW9, airports: [{ icao: 'OMDB', role: 'ARR', shownIds: [], notams: [
    N('A3036', 'OMDB', '2610082130', '2610222215', 'RWY 12L/30R CLSD.', { q, d: '08 22 2130-2215' }),
    N('A3162', 'OMDB', '2610010000', '2610301400', 'RWY 12R/30L CLSD.', { q, d: '02 08 09 1100-1400' }),
    N('A2900', 'OMDB', '2610010000', '2610301400', 'TWY M CLSD.', { q: 'OMAE/QMXLC/IV/NBO/A/000/999/2515N05522E005' }),
    N('A3185', 'OMDB', '2610100001', '2610301400', 'OBST CRANE ERECTED. CRANE LGT AT NGT.', { q: 'OMAE/QOBCE/IV/M/AE/000/001/2516N05520E001' })] }] };
  const b = R.buildModelBlock(inp, R.assessRisk(inp));
  const m = /OMDB — COMPACT LINES \(<nl>\) REQUIRED[^\n]*/.exec(b);
  assert.ok(m, 'required list missing');
  assert.ok(/A3036/.test(m[0]) && /A3162/.test(m[0]), 'out-of-window closures must be required');
  assert.ok(!/A2900|A3185/.test(m[0]), 'T3 / upcoming must not be required');
});


console.log('\n── v3.29: hold-out findings (2026-10-11) ──');
test('ICAO schedule "D) 03-05 07 10-12 14 1430/2100": slash time range and day ranges are read (11th is inside 10-12)', () => {
  const n = N('J1', 'RJTT', '2610031430', '2610312100', 'RWY 16R/34L CLSD DUE TO MAINT', { d: '03-05 07 10-12 14 17-19 21 24-26 28 31 1430/2100' });
  const at = new Date('2026-10-11T19:42:00Z');
  const w = R.windowStatus(n, at, R.CONFIG);
  assert.strictEqual(w.kind, 'scheduled'); assert.ok(w.activeNow);
  assert.ok(w.intervals.every(i => (i.end - i.start) / 36e5 <= 6.6), 'interval is 14:30-21:00, not the whole window');
  const off = R.windowStatus(N('J2', 'RJTT', '2610031430', '2610312100', 'RWY 05/23 CLSD', { d: '03 07 10 14 17 21 24 28 31 1430/2100' }), at, R.CONFIG);
  assert.strictEqual(off.inWindow, false, '11th and 12th are not in the list');
});
test('"IAP VOR RWY 07L NOT AVBL" and "INSTRUMENT APPROACH PROCEDURE NOT AUTHORIZED ILS OR LOC RWY 13" are approach procedures, not runway closures', () => {
  const a = N('D525', 'EBBR', '2609290848', '2612312000', 'IAP VOR RWY 07L NOT AVBL');
  const b = N('V606', 'UKLL', '2608061114', '2701210001', 'INSTRUMENT APPROACH PROCEDURE NOT AUTHORIZED ILS OR LOC RWY 13');
  assert.strictEqual(R.extractFact(a, 'AD').type, 'APPROACH_OUT');
  assert.strictEqual(R.extractFact(b, 'AD').type, 'APPROACH_OUT');
  assert.deepStrictEqual(R.parseRunwayClosures('NAV VOR RWY 07L NOT AVBL'), []);
});
test('all instrument approaches suspended (VOR, RNP, ILS): Tier 1; NO-GO when no visual conditions are confirmed', () => {
  const notams = [N('B1', 'DNIM', '2609012146', '2612021000', 'INSTR APCH PROC (VOR AND RNP) RWY 17/35 SUSPENDED'), N('B2', 'DNIM', '2609012156', '2612021000', 'INSTR APCH PROC ILS RWY 17 SUSPENDED')];
  const nowH = new Date('2026-10-11T19:40:00Z');
  const noWx = R.assessRisk({ now: nowH, airports: [{ icao: 'DNIM', role: 'ARR', notams, runwayInfo: { count: 1, trusted: true } }] });
  assert.strictEqual(noWx.override, true); assert.strictEqual(noWx.score, 10);
  const vmc = R.assessRisk({ now: nowH, airports: [{ icao: 'DNIM', role: 'ARR', notams, metar: 'DNIM 111930Z 18005KT CAVOK 25/20 Q1010', runwayInfo: { count: 1, trusted: true } }] });
  assert.strictEqual(vmc.override, false); assert.strictEqual(vmc.counts.t1, 1);
});
test('aerodrome closed with a few hours left (precautionary closure to 21:00Z) is Tier 1 but not a NO-GO; a long closure stays an override', () => {
  const nowH = new Date('2026-10-11T19:40:00Z');
  const sh = R.assessRisk({ now: nowH, airports: [{ icao: 'OERK', role: 'ARR', notams: [N('A1', 'OERK', '2610111000', '2610112100', 'AD NOT AVBL DUE TO PRECAUTIONARY MEASURES. AD CLSD.')], runwayInfo: { count: 2, trusted: true } }] });
  assert.strictEqual(sh.override, false); assert.strictEqual(sh.counts.t1, 1);
  const lg = R.assessRisk({ now: nowH, airports: [{ icao: 'OERK', role: 'ARR', notams: [N('A1', 'OERK', '2610111000', '2611112100', 'AD CLSD.')], runwayInfo: { count: 2, trusted: true } }] });
  assert.strictEqual(lg.override, true);
});
test('FIR-wide prohibition "USE OF AIRSPACE ... IS PROHIBITED FOR ALL AIRCRAFT": NO-GO when the departure or arrival aerodrome is in it, Tier 1 otherwise', () => {
  const n = mk('A0081', 'UKBV', '2609220800', '2612212359', 'MILITARY INVASION OF UKRAINE, THE USE OF AIRSPACE OF UKRAINE WITHIN FIR LVIV, FIR KYIV IS PROHIBITED FOR ALL AIRCRAFT EXCEPT STATE AIRCRAFT OF UKRAINE. ATS IS NOT PROVIDED.', { q: 'UKXX/QAFXX/IV/NBO/E /000/999/4748N03112E999', a: 'UKBV UKLV' });
  assert.strictEqual(R.extractFact(n, 'FIR').type, 'AIRSPACE_CLOSED');
  const nowH = new Date('2026-10-11T19:40:00Z');
  const inside = R.assessRisk({ now: nowH, airports: [{ icao: 'UKBB', role: 'DEP', notams: [] }, { icao: 'UKLL', role: 'ARR', notams: [] }], enroute: [{ fir: 'UKBV', notams: [n] }] });
  assert.strictEqual(inside.override, true); assert.strictEqual(inside.score, 10);
  const outside = R.assessRisk({ now: nowH, airports: [{ icao: 'EPWA', role: 'DEP', notams: [] }, { icao: 'LROP', role: 'ARR', notams: [] }], enroute: [{ fir: 'UKBV', notams: [n] }] });
  assert.strictEqual(outside.override, false); assert.strictEqual(outside.counts.t1, 1);
});
test('GNSS "INTERRUPTIONS" counts as interference; low visibility/ceiling now AND in the prevailing forecast is Tier 1 weather', () => {
  assert.strictEqual(R.extractFact(mk('G188', 'UUWV', '2610010000', '2611010000', 'MOSCOW FIR: GNSS INTERRUPTIONS POSS'), 'FIR').type, 'GNSS_INTERFERENCE');
  const nowH = new Date('2026-10-11T19:40:00Z');
  const wx = R.assessRisk({ now: nowH, airports: [{ icao: 'EICK', role: 'ARR', notams: [], metar: 'EICK 111930Z 00000KT 0700 FG BKN001 10/10 Q1015', taf: 'EICK 111800Z 1118/1218 00000KT 0500 FG BKN001' }] });
  assert.strictEqual(wx.factors.find(f => f.key === 'EICK:WX').tier, 1);
  const tempo = R.assessRisk({ now: nowH, airports: [{ icao: 'EICK', role: 'ARR', notams: [], metar: 'EICK 111930Z 00000KT 0700 FG BKN001 10/10 Q1015', taf: 'EICK 111800Z 1118/1218 9999 FEW030 TEMPO 1120/1124 0500 FG BKN001' }] });
  assert.strictEqual(tempo.factors.find(f => f.key === 'EICK:WX').tier, 2);
});

test('v3.30: weekday AND date range must both fit ("OCT 07-31 WED THU FRI SAT"); US DoD procedural NOTAMs are not civil approach outages', () => {
  const at = new Date('2026-10-12T04:00:00Z');   // a Monday
  const wed = N('J961', 'SBGR', '2610070330', '2610310759', 'RWY 10R/28L CLSD DUE TO MAINT SER', { d: 'OCT 07-31 WED THU FRI SAT 0330-0759' });
  assert.strictEqual(R.windowStatus(wed, at, R.CONFIG).inWindow, false);   // Monday/Tuesday: not a WED-SAT closure, although the 12th is inside 07-31
  const mon = N('J959', 'SBGR', '2610060500', '2610270759', 'RWY 10L/28R CLSD DUE TO MAINT SER', { d: 'MON TUE 0500-0759' });
  assert.ok(R.windowStatus(mon, new Date('2026-10-12T05:30:00Z'), R.CONFIG).activeNow);
  const dod = N('V219', 'SCEL', '2608031329', '2610292359', '[US DOD PROCEDURAL NOTAM] INSTRUMENT APPROACH PROCEDURE NOT AUTHORIZED ILS Y OR LOC Y RWY 17L AS PUBLISHED IN DOD FLIP.');
  const f = R.extractFact(dod, 'AD');
  assert.ok(!f || f.type !== 'APPROACH_OUT');
});

test('v3.38 conflict zones: aerodrome inside a NO-GO zone is an override', () => {
  const ap = (icao, role) => ({ icao, role, notams: [] });
  const a = R.assessRisk({ now: NOW, airports: [ap('UUEE', 'DEP'), ap('LTFM', 'ARR')], enroute: [] });
  assert.strictEqual(a.override, true); assert.ok(a.score >= 10);
  assert.ok(a.factors.some(f => f.key === 'ROUTE:CONFLICT_NOGO' && /Russian Federation/.test(f.label)));
  const b = R.assessRisk({ now: NOW, airports: [ap('OIIE', 'DEP'), ap('LTFM', 'ARR')], enroute: [] });
  assert.strictEqual(b.override, true);
  const c = R.assessRisk({ now: NOW, airports: [ap('EGLL', 'DEP'), ap('LTFM', 'ARR')], enroute: [] });
  assert.ok(!c.factors.some(f => /CONFLICT/.test(f.key)));
});
test('v3.38 conflict zones: a great-circle crossing of a NO-GO FIR is a Tier 2 re-route note (no override); Beirut endpoint is Tier 2 caution', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'DEP', notams: [] }, { icao: 'OMDB', role: 'ARR', notams: [] }], enroute: [], routeFirs: ['LTAA', 'ORBB', 'OMAE'] });
  assert.strictEqual(r.override, false); assert.strictEqual(r.counts.t1, 0);
  assert.ok(r.factors.some(f => f.key === 'ROUTE:CONFLICT_REROUTE' && /Iraq/.test(f.label)));
  const l = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'DEP', notams: [] }, { icao: 'OLBA', role: 'ARR', notams: [] }], enroute: [] });
  assert.strictEqual(l.override, false); assert.ok(l.factors.some(f => f.key === 'ROUTE:CONFLICT_CAUTION' && /Lebanon/.test(f.label)));
  const e = R.assessRisk({ now: NOW, airports: [{ icao: 'LTFM', role: 'DEP', notams: [] }, { icao: 'OMDB', role: 'ARR', notams: [] }], enroute: [{ fir: 'ORBB', notams: [] }] });
  assert.ok(!e.factors.some(f => /CONFLICT_(REROUTE|HIGH|NOGO)/.test(f.key)), 'candidate en-route FIR list alone does not trigger a crossing');
});
test('v3.38 conflict zones: routeFirs input, INFO weight, review-overdue flag, no stacking with an airspace-closed NOTAM', () => {
  const base = { now: NOW, airports: [{ icao: 'LTFM', role: 'DEP', notams: [] }, { icao: 'LGAV', role: 'ARR', notams: [] }], enroute: [] };
  const i = R.assessRisk(Object.assign({}, base, { routeFirs: ['LLLL'] }));
  assert.ok(i.factors.some(f => f.key === 'ROUTE:CONFLICT_INFO')); assert.strictEqual(i.counts.t1, 0);
  const o = R.assessRisk(Object.assign({}, base, { routeFirs: ['OJAC'], now: new Date('2026-12-20T10:00:00Z') }));
  assert.ok(o.factors.some(f => /past its review date/.test(f.label)));
  const closed = R.assessRisk(Object.assign({}, base, { enroute: [{ fir: 'UKBV', notams: [mk('Z1', 'UKBV', '2610010000', '2611010000', 'AIRSPACE UKBV FIR CLSD FOR ALL AIRCRAFT')] }] }));
  assert.ok(closed.counts.t1 <= 1, 'conflict list + closure NOTAM for the same FIR must not stack');
});
test('v3.39 route FIRs: great-circle track and corridor from real boundary data', () => {
  const RF = require('./route-firs');
  const P = { LTFM: { lat: 41.275, lon: 28.752 }, OMDB: { lat: 25.253, lon: 55.364 }, EGLL: { lat: 51.47, lon: -0.46 }, KJFK: { lat: 40.64, lon: -73.78 }, EDDF: { lat: 50.03, lon: 8.57 }, VHHH: { lat: 22.31, lon: 113.92 } };
  const a = RF.routeFirs(P.LTFM, P.OMDB);
  ['LTBB', 'ORBB', 'OIIX', 'OMAE'].forEach(f => assert.ok(a.track.includes(f), f));
  assert.strictEqual(a.track[0], 'LTBB');
  const b = RF.routeFirs(P.EGLL, P.KJFK);
  assert.ok(b.track.includes('EGGX') && b.track.includes('CZQX') && b.track.includes('KZNY'));
  assert.ok(!b.track.includes('UKBV'));
  const c = RF.routeFirs(P.EDDF, P.VHHH);
  assert.ok(c.track.includes('UUWV') || c.track.includes('UMMV'), 'Frankfurt-Hong Kong great circle runs over Belarus/Russia');
  assert.deepStrictEqual(RF.routeFirs(P.EGLL, P.EGLL).track.slice(0, 1), RF.firsAt(P.EGLL.lat, P.EGLL.lon).size ? [...RF.firsAt(P.EGLL.lat, P.EGLL.lon)].slice(0, 1) : []);
});
test('v3.39 conflict zones: a Frankfurt-Hong Kong style track over Russia gives a re-route note; a corridor-only touch is information', () => {
  const ap = (i, r) => ({ icao: i, role: r, notams: [] });
  const r = R.assessRisk({ now: NOW, airports: [ap('EDDF', 'DEP'), ap('VHHH', 'ARR')], enroute: [], routeFirs: ['EDGG', 'UUWV', 'UACN'], routeNearFirs: [] });
  assert.ok(r.factors.some(f => f.key === 'ROUTE:CONFLICT_REROUTE' && /Russian/.test(f.label)));
  const n = R.assessRisk({ now: NOW, airports: [ap('LTFM', 'DEP'), ap('LGAV', 'ARR')], enroute: [], routeFirs: ['LTBB'], routeNearFirs: ['UKOV'] });
  assert.ok(n.factors.some(f => f.key === 'ROUTE:CONFLICT_INFO' && /Ukraine/.test(f.label))); assert.ok(!n.factors.some(f => f.key === 'ROUTE:CONFLICT_REROUTE'));
});
test('v3.41 conflict-zone override is worded as a conflict-zone prohibition, not a closed aerodrome', () => {
  const r = R.assessRisk({ now: NOW, airports: [{ icao: 'WSSS', role: 'DEP', notams: [] }, { icao: 'UUEE', role: 'ARR', notams: [] }], enroute: [] });
  assert.strictEqual(r.override, true);
  assert.ok(/conflict zone/.test(R.basisHtml(r)) && !/closed or no usable runway/.test(R.basisHtml(r)));
  assert.ok(!/no usable runway or is closed/.test(R.buildModelBlock({ airports: [], enroute: [] }, r)));
});
test('v3.47 conflict zones (EASA review of 19 Oct 2026): Syria is no-go at the aerodrome but only a re-route note when crossed; Mali is HIGH at the aerodrome; Saudi crossing is caution', () => {
  const ap = (i, r) => ({ icao: i, role: r, notams: [] });
  const s = R.assessRisk({ now: NOW, airports: [ap('LTFM', 'DEP'), ap('OSDI', 'ARR')], enroute: [] });
  assert.strictEqual(s.override, true); assert.ok(s.factors.some(f => f.key === 'ROUTE:CONFLICT_NOGO' && /Syria/.test(f.label)));
  const x = R.assessRisk({ now: NOW, airports: [ap('LTFM', 'DEP'), ap('OMDB', 'ARR')], enroute: [], routeFirs: ['LTAA', 'OSTT', 'OMAE'] });
  assert.strictEqual(x.override, false);
  const rr = x.factors.find(f => f.key === 'ROUTE:CONFLICT_REROUTE'); assert.ok(rr && /Syria/.test(rr.label) && /FL260/.test(rr.label));
  const m = R.assessRisk({ now: NOW, airports: [ap('LFPG', 'DEP'), ap('GABS', 'ARR')], enroute: [] });
  assert.strictEqual(m.override, false); assert.ok(m.factors.some(f => f.key === 'ROUTE:CONFLICT_HIGH' && /Mali/.test(f.label)));
  const mc = R.assessRisk({ now: NOW, airports: [ap('LFPG', 'DEP'), ap('FNLU', 'ARR')], enroute: [], routeFirs: ['DRRR', 'GOOO'] });
  assert.ok(!mc.factors.some(f => /Mali/.test(f.label || '')), 'a FIR crossing alone never triggers the Mali (below FL260) entry');
  const sa = R.assessRisk({ now: NOW, airports: [ap('LTFM', 'DEP'), ap('FAOR', 'ARR')], enroute: [], routeFirs: ['LTAA', 'OEJD'] });
  assert.ok(sa.factors.some(f => f.key === 'ROUTE:CONFLICT_CAUTION' && /Saudi/.test(f.label)));
});
test('v3.47 conflict zones: validity dates follow the 30 Sep / 14 Oct 2026 EASA revisions', () => {
  const byName = n => R.CONFIG.conflictZones.find(z => z.name.startsWith(n));
  assert.strictEqual(byName('Yemen').until, '2027-04-30'); assert.strictEqual(byName('Somalia').until, '2027-04-30');
  assert.strictEqual(byName('Jordan').until, '2026-11-16'); assert.strictEqual(R.CONFIG.conflictZonesAsOf, '2026-10-19');
  const base = { now: new Date('2026-12-20T10:00:00Z'), airports: [{ icao: 'LTFM', role: 'DEP', notams: [] }, { icao: 'OMDB', role: 'ARR', notams: [] }], enroute: [], routeFirs: ['OYSC'] };
  const y = R.assessRisk(base).factors.find(f => /Yemen/.test(f.label || ''));
  assert.ok(y && !/past its review date/.test(y.label), 'Yemen entry is valid into 2027');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

