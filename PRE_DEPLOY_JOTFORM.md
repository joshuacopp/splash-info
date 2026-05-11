# PRE_DEPLOY_JOTFORM.md

Operator runbook for `splash-jotform` (Brief 107). Mirrors the layout of
`PRE_DEPLOY_FLEET.md`.

The worker ingests JotForm Enterprise submissions for four onboarded
forms (rewash / salt-log / retention / time-card-edit) into Supabase
tables `jotform_forms` + `jotform_submissions`, and exposes an
admin-gated read API at `/admin/jotform/api/*` for the apps/web viewer
landing in a follow-up brief (108). Public webhook receiver lives at
`/jotform/webhook/{token}/{form_id}`.

---

## 1. Supabase schema (operator runs once)

Paste this into the Supabase SQL Editor. Idempotent — safe to re-run.

```sql
-- Per-form metadata: slug, display name, enabled flag.
CREATE TABLE IF NOT EXISTS jotform_forms (
  form_id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The four onboarded forms.
INSERT INTO jotform_forms (form_id, slug, display_name) VALUES
  ('250165655616055', 'rewash',         'Rewash'),
  ('243523811897060', 'salt-log',       'Salt Log'),
  ('250855287972067', 'retention',      'Retention'),
  ('250193775451056', 'time-card-edit', 'Time Card Edit')
ON CONFLICT (form_id) DO NOTHING;

-- Submissions: common filterable fields promoted; rest in JSONB.
CREATE TABLE IF NOT EXISTS jotform_submissions (
  id text PRIMARY KEY,
  form_id text NOT NULL REFERENCES jotform_forms(form_id),
  site_number text,
  site text,
  site_email text,
  jotform_created_at timestamptz NOT NULL,
  jotform_updated_at timestamptz,
  jotform_status text,
  answers jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jotform_subs_form_created
  ON jotform_submissions (form_id, jotform_created_at DESC);

CREATE INDEX IF NOT EXISTS jotform_subs_form_site
  ON jotform_submissions (form_id, site_number);
```

Onboarding form #5 / #6 (operator-confirmed cap): `INSERT` a row into
`jotform_forms`, then run a backfill (Section 3) + configure the
webhook (Section 4). No code change.

---

## 2. Bind worker secrets

Five bindings — three secrets, plus the two `[vars]` already in
`wrangler.toml`. Run each `wrangler secret put` inside the worker's
directory or via `pnpm --filter @splash/jotform-worker exec wrangler
secret put NAME` (CLAUDE.md note: `wrangler --filter` does NOT exist;
that's a pnpm flag).

```powershell
# Required — Supabase service role key (same value as the other workers).
pnpm --filter @splash/jotform-worker exec wrangler secret put SUPABASE_SERVICE_KEY

# Required — Supabase anon key (for @splash/auth /auth/v1/user).
pnpm --filter @splash/jotform-worker exec wrangler secret put SUPABASE_ANON_KEY

# Required — JotForm Enterprise API key (Account → API → Create New Key).
# Recommended permission level: Read-only is sufficient (we never PATCH
# or DELETE JotForm).
pnpm --filter @splash/jotform-worker exec wrangler secret put JOTFORM_API_KEY

# Required — random URL-path token for webhook auth.
# Generate a fresh value:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
# 48 hex chars is plenty; JotForm's webhook URL field has no length cap.
pnpm --filter @splash/jotform-worker exec wrangler secret put JOTFORM_WEBHOOK_TOKEN
```

Verify with:

```powershell
pnpm --filter @splash/jotform-worker exec wrangler secret list
```

Expected output: `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`,
`JOTFORM_API_KEY`, `JOTFORM_WEBHOOK_TOKEN`.

`[vars]` block in `wrangler.toml` (already committed):
- `SUPABASE_URL`     — mirror across workers
- `JOTFORM_BASE_URL` — `https://splashcarwashes.jotform.com`

---

## 3. Backfill (per form, one-shot per form)

Smallest form first so you spot any issue early. The backfill endpoint
paginates one page (up to 1000 rows) per call; the operator drives the
loop by re-invoking with the returned `last_id` until `has_more: false`.

`POST /admin/jotform/api/{form_id}/backfill?after_id={lastId}`

Cookie auth required (super_admin only — must hold the dashboard SSO
session in the browser). Easiest way is via `curl` with the
`sb-access-token` cookie copied from a logged-in browser session, OR
via the apps/web admin shell once Brief 108 lands.

Sample loop in PowerShell (`$cookie` = your sb-access-token value):

```powershell
$cookie  = "PASTE_SB_ACCESS_TOKEN_HERE"
$formId  = "243523811897060"   # salt-log (start with the smallest)
$base    = "https://splash-jotform.<account>.workers.dev"
$afterId = $null

do {
  $url = "$base/admin/jotform/api/$formId/backfill"
  if ($afterId) { $url += "?after_id=$afterId" }
  $resp = Invoke-RestMethod -Method POST -Uri $url -Headers @{ Cookie = "sb-access-token=$cookie" }
  Write-Host ("inserted={0} last_id={1} has_more={2}" -f $resp.inserted, $resp.last_id, $resp.has_more)
  $afterId = $resp.last_id
} while ($resp.has_more)
```

Repeat for each `form_id`:
- `250165655616055`  rewash         (~30K rows; 30 pages × ~1-3s each)
- `243523811897060`  salt-log
- `250855287972067`  retention
- `250193775451056`  time-card-edit

Spot-check Supabase post-backfill: row counts in `jotform_submissions`
by `form_id` should match JotForm's "Submissions" tally per form.

---

## 4. JotForm webhook configuration (per form)

Each form's webhook URL pattern:

```
https://splash-jotform.<account>.workers.dev/jotform/webhook/{JOTFORM_WEBHOOK_TOKEN}/{form_id}
```

In each form's **Settings → Integrations → Webhooks**:

1. Click "Add Webhook".
2. Paste the URL above with the actual token and the form's id.
3. Save.

Repeat for all four forms (and any new form added in the future).

**Token rotation procedure** (if/when you need to rotate):
1. Generate a new token + bind via `wrangler secret put JOTFORM_WEBHOOK_TOKEN`.
2. Update the URL in each form's Webhooks panel.
3. Submit a test entry on one form; confirm the new row lands in
   `jotform_submissions`.

The webhook validates `{token}` via constant-time string compare;
mismatches return 403 with no body. JotForm Enterprise does NOT expose
a signing secret — URL secrecy is the entire auth posture (per
operator-confirmed screenshot review during planning).

---

## 5. First-run smoke

Run these end-to-end checks after backfill + webhook configuration.

5.1 **Webhook submit, end-to-end**:
   - Submit a real test entry on `salt-log` (smallest form).
   - Within 5 seconds, verify a new row appears in
     `jotform_submissions` filtered by today's date.

5.2 **Permission gate — admin tier sees all**:
   - Curl `GET /admin/jotform/api/forms` with a super_admin cookie.
   - Expected: 200, `forms[]` with all 4 enabled forms and
     submission_count > 0.

5.3 **Permission gate — RM/RD/GM sees only their locations**:
   - Curl `GET /admin/jotform/api/250165655616055/submissions?limit=10`
     with a regional_manager session cookie (any RM in `locations`).
   - Expected: 200, rows[] limited to their locations'
     submissions. Check that the `site_number` values across the rows
     are a subset of locations where that RM's email appears as
     `rm_email`.

5.4 **Anti-leak on detail endpoint**:
   - Pick a submission `id` from form X that belongs to a site NOT in
     RM Y's accessible set.
   - Curl `GET /admin/jotform/api/X/submissions/<id>` with RM Y's
     cookie.
   - Expected: 404, NOT 403 (we don't leak existence).

5.5 **CSV export**:
   - Click "Export CSV" from the apps/web `/admin/jotform/*` viewer
     (Brief 108) — or curl `GET /admin/jotform/api/<form_id>/submissions.csv?from=2026-04-01&to=2026-05-01`.
   - Expected: `Content-Type: text/csv; charset=utf-8`, header row
     starts with `id,jotform_created_at,...` followed by
     `answers__<key>__answer` columns (one per unique answer key
     across the date range), one data row per submission.

5.6 **Webhook 403 on bad token**:
   - Curl `POST /jotform/webhook/<wrong-token>/250165655616055` with
     dummy body.
   - Expected: 403 with no body.

5.7 **Workers Logs**:
   - Confirm in CF dashboard → splash-jotform → Logs that invocations
     for both the webhook + admin endpoints appear with
     `eventType: fetch`. The `[observability.logs]` block in
     wrangler.toml keeps the toggle sticky across deploys (Brief 63).

---

## 6. Cutover plan (operator-driven)

`splash-jotform` is workers.dev only at brief land. Production custom
route binding (`splashcarwashes.info/jotform/*` and
`splashcarwashes.info/admin/jotform/api/*`) is out of scope for any
Claude Code brief unless the operator asks. The path-carved pattern
matches the rest of the monorepo (forms / damage / signup / sysadmin /
workorders); apps/web's `staging.splashcarwashes.info/*` catch-all
defers to per-worker patterns automatically when more specific.

Staging recommendation: bind
`staging.splashcarwashes.info/jotform/*` and
`staging.splashcarwashes.info/admin/jotform/api/*` via the dashboard
post-deploy for same-origin SSR (apps/web → jotform via service
binding still works either way; routes matter for browser-direct
hits).

---

## 7. Known limitations / v2 candidates

- **No splash_status / splash_notes columns.** Read-only v1 per
  operator decision (moving away from JotForm rather than building
  richer integrations). Add later if needed.
- **No JotForm HMAC signature verification.** JotForm Enterprise UI
  doesn't expose a signing secret per operator's review. URL-token
  secrecy is the auth posture. If JotForm ever surfaces a signing
  secret, swap to HMAC.
- **JotForm timestamp timezone.** The API returns `created_at` as
  `"YYYY-MM-DD HH:MM:SS"` with no zone offset. v1 treats these as UTC.
  If they're actually local (account-timezone), apply an offset
  correction in `normalizeSubmission` and re-ingest.
- **`update_count` not promoted.** JotForm's per-submission API
  includes `update_count` (# of resubmits via "edit submission"); we
  store `jotform_updated_at` instead. Add the column if the operator
  wants per-row update history at the column level.
- **`pretty` field not stored top-level.** The webhook payload's
  `pretty` field (a comma-joined human-readable summary) gets thrown
  away — the `answers` JSONB carries every field's `prettyFormat`
  individually, which is richer.
- **Bulk re-sync per form.** No "bust + re-backfill" admin endpoint;
  rebuilding a form's history means manual `DELETE FROM
  jotform_submissions WHERE form_id = '...'` followed by a fresh
  backfill loop. Acceptable at v1 — backfills are one-shot.

---

## 8. Operator follow-up checklist (post-Brief-107)

1. Run **Section 1** SQL in Supabase Editor.
2. Bind the four secrets in **Section 2**.
3. Run the backfill loop per form (**Section 3**) — smallest first.
4. Configure JotForm webhooks per form (**Section 4**).
5. Submit a test entry on each form (**Section 5.1**) to confirm the
   webhook end-to-end path works.
6. Wait for Brief 108 (apps/web viewer pages) to surface the data to
   admins via the dashboard.
