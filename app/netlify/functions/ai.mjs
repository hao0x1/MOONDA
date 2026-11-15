import { handleAi } from '../../server/aiHandler.mjs';

export default (req, context) => handleAi(req, context, name => globalThis.Netlify?.env.get(name) ?? process.env[name]);

export const config = {
  path: '/api/ai',
  rateLimit: { action: 'rate_limit', windowSize: 60, windowLimit: 12, aggregateBy: ['ip', 'domain'] },
};
