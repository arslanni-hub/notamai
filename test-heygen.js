const https = require('https');

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY || 'test';
const PHOTO_URL = 'https://i.imgur.com/Aap70Bx.jpeg';

const payload = JSON.stringify({
  video_inputs: [{
    character: {
      type: 'talking_photo',
      talking_photo_url: PHOTO_URL
    },
    voice: {
      type: 'text',
      input_text: 'Good morning Captain. This is your NOTAM Intelligence pre-flight briefing. Runway 18R is closed. ILS system is unserviceable. Weather at destination is VFR. Have a safe flight.',
      voice_id: 'en-US-ChristopherNeural'
    }
  }],
  dimension: { width: 1280, height: 720 }
});

const options = {
  hostname: 'api.heygen.com',
  path: '/v2/video/generate',
  method: 'POST',
  headers: {
    'X-Api-Key': HEYGEN_API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Response:', data);
    const result = JSON.parse(data);
    if (result.data?.video_id) {
      console.log('✅ Video ID:', result.data.video_id);
      setTimeout(() => checkStatus(result.data.video_id), 15000);
    }
  });
});

req.on('error', e => console.error('Error:', e));
req.write(payload);
req.end();

function checkStatus(videoId) {
  const options = {
    hostname: 'api.heygen.com',
    path: '/v1/video_status.get?video_id=' + videoId,
    method: 'GET',
    headers: { 'X-Api-Key': HEYGEN_API_KEY }
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const result = JSON.parse(data);
      console.log('Status:', result.data?.status);
      if (result.data?.video_url) console.log('✅ Video URL:', result.data.video_url);
      if (result.data?.status === 'processing') {
        console.log('Still processing, checking in 10s...');
        setTimeout(() => checkStatus(videoId), 10000);
      }
    });
  });
  req.end();
}
