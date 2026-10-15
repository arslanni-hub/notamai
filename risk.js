'use strict';
/**
 * NOTAM Intelligence — deterministic risk rubric (v0.2)
 *
 * Purpose: the risk LEVEL, SCORE and VERDICT of a briefing are computed here, from structured data,
 * instead of being "chosen" by the language model. The same input always yields the same output.
 *
 * Model of the rubric
 *   1. Every NOTAM that is active inside the look-ahead window is reduced to one or more FACTORS.
 *   2. Every factor belongs to a TIER:
 *        Tier 1 = critical loss of capability   (aerodrome closed / single runway left, LLWAS fully out,
 *                                                 GNSS interference in a FIR, ATC unavailable)
 *        Tier 2 = significant restriction        (runway capacity reduced, ILS/GP/CAT II-III/RVR out,
 *                                                 critical lighting, raised minima, navaid out,
 *                                                 airspace restrictions, bad weather ...)
 *        Tier 3 = ground-movement / minor items  (taxiway closures, obstacles, minor equipment)
 *   3. LEVEL and SCORE are derived from the tier counts (see levelFromCounts).
 *
 * All tunable values live in CONFIG below — an AIM expert can adjust them without touching the logic.
 */

const CONFIG = {
  // Only NOTAMs that are active at some point between now and now + windowHours are scored.
  windowHours: 24,

  // OPTIONAL expert-verified runway counts (physical runways; each pair like "16L/34R" counts once).
  // Leave EMPTY by default: runway counts are normally resolved LIVE per aerodrome from data sources
  // (see resolveRunwayCount). An entry here OVERRIDES live data, so only add values an AIM expert has verified.
  // Example:  LTFM: 5, OMDB: 2
  runwayCountOverrides: {},

  // Expert-verified runway roles. "main" runways carry the planned traffic; "backup" runways are used depending
  // on traffic density. The runway count of such an aerodrome is main + backup and is TRUSTED.
  // LTFM (Istanbul Airport): 6 runways, the 09/27 opened in September 2026.
  runwayRoles: {
    LTFM: { main: ['16R/34L', '16L/34R', '17R/35L', '09/27'], backup: ['17L/35R', '18/36'] },
  },

  // A runway closure that only applies during scheduled windows (NOTAM line D) is one tier lighter.
  scheduledDowngrade: false,   // safety first: a closure inside the window counts at full strength (ETA is unknown)

  // Runway capacity: if this fraction (or more) of an aerodrome's runways is closed, the situation is Tier 1
  // even when more than one runway remains (e.g. 3 of 5 closed). Set to 1.01 to disable.
  // 2026-10-11 calibration: disabled. With several runways still usable (e.g. 2 of 4 main closed, 2 main + 2 backup open)
  // the situation is a capacity reduction (Tier 2), not Tier 1. Tier 1 stays for "one usable runway left" or "no main runway left".
  runwayClosedFractionT1: 1.01,

  // A runway closure that lasts at most this many hours (night works, short maintenance windows) is one tier lighter.
  shortClosureHours: 8,

  // Weight of each Tier 2 factor in the score (default 1). Light items that rarely change a plan on their own count less.
  t2Weights: { MINIMA: 0.25, RVR: 0.25, CAT23: 0.25, NAVAID: 0.25, LIGHTING: 0.5, RWY_RESTRICTION: 0.5, LLWAS: 1.5, 'ROUTE:AIRSPACE': 0.5, 'ROUTE:NAVAID': 0.25, 'ROUTE:GNSS_OUTAGE': 0.25, APCH_NA: 0.5, 'ROUTE:CONFLICT_CAUTION': 1, 'ROUTE:CONFLICT_REROUTE': 1, 'ROUTE:CONFLICT_INFO': 0.5 },
  thunderstormForecastWeight: 0.5,   // a forecast thunderstorm without low visibility/ceiling
  // En-route GNSS interference reported in this many FIRs or more is Tier 1; in a single FIR it is Tier 2.
  // 2026-10-11 hold-out: two neighbouring FIRs with chronic interference (e.g. Helsinki + Tallinn) did not change the plan -> Tier 1 from three FIRs.
  gnssRouteT1Firs: 3,

  // En-route restrictions are scored only if they are near the planned route (dep -> arr great circle).
  routeCorridorNm: 100,     // half-width of the corridor around the route
  lowLevelUpperFl: 150,     // restrictions topping out below this FL only matter near the aerodromes ...
  nearAirportNm: 80,        // ... i.e. within this distance of departure or arrival

  // One aerodrome with >= t1 Tier-1 factors AND >= t2 Tier-2 factors is escalated to CRITICAL.
  concentration: { t1: 1, t2: 3 },   // t2 is the weighted Tier 2 sum (see t2Weights)

  // Weather thresholds (METAR).
  weather: { lifrVisM: 1600, lifrCeilFt: 500, ifrVisM: 5000, ifrCeilFt: 1000, gustKt: 35 },

  levelBands: { LOW: [0, 2], MEDIUM: [3, 5], HIGH: [6, 8], CRITICAL: [9, 10] },

  // ── Conflict-zone list (static, maintained by hand) ───────────────────────────────────────────────
  // Source: EASA Conflict Zone Information Bulletins (CZIB) + FAA "Prohibitions, Restrictions and Notices".
  // AS OF 2026-10-15 (EASA review of 30 Sep 2026 included). REVIEW THIS LIST whenever EASA extends or issues a CZIB
  // (next dates: Jordan 16 Oct 2026; Iran/Iraq/Lebanon/Gulf/Saudi Arabia 16 Nov 2026; Syria 30 Nov 2026; Yemen/Somalia 31 Oct 2026).
  // Each entry: firs (FIR codes), prefixes (ICAO location prefixes of aerodromes inside), endpoint / crossing = severity when the
  // departure or arrival aerodrome is inside / the route crosses the FIR:
  //   'NOGO'    do not operate at any level          -> Tier 1 and NO-GO (endpoint) / Tier 1 (crossing: re-route)
  //   'HIGH'    do not operate with narrow exceptions -> Tier 1
  //   'CAUTION' exercise caution                      -> Tier 2 (weight 1)
  //   'INFO'    take the risk into account            -> Tier 2 (weight 0.5)
  // An entry past its `until` date is still applied and marked "review overdue" (a lapsed bulletin is usually renewed).
  conflictZonesAsOf: '2026-10-15',
  conflictZones: [
    { name: 'Ukraine', firs: ['UKBV', 'UKDV', 'UKLV', 'UKOV', 'UKFV', 'UKBU'], prefixes: ['UK'], endpoint: 'NOGO', crossing: 'NOGO', until: '2027-01-31', src: 'EASA CZIB-2022-01R14; FAA KICZ A0004/22', rec: 'do not operate, including landings and departures' },
    { name: 'Russian Federation west of 60°E', firs: ['UUWV', 'URRV', 'UWWW', 'ULLL', 'ULMM', 'ULAA', 'UUYY', 'UMKK'], prefixes: ['UU', 'UR', 'UW', 'UL', 'UMKK'], endpoint: 'NOGO', crossing: 'NOGO', until: '2027-01-31', src: 'EASA CZIB-2025-01R3; FAA KICZ A0005/22 (parts of Moscow, Samara, Rostov FIRs)', rec: 'do not operate at any level west of 60°E' },
    { name: 'Iran', firs: ['OIIX'], prefixes: ['OI'], endpoint: 'NOGO', crossing: 'NOGO', until: '2026-11-16', src: 'EASA CZIB-2026-04-R2; FAA SFAR 117', rec: 'do not operate at any level' },
    { name: 'Iraq', firs: ['ORBB'], prefixes: ['OR'], endpoint: 'NOGO', crossing: 'NOGO', until: '2026-11-16', src: 'EASA CZIB-2026-05-R2; FAA SFAR 77', rec: 'do not operate at any level' },
    { name: 'Syria', firs: ['OSTT'], prefixes: ['OS'], endpoint: 'NOGO', crossing: 'NOGO', until: '2026-11-30', src: 'EASA CZIB-2017-03 (revised 1 Oct 2026); FAA SFAR 114', rec: 'do not operate at any level' },
    { name: 'Sudan', firs: ['HSSS'], prefixes: ['HS'], endpoint: 'NOGO', crossing: 'NOGO', until: '2027-01-31', src: 'EASA CZIB-2023-01R8', rec: 'do not fly at any level' },
    { name: 'Lebanon', firs: ['OLBB'], prefixes: ['OL'], endpoint: 'CAUTION', crossing: 'NOGO', until: '2026-11-16', src: 'EASA CZIB-2026-06-R2', rec: 'do not operate, except Beirut approaches from the sea and departures over the sea (risk assessment required)' },
    { name: 'Yemen', firs: ['OYSC'], prefixes: ['OY'], endpoint: 'HIGH', crossing: 'NOGO', until: '2026-10-31', src: 'EASA CZIB-2017-07R19; FAA SFAR 115', rec: 'do not operate, except maritime routes east of B400 (caution)' },
    { name: 'Libya', firs: ['HLLL'], prefixes: ['HL'], endpoint: 'HIGH', crossing: 'CAUTION', until: '2027-01-31', src: 'EASA CZIB-2017-02R20; FAA SFAR 112', rec: 'below FL320 do not operate except coastal approaches from the sea; above FL320 exercise caution' },
    { name: 'Afghanistan', firs: ['OAKX'], prefixes: ['OA'], endpoint: 'HIGH', crossing: 'CAUTION', until: '2027-01-31', src: 'EASA CZIB-2017-08R19; FAA SFAR 119', rec: 'do not operate below FL320' },
    { name: 'Somalia', firs: ['HCSM'], prefixes: ['HC'], endpoint: 'HIGH', crossing: 'INFO', until: '2026-10-31', src: 'EASA CZIB-2017-05R19; FAA SFAR 107', rec: 'do not operate at or below FL260' },
    { name: 'Pakistan (Baluchistan, Khyber Pakhtunkhwa)', firs: ['OPKR', 'OPLR'], prefixes: ['OP'], endpoint: 'CAUTION', crossing: 'INFO', until: '2027-01-31', src: 'EASA CZIB-2018-02R21', rec: 'do not operate below FL260 in Baluchistan and Khyber Pakhtunkhwa' },
    { name: 'Persian Gulf and Gulf of Oman (Bahrain, Kuwait, Qatar, UAE, Oman FIRs)', firs: ['OBBB', 'OKAC', 'OTDF', 'OTBD', 'OMAE', 'OOMM'], prefixes: ['OB', 'OK', 'OT', 'OM', 'OO'], endpoint: 'INFO', crossing: 'CAUTION', until: '2026-11-16', src: 'EASA CZIB-2026-07-R3', rec: 'do not operate over Gulf waters (except arrivals/departures) or the Gulf of Oman west of 58°E; exercise caution over land' },
    { name: 'Saudi Arabia (defined portion of Jeddah FIR)', firs: ['OEJD'], prefixes: [], endpoint: null, crossing: 'INFO', until: '2026-11-16', src: 'EASA CZIB-2026-09; FAA KICZ A0056/26', rec: 'a defined portion of the Jeddah FIR is affected — see the bulletin' },
    { name: 'Jordan', firs: ['OJAC'], prefixes: ['OJ'], endpoint: 'INFO', crossing: 'INFO', until: '2026-10-16', src: 'EASA CZIB-2026-08-R2', rec: 'medium risk: be ready for tactical deconfliction and short-notice instructions' },
    { name: 'Israel', firs: ['LLLL'], prefixes: ['LL'], endpoint: 'INFO', crossing: 'INFO', until: '2026-12-31', src: 'EASA information note of 30 Sep 2026', rec: 'take the threat and risk situation into account in risk assessment and routing' },
    { name: 'Myanmar', firs: ['VYYF'], prefixes: ['VY'], endpoint: 'INFO', crossing: 'INFO', until: '2026-12-31', src: 'EASA information note of 30 Jul 2026', rec: 'take potential risk into account in risk assessment and routing' },
    { name: 'Ethiopia', firs: ['HAAA'], prefixes: ['HA'], endpoint: 'INFO', crossing: 'INFO', until: '2026-12-31', src: 'EASA information note of 30 Apr 2026', rec: 'take potential risk into account in risk assessment and routing' },
  ],
};

const US = /\b(U\/S|UNSERVICEABLE|NOT\s+AVBL|NOT\s+AVAILABLE|N\/A|OTS|OUT\s+OF\s+SERVICE|UNUSABLE|INOP)\b/;

// ───────────────────────── text helpers ─────────────────────────
// True when `word` and an outage phrase occur close together inside the same clause ("." ends a clause).
function out(t, word, win) {
  win = win || 60;
  const w = word.source, u = US.source;
  // A clause ends at a full stop, but a decimal point ("334.7MHZ", "3.0 DEG") must not end it.
  const C = '(?:[^.]|\\.(?=\\d))';
  return new RegExp(`(?:${w})${C}{0,${win}}?(?:${u})`).test(t) || new RegExp(`(?:${u})${C}{0,20}?(?:${w})`).test(t);
}

const rawOf = n => String((n && (n.raw || n.body)) || '');
const UP = n => rawOf(n).toUpperCase();

function eText(n) {
  const raw = rawOf(n);
  const m = raw.match(/\bE\)\s*([\s\S]*?)(?=\n\s*[FG]\)|$)/i);
  return (m ? m[1] : raw).toUpperCase().replace(/\s+/g, ' ').trim();
}

function parseQ(n) {
  const m = rawOf(n).match(/\bQ\)\s*([^\n]+)/);
  if (!m) return null;
  const parts = m[1].replace(/\s+/g, '').toUpperCase().split('/');
  const code = parts[1] || '';
  return { fir: parts[0] || '', code, subj: code.slice(1, 3), cond: code.slice(3, 5), lower: parts[5], upper: parts[6], geo: parts[7] };
}

// "4057N02857E009" -> { lat, lon, radius(NM) }.  Radius 999 means "whole FIR / not localised".
function parseGeo(s) {
  const m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})?$/.exec(s || '');
  if (!m) return null;
  let lat = +m[1] + +m[2] / 60; if (m[3] === 'S') lat = -lat;
  let lon = +m[4] + +m[5] / 60; if (m[6] === 'W') lon = -lon;
  return { lat, lon, radius: m[7] === undefined ? 5 : +m[7] };
}

// ── great-circle helpers (nautical miles) ──
const R_NM = 3440.065;
const rad = d => d * Math.PI / 180;
function gcDist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
}
function trackDistances(p, a, b) {
  const d13 = gcDist(a, p) / R_NM, t13 = bearing(a, p), t12 = bearing(a, b);
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  let at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt)))) * R_NM;
  if (Math.cos(t13 - t12) < 0) at = -at;
  return { cross: Math.abs(xt) * R_NM, along: at };
}

// Is this FIR-level NOTAM geographically relevant to the planned route?  Unknown geometry -> relevant (conservative).
function routeRelevant(n, route, cfg) {
  if (!route || !route.dep || !route.arr) return true;
  const q = parseQ(n);
  const g = q && parseGeo(q.geo);
  if (!g || g.radius >= 999) return true;
  const L = gcDist(route.dep, route.arr);
  const { cross, along } = trackDistances(g, route.dep, route.arr);
  const reach = cfg.routeCorridorNm + g.radius;
  if (cross > reach || along < -reach || along > L + reach) return false;
  const upper = parseInt(q.upper, 10);
  if (!isNaN(upper) && upper < cfg.lowLevelUpperFl) {
    const dEnd = Math.min(gcDist(g, route.dep), gcDist(g, route.arr));
    if (dEnd > cfg.nearAirportNm + g.radius) return false;
  }
  return true;
}

// ───────────────────────── validity / schedule ─────────────────────────
function parseDt(s) {
  if (!s) return null;
  s = String(s).replace(/[^0-9]/g, '');
  let y, rest;
  if (s.length === 12) { y = +s.slice(0, 4); rest = s.slice(4); }
  else if (s.length === 10) { y = 2000 + +s.slice(0, 2); rest = s.slice(2); }
  else return null;
  return new Date(Date.UTC(y, +rest.slice(0, 2) - 1, +rest.slice(2, 4), +rest.slice(4, 6), +rest.slice(6, 8)));
}

function validity(n) {
  const raw = UP(n);
  let eff = parseDt(n.effective);
  if (!eff) { const m = raw.match(/\bB\)\s*(\d{10})/); if (m) eff = parseDt(m[1]); }
  let exp = null, perm = false;
  const e = String(n.expiration || '').toUpperCase();
  if (e === 'PERM') perm = true; else exp = parseDt(e);
  if (!exp && !perm) {
    const m = raw.match(/\bC\)\s*(\d{10}|PERM)/);
    if (m) { if (m[1] === 'PERM') perm = true; else exp = parseDt(m[1]); }
  }
  return { eff, exp, perm };
}

// Items Q (qualifier line) and F/G (limits) of the original NOTAM text, for the NOTAMs & MET panel (ICAO format).
function qLine(raw) {
  const m = /(?:^|\n)\s*Q\)\s*([^\n]*)/.exec(raw || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function fgLine(raw) {
  const t = String(raw || ''), i = t.search(/(?:^|\n)\s*E\)/);
  const tail = i >= 0 ? t.slice(i) : '';
  const f = /(?:^|\n)\s*F\)\s*([^\n]*)/.exec(tail), g = /(?:^|\n)\s*G\)\s*([^\n]*)/.exec(tail);
  return [f && f[1].trim() ? 'F) ' + f[1].trim() : '', g && g[1].trim() ? 'G) ' + g[1].trim() : ''].filter(Boolean).join(' ');
}

function dLine(raw) {
  const m = raw.match(/\bD\)\s*([\s\S]*?)(?=\n\s*E\)|\bE\)|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function parseSchedule(d) {
  if (/\bSR\b|\bSS\b|SUNRISE|SUNSET/.test(d)) return { unparsed: true };
  const ranges = [];
  const rx = /(\d{4})\s*[-/]\s*(\d{4})/g;   // "0700-1900" and the ICAO form "0700/1900"
  let m;
  while ((m = rx.exec(d))) ranges.push([m[1], m[2]]);
  if (!ranges.length) return { unparsed: true };
  const rest = d.replace(/(\d{4})\s*[-/]\s*(\d{4})/g, ' ');
  // day lists: "03 07 10-12 14" -> 3, 7, 10, 11, 12, 14 (a day range counts every day in it)
  const days = [];
  for (const x of rest.matchAll(/\b(0[1-9]|[12]\d|3[01])(?:\s*-\s*(0[1-9]|[12]\d|3[01]))?\b/g)) {
    const a = +x[1], b = x[2] ? +x[2] : a;
    if (b >= a) for (let k = a; k <= b; k++) days.push(k); else days.push(a, b);
  }
  const wd = new Set();
  for (const x of rest.matchAll(/\b(MON|TUE|WED|THU|FRI|SAT|SUN)(?:\s*-\s*(MON|TUE|WED|THU|FRI|SAT|SUN))?\b/g)) {
    const a = WD.indexOf(x[1]);
    if (x[2]) { const b = WD.indexOf(x[2]); let i = a; wd.add(i); while (i !== b) { i = (i + 1) % 7; wd.add(i); } }
    else wd.add(a);
  }
  const daily = /\b(DLY|DAILY)\b/.test(rest);
  return { ranges, days, wd, daily };
}

function isAdminNotam(n) {
  return /\bTRIGGER\b/.test(UP(n)) || validity(n).perm;
}

// Is this NOTAM relevant inside [now, now + windowHours]?  Also returns the time INTERVALS (clipped to the
// window) during which it is in force, so that simultaneity can be evaluated (e.g. runways closed at different hours).
function windowStatus(n, now, cfg) {
  const windowEnd = new Date(now.getTime() + cfg.windowHours * 3600e3);
  const v = validity(n);
  if (v.eff && v.eff > windowEnd) return { inWindow: false, reason: 'later' };
  if (v.exp && v.exp <= now) return { inWindow: false, reason: 'expired' };
  const lo = new Date(Math.max(now.getTime(), v.eff ? v.eff.getTime() : now.getTime()));
  const hi = new Date(Math.min(windowEnd.getTime(), v.exp ? v.exp.getTime() : windowEnd.getTime()));
  const whole = [{ start: lo, end: hi }];
  const d = dLine(UP(n));
  if (!d) return { inWindow: true, kind: (v.eff && v.eff > now) ? 'starts-in-window' : 'continuous', intervals: whole };
  const sch = parseSchedule(d);
  if (sch.unparsed) return { inWindow: true, kind: 'scheduled-unparsed', intervals: whole };
  const out = [];
  for (let off = -1; off <= 1; off++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + off));
    // "OCT 07-31 WED THU FRI SAT": the date range AND the weekdays must both fit (a date list alone, or weekdays alone, is enough on its own)
    const dayOk = sch.daily || ((!sch.days.length || sch.days.includes(base.getUTCDate())) && (!sch.wd.size || sch.wd.has(base.getUTCDay())));
    if (!dayOk) continue;
    for (const [a, b] of sch.ranges) {
      const st = new Date(base.getTime() + (+a.slice(0, 2) * 60 + +a.slice(2)) * 60000);
      let e = new Date(base.getTime() + (+b.slice(0, 2) * 60 + +b.slice(2)) * 60000);
      if (e <= st) e = new Date(e.getTime() + 86400000);
      out.push({ start: st, end: e });
    }
  }
  const hit = out
    .map(i => ({ start: new Date(Math.max(i.start.getTime(), lo.getTime())), end: new Date(Math.min(i.end.getTime(), hi.getTime())) }))
    .filter(i => i.end > i.start && i.end > now);
  if (!hit.length) return { inWindow: false, reason: 'schedule' };
  return { inWindow: true, kind: 'scheduled', activeNow: hit.some(i => i.start <= now && i.end > now), intervals: hit };
}

// ───────────────────────── runway helpers ─────────────────────────
function recip(des) {
  const m = /^(\d{2})([LRC]?)$/.exec(des);
  if (!m) return des;
  const n = parseInt(m[1], 10);
  const r = ((n + 18 - 1) % 36) + 1;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return String(r).padStart(2, '0') + side;
}
function rwyKey(des) {
  const a = des, b = recip(des);
  return [a, b].sort((x, y) => parseInt(x, 10) - parseInt(y, 10) || x.localeCompare(y)).join('/');
}
const D = '\\d{2}[LRC]?';
const RWY_GROUP = `${D}(?:\\s*/\\s*${D})?(?:\\s*(?:,|AND|&)\\s*(?:RWY\\s*)?${D}(?:\\s*/\\s*${D})?)*`;
const RWY_CLOSE_RX = new RegExp(
  `\\bRWY\\s*(${RWY_GROUP})\\s*(?:IS\\s+|ARE\\s+)?(?:CLSD|CLOSED|NOT\\s+AVBL|NOT\\s+AVAILABLE)\\b(?:\\s+TO\\s+(LANDING|LDG|TKOF|TAKE-?OFF|DEPARTURE|DEP\\b|ALL\\s+TFC|ALL\\s+TRAFFIC|TFC|TRAFFIC|OPS))?`, 'g');

function parseRunwayClosures(t) {
  const out = [];
  let m;
  RWY_CLOSE_RX.lastIndex = 0;
  while ((m = RWY_CLOSE_RX.exec(t))) {
    // "<equipment> RWY 24L ..." is an equipment outage on that runway, not a runway closure
    const pre0 = t.slice(Math.max(0, m.index - 40), m.index);
    // "ILS Y RWY 18L", "ILS Z CAT I RWY 32R": the procedure letter / category sits between the equipment word and RWY
    const pre = pre0.replace(/\s+(?:[XYZW]\b)?(?:\s*CAT\s*I{1,3}(?:\s*(?:\/|AND|&)\s*I{1,3})?)?\s*$/, ' ');
    if (/(LGT|LIGHTS?|LIGHTING|PAPI|VASI|ILS|LOC|LOCALI[SZ]ER|GP|GS|RVR|SFL|ALS|APCH|APPROACH|IAPS?|VOR|DME|NDB|RNP|RNAV|GLS|PROC(?:EDURE)?|MARKINGS?|SIGNS?|EDGE|CENTRE\s*LINE|CENTERLINE|TDZ|THR|BARRIER)\s*$/.test(pre)) continue;
    // "... CRANE WILL ONLY OPR WHEN RWY 09L/27R IS CLSD" describes a condition, it does not announce a closure
    if (/\b(?:WHEN|IF|WHILE|DURING|UNLESS)\s*$/.test(pre)) continue;
    const keys = [...new Set([...m[1].matchAll(/\d{2}[LRC]?/g)].map(x => rwyKey(x[0])))];
    const to = (m[2] || '').toUpperCase();
    const mode = /LANDING|LDG/.test(to) ? 'landing' : /TKOF|TAKE|DEP/.test(to) ? 'takeoff' : 'full';
    // "RWY 36 NOT AVBL FOR LDG BY ACFT WITH CAT D/E/F" is a restriction for some aircraft, not a closure
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 160).split('.')[0];
    // "RWY 13R/31L CLSD BTN TWY K AND TWY KK", "PART OF RWY ... CLSD": only a section is closed, the runway stays usable
    const partial = /^\s*(?:BTN|BTWN|BETWEEN|FM|FROM)\b/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 12)) || /\b(?:PART|PORTION|SECTION|HALF)\s+OF\s*$/.test(pre0);
    const restricted = partial || /\b(?:FOR|BY)\s+(?:ALL\s+)?(?:ACFT|AIRCRAFT)\b|\bWITH\s+(?:CAT|CODE)\b|\bWINGSPAN\b|\bEXC(?:EPT|LUDING)?\b|\b(?:CAT|CODE)\s+[A-F]\b|\b(?:HEAVY|WIDE-?\s?BODY|MTOW)\b|\bONLY\s+(?:FOR|TO)\b/.test(after);
    keys.forEach(k => out.push({ key: k, mode, restricted }));
  }
  return out;
}
function runwaysMentioned(notams) {
  const set = new Set();
  for (const n of notams) {
    for (const m of UP(n).matchAll(new RegExp(`\\bRWY\\s*(${D}(?:\\s*/\\s*${D})?)`, 'g'))) {
      for (const d of m[1].matchAll(/\d{2}[LRC]?/g)) set.add(rwyKey(d[0]));
    }
  }
  return set;
}

// ───────────────────────── fact extraction ─────────────────────────
// Returns the primary fact of a NOTAM (or null). `scope` = 'AD' (aerodrome NOTAM) or 'FIR'.
function extractFact(n, scope) {
  const t = eText(n);
  const q = parseQ(n) || {};
  const GNSS = /\b(GNSS|GPS|GLONASS|GALILEO|BEIDOU)\b/;

  // GNSS (aerodrome or FIR level)
  if (GNSS.test(t)) {
    if (/JAMM|SPOOF|INTERFER|UNRELIABLE|DISRUPT|INTERRUPT/.test(t)) return { type: 'GNSS_INTERFERENCE' };
    if (/RAIM|OUTAGE|DEGRAD|PREDICT/.test(t)) return { type: 'GNSS_OUTAGE' };
  }

  if (scope === 'FIR') {
    // FIR-wide closure: "THE USE OF AIRSPACE OF UKRAINE ... IS PROHIBITED FOR ALL AIRCRAFT" (Q-code QAF.., radius 999 = whole FIR)
    if (/\bAIRSPACE\b[\s\S]{0,300}?\b(?:PROHIBITED|CLSD|CLOSED)\s+(?:FOR|TO)\s+ALL\s+(?:AIRCRAFT|ACFT|FLIGHTS?|TFC|TRAFFIC|CIVIL)/.test(t) && /999$/.test(q.geo || ''))
      return { type: 'AIRSPACE_CLOSED', firs: ((rawOf(n).match(/\bA\)\s*([A-Z0-9 ]+?)\s+B\)/i) || [])[1] || '').toUpperCase().split(/\s+/).filter(x => /^[A-Z]{4}$/.test(x)) };
    if (/\b(PROHIBITED|RESTRICTED|DANGER|TEMPORARY\s+RESTRICTED)\s+(AREA|ZONE|AIRSPACE)\b|\b(MILITARY\s+(EXERCISE|ACTIVITY|OPS)|LIVE\s+FIRING|MISSILE|ROCKET|LASER)\b/.test(t) ||
        ['RP', 'RR', 'RD', 'RT', 'WE', 'WM', 'WL'].includes(q.subj)) return { type: 'AIRSPACE' };
    if (out(t, /\b(?:VOR|DME|NDB|TACAN|VORTAC|DVOR)\b/)) return { type: 'NAVAID_ENROUTE' };
    return null;
  }

  // aerodrome closed (no runway/taxiway/apron wording)
  if ((/\b(AD|AERODROME|AIRPORT|ARPT)\b\s*(?:IS\s*)?(CLSD|CLOSED)\b/.test(t) && !/\b(RWY|TWY|APRON|STAND)\b/.test(t)) || q.code === 'QFALC')
    return { type: 'AD_CLOSED' };

  // "INSTR APCH PROC (VOR AND RNP) RWY 17/35 SUSPENDED", "IAP VOR RWY 07L NOT AVBL", "INSTRUMENT APPROACH PROCEDURE NOT AUTHORIZED ILS OR LOC RWY 13":
  // an approach procedure is unavailable — never a runway closure
  // "[US DOD PROCEDURAL NOTAM] ... AS PUBLISHED IN DOD FLIP" / "[US DOD E-IPL ONLY]" applies to US military procedures, not to civil airline operations
  if (!/\bUS\s+DOD\b|\bDOD\s+FLIP\b/.test(t) &&
      /\b(?:IAPS?|INSTR(?:UMENT)?\s+APCH(?:\s+PROC\w*)?|INSTRUMENT\s+APPROACH(?:\s+PROCEDURES?)?)\b/.test(t) &&
      /\b(?:SUSPENDED|NOT\s+AUTHORI[SZ]ED|NOT\s+AVBL|NOT\s+AVAILABLE|CANCELLED|WITHDRAWN|U\/S|UNSERVICEABLE)\b/.test(t) && !/\b(?:AMEND\w*|CHG|CHANGE\w*|REVISED)\b/.test(t)) {
    const kinds = [];
    if (/\b(?:ILS|LOC|LOCALI[SZ]ER)\b/.test(t)) kinds.push('ILS/LOC');
    if (/\bVOR\b/.test(t)) kinds.push('VOR');
    if (/\bNDB\b/.test(t)) kinds.push('NDB');
    if (/\b(?:RNP|RNAV|LPV|GLS)\b/.test(t)) kinds.push('RNP/RNAV');
    return { type: 'APPROACH_OUT', kinds, all: /\bALL\s+(?:INSTR(?:UMENT)?\s+)?(?:APCH|APPROACH\w*|IAPS?)\b/.test(t) };
  }

  const rc = parseRunwayClosures(t);
  const fullCl = rc.filter(c => !c.restricted), partCl = rc.filter(c => c.restricted);
  if (fullCl.length) return { type: 'RWY_CLOSURE', closures: fullCl };
  if (partCl.length) return { type: 'RWY_RESTRICTION', closures: partCl };

  if (out(t, /\bLLWAS\b|LOW[- ]LEVEL\s+WIND\s*SHEAR/))
    return { type: 'LLWAS', comp: /LIDAR|LASER/.test(t) ? 'lidar' : /RADAR/.test(t) ? 'radar' : 'full' };
  if (out(t, /\b(?:LIDAR|RADAR)\s+COMPONENT\b/))
    return { type: 'LLWAS', comp: /LIDAR|LASER/.test(t) ? 'lidar' : 'radar' };

  if (out(t, /\bCAT\s*(?:II|III|2|3)\b/)) return { type: 'CAT23' };
  if (out(t, /\b(?:ILS|LOC|LOCALI[SZ]ER|GP|GS|GLIDE\s*(?:PATH|SLOPE)|GLIDEPATH)\b/)) return { type: 'ILS' };
  if (out(t, /\bRVR\b/)) return { type: 'RVR' };

  if (/\b(LNAV|VNAV|OCA|OCH|MDA|DA\(H\)|MINIMA|MINIMUM|MINIMUMS)\b/.test(t) && /\b(RAIS\w*|INCREAS\w*|AMEND\w*|REVISED|HIGHER|AFFECT\w*)\b/.test(t))
    return { type: 'MINIMA' };

  const lightWord = /\b(SEQUENCED\s+FLASHING|SFL|APCH\s+LGT|APPROACH\s+LIGHT(?:ING)?|ALS|PAPI|VASI|HIALS|MALS|RWY\s+(?:EDGE|CENTRE\s*LINE|CENTERLINE|TDZ|THR|END)\s+LGT|RWY\s+LGT)\b/;
  if (out(t, lightWord)) return { type: 'LIGHTING' };

  if (out(t, /\b(?:VOR|DME|NDB|TACAN|VORTAC|DVOR)\b/) && !/\bILS\b/.test(t)) return { type: 'NAVAID' };

  if (/\b(?:ATC|ATS|AERODROME\s+CONTROL|TWR)(?:\s+(?:SERVICES?|FREQ\w*|OPS|OPERATIONS|UNIT))?\s+(?:IS\s+|ARE\s+)?(?:NOT\s+AVBL|U\/S|UNSERVICEABLE|CLSD|CLOSED|SUSPENDED)\b/.test(t)) return { type: 'ATC_OUT' };
  if (/\b(RFFS|FIRE\s*FIGHTING|FIREFIGHTING|FIRE\s+CAT(?:EGORY)?)\b/.test(t) && /(REDUC|DOWNGRAD|LOWER|CAT\s*\d)/.test(t)) return { type: 'RFFS' };

  if (/\b(PROHIBITED|RESTRICTED|DANGER)\s+(AREA|ZONE|AIRSPACE)\b/.test(t) || ['RP', 'RR', 'RD', 'RT'].includes(q.subj)) return { type: 'AIRSPACE' };

  if ((/\bTWY\b/.test(t) && (/\b(CLSD|CLOSED)\b/.test(t) || US.test(t))) ||
      (/\b(APRON|STAND|STANDS|PARKING)\b/.test(t) && (/\b(CLSD|CLOSED)\b/.test(t) || US.test(t))) ||
      (/\bTWY\b/.test(t) && out(t, /\b(?:LGT|LIGHTS?)\b/))) return { type: 'GROUND' };

  if (/\b(CRANE|CRANES|OBST|OBSTACLE|MAST|CHIMNEY|WIND\s+TURBINE|TOWER\s+CRANE)\b/.test(t) || q.subj === 'OB') return { type: 'OBSTACLE' };

  if (out(t, /\b(?:BARRIER|NET|ARRESTING|ARRESTOR|ATIS|FOLLOW[- ]ME)\b/)) return { type: 'EQUIP_MINOR' };

  return null;
}

// ───────────────────────── weather (METAR + TAF) ─────────────────────────
function scanWx(toks) {
  let vis = null, ceil = null, ts = false, fz = false, gust = 0, wind = 0, m;
  toks.forEach((tk, i) => {
    if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(tk))) { wind = Math.max(wind, +m[2]); gust = Math.max(gust, m[3] ? +m[3] : 0); }
    else if (tk === 'CAVOK') { if (vis === null) vis = 10000; }
    else if (/^\d{4}$/.test(tk) && vis === null) vis = +tk;
    else if ((m = /^(\d+(?:\/\d)?)SM$/.exec(tk))) { const [x, y] = m[1].split('/'); vis = Math.round((y ? +x / +y : +x) * 1609); }
    else if ((m = /^(BKN|OVC|VV)(\d{3})/.exec(tk))) { const h = +m[2] * 100; if (ceil === null || h < ceil) ceil = h; }
    else if (/^[-+]?(VC)?TS/.test(tk)) ts = true;
    else if (/^[-+]?FZ(RA|DZ|FG)$/.test(tk)) fz = true;
  });
  return { vis, ceil, ts, fz, gust, wind };
}
function classifyWx(sc, cfg) {
  const severe = [];
  if (sc.vis !== null && sc.vis < cfg.lifrVisM) severe.push(`VIS ${sc.vis} m`);
  if (sc.ceil !== null && sc.ceil < cfg.lifrCeilFt) severe.push(`CIG ${sc.ceil} ft`);
  if (sc.ts) severe.push('thunderstorm');
  if (sc.fz) severe.push('freezing precipitation/fog');
  const w = Math.max(sc.gust, sc.wind);
  if (w >= cfg.gustKt) severe.push(`wind ${w} kt`);
  if (severe.length) return { tier: 2, reasons: severe, severe: true };
  const mild = [];
  if (sc.vis !== null && sc.vis < cfg.ifrVisM) mild.push(`VIS ${sc.vis} m`);
  if (sc.ceil !== null && sc.ceil < cfg.ifrCeilFt) mild.push(`CIG ${sc.ceil} ft`);
  return mild.length ? { tier: 3, reasons: mild, severe: false } : null;
}
function assessWeather(metar, cfg) {
  if (!metar) return null;
  const c = classifyWx(scanWx(String(metar).toUpperCase().split(/\s+/)), cfg);
  if (!c) return null;
  return c.severe ? { tier: 2, label: 'adverse weather (' + c.reasons.join(', ') + ')' } : { tier: 3, label: 'IFR conditions (' + c.reasons.join(', ') + ')' };
}
// TAF: every change group is evaluated. PROB30/40 events are watch items (Tier 3) even when severe.
function assessTaf(taf, cfg) {
  if (!taf) return null;
  const toks = String(taf).toUpperCase().split(/\s+/);
  const groups = []; let cur = { type: 'MAIN', toks: [] };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'TEMPO' || t === 'BECMG') { groups.push(cur); cur = { type: t, toks: [] }; }
    else if (/^FM\d{6}$/.test(t)) { groups.push(cur); cur = { type: 'FM', toks: [] }; }
    else if (/^PROB(30|40)$/.test(t)) { groups.push(cur); cur = { type: t, toks: [] }; if (toks[i + 1] === 'TEMPO') i++; }
    else cur.toks.push(t);
  }
  groups.push(cur);
  let best = null;
  for (const g of groups) {
    const c = classifyWx(scanWx(g.toks), cfg);
    if (!c) continue;
    const prob = /^PROB/.test(g.type);
    const tier = prob ? 3 : c.tier;
    const win = (g.toks.find(x => /^\d{4}\/\d{4}$/.test(x)) || '');
    const cand = { tier, label: `forecast ${g.type}${win ? ' ' + win + 'Z' : ''}: ${c.reasons.join(', ')}` };
    if (!best || cand.tier < best.tier) best = cand;
  }
  return best;
}

// Wording that signals a hazard the rubric has no factor for -> handed to the model as a WATCHLIST item.
const WATCH_RX = /\b(VOLCAN\w*|ASH|RADIOACTIV\w*|NUCLEAR|CHEMICAL|BIOLOGICAL|EMERGENCY|EVACUAT\w*|SECURITY|THREAT|BOMB|HIJACK\w*|WAR|CONFLICT|HOSTIL\w*|MISSILE|ROCKET|LASER|DRONE|UAS|BIRDS?|BIRDSTRIKE|WILDLIFE|DEBRIS|FOD|CONTAMINAT\w*|FLOOD\w*|SNOW|ICE|ICING|SLUSH|BRAKING\s+ACTION|FRICTION|STRIKE|INDUSTRIAL\s+ACTION|FIRE|SMOKE|DISRUPT\w*|UNSAFE|HAZARD\w*|CAUTION|WARNING|SUSPENDED|IRREGULARIT\w*|POTHOLE\w*|RUTS?|CRACK\w*|BREAK-?UP|DAMAGED?|DEFECT\w*|STANDING\s+WATER|PONDING|PUDDLES?)\b/;
const WATCH_HIGH = /^(VOLCAN\w*|ASH|RADIOACTIV\w*|NUCLEAR|CHEMICAL|BIOLOGICAL|SECURITY|THREAT|BOMB|HIJACK\w*|WAR|CONFLICT|HOSTIL\w*|MISSILE|ROCKET|EVACUAT\w*|EMERGENCY)$/;
function watchReason(n) { const m = WATCH_RX.exec(eText(n)); return m ? m[1] : null; }

// ───────────────────────── aerodrome assessment ─────────────────────────
const idOf = n => n.notam_id || (rawOf(n).match(/[A-Z]\d{3,5}\/\d{2}/) || [''])[0];
const DOWN = t => (t === 1 ? 2 : t);


// Combine runway-count data sources into ONE answer.
//   sources    : [{ name: 'ourairports'|'awc'|..., count: <number of runways> }]  (any may be missing)
//   lowerBound : number of distinct runways referenced by the aerodrome's own NOTAMs (a sanity floor)
// Safety logic: OVER-estimating the runway count makes closures look milder (unsafe), so when sources
// disagree the SMALLER number is used and the result is marked untrusted -> the conservative rule applies.
function resolveRunwayCount(sources, lowerBound) {
  const srcs = (sources || []).filter(x => x && x.count > 0);
  const lb = lowerBound || 0;
  if (!srcs.length) return { count: lb || null, trusted: false, source: lb ? 'notam-min' : 'unknown', note: lb ? 'runway count unverified (lower bound from NOTAMs)' : 'runway count unknown' };
  const counts = srcs.map(x => x.count);
  const min = Math.min(...counts), max = Math.max(...counts);
  const names = srcs.map(x => `${x.name} ${x.count}`).join(', ');
  if (min !== max) {
    if (srcs.length === 2 && srcs[0].keys && srcs[1].keys) {
      const base = k => k.replace(/[LRC]/g, '');
      const bs = srcs.map(x => new Set(x.keys.map(base)));
      const same = bs[0].size === bs[1].size && [...bs[0]].every(k => bs[1].has(k));
      if (same) {
        const big = srcs[0].count >= srcs[1].count ? srcs[0] : srcs[1];
        return { count: Math.max(big.count, lb), trusted: true, source: big.name, note: `${names}; sources agree on runway headings, ${big.name} lists the parallel runways separately` };
      }
    }
    let diff = '';
    if (srcs.length === 2 && srcs[0].keys && srcs[1].keys) {
      const a = new Set(srcs[0].keys), b = new Set(srcs[1].keys);
      const onlyA = [...a].filter(k => !b.has(k)), onlyB = [...b].filter(k => !a.has(k));
      if (onlyA.length) diff += `; only in ${srcs[0].name}: ${onlyA.join(', ')}`;
      if (onlyB.length) diff += `; only in ${srcs[1].name}: ${onlyB.join(', ')}`;
    }
    return { count: Math.max(min, lb), trusted: false, disputed: true, source: 'disputed', note: `runway count disputed (${names}${diff}) — using the smaller number` };
  }
  if (min < lb) return { count: lb, trusted: false, source: 'notam-min', note: `data sources report ${min} runway(s) but NOTAMs reference ${lb}` };
  return { count: min, trusted: true, source: srcs.map(x => x.name).join('+'), note: names };
}

function runwayTier(closedLanding, closedTakeoff, info, cfg) {
  const closed = Math.max(closedLanding.size, closedTakeoff.size);
  if (!closed) return null;
  const frac = (cfg && cfg.runwayClosedFractionT1) || 1.01;

  // Roles known (expert data): main runways matter most, backup runways add surge capacity.
  if (info && info.main && info.backup) {
    const N = info.count, M = info.main.size;
    const one = S => {
      const cb = [...S].filter(k => info.backup.has(k)).length;       // closed backup runways
      const cm = S.size - cb;                                         // closed main (unknown designators count as main)
      const remTotal = N - S.size, remMain = Math.max(0, M - cm);
      if (!S.size) return null;
      if (remTotal <= 0) return { tier: 1, override: true, remaining: 0, note: `no usable runway remains (all ${N} closed)` };
      if (remMain <= 0) return { tier: 1, override: false, remaining: remTotal, note: `all ${M} main runways closed, only ${remTotal} backup runway(s) remain` };
      if ((remTotal === 1 && N >= 2) || cm / M >= frac)
        return { tier: 1, override: false, remaining: remTotal, note: `${cm} of ${M} main runways closed (${remMain} main + ${remTotal - remMain} backup remain)` };
      if (cm >= 1) return { tier: 2, override: false, remaining: remTotal, note: `${cm} of ${M} main runways closed (${remMain} main + ${remTotal - remMain} backup remain)` };
      return { tier: 3, override: false, remaining: remTotal, note: `${cb} backup runway(s) closed (all main runways open)` };
    };
    const a = one(closedLanding), b = one(closedTakeoff);
    if (!a) return b; if (!b) return a;
    return MORE_SEVERE(a, b) ? a : b;
  }

  if (info && info.count >= 1 && (info.trusted || info.disputed)) {
    const N = info.count, remaining = N - closed;
    const tag = info.disputed ? ` (${info.note})` : '';
    if (remaining <= 0) {
      return info.trusted
        ? { tier: 1, override: true, remaining: 0, note: `no usable runway remains (${closed} of ${N} closed)` }
        : { tier: 1, override: false, remaining: 0, note: `possibly no usable runway (${closed} closed, count ${N})${tag}` };
    }
    if ((remaining === 1 && N >= 2) || closed / N >= frac)
      return { tier: 1, override: false, remaining, note: `${closed} of ${N} runways closed, ${remaining} remain${tag}` };
    return { tier: 2, override: false, remaining, note: `${closed} of ${N} runways closed, ${remaining} remain${tag}` };
  }
  return closed >= 2
    ? { tier: 1, override: false, remaining: null, note: `${closed} runways closed (runway count unverified — conservative rule)` }
    : { tier: 2, override: false, remaining: null, note: '1 runway closed (runway count unverified)' };
}

function MORE_SEVERE(x, y) { return !y || (x.override && !y.override) || (!!x.override === !!y.override && (x.tier < y.tier || (x.tier === y.tier && x.remaining != null && y.remaining != null && x.remaining < y.remaining))); }

// Sweeps the look-ahead window: only closures that are in force AT THE SAME TIME count together.
// An "aerodrome closed" override (NO-GO) is raised only when the closure is certain and in force NOW;
// closures that start later or have an unreadable schedule are Tier 1 with their timing named, never a NO-GO.
const fmtZ = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
function evaluateRunways(rwRows, info, cfg, now) {
  const windowEnd = new Date(now.getTime() + cfg.windowHours * 3600e3);
  const closures = [];
  for (const r of rwRows) {
    const continuous = r.win.kind === 'continuous' || r.win.kind === 'starts-in-window';
    const certain = continuous || r.win.kind === 'scheduled';
    // real length of the closure in hours: the whole NOTAM span if it is continuous, the length of each scheduled period otherwise
    const v = validity(r.n);
    const spanH = continuous ? ((v.perm || !v.exp) ? Infinity : (v.exp.getTime() - Math.max(v.eff ? v.eff.getTime() : now.getTime(), now.getTime())) / 3600e3) : null;
    for (const c of r.fact.closures) closures.push({ key: c.key, mode: c.mode, continuous, certain, spanH, intervals: r.win.intervals || [{ start: now, end: windowEnd }] });
  }
  const pts = new Set([now.getTime(), windowEnd.getTime()]);
  closures.forEach(c => c.intervals.forEach(i => { pts.add(i.start.getTime()); pts.add(i.end.getTime()); }));
  const t = [...pts].filter(x => x >= now.getTime() && x <= windowEnd.getTime()).sort((p, q) => p - q);
  const setsOf = list => {
    const l = new Set(), tk = new Set();
    list.forEach(c => { if (c.mode === 'full' || c.mode === 'landing') l.add(c.key); if (c.mode === 'full' || c.mode === 'takeoff') tk.add(c.key); });
    return [l, tk];
  };
  let worst = null;
  for (let i = 0; i < t.length - 1; i++) {
    const mid = (t[i] + t[i + 1]) / 2;
    const act = closures.filter(c => c.intervals.some(iv => iv.start.getTime() <= mid && mid < iv.end.getTime()));
    if (!act.length) continue;
    let all = runwayTier(...setsOf(act), info, cfg);
    if (!all) continue;
    all = Object.assign({}, all, { wasOverride: !!all.override });
    if (all.override && !(t[i] === now.getTime() && act.every(c => c.certain))) {
      all.override = false;
      all.note = all.note.replace('no usable runway remains', 'no usable runway during the closure period');
    }
    if (act.some(c => !c.continuous) && !(t[i] <= now.getTime() && t[i + 1] >= windowEnd.getTime()))
      all.note += ` — in force ${fmtZ(new Date(t[i]))}–${fmtZ(new Date(t[i + 1]))}`;
    // a closure that lasts only a few hours (night works, short maintenance) is one tier lighter; never an override
    const lenH = c => c.continuous ? c.spanH : Math.max(...c.intervals.filter(iv => iv.start.getTime() <= mid && mid < iv.end.getTime()).map(iv => (iv.end.getTime() - iv.start.getTime()) / 3600e3), 0);
    if (all.tier === 1 && !all.wasOverride && cfg.shortClosureHours && act.every(c => lenH(c) <= cfg.shortClosureHours))
      all = Object.assign({}, all, { tier: 2, note: all.note + ' (short closure)' });
    const base = runwayTier(...setsOf(act.filter(c => c.continuous)), info, cfg);
    let eff = all;
    if (cfg.scheduledDowngrade && act.some(c => !c.continuous) && (!base || MORE_SEVERE(all, base))) {
      const down = Object.assign({}, all, { tier: all.wasOverride ? 1 : DOWN(all.tier), override: false, note: all.note + ' (lighter: scheduled)' });
      eff = (base && !MORE_SEVERE(down, base)) ? base : down;
    }
    if (MORE_SEVERE(eff, worst)) worst = eff;
  }
  return worst;
}

function assessAirport(a, now, cfg) {
  const factors = [];
  const severityById = new Map();
  const all = (a.notams || []).filter(n => !isAdminNotam(n));
  const rows = all.map(n => ({ n, id: idOf(n), win: windowStatus(n, now, cfg), fact: extractFact(n, 'AD') }));
  const live = rows.filter(r => r.win.inWindow && r.fact);

  // runway info: override > trusted data > NOTAM lower bound (untrusted)
  const mentioned = runwaysMentioned(all).size;
  const ov = cfg.runwayCountOverrides[a.icao];
  const roles = (cfg.runwayRoles || {})[a.icao];
  let info;
  if (roles) {
    const norm = list => new Set(list.map(x => rwyKey(x.split('/')[0])));
    const main = norm(roles.main), backup = norm(roles.backup);
    info = { count: main.size + backup.size, trusted: true, source: 'expert', main, backup, note: `${main.size} main + ${backup.size} backup` };
  } else if (ov) info = { count: ov, trusted: true, source: 'override' };
  else if (a.runwayInfo) { info = Object.assign({}, a.runwayInfo); if (info.trusted) info.count = Math.max(info.count, mentioned); }
  else info = resolveRunwayCount(a.runwaySources, mentioned);

  const add = (key, tier, label, ids, extra) => { factors.push(Object.assign({ key: `${a.icao}:${key}`, tier, scope: a.icao, label: `${a.icao}: ${label}`, ids }, extra || {})); };
  const ids = type => live.filter(r => r.fact.type === type).map(r => r.id);

  // aerodrome closed
  let override = false;
  const adc = live.filter(r => r.fact.type === 'AD_CLOSED' && r.win.kind !== 'scheduled' && r.win.kind !== 'scheduled-unparsed');
  if (adc.length) {
    // a closure with only a few hours left (precautionary closure, night closure) is Tier 1 but not a NO-GO override
    const remH = r => { const v = validity(r.n); return (v.perm || !v.exp) ? Infinity : (v.exp.getTime() - Math.max(v.eff ? v.eff.getTime() : now.getTime(), now.getTime())) / 3600e3; };
    const shortOnly = !!cfg.shortClosureHours && adc.every(r => remH(r) <= cfg.shortClosureHours);
    const until = shortOnly ? new Date(Math.max(...adc.map(r => validity(r.n).exp.getTime()))) : null;
    if (!shortOnly) override = true;
    add('AD_CLOSED', 1, shortOnly ? `aerodrome closed until ${fmtZ(until)} (short closure)` : 'aerodrome closed', adc.map(r => r.id), { override: !shortOnly });
  }

  // instrument approach procedures suspended / not authorised: all of them (3+ kinds) is Tier 1, otherwise Tier 2
  const apRows = live.filter(r => r.fact.type === 'APPROACH_OUT');
  if (apRows.length) {
    const kinds = [...new Set(apRows.flatMap(r => r.fact.kinds))];
    const allOut = apRows.some(r => r.fact.all) || kinds.length >= 3;
    const what = kinds.length ? kinds.join(', ') : 'unspecified';
    if (allOut) {
      // with no instrument approach left, an IFR flight can only be released if visual conditions are known: no weather data or IFR weather = NO-GO
      const vmcKnown = !!(a.metar || a.taf) && !assessWeather(a.metar, cfg.weather) && !assessTaf(a.taf, cfg.weather);
      if (!vmcKnown) override = true;
      add('APCH_ALL', 1, `instrument approach procedures suspended/not authorised (${what})${vmcKnown ? '' : ' — no visual conditions confirmed'}`, apRows.map(r => r.id), { override: !vmcKnown });
    }
    else if (kinds.includes('ILS/LOC')) add('APCH_ILS_NA', 2, `ILS/LOC approach procedure suspended/not authorised (${what})`, apRows.map(r => r.id));
    else add('APCH_NA', 2, `approach procedure suspended/not authorised (${what})`, apRows.map(r => r.id));
  }

  // runways (dynamic rule, evaluated over time)
  const rwRows = live.filter(r => r.fact.type === 'RWY_CLOSURE');
  if (rwRows.length) {
    const pick = evaluateRunways(rwRows, info, cfg, now);
    if (pick) {
      if (pick.override) override = true;
      add('RWY', pick.tier, pick.note, rwRows.map(r => r.id), { override: !!pick.override, runwayTier: pick.tier });
    }
  }

  // runway restricted for some aircraft only (category / wingspan limits) — not a closure
  const rrRows = live.filter(r => r.fact.type === 'RWY_RESTRICTION');
  if (rrRows.length) {
    const rkeys = [...new Set(rrRows.flatMap(r => r.fact.closures.map(c => c.key)))];
    const onlyBackup = !!(info && info.backup && rkeys.every(k => info.backup.has(k)));
    add('RWY_RESTRICTION', onlyBackup ? 3 : 2, `runway ${rkeys.join(', ')} restricted for some aircraft (category/size limits)`, rrRows.map(r => r.id));
  }

  // LLWAS
  const ll = live.filter(r => r.fact.type === 'LLWAS');
  if (ll.length) {
    const comps = new Set(ll.map(r => r.fact.comp));
    const fullOut = comps.has('full') || (comps.has('radar') && comps.has('lidar'));
    add('LLWAS', 2, fullOut ? 'low-level windshear alerting (LLWAS) fully unserviceable' : 'LLWAS partially unserviceable (' + [...comps].join('/') + ')', ids('LLWAS'));
  }
  const simple = [
    ['GNSS_INTERFERENCE', 1, 'GNSS interference/jamming reported'],
    ['ATC_OUT', 1, 'ATC services unavailable'],
    ['ILS', 2, 'ILS/LOC/glide path unserviceable'],
    ['CAT23', 2, 'ILS CAT II/III not available'],
    ['RVR', 2, 'RVR sensor unserviceable'],
    ['LIGHTING', 2, 'runway/approach lighting unserviceable'],
    ['MINIMA', 2, 'raised/amended minima in force'],
    ['NAVAID', 2, 'navaid unserviceable'],
    ['RFFS', 2, 'rescue/firefighting category reduced'],
    ['AIRSPACE', 2, 'airspace restriction near the aerodrome'],
    ['GROUND', 3, 'taxiway/apron closures or ground-lighting outages'],
    ['OBSTACLE', 3, 'obstacle/crane'],
    ['EQUIP_MINOR', 3, 'minor equipment outage'],
  ];
  simple.forEach(([type, tier, label]) => { const i = ids(type); if (i.length) add(type, tier, label + (i.length > 1 ? ` (${i.length} NOTAMs)` : ''), i); });

  // weather: current (METAR) and forecast (TAF) — the more severe one sets the tier, both are named
  const wxs = [assessWeather(a.metar, cfg.weather) && Object.assign({}, assessWeather(a.metar, cfg.weather), { label: 'current ' + assessWeather(a.metar, cfg.weather).label }), assessTaf(a.taf, cfg.weather)].filter(Boolean);
  if (wxs.length) {
    // low visibility/ceiling NOW that the prevailing forecast does not improve (MAIN/FM/BECMG, not TEMPO/PROB) is Tier 1: alternate and fuel decisions
    const cur = wxs.find(x => /^current/.test(x.label) && x.tier === 2 && /VIS|CIG/.test(x.label));
    const fc = wxs.find(x => /^forecast (?:MAIN|FM|BECMG)\b/.test(x.label) && x.tier === 2 && /VIS|CIG/.test(x.label));
    add('WX', cur && fc ? 1 : Math.min(...wxs.map(x => x.tier)), wxs.map(x => x.label).join('; ') + (cur && fc ? ' — persists in the prevailing forecast' : ''), []);
  }

  // display severity per NOTAM (drives card format/order); out-of-window items are shown compactly
  const rwFactor = factors.find(f => f.key.endsWith(':RWY'));
  for (const r of rows) {
    let sev = 'LOW';
    if (r.fact) {
      const t = r.fact.type;
      if (t === 'AD_CLOSED' || t === 'ATC_OUT' || t === 'GNSS_INTERFERENCE') sev = 'CRITICAL';
      else if (t === 'RWY_CLOSURE') sev = rwFactor && rwFactor.tier === 1 ? 'CRITICAL' : 'HIGH';
      else if (t === 'RWY_RESTRICTION') sev = (factors.find(f => f.key.endsWith(':RWY_RESTRICTION')) || {}).tier === 3 ? 'MEDIUM' : 'HIGH';
      else if (t === 'LLWAS') sev = 'HIGH';
      else if (['ILS', 'CAT23', 'RVR', 'LIGHTING', 'MINIMA', 'NAVAID', 'RFFS', 'AIRSPACE', 'GNSS_OUTAGE', 'APPROACH_OUT'].includes(t)) sev = 'HIGH';
      else sev = 'MEDIUM';
      if (!r.win.inWindow && sev !== 'LOW') sev = 'MEDIUM';
    }
    severityById.set(r.id, sev);
  }
  const rowsOut = rows.map(r => ({
    id: r.id, type: r.fact ? r.fact.type : null, sev: severityById.get(r.id), inWindow: r.win.inWindow,
    upcoming: (() => { const v = validity(r.n); return !!(v.eff && v.eff > now); })(),
    text: eText(r.n), watch: (!r.fact && r.win.inWindow) ? watchReason(r.n) : null,
  }));
  return { factors, override, info, severityById, rows: rowsOut };
}

// ───────────────────────── level / score ─────────────────────────
// Weight of one Tier 2 factor in the score: 1 unless the config lowers it (light items) or raises it (LLWAS fully out).
function factorWeight(f, cfg) {
  if (!f || f.tier !== 2) return 0;
  const c = cfg || CONFIG, W = c.t2Weights || {};
  const type = String(f.key || '').split(':').slice(1).join(':') || '';
  const k = f.scope === 'ROUTE' ? 'ROUTE:' + type : type;
  if (type === 'WX' && /thunderstorm/i.test(f.label || '') && !/VIS|CIG|current/.test(f.label || '')) return c.thunderstormForecastWeight != null ? c.thunderstormForecastWeight : 1;
  if (f.scope === 'ROUTE') return W[k] != null ? W[k] : 1;
  return W[type] != null ? W[type] : 1;
}

// t2 is the WEIGHTED sum of Tier 2 factors (a plain count when every weight is 1).
function levelFromCounts(t1, t2, t3, flags) {
  if (flags.override) return { level: 'CRITICAL', score: 10 };
  if (t1 >= 3 || flags.concentration) return { level: 'CRITICAL', score: 9 };   // 10 is reserved for an aerodrome that is closed (override)
  if (t1 >= 2) return { level: 'HIGH', score: t2 >= 2.5 ? 8 : 7 };
  if (t1 === 1) return { level: 'HIGH', score: 6 + (t2 >= 2.5 ? 1 : 0) + (t2 >= 5 ? 1 : 0) };
  if (t2 >= 6.5) return { level: 'HIGH', score: t2 >= 8 ? 7 : 6 };
  if (t2 >= 0.5 || t3 >= 3) return { level: 'MEDIUM', score: t2 >= 4.5 ? 5 : t2 >= 2.5 ? 4 : 3 };
  return { level: 'LOW', score: t3 >= 2 ? 2 : t3 === 1 ? 1 : 0 };
}

const CLASS_OF = { LOW: 'low', MEDIUM: 'med', HIGH: 'high', CRITICAL: 'crit' };
const LABEL_OF = { LOW: '🟢 LOW', MEDIUM: '🟡 MEDIUM', HIGH: '🟠 HIGH', CRITICAL: '🔴 CRITICAL' };

// Conflict zones (static list in CONFIG.conflictZones). Departure / arrival aerodromes are matched by ICAO prefix; the route by the FIR codes
// it crosses (fed by the en-route data, and by input.routeFirs when the route's FIR list is known).
function assessConflictZones(input, cfg, now, coveredFirs) {
  const zones = cfg.conflictZones || [];
  if (!zones.length) return [];
  const icaos = (input.airports || []).map(a => String(a.icao || '').toUpperCase());
  // Crossing is judged ONLY from input.routeFirs (the FIRs the great-circle route really passes through). The en-route NOTAM FIR list is a
  // generous candidate list (it includes FIRs that may be flown around), so it is NOT used for the NO-GO / caution crossing check.
  const firs = new Set((input.routeFirs || []).map(x => String(x || '').toUpperCase()));
  const nearFirs = new Set((input.routeNearFirs || []).map(x => String(x || '').toUpperCase()));
  const hits = [];
  for (const z of zones) {
    const atEnd = icaos.some(ic => (z.prefixes || []).some(p => ic.startsWith(p)));
    const crosses = (z.firs || []).some(f => firs.has(f));
    const near = !crosses && (z.firs || []).some(f => nearFirs.has(f));
    if (!atEnd && !crosses && !near) continue;
    // Aerodrome inside the zone: the endpoint rule applies. A route that only crosses the zone on the great-circle track normally flies around it,
    // so a NO-GO/HIGH zone becomes a "re-route needed" note (Tier 2) rather than a block; a zone only within the corridor is information.
    let lv = atEnd ? z.endpoint : (crosses ? z.crossing : (near ? 'INFO' : null));
    if (!lv) continue;
    if (!atEnd && crosses && (lv === 'NOGO' || lv === 'HIGH')) lv = 'REROUTE';
    const covered = lv === 'REROUTE' && (z.firs || []).some(f => coveredFirs && coveredFirs.has(f));   // already raised by an airspace-closed NOTAM
    const overdue = z.until && new Date(z.until + 'T23:59:59Z') < now;
    hits.push({ z, lv, atEnd, covered, overdue });
  }
  const txt = h => `${h.z.name}${h.atEnd ? ' (departure/arrival aerodrome inside)' : ''} — ${h.z.src}: ${h.z.rec}${h.overdue ? ' [list entry past its review date — verify]' : (h.z.until ? ' (valid to ' + h.z.until + ')' : '')}`;
  const out = [];
  const nogoEnd = hits.filter(h => h.lv === 'NOGO' && h.atEnd && !h.covered);
  if (nogoEnd.length) out.push({ key: 'ROUTE:CONFLICT_NOGO', tier: 1, scope: 'ROUTE', override: true, label: 'conflict zone: operations to/from this aerodrome are prohibited for operators subject to EASA/FAA rules — ' + nogoEnd.map(txt).join('; '), ids: [] });
  const high = hits.filter(h => h.lv === 'HIGH' && h.atEnd);
  if (high.length) out.push({ key: 'ROUTE:CONFLICT_HIGH', tier: 1, scope: 'ROUTE', label: 'conflict zone at the aerodrome — risk assessment required — ' + high.map(txt).join('; '), ids: [] });
  const rer = hits.filter(h => h.lv === 'REROUTE' && !h.covered);
  if (rer.length) out.push({ key: 'ROUTE:CONFLICT_REROUTE', tier: 2, scope: 'ROUTE', label: 'the great-circle track crosses a prohibited/high-risk zone — the route must be planned around it: ' + rer.map(txt).join('; '), ids: [] });
  const caution = hits.filter(h => h.lv === 'CAUTION');
  if (caution.length) out.push({ key: 'ROUTE:CONFLICT_CAUTION', tier: 2, scope: 'ROUTE', label: 'conflict zone — caution: ' + caution.map(txt).join('; '), ids: [] });
  const info = hits.filter(h => h.lv === 'INFO');
  if (info.length) out.push({ key: 'ROUTE:CONFLICT_INFO', tier: 2, scope: 'ROUTE', label: 'conflict zone — information note: ' + info.map(txt).join('; '), ids: [] });
  return out;
}

function assessRisk(input, userCfg) {
  const cfg = Object.assign({}, CONFIG, userCfg || {});
  const now = input.now || new Date();
  const airports = (input.airports || []).map(a => assessAirport(a, now, cfg));
  const factors = airports.flatMap(a => a.factors);
  const severityById = new Map();
  airports.forEach(a => a.severityById.forEach((v, k) => severityById.set(k, v)));

  // en-route (FIR) factors — aggregated so that one FIR with many NOTAMs cannot inflate the score
  const enIds = { AIRSPACE: [], NAVAID_ENROUTE: [], GNSS_OUTAGE: [] };
  const gnssFirs = [];
  const closedAir = [];   // FIR-wide closures / prohibitions
  const enrouteList = [], enrouteWatch = [], coverage = [];
  for (const f of (input.enroute || [])) {
    const gn = [];
    let total = 0, inWin = 0, rel = 0;
    for (const n of (f.notams || []).filter(n => !isAdminNotam(n))) {
      total++;
      if (!windowStatus(n, now, cfg).inWindow) continue;
      inWin++;
      const fact = extractFact(n, 'FIR');
      if (!fact) {
        const wr = watchReason(n);
        if (wr && routeRelevant(n, input.route, cfg)) enrouteWatch.push({ fir: f.fir, id: idOf(n), reason: wr, text: eText(n) });
        continue;
      }
      if (!routeRelevant(n, input.route, cfg)) continue;   // restriction nowhere near the planned route
      rel++;
      enrouteList.push({ fir: f.fir, id: idOf(n), type: fact.type, text: eText(n) });
      if (fact.type === 'AIRSPACE_CLOSED') closedAir.push({ fir: f.fir, id: idOf(n), firs: fact.firs });
      else if (fact.type === 'GNSS_INTERFERENCE') gn.push(idOf(n));
      else if (enIds[fact.type]) enIds[fact.type].push(idOf(n));
    }
    coverage.push({ fir: f.fir, total, inWindow: inWin, relevant: rel });
    if (gn.length) gnssFirs.push({ fir: f.fir, ids: gn });
  }
  // All en-route GNSS interference reports count as ONE Tier 1 factor (chronic in several regions;
  // per-FIR counting would inflate the score). The FIRs concerned are named in the label.
  if (gnssFirs.length) factors.push({ key: 'ROUTE:GNSS', tier: gnssFirs.length >= (cfg.gnssRouteT1Firs || 2) ? 1 : 2, scope: 'ROUTE', label: `en-route: GNSS interference/jamming reported (${gnssFirs.map(g => g.fir).join(', ')})`, ids: gnssFirs.flatMap(g => g.ids) });
  if (closedAir.length) {
    // a prohibition that covers the departure or arrival country (same two-letter ICAO prefix) cannot be flown around: NO-GO. Otherwise Tier 1 (route change needed).
    const pre = new Set(closedAir.flatMap(c => [c.fir, ...(c.firs || [])]).map(x => String(x).slice(0, 2)));
    const endpoint = (input.airports || []).some(a => pre.has(String(a.icao || '').slice(0, 2)));
    const names = [...new Set(closedAir.flatMap(c => c.firs && c.firs.length ? c.firs : [c.fir]))];
    factors.push({ key: 'ROUTE:AIRSPACE_CLOSED', tier: 1, scope: 'ROUTE', override: endpoint, label: `en-route: airspace closed/prohibited for all aircraft (${names.join(', ')})${endpoint ? ' — includes the departure or arrival aerodrome' : ''}`, ids: closedAir.map(c => c.id) });
  }
  assessConflictZones(input, cfg, now, new Set(closedAir.flatMap(c => [c.fir, ...(c.firs || [])]))).forEach(f => factors.push(f));
  if (enIds.AIRSPACE.length) factors.push({ key: 'ROUTE:AIRSPACE', tier: 2, scope: 'ROUTE', label: `en-route: prohibited/restricted/danger area activity (${enIds.AIRSPACE.length} NOTAMs)`, ids: enIds.AIRSPACE });
  if (enIds.NAVAID_ENROUTE.length) factors.push({ key: 'ROUTE:NAVAID', tier: 2, scope: 'ROUTE', label: `en-route: navaid unserviceable (${enIds.NAVAID_ENROUTE.length} NOTAMs)`, ids: enIds.NAVAID_ENROUTE });
  if (enIds.GNSS_OUTAGE.length) factors.push({ key: 'ROUTE:GNSS_OUTAGE', tier: 2, scope: 'ROUTE', label: 'en-route: GNSS outage/RAIM degradation', ids: enIds.GNSS_OUTAGE });

  const count = tier => factors.filter(f => f.tier === tier).length;
  const t1 = count(1), t3 = count(3);
  const t2 = count(2), w2 = factors.reduce((n, f) => n + factorWeight(f, cfg), 0);
  const override = airports.some(a => a.override) || factors.some(f => f.override);
  let concentration = null;
  for (const a of airports) {
    const a1 = a.factors.filter(f => f.tier === 1).length, a2 = a.factors.reduce((n, f) => n + factorWeight(f, cfg), 0);
    if (a1 >= cfg.concentration.t1 && a2 >= cfg.concentration.t2) { concentration = a.factors[0].scope; break; }
  }
  const { level, score } = levelFromCounts(t1, w2, t3, { override, concentration: !!concentration });
  const isSingle = (input.airports || []).length === 1;
  const verdict = isSingle
    ? (override || level === 'CRITICAL' ? 'SIGNIFICANTLY CONSTRAINED' : level === 'LOW' ? 'OPEN' : 'OPEN WITH CONSTRAINTS')
    : (override ? 'NO-GO' : level === 'LOW' ? 'GO' : 'GO WITH CONDITIONS');
  const order = f => f.tier * 1000 + (f.scope === 'ROUTE' ? 1 : 0);
  const sorted = [...factors].sort((a, b) => order(a) - order(b));
  const unverified = airports.filter(a => !a.info.trusted && a.factors.some(f => f.key.endsWith(':RWY'))).map(a => a.factors[0].scope);

  return {
    level, score, headerClass: CLASS_OF[level], label: LABEL_OF[level], verdict, override,
    concentration, counts: { t1, t2, t3, w2 }, factors: sorted, severityById,
    runwayInfo: Object.fromEntries(airports.map((a, i) => [input.airports[i].icao, Object.assign({}, a.info, { main: a.info.main ? [...a.info.main] : undefined, backup: a.info.backup ? [...a.info.backup] : undefined })])),
    airportRows: Object.fromEntries(airports.map((a, i) => [input.airports[i].icao, a.rows])),
    enrouteList, enrouteWatch, coverage,
    hasWeather: Object.fromEntries((input.airports || []).map(a => [a.icao, { metar: !!a.metar, taf: !!a.taf }])),
    unverifiedRunwayCount: unverified,
  };
}

// Text block handed to the language model (authoritative, verbatim use).
function promptBlock(r) {
  const lines = [
    'RISK ASSESSMENT (computed by the server — AUTHORITATIVE; do not re-score, do not contradict):',
    `LEVEL: ${r.level}`,
    `SCORE: ${r.score}`,
    `MASTER-HEADER CLASS: ${r.headerClass}`,
    `RISK LABEL: ${r.label}`,
    `VERDICT: ${r.verdict}`,
  ];
  [1, 2, 3].forEach(t => {
    const f = r.factors.filter(x => x.tier === t);
    if (f.length) lines.push(`TIER ${t} FACTORS:\n` + f.map(x => `- ${x.label}${x.ids && x.ids.length ? ' [' + x.ids.slice(0, 8).join(', ') + (x.ids.length > 8 ? ` +${x.ids.length - 8} more` : '') + ']' : ''}`).join('\n'));
  });
  if (!r.factors.length) lines.push('No scored factors are active in the next 24 hours.');
  return lines.join('\n');
}

// ───────────────────────── model hand-over and client finalisation ─────────────────────────
// Minor rows: rubric Tier 3, or not recognised by the rubric and without alarm wording (not on the watchlist). They are summarised, not listed.
// Recognised types that are Tier 1/2 when in force: out of the window they are only downgraded to MEDIUM, but they must stay listed (never minor).
const T12_TYPES = new Set(['AD_CLOSED', 'ATC_OUT', 'GNSS_INTERFERENCE', 'RWY_CLOSURE', 'RWY_RESTRICTION', 'LLWAS', 'ILS', 'CAT23', 'RVR', 'LIGHTING', 'MINIMA', 'NAVAID', 'RFFS', 'AIRSPACE', 'GNSS_OUTAGE', 'APPROACH_OUT', 'AIRSPACE_CLOSED']);
const isMinorRow = x => !!x && !T12_TYPES.has(x.type) && (x.sev === 'MEDIUM' || ((x.sev === 'LOW' || !x.sev) && !x.watch));
const SEV_TAG = { CRITICAL: 'T1', HIGH: 'T2', MEDIUM: 'T3', LOW: 'not scored' };
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t);
const levelOfScore = sc => (sc >= 9 ? 'CRITICAL' : sc >= 6 ? 'HIGH' : sc >= 3 ? 'MEDIUM' : 'LOW');

// Everything the language model needs to rate the briefing WITHOUT information gaps: the floor, all factors,
// runway data, every active aerodrome NOTAM (tier-tagged), route-relevant en-route NOTAMs and a watchlist.
// true when the only override comes from the conflict-zone list (not a closed aerodrome / no usable runway)
function isConflictOverride(r) {
  const ov = (r.factors || []).filter(f => f.override);
  return ov.length > 0 && ov.every(f => f.key === 'ROUTE:CONFLICT_NOGO');
}

function buildModelBlock(input, r, opts) {
  const o = Object.assign({ maxPerAirport: 60, maxEnroute: 40, maxWatch: 20, textLen: 160 }, opts || {});
  const L = [];
  L.push([
    'RISK FLOOR — computed by the server from NOTAM, weather and route data. This is the MINIMUM rating (see RISK RATING RULES).',
    `FLOOR LEVEL: ${r.level}`,
    `FLOOR SCORE: ${r.score}`,
    `VERDICT FLOOR: ${r.override ? r.verdict + (isConflictOverride(r) ? ' — OVERRIDE: operations to/from an aerodrome inside a prohibited conflict zone (EASA/FAA); the verdict MUST be NO-GO' : ' — OVERRIDE: an aerodrome has no usable runway or is closed; the verdict MUST be NO-GO') : r.verdict}`,
  ].join('\n'));
  [1, 2, 3].forEach(t => {
    const f = r.factors.filter(x => x.tier === t);
    if (f.length) L.push(`TIER ${t} FACTORS:\n` + f.map(x => `- ${x.label}${x.ids && x.ids.length ? ' [' + x.ids.slice(0, 8).join(', ') + (x.ids.length > 8 ? ` +${x.ids.length - 8} more` : '') + ']' : ''}`).join('\n'));
  });
  if (!r.factors.length) L.push('No scored factors are active in the next 24 hours.');

  if ((input.routeFirs || []).length) L.push(`GREAT-CIRCLE ROUTE FIRs (approximate boundaries; actual routing may differ): ${input.routeFirs.join(' > ')}${(input.routeNearFirs || []).length ? ' | within ~50 NM of the track: ' + input.routeNearFirs.join(', ') : ''}`);

  // runway data
  const rw = Object.entries(r.runwayInfo || {}).map(([icao, inf]) => {
    if (inf.main && inf.backup) return `${icao}: ${inf.count} runways — main: ${[...inf.main].join(', ')}; backup (used depending on traffic): ${[...inf.backup].join(', ')} [expert-verified]`;
    return `${icao}: ${inf.count || 'unknown'} runways [${inf.disputed ? 'DISPUTED — ' + inf.note : (inf.source || 'unknown')}${inf.trusted ? '' : ' — unverified'}]`;
  });
  if (rw.length) L.push('RUNWAY DATA:\n' + rw.map(x => '- ' + x).join('\n'));

  // coverage statement
  const cov = [];
  (input.airports || []).forEach(a => {
    const rows = (r.airportRows || {})[a.icao] || [];
    const hw = (r.hasWeather || {})[a.icao] || {};
    cov.push(`${a.icao}: ${rows.length} active NOTAMs evaluated; METAR ${hw.metar ? 'yes' : 'NO'}, TAF ${hw.taf ? 'yes' : 'NO'}`);
  });
  (r.coverage || []).forEach(c => cov.push(`FIR ${c.fir}: ${c.total} NOTAMs, ${c.inWindow} in force within 24 h, ${c.relevant} recognised and relevant to the route`));
  if (!(r.coverage || []).length && (input.airports || []).length > 1) cov.push('En-route FIR NOTAMs: NOT retrieved — the rating covers aerodromes and weather only');
  L.push('COVERAGE:\n' + cov.map(x => '- ' + x).join('\n'));

  // per-aerodrome NOTAMs
  (input.airports || []).forEach(a => {
    const rows = (r.airportRows || {})[a.icao] || [];
    const shown = new Set(a.shownIds || []);
    const tag = x => (x.sev === 'MEDIUM' && T12_TYPES.has(x.type)) ? 'T2 when in force' : (SEV_TAG[x.sev] || 'not scored');
    const cards = rows.filter(x => shown.has(x.id));
    if (cards.length) L.push(`${a.icao} — rubric tier of the NOTAMs whose full text is given below (the [CRITICAL]/[HIGH] tags on that text are only ordering hints):\n` + cards.map(x => `- ${x.id} ${tag(x)}${x.type ? ' ' + x.type : ''}${x.inWindow ? '' : ' (not in force during the next 24 h)'}`).join('\n'));
    // Full cards are reserved for rubric Tier 1 / Tier 2 NOTAMs that are in force (server decides; tag-compact lines for everything else)
    const cap = a.cardCap || 3;
    const byId = {}; rows.forEach(x => { byId[x.id] = x; });
    const cardIds = (a.shownIds || []).map(id => byId[id]).filter(x => x && (x.sev === 'CRITICAL' || x.sev === 'HIGH') && x.inWindow !== false).map(x => x.id).filter((id, i, arr) => arr.indexOf(id) === i).slice(0, cap);
    L.push(cardIds.length
      ? `${a.icao} — FULL CARDS (<nc>) for EXACTLY these NOTAMs, in this order: ${cardIds.join(', ')}. EVERY other Tier 1/2 NOTAM of ${a.icao} gets one compact <nl> line; T3 and not-scored NOTAMs follow the rule below.`
      : `${a.icao} — FULL CARDS: none (no <nc> cards for this aerodrome).`);
    const lineRows = rows.filter(x => !isMinorRow(x) && !cardIds.includes(x.id) && !x.upcoming);
    if (lineRows.length) L.push(`${a.icao} — COMPACT LINES (<nl>) REQUIRED: write exactly one line for EACH of these ids, none may be left out (those marked "not in force during the next 24 h" are valid on scheduled days only and are still listed): ${lineRows.slice(0, 40).map(x => x.id).join(', ')}${lineRows.length > 40 ? ' …' : ''}.`);
    const t3 = rows.filter(x => isMinorRow(x) && !cardIds.includes(x.id));
    if (t3.length) L.push(`${a.icao} — ${t3.length} minor (T3 / not scored) NOTAMs, NO LINE for any of these ids: ${t3.slice(0, 40).map(x => x.id).join(', ')}${t3.length > 40 ? ' …' : ''}. The page adds one summary note with the count and a link to the NOTAMs & MET panel. Still use them for the rating. Only exception: a minor NOTAM that you name in a COMPOUNDS WITH banner or in the executive summary gets exactly one <nl> line; no other minor NOTAM is written out.`);
    const rest = rows.filter(x => !shown.has(x.id)).sort((x, y) => String(tag(x)).localeCompare(String(tag(y))) || String(x.id).localeCompare(String(y.id)));
    if (rest.length) L.push(`${a.icao} — ADDITIONAL ACTIVE NOTAMs NOT SHOWN AS FULL CARDS (one line each; evaluate them for the rating):\n` +
      rest.slice(0, o.maxPerAirport).map(x => `- ${x.id} [${tag(x)}${x.type ? ' ' + x.type : ''}${x.inWindow ? '' : '; not in force during the next 24 h'}] ${clip(x.text, o.textLen)}`).join('\n') +
      (rest.length > o.maxPerAirport ? `\n- … ${rest.length - o.maxPerAirport} more (see the NOTAM panel)` : ''));
  });

  if ((r.enrouteList || []).length) {
    const e = r.enrouteList;
    L.push('EN-ROUTE NOTAMs RELEVANT TO THE ROUTE (server-filtered by geography and validity):\n' +
      e.slice(0, o.maxEnroute).map(x => `- ${x.fir} ${x.id} [${x.type}] ${clip(x.text, o.textLen)}`).join('\n') +
      (e.length > o.maxEnroute ? `\n- … ${e.length - o.maxEnroute} more` : ''));
  }
  const watch = [];
  (input.airports || []).forEach(a => ((r.airportRows || {})[a.icao] || []).filter(x => x.watch).forEach(x => watch.push({ hi: WATCH_HIGH.test(x.watch), line: `${a.icao} ${x.id} [${x.watch}] ${clip(x.text, o.textLen)}` })));
  (r.enrouteWatch || []).forEach(x => watch.push({ hi: WATCH_HIGH.test(x.reason), line: `${x.fir} ${x.id} [${x.reason}] ${clip(x.text, o.textLen)}` }));
  watch.sort((x, y) => (y.hi ? 1 : 0) - (x.hi ? 1 : 0));   // security / volcanic / conflict wording first
  if (watch.length) L.push('WATCHLIST — NOT RECOGNISED BY THE RUBRIC BUT CONTAINING ALARM WORDING (assess each one yourself):\n' + watch.slice(0, o.maxWatch).map(x => '- ' + x.line).join('\n') + (watch.length > o.maxWatch ? `\n- … ${watch.length - o.maxWatch} more` : ''));
  return L.join('\n\n');
}

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LEVEL_COLOR = { LOW: '#2ec4b6', MEDIUM: '#f2c641', HIGH: '#f4841a', CRITICAL: '#e63946' };

// Server-authored box shown under the master header.
function basisHtml(r, finalScore, finalLevel, flags) {
  // every Tier 1 and Tier 2 factor is listed; Tier 3 factors are summarised as a count (full detail is in the briefing body)
  const sig = r.factors.filter(f => f.tier <= 2).map(f => `T${f.tier}: ${esc(f.label)}`);
  const t3n = r.factors.filter(f => f.tier === 3).length;
  const top = sig.concat(t3n ? [`T3: ${t3n} minor factor${t3n > 1 ? 's' : ''} (ground works, obstacles, minor equipment, low-probability forecast)`] : []).join(' · ');
  const parts = [`<strong>RISK BASIS</strong> — rubric floor <strong>${r.level} ${r.score}/10</strong> (T1 ${r.counts.t1} · T2 ${r.counts.t2}${r.counts.w2 != null && r.counts.w2 !== r.counts.t2 ? ` — weighted ${r.counts.w2}` : ''} · T3 ${r.counts.t3})`];
  if (top) parts.push(top);
  parts.push(`Final rating: <strong>${finalLevel} ${finalScore}/10</strong>${flags && flags.raised ? ' — raised above the floor by the assessment' : ''}`);
  if (r.override) parts.push(isConflictOverride(r) ? '⚠ Aerodrome inside a prohibited conflict zone (EASA/FAA) — NO-GO.' : '⚠ Aerodrome closed or no usable runway — NO-GO.');
  if (flags && flags.lowered) parts.push('⚠ The narrative was rated below the rubric floor; the header has been set to the floor value.');
  if (r.unverifiedRunwayCount && r.unverifiedRunwayCount.length) parts.push('Runway count unverified for ' + esc(r.unverifiedRunwayCount.join(', ')) + ' — conservative rule applied.');
  const c = LEVEL_COLOR[finalLevel] || '#4a9eff';
  return `<div style="font-family:'Share Tech Mono',monospace;font-size:11px;line-height:1.7;color:#8a9bb0;padding:10px 14px;margin:10px 0;border:1px solid #1a2a3a;border-left:3px solid ${c};background:rgba(10,15,24,0.6);">${parts.join('<br>')}</div>`;
}

// Final header values for the client: never below the floor, and always internally consistent (class / label / score).
function finalizeForClient(r, headText) {
  const m = /RISK\s*SCORE\s*(?:<[^>]*>)?\s*(\d+)\s*\/\s*10/i.exec(headText || '');
  const modelScore = m ? Math.min(10, parseInt(m[1], 10)) : null;
  const finalScore = Math.max(r.score, modelScore === null ? 0 : modelScore);
  const finalLevel = levelOfScore(finalScore);
  return {
    riskFix: { cls: CLASS_OF[finalLevel], label: LABEL_OF[finalLevel], score: finalScore },
    riskBasisHtml: basisHtml(r, finalScore, finalLevel, { raised: modelScore !== null && modelScore > r.score, lowered: modelScore === null || modelScore < r.score }),
    modelScore,
  };
}

// En-route NOTAMs that are NOT yet effective but start within the next `hours` and are relevant to the route
// (recognised hazard types only). Used for the server-authored "Upcoming NOTAMs" list.
function upcomingEnroute(enroute, route, now, hours, cfg) {
  const c = cfg || CONFIG, end = new Date(now.getTime() + (hours || 24) * 3600e3), out = [];
  for (const f of enroute || []) {
    for (const n of f.notams || []) {
      if (isAdminNotam(n)) continue;
      const v = validity(n);
      if (!v.eff || v.eff <= now || v.eff > end) continue;
      if (v.exp && v.exp <= now) continue;
      const fact = extractFact(n, 'FIR');
      if (!fact || !routeRelevant(n, route, c)) continue;
      out.push({ fir: f.fir, id: idOf(n), from: v.eff, type: fact.type, text: eText(n) });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

module.exports = { qLine, fgLine, dLine, isMinorRow, upcomingEnroute, CONFIG, assessTaf, watchReason, buildModelBlock, finalizeForClient, basisHtml, levelOfScore, parseGeo, gcDist, trackDistances, routeRelevant, evaluateRunways, resolveRunwayCount, assessRisk, assessAirport, promptBlock, assessWeather, windowStatus, parseRunwayClosures, extractFact, rwyKey, levelFromCounts, runwaysMentioned, isAdminNotam, idOf };
