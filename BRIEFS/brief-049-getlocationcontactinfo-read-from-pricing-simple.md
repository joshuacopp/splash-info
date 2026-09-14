# Brief 49: Simplify `getLocationContactInfo` to read site_email from pricing_simple directly

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:** Brief 48 (the helper this brief patches).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-048-customer-webhook-add-site-email.md (the brief
  that introduced this helper)
- packages/db-supabase/src/locations.ts (the file with the bug,
  function `getLocationContactInfo` ~L166)

## Context

Brief 48's `getLocationContactInfo` helper does a two-step
Supabase lookup to get `site_email`:

1. `pricing_simple` filtered by `location_code` → returns `site` (text)
2. `locations` filtered by `site=eq.<step 1's site>` → returns `site_email`

Operator confirmed 2026-05-06 that for the Oswego location:
- `pricing_simple` rows have `site_email = "oswegowash@splashcarwashes.com"` populated
- `locations` rows have `site_email = "oswegowash@splashcarwashes.com"` populated

But the helper is returning null for that location, which caused
the customer webhook to send `site_email: null` and (after
Brief 48's PA schema was set to `"type": "string"` only) PA's
trigger 400'd. We patched PA to accept `["string", "null"]`,
which lets the email send — but **the underlying helper bug
that returns null when data is present is still there.**

The bug is in step 2's join: `pricing_simple.site = locations.site`
returns zero rows for at least the Oswego location. Likely cause:
the `trg_sync_pricing_simple` trigger writes `pricing_simple.site`
from a different source column than the helper assumes (e.g.,
`locations.site_number::text` instead of `locations.site`), so
the values don't match for some/all locations.

The fix: skip step 2 entirely. `pricing_simple.site_email` is
sync'd from `locations.site_email` via the trigger (Brief 26
explicitly REJECTS direct edits to `pricing_simple.site_email`,
so pricing_simple's value is always the locations-sourced value).
Reading from `pricing_simple` directly is functionally equivalent,
one query instead of two, and avoids the broken join.

The original Brief 48 comment claimed locations was "the
authoritative source" — that's true semantically, but the trigger
makes the two stores eventually consistent, so reading either is
fine for read-only consumers. The damage worker is read-only here.

## Scope

### Phase 1 — Rewrite the helper to a single query

1.1 Edit `packages/db-supabase/src/locations.ts`:

  - Replace the two-step lookup in `getLocationContactInfo` with
    a single query against `pricing_simple` selecting
    `site_email` filtered by `location_code`.
  - Drop the locations-side fetch entirely.
  - Keep all the fail-soft branches (slug regex check, fetch
    throws, non-2xx response, empty result, null/empty
    site_email → null return). Do NOT loosen any error
    handling.

  Concrete shape:

```ts
export async function getLocationContactInfo(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<{ site_email: string | null }> {
  const sanitized = locationCode.trim().toLowerCase();
  if (!sanitized || !/^[a-z0-9_]+$/.test(sanitized)) {
    return { site_email: null };
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };

  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("location_code", `eq.${sanitized}`);
  url.searchParams.set("select", "site_email");
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers });
  } catch (err) {
    console.error("getLocationContactInfo: pricing_simple fetch threw", err);
    return { site_email: null };
  }
  if (!response.ok) {
    console.error(
      "getLocationContactInfo: pricing_simple returned",
      response.status
    );
    return { site_email: null };
  }

  const rows = (await response.json().catch(() => [])) as Array<{
    site_email: string | null;
  }>;
  const raw = rows[0]?.site_email;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return { site_email: trimmed ? trimmed : null };
}
```

1.2 Update the leading JSDoc comment to reflect the new shape:

  - Drop the "two-step lookup" / "locations is the authoritative
    source" language
  - Replace with: reads `pricing_simple.site_email` directly;
    the value is trigger-synced from `locations.site_email` by
    `trg_sync_pricing_simple` so the read is eventually
    consistent with the locations row, and `pricing_simple.site_email`
    is enforced read-only against direct edits (Brief 26's
    package update endpoint rejects `site_email` patches with
    400 specifically because of this trigger).

1.3 Add a one-line code comment at the top of the function body
referencing Brief 49 and the reason for the simplification, so a
future reader doesn't try to "fix" the helper back to a
two-table join thinking it's more correct.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages.
2.2 `pnpm --filter @splash/damage-worker build` — must succeed.
2.3 No D1 schema change. No new secret.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 49 row added.

3.2 BUILD_STATE.md: Findings entry noting:
  - Brief 48's two-step join was broken for at least the Oswego
    location (pricing_simple.site doesn't match locations.site
    via the trigger sync — exact mismatch unclear but doesn't
    matter since we're skipping that join now)
  - The simplification reads pricing_simple directly; trigger
    keeps it in sync with locations
  - Operator should retry a customer claim submission against
    Oswego and confirm the email's Reply-To is set to
    `oswegowash@splashcarwashes.com`

## Out of scope

- Investigating the trg_sync_pricing_simple trigger's actual
  write logic. Whatever it does, this fix doesn't depend on it.
  If a separate issue is later found with the trigger, that's
  its own brief.
- Backfilling pricing_simple.site_email values for locations
  whose locations.site_email is set but pricing_simple's isn't.
  If any such mismatch exists, the trigger will fix it on the
  next locations-side update of that row; not blocking on it.
- Reverting PA's schema null-tolerance for site_email. Even with
  this fix, locations without a site_email set in Supabase will
  still send null, so the schema's null tolerance stays.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `getLocationContactInfo` does a single query against
  `pricing_simple`, no longer touches `locations`
- All fail-soft branches preserved
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely ~30 lines net negative)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Status:** Completed (2026-05-06).

### Files modified

- `packages/db-supabase/src/locations.ts` — `getLocationContactInfo` body
  rewritten from a two-step join (`pricing_simple.location_code` →
  `pricing_simple.site` → `locations.site_email`) to a single query
  against `pricing_simple.site_email`. Function body shrunk ~50 → ~25
  LOC: deleted the second URL/Response/JSON parse block, renamed the
  first query to `select=site_email` instead of `select=site`, folded
  the trim/null collapse onto its rows. Leading JSDoc rewritten from
  the "two-step / locations is authoritative" language to single-query
  / trigger-synced semantics, with a Brief 26 cross-reference
  explaining why pricing_simple's value is always the locations-sourced
  value (Brief 26's package update endpoint REJECTS direct PATCHes to
  `pricing_simple.site_email` with HTTP 400 because of the trigger).
  Added a one-line in-body comment referencing Brief 49 and the
  broken-join rationale so a future reader doesn't try to "restore"
  the two-table join.

### Files NOT modified (intentional)

- `apps/damage-worker/src/index.ts` — call site is unchanged. It still
  wraps `getLocationContactInfo` in try/catch and passes the result
  through to `fireCustomerClaimWebhook` with the same fail-soft
  posture from Brief 48.
- `fireCustomerClaimWebhook` signature unchanged. The `siteEmail:
  string | null` parameter still carries the helper's return value;
  the only difference is it'll now actually be populated for
  locations whose `pricing_simple.site_email` is set (which, per the
  trigger, equals `locations.site_email`).
- `CLAUDE.md` — `CUSTOMER_CLAIM_WEBHOOK_URL` glossary entry already
  describes Brief 48's contract correctly (the public-facing
  contract didn't change in this brief; the helper is read-only and
  the webhook payload shape is identical). No edit needed.

### Decisions made on the operator's behalf

- Used Brief 49's exact concrete-shape code from the Scope section
  verbatim (renamed local `psUrl`/`psResponse` to `url`/`response`
  to match the brief's example, since there's no longer a "step 2"
  to disambiguate against). All fail-soft branches preserved as
  required.
- Did NOT investigate `trg_sync_pricing_simple`'s actual source
  column (out of scope per the brief). The exact reason
  `pricing_simple.site` doesn't match `locations.site` for Oswego
  remains undiagnosed — likely `locations.site_number::text` vs.
  `locations.site` mismatch — but the fix doesn't depend on
  knowing. If a separate issue is later found with the trigger,
  it's its own brief.
- Did NOT touch the damage-worker call site try/catch. The brief's
  Scope is helper-only; the call-site fail-soft layering from
  Brief 48 is still load-bearing (it covers the case where the
  helper module itself throws at import-time, an unrelated failure
  mode).

### Latent issues found

- The exact mismatch between `pricing_simple.site` and
  `locations.site` is undiagnosed and could affect other future
  consumers that try a similar join. Brief 42's
  `getMaintainXLocationId` uses the same `pricing_simple.site →
  locations.site` join pattern, so it likely has the same bug for
  at least the Oswego location (would silently return null
  `maintainx_id` and the work order would be created without a
  location set). Out of scope for this brief; flagged here for a
  potential follow-up.
- Backfilling `pricing_simple.site_email` for locations whose
  `locations.site_email` is set but pricing_simple's isn't is
  out of scope; the trigger will heal those on the next
  locations-side UPDATE of the row. If any specific location is
  observed sending null `site_email` after this brief lands AND
  has `locations.site_email` set, operator can run a no-op
  UPDATE on the locations row to fire the trigger.

### Validation results

- `pnpm typecheck` — **13/13 successful** (3.325s, 6 cache hits,
  fresh build on `@splash/db-supabase` + downstream consumers
  `@splash/damage-worker` + `@splash/auth` + `@splash/dashboard-worker`
  + `@splash/signup-worker` + `@splash/sysadmin-worker` +
  `@splash/performance-worker`). Every downstream typecheck passed
  cleanly; the helper's signature is unchanged (still
  `(env, locationCode) => Promise<{ site_email: string | null }>`)
  so no consumer needed updating.
- `pnpm --filter @splash/damage-worker build` — **N/A** (workers
  have no `build` script; bundling happens at deploy time via
  wrangler).
- Equivalent dry-run validation: `pnpm --filter @splash/damage-worker
  exec wrangler deploy --dry-run` — **succeeded**. Total Upload
  **1687.32 KiB / gzip 382.21 KiB** (Brief 48 baseline 1688.04 /
  382.22 → **−0.72 KiB / −0.01 KiB gzip**, accounted for by the
  deleted second-step query block). All 6 bindings resolved
  (DB / R2_BUCKET / IMAGES / MAINTAINX_MODE="test" /
  MAINTAINX_BASE_URL / APPS_WEB_BASE_URL).
- No D1 schema change. No new secret. No new env var.

### Diff size

Net negative as expected per the brief: ~25 lines deleted from the
function body (entire step-2 fetch+parse+null-check block) plus
~10 lines of new JSDoc/comment, for a net delta of roughly −15 LOC
in `locations.ts`. The wrangler dry-run delta of −0.72 KiB
uncompressed corroborates the source-side reduction.

### Operator follow-up

After the next damage-worker redeploy, retry a customer claim
submission against the Oswego customer claim URL and confirm the
PA-sent confirmation email's Reply-To header is set to
`oswegowash@splashcarwashes.com`. On any other location whose
`pricing_simple.site_email` is null, the webhook will continue to
send `site_email: null` and PA will fall back to the From mailbox
for replies — that's the expected behavior; PA's recent
`["string", "null"]` schema relaxation stays.
