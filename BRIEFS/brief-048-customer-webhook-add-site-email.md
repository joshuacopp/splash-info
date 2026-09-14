# Brief 48: Add `site_email` to customer claim webhook payload

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Power Automate flow's Reply-To wiring (operator
configures the PA side in parallel; once worker deploy lands AND
PA flow is updated, customer replies route to the location's
site_email instead of the shared sender mailbox).
**Dependencies:** Brief 32 (the customer webhook this brief
extends). Brief 33 (the Supabase locations resolution path).

## Read first

- CLAUDE.md (CUSTOMER_CLAIM_WEBHOOK_URL entry under "Working
  with workers"; locations table glossary entry)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-032-claim-summary-pdf-and-customer-email.md (the
  webhook's original brief; payload shape is documented there)
- BRIEFS/brief-033-drop-d1-locations-supabase-authoritative.md
  (the Supabase locations helper this brief extends)
- apps/damage-worker/src/index.ts (`handleClaimSubmission` —
  search for `CUSTOMER_CLAIM_WEBHOOK_URL` to find the webhook
  POST site)
- packages/db-supabase/src/* (find `getActiveLocationByCode` or
  whatever Brief 33 / Brief 42 left for the locations helper —
  likely also returns `site_email` already; this brief just
  surfaces it through to the payload)

## Context

The customer-claim webhook today fires a JSON payload with
`claim_id`, `customer_email`, `summary_pdf_url`, and (≤3 MB)
`summary_pdf_base64`. Power Automate uses this to email the
customer their PDF copy. The email's From address is a shared
mailbox (operator-configured 2026-05-06).

Today, when a customer hits "Reply" to the confirmation email,
the reply goes back to the shared mailbox — which means whoever
monitors that mailbox has to triage and forward to the right
location. Not great.

Operator wants Reply-To set to the **location's `site_email`**
so customer replies land directly in the per-location inbox
(the same address that gets pricing/permissions notifications
via the existing Supabase trigger cascades).

The Supabase `locations.site_email` column already exists and
is populated for active locations (Brief 27 made it editable
via the Update Location card). The damage worker already calls
into Supabase for `location_pretty` (Brief 33) and for
`maintainx_id` (Brief 42). Adding `site_email` to that lookup
is a one-field extension; no new helper, no new round-trip.

## Scope

### Phase 1 — Surface `site_email` from the Supabase helper

1.1 In `packages/db-supabase/`, find the helper Brief 33 added
for resolving location data by `location_code` (likely
`getActiveLocationByCode` returning the full pricing_simple
row, OR a sibling that hits the `locations` table). Brief 42
also added or extended `getMaintainXLocationId`. Look at both
to decide whether:
  - (a) The existing helper already returns `site_email` (some
    helpers select * — if so, just expose the field in the
    return type and no fetch change is needed)
  - (b) A small extension is needed to also select `site_email`
    in the PostgREST query

If (a), update only the return type. If (b), add `site_email`
to the `select=` query string and the return type.

1.2 If a separate helper makes more semantic sense (similar
to how Brief 42 added `getMaintainXLocationId` as a sibling),
add `getLocationContactInfo(env, location_code)` returning
`{ site_email: string | null }`. Executor's call based on what
reads cleanest in the existing helper module.

### Phase 2 — Wire `site_email` into the webhook payload

2.1 In `apps/damage-worker/src/index.ts handleClaimSubmission`,
find the block that constructs the `CUSTOMER_CLAIM_WEBHOOK_URL`
POST body. Today the body is approximately:

```ts
{
  claim_id,
  customer_email,
  summary_pdf_url,
  summary_pdf_base64,  // optional, ≤3MB
}
```

Extend it with `site_email`:

```ts
{
  claim_id,
  customer_email,
  summary_pdf_url,
  summary_pdf_base64,  // optional, ≤3MB
  site_email,          // null when location has no site_email set
}
```

2.2 Source the value: read `site_email` from the same Supabase
locations helper used elsewhere in the function (the worker
already loads location data for `location_pretty`). If the
existing in-memory location row doesn't include `site_email`,
extend the lookup per Phase 1.1.

2.3 Tolerate null: if a location's `site_email` is unset (or
NULL in Supabase), pass `null` in the payload. The PA flow
will gracefully no-op the Reply-To header in that case (no
behavioral change for those locations — replies fall back to
the From mailbox, same as today).

2.4 The webhook fail-soft posture from Brief 32 is unchanged.
A failure looking up site_email should NOT prevent the webhook
from firing; if the lookup throws, default site_email to null
and proceed.

### Phase 3 — Update CLAUDE.md

3.1 Update the `CUSTOMER_CLAIM_WEBHOOK_URL` entry under
"Working with workers" → glossary section. Today it reads:

> **CUSTOMER_CLAIM_WEBHOOK_URL** - Optional damage-worker secret
> (Brief 32) fired after a customer-submitted claim — Power
> Automate receives a JSON payload with `claim_id`,
> `customer_email`, `summary_pdf_url`, and (for PDFs ≤ 3 MB raw)
> `summary_pdf_base64`. ...

Append `site_email` to the field list and add a note:

> ... and `site_email` (Brief 48; the location's per-site contact
> address from Supabase `locations`, used by PA as the
> Reply-To header so customer replies land in the per-location
> inbox; null when the location has no site_email set).

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 13 packages.
4.2 `pnpm --filter @splash/damage-worker build` — must succeed.
4.3 No D1 schema change. No new secret. No new env var.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 48 row added.

5.2 BUILD_STATE.md: Findings entry noting:
  - Customer webhook payload now includes `site_email`
  - PA flow update is the operator's follow-up: add `site_email`
    (string) to the trigger schema, then set the Send Email
    action's Reply-To field to that dynamic value
  - When a location has no site_email, the field is null and
    PA will fall back to the From mailbox for replies

## Out of scope

- Changing the email From address. From stays the shared mailbox
  (operator-configured 2026-05-06). Reply-To is the change.
- Editing the SharePoint internal webhook payload. That payload
  doesn't drive customer email and shouldn't grow.
- Backfilling site_email values for locations that don't have one
  set today — that's an operator data task via the Update
  Location card.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Customer webhook payload includes `site_email` field (string
  or null)
- The value comes from Supabase `locations.site_email`
- Null is tolerated end-to-end (worker → PA)
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- CLAUDE.md updated
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified
- Whether the Supabase helper was extended in place or a sibling
  was added (which one)
- Confirmation that null handling is tested (e.g., logged behavior
  when the Supabase row's site_email is empty)
- Validation results

## Outcome

**Files modified:**
- `packages/db-supabase/src/locations.ts` — added a new sibling helper
  `getLocationContactInfo(env, locationCode): Promise<{ site_email: string | null }>`
  immediately above the existing `LOCATION_COLS` constant. Two-step lookup
  mirrors `getMaintainXLocationId`: step 1 reads `pricing_simple.site` by
  `location_code`, step 2 reads `locations.site_email` by `site`. Fail-soft
  on every branch (bad-shape slug, fetch throw, non-2xx, missing pricing_simple
  row, missing locations row, missing/null/whitespace `site_email`) → all
  collapse to `{ site_email: null }`. Empty-string-after-trim is normalized
  to null so PA's null check works uniformly. JSDoc block records the
  Brief 48 rationale + the "locations is the authoritative source over the
  denormalized pricing_simple copy because the trg_sync trigger writes one
  direction only" reasoning.
- `apps/damage-worker/src/index.ts` — (a) added `getLocationContactInfo` to
  the existing `@splash/db-supabase` import block; (b) inside
  `handleClaimSubmission`, immediately before the `fireCustomerClaimWebhook`
  call, added a try/catch that resolves `site_email` from the helper and
  defaults to `null` on any throw (defense-in-depth on top of the helper's
  own fail-soft posture); (c) `fireCustomerClaimWebhook` signature gained
  a `siteEmail: string | null` fifth parameter; (d) the constructed payload
  object now includes `site_email: siteEmail` alongside the existing fields.
- `CLAUDE.md` — `CUSTOMER_CLAIM_WEBHOOK_URL` glossary entry under "Working
  with workers" extended to list `site_email` in the field roster, document
  the Reply-To Power Automate semantics, note the null fallback, and
  cross-reference Brief 48 + the helper.
- `BRIEFS/INDEX.md` — Brief 48 row added.
- `BRIEFS/QUEUE.md` — Brief 48 moved to completed-comment line.
- `BUILD_STATE.md` — "Last updated" line bumped with Brief 48 summary;
  new Findings entry at the top of the table.
- `BRIEFS/brief-048-customer-webhook-add-site-email.md` — Status set to
  `Completed (2026-05-06)`; this Outcome section filled in.

**Files created:** none.

**Files deleted:** none.

**Helper extension chosen:** option (b) from Phase 1 — a sibling helper
`getLocationContactInfo` rather than extending `getActiveLocationByCode`.
Brief 42 took the same call (`getMaintainXLocationId` is also a sibling),
and the brief explicitly delegated this choice to the executor. Rationale:
different concerns (slug resolution at form load vs. contact lookup at
submission), different return shapes, and `getActiveLocationByCode` queries
`pricing_simple` while `site_email` is sourced from `locations` (the
authoritative store; pricing_simple's copy is denormalized via a one-direction
trigger).

**Null handling:** the helper returns `{ site_email: null }` on every
failure path. The damage-worker call site wraps the lookup in a try/catch
that also defaults to null. The webhook payload then carries `"site_email":
null` for locations without a populated `site_email`, which PA gracefully
no-ops as Reply-To (replies fall back to the From mailbox). Empty-string-
after-trim is normalized to null at the helper level so PA's null check
works uniformly across NULL and `''` legacy values.

**Validation:**
- `pnpm typecheck` — **13/13 successful** (4.295s). 6 cache hits; the
  `@splash/db-supabase` package change rippled through to all consumers
  (`@splash/auth`, `@splash/web`, `@splash/damage-worker`,
  `@splash/dashboard-worker`, `@splash/signup-worker`,
  `@splash/sysadmin-worker`, `@splash/performance-worker`) and every
  downstream typecheck passed.
- `pnpm --filter @splash/damage-worker build` — **N/A** (workers have no
  `build` script; bundling happens at deploy time via wrangler).
- Equivalent dry-run validation:
  `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run`
  — succeeded. Total Upload **1688.04 KiB / gzip 382.22 KiB** (Brief 47
  baseline 1685.48 / 381.90 → **+2.56 KiB / +0.32 KiB gzip**, accounted
  for by the new helper + call-site try/catch + JSDoc block + parameter
  passing). All 6 bindings (DB / R2_BUCKET / IMAGES / MAINTAINX_MODE="test"
  / MAINTAINX_BASE_URL / APPS_WEB_BASE_URL) resolved cleanly.

**Decisions made on operator's behalf:**
1. **Sibling helper, not extension.** See "Helper extension chosen" above.
2. **Empty-string normalization at helper level.** Some legacy `locations`
   rows have `''` rather than NULL for unset emails; trimming and mapping
   empty to null gives PA a single "unset" representation across both.
3. **Defense-in-depth try/catch at the call site.** The helper is already
   fail-soft, but the call-site catch matches the existing pattern at
   line 1746 (Brief 33's `getActiveLocationByCode` location_pretty
   resolution) and documents that this lookup is allowed to fail without
   affecting the webhook.
4. **Field name `site_email` (snake_case)** in the payload, matching the
   existing `claim_id`, `customer_email`, `summary_pdf_url`, etc.
5. **No PA-side changes from headless.** The brief specifies the PA flow
   update as the operator's parallel task; this brief only ships the
   worker-side payload extension. PA silently drops unknown fields, so
   deploying the worker change before the PA update is safe.

**Latent issues / forward flags:**
- **PA flow update is the gating step.** Until the PA trigger schema picks
  up `site_email` AND the Send Email action's Reply-To is set to the new
  dynamic value, customer replies continue going to the shared mailbox.
  Documented in BUILD_STATE.md as the operator follow-up.
- **Locations without `site_email` populated** keep today's behavior — PA
  Reply-To falls back to the From mailbox. Backfill is out of scope per
  the brief; that's a per-location operator data task via Brief 27's
  Update Location card.
- **Null handling tested via the helper's structure** (every branch returns
  null) but not via a live submission — headless cannot exercise the live
  webhook. Operator should confirm one populated and one unpopulated
  location at smoke time (see "Operator action items" in BUILD_STATE.md).
- **Helper does NOT cache.** Two REST round trips per customer claim
  submission. Equipment-related claims are low-volume; caching would be
  premature. The helper structure mirrors `getMaintainXLocationId` for
  grep-able consistency.
- **`pricing_simple.site_email` denormalized copy is unused by this helper**
  — by design, for symmetry with the locations-as-source-of-truth pattern
  used elsewhere.
