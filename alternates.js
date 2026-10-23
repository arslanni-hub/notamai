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
let blockedPrefixes = [];         // ICAO prefixes of countries whose aerodromes are no-go / high-risk (risk.js conflictZones), set by the server
function setBlockedPrefixes(list) { blockedPrefixes = (list || []).map(p => String(p || '').toUpperCase()).filter(Boolean); }
const isBlocked = icao => blockedPrefixes.some(p => icao.startsWith(p));

let airports = null;              // Map<ICAO, { icao, name, city, country, lat, lon, cand:boolean }>
let rwyMaxFt = null;              // Map<ICAO, longest open runway in ft>
let searchIndex = null;           // [{ id, iata, codes:[...], name, city, country, type, n, c, rank }] for the airport search box
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
  const rows = Array.isArray(csv) ? csv : parseCsv(csv);
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

// Accent/case-insensitive key (Turkish dotless i included): "İstanbul" / "ıstanbul" / "ISTANBUL" -> "ISTANBUL".
function norm(t) {
  return String(t || '').replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}
const TYPE_RANK = { large_airport: 40, medium_airport: 30, small_airport: 15, seaplane_base: 5, heliport: 0 };

// Every open aerodrome (not only 4-letter idents) for the airport search box. The shown code is the ICAO code when
// OurAirports has one, else the GPS code, else the OurAirports ident (same as SkyLink's search, which serves this data).
function buildSearchIndex(csv) {
  const rows = Array.isArray(csv) ? csv : parseCsv(csv);
  const out = [];
  if (!rows.length) return out;
  const head = rows[0].map(h => h.trim());
  const ix = n => head.indexOf(n);
  const iIdent = ix('ident'), iType = ix('type'), iName = ix('name'), iCountry = ix('iso_country'), iCity = ix('municipality');
  const iIcao = ix('icao_code'), iGps = ix('gps_code'), iIata = ix('iata_code'), iSched = ix('scheduled_service');
  const iLat = ix('latitude_deg'), iLon = ix('longitude_deg');
  if (iIdent < 0 || iName < 0) throw new Error('unexpected airports.csv header');
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = (row[iType] || '').trim();
    if (!(type in TYPE_RANK)) continue;                       // closed, balloonport
    const ident = (row[iIdent] || '').trim().toUpperCase();
    const icao = iIcao >= 0 ? (row[iIcao] || '').trim().toUpperCase() : '';
    const gps = iGps >= 0 ? (row[iGps] || '').trim().toUpperCase() : '';
    const iata = iIata >= 0 ? (row[iIata] || '').trim().toUpperCase() : '';
    const id = icao || gps || ident;
    if (!id) continue;
    const name = (row[iName] || '').trim(), city = iCity >= 0 ? (row[iCity] || '').trim() : '';
    const codes = [...new Set([id, ident, icao, gps].filter(Boolean))];   // ICAO-style codes; IATA kept apart
    const rank = TYPE_RANK[type] + (iSched >= 0 && (row[iSched] || '').trim() === 'yes' ? 10 : 0);
    const lat = iLat >= 0 ? parseFloat(row[iLat]) : NaN, lon = iLon >= 0 ? parseFloat(row[iLon]) : NaN;
    out.push({ id, iata, codes, name, city, country: iCountry >= 0 ? (row[iCountry] || '').trim() : '', type, n: norm(name), c: norm(city), rank, lat: isFinite(lat) ? lat : null, lon: isFinite(lon) ? lon : null });
  }
  return out;
}

// Pure ranking: exact code > code prefix > name/city word start > name/city substring; within a group large > medium >
// small > heliport, scheduled service first; an ICAO-code prefix beats an IATA-code prefix. Nothing below 2 characters,
// substring (not word-start) text matches only from 3 characters.
function searchIn(index, query, limit) {
  const q = norm(query);
  limit = limit || 8;
  if (!index || q.length < 2) return [];
  const hits = [];
  for (const a of index) {
    let score = 0;
    if (a.codes.includes(q) || a.iata === q) score = 1000;
    else if (a.codes.some(c => c.startsWith(q))) score = 500;                 // "LT" -> LTAC, LTAI ... before LTN (Luton)
    else if (a.iata && a.iata.startsWith(q)) score = 400;
    else {
      const wordStart = s => s.startsWith(q) || s.includes(' ' + q) || s.includes('-' + q) || s.includes('/' + q);
      if (wordStart(a.n) || wordStart(a.c)) score = 200;
      else if (q.length >= 3 && (a.n.includes(q) || a.c.includes(q))) score = 100;
    }
    if (score) hits.push({ a, s: score + a.rank });
  }
  hits.sort((x, y) => y.s - x.s || x.a.id.localeCompare(y.a.id));
  const clean = t => String(t || '').replace(/[<>]/g, '');          // the page puts these into innerHTML
  return hits.slice(0, limit).map(h => ({ id: h.a.id, name: clean(h.a.name), country: clean(h.a.country), city: clean(h.a.city), iata: h.a.iata || undefined }));
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
    if (!a.cand || a.icao === icao || (exclude && exclude.includes(a.icao)) || isBlocked(a.icao)) continue;
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
  const lines = ['CANDIDATE ALTERNATES (computed by the server from OurAirports data: scheduled-service aerodromes with a runway of at least 2,000 m, nearest first, aerodromes in EASA/FAA no-go or high-risk conflict zones left out; their weather and NOTAMs were NOT checked):'];
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
      const rows = parseCsv(a);        // parsed once for both tables (the CSV is ~13 MB)
      airports = buildAirports(rows);
      try { searchIndex = buildSearchIndex(rows); } catch (e) { console.log('[AIRPORT SEARCH] index build failed:', e.message); }
      rwyMaxFt = r ? buildRunwayLengths(r) : null;
      loadedAt = Date.now();
      console.log('[ALTERNATES] loaded:', airports.size, 'aerodromes,', searchIndex ? searchIndex.length + ' in search index,' : 'no search index,', rwyMaxFt ? rwyMaxFt.size + ' with runway lengths' : 'no runway lengths');
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

// Aerodrome position by ICAO (or IATA / GPS / local) code from the search index: { id, name, lat, lon } or null.
// An exact ICAO-style code wins over an IATA code (prefers large/scheduled aerodromes when several share a code).
function airportPoint(code, index) {
  index = index || searchIndex;
  const q = String(code || '').trim().toUpperCase();
  if (!index || !q) return null;
  let best = null, bestScore = -1;
  for (const a of index) {
    if (a.lat === null || a.lon === null) continue;
    const sc = a.codes.includes(q) ? 2000 + a.rank : (a.iata === q ? 1000 + a.rank : -1);
    if (sc > bestScore) { best = a; bestScore = sc; }
  }
  return best ? { id: best.id, name: best.name, lat: best.lat, lon: best.lon } : null;
}

// Great-circle distance (NM) and initial true bearing (deg) — exact maths, same answer as the provider's /distance.
function distanceBearing(a, b) {
  const R = Math.PI / 180;
  const p1 = a.lat * R, p2 = b.lat * R, dl = (b.lon - a.lon) * R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const nm = 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const brg = (Math.atan2(y, x) / R + 360) % 360;
  return { distance: Math.round(nm * 10) / 10, bearing: Math.round(brg * 10) / 10 };
}

// /api/distance answer in the provider's shape, or null when either code is unknown / the index is not loaded.
function localDistance(from, to) {
  const a = airportPoint(from), b = airportPoint(to);
  if (!a || !b) return null;
  const d = distanceBearing(a, b);
  return { distance: d.distance, bearing: d.bearing, unit: 'nm', from_point: { icao: a.id, name: a.name, latitude: a.lat, longitude: a.lon }, to_point: { icao: b.id, name: b.name, latitude: b.lat, longitude: b.lon }, source: 'local' };
}

// null when the index is not loaded yet (the caller then falls back to SkyLink).
function searchAirports(query, limit) {
  if (!searchIndex || !searchIndex.length) return null;
  try { return searchIn(searchIndex, query, limit); } catch (e) { return null; }
}

module.exports = { init, setBlockedPrefixes, candidateBlock, searchAirports, airportPoint, distanceBearing, localDistance, buildSearchIndex, searchIn, norm, buildAirports, buildRunwayLengths, nearestCandidates, buildBlock, distNm };
