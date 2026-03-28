const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTAMIFY_KEY = process.env.NOTAMIFY_KEY;

async function fetchNotams(icao) {
  if (!icao) return '';
  try {
    const now = new Date();
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 19);
    const url = `https://api.notamify.com/api/v2/notams?locations=${icao}&starts_at=${fmt(now)}&ends_at=${fmt(end)}&page=1`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${NOTAMIFY_KEY}` } });
    const data = await res.json();
    if (!data.notams || data.notams.length === 0) return `No active NOTAMs found for ${icao}.`;
    return data.notams.map(n =>
      `NOTAM ${n.id || ''}\nQ) ${n.q_code || ''}\nA) ${n.location || icao}\nB) ${n.valid_from || ''} C) ${n.valid_to || ''}\nE) ${n.text || n.condition || ''}`
    ).join('\n\n');
  } catch (e) { return `Could not fetch NOTAMs for ${icao}: ${e.message}`; }
}

async function fetchMetar(icao) {
  if (!icao) return '';
  try {
    const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`);
    const data = await res.json();
    if (!data || data.length === 0) return '';
    return data[0].rawOb || data[0].metar || '';
  } catch (e) { return ''; }
}

async function fetchTaf(icao) {
  if (!icao) return '';
  try {
    const res = await fetch(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`);
    const data = await res.json();
    if (!data || data.length === 0) return '';
    return data[0].rawTAF || '';
  } catch (e) { return ''; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { icao_dep, icao_arr, notam_text } = JSON.parse(event.body || '{}');

  const [notamDep, notamArr, metarDep, metarArr, tafDep, tafArr] = await Promise.all([
    fetchNotams(icao_dep), fetchNotams(icao_arr),
    fetchMetar(icao_dep), fetchMetar(icao_arr),
    fetchTaf(icao_dep), fetchTaf(icao_arr)
  ]);

  const systemPrompt = `You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM. Analyze ALL provided aviation data and produce a complete pre-flight operational intelligence briefing. Cover all NOTAM types: SNOWTAM, BIRDTAM, ASHTAM, Military, Trigger, Navigation, Airspace, Aerodrome. Apply AIRAC cycle awareness. Cross-reference NOTAMs to identify compounding risks. CRITICAL: Respond ONLY with a complete, valid HTML document. No text before or after the HTML. Start with <!DOCTYPE html> and end with </html>. Design: dark aviation theme background #060a0f, Google Fonts Orbitron/Share Tech Mono/Rajdhani, risk colors CRITICAL=#e63946 HIGH=#f4841a MEDIUM=#f2c641 LOW=#2ec4b6, sections: Executive Summary, Compounding Risk Matrix, NOTAM Analysis priority cards, Airspace Restrictions, Aerodrome Status dual column, Navigation Aids table, Weather Assessment METAR/TAF cards, Pilot Action Items numbered, Dispatch Notes, Go/No-Go box. NOTAM cards colored left border. Risk score pip bar. Scanline overlay. All content in English.`;

  const userMessage = `DEPARTURE: ${icao_dep || 'NOT PROVIDED'}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'}
LIVE NOTAMs - DEPARTURE: ${notamDep || 'No NOTAMs retrieved'}
LIVE NOTAMs - ARRIVAL: ${notamArr || 'No NOTAMs retrieved'}
METAR DEP: ${metarDep || 'Not available'}
METAR ARR: ${metarArr || 'Not available'}
TAF DEP: ${tafDep || 'Not available'}
TAF ARR: ${tafArr || 'Not available'}
${notam_text ? `ADDITIONAL DATA: ${notam_text}` : ''}
Generate complete pre-flight briefing based on above live data.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] })
    });
    const data = await response.json();
    if (!data.content || !data.content[0]) {
      return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Claude returned no content', detail: JSON.stringify(data) }) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ briefing_html: data.content[0].text }) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};
