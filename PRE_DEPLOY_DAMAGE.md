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
pnpm --filter @splash/damage-worker exec wrangler secret put CLAIM_UPDATE_WEBHOOK_URL
pnpm --filter @splash/damage-worker exec wrangler secret put INTERNAL_NEW_CLAIM_WEBHOOK_URL
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
| `CLAIM_UPDATE_WEBHOOK_URL` | secret | optional, fail-soft (Brief 101) | fired on note add (recipients: rm_email + site_email) and on status changes whose `to` is in the next-actor map (recipients: site_email when GM acts next, rm_email when RM acts next). Actor's own email is excluded server-side, case-insensitive. When unbound, the note / transition still succeeds and the webhook is silently skipped. |
| `INTERNAL_NEW_CLAIM_WEBHOOK_URL` | secret | optional, fail-soft (Brief 102) | fired after every successful customer claim submission, parallel to `CUSTOMER_CLAIM_WEBHOOK_URL`. Recipients: location's `rm_email` + `site_email` + `am_email` + the `INCIDENTS_EMAIL` `[vars]` entry. Payload includes the same PDF (URL + base64 when ≤ ~3 MB raw) plus a `photos[]` array of `/claims-api/photo/{r2_key}` URLs. When unbound, the internal-notification path is silently skipped; the customer-email path, PDF generation, and claim write are all unaffected. |
| `INCIDENTS_EMAIL` | `[vars]` | optional (Brief 102) | non-secret recipient added to the `INTERNAL_NEW_CLAIM_WEBHOOK_URL` `recipients[]` array. Edit in `apps/damage-worker/wrangler.toml`. Blank / unset → incidents drops out of the recipient list (the three location addresses still receive). |

**Fail-soft contract:** if `INCIDENTS_WEBHOOK_URL`, `AP_WEBHOOK_URL`, `CUSTOMER_CLAIM_WEBHOOK_URL`, `CLAIM_UPDATE_WEBHOOK_URL`, or `INTERNAL_NEW_CLAIM_WEBHOOK_URL` are unbound, the corresponding side effect is skipped; the underlying claim/transition/PDF still completes. R2 still has the canonical record (claim JSON + photos + summary PDF).

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
  - Clicking the link opens `/claims-api/summary/<claimId>` in a new tab and renders a Splash-branded PDF with: navy header band (logo + "Vehicle Issue Report" + claim ID + timestamp), a `LOCATION` line showing only the pretty location name (no `(#code)` slug — Brief 35), Customer Information grid (Name / Email / Phone / Vehicle / License Plate), "What Happened" text block, Staff Assessment (Staff Name / Equipment-Related / Determination / What Customer Was Told), and a footer with claim ID + contact note. **No photo thumbnails** — Brief 35 dropped them; photos remain accessible via `/claims-api/photo/...`.
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

## Brief 101 — manage-page update notifications

`CLAIM_UPDATE_WEBHOOK_URL` is a per-event fan-out to Power Automate. Fires fail-soft on two intercept points:

1. **Note add** — every successful `POST /manage/api/claim/{id}/note`. Recipients: location's `rm_email` AND `site_email`, minus the actor's own email (case-insensitive).
2. **Status change** — every successful `POST /manage/api/claim/{id}/transition` whose destination is in the next-actor map below. Recipient: the single address keyed by the destination.

### Status → next-actor → recipient

| `to_status` | next actor | recipient |
|---|---|---|
| `Pending GM Review` | GM | `site_email` |
| `No Responsibility — Pending Review` | GM (escalates) | `site_email` |
| `Pending RM Review` | RM | `rm_email` |
| `Pending RM Quote Approval` | RM | `rm_email` |
| `Approved — Pending Quotes` | GM (uploads quotes) | `site_email` |

Every other destination (admin / finance / closed / vestigial) fires no notification. The map is keyed by `to` (not transition pair), so Brief 66 RM-revert paths that land on `Pending GM Review` / `Pending RM Review` etc. also fire — bounce-backs ARE the event the field needs to know about.

### Payload shape (one fire per event)

```jsonc
{
  "change_type": "note" | "status",
  "claim_id": "CL-...",
  "customer_name": "Jane Doe",
  "location_code": "binghamton",
  "location_pretty": "Binghamton",
  "admin_url": "https://splashcarwashes.info/admin/damage/CL-...",
  "actor": { "email": "gm@example.com", "dc_role": "gm" },
  "from_status": "Pending GM Review",    // status changes only
  "to_status": "Approved — Pending Quotes", // status changes only
  "note_text": "...",                    // notes always; status changes when accompanying note text supplied
  "recipients": ["site_email@example.com"], // lowercased, actor excluded, deduped
  "candidates": {
    "rm_email": "rm@example.com",
    "site_email": "site_email@example.com"
  }
}
```

`recipients` is what PA loops over with "Apply to each" → "Send email (V2)". An empty array means the helper resolved nothing (e.g., actor was the only candidate, both addresses were null) — PA should no-op gracefully.

### Operator: PA-flow setup

1. Create a new PA flow with trigger "When an HTTP request is received".
2. Paste one of the sample payloads above into "Use sample payload to generate schema" so PA exposes dynamic content.
3. Add "Apply to each" → `triggerBody()?['recipients']`.
4. Inside the loop, add "Send an email (V2)":
   - **To:** current item
   - **Subject:** branch on `change_type` (use Compose or condition):
     - `note` → `"<actor email> added a note on <customer name>'s claim at <location pretty>"`
     - `status` → `"<customer name>'s claim at <location pretty> → <to_status>"`
   - **Body:** HTML with `admin_url` as a "View claim" button, the note text in a `<blockquote>` when present, and the from/to status pair for status changes.
5. Copy the trigger URL and bind it:
   ```bash
   pnpm --filter @splash/damage-worker exec wrangler secret put CLAIM_UPDATE_WEBHOOK_URL
   ```
6. Smoke: add a note from `/admin/damage/[id]` and tail CF Workers Logs for a `[claim-update]` line; verify PA flow runs and sends the email.

When the PA flow isn't ready yet, leave the secret unbound — the worker silently no-ops the notification path and all other claim operations continue unaffected.

## Brief 102 — internal new-claim notification

`INTERNAL_NEW_CLAIM_WEBHOOK_URL` is a per-submission fan-out to Power Automate, parallel to `CUSTOMER_CLAIM_WEBHOOK_URL` (the customer-email path). Fired once per successful `POST /claims-api/submit-claim` after the customer webhook in the same post-submit block; both are guarded on their own secret being bound and on the summary-PDF generation succeeding (Brief 32 `pdfBytes`).

Two-secret design (not multiplexed through the customer hook): the PA email templates are very different (customer apology vs. internal heads-up with action link), failure of one cannot affect the other, and the on/off toggle is per-flow. Mirrors the `DAILY_SUMMARY_WEBHOOK_URL` convention (one secret per PA flow).

### Recipient resolution

| Source | Resolved from | Notes |
|---|---|---|
| `rm_email` | `pricing_simple.rm_email` for the claim's location | Regional Manager |
| `site_email` | `pricing_simple.site_email` for the claim's location | GM / on-site inbox |
| `am_email` | `pricing_simple.am_email` for the claim's location | Regional Director (label-vs-data divergence — see CLAUDE.md) |
| `incidents_email` | `[vars] INCIDENTS_EMAIL` on damage-worker | Operator-configured constant; same value across all locations. Blank / unset → drops out. |

`recipients[]` is lowercased, deduped, and has any null/blank entries dropped server-side. PA loops over the array with "Apply to each" → "Send email (V2)". No actor exclusion — the claim submitter is the public customer; their email is not a location contact.

### Payload shape

```jsonc
{
  "claim_id": "BIN-20260511-143055-AB12",
  "submitted_at": "2026-05-11T14:30:55.123Z",
  "location_code": "binghamton",
  "location_pretty": "Binghamton",
  "admin_url": "https://splashcarwashes.info/admin/damage/BIN-20260511-143055-AB12",
  "customer_name": "Jane Doe",
  "customer_email": "jane@example.com",
  "customer_phone": "5551234567",
  "vehicle": "2020 Honda Civic - Blue",
  "damage_type": "Exterior",
  "damage_other": null,
  "issue_description": "Front bumper scratch noticed after wash.",
  "recipients": [
    "rm@splashcarwashes.com",
    "binghamton-site@splashcarwashes.com",
    "rd@splashcarwashes.com",
    "incidents@splashcarwashes.com"
  ],
  "candidates": {
    "rm_email": "rm@splashcarwashes.com",
    "site_email": "binghamton-site@splashcarwashes.com",
    "am_email": "rd@splashcarwashes.com",
    "incidents_email": "incidents@splashcarwashes.com"
  },
  "summary_pdf_url": "https://splashcarwashes.info/claims-api/summary/BIN-20260511-143055-AB12",
  "summary_pdf_base64": "JVBERi0xLj... (omitted when raw PDF > 3 MB)",
  "photos": [
    {
      "url": "https://splashcarwashes.info/claims-api/photo/claims/BIN-20260511-143055-AB12/vehicle_overview_1.jpg",
      "mime": "image/jpeg",
      "original_filename": "front-bumper.jpg",
      "photo_type": "Damage",
      "uploaded_at": "2026-05-11T14:30:55.123Z"
    }
  ]
}
```

Photos: every active `claim_photos` row for the freshly-inserted claim, mapped to the existing public `/claims-api/photo/{r2_key}` serve route. At submission time only `Damage` photos exist (Quote / Receipt come from the manage page later); the helper queries unfiltered so a future expansion is no-effort. `uploaded_at` is the claim's `submitted_at` because D1 doesn't carry a per-photo timestamp; all photos arrive with the claim, so the claim's submission timestamp is the authoritative upload time at submit time.

`summary_pdf_base64` is included only when the raw PDF is ≤ ~3 MB (same `CUSTOMER_WEBHOOK_BASE64_MAX_BYTES` ceiling as the customer webhook). Above the ceiling PA can still fetch by URL.

### Operator: PA-flow setup

1. Create a new PA flow with trigger "When an HTTP request is received".
2. Paste the sample payload above into "Use sample payload to generate schema" so PA exposes dynamic content.
3. Add "Apply to each" → `triggerBody()?['recipients']`.
4. Inside the loop, add "Send an email (V2)":
   - **To:** current item
   - **Subject:** `New damage claim at <location_pretty> — <customer_name>`
   - **Body (HTML):** customer details (name / email / phone), vehicle line, damage type + description, a "View claim in Splash admin" button → `admin_url`, an attachment from `summary_pdf_base64` when present (with a fallback "Download summary PDF" link to `summary_pdf_url`), and photo thumbnails (or links) from `photos[]`.
5. Save the trigger URL and bind it:
   ```bash
   pnpm --filter @splash/damage-worker exec wrangler secret put INTERNAL_NEW_CLAIM_WEBHOOK_URL
   ```
6. Smoke: submit a test claim from `/claims/{site}` on workers.dev, tail CF Workers Logs for an `[internal-new-claim]` line, verify PA flow ran and sent emails.

### Operator: incidents inbox

`INCIDENTS_EMAIL` is a non-secret `[vars]` entry in `apps/damage-worker/wrangler.toml`. The placeholder value committed with Brief 102 is `incidents@splashcarwashes.com` — confirm or amend before push. To drop the incidents recipient entirely, set the value to `""` (or delete the line); the three location addresses keep working.

When the PA flow isn't ready yet, leave the secret unbound — the worker silently no-ops the internal-notification path. The customer-email webhook and all other claim operations are unaffected.
