const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTAMIFY_KEY = process.env.NOTAMIFY_KEY;
const PORT = process.env.PORT || 3000;

const AIRPORT_NAMES = {
  LTFM: 'Istanbul Airport (IST)',
  LTBA: 'Istanbul Atatürk Airport (closed)',
  LTAI: 'Antalya Airport',
  LTFD: 'Balıkesir Koca Seyit Airport',
  LTBJ: 'İzmir Adnan Menderes Airport',
  LTAC: 'Ankara Esenboğa Airport',
  LTFE: 'Dalaman Airport',
  LTBS: 'Bodrum Milas Airport',
  EGLL: 'London Heathrow',
  EGKK: 'London Gatwick',
  EHAM: 'Amsterdam Schiphol',
  EDDF: 'Frankfurt Airport',
  LFPG: 'Paris Charles de Gaulle',
  LEMD: 'Madrid Barajas',
  LIRF: 'Rome Fiumicino',
  LSZH: 'Zurich Airport',
  LOWW: 'Vienna International Airport',
  EKCH: 'Copenhagen Airport',
};

function airportName(icao) {
  return icao ? (AIRPORT_NAMES[icao.toUpperCase()] || icao) : '';
}

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchNotams(icao) {
  if (!icao) return '';
  try {
    const url = `https://skylink-api.p.rapidapi.com/notams/${icao}`;
    const data = await fetchURL(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': process.env.SKYLINK_KEY,
        'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
      }
    });
    if (data.error || !data.notams || data.notams.length === 0) return `No active NOTAMs for ${icao}.`;
    const now = new Date();
    const activeNotams = data.notams.filter(n => {
      if (!n.expiration) return true;
      if (n.expiration.length < 12) return true;
      const e = n.expiration;
      const expDate = new Date(Date.UTC(
        parseInt(e.slice(0,4)),
        parseInt(e.slice(4,6)) - 1,
        parseInt(e.slice(6,8)),
        parseInt(e.slice(8,10)),
        parseInt(e.slice(10,12))
      ));
      return expDate > now;
    });
    console.log('[FILTER]', icao, 'total:', data.notams.length, 'active after filter:', activeNotams.length);
    if (activeNotams.length === 0) return `No active NOTAMs for ${icao}.`;
    return activeNotams.slice(0, 8).map((n, i) => {
      const raw = (n.raw || n.body || '').trim().slice(0, 500);
      return `[${icao} NOTAM ${i+1}] ${n.notam_id || ''}:\n${raw}`;
    }).join('\n\n---\n\n');
  } catch (e) { return `Could not fetch NOTAMs for ${icao}: ${e.message}`; }
}

// Oceanic FIRs that use SkyLink fallback messaging
const OCEANIC_FIRS = new Set(['KZNY', 'CZQX', 'EGGX', 'KZAK']);

// Fetch en-route FIR NOTAMs based on dep/arr ICAO pair
async function getEnrouteNotams(dep, arr) {
  const firMap = {
    // Europe
    'LT': 'LTBB', 'EG': 'EGTT', 'ED': 'EDGG', 'LF': 'LFFF',
    'LI': 'LIIV', 'LE': 'LECM', 'LP': 'LPPC', 'EB': 'EBUR',
    'EH': 'EHAA', 'EK': 'EKDK', 'EN': 'ENOR', 'EF': 'EFIN',
    'LG': 'LGGG', 'LB': 'LBSR', 'LR': 'LRBB', 'LY': 'LYBA',
    'LD': 'LDZO', 'LO': 'LOVV', 'LK': 'LKAA', 'EP': 'EPWW',
    // Middle East & Caucasus
    'OJ': 'OJAC', 'OI': 'OIIX', 'OR': 'ORBB', 'OT': 'OTBD',
    'OE': 'OEJD', 'OM': 'OMAE', 'OB': 'OBBB', 'OK': 'OKAC',
    'UD': 'UDDD', 'UG': 'UGGD', 'UK': 'UKBV', 'UR': 'URRV',
    // North America
    'KZ': 'KZNY', 'CZ': 'CZQX', 'KA': 'KZAK',
    'KJ': 'KZNY', 'KF': 'KZNY', 'KL': 'KZNY',
    // China
    'ZB': 'ZBPE', 'ZS': 'ZSHA', 'ZG': 'ZGZU', 'ZW': 'ZWWW',
    // Russia
    'UL': 'ULLL', 'UU': 'UUWV', 'UM': 'UMMV',
    'UT': 'UTAA', 'UC': 'UCFM', 'UA': 'UAAA',
    'UN': 'UNNT', 'UH': 'UHHH',
    // Mongolia
    'MG': 'ZMUB',
  };

  const depPrefix = dep ? dep.slice(0, 2) : '';
  const arrPrefix = arr ? arr.slice(0, 2) : '';

  const firs = new Set();
  if (firMap[depPrefix]) firs.add(firMap[depPrefix]);
  if (firMap[arrPrefix]) firs.add(firMap[arrPrefix]);

  // Add intermediate FIRs for common route pairs
  const routeKey = depPrefix + '-' + arrPrefix;
  const commonRoutes = {
    // Europe ↔ Turkey
    'LT-EG': ['LKAA', 'EDGG', 'EGTT'],
    'LT-ED': ['LKAA', 'LOVV'],
    'LT-LF': ['LKAA', 'LOVV', 'EDGG'],
    'LT-LI': ['LGGG', 'LIIV'],
    'LT-LE': ['LGGG', 'LIIV', 'LECM'],
    'EG-LT': ['EGTT', 'EDGG', 'LKAA'],
    'ED-LT': ['LOVV', 'LKAA'],
    // Turkey ↔ Middle East
    'LT-OE': ['LGGG', 'ORBB', 'OEJD'],
    'LT-OT': ['LGGG', 'ORBB', 'OTBD'],
    'LT-OM': ['LGGG', 'ORBB', 'OMAE'],
    // North America ↔ Europe / Middle East (transatlantic)
    'KJ-EG': ['KZNY', 'CZQX', 'EGGX', 'EGTT'],
    'KJ-ED': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG'],
    'KJ-LF': ['KZNY', 'CZQX', 'EGGX', 'LFFF'],
    'KJ-LT': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LKAA'],
    'KJ-OE': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LGGG', 'ORBB'],
    'KJ-OT': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LGGG', 'ORBB'],
    'KJ-OM': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LGGG', 'ORBB'],
    'EG-KJ': ['EGTT', 'EGGX', 'CZQX', 'KZNY'],
    'LT-KJ': ['LKAA', 'EDGG', 'EGTT', 'EGGX', 'CZQX', 'KZNY'],
    'OE-KJ': ['ORBB', 'LGGG', 'EDGG', 'EGTT', 'EGGX', 'CZQX', 'KZNY'],
    'OT-KJ': ['ORBB', 'LGGG', 'EDGG', 'EGTT', 'EGGX', 'CZQX', 'KZNY'],
    // Asia ↔ Russia / Europe (polar/Silk Road)
    'ZB-UL': ['ZWWW', 'UAAA', 'UNNT', 'ULLL'],
    'UL-ZB': ['ULLL', 'UNNT', 'UAAA', 'ZWWW'],
    'ZB-LT': ['ZWWW', 'UAAA', 'UNNT', 'UUWV', 'UKBV', 'LGGG'],
    'LT-ZB': ['LGGG', 'UKBV', 'UUWV', 'UNNT', 'UAAA', 'ZWWW'],
    'ZB-EG': ['ZWWW', 'UAAA', 'UNNT', 'UUWV', 'ULLL', 'EGTT'],
  };
  (commonRoutes[routeKey] || []).forEach(fir => firs.add(fir));

  // Fetch NOTAMs for up to 8 FIRs (skip raw airport codes)
  const firList = [...firs].filter(f => f !== dep && f !== arr).slice(0, 8);
  const results = [];

  for (const fir of firList) {
    await new Promise(r => setTimeout(r, 500));

    // Oceanic FIRs: SkyLink may not cover them — use informational fallback
    if (OCEANIC_FIRS.has(fir)) {
      try {
        const data = await fetchURL('https://skylink-api.p.rapidapi.com/notams/' + fir, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': process.env.SKYLINK_KEY,
            'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
          }
        });
        if (!data || !data.notams || data.notams.length === 0) {
          results.push(`FIR ${fir}: Oceanic FIR — check official NOTAM sources (KZNY/CZQX/EGGX) for current NAT track system and oceanic restrictions`);
          continue;
        }
        const now = new Date();
        const active = data.notams.filter(n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(parseInt(e.slice(0,4)), parseInt(e.slice(4,6))-1, parseInt(e.slice(6,8)), parseInt(e.slice(8,10)), parseInt(e.slice(10,12))));
          return expDate > now;
        });
        const summary = active.slice(0, 5).map(n => (n.raw || n.body || '').slice(0, 300)).join('\n');
        results.push(`FIR ${fir}: ${active.length} active NOTAMs\n${summary || 'No active restrictions'}`);
      } catch(e) {
        results.push(`FIR ${fir}: Oceanic FIR — verify current NAT tracks and oceanic NOTAM status via official sources`);
      }
      continue;
    }

    // Standard FIR fetch
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/notams/' + fir, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': process.env.SKYLINK_KEY,
          'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
        }
      });
      if (data && data.notams && data.notams.length > 0) {
        const now = new Date();
        const active = data.notams.filter(n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(parseInt(e.slice(0,4)), parseInt(e.slice(4,6))-1, parseInt(e.slice(6,8)), parseInt(e.slice(8,10)), parseInt(e.slice(10,12))));
          return expDate > now;
        });
        if (active.length > 0) {
          const summary = active.slice(0, 5).map(n => (n.raw || n.body || '').slice(0, 300)).join('\n');
          results.push(`FIR ${fir}: ${active.length} active NOTAMs\n${summary}`);
        } else {
          results.push(`FIR ${fir}: No active NOTAMs`);
        }
      } else {
        results.push(`FIR ${fir}: No active NOTAMs`);
      }
    } catch(e) {
      results.push(`FIR ${fir}: Data unavailable`);
    }
  }

  return results.join('\n\n');
}

async function fetchMetar(icao) {
  if (!icao) return '';
  try {
    const data = await fetchURL(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`);
    if (!data || !data[0]) return '';
    return data[0].rawOb || '';
  } catch { return ''; }
}

async function fetchTaf(icao) {
  if (!icao) return '';
  try {
    const data = await fetchURL(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`);
    if (!data || !data[0]) return '';
    return data[0].rawTAF || '';
  } catch { return ''; }
}

function streamClaude(requestBody, onChunk, onDone, onError) {
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  }, (claudeRes) => {
    let buf = '';
    claudeRes.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            onChunk(evt.delta.text);
          } else if (evt.type === 'message_stop') {
            onDone();
          }
        } catch (_) {}
      }
    });
    claudeRes.on('end', onDone);
    claudeRes.on('error', onError);
  });
  req.on('error', onError);
  req.write(requestBody);
  req.end();
}

const HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pre-Flight Operational Intelligence Briefing</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#060a0f;--bg2:#0b1118;--bg3:#101820;--panel:#0d1520;
    --border:#1a2a3a;--border2:#22384f;
    --red:#e63946;--red-dim:#7a1a20;--orange:#f4841a;--orange-dim:#7a3a08;
    --yellow:#f2c641;--yellow-dim:#7a5e10;--green:#2ec4b6;--green-dim:#0e5a54;
    --blue:#4a9eff;--blue-dim:#143060;--purple:#b57bff;
    --text:#cdd9e5;--text2:#8a9bb0;--text3:#4a5f72;
    --mono:'Share Tech Mono',monospace;--head:'Orbitron',sans-serif;--body:'Rajdhani',sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--body);font-size:15px;line-height:1.55;min-height:100vh}
  body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px);pointer-events:none;z-index:9999}
  .page{max-width:900px;margin:0 auto;padding:28px 24px 60px}
  .master-header{border:1px solid var(--border2);border-top:3px solid var(--red);background:var(--panel);padding:24px 28px 20px;margin-bottom:20px;position:relative;overflow:hidden}
  .master-header::after{content:'';position:absolute;top:0;right:0;width:200px;height:100%;background:linear-gradient(135deg,transparent 60%,rgba(230,57,70,0.04))}
  .header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .route-id{font-family:var(--head);font-size:28px;font-weight:900;letter-spacing:4px;color:#fff;text-shadow:0 0 24px rgba(74,158,255,0.3)}
  .route-sub{font-family:var(--mono);font-size:11px;color:var(--text3);letter-spacing:2px;margin-top:4px}
  .risk-badge{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
  .risk-label{font-family:var(--head);font-size:22px;font-weight:900;color:var(--red);letter-spacing:3px;text-shadow:0 0 16px rgba(230,57,70,0.5);animation:pulse-red 2s ease-in-out infinite}
  @keyframes pulse-red{0%,100%{text-shadow:0 0 16px rgba(230,57,70,0.5)}50%{text-shadow:0 0 28px rgba(230,57,70,0.9)}}
  .risk-score{font-family:var(--mono);font-size:13px;color:var(--orange);letter-spacing:2px}
  .score-bar{display:flex;gap:3px;margin-top:2px}
  .score-pip{width:16px;height:6px;border-radius:2px;background:var(--border2);transition:background 0.3s}
  .score-pip.active{background:var(--red);box-shadow:0 0 6px var(--red)}
  .score-pip.active.med{background:var(--orange);box-shadow:0 0 6px var(--orange)}
  .header-meta{display:flex;gap:24px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap}
  .meta-item{font-family:var(--mono);font-size:11px;color:var(--text3);letter-spacing:1px}
  .meta-item span{color:var(--blue)}
  .exec-summary{background:var(--panel);border:1px solid var(--border2);border-left:4px solid var(--orange);padding:18px 22px;margin-bottom:20px}
  .exec-summary p{color:var(--text);font-size:15px;line-height:1.7;font-weight:500}
  .exec-summary p+p{margin-top:10px}
  .section-header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--bg3);border:1px solid var(--border2);border-left:3px solid var(--blue);margin-bottom:12px;margin-top:28px}
  .section-header .icon{font-size:16px}
  .section-header .title{font-family:var(--head);font-size:12px;font-weight:700;letter-spacing:3px;color:var(--blue);text-transform:uppercase}
  .notam-list{display:flex;flex-direction:column;gap:10px}
  .notam-card{background:var(--panel);border:1px solid var(--border);border-left:4px solid transparent;padding:16px 18px;position:relative;transition:border-color 0.2s}
  .notam-card:hover{border-color:var(--border2)}
  .notam-card.crit{border-left-color:var(--red)}
  .notam-card.high{border-left-color:var(--orange)}
  .notam-card.med{border-left-color:var(--yellow)}
  .notam-card.low{border-left-color:var(--green)}
  .notam-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
  .notam-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;margin-top:4px}
  .crit .notam-dot{background:var(--red);box-shadow:0 0 8px var(--red)}
  .high .notam-dot{background:var(--orange);box-shadow:0 0 8px var(--orange)}
  .med .notam-dot{background:var(--yellow);box-shadow:0 0 8px var(--yellow)}
  .low .notam-dot{background:var(--green);box-shadow:0 0 8px var(--green)}
  .notam-id{font-family:var(--mono);font-size:12px;color:var(--text3);letter-spacing:1px;margin-bottom:2px}
  .notam-title{font-family:var(--body);font-size:16px;font-weight:700;color:#fff;letter-spacing:0.5px}
  .notam-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin-bottom:10px}
  .notam-field-label{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px}
  .notam-field-value{font-size:13px;color:var(--text);font-weight:500}
  .notam-action{background:rgba(0,0,0,0.3);border:1px solid var(--border);padding:10px 14px;margin-top:10px;font-size:13px;color:var(--text2);font-weight:600}
  .notam-action .action-label{font-family:var(--mono);font-size:10px;color:var(--yellow);letter-spacing:2px;display:block;margin-bottom:4px}
  .warning-banner{display:flex;gap:10px;background:rgba(230,57,70,0.08);border:1px solid var(--red-dim);padding:10px 14px;margin-top:10px;font-size:13px;color:#ff8a8a;font-weight:600}
  .warning-banner::before{content:'🔴';font-size:12px;margin-top:1px}
  .dual-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
  @media(max-width:620px){.dual-col{grid-template-columns:1fr}}
  .status-panel{background:var(--panel);border:1px solid var(--border);padding:16px 18px}
  .status-panel.dep{border-top:2px solid var(--yellow)}
  .status-panel.arr{border-top:2px solid var(--red)}
  .status-airport{font-family:var(--head);font-size:18px;font-weight:900;letter-spacing:3px;color:#fff;margin-bottom:4px}
  .status-sub{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1px;margin-bottom:12px}
  .status-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;gap:10px}
  .status-row:last-child{border-bottom:none}
  .status-key{color:var(--text3);font-size:12px;font-weight:600;white-space:nowrap}
  .status-val{color:var(--text);font-weight:600;text-align:right}
  .status-val.ok{color:var(--green)}
  .status-val.warn{color:var(--yellow)}
  .status-val.bad{color:var(--red)}
  .navaid-grid{background:var(--panel);border:1px solid var(--border);overflow:hidden}
  .navaid-row{display:grid;grid-template-columns:2fr 2fr 1fr 3fr;padding:10px 18px;border-bottom:1px solid var(--border);font-size:13px;align-items:center;gap:12px}
  .navaid-row.header{background:var(--bg3);font-family:var(--mono);font-size:10px;letter-spacing:1.5px;color:var(--text3);padding:8px 18px}
  .navaid-row:last-child{border-bottom:none}
  .navaid-name{font-weight:700;color:#fff}
  .navaid-loc{color:var(--text2)}
  .navaid-status{font-family:var(--mono);font-size:13px}
  .ok{color:var(--green)}.ux{color:var(--red)}.deg{color:var(--yellow)}
  .navaid-note{color:var(--text2);font-size:12px}
  .wx-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
  @media(max-width:700px){.wx-grid{grid-template-columns:1fr}}
  .wx-card{background:var(--panel);border:1px solid var(--border);padding:14px 16px}
  .wx-icao{font-family:var(--head);font-size:16px;font-weight:900;letter-spacing:3px;color:#fff;margin-bottom:2px}
  .wx-role{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1px;margin-bottom:10px}
  .wx-raw{font-family:var(--mono);font-size:11px;color:var(--text2);word-break:break-all;line-height:1.6;background:rgba(0,0,0,0.25);padding:8px;border:1px solid var(--border);margin-bottom:8px}
  .wx-tag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:1px;padding:2px 7px;border-radius:2px;margin-right:4px;margin-bottom:4px}
  .wx-tag.warn{background:rgba(244,132,26,0.15);color:var(--orange);border:1px solid var(--orange-dim)}
  .wx-tag.crit{background:rgba(230,57,70,0.15);color:var(--red);border:1px solid var(--red-dim)}
  .wx-tag.ok{background:rgba(46,196,182,0.1);color:var(--green);border:1px solid var(--green-dim)}
  .wx-analysis{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--red);padding:14px 18px;font-size:14px;color:var(--text);line-height:1.7;font-weight:500}
  .wx-analysis p+p{margin-top:8px}
  .compound-box{background:rgba(230,57,70,0.06);border:1px solid var(--red-dim);padding:16px 20px;margin-bottom:12px}
  .compound-title{font-family:var(--head);font-size:11px;font-weight:700;color:var(--red);letter-spacing:3px;margin-bottom:10px}
  .compound-item{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(230,57,70,0.15);font-size:13px;color:#ff8a8a;font-weight:600;line-height:1.5}
  .compound-item:last-child{border-bottom:none}
  .compound-item::before{content:'⚡';flex-shrink:0}
  .airspace-grid{background:var(--panel);border:1px solid var(--border);overflow:hidden}
  .airspace-row{display:grid;grid-template-columns:90px 1fr 120px 120px;padding:10px 18px;border-bottom:1px solid var(--border);font-size:13px;align-items:center;gap:12px}
  .airspace-row.header{background:var(--bg3);font-family:var(--mono);font-size:10px;letter-spacing:1.5px;color:var(--text3);padding:8px 18px}
  .airspace-row:last-child{border-bottom:none}
  .ar-id{font-family:var(--mono);font-size:11px;color:var(--blue)}
  .ar-desc{color:var(--text);font-weight:600}
  .ar-fl{font-family:var(--mono);font-size:12px;color:var(--yellow)}
  .ar-time{font-family:var(--mono);font-size:11px;color:var(--text2)}
  .action-list{display:flex;flex-direction:column;gap:8px}
  .action-item{display:flex;gap:14px;background:var(--panel);border:1px solid var(--border);padding:14px 16px;align-items:flex-start}
  .action-num{font-family:var(--head);font-size:16px;font-weight:900;color:var(--blue);min-width:28px;line-height:1.2}
  .action-text{font-size:14px;font-weight:600;color:var(--text);line-height:1.5}
  .action-text em{font-style:normal;color:var(--yellow);font-weight:700}
  .dispatch-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
  @media(max-width:620px){.dispatch-grid{grid-template-columns:1fr}}
  .dispatch-card{background:var(--panel);border:1px solid var(--border);padding:14px 18px;display:flex;flex-direction:column;gap:6px}
  .dispatch-icon{font-size:20px}
  .dispatch-label{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:2px}
  .dispatch-value{font-size:14px;font-weight:600;color:var(--text);line-height:1.5}
  .dispatch-value .hl{color:var(--orange);font-weight:700}
  .gng-box{background:rgba(244,132,26,0.07);border:1px solid var(--orange-dim);border-top:3px solid var(--orange);padding:24px 28px;margin-top:28px}
  .gng-verdict{font-family:var(--head);font-size:24px;font-weight:900;letter-spacing:4px;color:var(--orange);margin-bottom:14px;text-shadow:0 0 20px rgba(244,132,26,0.4)}
  .gng-conditions{display:flex;flex-direction:column;gap:6px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
  .gng-cond{display:flex;gap:10px;font-size:14px;font-weight:600;color:var(--text);align-items:flex-start;line-height:1.5}
  .gng-cond::before{content:'✓';color:var(--green);font-size:14px;flex-shrink:0;margin-top:1px}
  .gng-nogo-cond{display:flex;gap:10px;font-size:14px;font-weight:700;color:var(--red);align-items:flex-start;margin-top:10px;padding:12px 14px;background:rgba(230,57,70,0.08);border:1px solid var(--red-dim)}
  .gng-nogo-cond::before{content:'✕';flex-shrink:0}
  .briefing-footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
  .footer-sig{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1px}
  .footer-disclaimer{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:0.5px;text-align:right;max-width:360px}
  @media(max-width:560px){.notam-grid{grid-template-columns:1fr}.airspace-row{grid-template-columns:1fr 1fr}.airspace-row .ar-time{display:none}}
</style>
</head>
<body>
<div class="page">`;

const HTML_FOOT = `</div></body></html>`;

const systemPrompt = `MANDATORY RULES:
- Show ALL NOTAMs provided in the data - never skip or summarize any NOTAM
- Each NOTAM card must have correct risk color class: crit (red) for runway closures/GNSS/safety critical, high (orange) for navigation aids/UAS/obstacles, med (yellow) for taxiway/procedures, low (green) for administrative
- Show the airport ICAO code for each NOTAM in the notam-id field
- CRITICAL NOTAMs include: runway closures, GNSS jamming, dual runway closures, emergency-only airports
- Never downgrade GNSS jamming or runway closures to medium or low risk

You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM.

Analyze the provided aviation data and produce a complete pre-flight operational intelligence briefing.

If an image or PDF is provided, analyze it as aviation documentation (NOTAM, chart, weather report, or operational document) and include findings in the briefing.

CRITICAL INSTRUCTIONS:
1. Output ONLY the HTML body content — everything that goes INSIDE <div class="page">...</div>
2. Do NOT include <!DOCTYPE>, <html>, <head>, <style>, <body> or outer <div class="page"> tags
3. Start directly with <div class="master-header"> and end with </div> for briefing-footer
4. Use EXACTLY these CSS classes — they are already loaded
5. NEVER write "Content Under Review", "Under Review", or any placeholder text. Always use the actual NOTAM data provided.
6. AIRPORT NAMES — use correct official names:
   - LTFM = Istanbul Airport (opened 2019, main Istanbul hub)
   - LTAI = Antalya Airport
   - LTBA = Istanbul Atatürk Airport (CLOSED to commercial ops since April 2019)
   - LTAC = Ankara Esenboğa Airport
   - LTBJ = İzmir Adnan Menderes Airport
   - EGLL = London Heathrow | EGKK = London Gatwick | EHAM = Amsterdam Schiphol
   - EDDF = Frankfurt | LFPG = Paris Charles de Gaulle | LEMD = Madrid Barajas
   - LIRF = Rome Fiumicino | LSZH = Zurich | LOWW = Vienna | EKCH = Copenhagen
   - For any other ICAO code not listed above, derive the name from standard ICAO knowledge.

REQUIRED SECTIONS IN ORDER:

1. MASTER HEADER:
<div class="master-header">
  <div class="header-top">
    <div>
      <div class="route-id">[DEP] → [ARR]</div>
      <div class="route-sub">[DEP FULL NAME] → [ARR FULL NAME] | PRE-FLIGHT OPERATIONAL INTELLIGENCE BRIEFING</div>
    </div>
    <div class="risk-badge">
      <div class="risk-label">[🔴/🟠/🟡/🟢] [CRITICAL/HIGH/MEDIUM/LOW]</div>
      <div class="risk-score">📊 RISK SCORE [X] / 10</div>
      <div class="score-bar">
        [10 score-pip divs — add class="active" for filled pips, class="active med" for orange pips]
      </div>
    </div>
  </div>
  <div class="header-meta">
    <div class="meta-item">DATE <span>[CURRENT UTC DATE]</span></div>
    <div class="meta-item">VALIDITY <span>[VALIDITY PERIOD]</span></div>
    <div class="meta-item">ROUTE <span>[DEP] → [FIR route] → [ARR]</span></div>
    <div class="meta-item">AIRAC <span>CURRENT CYCLE ACTIVE</span></div>
    <div class="meta-item">PREPARED <span>AIM SPECIALIST / OPS</span></div>
  </div>
</div>

2. EXECUTIVE SUMMARY:
<div class="exec-summary">
  <p>✈️ <strong>EXECUTIVE SUMMARY —</strong> [3-4 detailed sentences covering all major risks]</p>
  <p>[Second paragraph with operational classification GO/NO-GO/GO WITH CONDITIONS]</p>
</div>

3. COMPOUNDING RISK MATRIX (always include if multiple NOTAMs):
<div class="compound-box">
  <div class="compound-title">🔴 COMPOUNDING RISK MATRIX — SIMULTANEOUS ACTIVE HAZARDS</div>
  <div class="compound-item">[Specific risk combination with details]</div>
  [more compound-item divs as needed]
</div>

4. NOTAM ANALYSIS:
<div class="section-header"><span class="icon">📋</span><span class="title">NOTAM Analysis — Priority Order</span></div>
<div class="notam-list">
  [For EACH NOTAM in the provided data use this EXACT structure — process every NOTAM, never skip or summarise:]
  <div class="notam-card [crit|high|med|low]">
    <div class="notam-head">
      <div class="notam-dot"></div>
      <div>
        <div class="notam-id">[🔴/🟠/🟡/🟢] [EXACT NOTAM ID from data] | TYPE: [TYPE]</div>
        <div class="notam-title">[Descriptive title derived from the NOTAM text]</div>
      </div>
    </div>
    <div class="notam-grid">
      <div class="notam-field"><div class="notam-field-label">📍 Location</div><div class="notam-field-value">[exact location from NOTAM]</div></div>
      <div class="notam-field"><div class="notam-field-label">⏰ Time Window UTC</div><div class="notam-field-value">[exact B/C times from NOTAM]</div></div>
      <div class="notam-field"><div class="notam-field-label">✈️ Affected Operations</div><div class="notam-field-value">[what operations are affected]</div></div>
      <div class="notam-field"><div class="notam-field-label">📐 Operational Impact</div><div class="notam-field-value">[specific impact on the flight]</div></div>
    </div>
    <div class="notam-field" style="margin:10px 0 6px"><div class="notam-field-label">📄 RAW NOTAM TEXT</div><div class="notam-field-value" style="font-family:monospace;font-size:12px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-all">[verbatim raw NOTAM text exactly as received from the data]</div></div>
    <div class="notam-field" style="margin:0 0 10px"><div class="notam-field-label">💬 DECODED PLAIN ENGLISH</div><div class="notam-field-value">[clear plain-English explanation of what this NOTAM means for crew — no jargon, full sentences]</div></div>
    <div class="notam-action"><span class="action-label">⚠️ REQUIRED CREW ACTION</span>[specific action the crew must take because of this NOTAM]</div>
    [Optional: <div class="warning-banner">COMPOUNDS WITH: [detail]</div>]
  </div>
</div>

5. AIRSPACE AND RESTRICTIONS:
<div class="section-header"><span class="icon">🚫</span><span class="title">Airspace and Restrictions</span></div>
<div class="airspace-grid">
  <div class="airspace-row header"><span>NOTAM / REF</span><span>DESCRIPTION</span><span>VERTICAL LIMITS</span><span>ACTIVE (UTC)</span></div>
  [airspace-row divs with ar-id, ar-desc, ar-fl, ar-time spans]
</div>

6. AERODROME STATUS:
<div class="section-header"><span class="icon">🛬</span><span class="title">Aerodrome Status</span></div>
<div class="dual-col">
  <div class="status-panel dep">
    <div class="status-airport">[DEP]</div>
    <div class="status-sub">[DEP CORRECT FULL NAME] — DEPARTURE</div>
    [status-row divs with status-key and status-val (ok/warn/bad) spans]
  </div>
  <div class="status-panel arr">
    <div class="status-airport">[ARR]</div>
    <div class="status-sub">[ARR CORRECT FULL NAME] — ARRIVAL</div>
    [status-row divs]
  </div>
</div>

7. NAVIGATION AIDS:
<div class="section-header"><span class="icon">📡</span><span class="title">Navigation Aids Status</span></div>
<div class="navaid-grid">
  <div class="navaid-row header"><span>NAVAID / TYPE</span><span>LOCATION</span><span>STATUS</span><span>NOTES</span></div>
  [navaid-row divs with navaid-name, navaid-loc, navaid-status (ok/ux/deg), navaid-note spans]
</div>

8. WEATHER ASSESSMENT:
<div class="section-header"><span class="icon">🌤️</span><span class="title">Weather Assessment</span></div>
<div class="wx-grid">
  <div class="wx-card"><div class="wx-icao">[DEP]</div><div class="wx-role">DEPARTURE</div><div class="wx-raw">[METAR]</div>[wx-tags]</div>
  <div class="wx-card"><div class="wx-icao">[ARR]</div><div class="wx-role">ARRIVAL — PRIMARY</div><div class="wx-raw">[METAR]</div>[wx-tags]</div>
  <div class="wx-card"><div class="wx-icao">[ALTERNATE]</div><div class="wx-role">ALTERNATE</div><div class="wx-raw">[METAR or N/A]</div>[wx-tags]</div>
</div>
<div class="wx-analysis"><p>[Dep weather analysis]</p><p>[Arr weather analysis with concerns]</p><p>[Alternate and additional info]</p></div>

9. PILOT ACTION ITEMS:
<div class="section-header"><span class="icon">✅</span><span class="title">Pilot Action Items</span></div>
<div class="action-list">
  [8-10 action-item divs each with action-num (01-10) and action-text with em tags for key terms]
</div>

10. DISPATCH NOTES:
<div class="section-header"><span class="icon">📦</span><span class="title">Dispatch Notes</span></div>
<div class="dispatch-grid">
  <div class="dispatch-card"><span class="dispatch-icon">⛽</span><div class="dispatch-label">FUEL PLANNING</div><div class="dispatch-value">[fuel details with hl spans]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">🛫</span><div class="dispatch-label">ALTERNATE AERODROME</div><div class="dispatch-value">[alternate details]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">🕐</span><div class="dispatch-label">SLOT / CTOT</div><div class="dispatch-value">[slot details]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">📻</span><div class="dispatch-label">ATC COORDINATION</div><div class="dispatch-value">[ATC details with hl spans]</div></div>
</div>

11. GO/NO-GO:
<div class="gng-box">
  <div class="gng-verdict">🎯 [GO ✅ / NO-GO ❌ / GO WITH CONDITIONS ⚠️]</div>
  <p style="font-size:14px;font-weight:600;color:var(--text);line-height:1.6;">[Main reasoning]</p>
  <div class="gng-conditions">
    [gng-cond divs for each condition]
  </div>
  [Optional: <div class="gng-nogo-cond">NO-GO IF: [condition]</div>]
</div>

12. FOOTER:
<div class="briefing-footer">
  <div class="footer-sig">AIM SPECIALIST — SENIOR OPERATIONAL BRIEFING<br>ROUTE: [DEP]–[ARR] | [DATE] | [TIME UTC]</div>
  <div class="footer-disclaimer">FLIGHT SAFETY IS THE OVERRIDING PRIORITY. THIS BRIEFING IS PREPARED IN ACCORDANCE WITH ICAO ANNEX 15, PANS-AIM DOC 10066, PANS-OPS DOC 8168, AND DOC 4444 PANS-ATM. ALWAYS CROSS-CHECK WITH CURRENT OPERATIONAL SOURCES BEFORE FLIGHT.</div>
</div>

MANDATORY: Analyze and include en-route NOTAMs for ALL FIRs along the route. For each FIR on the route (e.g. LTBB, LKAA, EGTT, EDGG etc.), check for:
- Airspace closures or restrictions
- Military exercise areas (MATZ, danger areas, restricted areas)
- Temporary Flight Restrictions (TFRs)
- Active SIGMETs along route
- FIR crossing procedures or special requirements
Include a dedicated AIRSPACE section in the briefing that specifically covers en-route hazards separate from aerodrome NOTAMs. If no en-route NOTAMs exist for a FIR, explicitly state 'No active en-route restrictions for [FIR]'.

EN-ROUTE FIR ANALYSIS: For each intermediate FIR along the route, create a dedicated subsection in the AIRSPACE section. List specific NOTAM numbers, types, and operational impact. If military exercise areas, TFRs, or airspace restrictions exist, classify them as HIGH or CRITICAL risk as appropriate. Never say 'limited information available' - either provide the data or explicitly state 'No active NOTAMs for [FIR]'.

For transatlantic routes, always mention NAT (North Atlantic Track) system status and oceanic clearance requirements. For routes over conflict zones (Middle East, Eastern Europe), specifically check for active airspace closures and NOTAM to Airmen.

Use real data from provided NOTAMs and weather. Be detailed and operationally specific. Cover all NOTAM types including SNOWTAM, BIRDTAM, ASHTAM, Military, Navigation, Airspace, Aerodrome NOTAMs.

IMPORTANT: Be concise. Limit each NOTAM card to essential information only. Ensure ALL sections are completed including Go/No-Go and Footer.

IMPORTANT: Never use markdown backticks or code blocks. For RAW NOTAM TEXT field, output the exact NOTAM text inside a pre HTML tag with inline styles. Example:
<pre style='font-family:monospace;white-space:pre-wrap;font-size:11px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid #1a2a3a;line-height:1.6;color:#8a9bb0;margin:8px 0;'>NOTAM TEXT</pre>
The ! prefix and date format (YYMMDDHHmm) are standard ICAO format - keep them exactly as received.`;

const server = http.createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (urlPath === '/about' || urlPath === '/about.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'about.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (urlPath === '/pricing' || urlPath === '/pricing.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'pricing.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (urlPath === '/pricing-upgrade' || urlPath === '/pricing-upgrade.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'pricing-upgrade.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (req.url === '/privacy' || req.url === '/privacy.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (req.url === '/terms' || req.url === '/terms.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/b/')) {
    const briefingId = req.url.split('/b/')[1].split('?')[0];
    const shareHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NOTAM Intelligence Briefing</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #060a0f; color: #cdd9e5; font-family: 'Rajdhani', sans-serif; min-height: 100vh; }
#loadingScreen { display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px; }
#loadingText { font-family: 'Share Tech Mono', monospace; font-size: 14px; letter-spacing: 3px; color: #4a9eff; }
#briefingContent { max-width: 900px; margin: 40px auto; padding: 0 24px 80px; }
@keyframes blinkDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
</style>
</head>
<body>
<div id="loadingScreen">
  <div id="loadingText">LOADING BRIEFING...</div>
</div>
<div id="briefingContent" style="display:none;">
  <div style="position:sticky;top:0;z-index:100;background:rgba(6,10,15,0.95);border-bottom:1px solid #1a2a3a;padding:0 24px;height:48px;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(8px);">
    <div style="display:flex;align-items:center;gap:12px;">
      <a href="https://notamai.onrender.com" style="text-decoration:none;display:flex;align-items:center;gap:4px;">
        <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#ffffff;">NOTAM</span>
        <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#4a9eff;">INTELLIGENCE</span>
      </a>
      <span style="color:#1a2a3a;">|</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#2ec4b6;display:inline-block;animation:blinkDot 1.5s ease-in-out infinite;flex-shrink:0;"></span>
        <span style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#4a5f72;letter-spacing:2px;">SHARED BRIEFING</span>
      </div>
    </div>
    <a id="getAccessBtn" href="https://notamai.onrender.com/?signup=true" style="display:flex;align-items:center;gap:6px;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);color:#ffffff;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;padding:6px 14px;border-radius:6px;cursor:pointer;text-decoration:none;">
      <span style="font-size:12px;">✨</span>
      GET FULL ACCESS
    </a>
  </div>
  <div id="getAccessTooltip" style="display:none;position:fixed;background:#1a1a1a;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;font-weight:400;padding:6px 10px;border-radius:4px;border:1px solid #333;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:normal;line-height:1.5;pointer-events:none;z-index:9999;max-width:280px;">Create a free account to generate your own AI-powered pre-flight briefings</div>
  <div id="briefingBody" style="padding-top:32px;"></div>
</div>
<script>
const firebaseConfig = {
  apiKey: "AIzaSyCH8bj9-775vmXU1HnqRFjf09g1yUXvnpo",
  authDomain: "notamai-a9d57.firebaseapp.com",
  projectId: "notamai-a9d57",
  storageBucket: "notamai-a9d57.firebasestorage.app",
  messagingSenderId: "793570221190",
  appId: "1:793570221190:web:aab696c96dbde26d9f4507"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
db.collection('briefings').doc('${briefingId}').get().then(doc => {
  if (doc.exists) {
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('briefingContent').style.display = 'block';
    document.getElementById('briefingBody').innerHTML = doc.data().html;
    const route = doc.data().route || 'NOTAM Briefing';
    document.title = 'NOTAM Intelligence — ' + route;
  } else {
    document.getElementById('loadingText').textContent = 'BRIEFING NOT FOUND';
  }
}).catch(() => {
  document.getElementById('loadingText').textContent = 'ERROR LOADING BRIEFING';
});
const getAccessBtn = document.getElementById('getAccessBtn');
const getAccessTooltip = document.getElementById('getAccessTooltip');
if (getAccessBtn) {
  getAccessBtn.addEventListener('mouseenter', function() {
    getAccessTooltip.style.display = 'block';
    const rect = this.getBoundingClientRect();
    getAccessTooltip.style.left = (rect.left + rect.width / 2 - 140) + 'px';
    getAccessTooltip.style.top = (rect.bottom + 8) + 'px';
  });
  getAccessBtn.addEventListener('mouseleave', function() {
    getAccessTooltip.style.display = 'none';
  });
}
</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(shareHtml);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/raw/')) {
    const urlParams = req.url.replace('/api/raw/', '');
    const [type, icao] = urlParams.split('/');

    if (type === 'notam') {
      try {
        const skyUrl = 'https://skylink-api.p.rapidapi.com/notams/' + icao;
        const data = await fetchURL(skyUrl, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': process.env.SKYLINK_KEY,
            'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
          }
        });
        if (!data || !data.notams || data.notams.length === 0) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('No active NOTAMs for ' + icao);
          return;
        }
        const now = new Date();
        const active = data.notams.filter(n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(
            parseInt(e.slice(0,4)), parseInt(e.slice(4,6)) - 1, parseInt(e.slice(6,8)),
            parseInt(e.slice(8,10)), parseInt(e.slice(10,12))
          ));
          return expDate > now;
        }).sort((a, b) => {
          const dateA = a.effective || '0';
          const dateB = b.effective || '0';
          return dateB.localeCompare(dateA);
        });
        const notamText = active.map(n => {
          const id = n.notam_id || '';
          const ntype = n.type === 'R' ? 'NOTAMR' : n.type === 'C' ? 'NOTAMC' : 'NOTAMN';
          const location = n.location || icao;
          const effective = n.effective ? n.effective.slice(2) : '';
          const expiration = n.expiration ? (n.expiration === 'PERM' ? 'PERM' : n.expiration.slice(2)) : 'PERM';
          const body = (n.body || '').trim() || (n.raw || '').replace(/^![A-Z]+ [A-Z0-9/]+\s*/, '').trim();
          let formatted = id + '\t' + ntype + '\n';
          formatted += 'A) ' + location + '\n';
          formatted += 'B) ' + effective + ' C) ' + expiration + '\n';
          formatted += 'E) ' + body;
          return formatted;
        }).join('\n===NOTAM===\n');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(notamText || 'No active NOTAMs for ' + icao);
      } catch(e) {
        res.writeHead(500);
        res.end('Error: ' + e.message);
      }
      return;
    }

    let apiUrl = '';
    if (type === 'metar') {
      apiUrl = 'https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw&hours=2';
    } else if (type === 'taf') {
      apiUrl = 'https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw';
    }
    if (!apiUrl) { res.writeHead(400); res.end('Invalid type'); return; }
    try {
      const response = await fetchURL(apiUrl);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(typeof response === 'string' ? response : JSON.stringify(response));
    } catch(e) {
      res.writeHead(500);
      res.end('Error fetching data');
    }
    return;
  }

  if (req.method === 'GET' && (urlPath === '/how-it-works' || urlPath === '/how-it-works.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'how-it-works.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, briefingContext, currentRoute, history, image_base64, image_type, pdf_base64 } = JSON.parse(body);

        // Extract ICAO codes from route for live data fetching
        const icaoCodes = currentRoute
          ? currentRoute.replace(/[^A-Z\s]/g, '').trim().split(/\s+/).filter(c => c.length >= 3 && c.length <= 4)
          : [];

        // Detect if live data is needed
        const needsLiveNotam   = /notam|active|current.*notam|how many notam|kaç notam|güncel notam|enroute|en-route|military|TFR|restricted|FIR/i.test(question);
        const needsLiveWeather = /current.*weather|live.*weather|metar|latest.*weather|güncel hava|şu anki hava/i.test(question);

        let liveData = '';

        // Fetch live NOTAMs if needed
        if (needsLiveNotam && icaoCodes.length > 0) {
          for (const icao of icaoCodes.slice(0, 2)) {
            try {
              const skyUrl = 'https://skylink-api.p.rapidapi.com/notams/' + icao;
              const data = await fetchURL(skyUrl, {
                method: 'GET',
                headers: {
                  'x-rapidapi-key': process.env.SKYLINK_KEY,
                  'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
                }
              });
              if (data && data.notams) {
                const now = new Date();
                const active = data.notams.filter(n => {
                  if (!n.expiration || n.expiration.length < 12) return true;
                  const e = n.expiration;
                  const expDate = new Date(Date.UTC(parseInt(e.slice(0,4)), parseInt(e.slice(4,6))-1, parseInt(e.slice(6,8)), parseInt(e.slice(8,10)), parseInt(e.slice(10,12))));
                  return expDate > now;
                });
                const critical = active.filter(n => /RWY.*CLSD|CLSD.*RWY|U\/S|UNSERVICEABLE|JAMM|EMERG/i.test(n.raw || n.body || ''));
                const high     = active.filter(n => /TWY.*CLSD|CLSD.*TWY|VOR|ILS|NDB|UAS/i.test(n.raw || n.body || ''));
                liveData += `\nLIVE NOTAM DATA FOR ${icao}: ${active.length} active NOTAMs. Critical: ${critical.length}, High priority: ${high.length}, Other: ${active.length - critical.length - high.length}.\n`;
                liveData += `Sample critical NOTAMs: ${critical.slice(0,3).map(n => (n.notam_id || '') + ': ' + (n.body || n.raw || '').slice(0,100)).join('; ')}\n`;
              }
            } catch(e) {}
          }
        }

        // Fetch live METAR if needed
        if (needsLiveWeather && icaoCodes.length > 0) {
          for (const icao of icaoCodes.slice(0, 2)) {
            try {
              const metarRes  = await fetch('https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw&hours=2');
              const metarText = await metarRes.text();
              if (metarText.trim()) liveData += `\nLIVE METAR FOR ${icao}:\n${metarText.trim()}\n`;
            } catch(e) {}
          }
        }

        // System prompt
        const systemPrompt = `You are an expert AIM (Aeronautical Information Management) specialist and senior flight dispatcher with deep knowledge of ICAO Annex 15, PANS-AIM, and international aviation operations.

The following is the complete pre-flight operational briefing you have analyzed:

${briefingContext}

${liveData ? 'LIVE REAL-TIME DATA FETCHED:\n' + liveData : ''}

IMPORTANT - NOTAM SCOPE: When analyzing NOTAMs, consider ALL types including:
- Aerodrome NOTAMs (departure and arrival airports)
- En-route NOTAMs (airspace along the route)
- Military exercise areas and restricted airspace
- TFRs (Temporary Flight Restrictions)
- FIR/UIR closures or restrictions
- SIGMET and special activity areas
If the briefing does not contain en-route or military NOTAMs, explicitly state this and recommend the crew check current en-route NOTAMs via NOTAMs & MET panel or official sources for the specific FIRs along the route.

IMPORTANT INSTRUCTIONS:
- Answer in the SAME LANGUAGE the user asks the question (Turkish → Turkish, English → English, etc.)
- For weather questions: use the weather data from the briefing. If live METAR was fetched, use that for current conditions.
- For NOTAM questions: use the NOTAM analysis from the briefing. If live NOTAM count was fetched, mention exact numbers.
- If user wants to see ALL NOTAMs, tell them to open the "NOTAMs & MET" panel in the sidebar for full raw NOTAM data.
- Be concise (under 200 words), professional, and operationally focused.
- Always prioritize flight safety in your answers.`;

        // Build user content (supports images and PDFs)
        const userContent = [];
        if (image_base64) {
          userContent.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
        }
        if (pdf_base64) {
          userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
        }
        userContent.push({ type: 'text', text: question || 'Please analyze the attached document.' });

        const messages = [
          ...(history || []).slice(-6).map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: userContent }
        ];

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: systemPrompt,
            messages
          })
        });

        const claudeData = await claudeRes.json();
        const answer = claudeData.content?.[0]?.text || 'Unable to process question.';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer }));

      } catch(e) {
        console.error('[CHAT ERROR]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: 'Error processing request.' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/briefing') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { icao_dep, icao_arr, notam_text, image_base64, image_type, pdf_base64 } = JSON.parse(body);

        const notamDep = await fetchNotams(icao_dep);
        await new Promise(r => setTimeout(r, 500));
        const notamArr = await fetchNotams(icao_arr);

        // Fetch en-route FIR NOTAMs
        const enrouteNotamData = await getEnrouteNotams(icao_dep, icao_arr);

        const [metarDep, metarArr, tafDep, tafArr] = await Promise.all([
          fetchMetar(icao_dep), fetchMetar(icao_arr),
          fetchTaf(icao_dep), fetchTaf(icao_arr)
        ]);

        const now = new Date();
        const utcDate = now.toUTCString().slice(5, 16).toUpperCase();

        const userMessage = `CRITICAL: Output maximum 5 NOTAM cards total. Be very concise in each section. Must complete ALL sections including Weather, Pilot Actions, Dispatch Notes, Go/No-Go and Footer.

TODAY'S DATE: ${utcDate}
DEPARTURE: ${icao_dep || 'NOT PROVIDED'} — ${airportName(icao_dep)}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'} — ${airportName(icao_arr)}

LIVE NOTAMs - DEPARTURE (${icao_dep} / ${airportName(icao_dep)}):
${notamDep || 'No active NOTAMs retrieved'}

LIVE NOTAMs - ARRIVAL (${icao_arr} / ${airportName(icao_arr)}):
${notamArr || 'No active NOTAMs retrieved'}

METAR DEPARTURE: ${metarDep || 'Not available'}
METAR ARRIVAL: ${metarArr || 'Not available'}
TAF DEPARTURE: ${tafDep || 'Not available'}
TAF ARRIVAL: ${tafArr || 'Not available'}
${enrouteNotamData ? '\nEN-ROUTE FIR NOTAMs:\n' + enrouteNotamData : '\nEN-ROUTE FIR NOTAMs: No FIR data available — advise crew to check current FIR NOTAMs via official sources.'}
${notam_text ? `\nADDITIONAL USER DATA:\n${notam_text}` : ''}

Generate the complete pre-flight operational intelligence briefing HTML content.`;

        const contentBlocks = [{ type: 'text', text: userMessage }];
        if (image_base64) {
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 }
          });
        }
        if (pdf_base64) {
          contentBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
          });
        }

        const claudeBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          stream: true,
          system: systemPrompt,
          messages: [{ role: 'user', content: contentBlocks }]
        });

        // Switch to SSE streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.writeHead(200);

        // Send HTML_HEAD and HTML_FOOT to client so it can wrap content
        res.write(`data: ${JSON.stringify({ type: 'init', html_head: HTML_HEAD, html_foot: HTML_FOOT })}\n\n`);

        let doneSent = false;
        streamClaude(claudeBody,
          (text) => { res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`); },
          () => { if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); res.end(); } },
          (err) => { if (!doneSent) { doneSent = true; res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`); res.end(); } }
        );

      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.timeout = 120000;
server.listen(PORT, () => {
  console.log(`NOTAM Intelligence server running on port ${PORT}`);
});
