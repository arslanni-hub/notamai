'use strict';
/**
 * Candidate alternate aerodromes for route briefings.
 *
 * The briefing model has no reliable geography for domestic routes (a Haiku briefing for LTFM-LTAI named no alternates at all),
 * so the server computes them from OurAirports data (airports.csv + runways.csv, downloaded once a day, kept in memory):
 * scheduled-service medium/large aerodromes with a long runway, nearest first. Only distance and runway length are known here;
 * weather and NOTAMs of the candidates are NOT checked, and the block says so. Nothing here ever throws into the briefing flow.
 */
const https = require('https');

const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const REFRESH_MS = 24 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MIN_RWY_FT = 6562;          // 2,000 m
const MAX_RADIUS_NM = 350;
const NEVER = new Set(['LTBA']);  // closed to commercial traffic

let airports = null;              // Map<ICAO, { icao, name, city, country, lat, lon, cand:boolean }>
let rwyMaxFt = null;              // Map<ICAO, longest open runway in ft>
let loadedAt = 0, lastAttempt = 0, loading = null;

function httpGet(url, timeoutMs, redirects) {
  redirects = redirects === undefined ? 3 : redirects;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'notam-intelligence/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function buildAirports(csv) {
  const rows = parseCsv(csv);
  const map = new Map();
  if (!rows.length) return map;
  const head = rows[0].map(h => h.trim());
  const ix = n => head.indexOf(n);
  const iIdent = ix('ident'), iType = ix('type'), iName = ix('name'), iLat = ix('latitude_deg'), iLon = ix('longitude_deg');
  const iCountry = ix('iso_country'), iCity = ix('municipality'), iSched = ix('scheduled_service');
  if (iIdent < 0 || iLat < 0 || iLon < 0) throw new Error('unexpected airports.csv header');
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const icao = (row[iIdent] || '').trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao)) continue;
    const lat = parseFloat(row[iLat]), lon = parseFloat(row[iLon]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const type = (row[iType] || '').trim();
    const cand = (type === 'large_airport' || type === 'medium_airport') && (row[iSched] || '').trim() === 'yes' && !NEVER.has(icao);
    map.set(icao, { icao, name: (row[iName] || '').trim(), city: (row[iCity] || '').trim(), country: (row[iCountry] || '').trim(), lat, lon, cand });
  }
  return map;
}

function buildRunwayLengths(csv) {
  const rows = parseCsv(csv);
  const map = new Map();
  if (!rows.length) return map;
  const head = rows[0].map(h => h.trim());
  const iIdent = head.indexOf('airport_ident'), iLen = head.indexOf('length_ft'), iClosed = head.indexOf('closed');
  if (iIdent < 0 || iLen < 0) throw new Error('unexpected runways.csv header');
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (iClosed >= 0 && (row[iClosed] || '').trim() === '1') continue;
    const id = (row[iIdent] || '').trim().toUpperCase();
    const len = parseFloat(row[iLen]);
    if (!id || !isFinite(len)) continue;
    if (!map.has(id) || map.get(id) < len) map.set(id, len);
  }
  return map;
}

function distNm(a, b) {
  const R = 3440.065, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Pure: nearest candidates to `icao`, excluding the listed codes. Runway length is required only when runway data was loaded.
function nearestCandidates(icao, exclude, count, airportsMap, runways) {
  const home = airportsMap && airportsMap.get(icao);
  if (!home) return [];
  const out = [];
  for (const a of airportsMap.values()) {
    if (!a.cand || a.icao === icao || (exclude && exclude.includes(a.icao))) continue;
    if (Math.abs(a.lat - home.lat) > 6) continue;           // cheap pre-filter (about 360 NM)
    const d = distNm(home, a);
    if (d > MAX_RADIUS_NM) continue;
    const ft = runways ? runways.get(a.icao) : null;
    if (runways && !(ft >= MIN_RWY_FT)) continue;
    out.push({ icao: a.icao, name: a.name, city: a.city, country: a.country, nm: Math.round(d), rwyM: ft ? Math.round(ft * 0.3048 / 10) * 10 : null });
  }
  out.sort((x, y) => x.nm - y.nm);
  return out.slice(0, count);
}

const fmt = c => c.icao + ' ' + c.name + (c.city ? ' (' + c.city + ')' : '') + ' — ' + c.nm + ' NM' + (c.rwyM ? ', longest runway ' + c.rwyM + ' m' : '');

// Pure: the text block for the briefing prompt ('' when nothing usable).
function buildBlock(dep, arr, airportsMap, runways) {
  const exclude = [dep, arr];
  const arrC = nearestCandidates(arr, exclude, 4, airportsMap, runways);
  const depC = nearestCandidates(dep, exclude, 2, airportsMap, runways);
  if (!arrC.length && !depC.length) return '';
  const lines = ['CANDIDATE ALTERNATES (computed by the server from OurAirports data: scheduled-service aerodromes with a runway of at least 2,000 m, nearest first; their weather and NOTAMs were NOT checked):'];
  if (arrC.length) lines.push('Near ' + arr + ' (destination alternates): ' + arrC.map(fmt).join('; '));
  if (depC.length) lines.push('Near ' + dep + ' (take-off alternates): ' + depC.map(fmt).join('; '));
  lines.push('Use these as the named candidates in the ALTERNATE card and in the Dispatch Notes (ICAO code and name exactly as listed), labelled as candidates to verify. Do not invent other alternates.');
  return '\n' + lines.join('\n') + '\n';
}

function load(force) {
  if (loading) return loading;
  const now = Date.now();
  if (!force && airports && now - loadedAt < REFRESH_MS) return Promise.resolve();
  if (!force && !airports && now - lastAttempt < RETRY_MS) return Promise.resolve();
  lastAttempt = now;
  loading = Promise.all([httpGet(AIRPORTS_URL, 40000), httpGet(RUNWAYS_URL, 40000).catch(() => null)])
    .then(([a, r]) => {
      airports = buildAirports(a);
      rwyMaxFt = r ? buildRunwayLengths(r) : null;
      loadedAt = Date.now();
      console.log('[ALTERNATES] loaded:', airports.size, 'aerodromes,', rwyMaxFt ? rwyMaxFt.size + ' with runway lengths' : 'no runway lengths');
    })
    .catch(e => console.log('[ALTERNATES] load failed:', e.message))
    .finally(() => { loading = null; });
  return loading;
}

function init() {
  load(true);
  const t = setInterval(() => load(true), REFRESH_MS);
  if (t.unref) t.unref();
}

// Never throws; '' when the data is not loaded yet.
function candidateBlock(dep, arr) {
  try {
    if (!airports) return '';
    return buildBlock(String(dep || '').toUpperCase(), String(arr || '').toUpperCase(), airports, rwyMaxFt);
  } catch (e) { return ''; }
}

module.exports = { init, candidateBlock, buildAirports, buildRunwayLengths, nearestCandidates, buildBlock, distNm };
