// k6 load test — no sleep between iterations, but rate-capped and self-aborting.
// Run:  k6 run loadtest/k6-stress.js
// Smoke first: k6 run --vus 5 --duration 20s loadtest/k6-stress.js
// Override target: BASE=https://your-domain k6 run loadtest/k6-stress.js

import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE || 'https://astro-si.onrender.com';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 300,
      gracefulStop: '15s',
      stages: [
        { target: 5,  duration: '30s' }, // warm
        { target: 20, duration: '60s' }, // ~normal peak for a small site
        { target: 50, duration: '60s' }, // 2-3x peak
        { target: 0,  duration: '20s' }, // cool down
      ],
    },
  },

  // The governor: stops the run itself instead of you watching a terminal.
  thresholds: {
    http_req_failed: [
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '20s' },
    ],
    http_req_duration: [
      { threshold: 'p(95)<2500', abortOnFail: true, delayAbortEval: '20s' },
    ],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

export default function () {
  const res = http.get(`${BASE}/`, {
    tags: { name: 'home' },
    headers: { 'User-Agent': 'k6-loadtest (owned-site verification)' },
  });

  check(res, {
    'status 200': (r) => r.status === 200,
    'origin hit':  (r) => r.headers['Cf-Cache-Status'] !== 'HIT',
  });
}
