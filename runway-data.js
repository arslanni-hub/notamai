'use strict';
/**
 * Runway-count data sources for the risk rubric.
 *
 *  1. OurAirports runways.csv  — global, free, refreshed daily. Downloaded by the server, kept in memory.
 *  2. aviationweather.gov airport API — live per-aerodrome lookup, cached 12 h.
 *
 * getRunwaySources(icao) returns [{ name, count }] for the sources that answered. The rubric
 * (risk.js -> resolveRunwayCount) combines them. Nothing here ever throws into the briefing flow:
 * a failing source is simply omitted, and the rubric then falls back to its conservative rule.
 */
const https = require('https');
const { rwyKey } = require('./risk');

const OURAIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const REFRESH_MS = 24 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const AWC_TTL_MS = 12 * 3600 * 1000;
const AWC_TIMEOUT_MS = 3500;
const LOAD_WAIT_MS = 4000;

let table = null;        // Map<ICAO, { keys:Set<runway-pair-key>, lats:[], lons:[] }> (open runways only)
let loadedAt = 0;
let lastAttempt = 0;
let loading = null;
const awcCache = new Map(); // ICAO -> { t, count }

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

// Minimal CSV parser (handles quoted fields, commas and escaped quotes inside quotes).
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

function buildTable(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return new Map();
  const head = rows[0].map(h => h.trim());
  const ix = name => head.indexOf(name);
  const iIdent = ix('airport_ident'), iClosed = ix('closed'), iLe = ix('le_ident'), iHe = ix('he_ident');
  const iLeLat = ix('le_latitude_deg'), iLeLon = ix('le_longitude_deg'), iHeLat = ix('he_latitude_deg'), iHeLon = ix('he_longitude_deg');
  if (iIdent < 0 || iLe < 0 || iHe < 0) throw new Error('unexpected runways.csv header');
  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const ident = (row[iIdent] || '').trim().toUpperCase();
    if (!ident) continue;
    if (iClosed >= 0 && (row[iClosed] || '').trim() === '1') continue;   // permanently closed runway
    const des = [row[iLe], row[iHe]].map(x => (x || '').trim().toUpperCase()).find(x => /^\d{2}[LRC]?$/.test(x));
    if (!des) continue;                                                    // helipads and odd identifiers
    if (!map.has(ident)) map.set(ident, { keys: new Set(), lats: [], lons: [] });
    const rec = map.get(ident);
    rec.keys.add(rwyKey(des));
    [[iLeLat, iLeLon], [iHeLat, iHeLon]].forEach(([ia, io]) => {
      const la = parseFloat(row[ia]), lo = parseFloat(row[io]);
      if (ia >= 0 && io >= 0 && isFinite(la) && isFinite(lo)) { rec.lats.push(la); rec.lons.push(lo); }
    });
  }
  return map;
}

function load(force) {
  if (loading) return loading;
  const now = Date.now();
  if (!force && table && now - loadedAt < REFRESH_MS) return Promise.resolve();
  if (!force && !table && now - lastAttempt < RETRY_MS) return Promise.resolve();
  lastAttempt = now;
  loading = httpGet(OURAIRPORTS_URL, 25000)
    .then(text => { table = buildTable(text); loadedAt = Date.now(); console.log('[RUNWAY DATA] OurAirports loaded:', table.size, 'aerodromes'); })
    .catch(e => console.log('[RUNWAY DATA] OurAirports load failed:', e.message))
    .finally(() => { loading = null; });
  return loading;
}

function init() {
  load(true);
  const t = setInterval(() => load(true), REFRESH_MS);
  if (t.unref) t.unref();
}

function awcInfoFromData(data) {
  const apt = Array.isArray(data) ? data[0] : null;
  if (!apt) return null;
  const set = new Set();
  if (Array.isArray(apt.runways)) {
    for (const r of apt.runways) {
      for (const m of String((r && (r.id || r.runway)) || '').toUpperCase().matchAll(/\d{2}[LRC]?/g)) set.add(rwyKey(m[0]));
    }
  }
  const lat = parseFloat(apt.lat), lon = parseFloat(apt.lon);
  return { count: set.size || null, keys: [...set], pos: isFinite(lat) && isFinite(lon) ? { lat, lon } : null };
}
function awcCountFromData(data) { const i = awcInfoFromData(data); return i ? i.count : null; }

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function awcInfo(icao, fetchJson) {
  const hit = awcCache.get(icao);
  if (hit && Date.now() - hit.t < AWC_TTL_MS) return hit.info;
  const data = await withTimeout(fetchJson(`https://aviationweather.gov/api/data/airport?ids=${icao}&format=json`), AWC_TIMEOUT_MS);
  const info = awcInfoFromData(data);
  awcCache.set(icao, { t: Date.now(), info });
  return info;
}

async function getRunwaySources(icao, opts) {
  const out = [];
  icao = String(icao || '').toUpperCase();
  if (!icao) return out;
  try {
    if (!table) await withTimeout(load(false), LOAD_WAIT_MS).catch(() => {});
    const rec = table && table.get(icao);
    if (rec && rec.keys.size) out.push({ name: 'ourairports', count: rec.keys.size, keys: [...rec.keys].sort() });
  } catch (e) { /* source omitted */ }
  try {
    const fetchJson = opts && opts.fetchJson;
    if (fetchJson) {
      const info = await awcInfo(icao, fetchJson);
      if (info && info.count) out.push({ name: 'awc', count: info.count, keys: info.keys.slice().sort() });
    }
  } catch (e) { /* source omitted */ }
  return out;
}

// Aerodrome position: mean of runway-end coordinates (OurAirports), else the aviationweather.gov airport record.
async function getAirportPosition(icao, opts) {
  icao = String(icao || '').toUpperCase();
  if (!icao) return null;
  try {
    if (!table) await withTimeout(load(false), LOAD_WAIT_MS).catch(() => {});
    const rec = table && table.get(icao);
    if (rec && rec.lats.length) {
      const m = a => a.reduce((x, y) => x + y, 0) / a.length;
      return { lat: m(rec.lats), lon: m(rec.lons) };
    }
  } catch (e) { /* fall through */ }
  try {
    const fetchJson = opts && opts.fetchJson;
    if (fetchJson) { const i = await awcInfo(icao, fetchJson); if (i && i.pos) return i.pos; }
  } catch (e) { /* no position */ }
  return null;
}

module.exports = { init, getAirportPosition, load, getRunwaySources, _buildTable: buildTable, _awcCountFromData: awcCountFromData, _parseCsv: parseCsv, _setTable: t => { table = t; loadedAt = Date.now(); }, _clearAwcCache: () => awcCache.clear() };
