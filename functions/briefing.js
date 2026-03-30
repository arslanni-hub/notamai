export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const { icao_dep, icao_arr, notam_text } = await request.json();

    const systemPrompt = `You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM. Analyze ALL provided aviation data and produce a complete pre-flight operational intelligence briefing. Cover all NOTAM types: SNOWTAM, BIRDTAM, ASHTAM, Military, Trigger, Navigation, Airspace, Aerodrome. Apply AIRAC cycle awareness. Cross-reference NOTAMs to identify compounding risks. CRITICAL: Respond ONLY with a complete, valid HTML document. No text before or after the HTML. Start with <!DOCTYPE html> and end with </html>. Design: dark aviation theme background #060a0f, Google Fonts Orbitron/Share Tech Mono/Rajdhani, risk colors CRITICAL=#e63946 HIGH=#f4841a MEDIUM=#f2c641 LOW=#2ec4b6, sections: Executive Summary, Compounding Risk Matrix, NOTAM Analysis priority cards, Airspace Restrictions, Aerodrome Status dual column, Navigation Aids table, Weather Assessment METAR/TAF cards, Pilot Action Items numbered, Dispatch Notes, Go/No-Go box. NOTAM cards colored left border. Risk score pip bar. Scanline overlay. All content in English.`;

    const userMessage = `DEPARTURE: ${icao_dep || 'NOT PROVIDED'}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'}
${notam_text ? `USER PROVIDED DATA: ${notam_text}` : 'Generate a complete briefing based on typical conditions for these airports.'}
Generate a complete pre-flight operational intelligence briefing.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const data = await response.json();

    if (!data.content || !data.content[0]) {
      return new Response(JSON.stringify({ error: 'Claude returned no content', detail: JSON.stringify(data) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ briefing_html: data.content[0].text }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
