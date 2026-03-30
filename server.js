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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

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

        const systemPrompt = `You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM. Analyze ALL provided aviation data and produce a complete pre-flight operational intelligence briefing. CRITICAL: Respond ONLY with a complete valid HTML document starting with <!DOCTYPE html> and ending with </html>. Design: dark aviation theme background #060a0f, Google Fonts Orbitron/Share Tech Mono/Rajdhani, risk colors CRITICAL=#e63946 HIGH=#f4841a MEDIUM=#f2c641 LOW=#2ec4b6. Include all sections: Executive Summary, Compounding Risk Matrix, NOTAM Analysis priority cards with colored left borders and dot indicators, Airspace Restrictions table, Aerodrome Status dual column, Navigation Aids table, Weather Assessment METAR/TAF cards, Pilot Action Items numbered list, Dispatch Notes, Go/No-Go recommendation box. All content in English.`;

        const userMessage = `DEPARTURE: ${icao_dep || 'NOT PROVIDED'}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'}
LIVE NOTAMs DEP: ${notamDep || 'None'}
LIVE NOTAMs ARR: ${notamArr || 'None'}
METAR DEP: ${metarDep || 'Not available'}
METAR ARR: ${metarArr || 'Not available'}
TAF DEP: ${tafDep || 'Not available'}
TAF ARR: ${tafArr || 'Not available'}
${notam_text ? `ADDITIONAL DATA: ${notam_text}` : ''}`;

        const claudeBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
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

server.timeout = 60000;

server.listen(PORT, () => {
  console.log(`NOTAM Intelligence server running on port ${PORT}`);
});
