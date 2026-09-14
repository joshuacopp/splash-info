# Brief 152: tighten email validation to reject trailing/leading/consecutive dots in local-part

**Status:** Completed (2026-06-03)
**Started:** 2026-06-03
**Completed:** 2026-06-03
**Blocks:** Email deliverability — 22 PA send-failures yesterday + today on
maxpass signups; each failed submission requires manual cleanup
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- legacy/signup_worker_with_BOGO.js — current production signup worker.
  Search for the email regex in `renderSignupForm` (`validateEmail` JS
  inside the client form HTML). It's loose: matches any
  `[^\s@]+@[^\s@]+\.[^\s@]+` — accepts `name.@domain.com`.
- apps/signup-worker/src/render/form.ts — TS port's version of the
  signup form (client-side regex)
- apps/signup-worker/src/handlers/submit-signup.ts — server-side
  submit handler. Confirm whether it validates email at all (today's
  trailing-dot bug suggests no, or the same loose regex)
- apps/damage-worker/src/render/claim-form.ts — customer claim form's
  email validation (Brief 32 made email required and added a regex —
  almost certainly the same loose one)
- apps/damage-worker/src/index.ts — claim submit handler's
  server-side email check
- apps/fleet-inquiry-worker/src/index.js — verbatim-lifted JS per
  Brief 81; likely has a fleet email field with the same loose regex
- apps/forms-worker/src/render/fields/email.ts (or wherever the email
  field type is rendered/validated per Brief 90)

## Context

Operator reports 22 Power Automate send-failures across yesterday +
today on the maxpass signup confirmation-email flow. Sample error from
Office 365 / Exchange:

```
{
  "status": 400,
  "message": "One or more recipients are invalid.",
  "error": {
    "code": "ErrorInvalidRecipients",
    "originalMessage": "At least one recipient is not valid.,
       Recipient 'Mariarivera9999mr.@gmail.com' is not resolved.
       All recipients must be resolved before a message can be submitted."
  }
}
```

Pattern across the 22: each failing recipient has a `.` immediately
before the `@`. This is RFC 5321/5322 invalid (local-part can't start
or end with a dot, can't have consecutive dots). Gmail's own MX
servers happen to accept the form, but Exchange Online does strict
recipient resolution before SMTP and rejects it during the connector
call.

The customer-input side allows it because the form's email regex is
the typical "no spaces or @ then @ then no spaces and a dot
somewhere" pattern (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`), which has no
opinion on dot positions inside the local-part. Trailing-dot emails
pass that check, land in `maxpass_signups`, and 30 minutes later PA
tries to send and Exchange rejects.

The frequency across multiple locations is the regex, not the
locations — tablet keyboards autocomplete a period after the end of a
word, especially when "double-space-period" or "period-on-end" muscle
memory kicks in mid-typing-an-email. Different customers at different
sites have the same input habit.

Fix: tighten the regex on every customer-facing form's email
validation (client-side AND server-side) so trailing dots, leading
dots, consecutive dots, and other RFC-invalid local-part shapes are
rejected at submission time. That stops the bad rows from landing in
`maxpass_signups` / `fleet_submissions` / `claims` / form
submissions in the first place.

## Scope

1. **Pick a single canonical regex helper.** New shared module:
   ```ts
   // packages/types/src/email-validate.ts  (or packages/http; place
   // wherever is most-importable from both Workers and apps/web)
   /**
    * Pragmatic email validation. Rejects the RFC-invalid shapes the
    * loose `[^@]+@[^@]+\.[^@]+` regex lets through:
    *   - leading dot in local-part: ".name@domain.com"
    *   - trailing dot in local-part: "name.@domain.com"
    *   - consecutive dots in local-part: "na..me@domain.com"
    *   - leading/trailing dot or hyphen in domain
    *   - missing TLD or TLD shorter than 2 chars
    *
    * This is NOT a full RFC-5321 validator (that includes quoted
    * local-parts, IP-literal domains, internationalized addresses).
    * It IS a strict-enough filter for the addresses Office 365's
    * Send Email V2 connector accepts via recipient resolution, which
    * is what's been failing.
    */
   export function isValidEmail(s: string): boolean {
     if (!s) return false;
     const trimmed = s.trim();
     if (trimmed.length === 0 || trimmed.length > 254) return false;
     // local-part: starts + ends with alphanumeric; internal dots
     // allowed but not adjacent and not adjacent to @
     // domain: dot-separated alphanumeric labels (with hyphens
     // allowed internally), TLD >= 2 alpha chars
     const re = /^[A-Za-z0-9](?:[A-Za-z0-9_+-]|\.(?!\.))*[A-Za-z0-9]@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
     return re.test(trimmed);
   }
   ```
   - This explicitly handles single-character local-parts (e.g.
     `a@b.co`) — the inner `(?:[A-Za-z0-9_+-]|\.(?!\.))*` is allowed
     to match zero characters, so the head and tail can be the same
     character. Add a unit-test-style sanity check in the doc comment
     for the cases `a@b.co`, `name@domain.com`, `name.@domain.com`,
     `.name@domain.com`, `na..me@domain.com`, `name@domain`,
     `name@.domain.com`, `name@domain.c`, with expected results.

2. **legacy/signup_worker_with_BOGO.js** — replace the
   `validateEmail` regex inside `renderSignupForm`'s client JS with
   the equivalent pattern. Since this is JS-in-HTML embedded in a
   template literal, escape carefully (the `\.(?!\.)` lookahead and
   `\D` etc.). Also add a SERVER-side check inside
   `handleSignupSubmission` before the Supabase POST — pull the same
   helper if practical, or duplicate the regex with a comment
   pointing at the canonical source.

3. **apps/signup-worker/src/render/form.ts** — same regex swap on
   the client side. The TS port has the helper available as
   `isValidEmail` from `packages/types/src/email-validate.ts`; use
   it via the form's inline `<script>` by serializing the regex
   constant (NOT the function — functions can't cross to a `<script>`
   tag literal). A small inline snippet that re-defines the regex
   with a comment "DO NOT EDIT — must match isValidEmail in
   @splash/types/email-validate" is fine.

4. **apps/signup-worker/src/handlers/submit-signup.ts** — call
   `isValidEmail(body.email)` after the existing phone validation
   and BEFORE `insertSignup`. On reject, return:
   `{ denied: true, error: "Please enter a valid email address." }`
   with status 400. The form's existing error display already shows
   `result.error`, so no client-side wiring needed.

5. **apps/damage-worker/src/render/claim-form.ts** — Brief 32 made
   email required and uses the same loose regex. Update both the
   client-side `validateEmail` and the server-side check in
   `handleClaimSubmission` (`apps/damage-worker/src/index.ts`,
   probably near the customer-email column write). Reuse the shared
   helper.

6. **apps/fleet-inquiry-worker/src/index.js** — verbatim-lifted JS;
   has its own email field. Find the validation and tighten the
   regex inline (the worker is JS-only, no TS helper import). Add a
   comment pointing at the canonical source.

7. **apps/forms-worker/src/render/fields/email.ts** (Brief 90 email
   field type) — server-side validation on the email field uses Zod
   today probably; tighten the `.email()` check with a `.regex(...)`
   refinement that matches the canonical pattern. The form-render
   path's inline JS validator should also reject the same shapes
   client-side.

8. **Cleanup / documentation:**
   - Add a glossary entry under "email validation" in CLAUDE.md
     capturing where `isValidEmail` lives, what shapes it rejects,
     and the Brief 152 cross-reference. Future executors touching
     any email-input form must use it.
   - Don't try to retroactively clean the 22 failed `maxpass_signups`
     rows (operator scope). The PA flow will keep failing on those
     until they're addressed manually OR superseded by a follow-up
     brief. Flag for the operator.

## Configuration

No new env vars or secrets.

## Out of scope

- Don't add a "did you mean…?" auto-correct feature (e.g. strip
  trailing dots and offer the fixed address). The right behavior is
  reject + ask the user to fix it. Auto-correct is a v2 candidate.
- Don't retroactively rewrite the 22 failed `maxpass_signups` rows
  or attempt to re-trigger their PA emails. Operator handles those
  one-off.
- Don't widen the regex to support quoted local-parts (`"weird
  name"@domain.com`), IP-literal domains (`name@[192.0.2.1]`),
  internationalized addresses (`naïve@münchen.de`), or other RFC
  5321 esoterica. The pragmatic regex covers the ~99.9% of real-
  world addresses that Exchange resolves successfully. Edge cases
  can come in via a follow-up brief if a real customer hits one.
- Don't change the existing phone regex / fraud detection logic.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/signup-worker build` succeeds.
- `pnpm --filter @splash/damage-worker build` succeeds.
- `pnpm --filter @splash/forms-worker build` succeeds.
- `packages/types/src/email-validate.ts` exports `isValidEmail` with
  the doc comment + sanity-check table.
- All FIVE customer-facing forms (legacy signup, TS signup, damage
  claim, fleet inquiry, custom forms) reject `name.@domain.com`,
  `.name@domain.com`, `na..me@domain.com`, `name@.domain.com`,
  `name@domain`, `name@domain.c` — both at client-side validation
  AND at server-side submit handler.
- All five forms STILL accept `name@domain.com`, `a@b.co`,
  `first.last@domain.com`, `name+tag@domain.com`,
  `na_me@domain.com`, `name@sub.domain.com` — common shapes that
  must continue to work.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 152: tightened email validation across all customer-facing
  forms to reject RFC-invalid local-part dot positions; closes the
  PA Send-Email-V2 recipient-resolution bug class").

## Report

- Whether the canonical helper landed in `packages/types/`,
  `packages/http/`, or a fresh `packages/email/` location.
- Whether the JS-in-template-literal escaping in the legacy worker
  required any regex-source rewriting (template-literal `\` rules
  get fussy with regex lookaheads).
- Any additional customer-facing email input the brief missed —
  search the repo for `type="email"` and `Content-Type.*email` to be
  thorough.
- Whether the forms-worker email field renderer was using Zod
  `.email()` (which has its OWN looseness story) or a custom regex
  before this change.
- Operator-facing surfaces (Set User Email, sysadmin create user)
  use the same regex or a different one — flag for consideration in
  a follow-up.

## Outcome

### Files created
- `packages/types/src/email-validate.ts` — canonical `isValidEmail` +
  `EMAIL_REGEX` + `EMAIL_REGEX_SOURCE`. Doc comment carries the brief's
  full sanity-check table (12 cases including `Mariarivera9999mr.@gmail.com`
  from the operator's PA failure logs). Regex source:
  `^[A-Za-z0-9](?:[A-Za-z0-9_+-]|\.(?=[A-Za-z0-9_+-]))*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$`.
  The `\.(?=[A-Za-z0-9_+-])` rule simultaneously rejects trailing dots
  (lookahead fails when next char is `@`) and consecutive dots
  (lookahead fails when next char is `.`); the surrounding structure
  permits single-character local-parts (`a@b.co` validates).

### Files modified
- `packages/types/src/index.ts` — added `export * from "./email-validate.js";`.
- `packages/types/package.json` — added subpath export `"./email-validate": "./src/email-validate.ts"` so workers can `import { isValidEmail } from "@splash/types/email-validate"`.
- `apps/signup-worker/src/render/form.ts` — imports `EMAIL_REGEX_SOURCE`;
  the form's inline IIFE now compiles `var EMAIL_RE = new RegExp(${JSON.stringify(EMAIL_REGEX_SOURCE)})`
  at module init, so the client-side gate matches the server-side
  `isValidEmail` exactly. `validateEmail()` now checks length + EMAIL_RE.
- `apps/signup-worker/src/handlers/submit-signup.ts` — imports `isValidEmail`;
  added a server-side check after phone validation and before `insertSignup`.
  On reject returns `{ denied: true, error: "Please enter a valid email address." }`
  with status 400 (matches the form's existing `result.error` display path).
- `apps/damage-worker/src/index.ts` — imports `isValidEmail`; swapped
  the loose `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` test in `handleClaimSubmission`'s
  customer-email validator. 303-redirect-on-error / 400-JSON-on-error
  paths unchanged.
- `apps/damage-worker/src/render/claim-form.ts` — imports `EMAIL_REGEX_SOURCE`;
  added `var EMAIL_RE = new RegExp(...)` + `validateCustomerEmail(input)`
  helper inside FORM_SCRIPT IIFE. Wired into TWO places: (a) Continue-
  button gate (uses `setCustomValidity` + `reportValidity` to surface
  the native browser bubble, then clears `setCustomValidity('')` so the
  bubble auto-dismisses on next input); (b) `validateBeforeSubmit()`
  defense-in-depth re-check at final submit time (covers a11y / programmatic
  paths that bypass the Continue button).
- `apps/fleet-inquiry-worker/src/index.js` — added module-level
  `EMAIL_REGEX` constant + `isValidEmail` JS helper with a
  "must match canonical helper" comment (this worker is verbatim-lifted
  JS, outside the TS workspace, per Brief 81 / CLAUDE.md constraint #9).
  Server-side `/api/fleet-submit` swapped to `isValidEmail(data.email)`.
  Client-side `validateForm()` inline regex also tightened (duplicated
  with the same comment pointer).
- `packages/forms-schema/src/validators/payload.ts` — tightened the
  `EMAIL_RE` const used by the email field's Zod `.regex(EMAIL_RE, ...)`
  payload validator. Same pattern as the canonical helper.
- `apps/forms-worker/src/render/fields/email.ts` — added an `EMAIL_PATTERN`
  constant + uses it as the HTML5 `pattern` attribute on the rendered
  `<input type="email">`. Also added `title="Please enter a valid email address."`
  so the browser's validation bubble carries useful copy.
- `legacy/signup_worker_with_BOGO.js` — the file was already partially
  tightened by prior in-flight work (git status showed it `M` before
  Brief 152 started). Added the canonical-source pointer comment above
  the `isValidEmail()` helper; the existing regex variant `(?!\.)` was
  verified equivalent to the canonical `(?=[A-Za-z0-9_+-])` variant
  against every Definition-of-done case and left in place to minimize
  diff noise on the verbatim-production worker.
- `CLAUDE.md` — new top-of-Glossary "email validation" entry capturing
  canonical location, what shapes are rejected/accepted, where each
  customer-facing form uses it, and the follow-up flags for operator-
  facing surfaces.
- `BUILD_STATE.md` — bumped "Last updated" to 2026-06-03, prepended a
  Brief 152 findings entry.

### Decisions made on operator's behalf
1. Canonical home is `packages/types/src/email-validate.ts` — pure
   predicate, no framework dependency, and `@splash/types` is already
   a workspace dep of every TS worker that has a customer email field.
   Subpath export `@splash/types/email-validate` keeps tree-shaking
   surgical. Did NOT add a new `packages/email/` package; that would
   be ceremony for one regex constant.
2. Three workers couldn't subpath-import (`packages/forms-schema` does
   not depend on `@splash/types`, and `apps/fleet-inquiry-worker` +
   `legacy/signup_worker_with_BOGO.js` are verbatim-lifted JS outside
   the TS workspace). All three duplicated the regex inline with a
   "must match canonical helper" pointer comment — same posture other
   verbatim-lifted code in this repo uses. The brief's "Place wherever
   is most-importable from both Workers and apps/web" guidance and
   the "function over function — functions can't cross to a `<script>`
   tag literal" note both apply here.
3. Damage claim form uses `setCustomValidity()` → `reportValidity()`
   → `setCustomValidity('')` pattern to surface the native browser
   bubble on the customerEmail field and immediately re-arm for the
   next input. Matches the existing `field.reportValidity()` pattern
   Brief 135 used for required-field handling.
4. `${JSON.stringify(EMAIL_REGEX_SOURCE)}` chosen as the embedding
   mechanism for the signup-worker form's inline `<script>` IIFE.
   Produces a JS string literal in the OUTPUT JS that the browser
   parses correctly — no manual `\\.` doubling required. Verified
   by Node REPL roundtrip.
5. Defense-in-depth: damage claim form runs the regex check at BOTH
   the Continue-button gate AND `validateBeforeSubmit()` (the second
   covers a11y / programmatic submit paths that bypass Continue).
   Signup-worker runs it client-side inside `validateEmail()` AND
   server-side inside `handleSignupSubmission` (programmatic JSON
   callers bypass the client gate).

### Latent issues found
- **Operator-facing surfaces still using the loose regex (out-of-scope
  per brief Report direction).** Three sites left intentionally for a
  follow-up alignment brief: (a) `apps/sysadmin-worker/src/index.ts`
  line 676 `EMAIL_RE` — operator-curated location email fields
  (am_email / rm_email / site_email). (b) `apps/jotform-worker/src/filters.js`
  line 18 — URL param sanitizer for am_email / rm_email filters; a
  malformed input simply finds no rows. (c) `apps/web/app/admin/forms/[id]/_workflow/PersonAutosuggest.tsx`
  line 23 — Workflow builder's Specific person / Multiple people
  picker. These eventually flow into `current_approver_emails` and
  through PA Send Email V2, so this is the highest-priority follow-up.
- **Pre-existing partial work in `legacy/signup_worker_with_BOGO.js`.**
  Brief 152 found the file already had a tightened regex (different
  lookahead style but functionally equivalent — verified via Node
  REPL). The pre-existing changes were not from a tracked brief; left
  in place + added the canonical-source pointer comment.
- **Damage claim form's customer email validation runs only on
  Continue-button click**, not on input/blur. Live validation (input
  event → regex → bubble) is a UX v2 candidate.
- **22 already-landed `maxpass_signups` rows** with tainted email
  shapes are NOT retroactively rewritten — operator handles those
  one-off per brief Out-of-scope.

### Report (per brief)
- **Canonical helper home:** `packages/types/src/email-validate.ts`
  with subpath export `@splash/types/email-validate`. Rationale:
  pure predicate, no HTTP / framework dependency, `@splash/types` is
  already a workspace dep of every TS worker that has a customer
  email field. `packages/http/` would have been wrong (mixes string
  validation into the HTTP-helper namespace); a fresh `packages/email/`
  would have been ceremony for one regex constant.
- **JS-in-template-literal escaping in the legacy worker:** No regex-
  source rewriting required — the pre-existing partial-work tightened
  regex was already correctly escaped (`\\.` doubled inside the
  backtick literal). The TS signup-worker (apps/signup-worker) uses
  `${JSON.stringify(EMAIL_REGEX_SOURCE)}` interpolation to embed a
  JSON string literal in the output JS, sidestepping double-escape
  gymnastics entirely.
- **Additional customer-facing email inputs:** Searched repo with
  `\[\^@\\s\]\+@`, `\[\^@\]\+@`, `@\[\^@`, `type="email"` patterns.
  No additional customer-facing input found beyond the five in the
  brief. The three operator-facing surfaces noted above (sysadmin,
  jotform filters, PersonAutosuggest) are documented for follow-up.
- **forms-worker email field renderer pre-fix state:** Used custom
  Zod `.regex(EMAIL_RE, "Invalid email address")` with `EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/`
  (NOT `z.string().email()` — Zod's `.email()` has its own looseness
  story that wouldn't have been any better). Brief 152 swaps the
  regex constant in place; the Zod method shape is unchanged.
- **Operator-facing surfaces flagged for follow-up:** See "Latent
  issues found" above.

### Validation results
- **`pnpm typecheck`:** 18/18 successful (10.461s; 2 cached, fresh
  runs across web + all 8 workers + packages including the modified
  `@splash/types` and `@splash/forms-schema`). No type errors.
- **`pnpm --filter @splash/signup-worker exec wrangler deploy --dry-run --outdir=.tmp-build`:** succeeded, bundle 785.10 KiB raw / 151.81 KiB gzipped.
- **`pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=.tmp-build`:** succeeded, bundle 1864.12 KiB raw / 424.58 KiB gzipped.
- **`pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build`:** succeeded, bundle 2024.03 KiB raw / 445.33 KiB gzipped.
- **`pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy --dry-run --outdir=.tmp-build`:** succeeded, bundle 787.03 KiB raw / 150.03 KiB gzipped.
- `.tmp-build` directories cleaned up after each run.
- **Brief's Definition-of-done case verification (Node REPL):** all
  six "must accept" cases pass; all six "must reject" cases including
  `Mariarivera9999mr.@gmail.com` from the operator's PA failure logs
  fail correctly. Both regex variants (canonical and legacy-worker's
  pre-existing) tested side-by-side and verified equivalent.
- No CF deploys; no production-route bindings; no git commits per
  CLAUDE.md.
