'use strict';
/**
 * Great-circle route -> FIRs it passes through.
 * Boundaries: fir-boundaries.json (VATSIM VATSpy data project, simplified to ~2 km). They are a navigation-planning approximation,
 * not an official ICAO/AIP source: a route within a few NM of a border can be classified either way, hence the corridor.
 *   track — FIRs the great-circle centre line enters, in order
 *   near  — FIRs only touched within `corridorNm` of the centre line (not on it)
 */
const fs = require('fs');
const path = require('path');

let DATA = null;
function load() {
  if (DATA) return DATA;
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fir-boundaries.json'), 'utf8'));
  DATA = { asOf: j.asOf, list: [] };
  for (const [id, rings] of Object.entries(j.firs)) for (const r of rings) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
    DATA.list.push({ id, r, x0, x1, y0, y1 });
  }
  return DATA;
}
function inRing(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function firsAt(lat, lon) {
  const out = new Set();
  for (const f of load().list) if (lon >= f.x0 && lon <= f.x1 && lat >= f.y0 && lat <= f.y1 && inRing(f.r, lon, lat)) out.add(f.id);
  return out;
}
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI, R_NM = 3440.065;
function interp(a, b, f) {
  const p1 = rad(a.lat), l1 = rad(a.lon), p2 = rad(b.lat), l2 = rad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2), y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2), z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)), d: d * R_NM };
}
function bearingRad(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
}
function offset(p, brg, nm) {
  const d = nm / R_NM, p1 = rad(p.lat), l1 = rad(p.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
}
/** @returns {{track:string[], near:string[], asOf:string}} */
function routeFirs(dep, arr, opts) {
  const corridorNm = (opts && opts.corridorNm) || 50, stepNm = (opts && opts.stepNm) || 15;
  const total = interp(dep, arr, 0.5).d * 2 || 0;   // (interp returns the whole-arc length in .d)
  const n = Math.max(2, Math.ceil(total / stepNm));
  const track = [], near = new Set();
  for (let i = 0; i <= n; i++) {
    const p = interp(dep, arr, i / n);
    for (const id of firsAt(p.lat, p.lon)) if (!track.includes(id)) track.push(id);
    const brg = bearingRad(p, arr);
    for (const s of [-1, -0.5, 0.5, 1]) {
      const q = offset(p, brg + Math.PI / 2, s * corridorNm);
      for (const id of firsAt(q.lat, q.lon)) near.add(id);
    }
  }
  return { track, near: [...near].filter(x => !track.includes(x)), asOf: load().asOf };
}
// keep the part of a [lon,lat] ring on one side of a meridian / parallel (Sutherland–Hodgman; axis 0 = lon, 1 = lat;
// keepBelow: keep values <= v, else >= v; open ring in, open ring out)
function clipAxis(ring, axis, v, keepBelow) {
  const out = [], pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const inside = q => keepBelow ? q[axis] <= v : q[axis] >= v;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], ina = inside(a), inb = inside(b);
    if (ina) out.push(a);
    if (ina !== inb) { const t = (v - a[axis]) / (b[axis] - a[axis]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
// v3.104: for the loading-screen animation — FIRs along the great circle with the fraction of the route where each is entered
// and left, plus their (simplified) boundary rings as [lon,lat] pairs. Cached per route.
const timelineCache = new Map();
function routeFirTimeline(dep, arr) {
  const key = [dep.lat, dep.lon, arr.lat, arr.lon].map(v => v.toFixed(3)).join(',');
  if (timelineCache.has(key)) return timelineCache.get(key);
  const total = interp(dep, arr, 0.5).d * 2 || 0;
  const n = Math.min(600, Math.max(20, Math.ceil(total / 10)));
  const seen = new Map();
  for (let i = 0; i <= n; i++) {
    const f = i / n, p = interp(dep, arr, f);
    for (const id of firsAt(p.lat, p.lon)) { const s = seen.get(id); if (s) s.to = f; else seen.set(id, { id, from: f, to: f }); }
  }
  // drop VATSIM helper regions (…XX) and sub-sectors that span exactly the same stretch as an earlier FIR
  const firs = [];
  for (const f of [...seen.values()].sort((a, b) => a.from - b.from)) {
    if (/XX$/.test(f.id)) continue;
    if (firs.some(k => Math.abs(k.from - f.from) < 0.012 && Math.abs(k.to - f.to) < 0.012)) continue;
    firs.push(f);
  }
  const ids = new Set(firs.map(f => f.id));
  const rings = [], biggest = new Map();   // v3.107: largest ring per FIR only (no TMA/CTR-sized pieces)
  for (const f of load().list) if (ids.has(f.id)) {
    const a = (f.x1 - f.x0) * (f.y1 - f.y0), b = biggest.get(f.id);
    if (!b || a > b.a) biggest.set(f.id, { a, f });
  }
  for (const { f } of biggest.values()) {
    const pts = f.r.length / 2, step = Math.max(1, Math.ceil(pts / 300)), ring = [];
    for (let i = 0; i < f.r.length; i += 2 * step) ring.push([f.r[i], f.r[i + 1]]);
    ring.push([f.r[0], f.r[1]]);
    rings.push({ id: f.id, ring });
  }
  // v3.106: conflict zones (risk.js CONFIG.conflictZones, defined by FIR codes) the route crosses, comes within ~120 NM of, or starts/ends in
  const zones = [];
  try {
    const cz = require('./risk').CONFIG.conflictZones || [];
    const near = new Set(routeFirs(dep, arr, { corridorNm: 120, stepNm: 25 }).near);
    for (const z of cz) {
      const zf = z.firs || [];
      const atEnd = [dep.id, arr.id].some(ic => ic && (z.prefixes || []).some(p => String(ic).toUpperCase().startsWith(p)));
      const maxLon = (z.map && z.map.maxLon) || {}, minLat = (z.map && z.map.minLat) || {};
      // v3.108: a FIR that only counts west of a longitude (Muscat FIR west of 58°E) is crossed only where the route is west of it
      const crossed = zf.map(id => {
        if (maxLon[id] == null) return seen.get(id);
        let c = null;
        for (let i = 0; i <= n; i++) { const f = i / n, q = interp(dep, arr, f); if (q.lon <= maxLon[id] && (minLat[id] == null || q.lat >= minLat[id]) && firsAt(q.lat, q.lon).has(id)) { if (c) c.to = f; else c = { from: f, to: f }; } }
        return c;
      }).filter(Boolean);
      const isNear = zf.some(id => near.has(id));
      if (!zf.length || (!crossed.length && !isNear && !atEnd)) continue;
      const level = atEnd ? (z.endpoint || z.crossing || 'INFO') : crossed.length ? (z.crossing || 'INFO') : 'INFO';
      // v3.107: one outline per FIR — its largest ring only (VATSIM data also holds TMA/CTR-sized pieces under the same code)
      const best = new Map();
      for (const f of load().list) if (zf.includes(f.id)) {
        const a = (f.x1 - f.x0) * (f.y1 - f.y0), b = best.get(f.id);
        if (!b || a > b.a) best.set(f.id, { a, f });
      }
      const zr = [];
      for (const { f } of best.values()) {
        const pts = f.r.length / 2, step = Math.max(1, Math.ceil(pts / 150));
        let ring = [];
        for (let i = 0; i < f.r.length; i += 2 * step) ring.push([f.r[i], f.r[i + 1]]);
        if (maxLon[f.id] != null) ring = clipAxis(ring, 0, maxLon[f.id], true);
        if (minLat[f.id] != null && ring.length >= 3) ring = clipAxis(ring, 1, minLat[f.id], false);
        if (ring.length < 3) continue;
        ring.push(ring[0].slice());
        zr.push(ring);
      }
      zones.push({ name: z.name, level, waterOnly: !!(z.map && z.map.waterOnly), crossing: crossed.length > 0, atEnd, from: crossed.length ? Math.min(...crossed.map(c => c.from)) : null, to: crossed.length ? Math.max(...crossed.map(c => c.to)) : null, src: String(z.src || '').split(';')[0], rings: zr });
    }
  } catch (e) { /* zones optional */ }
  const out = { firs, rings, zones, totalNm: Math.round(total) };
  if (timelineCache.size > 500) timelineCache.clear();
  timelineCache.set(key, out);
  return out;
}
module.exports = { routeFirs, firsAt, routeFirTimeline };
