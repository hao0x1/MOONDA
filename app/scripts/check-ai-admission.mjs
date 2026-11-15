// Atomic-create contract checks. The fake store makes all listings stale and
// races writes at the onlyIfNew boundary; no provider or production data is used.
import assert from 'node:assert/strict';
import { createAdmission, clientIdentifier, ADMISSION_LIMITS, ADMISSION_STORE } from '../server/aiAdmission.mjs';

const secret = 'isolated-admission-test-secret';
const ip = '192.0.2.1';
let sequence = 0;
let current = Date.parse('2026-11-15T17:15:00Z'); // 00:15 Cambodia
const env = values => name => values[name];
function fixture({ stale = false, fail = false } = {}) {
  const records = new Map();
  let writes = 0;
  const store = {
    async list({ prefix }) {
      if (fail) throw new Error('storage unavailable');
      await Promise.resolve();
      return { blobs: stale ? [] : [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) };
    },
    async setJSON(key, value, options) {
      assert.deepEqual(options, { onlyIfNew: true });
      await Promise.resolve(); // interleave all contenders before atomic check/create
      if (fail) throw new Error('storage unavailable');
      writes++;
      if (records.has(key)) return { modified: false };
      records.set(key, structuredClone(value));
      return { modified: true, etag: crypto.randomUUID() };
    },
  };
  const open = options => {
    assert.deepEqual(options, { name: ADMISSION_STORE, consistency: 'strong' });
    return store;
  };
  return { records, make: () => createAdmission({ getStore: open, now: () => current }), writes: () => writes };
}
const request = (admission, overrides = {}) => admission({ ip, requestId: `test-${++sequence}`, inputBytes: 100, secret, ...overrides });

const id = await clientIdentifier(ip, secret);
assert.equal(id.length, 64);
assert.equal(id, await clientIdentifier(ip, secret));
assert.notEqual(id, await clientIdentifier('192.0.2.2', secret));
assert.notEqual(id, await clientIdentifier(ip, `${secret}-other`));
assert.equal((await request(fixture().make(), { ip: '' })).status, 503);
assert.equal((await request(fixture().make(), { secret: '' })).status, 503);
assert.equal((await request(fixture().make(), { inputBytes: NaN })).status, 400);
assert.equal((await request(fixture({ fail: true }).make())).status, 503);

// Stale reads cannot overshoot a fixed number of immutable hourly permits.
const hourly = fixture({ stale: true });
const hourRace = await Promise.all(Array.from({ length: 50 }, () => request(hourly.make(), { env: env({ AI_IP_HOURLY_LIMIT: '3' }) })));
assert.equal(hourRace.filter(result => result.ok).length, 3);
assert(hourRace.filter(result => !result.ok).every(result => result.reason === 'client-hourly'));
const first = hourRace.find(result => result.ok);
const writeCount = hourly.writes();
const recordCount = hourly.records.size;
await first.release();
await first.release();
assert.equal(hourly.writes(), writeCount);
assert.equal(hourly.records.size, recordCount);
assert.equal((await request(hourly.make(), { env: env({ AI_IP_HOURLY_LIMIT: '3' }) })).reason, 'client-hourly');

const global = fixture({ stale: true });
const globalRace = await Promise.all(Array.from({ length: 40 }, (_, n) => request(global.make(), { ip: `198.51.100.${n + 1}`, env: env({ AI_GLOBAL_DAILY_LIMIT: '4' }) })));
assert.equal(globalRace.filter(result => result.ok).length, 4);
assert(globalRace.filter(result => !result.ok).every(result => result.reason === 'global-daily' && result.error === 'budget-limit'));
assert.equal([...global.records.keys()].filter(key => key.includes('/global-day/')).length, 4);

// Each large request needs two budget permits. Racing independent isolates may
// burn partial permits, but can never admit more work than the four-slot budget.
const budget = fixture({ stale: true });
const budgetRace = await Promise.all(Array.from({ length: 30 }, (_, n) => request(budget.make(), { ip: `203.0.113.${n + 1}`, inputBytes: 20_000, env: env({ AI_DAILY_TOKEN_BUDGET: String(4 * ADMISSION_LIMITS.unitSize) }) })));
assert(budgetRace.filter(result => result.ok).length <= 2);
assert(budgetRace.filter(result => result.ok).every(result => result.tokenUnits === 2 * ADMISSION_LIMITS.unitSize));
assert(budgetRace.filter(result => !result.ok).every(result => result.reason === 'daily-budget'));
assert.equal([...budget.records.keys()].filter(key => key.includes('/budget-day/')).length, 4);

const fullBudget = fixture({ stale: true });
const unitRace = await Promise.all(Array.from({ length: 100 }, (_, n) => request(fullBudget.make(), { ip: `203.0.113.${n + 1}` })));
assert.equal(unitRace.filter(result => result.ok).length, 64);
assert.equal(unitRace.filter(result => result.ok).reduce((sum, result) => sum + result.tokenUnits, 0), ADMISSION_LIMITS.dailyUnits);
assert(unitRace.filter(result => !result.ok).every(result => result.reason === 'daily-budget'));

const daily = fixture();
const dailyEnv = env({ AI_IP_DAILY_LIMIT: '2' });
assert((await request(daily.make(), { env: dailyEnv })).ok);
assert((await request(daily.make(), { env: dailyEnv })).ok);
assert.equal((await request(daily.make(), { env: dailyEnv })).reason, 'client-daily');
current += 3_600_000;
assert.equal((await request(daily.make(), { env: dailyEnv })).reason, 'client-daily');
current = Date.parse('2026-11-16T17:00:00Z'); // next Cambodia midnight
assert((await request(daily.make(), { env: dailyEnv })).ok);
assert([...daily.records.keys()].some(key => key.includes('/2026-11-16/')));
assert([...daily.records.keys()].some(key => key.includes('/2026-11-17/')));

const beforeOversize = daily.records.size;
assert.equal((await request(daily.make(), { inputBytes: 1_000_000, env: env({ AI_DAILY_TOKEN_BUDGET: '65536' }) })).reason, 'daily-budget');
assert.equal(daily.records.size, beforeOversize);
for (const [key, receipt] of fullBudget.records) {
  assert(!key.includes('203.0.113.'));
  assert(!JSON.stringify(receipt).includes(secret));
  assert.deepEqual(Object.keys(receipt).sort(), ['clientId', 'createdAt', 'expiresAt', 'requestId', 'scope']);
}
console.log('AI permit checks passed: concurrent atomic creates, stale listings, hourly/daily/global limits, reserved budget, partial claims, Cambodia midnight, no refunds, HMAC, and fail-closed storage.');
