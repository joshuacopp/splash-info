# PRE_DEPLOY — damage-worker

Largest port (5,684 legacy lines). Public claim form + R2 photos + D1 claim records + Power Automate webhooks for SharePoint sync + check-request PDF generation via `pdf-lib` + manager interface (auth-gated state machine).

Worker name: `splash-damage`. Currently deployed only to its `*.workers.dev` URL.

---

## Required secrets (`wrangler secret put`)

```bash
pnpm --filter @splash/damage-worker exec wrangler secret put SUPABASE_URL
pnpm --filter @splash/damage-worker exec wrangler secret put SUPABASE_ANON_KEY
pnpm --filter @splash/damage-worker exec wrangler secret put SUPABASE_SERVICE_KEY
pnpm --filter @splash/damage-worker exec wrangler secret put POWER_AUTOMATE_URL
pnpm --filter @splash/damage-worker exec wrangler secret put INCIDENTS_WEBHOOK_URL
pnpm --filter @splash/damage-worker exec wrangler secret put AP_WEBHOOK_URL
```

| Name | Type | Required? | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | string | yes | base URL of the Supabase project |
| `SUPABASE_ANON_KEY` | secret | yes | `/auth/v1/user` validation |
| `SUPABASE_SERVICE_KEY` | secret | yes | `auth_unified` reads + locations Supabase reads |
| `POWER_AUTOMATE_URL` | secret | yes (for prod) | webhook for SharePoint sync of new claims; legacy hardcoded this URL with an embedded signature |
| `INCIDENTS_WEBHOOK_URL` | secret | optional, fail-soft | fired after RM approves a quote — Incidents desk receives the auto-generated Check Request PDF |
| `AP_WEBHOOK_URL` | secret | optional, fail-soft | fired after Incidents submits for payment — AP desk receives the fully-signed Check Request PDF |

**Fail-soft contract:** if `INCIDENTS_WEBHOOK_URL` or `AP_WEBHOOK_URL` are unbound, the corresponding status transition still succeeds; an activity row notes the email-skipped outcome. R2 still has the canonical record (claim JSON + photos). Only the SharePoint/desk sync is skipped.

If `POWER_AUTOMATE_URL` is unbound, claim submissions still write to R2 + D1 successfully — only the SharePoint sync is skipped (with a `console.warn` line). For production this is a misconfiguration; for dev / smoke-test it's acceptable.

## Required bindings

### D1

```toml
[[d1_databases]]
binding = "DB"
database_name = "splash-claims"           # confirm exact db name in CF dashboard
database_id   = "00000000-0000-0000-0000-000000000000"   # MUST replace with real UUID
```

**Operator step before first deploy:** replace the placeholder UUID with the real `database_id` from the Cloudflare D1 dashboard. Without this, every D1 call 500s.

### R2

```toml
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "splash-vehicle-claims"
```

The bucket must exist before deploy. Used for:
- `claims/{claimId}/{type}_{n}.{ext}` — customer photos + Quote/Receipt docs
- `submissions/{claimId}.json` — full claim JSON archive (canonical record, written unconditionally)
- `failed_submissions/{claimId}.json` — Power Automate failure fallback
- `templates/check-request.pdf` — **AcroForm template; operator MUST upload before any check-request transition can succeed**

### Images (Cloudflare Images binding — optional)

```toml
[images]
binding = "IMAGES"
```

Used for HEIC→JPEG conversion in `uploadClaimPhoto`. **Optional** — when the binding is unset, HEIC photos store as-is. Customers on iPhones produce HEIC; without this binding, downstream tools may not display them correctly. Bind for production; skip for dev.

## Smoke-test checklist

After `pnpm --filter @splash/damage-worker deploy`:

```bash
WORKER=https://splash-damage.<ACCOUNT>.workers.dev

# 1. Public landing page (no auth):
curl -i "$WORKER/claims"
# → 200 HTML

# 2. Public claim form for a site:
curl -i "$WORKER/claims/binghamton"
# → 200 HTML

# 3. Photo serving (after a claim has been submitted):
curl -i "$WORKER/claims-api/photo/<claim_id>/vehicle_overview_1.jpg"
# → 200 image/jpeg with Cache-Control: public, max-age=86400

# 4. /manage/api/* without auth → 401.
curl -i "$WORKER/manage/api/claims"

# 5. /manage/api/* without "claims" tool grant → 403.
curl -i "$WORKER/manage/api/claims" -H "Cookie: sb-access-token=<no-claims-grant token>"

# 6. /manage/api/claims with valid claims-tool grant + dc_role:
curl -i "$WORKER/manage/api/claims" -H "Cookie: sb-access-token=<gm/rm/admin/super_admin token>"
# → 200 [...claims scoped by dc_role...]

# 7. CSRF on a transition POST → 403 bad origin.
curl -i -X POST "$WORKER/manage/api/claim/<id>/note" \
  -H "Origin: https://malicious.example.com" \
  -H "Content-Type: application/json" \
  --data '{"note":"x"}'
```

**Manual checks:**

- [ ] Submit a test claim (with photos) through `POST /claims-api/submit-claim` and confirm:
  - R2 `submissions/{claimId}.json` exists (unconditional archive)
  - D1 `claims` row inserted with the correct `location_pretty` (D1-canonical, resolved before PA POST per Chunk 4)
  - `claim_photos` rows inserted, R2 keys point at real objects
  - Power Automate received the JSON (check Power Automate run history)
- [ ] Status transition from "Pending RM Quote Approval" → "Approved — Check Request Submitted" with a valid quote produces:
  - Claim row updated (claim_status, lifecycle_state, rm_approved_at/by, approved_amount, approved_quote_id)
  - `claim_photos` row of `photo_type='Check Request'` (the generated PDF)
  - `claim_activity` rows for the status_change AND the document_added (PDF outcome)
  - Webhook to `INCIDENTS_WEBHOOK_URL` succeeded (or activity row notes failure)
- [ ] gm/rm users see only claims at their `dcLocations`; out-of-scope claims return 404 (anti-leak).
- [ ] super_admin sees every claim regardless of location.
- [ ] Photo upload of an HEIC file converts to JPEG when `IMAGES` is bound, otherwise stores as `.heic`.

## Production route binding (cutover-time)

In `apps/damage-worker/wrangler.toml`, uncomment:

```toml
routes = [
  { pattern = "splashcarwashes.info/claims-api/submit-claim", zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/claims-api/photo/*",      zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/manage/api/*",            zone_name = "splashcarwashes.info" }
]
```

Then redeploy. damage-worker has no production traffic today; cutover is low-risk. Note that the public form pages (`/claims/{site}` and `/manage/*` HTML) are owned by apps/web post-cutover, NOT this worker — the worker is API-only.
