import { handleAi } from '../../server/aiHandler.mjs';

export default (req, context) => handleAi(req, context);

export const config = {
  path: '/api/ai',
  rateLimit: { action: 'rate_limit', windowSize: 60, windowLimit: 12, aggregateBy: ['ip', 'domain'] },
};
