# Moon AI usage controls

The public AI routes share `app/server/aiHandler.mjs`, including the Edge route
and serverless fallback. Credentials stay in Netlify Functions environment
variables. Replacing a variable requires deploying again.

Paid requests are admitted using site-wide, immutable Netlify Blobs permits.
Every permit is created with `onlyIfNew`; quota records are never incremented,
overwritten, refunded, or reused. Concurrent callers compete for a finite set
of slots. A failed multi-scope reservation can consume unused permits, which
reduces availability conservatively rather than allowing extra paid requests.
This works on the existing Netlify plan without provisioning a database.

Default ceilings:

- 12 requests per minute per IP/domain at Netlify's edge. Enforcement can lag.
- 30 upstream requests per IP per clock hour and 80 per Cambodia calendar day.
- 150 upstream requests per day across the site.
- A shared daily pool of 64 permits worth 16,384 reservation units each.
  Each request reserves its UTF-8 request bytes, the full 8,192 output-token
  allowance, and 4,096 framing units, rounded up to whole permits.

Reservation units are a conservative allowance, not a measured token count
or a guaranteed currency budget. Failed requests keep their reservations.
Native limits are per domain; the durable limits share one site-wide store
across the custom and Netlify domains. Visitors sharing a public IP also
share its limits. Fixed hourly windows can allow requests on both sides of
an hour boundary; the shared daily pool remains the spending safeguard.

The server accepts at most 96 KiB UTF-8, validates text messages and the app's
seven local function tools, and rejects provider-native search tools and
caller-supplied model/billing options. Pro reasoning remains enabled.
Provider generation stops on disconnect or after 180 seconds. Quota storage
failure blocks paid work. Responses explain usage limits in English/Khmer.

The origin check prevents ordinary cross-site browser calls; it is not user
authentication. Scripts can imitate browser headers. IP limits and the
shared allowance provide the billing controls. Accounts or a challenge would
be needed to distinguish individual visitors behind shared or rotating IPs.

Logs contain request IDs, keyed client identifiers, request sizes, reserved
units, completion status, and reported token totals. They contain no API
keys, chat contents, or raw client IPs. Set `MOONDA_AI_AUDIT_SECRET` to a
stable random server-only secret to preserve identifiers across API-key
rotations; otherwise the provider key is the HMAC secret.

Completion receipts are also appended as immutable `v1/audit/<day>/<uuid>`
objects in the admission store. This keeps the record available beyond the
hosting plan's short console-log window. Completion writes never refund or
alter permits. Old permits and audit receipts are retained; their date-scoped
keys prevent reuse after expiration. No automatic deletion job is installed.

## Credential replacement

Create a replacement DeepSeek key, update `DEEPSEEK_API_KEY` in Netlify's
Functions scope, deploy and verify one small answer, then revoke the old key
at DeepSeek. Historical deploys retain their original code and environment,
so deploying protected code alone cannot secure the old credential.
Do not put a replacement key in chat, source files, screenshots, or a client
environment variable. `MOONDA_AI_ENABLED=false` plus a deploy pauses paid AI
without disabling the Moon explorer.

## Verification

Run `node scripts/check-ai-proxy.mjs`, `node scripts/check-ai-admission.mjs`,
and `node scripts/check-ai-handler.mjs` from `app/`, then `npm run build`.
Admission tests exercise simultaneous permit claims and persistence failure
without calling DeepSeek. Verify the published route's
`x-moonda-ai-guard: 2026-11-16` header and a small streamed answer after deploy.
