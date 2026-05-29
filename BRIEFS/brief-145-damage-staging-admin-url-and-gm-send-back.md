# Brief 145: damage email admin_url respects staging, plus GM can send back to GM Review

**Status:** Completed (2026-05-29)
**Started:** 2026-05-29
**Completed:** 2026-05-29
**Blocks:** Neither
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- apps/damage-worker/src/index.ts (search for `APPS_WEB_BASE_URL` and
  `admin_url` to find the four URL-build sites)
- apps/damage-worker/src/transitions.ts (specifically the rows whose
  `to: "Pending GM Review"` — there are ~7 of them, grouped by `from`)
- apps/damage-worker/src/notifications.ts (note any URLs assembled here)
- apps/damage-worker/src/maintainx.ts (one more admin link build site)
- apps/forms-worker/src/submit/webhook.ts — see the `inferAdminBase`
  helper. Same problem class, already solved on a sibling worker;
  copy the shape.

## Context

Two unrelated damage-worker fixes pinned into one brief because both
are small.

### (1) Staging admin link goes to production

When a customer submits a damage claim on
`https://staging.splashcarwashes.info/claims/{site}`, the
INTERNAL_NEW_CLAIM_WEBHOOK_URL payload (Brief 102) carries an
`admin_url` field built as `${env.APPS_WEB_BASE_URL}/admin/damage/{id}`.
`APPS_WEB_BASE_URL` is set globally in `wrangler.toml` to
`https://splashcarwashes.info`. So the email's "View claim" link goes
to PRODUCTION apps/web — but the claim row only exists in staging D1.
Recipient clicks the link and gets a 404 / blank admin page.

Same bug class exists on the four URL-build sites in
`apps/damage-worker/src/index.ts` (customer-claim webhook, internal
webhook, daily summary cron payload, manage-page transition / note
update webhooks via `notifications.ts`), and on the MaintainX admin
link in `apps/damage-worker/src/maintainx.ts`.

Forms-worker has already solved this same problem with an
`inferAdminBase(request)` helper (Brief 97): if the request origin is
`*.workers.dev`, rewrite to `https://splashcarwashes.info` (production
apps/web); otherwise pass the request origin through. Staging traffic
hits `staging.splashcarwashes.info`, so passing it through yields
`https://staging.splashcarwashes.info`, which is the correct apps/web
host for staging.

### (2) GM can't send their own claim back to Pending GM Review

Scenarios:
- A GM submits a claim, it auto-routes to a downstream state (e.g.
  Pending RM Review), and the GM wants to recall it for re-review.
- A GM erroneously approves at the GM Review stage, the claim lands at
  `Approved — Pending Quotes`, and the GM wants to bounce it back to
  themselves without escalating to RM or admin.

Brief 66 (2026-05-07) widened RM access on these revert paths but kept
them gated to RM-or-higher. Per operator decision, GMs should also be
able to use the pre-approval "send back to Pending GM Review" paths,
because they're recoverable mistakes the GM themselves needs to undo.
The admin-only revert paths (post-parts-ordered, post-closed,
post-finance) stay admin-only — GMs should not claw back work-in-
progress or already-resolved claims.

## Scope

1. **`apps/damage-worker/src/index.ts` (and helper module) —
   request-origin-based admin URL.**
   - Add a small helper, either inline or as a new module
     `apps/damage-worker/src/admin-url.ts`, with this contract:
     ```ts
     /**
      * Resolve the apps/web origin for building admin links inside
      * outbound webhook payloads. Operators click these from email,
      * so workers.dev origins MUST get rewritten to production. The
      * staging hostname is preserved so staging-test claims link to
      * staging apps/web (where the claim row actually exists).
      *
      * Mirrors apps/forms-worker/src/submit/webhook.ts `inferAdminBase`.
      */
     function resolveAdminBase(request: Request, env: Env): string {
       try {
         const url = new URL(request.url);
         // workers.dev → production fallback
         if (url.hostname.endsWith(".workers.dev")) {
           return env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";
         }
         // splashcarwashes.info AND staging.splashcarwashes.info pass through
         if (url.hostname.endsWith("splashcarwashes.info")) {
           return `${url.protocol}//${url.hostname}`;
         }
       } catch {
         // fall through to env fallback
       }
       return env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";
     }
     ```
   - Replace EVERY `${env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info"}/admin/damage/${...}`
     site with `${resolveAdminBase(request, env)}/admin/damage/${...}`.
     A grep of the worker shows ~6 sites total:
       * `apps/damage-worker/src/index.ts` — customer-claim webhook
         payload (Brief 32), internal-new-claim webhook payload (Brief
         102), check-request PDF link (if any uses it), and one or two
         others (find them all).
       * `apps/damage-worker/src/notifications.ts` — manage-page
         transition / note update webhook payloads (Brief 101).
       * `apps/damage-worker/src/maintainx.ts` — admin link embedded
         in the MaintainX WO description (`/admin/damage/{claim_id}`).
   - Pass `request` through to every fire-site that needs it. Most
     already have it in scope (it's the inbound fetch's `request`
     argument); the daily-summary cron path runs in a `scheduled`
     handler that has NO inbound request — for that path ONLY, fall
     back to `env.APPS_WEB_BASE_URL`. The helper should accept an
     optional request parameter to handle the cron case cleanly, or
     the cron site should just keep using the env fallback directly.
   - Do NOT remove `APPS_WEB_BASE_URL` from `wrangler.toml` — it's
     still the cron fallback and the safety net when the request
     origin doesn't match any known host.

2. **`apps/damage-worker/src/transitions.ts` — widen GM access on
   pre-approval "send back to Pending GM Review" paths.**
   - Change `role: "rm"` to `role: "gm"` on these transitions
     (locate via the grep hits with `to: "Pending GM Review"`):
       * `From "No Responsibility — Pending Review" → "Pending GM Review"`
       * `From "Pending RM Review" → "Pending GM Review"`
       * `From "Approved — Pending Quotes" → "Pending GM Review"`
       * `From "Pending RM Quote Approval" → "Pending GM Review"`
   - Keep `requiresNote: true` and `clearApprovalDetails: true` on
     each.
   - Do NOT widen these (they stay `admin` per Brief 66 — post-
     approval / work-in-progress / finance-touched):
       * `From "Approved — In House — Parts Ordered" → "Pending GM Review"`
       * `From "Closed — Paid" → "Pending GM Review"`
       * `From "Closed — Denied" → "Pending GM Review"`
   - The `New — Pending Review → Pending GM Review` transition is
     already `role: "gm"` — no change.
   - The comment block above the admin-escape-hatch group (Brief 66
     paragraph) needs updating to reflect Brief 145's widening. Add a
     short note: "Brief 145 (2026-05-29) — the four pre-approval
     revert paths to Pending GM Review widened from `rm` to `gm` so
     GMs can recall / un-approve their own claims without RM
     escalation. The three admin-only paths below stay admin-only;
     they involve work-in-progress, closed, or finance-touched
     claims."

3. **apps/web detail page (`/admin/damage/[id]`)**
   - The page already computes per-transition enabled/disabled based
     on `session.dcRole` against each transition's `allowedRoles`.
     After step 2, GMs will see the four affected transitions as
     enabled (no longer greyed). Verify the disabled-button hint
     text doesn't hardcode "Requires RM or higher" anywhere — if it
     does, soften to "Requires GM or higher" (or whatever role is
     actually allowed for that specific transition). The existing
     pattern derives the hint from the transition's allowedRoles, so
     this is likely already correct; just spot-check.

4. **Optional smoke (not strictly required for done):**
   - Manual: customer submits a test damage claim on
     `https://staging.splashcarwashes.info/claims/{site}`. The
     INTERNAL_NEW_CLAIM_WEBHOOK_URL recipient's "View claim" link in
     the resulting email should resolve to
     `https://staging.splashcarwashes.info/admin/damage/{claim_id}`,
     and that URL should render the claim (not 404). Same submission
     against `https://splashcarwashes.info/claims/{site}` should give
     a production admin link.

## Configuration

No new env vars or secrets. `APPS_WEB_BASE_URL` stays bound at the
worker level; it's the cron / safety-net fallback.

## Out of scope

- Don't add a per-environment `[env.staging]` block in
  `wrangler.toml` — the worker is a single deployment that serves
  both staging and production via path-carve, so the per-request
  origin derivation is the correct fix.
- Don't widen the admin-only revert transitions (Parts Ordered, Closed
  — Paid, Closed — Denied). Operator decision: those stay gated to
  admin.
- Don't change the GM Review forward transitions (Pending GM Review →
  Approved — Pending Quotes, etc.) — they're already `role: "gm"`.
- Don't touch the customer-facing `/claims/{site}` form, the PDF
  generator, or the MaintainX WO creation flow itself (only the URL
  string embedded inside it changes).
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/damage-worker build` succeeds.
- `pnpm --filter @splash/web build` succeeds (if the apps/web
  disabled-hint text was touched).
- A grep for `APPS_WEB_BASE_URL` in `apps/damage-worker/src/` returns
  only:
    (a) the `[vars]` declaration and the `Env` interface field,
    (b) the cron / safety-net fallback inside `resolveAdminBase`,
    (c) the daily-summary scheduled-handler path if it kept the
        direct env reference for the no-request case.
  Every other `/admin/damage/${...}` build site reads
  `resolveAdminBase(request, env)`.
- `apps/damage-worker/src/transitions.ts` has `role: "gm"` on the
  four pre-approval Pending-GM-Review revert paths listed above.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 145: damage admin URL now derived from request origin
  (staging links go to staging apps/web, not production); GM role
  may send back to Pending GM Review from pre-approval states").
  Also update the glossary entry for the manage-page write surface
  if it specifically calls out the role of the "Send back to GM
  Review" transitions.

## Report

- The exact list of files modified for the URL helper.
- Whether the helper was inlined or moved to its own module — both
  acceptable; record which.
- Any URL-build site you found in damage-worker that the brief
  didn't enumerate (search for `/admin/damage/` to be sure).
- Whether the apps/web detail page needed a hint-text change (most
  likely no — the existing implementation reads from
  `allowedRoles` — but worth confirming).
- Any other transition that referenced `role: "rm"` for sending a
  claim "backward" that you think should also be widened to `gm`
  (don't change here — flag for a follow-up brief).

## Outcome

**Status:** Completed 2026-05-29.

### Files created
- `apps/damage-worker/src/admin-url.ts` — new helper module exporting
  `resolveAdminBase(request: Request | null, env: { APPS_WEB_BASE_URL?: string }): string`.
  Mirrors apps/forms-worker/src/submit/webhook.ts `inferAdminBase` shape,
  widened to accept a Request directly (workers.dev → production,
  `*.splashcarwashes.info` passes through, falls through to env on
  parse failure or null-request).

### Files modified
- `apps/damage-worker/src/index.ts`
  - Added `import { resolveAdminBase } from "./admin-url.js"`.
  - `tryCreateMaintainXIfMissing` (Brief 43 override path): added
    `request: Request` to its input shape; the
    `env.APPS_WEB_BASE_URL ?? "..."` literal at the WO-creation site
    now reads `resolveAdminBase(request, env)`. Caller in
    `handleStatusTransition` passes `request` through.
  - `handleClaimSubmission` initial-submission MaintainX block: the
    `mxAppsWebBaseUrl` constant now reads `resolveAdminBase(request, env)`
    (was `env.APPS_WEB_BASE_URL ?? "..."`).
  - `fireInternalNewClaimNotification` (Brief 102): added
    `request: Request` to its args; the `baseUrl` constant that
    builds `admin_url` now reads `resolveAdminBase(request, env)`.
    `handleClaimSubmission`'s call site passes `request` through.
  - `notifyClaimUpdate` (Brief 101): added `request: Request` to its
    args; the `baseUrl` constant that builds `admin_url` now reads
    `resolveAdminBase(request, env)`. Both call sites
    (`handleAddNote`, `handleStatusTransition`) pass `request` through.
- `apps/damage-worker/src/transitions.ts`
  - Widened four pre-approval revert transitions from `role: "rm"`
    to `role: "gm"`:
    1. `No Responsibility — Pending Review → Pending GM Review`
    2. `Pending RM Review → Pending GM Review`
    3. `Approved — Pending Quotes → Pending GM Review`
    4. `Pending RM Quote Approval → Pending GM Review`
  - Extended the Brief 66 admin-escape-hatch comment block with a
    Brief 145 paragraph naming the four widened paths and noting
    that the three remaining admin-only revert paths
    (`Parts Ordered`, `Closed — Paid`, `Closed — Denied`) stay
    admin-only.
- `apps/web/app/admin/damage/_lib/transitions.ts`
  - Mirrored the same four `role: "rm"` → `role: "gm"` widenings,
    keeping per-from comment notes and the admin-escape-hatch
    comment block in sync with the worker table.

### Files NOT changed
- `apps/damage-worker/src/maintainx.ts` — the `appsWebBaseUrl` is an
  input on `createMaintainXWorkOrder`; the URL helper change happens
  upstream at the two call sites in `index.ts`. Helper itself is
  policy-neutral and stays as-is.
- `apps/damage-worker/wrangler.toml` — `APPS_WEB_BASE_URL` `[vars]`
  declaration retained as the safety-net fallback inside
  `resolveAdminBase` (per the brief's explicit "don't remove"
  instruction).
- `apps/web/app/admin/damage/[id]/page.tsx` — disabled-hint text at
  `transitionDisabledHint` (page.tsx:764) already derives the
  minimum-role label from `t.allowedRoles` via hierarchy search; no
  hardcoded "Requires RM or higher" anywhere. After widening, the
  four affected transitions will simply be enabled for GMs (the
  greyed branch never fires).

### Decisions made on operator's behalf
1. **Helper lives in its own module** (`admin-url.ts`) rather than
   inline. Single-responsibility, reused at 4 call sites,
   trivially unit-testable, mirrors the brief's example code shape.
   17 LOC + docblock.
2. **`request` parameter is `Request | null`**, not strictly required.
   The cron daily-summary path doesn't build admin URLs (confirmed
   via grep for `/admin/damage/` and `admin_url` in `runDailySummaryCron`
   — the digest payload ships claim_id + location data but no admin
   link), so the `null` branch is defense-in-depth for any future
   no-request caller. Today every actual call site passes a real
   Request.
3. **Threading `request` through `tryCreateMaintainXIfMissing` /
   `fireInternalNewClaimNotification` / `notifyClaimUpdate`** rather
   than computing a `baseOrigin` string upstream and threading
   that. Keeps the policy (workers.dev rewrite, splashcarwashes.info
   pass-through) entirely inside `resolveAdminBase`; helpers don't
   each need to know how to derive a base URL.
4. **Did NOT widen `Approved — Pending Quotes → Pending RM Review`
   to `gm`.** Brief 145 lists only the four `→ Pending GM Review`
   reverts. The `→ Pending RM Review` revert routes work AWAY from
   the GM, not back to them; it's not a "recall my own claim" use
   case and stays at `rm` per Brief 66.

### URL-build sites found and addressed
A grep for `/admin/damage/` in `apps/damage-worker/src/` returned six
hits:

| File | Line | Site | Change |
|---|---|---|---|
| `index.ts` | 2049 | comment | n/a |
| `index.ts` | 2069 | `buildUploadRedirect` 303 redirect path | already uses request `Origin` header / request URL origin (browser-form POST redirect, not an outbound webhook) — no change needed |
| `index.ts` | 3599 | `fireInternalNewClaimNotification` `admin_url` | rewired to `resolveAdminBase(request, env)` |
| `index.ts` | 3709 | `notifyClaimUpdate` `admin_url` | rewired to `resolveAdminBase(request, env)` |
| `maintainx.ts` | 97 | `adminLink` in WO description | input now sourced from `resolveAdminBase` at the two `createMaintainXWorkOrder` call sites |
| `claim-summary-pdf.ts` | 406 | comment | n/a |

A grep for `APPS_WEB_BASE_URL` in `apps/damage-worker/src/` now
returns only:
- `admin-url.ts` (the env field declaration in the helper's interface
  + the safety-net fallback at two `??` sites)
- `index.ts:195` (the `Env` interface field)

Definition of Done parity confirmed.

### Latent issues found
- The `fireD1FailureAlert` helper in `notifications.ts` (Brief 140)
  also ships through PA but does NOT carry an `admin_url` field —
  the payload's `claim_id` is the recovery handle, not a link. No
  change needed.
- The customer-claim webhook payload (`fireCustomerClaimWebhook` at
  index.ts:3441) does NOT include `admin_url` — customers don't need
  an admin link. The brief's mention of "customer-claim webhook
  payload (Brief 32)" as a site was inaccurate; only the four
  internal-facing webhooks (customer-email site_email reply-to side,
  Brief 102 internal new claim, Brief 101 manage-page updates) and
  the two MaintainX WO description sites needed updating.
- No other transition referencing `role: "rm"` for a backward path
  appears to be a "GM recall my own claim" case (the other RM-allowed
  reverts go to `Pending RM Review` or `Closed — Denied`, not back to
  the GM stage). No follow-up flag.

### Validation
- `pnpm typecheck` — **PASS.** 18/18 successful (16 cached, web +
  damage-worker ran fresh). 4.177s wall.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run`
  — **PASS.** Bundle 1764.78 KiB raw / 401.62 KiB gzip (+1.49 KiB
  raw / +0.47 KiB gzip vs Brief 141 baseline of 1763.29 / 401.15).
  Comfortably under the 3 MiB compressed free-tier ceiling.
- `pnpm --filter @splash/web build` — **PASS.** `/admin/damage/[id]`
  unchanged at 4.2 kB / 111 kB First-Load JS.
- No Supabase / R2 / wrangler.toml / D1 / secret changes. No new
  dependencies. `APPS_WEB_BASE_URL` `[vars]` value left at
  `https://splashcarwashes.info` (still the production fallback).

### Operator post-deploy smoke (deferred)
1. Customer submits a test claim at
   `https://staging.splashcarwashes.info/claims/{site}`. The
   `INTERNAL_NEW_CLAIM_WEBHOOK_URL` recipient's email's "View claim"
   link should resolve to
   `https://staging.splashcarwashes.info/admin/damage/{claim_id}`
   (NOT production); link should render the staging claim row.
2. Same submission against `https://splashcarwashes.info/claims/{site}`
   should give a production admin link (`https://splashcarwashes.info/admin/damage/{claim_id}`).
3. As GM on staging, find an open claim in `Pending RM Review` AND
   `No Responsibility — Pending Review` AND `Approved — Pending
   Quotes` AND `Pending RM Quote Approval` — the four
   `→ Pending GM Review` revert buttons should now be enabled (not
   greyed with "Requires rm or higher"). Click one, add a required
   note, transition lands on `Pending GM Review`.
4. As GM on staging, find an open claim in `Approved — In House —
   Parts Ordered` — the `→ Pending GM Review` button should still
   be greyed with "Requires admin or higher".

