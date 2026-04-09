require('dotenv').config();
const { Bot, webhookCallback, InputFile } = require('grammy');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const tools = require('./tools');

const bot = new Bot(process.env.TG_TOKEN);
const client = new Anthropic();
const sessions = new Map();   // chat_id → messages[]
const activeJobs = new Map(); // task_id → { chat_id, description }

// ── Tool definitions for Claude ────────────────────────────────────────────────
const TOOL_DEFS = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. Use model=dalle3 for high quality, model=flux for speed/free. For marketing/campaigns, consider calling twice with both models.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image generation prompt in English' },
        model: { type: 'string', enum: ['dalle3', 'flux'], description: 'Image model to use' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'submit_video',
    description: 'Submit a Runway Gen4 Turbo text-to-video job. Async — returns immediately with task_id. User will be notified when video is ready (3-5 minutes).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Video generation prompt in English' },
        duration: { type: 'number', enum: [5, 10], description: 'Video duration in seconds' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'submit_image_to_video',
    description: 'Animate an existing image into a video using Runway Gen4 Turbo. Async — returns task_id.',
    input_schema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of the image to animate' },
        prompt: { type: 'string', description: 'Motion/animation instructions in English' },
        duration: { type: 'number', enum: [5, 10], description: 'Video duration in seconds' }
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
  }
];

// ── System Prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are "The Designer" (המעצב) — an elite AI creative assistant on Telegram.

LANGUAGE: Always respond in the SAME language the user writes in. If Hebrew → Hebrew. If English → English.

TOOLS — when to use them:
- generate_image: For ANY request involving images, artwork, logos, mockups, marketing visuals. Always generate immediately — do not ask clarifying questions first. Use model=dalle3 for quality, model=flux for speed. For campaigns, call TWICE (both models) and present both.
- submit_video: Call IMMEDIATELY for any video request. Do not ask questions first. After submitting, tell user: "שלחתי את הבקשה ל-Runway — אשלח לך הודעה כשהוידאו מוכן (בד״כ 3-5 דקות) 🎬"
- submit_image_to_video: When user wants to animate an image they sent or one you just generated.
- analyze_image: When user sends a photo — analyze it FIRST, then decide what to do based on the analysis.

CRITICAL RULES:
- Generate first, ask later. A rough generation beats an explanation of what you'd generate.
- Keep text responses SHORT and punchy. The visuals carry the message.
- For video: always submit, always notify user to wait. Never say "I cannot generate video."
- When you generate an image, the URL will be sent to the user automatically — no need to include it in your text.
- For complex creative campaigns: think like a senior creative director. Understand the brand, the audience, the emotion before generating.

CAPABILITIES SUMMARY (tell users when relevant):
✨ תמונות: DALL-E 3 (איכות גבוהה) + FLUX Schnell (מהיר)
🎬 וידאו: Runway Gen4 Turbo — text-to-video ו-image-to-video
👁️ ניתוח תמונות: Gemini 2.5 Flash Vision
💬 זיכרון שיחה: זוכר את כל ההיסטוריה שלנו`;

// ── Message handler ────────────────────────────────────────────────────────────
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  const history = sessions.get(chatId) || [];

  // Build user message content
  const userContent = [];

  if (ctx.message.text) {
    userContent.push({ type: 'text', text: ctx.message.text });
  }

  if (ctx.message.photo) {
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]; // largest size
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
      // Fetch and embed as base64 for Claude
      const imgRes = await fetch(fileUrl);
      const buf = await imgRes.arrayBuffer();
      const base64 = Buffer.from(buf).toString('base64');
      const mimeType = 'image/jpeg';
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 }
      });
      if (ctx.message.caption) {
        userContent.push({ type: 'text', text: ctx.message.caption });
      } else {
        userContent.push({ type: 'text', text: 'מה תוכל לעשות עם התמונה הזו?' });
      }
    } catch (e) {
      userContent.push({ type: 'text', text: ctx.message.caption || 'שלחתי תמונה' });
    }
  }

  if (userContent.length === 0) return;

  history.push({ role: 'user', content: userContent });

  // Typing indicator
  await ctx.replyWithChatAction('typing').catch(() => {});

  try {
    // ── Claude agentic loop ────────────────────────────────────────────────────
    let response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages: history
    });

    while (response.stop_reason === 'tool_use') {
      history.push({ role: 'assistant', content: response.content });

      // Process all tool calls in this response
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let toolResult;
        try {
          await ctx.replyWithChatAction('typing').catch(() => {});
          const result = await tools[block.name](block.input);

          // Handle result side-effects
          if (block.name === 'generate_image' && result.url) {
            try {
              await ctx.replyWithPhoto(result.url, { caption: `✨ ${result.model}` });
            } catch (e) {
              // If direct URL fails, try sending as file
              try {
                const imgData = await fetch(result.url);
                const buf = await imgData.arrayBuffer();
                await ctx.replyWithPhoto(new InputFile(Buffer.from(buf), 'image.jpg'), {
                  caption: `✨ ${result.model}`
                });
              } catch (e2) {
                await ctx.reply(`תמונה נוצרה: ${result.url}`);
              }
            }
          }

          if ((block.name === 'submit_video' || block.name === 'submit_image_to_video') && result.task_id) {
            activeJobs.set(result.task_id, {
              chat_id: chatId,
              description: block.input.prompt || 'וידאו',
              duration: result.duration
            });
          }

          toolResult = JSON.stringify(result);
        } catch (e) {
          console.error(`Tool ${block.name} error:`, e.message);
          toolResult = JSON.stringify({ error: e.message });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolResult
        });
      }

      history.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages: history
      });
    }

    // Send final text response
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock && textBlock.text.trim()) {
      await ctx.reply(textBlock.text);
    }

    history.push({ role: 'assistant', content: response.content });

    // Keep last 40 messages
    sessions.set(chatId, history.slice(-40));

  } catch (e) {
    console.error('Handler error:', e.message);
    await ctx.reply('אירעה שגיאה. נסה שוב עוד רגע.').catch(() => {});
  }
});

// ── Runway Poller (every 30 seconds) ──────────────────────────────────────────
setInterval(async () => {
  if (activeJobs.size === 0) return;

  for (const [task_id, job] of activeJobs) {
    try {
      const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task_id}`, {
        headers: {
          Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
          'X-Runway-Version': '2024-11-06'
        }
      });
      const status = await r.json();

      if (status.status === 'SUCCEEDED' && status.output && status.output[0]) {
        try {
          await bot.api.sendVideo(job.chat_id, status.output[0], {
            caption: `🎬 הוידאו שלך מוכן! (${job.duration || 5} שניות)`
          });
        } catch (e) {
          // If sendVideo fails, send as document or link
          await bot.api.sendMessage(job.chat_id, `🎬 הוידאו מוכן: ${status.output[0]}`);
        }
        activeJobs.delete(task_id);
        console.log(`Video delivered for task ${task_id}`);

      } else if (status.status === 'FAILED') {
        await bot.api.sendMessage(job.chat_id, '⚠️ יצירת הוידאו נכשלה. רוצה לנסות שוב?');
        activeJobs.delete(task_id);
        console.log(`Video failed for task ${task_id}`);
      }
      // If PENDING/RUNNING — continue waiting
    } catch (e) {
      console.error(`Poller error for ${task_id}:`, e.message);
    }
  }
}, 30000);

// ── Express webhook server ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', jobs: activeJobs.size }));

app.use('/webhook', webhookCallback(bot, 'express'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`The Designer running on port ${PORT}`);
  console.log('Waiting for Telegram messages...');
});
