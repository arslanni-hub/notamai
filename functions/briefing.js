export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();
    const { icao_dep, icao_arr, notam_text } = body;

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
        system: `You are a senior AIM specialist. Respond ONLY with a complete valid HTML document starting with <!DOCTYPE html> and ending with </html>. Dark aviation theme, background #060a0f, Google Fonts Orbitron/Share Tech Mono/Rajdhani. Include: Executive Summary, NOTAM Analysis priority cards with colored left borders, Aerodrome Status, Weather Assessment, Pilot Action Items, Go/No-Go recommendation. Risk colors: CRITICAL=#e63946 HIGH=#f4841a MEDIUM=#f2c641 LOW=#2ec4b6.`,
        messages: [{
          role: 'user',
          content: `Departure: ${icao_dep || 'N/A'} Arrival: ${icao_arr || 'N/A'} Data: ${notam_text || 'Generate sample briefing for these airports.'}`
        }]
      })
    });

    const data = await response.json();
    
    if (!data.content?.[0]?.text) {
      return new Response(JSON.stringify({ error: 'No content', detail: JSON.stringify(data) }), {
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
