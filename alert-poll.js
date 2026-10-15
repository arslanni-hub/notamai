'use strict';
/**
 * NOTAM alert polling — pure helpers (no I/O), unit-tested in alert-poll.test.js.
 *
 * One shared state per airport/FIR (not per user alert):
 *   - how often it must be checked depends on the highest plan among its subscribers
 *   - ANY fresh fetch of that airport (briefing, raw NOTAM panel, an earlier poll) counts as a poll: the stored response is diffed
 *     instead of calling the provider again
 *   - the diff is against the set of NOTAM ids already seen, so several new NOTAMs in one interval are all reported
 */
const INTERVAL_MIN = { pro: 60, max: 30, enterprise: 30, admin: 30 };
const DEFAULT_INTERVAL_MIN = 60;
const KNOWN_CAP = 600;

/** Interval (ms) for an airport = the shortest interval among its subscribers' plans. */
function intervalMsFor(plans) {
  const mins = (plans || []).map(p => INTERVAL_MIN[p] || DEFAULT_INTERVAL_MIN);
  return (mins.length ? Math.min(...mins) : DEFAULT_INTERVAL_MIN) * 60 * 1000;
}

function idOfNotam(n) {
  let id = (n && (n.notam_id || n.id)) || '';
  if (!id && n && n.raw) { const m = String(n.raw).match(/([A-Z]\d{3,5}\/\d{2,4})/); if (m) id = m[1]; }
  return String(id || '').trim();
}
function extractIds(notams) {
  return [...new Set((notams || []).map(idOfNotam).filter(Boolean))];
}

/**
 * What to do for one airport at this tick.
 *  state:  { lastCheckedAt } — time of the last diff (any source)
 *  stored: { t } — time of the newest stored provider response for this airport (any source), or null
 * Returns 'skip' (not due), 'diff-stored' (a fresh response already exists — diff it, no provider call) or 'fetch'.
 */
function planAction({ now, intervalMs, state, stored }) {
  const last = state && state.lastCheckedAt ? state.lastCheckedAt : 0;
  if (stored && stored.t > last) return 'diff-stored';   // someone fetched it since the last diff: free
  if (now - last >= intervalMs - 1000) return 'fetch';
  return 'skip';
}

/** New ids since the last diff. known === null -> first sight: baseline only, nothing is reported. */
function diffIds(known, currentIds) {
  if (!known) return { baseline: true, fresh: [] };
  const k = new Set(known);
  return { baseline: false, fresh: currentIds.filter(id => !k.has(id)) };
}
function mergeKnown(known, currentIds, cap) {
  const out = [...new Set([...(known || []), ...currentIds])];
  return out.length > (cap || KNOWN_CAP) ? out.slice(out.length - (cap || KNOWN_CAP)) : out;
}

/** Text for one alert e-mail: the new NOTAMs (newest first as given), capped, with a count of the rest. */
function digestText(freshNotams, cap) {
  const c = cap || 5;
  const shown = freshNotams.slice(0, c).map(n => String(n.raw || idOfNotam(n)).trim());
  let t = shown.join('\n\n— — —\n\n');
  if (freshNotams.length > c) t += `\n\n(+${freshNotams.length - c} more new NOTAMs — see the NOTAMs & MET panel)`;
  return t;
}

module.exports = { INTERVAL_MIN, intervalMsFor, extractIds, idOfNotam, planAction, diffIds, mergeKnown, digestText };
