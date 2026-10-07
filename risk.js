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
  runwayClosedFractionT1: 0.5,

  // En-route restrictions are scored only if they are near the planned route (dep -> arr great circle).
  routeCorridorNm: 100,     // half-width of the corridor around the route
  lowLevelUpperFl: 150,     // restrictions topping out below this FL only matter near the aerodromes ...
  nearAirportNm: 80,        // ... i.e. within this distance of departure or arrival

  // One aerodrome with >= t1 Tier-1 factors AND >= t2 Tier-2 factors is escalated to CRITICAL.
  concentration: { t1: 1, t2: 3 },

  // Weather thresholds (METAR).
  weather: { lifrVisM: 1600, lifrCeilFt: 500, ifrVisM: 5000, ifrCeilFt: 1000, gustKt: 35 },

  levelBands: { LOW: [0, 2], MEDIUM: [3, 5], HIGH: [6, 8], CRITICAL: [9, 10] },
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

function dLine(raw) {
  const m = raw.match(/\bD\)\s*([\s\S]*?)(?=\n\s*E\)|\bE\)|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function parseSchedule(d) {
  if (/\bSR\b|\bSS\b|SUNRISE|SUNSET/.test(d)) return { unparsed: true };
  const ranges = [];
  const rx = /(\d{4})\s*-\s*(\d{4})/g;
  let m;
  while ((m = rx.exec(d))) ranges.push([m[1], m[2]]);
  if (!ranges.length) return { unparsed: true };
  const rest = d.replace(/(\d{4})\s*-\s*(\d{4})/g, ' ');
  const days = [...rest.matchAll(/\b(0[1-9]|[12]\d|3[01])\b/g)].map(x => +x[1]);
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
    const dayOk = sch.daily || (!sch.days.length && !sch.wd.size) || sch.days.includes(base.getUTCDate()) || sch.wd.has(base.getUTCDay());
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
    const pre = t.slice(Math.max(0, m.index - 40), m.index);
    if (/(LGT|LIGHTS?|LIGHTING|PAPI|VASI|ILS|LOC|LOCALI[SZ]ER|GP|GS|RVR|SFL|ALS|APCH|APPROACH|MARKINGS?|SIGNS?|EDGE|CENTRE\s*LINE|CENTERLINE|TDZ|THR|BARRIER)\s*$/.test(pre)) continue;
    // "... CRANE WILL ONLY OPR WHEN RWY 09L/27R IS CLSD" describes a condition, it does not announce a closure
    if (/\b(?:WHEN|IF|WHILE|DURING|UNLESS)\s*$/.test(pre)) continue;
    const keys = [...new Set([...m[1].matchAll(/\d{2}[LRC]?/g)].map(x => rwyKey(x[0])))];
    const to = (m[2] || '').toUpperCase();
    const mode = /LANDING|LDG/.test(to) ? 'landing' : /TKOF|TAKE|DEP/.test(to) ? 'takeoff' : 'full';
    // "RWY 36 NOT AVBL FOR LDG BY ACFT WITH CAT D/E/F" is a restriction for some aircraft, not a closure
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 160).split('.')[0];
    const restricted = /\b(?:FOR|BY)\s+(?:ALL\s+)?(?:ACFT|AIRCRAFT)\b|\bWITH\s+(?:CAT|CODE)\b|\bWINGSPAN\b|\bEXC(?:EPT|LUDING)?\b|\b(?:CAT|CODE)\s+[A-F]\b|\b(?:HEAVY|WIDE-?\s?BODY|MTOW)\b|\bONLY\s+(?:FOR|TO)\b/.test(after);
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
    if (/JAMM|SPOOF|INTERFER|UNRELIABLE|DISRUPT/.test(t)) return { type: 'GNSS_INTERFERENCE' };
    if (/RAIM|OUTAGE|DEGRAD|PREDICT/.test(t)) return { type: 'GNSS_OUTAGE' };
  }

  if (scope === 'FIR') {
    if (/\b(PROHIBITED|RESTRICTED|DANGER|TEMPORARY\s+RESTRICTED)\s+(AREA|ZONE|AIRSPACE)\b|\b(MILITARY\s+(EXERCISE|ACTIVITY|OPS)|LIVE\s+FIRING|MISSILE|ROCKET|LASER)\b/.test(t) ||
        ['RP', 'RR', 'RD', 'RT', 'WE', 'WM', 'WL'].includes(q.subj)) return { type: 'AIRSPACE' };
    if (out(t, /\b(?:VOR|DME|NDB|TACAN|VORTAC|DVOR)\b/)) return { type: 'NAVAID_ENROUTE' };
    return null;
  }

  // aerodrome closed (no runway/taxiway/apron wording)
  if ((/\b(AD|AERODROME|AIRPORT|ARPT)\b\s*(?:IS\s*)?(CLSD|CLOSED)\b/.test(t) && !/\b(RWY|TWY|APRON|STAND)\b/.test(t)) || q.code === 'QFALC')
    return { type: 'AD_CLOSED' };

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
  const frac = (cfg && cfg.runwayClosedFractionT1) || 0.5;

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
    for (const c of r.fact.closures) closures.push({ key: c.key, mode: c.mode, continuous, certain, intervals: r.win.intervals || [{ start: now, end: windowEnd }] });
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
  if (adc.length) { override = true; add('AD_CLOSED', 1, 'aerodrome closed', adc.map(r => r.id), { override: true }); }

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
    add('LLWAS', fullOut ? 1 : 2, fullOut ? 'low-level windshear alerting (LLWAS) fully unserviceable' : 'LLWAS partially unserviceable (' + [...comps].join('/') + ')', ids('LLWAS'));
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
  if (wxs.length) add('WX', Math.min(...wxs.map(x => x.tier)), wxs.map(x => x.label).join('; '), []);

  // display severity per NOTAM (drives card format/order); out-of-window items are shown compactly
  const rwFactor = factors.find(f => f.key.endsWith(':RWY'));
  for (const r of rows) {
    let sev = 'LOW';
    if (r.fact) {
      const t = r.fact.type;
      if (t === 'AD_CLOSED' || t === 'ATC_OUT' || t === 'GNSS_INTERFERENCE') sev = 'CRITICAL';
      else if (t === 'RWY_CLOSURE') sev = rwFactor && rwFactor.tier === 1 ? 'CRITICAL' : 'HIGH';
      else if (t === 'RWY_RESTRICTION') sev = (factors.find(f => f.key.endsWith(':RWY_RESTRICTION')) || {}).tier === 3 ? 'MEDIUM' : 'HIGH';
      else if (t === 'LLWAS') sev = r.fact.comp === 'full' || factors.some(f => f.key.endsWith(':LLWAS') && f.tier === 1) ? 'CRITICAL' : 'HIGH';
      else if (['ILS', 'CAT23', 'RVR', 'LIGHTING', 'MINIMA', 'NAVAID', 'RFFS', 'AIRSPACE', 'GNSS_OUTAGE'].includes(t)) sev = 'HIGH';
      else sev = 'MEDIUM';
      if (!r.win.inWindow && sev !== 'LOW') sev = 'MEDIUM';
    }
    severityById.set(r.id, sev);
  }
  const rowsOut = rows.map(r => ({
    id: r.id, type: r.fact ? r.fact.type : null, sev: severityById.get(r.id), inWindow: r.win.inWindow,
    text: eText(r.n), watch: (!r.fact && r.win.inWindow) ? watchReason(r.n) : null,
  }));
  return { factors, override, info, severityById, rows: rowsOut };
}

// ───────────────────────── level / score ─────────────────────────
function levelFromCounts(t1, t2, t3, flags) {
  if (flags.override) return { level: 'CRITICAL', score: 10 };
  if (t1 >= 2 || flags.concentration) return { level: 'CRITICAL', score: 9 };   // 10 is reserved for an aerodrome that is closed (override)
  if (t1 === 1 || t2 >= 3) {
    let s = 6;
    if ((t1 === 1 && t2 >= 1) || t2 >= 4) s += 1;
    if ((t1 === 1 && t2 >= 3) || t2 >= 5) s += 1;
    return { level: 'HIGH', score: s };
  }
  if (t2 >= 1 || t3 >= 3) return { level: 'MEDIUM', score: t2 >= 2 ? 5 : t2 === 1 ? 4 : 3 };
  return { level: 'LOW', score: t3 >= 2 ? 2 : t3 === 1 ? 1 : 0 };
}

const CLASS_OF = { LOW: 'low', MEDIUM: 'med', HIGH: 'high', CRITICAL: 'crit' };
const LABEL_OF = { LOW: '🟢 LOW', MEDIUM: '🟡 MEDIUM', HIGH: '🟠 HIGH', CRITICAL: '🔴 CRITICAL' };

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
      if (fact.type === 'GNSS_INTERFERENCE') gn.push(idOf(n));
      else if (enIds[fact.type]) enIds[fact.type].push(idOf(n));
    }
    coverage.push({ fir: f.fir, total, inWindow: inWin, relevant: rel });
    if (gn.length) gnssFirs.push({ fir: f.fir, ids: gn });
  }
  // All en-route GNSS interference reports count as ONE Tier 1 factor (chronic in several regions;
  // per-FIR counting would inflate the score). The FIRs concerned are named in the label.
  if (gnssFirs.length) factors.push({ key: 'ROUTE:GNSS', tier: 1, scope: 'ROUTE', label: `en-route: GNSS interference/jamming reported (${gnssFirs.map(g => g.fir).join(', ')})`, ids: gnssFirs.flatMap(g => g.ids) });
  if (enIds.AIRSPACE.length) factors.push({ key: 'ROUTE:AIRSPACE', tier: 2, scope: 'ROUTE', label: `en-route: prohibited/restricted/danger area activity (${enIds.AIRSPACE.length} NOTAMs)`, ids: enIds.AIRSPACE });
  if (enIds.NAVAID_ENROUTE.length) factors.push({ key: 'ROUTE:NAVAID', tier: 2, scope: 'ROUTE', label: `en-route: navaid unserviceable (${enIds.NAVAID_ENROUTE.length} NOTAMs)`, ids: enIds.NAVAID_ENROUTE });
  if (enIds.GNSS_OUTAGE.length) factors.push({ key: 'ROUTE:GNSS_OUTAGE', tier: 2, scope: 'ROUTE', label: 'en-route: GNSS outage/RAIM degradation', ids: enIds.GNSS_OUTAGE });

  const count = tier => factors.filter(f => f.tier === tier).length;
  const t1 = count(1), t2 = count(2), t3 = count(3);
  const override = airports.some(a => a.override);
  let concentration = null;
  for (const a of airports) {
    const a1 = a.factors.filter(f => f.tier === 1).length, a2 = a.factors.filter(f => f.tier === 2).length;
    if (a1 >= cfg.concentration.t1 && a2 >= cfg.concentration.t2) { concentration = a.factors[0].scope; break; }
  }
  const { level, score } = levelFromCounts(t1, t2, t3, { override, concentration: !!concentration });
  const isSingle = (input.airports || []).length === 1;
  const verdict = isSingle
    ? (override || level === 'CRITICAL' ? 'SIGNIFICANTLY CONSTRAINED' : level === 'LOW' ? 'OPEN' : 'OPEN WITH CONSTRAINTS')
    : (override ? 'NO-GO' : level === 'LOW' ? 'GO' : 'GO WITH CONDITIONS');
  const order = f => f.tier * 1000 + (f.scope === 'ROUTE' ? 1 : 0);
  const sorted = [...factors].sort((a, b) => order(a) - order(b));
  const unverified = airports.filter(a => !a.info.trusted && a.factors.some(f => f.key.endsWith(':RWY'))).map(a => a.factors[0].scope);

  return {
    level, score, headerClass: CLASS_OF[level], label: LABEL_OF[level], verdict, override,
    concentration, counts: { t1, t2, t3 }, factors: sorted, severityById,
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
const isMinorRow = x => !!x && (x.sev === 'MEDIUM' || ((x.sev === 'LOW' || !x.sev) && !x.watch));
const SEV_TAG = { CRITICAL: 'T1', HIGH: 'T2', MEDIUM: 'T3', LOW: 'not scored' };
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t);
const levelOfScore = sc => (sc >= 9 ? 'CRITICAL' : sc >= 6 ? 'HIGH' : sc >= 3 ? 'MEDIUM' : 'LOW');

// Everything the language model needs to rate the briefing WITHOUT information gaps: the floor, all factors,
// runway data, every active aerodrome NOTAM (tier-tagged), route-relevant en-route NOTAMs and a watchlist.
function buildModelBlock(input, r, opts) {
  const o = Object.assign({ maxPerAirport: 60, maxEnroute: 40, maxWatch: 20, textLen: 160 }, opts || {});
  const L = [];
  L.push([
    'RISK FLOOR — computed by the server from NOTAM, weather and route data. This is the MINIMUM rating (see RISK RATING RULES).',
    `FLOOR LEVEL: ${r.level}`,
    `FLOOR SCORE: ${r.score}`,
    `VERDICT FLOOR: ${r.override ? r.verdict + ' — OVERRIDE: an aerodrome has no usable runway or is closed; the verdict MUST be NO-GO' : r.verdict}`,
  ].join('\n'));
  [1, 2, 3].forEach(t => {
    const f = r.factors.filter(x => x.tier === t);
    if (f.length) L.push(`TIER ${t} FACTORS:\n` + f.map(x => `- ${x.label}${x.ids && x.ids.length ? ' [' + x.ids.slice(0, 8).join(', ') + (x.ids.length > 8 ? ` +${x.ids.length - 8} more` : '') + ']' : ''}`).join('\n'));
  });
  if (!r.factors.length) L.push('No scored factors are active in the next 24 hours.');

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
    const tag = x => SEV_TAG[x.sev] || 'not scored';
    const cards = rows.filter(x => shown.has(x.id));
    if (cards.length) L.push(`${a.icao} — rubric tier of the NOTAMs whose full text is given below (the [CRITICAL]/[HIGH] tags on that text are only ordering hints):\n` + cards.map(x => `- ${x.id} ${tag(x)}${x.type ? ' ' + x.type : ''}${x.inWindow ? '' : ' (not in force during the next 24 h)'}`).join('\n'));
    // Full cards are reserved for rubric Tier 1 / Tier 2 NOTAMs that are in force (server decides; tag-compact lines for everything else)
    const cap = a.cardCap || 3;
    const byId = {}; rows.forEach(x => { byId[x.id] = x; });
    const cardIds = (a.shownIds || []).map(id => byId[id]).filter(x => x && (x.sev === 'CRITICAL' || x.sev === 'HIGH') && x.inWindow !== false).map(x => x.id).filter((id, i, arr) => arr.indexOf(id) === i).slice(0, cap);
    L.push(cardIds.length
      ? `${a.icao} — FULL CARDS (<nc>) for EXACTLY these NOTAMs, in this order: ${cardIds.join(', ')}. EVERY other Tier 1/2 NOTAM of ${a.icao} gets one compact <nl> line; T3 and not-scored NOTAMs follow the rule below.`
      : `${a.icao} — FULL CARDS: none (no <nc> cards for this aerodrome).`);
    const t3 = rows.filter(x => isMinorRow(x) && !cardIds.includes(x.id));
    if (t3.length) L.push(`${a.icao} — ${t3.length} minor (T3 / not scored) NOTAMs: write NO line for any NOTAM tagged T3 or "not scored" (the page adds one summary note with the count and a link to the NOTAMs & MET panel). Still use them for the rating. Only exception: a T3 or not-scored NOTAM that materially compounds with a Tier 1/2 NOTAM or is named in a COMPOUNDS WITH banner or the executive summary gets exactly one <nl> line.`);
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
  const parts = [`<strong>RISK BASIS</strong> — rubric floor <strong>${r.level} ${r.score}/10</strong> (T1 ${r.counts.t1} · T2 ${r.counts.t2} · T3 ${r.counts.t3})`];
  if (top) parts.push(top);
  parts.push(`Final rating: <strong>${finalLevel} ${finalScore}/10</strong>${flags && flags.raised ? ' — raised above the floor by the assessment' : ''}`);
  if (r.override) parts.push('⚠ Aerodrome closed or no usable runway — NO-GO.');
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

module.exports = { isMinorRow, upcomingEnroute, CONFIG, assessTaf, watchReason, buildModelBlock, finalizeForClient, basisHtml, levelOfScore, parseGeo, gcDist, trackDistances, routeRelevant, evaluateRunways, resolveRunwayCount, assessRisk, assessAirport, promptBlock, assessWeather, windowStatus, parseRunwayClosures, extractFact, rwyKey, levelFromCounts, runwaysMentioned, isAdminNotam, idOf };
