const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTAMIFY_KEY = process.env.NOTAMIFY_KEY;
const PORT = process.env.PORT || 3000;

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
    const now = new Date();
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 19);
    const url = `https://api.notamify.com/api/v2/notams?locations=${icao}&starts_at=${fmt(now)}&ends_at=${fmt(end)}&page=1`;
    const data = await fetchURL(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${NOTAMIFY_KEY}` }
    });
    if (!data.notams || data.notams.length === 0) return `No active NOTAMs for ${icao}.`;
    return data.notams.map(n =>
      `NOTAM ${n.id || ''}\nA) ${n.location || icao}\nB) ${n.valid_from || ''} C) ${n.valid_to || ''}\nE) ${n.text || n.condition || ''}`
    ).join('\n\n');
  } catch (e) { return `Could not fetch NOTAMs for ${icao}.`; }
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

const systemPrompt = `You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM.

Analyze ALL provided aviation data and produce a complete pre-flight operational intelligence briefing.

CRITICAL: Output ONLY a valid complete HTML document. Start with <!DOCTYPE html> and end with </html>. No text outside HTML. No markdown. No code blocks.

You MUST use EXACTLY this HTML template structure. Copy the HEAD section verbatim, then fill the BODY with real data:

HEAD (copy exactly):
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BRIEFING</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet">
<style>
:root{--bg:#060a0f;--bg2:#0b1118;--bg3:#101820;--panel:#0d1520;--border:#1a2a3a;--border2:#22384f;--red:#e63946;--red-dim:#7a1a20;--orange:#f4841a;--orange-dim:#7a3a08;--yellow:#f2c641;--yellow-dim:#7a5e10;--green:#2ec4b6;--green-dim:#0e5a54;--blue:#4a9eff;--blue-dim:#143060;--purple:#b57bff;--text:#cdd9e5;--text2:#8a9bb0;--text3:#4a5f72;--mono:'Share Tech Mono',monospace;--head:'Orbitron',sans-serif;--body:'Rajdhani',sans-serif}
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
.notam-card{background:var(--panel);border:1px solid var(--border);border-left:4px solid transparent;padding:16px 18px;position:relative}
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
@media(max-width:620px){.notam-grid,.dual-col,.dispatch-grid,.wx-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="page">
[CONTENT HERE]
</div>
</body>
</html>

For [CONTENT HERE], generate the full briefing using EXACTLY these HTML elements with EXACTLY these CSS classes:

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
      <div class="score-bar">[10x score-pip divs, active class for filled ones, add med class for orange pips]</div>
    </div>
  </div>
  <div class="header-meta">
    <div class="meta-item">DATE <span>[UTC DATE]</span></div>
    <div class="meta-item">VALIDITY <span>[TIME RANGE]</span></div>
    <div class="meta-item">AIRAC <span>CURRENT CYCLE ACTIVE</span></div>
    <div class="meta-item">SOURCE <span>LIVE DATA</span></div>
  </div>
</div>

2. EXECUTIVE SUMMARY:
<div class="exec-summary"><p>✈️ <strong>EXECUTIVE SUMMARY —</strong> [3-4 sentences]</p></div>

3. COMPOUNDING RISK MATRIX (if multiple risks):
<div class="compound-box">
  <div class="compound-title">🔴 COMPOUNDING RISK MATRIX — SIMULTANEOUS ACTIVE HAZARDS</div>
  <div class="compound-item">[risk combination]</div>
</div>

4. NOTAM ANALYSIS section-header then notam-list with notam-cards (class crit/high/med/low)

5. AIRSPACE AND RESTRICTIONS section-header then airspace-grid with airspace-rows

6. AERODROME STATUS section-header then dual-col with status-panel dep and arr

7. NAVIGATION AIDS section-header then navaid-grid with navaid-rows

8. WEATHER ASSESSMENT section-header then wx-grid (3 wx-cards) then wx-analysis

9. PILOT ACTION ITEMS section-header then action-list with action-items (numbered 01-0N)

10. DISPATCH NOTES section-header then dispatch-grid with 4 dispatch-cards (fuel/alternate/slot/atc)

11. GO/NO-GO:
<div class="gng-box">
  <div class="gng-verdict">🎯 [GO ✅ / NO-GO ❌ / GO WITH CONDITIONS ⚠️]</div>
  [reasoning paragraph]
  <div class="gng-conditions"><div class="gng-cond">[condition]</div></div>
  [optional gng-nogo-cond]
</div>

12. FOOTER:
<div class="briefing-footer">
  <div class="footer-sig">AIM SPECIALIST — SENIOR OPERATIONAL BRIEFING<br>ROUTE: [DEP]–[ARR] | [DATE] | [TIME UTC]</div>
  <div class="footer-disclaimer">FLIGHT SAFETY IS THE OVERRIDING PRIORITY. THIS BRIEFING IS PREPARED IN ACCORDANCE WITH ICAO ANNEX 15, PANS-AIM DOC 10066, PANS-OPS DOC 8168, AND DOC 4444 PANS-ATM. ALWAYS CROSS-CHECK WITH CURRENT OPERATIONAL SOURCES BEFORE FLIGHT.</div>
</div>

Use real data from provided NOTAMs and weather. Be specific and detailed.`;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'POST' && req.url === '/briefing') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { icao_dep, icao_arr, notam_text } = JSON.parse(body);

        const [notamDep, notamArr, metarDep, metarArr, tafDep, tafArr] = await Promise.all([
          fetchNotams(icao_dep), fetchNotams(icao_arr),
          fetchMetar(icao_dep), fetchMetar(icao_arr),
          fetchTaf(icao_dep), fetchTaf(icao_arr)
        ]);

        const userMessage = `DEPARTURE: ${icao_dep || 'NOT PROVIDED'}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'}
LIVE NOTAMs DEP (${icao_dep}): ${notamDep || 'No active NOTAMs'}
LIVE NOTAMs ARR (${icao_arr}): ${notamArr || 'No active NOTAMs'}
METAR DEP: ${metarDep || 'Not available'}
METAR ARR: ${metarArr || 'Not available'}
TAF DEP: ${tafDep || 'Not available'}
TAF ARR: ${tafArr || 'Not available'}
${notam_text ? `ADDITIONAL DATA: ${notam_text}` : ''}`;

        const claudeBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        });

        const claudeData = await fetchURL('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(claudeBody)
          },
          body: claudeBody
        });

        if (!claudeData.content?.[0]?.text) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Claude returned no content', detail: JSON.stringify(claudeData) }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ briefing_html: claudeData.content[0].text }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
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
