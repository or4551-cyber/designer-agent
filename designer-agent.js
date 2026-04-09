require('dotenv').config();
const { Bot, InputFile } = require('grammy');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const tools = require('./tools');

const bot = new Bot(process.env.TG_TOKEN);
const client = new Anthropic();
const sessions = new Map();   // chat_id → messages[]
const activeJobs = new Map(); // task_id → { chat_id, description, duration }

// ── Tool definitions for Claude ────────────────────────────────────────────────
const TOOL_DEFS = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. model=gpt4o for maximum quality (newest OpenAI), model=dalle3 for high quality, model=flux for speed/free. For campaigns, call TWICE with different models.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image generation prompt in English' },
        model: { type: 'string', enum: ['gpt4o', 'dalle3', 'flux'], description: 'gpt4o=best quality, dalle3=high quality, flux=fast/free' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'submit_video',
    description: 'Submit a text-to-video job. Tries Runway Gen4 Turbo first, falls back to Luma AI automatically. Async — user notified when ready (3-5 min).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Cinematic video generation prompt in English' },
        duration: { type: 'number', enum: [5, 10], description: 'Video duration in seconds' },
        engine: { type: 'string', enum: ['auto', 'runway', 'luma'], description: 'auto=try runway then luma, runway=force runway, luma=force luma' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'submit_image_to_video',
    description: 'Animate an image into a video. Tries Runway first, falls back to Luma AI. Async — returns task_id.',
    input_schema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of the image to animate' },
        prompt: { type: 'string', description: 'Motion/animation instructions in English' },
        duration: { type: 'number', enum: [5, 10], description: 'Video duration in seconds' },
        engine: { type: 'string', enum: ['auto', 'runway', 'luma'], description: 'auto=try runway then luma' }
      },
      required: ['image_url']
    }
  },
  {
    name: 'analyze_image',
    description: 'Analyze and describe an image using Gemini Vision. Use when user sends a photo or when you need to understand image content.',
    input_schema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of the image to analyze' },
        question: { type: 'string', description: 'Specific question about the image' }
      },
      required: ['image_url']
    }
  },
  {
    name: 'text_to_speech',
    description: 'Convert text to realistic Hebrew/English spoken audio using ElevenLabs. Use for: reading content aloud, voice messages, narration, podcast scripts. Audio sent directly to user.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to convert to speech (Hebrew or English)' },
        voice_id: { type: 'string', description: 'Optional ElevenLabs voice ID. Leave empty for default multilingual voice.' }
      },
      required: ['text']
    }
  },
  {
    name: 'sound_effects',
    description: 'Generate realistic sound effects using ElevenLabs. Use for: ambient sounds, UI sounds, nature sounds, action sounds. Audio sent directly to user.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Describe the sound effect in English (e.g. "thunderstorm with rain", "coffee shop ambience")' },
        duration_seconds: { type: 'number', description: 'Duration in seconds (1-22). Default: 3' }
      },
      required: ['description']
    }
  }
];

// ── System Prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are "The Designer" (המעצב) — an elite AI creative director on Telegram. You create stunning visuals, videos, voice content, and sound design.

LANGUAGE: Always respond in the SAME language the user writes in. Hebrew → Hebrew. English → English.

TOOLS — when & how to use:

generate_image:
- Use for ANY image request. Generate IMMEDIATELY — no clarifying questions.
- model=gpt4o: best quality, photorealistic, complex scenes (use by default for important work)
- model=dalle3: high quality artistic (use when gpt4o is too slow or for stylized art)
- model=flux: fast & free (use for quick drafts or when user wants speed)
- For campaigns: call gpt4o + flux in parallel, send both

submit_video:
- Call IMMEDIATELY for any video request. Never ask questions first.
- CRITICAL: prompt MUST be in English only — no Hebrew, no special characters. Translate user's request yourself.
- Good prompt example: "Slow cinematic shot of ocean waves crashing on shore at golden sunset, foam on sand, warm light"
- After submitting: "שלחתי ל-Runway — אודיע כשהוידאו מוכן (3-5 דקות) 🎬"
- duration=10 for cinematic shots, duration=5 for quick clips

submit_image_to_video:
- When user wants to animate a photo they sent or an image you just generated

analyze_image:
- When user sends a photo → analyze FIRST, then act on what you see

text_to_speech:
- When user asks to "read this", "voice message", "הקרא", "הקלטה", "קול"
- Proactively offer after: generating taglines, writing scripts, creating ad copy
- eleven_multilingual_v2 handles Hebrew natively and beautifully

sound_effects:
- When user asks for sounds, ambience, audio effects
- Great for: background music for videos, UI sounds, nature/environment audio
- Proactively offer after: video creation ("רוצה להוסיף צלילי רקע?")

CRITICAL RULES:
- Generate first, ask later. A rough result beats a question.
- Text responses: SHORT and punchy. Visuals carry the message.
- Never say "I cannot generate X" — always try.
- Voice messages from users are auto-transcribed — treat them as text.
- Think like a senior creative director: brand, audience, emotion first.

CAPABILITIES (mention when relevant):
✨ תמונות: GPT-Image-1 (הכי חדש) + DALL-E 3 + FLUX Schnell
🎬 וידאו: Runway Gen4 Turbo (5/10 שניות)
🔊 קול: ElevenLabs TTS עברית/אנגלית + Sound Effects
👁️ ניתוח תמונות: Gemini 2.5 Flash Vision
🎤 תמלול קולי: Whisper (אוטומטי)
💬 זיכרון שיחה מלא`;

// ── Message handler ────────────────────────────────────────────────────────────
const processedUpdates = new Set();

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const history = sessions.get(chatId) || [];
  const userContent = [];

  // ── Text message
  if (msg.text) {
    userContent.push({ type: 'text', text: msg.text });
  }

  // ── Voice / Audio message → auto-transcribe with Whisper
  if (msg.voice || msg.audio) {
    try {
      await bot.api.sendChatAction(chatId, 'typing').catch(() => {});
      const fileId = (msg.voice || msg.audio).file_id;
      const file = await bot.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
      const transcription = await tools.transcribe_audio({ audio_url: fileUrl });
      userContent.push({ type: 'text', text: `[הודעה קולית — תומללה אוטומטית]: ${transcription.text}` });
      console.log(`Transcribed voice: ${transcription.text.substring(0, 80)}`);
    } catch (e) {
      console.error('Transcription error:', e.message);
      userContent.push({ type: 'text', text: msg.caption || 'שלחתי הודעה קולית' });
    }
  }

  // ── Photo message
  if (msg.photo) {
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const file = await bot.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
      const imgRes = await fetch(fileUrl);
      const buf = await imgRes.arrayBuffer();
      const base64 = Buffer.from(buf).toString('base64');
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
      userContent.push({ type: 'text', text: msg.caption || 'מה תוכל לעשות עם התמונה הזו?' });
    } catch (e) {
      userContent.push({ type: 'text', text: msg.caption || 'שלחתי תמונה' });
    }
  }

  // ── Document (could be image/video for analysis)
  if (msg.document && msg.document.mime_type?.startsWith('image/')) {
    try {
      const file = await bot.api.getFile(msg.document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
      const imgRes = await fetch(fileUrl);
      const buf = await imgRes.arrayBuffer();
      const base64 = Buffer.from(buf).toString('base64');
      userContent.push({ type: 'image', source: { type: 'base64', media_type: msg.document.mime_type, data: base64 } });
      userContent.push({ type: 'text', text: msg.caption || 'מה תוכל לעשות עם התמונה הזו?' });
    } catch (e) {
      userContent.push({ type: 'text', text: msg.caption || 'שלחתי קובץ תמונה' });
    }
  }

  if (userContent.length === 0) return;

  history.push({ role: 'user', content: userContent });

  // Immediate acknowledgement for voice/photo so user knows we got it
  if (msg.voice || msg.audio) {
    await bot.api.sendMessage(chatId, '🎤 מתמלל...').catch(() => {});
  }
  await bot.api.sendChatAction(chatId, 'typing').catch(() => {});

  // ── Claude with retry + Haiku fallback (overload protection)
  async function claudeCreate(params, retries = 3) {
    // Try Sonnet first with retries
    for (let i = 0; i < retries; i++) {
      try {
        return await client.messages.create(params);
      } catch (e) {
        const isOverload = e.status === 529 || e.status === 503 || e.status === 500;
        if (isOverload && i < retries - 1) {
          console.log(`Claude overloaded (attempt ${i+1}), retrying in ${(i+1)*5}s...`);
          await new Promise(r => setTimeout(r, (i + 1) * 5000));
          continue;
        }
        if (isOverload) {
          // All retries exhausted — fall back to Haiku immediately
          console.log('Sonnet exhausted, falling back to Haiku...');
          try {
            return await client.messages.create({ ...params, model: 'claude-haiku-4-5-20251001' });
          } catch (e2) {
            throw new Error(`Both Sonnet and Haiku overloaded. Try again in a minute.`);
          }
        }
        throw e;
      }
    }
  }

  try {
    let response = await claudeCreate({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages: history
    });

    // ── Agentic tool loop
    while (response.stop_reason === 'tool_use') {
      history.push({ role: 'assistant', content: response.content });
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let toolResult;
        try {
          await bot.api.sendChatAction(chatId, 'typing').catch(() => {});
          const result = await tools[block.name](block.input);

          // ── Image: URL (dalle3/flux)
          if (block.name === 'generate_image' && result.url) {
            try {
              await bot.api.sendPhoto(chatId, result.url, { caption: `✨ ${result.model}` });
            } catch {
              try {
                const imgData = await fetch(result.url);
                const buf = await imgData.arrayBuffer();
                await bot.api.sendPhoto(chatId, new InputFile(Buffer.from(buf), 'image.jpg'), { caption: `✨ ${result.model}` });
              } catch {
                await bot.api.sendMessage(chatId, `תמונה נוצרה: ${result.url}`);
              }
            }
          }

          // ── Image: base64 (gpt-image-1)
          if (block.name === 'generate_image' && result.base64) {
            try {
              const imgBuf = Buffer.from(result.base64, 'base64');
              await bot.api.sendPhoto(chatId, new InputFile(imgBuf, 'image.png'), { caption: `✨ ${result.model}` });
            } catch (e) {
              console.error('sendPhoto base64 error:', e.message);
            }
          }

          // ── TTS voice
          if (block.name === 'text_to_speech' && result.audio_base64) {
            try {
              const audioBuf = Buffer.from(result.audio_base64, 'base64');
              await bot.api.sendVoice(chatId, new InputFile(audioBuf, 'voice.mp3'));
            } catch (e) {
              console.error('sendVoice error:', e.message);
            }
          }

          // ── Sound effects
          if (block.name === 'sound_effects' && result.audio_base64) {
            try {
              const audioBuf = Buffer.from(result.audio_base64, 'base64');
              await bot.api.sendAudio(chatId, new InputFile(audioBuf, 'sfx.mp3'), {
                caption: `🔊 ${result.description}`
              });
            } catch (e) {
              console.error('sendAudio error:', e.message);
            }
          }

          // ── Video job registered
          if ((block.name === 'submit_video' || block.name === 'submit_image_to_video') && result.task_id) {
            activeJobs.set(result.task_id, {
              chat_id: chatId,
              description: block.input.prompt || 'וידאו',
              duration: result.duration,
              engine: result.engine || 'runway',
              created_at: Date.now()
            });
          }

          // Strip large binary data before sending back to Claude
          const claudeResult = { ...result };
          delete claudeResult.audio_base64;
          delete claudeResult.base64;
          toolResult = JSON.stringify(claudeResult);

        } catch (e) {
          console.error(`Tool ${block.name} error:`, e.message);
          toolResult = JSON.stringify({ error: e.message });
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolResult });
      }

      history.push({ role: 'user', content: toolResults });

      response = await claudeCreate({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages: history
      });
    }

    // ── Final text response
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock?.text.trim()) {
      await bot.api.sendMessage(chatId, textBlock.text);
    }

    history.push({ role: 'assistant', content: response.content });
    sessions.set(chatId, history.slice(-50));

  } catch (e) {
    console.error('Handler error:', e.message);
    const userMsg = e.message.includes('overloaded')
      ? '⏳ השרת עמוס כרגע. נסה שוב בעוד דקה.'
      : '⚠️ אירעה שגיאה. נסה שוב.';
    await bot.api.sendMessage(chatId, userMsg).catch(() => {});
  }
}

// ── Video Poller (Runway + Luma, every 30 seconds) ────────────────────────────
setInterval(async () => {
  if (activeJobs.size === 0) return;
  for (const [task_id, job] of activeJobs) {
    try {
      let videoUrl = null;
      let failed = false;

      if (job.engine === 'luma') {
        // ── Luma AI polling ──
        const { LumaAI } = require('lumaai');
        const luma = new LumaAI({ authToken: process.env.LUMA_API_KEY });
        const gen = await luma.generations.get(task_id);
        if (gen.state === 'completed' && gen.assets?.video) {
          videoUrl = gen.assets.video;
        } else if (gen.state === 'failed') {
          failed = true;
        }
      } else if (job.engine === 'fal_kling') {
        // ── fal.ai Kling polling ──
        const { fal } = require('@fal-ai/client');
        fal.config({ credentials: process.env.FAL_API_KEY });
        const falStatus = await fal.queue.status('fal-ai/kling-video/v1.6/standard/text-to-video', {
          requestId: task_id, logs: false
        });
        if (falStatus.status === 'COMPLETED') {
          const falResult = await fal.queue.result('fal-ai/kling-video/v1.6/standard/text-to-video', { requestId: task_id });
          videoUrl = falResult.data?.video?.url;
        } else if (falStatus.status === 'FAILED') {
          failed = true;
        }
      } else if (job.engine === 'replicate') {
        // ── Replicate polling ──
        const r = await fetch(`https://api.replicate.com/v1/predictions/${task_id}`, {
          headers: { Authorization: `Bearer ${process.env.REPLICATE_API_KEY}` }
        });
        const pred = await r.json();
        if (pred.status === 'succeeded' && pred.output) {
          videoUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
        } else if (pred.status === 'failed' || pred.status === 'canceled') {
          failed = true;
        }
      } else {
        // ── Runway polling ──
        const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task_id}`, {
          headers: { Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' }
        });
        const status = await r.json();
        if (status.status === 'SUCCEEDED' && status.output?.[0]) {
          videoUrl = status.output[0];
        } else if (status.status === 'FAILED') {
          failed = true;
        }
      }

      if (videoUrl) {
        const engineLabels = { luma: 'Luma AI', replicate: 'Replicate', fal_kling: 'Kling AI', runway: 'Runway' };
        const engineLabel = engineLabels[job.engine] || 'AI';
        try {
          await bot.api.sendDocument(job.chat_id, videoUrl, {
            caption: `🎬 הוידאו מוכן! (${engineLabel}, ${job.duration || 5} שניות)`
          });
        } catch {
          await bot.api.sendMessage(job.chat_id, `🎬 הוידאו מוכן:\n${videoUrl}`);
        }
        activeJobs.delete(task_id);
        console.log(`Video delivered [${job.engine}]: ${task_id}`);
      } else if (failed) {
        await bot.api.sendMessage(job.chat_id, '⚠️ יצירת הוידאו נכשלה. רוצה לנסות שוב?');
        activeJobs.delete(task_id);
        console.log(`Video failed [${job.engine}]: ${task_id}`);
      }
      // Timeout: give up after 20 minutes
      if (job.created_at && Date.now() - job.created_at > 20 * 60 * 1000) {
        await bot.api.sendMessage(job.chat_id, '⏱️ יצירת הוידאו לקחה יותר מדי זמן. נסה שוב.').catch(() => {});
        activeJobs.delete(task_id);
        console.log(`Job timed out: ${task_id}`);
      }
    } catch (e) {
      console.error(`Poller error ${task_id}:`, e.message);
    }
  }
}, 30000);

// ── Express webhook server ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', jobs: activeJobs.size, sessions: sessions.size }));

app.get('/jobs', (req, res) => {
  const jobs = [];
  for (const [task_id, job] of activeJobs) {
    jobs.push({ task_id, engine: job.engine, chat_id: job.chat_id, description: job.description, age_min: Math.round((Date.now() - job.created_at) / 60000) });
  }
  res.json(jobs);
});

app.post('/clearjobs', (req, res) => {
  const count = activeJobs.size;
  activeJobs.clear();
  res.json({ cleared: count });
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  if (processedUpdates.has(update.update_id)) return;
  processedUpdates.add(update.update_id);
  if (processedUpdates.size > 1000) processedUpdates.delete(processedUpdates.values().next().value);
  handleMessage(update.message).catch(async (e) => {
    console.error('Unhandled error:', e.message);
    await bot.api.sendMessage(update.message.chat.id, '⚠️ משהו השתבש. נסה שוב.').catch(() => {});
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`The Designer running on port ${PORT}`);
  console.log('Tools: images(gpt4o/dalle3/flux) | video(runway) | tts+sfx(elevenlabs) | vision(gemini) | transcribe(whisper)');
});
