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
module.exports = { routeFirs, firsAt };
