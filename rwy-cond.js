// Runway surface condition helpers (v3.149) — shared by the server (risk rubric, briefing prompt) and the page
// (NOTAMs & MET panel, served as /rwy-cond.js). No dependencies.
//
// Sources we actually have:
//   1. METAR runway state groups  R06L/450243, R24/CLRD62, R/SNOCLO (WMO FM-15 / ICAO Annex 3; reported in Europe/Russia/CIS)
//   2. Runway-condition NOTAMs: US FICON NOTAMs and Canadian RSC NOTAMs (RWYCC a/b/c per runway third; Canada replaced the SNOWTAM
//      with the RSC NOTAM on 12 Aug 2021 and distributes it to the US), ICAO-style RWYCC / braking action / friction wording
// Not available: international SNOWTAMs in the ICAO GRF format — the FAA NOTAM system (SkyLink's source) does not ingest or
// distribute them (FAA safety alert USNOF 21-02, Sep 2021, still in force). Never claim "no SNOWTAM".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RwyCond = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEPOSIT = { '0': 'clear and dry', '1': 'damp', '2': 'wet or water patches', '3': 'rime or frost', '4': 'dry snow', '5': 'wet snow', '6': 'slush', '7': 'ice', '8': 'compacted or rolled snow', '9': 'frozen ruts or ridges' };
  const EXTENT = { '1': '≤10%', '2': '11–25%', '5': '26–50%', '9': '51–100%' };
  const BRAKE_WORD = { 0: 'NIL', 1: 'POOR', 2: 'MEDIUM TO POOR', 3: 'MEDIUM', 4: 'GOOD TO MEDIUM', 5: 'GOOD', 6: 'DRY' };

  function depthText(ee) {
    if (ee === '//') return null;
    const n = parseInt(ee, 10);
    if (isNaN(n)) return null;
    if (n === 0) return '<1 mm';
    if (n <= 90) return n + ' mm';
    const cm = { 92: '10 cm', 93: '15 cm', 94: '20 cm', 95: '25 cm', 96: '30 cm', 97: '35 cm', 98: '40 cm or more' };
    if (cm[n]) return cm[n];
    if (n === 99) return 'runway not operational (snow, slush, ice, drifts or clearance)';
    return null;
  }

  // Friction coefficient (old ICAO table) -> braking level 1..5, same scale as the RWYCC (5 good … 1 poor)
  function levelOfFriction(mu) {
    if (mu >= 0.40) return 5;
    if (mu >= 0.36) return 4;
    if (mu >= 0.30) return 3;
    if (mu >= 0.26) return 2;
    return 1;
  }
  function brakingOf(bb) {
    if (bb === '//' || bb == null) return null;
    const n = parseInt(bb, 10);
    if (isNaN(n)) return null;
    if (n >= 1 && n <= 90) { const mu = n / 100; return { level: levelOfFriction(mu), text: 'friction ' + mu.toFixed(2) + ' (' + BRAKE_WORD[levelOfFriction(mu)].toLowerCase() + ')' }; }
    const est = { 91: 1, 92: 2, 93: 3, 94: 4, 95: 5 };
    if (est[n]) return { level: est[n], text: 'braking ' + BRAKE_WORD[est[n]].toLowerCase() };
    if (n === 99) return { level: null, text: 'braking unreliable / not measurable' };
    return null;
  }

  function rwyName(dd) {
    if (dd === '88') return 'ALL RWYS';
    if (dd === '99') return 'REPEAT';
    const m = /^(\d{2})([LCR]?)$/.exec(dd);
    if (!m) return dd;
    const n = parseInt(m[1], 10);
    if (!m[2] && n > 50 && n <= 86) return String(n - 50).padStart(2, '0') + 'R';   // old convention: 50 + designator = right runway
    return dd;
  }

  // Tier per the decision of 6 Nov 2026 (ICAO GRF / RCAM): level 0–1 or depth "99" or SNOCLO -> 1; level 2–3 -> 2; contaminated but 4–5 -> 3
  function tierOf(level, contaminated, nonOperational) {
    if (nonOperational) return 1;
    if (level != null) {
      if (level <= 1) return 1;
      if (level <= 3) return 2;
    }
    return contaminated ? 3 : null;
  }

  // METAR runway state groups. Returns [{ rwy, raw, deposit, extent, depth, braking, level, contaminated, tier, text }]
  // plus { snoclo: true } entries. Only the part before RMK is read; R-prefixed groups only (the old 8-digit form is not parsed).
  function parseMetar(metar) {
    const out = [];
    if (!metar) return out;
    const body = String(metar).toUpperCase().split(/\sRMK\s/)[0];
    const toks = body.split(/\s+/);
    for (const t of toks) {
      if (t === 'SNOCLO' || t === 'R/SNOCLO') { out.push({ rwy: 'AERODROME', raw: t, snoclo: true, tier: 1, level: null, contaminated: true, text: 'aerodrome closed due to snow (SNOCLO)' }); continue; }
      let m = /^R(\d{2}[LCR]?)\/CLRD(\d{2}|\/\/)$/.exec(t);
      if (m) {
        const br = brakingOf(m[2]);
        const level = br ? br.level : null;
        out.push({ rwy: rwyName(m[1]), raw: t, cleared: true, braking: br ? br.text : null, level, contaminated: false, tier: tierOf(level, false, false), text: 'contamination cleared' + (br ? ', ' + br.text : '') });
        continue;
      }
      m = /^R(\d{2}[LCR]?)\/([0-9\/])([1259\/])(\d{2}|\/\/)(\d{2}|\/\/)$/.exec(t);
      if (!m) continue;
      const rwy = rwyName(m[1]);
      if (rwy === 'REPEAT') continue;
      const deposit = DEPOSIT[m[2]] || null, extent = EXTENT[m[3]] || null, depth = depthText(m[4]);
      const br = brakingOf(m[5]);
      const nonOp = m[4] === '99';
      const contaminated = /^[3-9]$/.test(m[2]) || (m[2] === '2' && parseInt(m[4], 10) > 3 && parseInt(m[4], 10) <= 90);   // standing water > 3 mm counts
      const level = br ? br.level : null;
      const parts = [deposit || 'deposit not reported'];
      if (extent) parts.push(extent);
      if (depth) parts.push(depth);
      if (br) parts.push(br.text);
      out.push({ rwy, raw: t, deposit, extent, depth, braking: br ? br.text : null, level, contaminated, nonOperational: nonOp, tier: tierOf(level, contaminated, nonOp), text: parts.join(', ') });
    }
    return out;
  }

  const BRAKE_RX = /\b(?:BA|BRAKING\s+ACTION|BRKG\s+ACT(?:ION)?)\s+(NIL|POOR|MEDIUM[\s-]+TO[\s-]+POOR|MEDIUM[\s-]POOR|MEDIUM|MED|GOOD[\s-]+TO[\s-]+MEDIUM|GOOD[\s-]MEDIUM|GOOD)\b/;
  const BRAKE_LEVEL = w => {
    w = w.replace(/[\s-]+/g, ' ');
    if (w === 'NIL') return 0; if (w === 'POOR') return 1;
    if (/^MEDIUM (TO )?POOR$/.test(w)) return 2; if (w === 'MEDIUM' || w === 'MED') return 3;
    if (/^GOOD (TO )?MEDIUM$/.test(w)) return 4; return 5;
  };
  const CONTAM_RX = /\b(WET\s+SN(?:OW)?|DRY\s+SN(?:OW)?|SLUSH|WET\s+ICE|ICE|FROST|COMPACTED\s+SN(?:OW)?|COMPACT\s+SN|STANDING\s+WATER|SN(?:OW)?|SNOWBANKS?|SN\s+BANKS?|FROZEN\s+RUTS|RUTS|CONTAMINA\w*)\b/;

  // A runway-condition NOTAM (FICON, RWYCC, braking action, friction). Returns null when the text is not one.
  function parseNotam(text) {
    const t = String(text || '').toUpperCase().replace(/\s+/g, ' ');
    const isFicon = /\bFICON\b/.test(t), isSnowtam = /\bSNOWTAM\b/.test(t);
    // Canada (v3.150): "RSC 05 3/5/3 30 PCT 1/8IN DRY SNOW…" / "RSC 03/21 60 PCT 1/4IN DRY SNOW…" — the runway follows RSC, no 'RWY' word
    const rscM = /\bRSC\s+(\d{2}[LCR]?(?:\/\d{2}[LCR]?)?)\b/.exec(t);
    const isRsc = !!rscM;
    const codesM = /\b(?:FICON|RWYCC|RWY\s+COND(?:ITION)?\s+CODES?)\s*([0-6])\/([0-6])\/([0-6])\b/.exec(t) || /\bRSC\s+\d{2}[LCR]?(?:\/\d{2}[LCR]?)?\s+([0-6])\/([0-6])\/([0-6])\b/.exec(t);
    const brM = BRAKE_RX.exec(t);
    const muM = /\b(?:FRICTION|FRICTION\s+COEF\w*|MU|COEFFICIENT)\s*(?:VALUES?\s*)?(0?[.,]\d{2}|\d{2}\b)/.exec(t);
    if (!isFicon && !isSnowtam && !isRsc && !codesM && !brM && !muM) return null;
    const rwyM = /\bRWY\s+(\d{2}[LCR]?(?:\/\d{2}[LCR]?)?)\b/.exec(t) || rscM;
    const isTaxiOrApron = !rwyM && /\b(TWY|TAXIWAY|APRON|APN|RAMP)\b/.test(t);
    const deicing = /\b(?:DE-?IC|ANTI-?IC)/.test(t);
    const contamM = CONTAM_RX.exec(t.replace(/\b(?:DE|ANTI)-?IC\w*/g, ''));
    const contaminated = !!contamM;
    let level = null; const parts = [];
    if (codesM) { const cs = [codesM[1], codesM[2], codesM[3]].map(Number); level = Math.min(...cs); parts.push('RWYCC ' + cs.join('/')); }
    if (brM) { const bl = BRAKE_LEVEL(brM[1]); level = level == null ? bl : Math.min(level, bl); parts.push('braking ' + BRAKE_WORD[bl].toLowerCase()); }
    if (muM) { let v = muM[1].replace(',', '.'); const mu = v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10) / 100; if (mu > 0 && mu < 1) { const fl = levelOfFriction(mu); level = level == null ? fl : Math.min(level, fl); parts.push('friction ' + mu.toFixed(2)); } }
    if (contamM) parts.push(contamM[1].replace(/\s+/g, ' ').toLowerCase());
    const scored = !isTaxiOrApron && !deicing;
    return {
      rwy: rwyM ? rwyM[1] : (isTaxiOrApron ? 'TWY/APRON' : null),
      kind: isFicon ? 'FICON' : isRsc ? 'RSC' : isSnowtam ? 'SNOWTAM' : 'RWY COND',
      level, contaminated,
      tier: scored ? tierOf(level, contaminated, false) : null,
      text: parts.join(', ') || (isFicon ? 'field condition report' : isRsc ? 'runway surface condition report' : 'runway condition report'),
    };
  }

  // Panel / severity category of a NOTAM text: 'rwy' (SNOWTAM / runway surface), 'bird', 'ash' or null
  function category(text) {
    const t = String(text || '').toUpperCase();
    if (/\bASHTAM\b|\bVOLCAN\w*|\bVOLCANIC\s+ASH\b|\bASH\s+(?:CLOUD|CLD|PLUME|FALL)|\bVA\s+(?:CLD|CLOUD|ADVISORY)|\bERUPTI\w*|\bVAAC\b|Q\)\s*[A-Z]{4}\/QWW/.test(t)) return 'ash';
    if (/\bSNOWTAM\b|\bFICON\b|\bRSC\s+\d{2}|\bRWYCC\b|\bBRAKING\s+ACTION\b|\bBA\s+(?:NIL|POOR|MEDIUM|GOOD)\b|\bFRICTION\b|\bSNOW\s*(?:REMOVAL|CLEARANCE|CLEARING|PLOUGH\w*|PLOW\w*|BANKS?)\b|\bSN\s*(?:BANKS?|REMOVAL)\b/.test(t)) return 'rwy';
    if (/\b(?:RWY|TWY|APRON|APN)\b/.test(t) && /\b(?:SLUSH|(?<!DE-|ANTI-)ICE|ICY|FROST|COMPACTED\s+SN\w*|WET\s+SN\w*|DRY\s+SN\w*|STANDING\s+WATER|CONTAMINA\w*|SNOW)\b/.test(t)) return 'rwy';
    if (/\bBIRDTAM\b|\bBIRDS?\b|\bBIRD\s*STRIKE|\bWILDLIFE\b|\bBIRD\s+(?:ACT\w*|HAZARD|CONCENTRATION|MIGRATION)/.test(t)) return 'bird';
    return null;
  }

  // Winter conditions that make a missing SNOWTAM matter: snow/ice precipitation or freezing phenomena in METAR/TAF,
  // a runway state group, or a METAR temperature of +3 °C or below.
  function winterHint(metar, taf) {
    const reasons = [];
    const M = String(metar || '').toUpperCase().split(/\sRMK\s/)[0], T = String(taf || '').toUpperCase();
    // weather tokens only (e.g. -SN, +SHSN, -RASN, FZRA, BLSN, FZFG, PL, IC); snow/ice or freezing must be part of it
    const winterTok = s => s.split(/\s+/).some(x => /^[-+]?(?:VC)?(?:MI|BC|PR|DR|BL|SH|TS|FZ|RA|DZ|SN|SG|PL|IC|GS|FG|UP)+$/.test(x) && /SN|SG|PL|IC|FZ/.test(x.replace(/^[-+]?VC/, '')));
    if (winterTok(M)) reasons.push('snow/ice or freezing weather in the METAR');
    else if (winterTok(T)) reasons.push('snow/ice or freezing weather in the TAF');
    if (parseMetar(metar).length) reasons.push('runway state group in the METAR');
    const tm = /\s(M?\d{2})\/(M?\d{2})?\s/.exec(' ' + M + ' ');
    if (tm) { const temp = parseInt(tm[1].replace('M', '-'), 10); if (!isNaN(temp) && temp <= 3) reasons.push('temperature ' + (temp > 0 ? '+' : '') + temp + ' °C'); }
    return reasons;
  }

  // US aerodromes report runway conditions as FICON NOTAMs and Canadian ones as RSC NOTAMs — both are in the feed; elsewhere the
  // SNOWTAM is the source we don't have. usesFicon kept as the name for both (true for K…, P…, C…).
  const usesFicon = icao => /^[KPC]/.test(String(icao || '').toUpperCase());
  const notamFormatOf = icao => /^C/.test(String(icao || '').toUpperCase()) ? 'RSC' : 'FICON';

  return { parseMetar, parseNotam, category, winterHint, usesFicon, notamFormatOf, tierOf, BRAKE_WORD };
});
