require('dotenv').config();

// ── Retry helper ───────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, baseDelay = 2000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ── DALL-E 3 ──────────────────────────────────────────────────────────────────
async function dalle3(prompt) {
  return withRetry(async () => {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', quality: 'hd' })
    });
    const d = await r.json();
    if (!d.data?.[0]) throw new Error(d.error?.message || 'DALL-E 3 failed');
    return d.data[0].url;
  });
}

// ── GPT-Image-1 (newest OpenAI model, returns base64) ─────────────────────────
async function gptImage1(prompt) {
  return withRetry(async () => {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: '1024x1024', quality: 'high' })
    });
    const d = await r.json();
    if (!d.data?.[0]) throw new Error(d.error?.message || 'gpt-image-1 failed');
    return { base64: d.data[0].b64_json };
  });
}

// ── FLUX Schnell (Pollinations.ai — free, no key needed) ──────────────────────
async function flux(prompt) {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&seed=${seed}&nologo=true&enhance=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Pollinations failed: ${r.status}`);
  return url;
}

// ── generate_image ─────────────────────────────────────────────────────────────
// model: 'dalle3' | 'flux' | 'gpt4o'
async function generate_image({ prompt, model = 'dalle3' }) {
  if (model === 'flux') {
    const url = await flux(prompt);
    return { url, model: 'FLUX (Pollinations)' };
  }
  if (model === 'gpt4o') {
    const result = await gptImage1(prompt);
    return { ...result, model: 'GPT-Image-1' };
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
    body: JSON.stringify({ model: 'gen4_turbo', promptText: prompt, ratio: '1280:720', duration })
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

// ── text_to_speech (ElevenLabs) ───────────────────────────────────────────────
async function text_to_speech({ text, voice_id }) {
  const vid = voice_id || process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam multilingual
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true }
    })
  });
  if (!r.ok) { const err = await r.text(); throw new Error(`ElevenLabs TTS ${r.status}: ${err.substring(0, 200)}`); }
  const buf = await r.arrayBuffer();
  return { audio_base64: Buffer.from(buf).toString('base64'), format: 'mp3', chars: text.length };
}

// ── sound_effects (ElevenLabs) ────────────────────────────────────────────────
async function sound_effects({ description, duration_seconds = 3 }) {
  const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: description, duration_seconds: Math.min(duration_seconds, 22), prompt_influence: 0.3 })
  });
  if (!r.ok) { const err = await r.text(); throw new Error(`ElevenLabs SFX ${r.status}: ${err.substring(0, 200)}`); }
  const buf = await r.arrayBuffer();
  return { audio_base64: Buffer.from(buf).toString('base64'), format: 'mp3', description };
}

// ── transcribe_audio (OpenAI Whisper) — used internally for voice messages ─────
async function transcribe_audio({ audio_url, language }) {
  const audioRes = await fetch(audio_url);
  if (!audioRes.ok) throw new Error(`Cannot fetch audio: ${audioRes.status}`);
  const audioBuf = await audioRes.arrayBuffer();
  const formData = new FormData();
  formData.append('file', new Blob([audioBuf], { type: 'audio/ogg' }), 'voice.ogg');
  formData.append('model', 'whisper-1');
  if (language) formData.append('language', language);
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData
  });
  const d = await r.json();
  if (!d.text) throw new Error(d.error?.message || 'Whisper transcription failed');
  return { text: d.text };
}

module.exports = {
  generate_image, submit_video, submit_image_to_video,
  analyze_image, text_to_speech, sound_effects, transcribe_audio
};
