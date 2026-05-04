# PRE_DEPLOY — signup-worker

**The only production-critical worker.** Real customer traffic today goes to the legacy `splash-signup` script; the new worker is named `splash-signup-next` so deploys don't clobber. Cutover gets a dedicated planning conversation (parallel deploy, shadow testing, traffic shifting, rollback).

Worker name: `splash-signup-next` (renames to `splash-signup` at cutover, OR keep this name and rebind the production routes to it — decided in the cutover conversation).

---

## Required secrets (`wrangler secret put`)

```bash
pnpm --filter @splash/signup-worker exec wrangler secret put SUPABASE_URL
pnpm --filter @splash/signup-worker exec wrangler secret put SUPABASE_ANON_KEY
pnpm --filter @splash/signup-worker exec wrangler secret put SUPABASE_SERVICE_KEY
```

| Name | Type | Purpose |
|---|---|---|
| `SUPABASE_URL` | string | base URL of the Supabase project |
| `SUPABASE_ANON_KEY` | secret | `/auth/v1/user` validation (admin endpoints) |
| `SUPABASE_SERVICE_KEY` | secret | `pricing_simple` reads/writes, `maxpass_signups` insert, `suspicious_phones` + `phone_usage_log` writes, `auth_unified` reads (admin), `sysadmin_audit_log` writes (admin pricing changes) |

## Plain vars (`wrangler.toml [vars]` block)

```toml
[vars]
SIGNATURE_MODE = "inline"
```

| Name | Default | Allowed | Effect |
|---|---|---|---|
| `SIGNATURE_MODE` | `"inline"` | `"inline"` \| `"jotform"` | `inline` renders the form HTML and POSTs straight to `maxpass_signups`. `jotform` 302s to a JotForm with prefilled fields. **Do not flip to `"jotform"` until the family-plan form IDs in `apps/signup-worker/src/signature/jotform.ts` are real and the JotForm phone-prefill field name has been verified — see CUTOVER_PLAN.md items (b) and (c).** |

## Required bindings

None beyond the secrets / vars above. No D1, no R2, no Images.

## Smoke-test checklist

After `pnpm --filter @splash/signup-worker deploy`:

```bash
WORKER=https://splash-signup-next.<ACCOUNT>.workers.dev

# === Public signup flow ===

# 1. Picker page renders for a real location.
curl -i "$WORKER/signup/binghamton"
# → 200 text/html; bubble background + package cards
# (Confirm visually in a browser if convenient — picker tests legacy parity.)

# 2. Form page renders for a known package.
curl -i "$WORKER/signup/binghamton/ultra_bath"
# → 200 text/html; phone + email + terms checkbox

# 3. Hardcoded-deny phone → 400 { denied, error }, log row written.
curl -i -X POST "$WORKER/api/submit-signup" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" \
  --data '{"phone":"0000000000","phone_formatted":"(000)000-0000","location":"binghamton","location_pretty":"Binghamton","package":"ultra_bath","package_pretty":"Ultra Bath","today_price":"5","monthly_price":"39.99","email":"x@y.z","terms":"...","terms_agreed":true,"timestamp":"2026-05-03T00:00:00Z"}'
# → 400 { denied: true, error: "..." }
# Confirm a phone_usage_log row appeared with action_taken="blocked".

# 4. Invalid area code → 400 same shape.
curl -i -X POST "$WORKER/api/submit-signup" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" \
  --data '{"phone":"9111234567",...}'

# 5. Real new phone → 200 { success: true, confirmation_token }.
#    Confirms maxpass_signups insert + phone_usage_log "allowed" row.

# === Admin pricing API (requires "pricing" tool grant or super_admin) ===

# 6. Admin locations list:
curl -i "$WORKER/admin/api/locations" -H "Cookie: sb-access-token=<token>"

# 7. Admin set-mode (super_admin or location_admin with scope):
curl -i -X POST "$WORKER/admin/api/locations/binghamton/set-mode" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" \
  -H "Cookie: sb-access-token=<token>" \
  --data '{"mode":"flash5","pkgList":["ultra_bath"]}'
# → 200 { ok, mode, packages, resolved }
# Confirm sysadmin_audit_log row with action="pricing_set_mode".

# 8. CSRF on admin write → 403 bad origin.
curl -i -X POST "$WORKER/admin/api/locations/binghamton/flip" \
  -H "Origin: https://malicious.example.com"

# 9. Pricing cache invalidation works:
#    a) GET /signup/binghamton (reads cached pricing).
#    b) POST /admin/api/locations/binghamton/flip (invalidates cache).
#    c) GET /signup/binghamton again — should reflect the new mode within 5min.
```

**Manual checks:**

- [ ] Phone `(607)768-5674` formatting works in the form's input field (no space after `)`).
- [ ] Submitting a valid signup writes to `maxpass_signups` with all 18 columns including `confirmation_token` (UUID), `terms_text` (the exact string the customer saw), `user_agent` (from header), `country/city/region` (from `request.cf`).
- [ ] 3rd submission of the same phone triggers the warn modal (count === 2 → returns `{ warning: true }`); confirming via the modal resubmits with `user_confirmed: true` and writes the row.
- [ ] 10th submission triggers the monitor modal (count === 9 → returns `{ monitor: true }`); confirming via modal writes the row.
- [ ] An admin-flagged Deny row in `suspicious_phones` (with `manually_flagged = true`) is **not** mutated by `createOrUpdateSuspicious` — auto-detection logs but doesn't overwrite (Chunk 3 bug fix).
- [ ] Admin pricing audit log captures `pricing_set_mode`, `pricing_flip`, `pricing_bulk_set_mode` rows in `sysadmin_audit_log` with the actor's email and the right `target_id` / `after` jsonb shape.
- [ ] Pricing cache: after a write, the next picker-page load shows the new mode within 5 minutes (or immediately, since the cache key is invalidated on write).

## Production route binding (cutover-time)

**This is the only worker whose route binding requires a dedicated cutover plan.** The other 4 workers have no production traffic; this one carries every customer signup. Out of scope for this doc — see CUTOVER_PLAN.md.

The route block (currently commented in `apps/signup-worker/wrangler.toml`) when uncommented becomes:

```toml
routes = [
  { pattern = "splashcarwashes.info/signup/*",            zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/q/*",                 zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/join/*",              zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/api/submit-signup",   zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/admin/api/*",         zone_name = "splashcarwashes.info" }
]
```

The `/admin/api/*` route is new (added in Chunk 4); legacy didn't have it because legacy was HTML-form-based.

## Pre-cutover SQL guard

Run once at cutover (currently a no-op — zero rows match):

```sql
UPDATE pricing_simple
SET pricing = 'special', special = 0.01
WHERE pricing = 'penny';
```

Defensive against any stray legacy `penny` rows. The new worker's resolver (`apps/signup-worker/src/pricing/resolver.ts`) defensively falls back to `full` for unknown modes anyway, so the customer flow survives even without this guard.

## Cutover-strategy items (NOT this conversation's scope)

- Parallel deployment — both `splash-signup` (legacy) and `splash-signup-next` (new) running simultaneously
- Shadow testing — cloning live traffic to the new worker without serving its responses
- Traffic shifting — gradual percentage of real traffic moved to the new worker
- Rollback path — single-flip-back to legacy if signup error rate spikes
- Worker rename strategy — `splash-signup-next` → `splash-signup` vs. rebind routes to the new name
- Family Plan JotForm form IDs — flip-time operator task (only if `SIGNATURE_MODE` flips to `"jotform"`)
- JotForm phone field name — flip-time verification (same)

See CUTOVER_PLAN.md.
