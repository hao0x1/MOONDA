// Durable admission uses finite, write-once permits in a site-wide Blobs store.
// A permit is claimed ONLY with atomic onlyIfNew. There are no mutable counters,
// read-modify-write operations, refunds, leases, or request-time deletions.
// Partial claims stay consumed if a later scope fails: this can reduce available
// capacity, but concurrent edge isolates can never create extra permits.

export const ADMISSION_LIMITS = Object.freeze({
  hourly: 30,
  daily: 80,
  globalDaily: 150,
  unitSize: 16_384,
  dailyUnits: 1_048_576,
});
export const ADMISSION_STORE = 'moonda-ai-admission-v1';
const encoder = new TextEncoder();
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CAMBODIA_OFFSET = 7 * HOUR_MS;

function lowerLimit(env, name, ceiling) {
  const value = env?.(name);
  if (value === undefined || value === null || value === '') return ceiling;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, ceiling) : ceiling;
}

/** Purpose-separated HMAC; the raw network address is never persisted. */
export async function clientIdentifier(ip, secret) {
  if (typeof ip !== 'string' || !ip || ip.length > 128 || /[\s,]/.test(ip)) throw new Error('missing-client');
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('missing-secret');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`moonda-ai-client-v1:${ip}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Lists only avoid known occupied slots. A stale/empty listing cannot grant extra
 * work: each attempted slot still requires an atomic create at the store.
 */
async function claim(store, prefix, capacity, needed, receipt) {
  if (needed > capacity || capacity < 1) return false;
  const listing = await store.list({ prefix });
  if (!Array.isArray(listing?.blobs)) throw new Error('invalid-store-list');
  const occupied = new Set(listing.blobs.map(blob => blob.key));
  let claimed = 0;
  const start = crypto.getRandomValues(new Uint32Array(1))[0] % capacity;
  for (let step = 0; step < capacity; step++) {
    const slot = (start + step) % capacity;
    const key = `${prefix}${String(slot).padStart(3, '0')}`;
    if (occupied.has(key)) continue;
    const result = await store.setJSON(key, receipt, { onlyIfNew: true });
    if (!result || typeof result.modified !== 'boolean') throw new Error('invalid-store-write');
    if (result.modified && ++claimed === needed) return true;
  }
  return false;
}

/** getStore/now are injectable for deterministic atomic-create race checks. */
export function createAdmission({ getStore, now = Date.now } = {}) {
  const store = async () => {
    const open = getStore || (await import('@netlify/blobs')).getStore;
    // Open inside each invocation so runtime credentials come from its current
    // context. Site-wide scope shares quotas across production domains/deploys;
    // the HTTP handler rejects preview/deploy URLs.
    return open({ name: ADMISSION_STORE, consistency: 'strong' });
  };
  return async function admit({ ip, requestId = '', inputBytes, secret, env } = {}) {
    let clientId;
    try {
      clientId = await clientIdentifier(ip, secret);
      if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > 1_000_000) {
        return { ok: false, status: 400, error: 'bad-request', reason: 'invalid-size', clientId };
      }
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0) throw new Error('invalid-clock');
      const local = new Date(current + CAMBODIA_OFFSET).toISOString();
      const day = local.slice(0, 10);
      const hour = local.slice(0, 13);
      const dayEnd = (Math.floor((current + CAMBODIA_OFFSET) / DAY_MS) + 1) * DAY_MS - CAMBODIA_OFFSET;
      const hourEnd = (Math.floor(current / HOUR_MS) + 1) * HOUR_MS;
      const dayRetry = Math.max(1, Math.ceil((dayEnd - current) / 1000));
      const hourRetry = Math.max(1, Math.ceil((hourEnd - current) / 1000));
      const estimate = inputBytes + 8192 + 4096;
      const unitsNeeded = Math.ceil(estimate / ADMISSION_LIMITS.unitSize);
      const unitCapacity = Math.floor(lowerLimit(env, 'AI_DAILY_TOKEN_BUDGET', ADMISSION_LIMITS.dailyUnits) / ADMISSION_LIMITS.unitSize);
      const denied = (reason, retryAfter) => ({
        ok: false, status: 429,
        error: ['global-daily', 'daily-budget'].includes(reason) ? 'budget-limit' : 'rate-limit',
        reason, retryAfter, clientId,
      });
      if (unitsNeeded > unitCapacity) return denied('daily-budget', dayRetry);
      const permits = await store();
      const receipt = {
        requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : '',
        clientId, createdAt: current, expiresAt: dayEnd,
      };
      const scopes = [
        [`v1/client-hour/${hour}/${clientId}/`, lowerLimit(env, 'AI_IP_HOURLY_LIMIT', ADMISSION_LIMITS.hourly), 1, 'client-hourly', hourRetry],
        [`v1/client-day/${day}/${clientId}/`, lowerLimit(env, 'AI_IP_DAILY_LIMIT', ADMISSION_LIMITS.daily), 1, 'client-daily', dayRetry],
        [`v1/global-day/${day}/`, lowerLimit(env, 'AI_GLOBAL_DAILY_LIMIT', ADMISSION_LIMITS.globalDaily), 1, 'global-daily', dayRetry],
        [`v1/budget-day/${day}/`, unitCapacity, unitsNeeded, 'daily-budget', dayRetry],
      ];
      for (const [prefix, capacity, needed, reason, retryAfter] of scopes) {
        const expiresAt = reason === 'client-hourly' ? hourEnd : dayEnd;
        if (!await claim(permits, prefix, capacity, needed, { ...receipt, expiresAt, scope: reason })) return denied(reason, retryAfter);
      }
      return {
        ok: true, clientId, tokenUnits: unitsNeeded * ADMISSION_LIMITS.unitSize,
        // Accepted/partially consumed permits are never refunded. Keep the same
        // lifecycle API as the stream handler; finishing does not mutate storage.
        async release() {},
      };
    } catch {
      // Driver errors can contain credentials. Return a fixed code and fail closed.
      return { ok: false, status: 503, error: 'service', reason: 'admission-unavailable', retryAfter: 30, clientId };
    }
  };
}

export const admit = createAdmission();
