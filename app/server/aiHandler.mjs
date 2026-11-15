import { MAX_BODY, proxyChat, validateBody } from './aiProxy.mjs';
import { admit } from './aiAdmission.mjs';

const HOSTS = new Set(['moonda.us', 'www.moonda.us', 'moonda-lunar-navigator.netlify.app']);
const encoder = new TextEncoder();
const json = (status, error, extra = {}) => new Response(JSON.stringify({ error }), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-moonda-ai-guard': '2026-11-16', ...extra },
});

export async function readBody(req) {
  if (Number(req.headers.get('content-length')) > MAX_BODY) return { error: 'too-long', status: 413 };
  if (!req.body) return { error: 'bad-request', status: 400 };
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel().catch(() => {});
        return { error: 'too-long', status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    return validateBody(body) || { body, bytes };
  } catch { return { error: 'bad-request', status: 400 }; }
  finally { reader.releaseLock(); }
}

/** Both public entry points must enforce the same paid-work policy. */
export function createHandler({ reserve = admit, proxy = proxyChat } = {}) {
  return async (req, context = {}, env = name => globalThis.Netlify?.env.get(name)) => {
    const requestId = context.requestId || crypto.randomUUID();
    const log = (event, detail = {}) => console.log('[moonda-ai]', JSON.stringify({ event, requestId, ...detail }));
    if (req.method !== 'POST') return json(405, 'bad-request', { allow: 'POST' });
    const url = new URL(req.url);
    if (!HOSTS.has(url.hostname) || (context.deploy?.context && context.deploy.context !== 'production')) return json(403, 'forbidden');
    const origin = req.headers.get('origin');
    if (origin !== url.origin || req.headers.get('sec-fetch-site') === 'cross-site') return json(403, 'forbidden');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) return json(415, 'bad-request');
    if (env('MOONDA_AI_ENABLED') === 'false') return json(503, 'busy');
    const key = env('DEEPSEEK_API_KEY');
    if (!key) return json(501, 'no-key');
    const parsed = await readBody(req);
    if (parsed.error) return json(parsed.status, parsed.error);
    let admission;
    try {
      admission = await reserve({ ip: context.ip, requestId, inputBytes: Math.max(parsed.bytes, encoder.encode(JSON.stringify(parsed.body)).length), secret: env('MOONDA_AI_AUDIT_SECRET') || key, env });
    } catch {
      log('admission-unavailable');
      return json(503, 'busy');
    }
    if (!admission.ok) {
      log('blocked', { clientId: admission.clientId, reason: admission.reason });
      return json(admission.status, admission.error, admission.retryAfter ? { 'retry-after': String(admission.retryAfter) } : {});
    }
    const common = { clientId: admission.clientId, inputBytes: parsed.bytes, reservedUnits: admission.tokenUnits, model: env('DEEPSEEK_MODEL') || 'deepseek-v4-pro' };
    log('admitted', common);
    let released = false;
    const finish = detail => {
      if (released) return;
      released = true;
      log('finished', { ...common, ...detail });
      const pending = admission.release().catch(() => log('release-failed', { clientId: admission.clientId }));
      context.waitUntil?.(pending);
      return pending;
    };
    try {
      const response = await proxy(parsed.body, {
        key, model: env('DEEPSEEK_MODEL'), baseUrl: env('DEEPSEEK_BASE_URL'), signal: req.signal,
        onUsage: usage => log('usage', { clientId: admission.clientId, ...usage }), onFinish: finish,
      });
      if (!response.ok) await finish({ reason: 'rejected', status: response.status });
      response.headers.set('x-moonda-ai-guard', '2026-11-16');
      return response;
    } catch {
      await finish({ reason: 'handler-error' });
      return json(500, 'service');
    }
  };
}

export const handleAi = createHandler();
