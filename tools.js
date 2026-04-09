require('dotenv').config();

// ── DALL-E 3 ──────────────────────────────────────────────────────────────────
async function dalle3(prompt) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', quality: 'hd' })
  });
  const d = await r.json();
  if (!d.data || !d.data[0]) throw new Error(d.error?.message || 'DALL-E 3 failed');
  return d.data[0].url;
}

// ── FLUX Schnell (Pollinations.ai — free, no key needed) ──────────────────────
async function flux(prompt) {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&seed=${seed}&nologo=true&enhance=true`;
  // Pollinations returns the image directly — verify it responds
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Pollinations failed: ${r.status}`);
  // Return the URL directly (Telegram can fetch it)
  return url;
}

// ── generate_image ─────────────────────────────────────────────────────────────
async function generate_image({ prompt, model = 'dalle3' }) {
  if (model === 'flux') {
    const url = await flux(prompt);
    return { url, model: 'FLUX (Pollinations)' };
  }
  const url = await dalle3(prompt);
  return { url, model: 'DALL-E 3' };
}

// ── submit_video (Runway text-to-video) ────────────────────────────────────────
async function submit_video({ prompt, duration = 5 }) {
  const r = await fetch('https://api.dev.runwayml.com/v1/text_to_video', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06'
    },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptText: prompt,
      ratio: '1280:720',
      duration
    })
  });
  const d = await r.json();
  if (!d.id) throw new Error(d.message || JSON.stringify(d).substring(0, 100));
  return { task_id: d.id, status: 'submitted', duration };
}

// ── submit_image_to_video (Runway image-to-video) ──────────────────────────────
async function submit_image_to_video({ image_url, prompt, duration = 5 }) {
  const r = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06'
    },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptImage: image_url,
      promptText: prompt || '',
      ratio: '1280:720',
      duration
    })
  });
  const d = await r.json();
  if (!d.id) throw new Error(d.message || JSON.stringify(d).substring(0, 100));
  return { task_id: d.id, status: 'submitted', duration };
}

// ── analyze_image (Gemini 2.5 Flash Vision) ────────────────────────────────────
async function analyze_image({ image_url, question }) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // Fetch image and convert to base64
  const imgRes = await fetch(image_url);
  const buf = await imgRes.arrayBuffer();
  const base64 = Buffer.from(buf).toString('base64');
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  const result = await model.generateContent([
    question || 'תאר את התמונה הזו בפירוט.',
    { inlineData: { mimeType, data: base64 } }
  ]);
  return { description: result.response.text() };
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────
async function text_to_speech({ text, voice_id, language = 'he' }) {
  // Default: multilingual voice that handles Hebrew well
  const vid = voice_id || process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true }
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`ElevenLabs failed ${r.status}: ${err.substring(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  return { audio_base64: Buffer.from(buf).toString('base64'), format: 'mp3', chars: text.length };
}

module.exports = { generate_image, submit_video, submit_image_to_video, analyze_image, text_to_speech };
