require('dotenv').config();
const https = require('https');

// Get Cloudflare tunnel URL from metrics API
async function getCfUrl() {
  return new Promise((resolve) => {
    const req = require('http').request(
      { hostname: 'localhost', port: 20241, path: '/quicktunnel', method: 'GET' },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d).hostname); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function main() {
  const cfHost = await getCfUrl();
  if (!cfHost) {
    console.error('Could not get Cloudflare URL. Is cloudflared running?');
    process.exit(1);
  }

  const webhookUrl = `https://${cfHost}/webhook`;
  console.log('Registering webhook:', webhookUrl);

  const body = JSON.stringify({
    url: webhookUrl,
    allowed_updates: ['message'],
    drop_pending_updates: true
  });

  const result = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${process.env.TG_TOKEN}/setWebhook`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', e => resolve({ ok: false, description: e.message }));
    req.write(body);
    req.end();
  });

  if (result.ok) {
    console.log('✅ Webhook registered:', result.description);
    console.log('Bot URL: https://t.me/TheDesignerBotName');
  } else {
    console.error('❌ Webhook registration failed:', result.description);
  }
}

main().catch(console.error);
