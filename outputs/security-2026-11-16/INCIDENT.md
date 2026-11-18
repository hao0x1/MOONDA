# MOONDA AI incident — 16 November 2026

## Confirmed usage

DeepSeek's per-key export for **moonda**, 00:00–01:00 Cambodia time (15 November 17:00–18:00 UTC), records **353 Pro requests**, **15,947,611 tokens**, and **¥37.4647827 CNY**. This is the confirmed cost of this spike; it does not establish a US$35 loss. The original account screenshot was filtered to All keys and showed ¥165.82 CNY total cost across the account. MOONDA's prior-day filter showed 97 requests / ¥2.88 CNY.

The incident export breaks tokens into 13,140,608 cached input tokens, 266,761 uncached input tokens, and 2,540,242 output tokens. The output averages roughly 7,196 tokens per request. Cloudflare edge counts are separate from provider billing and cannot be matched one-to-one.

## Recovered source evidence (private)

Cloudflare's exact-hour /api/ai view reports **1,079 requests**, including **1,077 POSTs**, **362 HTTP 200**, **709 HTTP 503**, six HTTP 499 disconnects and two HTTP 405 GETs. The dashboard's analytics can be sampled, so preserve the native exports rather than treating these as a complete provider ledger.

**113.130.126.113** accounts for **1,074 requests (99.54%)**. Cloudflare associates that address with **ASN 38901 / EZECOM, Cambodia**. User-agent totals include **980 Python/3.14 aiohttp/3.14.5** requests and **88 curl/8.22.0** requests. Most activity occurred around 00:06–00:14. An individual sampled record confirms an aiohttp POST to /api/ai at 00:14.

This supports scripted use of the public endpoint. It does not identify a person, account holder, precise location or motive, and does not prove a hackathon participant was responsible. User-agent headers can be spoofed. This IP also browsed the app normally later and issued many POSTs to other paths. A shared NAT, owner/test script, VPN or another user on the same network remains possible. No obvious generator was found in the checked project scripts, but this does not rule out other machines or automation. The current verification connection used a different source IP.

Native JSON exports, exact filter URLs, hashes and detailed limitations are in `cloudflare-private/`. DeepSeek CSV exports and the original screenshots are retained beside this report. No named individual was accused.

## Exposure and containment

The previous public endpoint accepted paid requests without authentication or rate limits, up to 600,000 characters / 120 messages, and passed caller-supplied tools upstream. This allowed endpoint abuse without stealing the server key. No sk-shaped key was found in the checked current tracked files, built client assets or 18 Git commits. Leakage elsewhere cannot be excluded.

The user replaced DEEPSEEK_API_KEY in Netlify and confirmed revoking the old key. The protected deployment successfully answered in the live moonda.us UI after revocation. A direct test of the previous deployment returned HTTP 502 with provider status **401** / error **no-key**, verifying that old deployment cannot use its frozen credential.

New controls keep Pro reasoning and enforce 96 KiB UTF-8 payloads, validated local function tools, no provider search tools or client billing overrides, a 180-second generation ceiling, and upstream cancellation. Native Netlify enforcement is 12 requests/minute/IP/domain, verified with a live 429 after its enforcement delay. Shared immutable admission permits add 30 calls/IP/clock-hour, 80/IP/day, 150 global/day and 1,048,576 conservative reserved units/day. The reserved allowance can pause AI for the remainder of the Cambodia day; the Moon explorer stays available. It is not a guaranteed currency budget. Stale-list/concurrent-claim tests verify slots cannot be over-allocated. Failed or partial reservations stay consumed conservatively.

New deployment URLs reject AI calls by hostname and preview context; the stable custom/Netlify domains share the same quota store. Origin checks provide browser hygiene, not authentication. Rotating IPs cannot bypass the site's shared daily allowance. Historical deployments remain reachable but their revoked key is invalid.

## Validation

Offline proxy, admission race and HTTP handler checks passed, as did TypeScript and the production build. Live tests covered a normal streamed answer, rejected origin, rejected native search tool, the native 429 limiter, the new-key browser answer and the old-key 401. See `native-rate-check.json`, `old-deploy-key-revocation-check.json`, `final-live-verification.json`, and `moon-ai-after-key-rotation.jpg`.

Code is on local branch `codex/moonda-ai-abuse-guard-2026-11-16`; unrelated working files were preserved. Deployment and final audit verification are recorded in `deployment-verification.json`.

The final published deployment is `6afa3c5cd63d38cf54aea16b` (commit `3f1823a`). A final post-revocation stream returned HTTP 200 / [DONE], and its immutable completion receipt was independently fetched through the official Netlify Blobs CLI, including reported token totals. This durable record is used because streamed console completion messages did not appear reliably in the legacy Netlify request log.

## Reporting drafts and submissions

Two factual drafts are saved beside this report: `EZECOM-abuse-report-DRAFT.txt` and `DeepSeek-usage-review-DRAFT.txt`. They request investigation and evidence preservation without accusing a named person or requesting public subscriber disclosure. The DeepSeek draft needs the account login email filled in.

Verified channels on 16 November 2026:

- EZECOM network incident response: irt@ezecomcorp.com, listed in [APNIC RDAP for the source range](https://rdap.apnic.net/ip/113.130.126.113) and [APNIC AS38901](https://wq.apnic.net/apnic-bin/whois.pl?object_type=aut-num&searchtext=AS38901).
- DeepSeek API support: api-service@deepseek.com, listed in [DeepSeek's official API documentation](https://api-docs.deepseek.com/api/deepseek-api/).

The user authorized sending both reports. Final versions were sent from zhihaowu003@gmail.com at approximately 06:43 Cambodia time on 16 November 2026. Both messages were verified in Gmail Sent with their evidence attachments. No face, personal profile, identity or subscriber information has been sought. Cloudflare's public abuse form concerns abuse involving websites/services on its network; it is not presented here as the way to identify an incoming website visitor.

### Submission verification

- EZECOM: irt@ezecomcorp.com; sent message `1a1e197dd0ba13a1`; attachment `EZECOM-incident-evidence.txt` (1,481 bytes). Requested investigation, evidence preservation and a case reference.
- DeepSeek: api-service@deepseek.com; sent message `1a1e19823b7ca1d5`; attachment `DeepSeek-incident-evidence.txt` (3,000 bytes). Requested a CNY37.46 refund or equivalent account credit, usage investigation, preservation of records, review of nearby anomalous usage and a case reference.
- The DeepSeek login email was verified from provider account emails in the authenticated Gmail account before submission. Exact final bodies are saved in `EZECOM-report-FINAL.txt` and `DeepSeek-report-FINAL.txt`; original drafts remain as preparation records.
- Verified Gmail Sent metadata and message links are in `report-submission-receipts.json`. Sent status does not establish recipient receipt, case acceptance or refund approval.
