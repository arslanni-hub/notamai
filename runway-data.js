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

let table = null;        // Map<ICAO, Set<runway-pair-key>> (open runways only)
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
  if (iIdent < 0 || iLe < 0 || iHe < 0) throw new Error('unexpected runways.csv header');
  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const ident = (row[iIdent] || '').trim().toUpperCase();
    if (!ident) continue;
    if (iClosed >= 0 && (row[iClosed] || '').trim() === '1') continue;   // permanently closed runway
    const des = [row[iLe], row[iHe]].map(x => (x || '').trim().toUpperCase()).find(x => /^\d{2}[LRC]?$/.test(x));
    if (!des) continue;                                                    // helipads and odd identifiers
    if (!map.has(ident)) map.set(ident, new Set());
    map.get(ident).add(rwyKey(des));
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

function awcCountFromData(data) {
  const apt = Array.isArray(data) ? data[0] : null;
  if (!apt || !Array.isArray(apt.runways)) return null;
  const set = new Set();
  for (const r of apt.runways) {
    for (const m of String((r && (r.id || r.runway)) || '').toUpperCase().matchAll(/\d{2}[LRC]?/g)) set.add(rwyKey(m[0]));
  }
  return set.size || null;
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function awcCount(icao, fetchJson) {
  const hit = awcCache.get(icao);
  if (hit && Date.now() - hit.t < AWC_TTL_MS) return hit.count;
  const data = await withTimeout(fetchJson(`https://aviationweather.gov/api/data/airport?ids=${icao}&format=json`), AWC_TIMEOUT_MS);
  const count = awcCountFromData(data);
  awcCache.set(icao, { t: Date.now(), count });
  return count;
}

async function getRunwaySources(icao, opts) {
  const out = [];
  icao = String(icao || '').toUpperCase();
  if (!icao) return out;
  try {
    if (!table) await withTimeout(load(false), LOAD_WAIT_MS).catch(() => {});
    const set = table && table.get(icao);
    if (set && set.size) out.push({ name: 'ourairports', count: set.size });
  } catch (e) { /* source omitted */ }
  try {
    const fetchJson = opts && opts.fetchJson;
    if (fetchJson) {
      const c = await awcCount(icao, fetchJson);
      if (c) out.push({ name: 'awc', count: c });
    }
  } catch (e) { /* source omitted */ }
  return out;
}

module.exports = { init, load, getRunwaySources, _buildTable: buildTable, _awcCountFromData: awcCountFromData, _parseCsv: parseCsv, _setTable: t => { table = t; loadedAt = Date.now(); }, _clearAwcCache: () => awcCache.clear() };
