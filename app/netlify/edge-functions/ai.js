// Netlify Edge Function: POST /api/ai -> the model (streamed). It answers before the ordinary function of the
// same path (netlify/functions/ai.mjs), which stays as the fallback.
//
// Why at the edge: an ordinary Netlify Function is ended after 30 seconds, whatever it is doing, and a
// thinking model often needs longer than that for one answer. The stream was cut mid-sentence (measured on
// the live site, 30.5 s). An edge function has no such limit on a response that is streaming; it only has to
// start answering within 40 s, and the model starts within a second or two.
//
// The key lives in the Netlify environment variable DEEPSEEK_API_KEY and never reaches the browser.
import { MAX_BODY, proxyChat } from '../../server/aiProxy.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { error: 'too-long' });
    let body;
    try { body = JSON.parse(text); } catch { return json(400, { error: 'bad-request' }); }
    const env = name => globalThis.Netlify?.env.get(name);
    return await proxyChat(body, { key: env('DEEPSEEK_API_KEY'), model: env('DEEPSEEK_MODEL'), baseUrl: env('DEEPSEEK_BASE_URL'), raw: true });
  } catch (err) {
    console.error('[ai edge]', err);
    return json(500, { error: 'service' });
  }
};

export const config = { path: '/api/ai' };
