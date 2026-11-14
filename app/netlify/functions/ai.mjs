// Netlify Function: POST /api/ai -> the model (streamed). The key lives in the Netlify
// environment variable DEEPSEEK_API_KEY and never reaches the browser. Errors go back as short
// fixed codes ({ error: 'network' } etc.); the details are logged here, never sent to the page.
import { MAX_BODY, proxyChat } from '../../server/aiProxy.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { error: 'too-long' });
    let body;
    try { body = JSON.parse(text); } catch { return json(400, { error: 'bad-request' }); }
    return await proxyChat(body, { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL, baseUrl: process.env.DEEPSEEK_BASE_URL });
  } catch (err) {
    console.error('[ai function]', err);
    return json(500, { error: 'service' });
  }
};

export const config = { path: '/api/ai' };
