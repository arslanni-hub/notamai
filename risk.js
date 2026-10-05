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

  // A runway closure that only applies during scheduled windows (NOTAM line D) is one tier lighter.
  scheduledDowngrade: true,

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
  return new RegExp(`(?:${w})[^.]{0,${win}}?(?:${u})`).test(t) || new RegExp(`(?:${u})[^.]{0,20}?(?:${w})`).test(t);
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
  return { fir: parts[0] || '', code, subj: code.slice(1, 3), cond: code.slice(3, 5) };
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

// Is this NOTAM relevant inside [now, now + windowHours]?
function windowStatus(n, now, cfg) {
  const windowEnd = new Date(now.getTime() + cfg.windowHours * 3600e3);
  const v = validity(n);
  if (v.eff && v.eff > windowEnd) return { inWindow: false, reason: 'later' };
  if (v.exp && v.exp <= now) return { inWindow: false, reason: 'expired' };
  const d = dLine(UP(n));
  if (!d) return { inWindow: true, kind: (v.eff && v.eff > now) ? 'starts-in-window' : 'continuous' };
  const sch = parseSchedule(d);
  if (sch.unparsed) return { inWindow: true, kind: 'scheduled-unparsed' };
  const out = [];
  for (let off = -1; off <= 1; off++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + off));
    const dayOk = sch.daily || (!sch.days.length && !sch.wd.size) || sch.days.includes(base.getUTCDate()) || sch.wd.has(base.getUTCDay());
    if (!dayOk) continue;
    for (const [a, b] of sch.ranges) {
      const s = new Date(base.getTime() + (+a.slice(0, 2) * 60 + +a.slice(2)) * 60000);
      let e = new Date(base.getTime() + (+b.slice(0, 2) * 60 + +b.slice(2)) * 60000);
      if (e <= s) e = new Date(e.getTime() + 86400000);
      out.push({ start: s, end: e });
    }
  }
  const hit = out.filter(i => i.end > now && i.start < windowEnd && (!v.eff || i.end > v.eff) && (!v.exp || i.start < v.exp));
  if (!hit.length) return { inWindow: false, reason: 'schedule' };
  return { inWindow: true, kind: 'scheduled', activeNow: hit.some(i => i.start <= now && i.end > now) };
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
    const keys = [...new Set([...m[1].matchAll(/\d{2}[LRC]?/g)].map(x => rwyKey(x[0])))];
    const to = (m[2] || '').toUpperCase();
    const mode = /LANDING|LDG/.test(to) ? 'landing' : /TKOF|TAKE|DEP/.test(to) ? 'takeoff' : 'full';
    keys.forEach(k => out.push({ key: k, mode }));
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
  if (rc.length) return { type: 'RWY_CLOSURE', closures: rc };

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

// ───────────────────────── weather ─────────────────────────
function assessWeather(metar, cfg) {
  if (!metar) return null;
  const toks = String(metar).toUpperCase().split(/\s+/);
  let vis = null, ceil = null, ts = false, fz = false, gust = 0, wind = 0;
  for (const tk of toks) {
    let m;
    if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(tk))) { wind = +m[2]; gust = m[3] ? +m[3] : 0; }
    else if (tk === 'CAVOK') { vis = 10000; }
    else if (/^\d{4}$/.test(tk) && vis === null && toks.indexOf(tk) > 1) vis = +tk;
    else if ((m = /^(\d+(?:\/\d)?)SM$/.exec(tk))) { const [a, b] = m[1].split('/'); vis = Math.round((b ? +a / +b : +a) * 1609); }
    else if ((m = /^(BKN|OVC|VV)(\d{3})/.exec(tk))) { const h = +m[2] * 100; if (ceil === null || h < ceil) ceil = h; }
    else if (/^[-+]?(VC)?(TS|TSRA|TSSN|TSGR)/.test(tk)) ts = true;
    else if (/^[-+]?FZ(RA|DZ|FG)$/.test(tk)) fz = true;
  }
  const reasons = [];
  if (vis !== null && vis < cfg.lifrVisM) reasons.push(`VIS ${vis} m`);
  if (ceil !== null && ceil < cfg.lifrCeilFt) reasons.push(`CIG ${ceil} ft`);
  if (ts) reasons.push('thunderstorm');
  if (fz) reasons.push('freezing precipitation/fog');
  if (Math.max(gust, wind) >= cfg.gustKt) reasons.push(`wind ${Math.max(gust, wind)} kt`);
  if (reasons.length) return { tier: 2, label: 'adverse weather (' + reasons.join(', ') + ')' };
  const mild = [];
  if (vis !== null && vis < cfg.ifrVisM) mild.push(`VIS ${vis} m`);
  if (ceil !== null && ceil < cfg.ifrCeilFt) mild.push(`CIG ${ceil} ft`);
  if (mild.length) return { tier: 3, label: 'IFR conditions (' + mild.join(', ') + ')' };
  return null;
}

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
  if (min !== max) return { count: Math.max(min, lb), trusted: false, disputed: true, source: 'disputed', note: `runway count disputed (${names})` };
  if (min < lb) return { count: lb, trusted: false, source: 'notam-min', note: `data sources report ${min} runway(s) but NOTAMs reference ${lb}` };
  return { count: min, trusted: true, source: srcs.map(x => x.name).join('+'), note: names };
}

function runwayTier(closedLanding, closedTakeoff, info) {
  const closed = Math.max(closedLanding.size, closedTakeoff.size);
  if (!closed) return null;
  if (info && info.trusted && info.count >= 1) {
    const remaining = info.count - closed;
    if (remaining <= 0) return { tier: 1, override: true, remaining: 0, note: `no usable runway remains (${closed} of ${info.count} closed)` };
    if (remaining === 1 && info.count >= 2) return { tier: 1, override: false, remaining, note: `only 1 of ${info.count} runways remains` };
    return { tier: 2, override: false, remaining, note: `${closed} of ${info.count} runways closed, ${remaining} remain` };
  }
  return closed >= 2
    ? { tier: 1, override: false, remaining: null, note: `${closed} runways closed (runway count unverified — conservative rule)` }
    : { tier: 2, override: false, remaining: null, note: '1 runway closed (runway count unverified)' };
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
  let info;
  if (ov) info = { count: ov, trusted: true, source: 'override' };
  else if (a.runwayInfo) { info = Object.assign({}, a.runwayInfo); if (info.trusted) info.count = Math.max(info.count, mentioned); }
  else info = resolveRunwayCount(a.runwaySources, mentioned);

  const add = (key, tier, label, ids, extra) => { factors.push(Object.assign({ key: `${a.icao}:${key}`, tier, scope: a.icao, label: `${a.icao}: ${label}`, ids }, extra || {})); };
  const ids = type => live.filter(r => r.fact.type === type).map(r => r.id);

  // aerodrome closed
  let override = false;
  const adc = live.filter(r => r.fact.type === 'AD_CLOSED' && r.win.kind !== 'scheduled' && r.win.kind !== 'scheduled-unparsed');
  if (adc.length) { override = true; add('AD_CLOSED', 1, 'aerodrome closed', adc.map(r => r.id), { override: true }); }

  // runways (dynamic rule)
  const rwRows = live.filter(r => r.fact.type === 'RWY_CLOSURE');
  if (rwRows.length) {
    const sets = (filter) => {
      const l = new Set(), t = new Set();
      rwRows.filter(filter).forEach(r => r.fact.closures.forEach(c => {
        if (c.mode === 'full' || c.mode === 'landing') l.add(c.key);
        if (c.mode === 'full' || c.mode === 'takeoff') t.add(c.key);
      }));
      return [l, t];
    };
    const isCont = r => r.win.kind === 'continuous' || r.win.kind === 'starts-in-window';
    const cont = runwayTier(...sets(isCont), info);
    const full = runwayTier(...sets(() => true), info);
    let pick = cont;
    if (full) {
      const windowed = cfg.scheduledDowngrade && (!cont || full.tier > cont.tier || full.override)
        ? Object.assign({}, full, { tier: full.override ? 1 : DOWN(full.tier), override: false, note: full.note + ' — during scheduled windows' })
        : full;
      if (!pick || windowed.tier < pick.tier) pick = windowed;
    }
    if (pick) {
      if (pick.override) override = true;
      add('RWY', pick.tier, pick.note, rwRows.map(r => r.id), { override: !!pick.override, runwayTier: pick.tier });
    }
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

  // weather
  const wx = assessWeather(a.metar, cfg.weather);
  if (wx) add('WX', wx.tier, wx.label, []);

  // display severity per NOTAM (drives card format/order); out-of-window items are shown compactly
  const rwFactor = factors.find(f => f.key.endsWith(':RWY'));
  for (const r of rows) {
    let sev = 'LOW';
    if (r.fact) {
      const t = r.fact.type;
      if (t === 'AD_CLOSED' || t === 'ATC_OUT' || t === 'GNSS_INTERFERENCE') sev = 'CRITICAL';
      else if (t === 'RWY_CLOSURE') sev = rwFactor && rwFactor.tier === 1 ? 'CRITICAL' : 'HIGH';
      else if (t === 'LLWAS') sev = r.fact.comp === 'full' || factors.some(f => f.key.endsWith(':LLWAS') && f.tier === 1) ? 'CRITICAL' : 'HIGH';
      else if (['ILS', 'CAT23', 'RVR', 'LIGHTING', 'MINIMA', 'NAVAID', 'RFFS', 'AIRSPACE', 'GNSS_OUTAGE'].includes(t)) sev = 'HIGH';
      else sev = 'MEDIUM';
      if (!r.win.inWindow && sev !== 'LOW') sev = 'MEDIUM';
    }
    severityById.set(r.id, sev);
  }
  return { factors, override, info, severityById };
}

// ───────────────────────── level / score ─────────────────────────
function levelFromCounts(t1, t2, t3, flags) {
  if (flags.override) return { level: 'CRITICAL', score: 10 };
  if (t1 >= 2 || flags.concentration) return { level: 'CRITICAL', score: t1 >= 3 ? 10 : 9 };
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
  for (const f of (input.enroute || [])) {
    const gn = [];
    for (const n of (f.notams || []).filter(n => !isAdminNotam(n))) {
      if (!windowStatus(n, now, cfg).inWindow) continue;
      const fact = extractFact(n, 'FIR');
      if (!fact) continue;
      if (fact.type === 'GNSS_INTERFERENCE') gn.push(idOf(n));
      else if (enIds[fact.type]) enIds[fact.type].push(idOf(n));
    }
    if (gn.length) factors.push({ key: `${f.fir}:GNSS`, tier: 1, scope: f.fir, label: `${f.fir}: GNSS interference/jamming reported`, ids: gn });
  }
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
    runwayInfo: Object.fromEntries(airports.map((a, i) => [input.airports[i].icao, a.info])),
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
    if (f.length) lines.push(`TIER ${t} FACTORS:\n` + f.map(x => `- ${x.label}${x.ids && x.ids.length ? ' [' + x.ids.join(', ') + ']' : ''}`).join('\n'));
  });
  if (!r.factors.length) lines.push('No scored factors are active in the next 24 hours.');
  return lines.join('\n');
}

module.exports = { CONFIG, resolveRunwayCount, assessRisk, assessAirport, promptBlock, assessWeather, windowStatus, parseRunwayClosures, extractFact, rwyKey, levelFromCounts, runwaysMentioned, isAdminNotam, idOf };
