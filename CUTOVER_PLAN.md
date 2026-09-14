# Cutover Plan — splash-info monorepo

Build phase complete (2026-05-03). All five workers ported, all shared packages built, all four security bug fixes landed, decision-2 admin-pricing UX rework finalized. **`pnpm typecheck` 13/13 green from a cold cache.**

This document hands off to the dedicated cutover-strategy conversation. The actual cutover (parallel deployment, shadow testing, traffic shifting, rollback) is **out of scope here** — it gets its own chat.

---

## Build phase deliverables

| Chunk | Scope | Status |
|---|---|---|
| 1 | Signup-worker skeleton + flippable JotForm + pricing resolver + signature-mode dispatch surface | ✅ |
| 2 | Pricing cache (5min fresh / 24h SWR) + picker + form render + dispatch on `SIGNATURE_MODE` | ✅ |
| 3 | `POST /api/submit-signup` + layered fraud detection + `manually_flagged` bug fix + modal kit | ✅ |
| 4 | Admin pricing JSON API + apps/web pages + Quick Flip + `bulk-set-mode` | ✅ |
| 5 | Decision-3 refetch + pricing audit logging + CSRF retrofit on dashboard / performance / sysadmin | ✅ |
| Decision-2 rework | Location-level button row + `PackagePickerModal` (legacy parity per screenshots) | ✅ |

### Workspace state — 13 packages, all green

```
packages/
  auth, config, db-d1, db-supabase, http, storage-r2, types, ui

apps/
  damage-worker, dashboard-worker, performance-worker, signup-worker,
  sysadmin-worker, web
```

---

## Worker port status — workers.dev only, production routes commented

| Worker | wrangler `name` | Production routes | Status |
|---|---|---|---|
| dashboard-worker | `splash-dashboard` | commented in `wrangler.toml` | ✅ port complete |
| performance-worker | `splash-performance` | commented | ✅ port complete |
| sysadmin-worker | `splash-sysadmin` | commented | ✅ port complete |
| damage-worker | `splash-damage` | commented | ✅ port complete |
| signup-worker | **`splash-signup-next`** | commented | ✅ port complete; **renames to `splash-signup` at cutover** |

Each worker has a `PRE_DEPLOY_<NAME>.md` next to this file with required secrets, bindings, smoke-test checklist, and the production-route binding step.

---

## Schema notes — DO NOT "fix"

### `pkg$` is intentional

The `pricing_simple` table has a column literally named `pkg$` (with the `$`). This is real and load-bearing. Postgres requires double-quoting the identifier — `"pkg$"` — and every reference in this codebase uses that form. Examples:

- `packages/types/src/pricing.ts` — `"pkg$": number` on `PricingSimpleRowWithRawPrices`
- `apps/signup-worker/src/pricing/resolver.ts` — `Number(row["pkg$"])` via bracket notation

**Do not rename the column. Do not rename the type field. Do not "normalize" the bracket-notation accesses to dot-notation.** If a reviewer asks why `pkg$` instead of `pkg_dollar` or `pkg_price`, the answer is "that's the column name in production; renaming it cascades to PostgREST clients, the resolved view, Power Automate, Supabase RLS policies, and probably more." Keep it.

### Same rule applies to any other quoted identifiers

If you find another column with a literal `$`, space, or other quoted-identifier-requiring character: don't rename it. Adapt code, don't adapt schema.

### `manually_flagged` immutability

Auto-detection (`createOrUpdateSuspicious`, `updateUsageCount` in `@splash/db-supabase`) skips writes when the existing `suspicious_phones` row has `manually_flagged = true`. This is the bug fix from Chunk 3 — admin-curated rows are immutable from worker code. Flagged Deny patterns (`'0000000000'`, `'1111111111'`, etc.) are seed rows with `manually_flagged = true` and must stay untouched.

### `'document_removed'` was reverted

`ClaimActivityType` is the legacy 3-value union (`status_change | note | document_added`). Document deletes use `'document_added'` with prose distinction in `notes`. The migration cost (D1 CHECK-constraint rebuild) wasn't worth the audit-log cleanup.

---

## Open items going into cutover

### a) Bulk endpoint subrequest budget

**Recommendation: ~15-location limit (Option D from Chunk 5 flag).**

`POST /admin/api/bulk-set-mode` does ~3 subrequests per location (setPricingMode, listLocationPkgs, logPricingAudit) plus 2 fixed (auth). At 50 locations that's 152 subrequests — well above CF's 50-per-request limit.

**Two paths to ship safely:**

1. **Front-end chunking** (recommended). The apps/web client splits any bulk request larger than 15 locations into sequential chunks of ≤15. No worker changes needed.
2. **Server-side limit** (defensive). Add a `body.locationCodes.length > 15 → 400 too_many_locations` guard in `handleBulkSetMode`. Decide whether to do this before or after cutover; not blocking either way.

The realistic admin use case is "set 5-10 sites for a regional manager," not "set all 70." If bulk traffic ever exceeds the limit, **C** (queued/async pattern via Workers Queues) is the right architecture — but that's a follow-up, not a cutover blocker.

### b) Family Plan JotForm form IDs

`apps/signup-worker/src/signature/jotform.ts` has placeholder constants:

```ts
export const FAMILY_FORM_IDS: Readonly<Record<string, string>> = {
  family_bubble_bath: "FAMILY_BUBBLE_BATH_FORM_ID_TBD",
  family_ultra_bath:  "FAMILY_ULTRA_BATH_FORM_ID_TBD",
  family_express:     "FAMILY_EXPRESS_FORM_ID_TBD"
};
```

**Flip-time operator task:** sourced from the JotForm dashboard. The values aren't in MIGRATION_PLAN.md or any in-repo doc. If `SIGNATURE_MODE` flips to `"jotform"` before these are filled in, family-plan signups redirect to the placeholder string and JotForm 404s.

### c) JotForm phone field name

`signature/jotform.ts` uses `PHONE_FIELD_NAME = "phoneNumber"` — unverified. The migration plan lists 5 prefill fields (`package49, todaysDate, todaysPayment, nextBilling, typeA19`) and does NOT include phone, but the prompt directive specified phone format `(607)768-5674` for prefill. **Verify against JotForm's current form definition at flip time** — the prefill is conditional (only included when `phoneFormatted` is provided), so an unbound JotForm phone field doesn't break the redirect, just silently drops the prefill.

### d) Production route bindings + worker rename

`apps/signup-worker/wrangler.toml` currently:

```toml
name = "splash-signup-next"
workers_dev = true

# routes = [
#   { pattern = "splashcarwashes.info/signup/*",     ... },
#   { pattern = "splashcarwashes.info/q/*",          ... },
#   { pattern = "splashcarwashes.info/join/*",       ... },
#   { pattern = "splashcarwashes.info/api/submit-signup", ... }
# ]
```

**At cutover:**

1. Decide rename strategy:
   - **Rename `splash-signup-next` → `splash-signup`** before binding routes, OR
   - **Keep `splash-signup-next`** and bind production routes to it (old `splash-signup` script becomes unrouted; orphaned).
2. Uncomment the `routes = [...]` block.
3. Add the new admin routes to the block (Chunk 4 added these endpoints):
   ```toml
   { pattern = "splashcarwashes.info/admin/api/*", zone_name = "splashcarwashes.info" }
   ```
4. `pnpm --filter @splash/signup-worker deploy`.
5. The other 4 workers (dashboard, performance, sysadmin, damage) follow the same uncomment-and-deploy pattern; their routes are already laid out in the corresponding wrangler.toml comments.

**The dashboard / performance / sysadmin / damage workers have NO production traffic today.** Their cutover is low-risk and can happen ahead of signup-worker. signup-worker is the only production-critical cutover; that's the one that needs parallel-deploy + shadow-test + rollback planning.

---

## Pre-cutover SQL guard

Run **once** at cutover (currently a no-op — zero rows match — but defensive against any stray legacy data):

```sql
UPDATE pricing_simple
SET pricing = 'special', special = 0.01
WHERE pricing = 'penny';
```

The new worker's pricing resolver (`apps/signup-worker/src/pricing/resolver.ts`) defensively falls back to `full` for any unrecognized mode (including `penny`) with a `console.warn`, so the customer flow survives even without this guard. The guard is for cleanliness — converts any stray rows to a real, supported mode so admins see the right state in the pricing UI.

---

## What's NOT in this conversation's scope

- Cutover strategy (parallel deploy, shadow testing, traffic shifting, rollback path)
- D1 schema validation for `pricing_simple` per-mode column names (`pkg$` confirmed; `single`, `flash5`, `flash2` flagged in `PricingSimpleRowWithRawPrices` — verify before any caller depends on the resolver in production)
- `auth_unified` view shape verification beyond the manual test Josh ran in Chunk 5A
- Real-world JotForm field testing (Family Plan IDs, phone field name)
- Anything in `legacy/` cleanup — those files stay until cutover is complete

---

## Files that will change at cutover (per worker)

For each worker, the only cutover-time edits are in its `wrangler.toml`:

1. Uncomment `routes = [...]`.
2. (signup-worker only) Rename `name = "splash-signup-next"` → `name = "splash-signup"` if going with the rename strategy.
3. Run `wrangler secret put` for any secrets not yet bound (see each worker's `PRE_DEPLOY_*.md`).

Source code changes at cutover: **none expected.**
