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
pnpm --filter @splash/damage-worker exec wrangler secret put CUSTOMER_CLAIM_WEBHOOK_URL
```

| Name | Type | Required? | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | string | yes | base URL of the Supabase project |
| `SUPABASE_ANON_KEY` | secret | yes | `/auth/v1/user` validation |
| `SUPABASE_SERVICE_KEY` | secret | yes | `auth_unified` reads + locations Supabase reads |
| `POWER_AUTOMATE_URL` | secret | yes (for prod) | webhook for SharePoint sync of new claims; legacy hardcoded this URL with an embedded signature |
| `INCIDENTS_WEBHOOK_URL` | secret | optional, fail-soft | fired after RM approves a quote — Incidents desk receives the auto-generated Check Request PDF |
| `AP_WEBHOOK_URL` | secret | optional, fail-soft | fired after Incidents submits for payment — AP desk receives the fully-signed Check Request PDF |
| `CUSTOMER_CLAIM_WEBHOOK_URL` | secret | optional, fail-soft (Brief 32) | fired after a customer-submitted claim — PA receives the auto-generated claim summary PDF URL + customer email and emails the customer their copy. When unbound, PDF still generates and the outcome card surfaces a "Download a copy" link. |

**Fail-soft contract:** if `INCIDENTS_WEBHOOK_URL`, `AP_WEBHOOK_URL`, or `CUSTOMER_CLAIM_WEBHOOK_URL` are unbound, the corresponding side effect (Incidents email / AP email / customer-copy email) is skipped; the underlying claim/transition/PDF still completes. R2 still has the canonical record (claim JSON + photos + summary PDF).

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
- `claims/{claimId}/summary.pdf` — auto-generated customer-facing claim summary PDF (Brief 32)
- `submissions/{claimId}.json` — full claim JSON archive (canonical record, written unconditionally)
- `failed_submissions/{claimId}.json` — Power Automate failure fallback
- `templates/check-request.pdf` — **AcroForm template; operator MUST upload before any check-request transition can succeed**
- `assets/splash-logo-white.png` — **Brief 32 brand logo** for the claim summary PDF header band; ~144×36 pt white-on-navy PNG (4× raster fine). Optional: when missing, the worker falls back to fetching `ASSETS.logoWhite` over HTTPS, so claim submissions still succeed but incur an extra 50-200 ms.

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
- [ ] **(Brief 32)** Submit a customer claim from `/claims/{site}` with a real email and verify:
  - The post-submit outcome card shows a **Download a copy (PDF)** link.
  - Clicking the link opens `/claims-api/summary/<claimId>` in a new tab and renders a Splash-branded PDF with: navy header band (logo + "Vehicle Issue Report" + claim ID + timestamp), Customer Information grid (Name / Email / Phone / Vehicle / License Plate), "What Happened" text block, up to 4 photo thumbnails (or none if photos failed to load), Staff Assessment (Staff Name / Equipment-Related / Determination / What Customer Was Told), and a footer with claim ID + contact note.
  - R2 contains an object at `claims/<claimId>/summary.pdf` (verifiable via `wrangler r2 object get`).
  - If `CUSTOMER_CLAIM_WEBHOOK_URL` is bound, the configured PA flow received a JSON POST with `claim_id`, `customer_email`, `summary_pdf_url`, and (for PDFs ≤ 3 MB) `summary_pdf_base64`.
  - If `CUSTOMER_CLAIM_WEBHOOK_URL` is **un**bound, the submission still succeeds and the outcome card still shows the download link (verifies fail-soft).
- [ ] **(Brief 32)** Submit a customer claim with the email field empty: form-side HTML5 validation should block submit. If you bypass with a programmatic curl/fetch (no email), the worker returns `400 { ok: false, error: "Email required" }` (JSON mode) or 303-redirects back to `/claims/<slug>?error=Email%20required` (browser mode).

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
