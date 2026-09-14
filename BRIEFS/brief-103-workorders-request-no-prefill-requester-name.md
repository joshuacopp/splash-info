# Brief 103: Work-request form — drop MaintainX-name pre-fill, require manual entry of actual submitter

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither (single-file UX change; no API contract change,
no worker change, no migration)
**Dependencies:** Brief 74 (introduced the New Request tab and the
`requester_name` field on `apps/web/app/workorders/_components/NewRequestForm.tsx`),
Brief 75 (made `requester_phone` required — same pattern this brief
extends to "type a real name").

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md
  (introduced the New Request tab; current pre-fill behavior is from
  this brief)
- apps/web/app/workorders/_components/NewRequestForm.tsx (~L108-118 —
  the Requester Name input and its `defaultValue` reference)
- apps/web/app/workorders/_lib/worker-fetch.ts (~L58 — `currentUser`
  shape on the `/workorders/api/list` response; not modified by this
  brief, kept harmless)
- apps/workorders-worker/src/index.ts (~L236-242, L761, L792, L847 —
  worker-side flow: pre-fill source, submit-side parse, empty-name
  reject, description-footer composition; not modified by this brief)

## Context

The Brief 74 New Request form pre-fills the **Requester Name** input
from `currentUser.full_name`, which the worker sources by looking up
the operator's session email in `maintainx_users` (the daily-synced
Brief 71 cache). The intent was to spare individual users from typing
their name on every submit.

In practice, the operator confirmed today (2026-05-11) that the
majority of MaintainX accounts in use are **shared per-location
accounts** like `binghamtonwash@splashcarwashes.com` /
`milfordwash@splashcarwashes.com`, whose `full_name` in MaintainX is
the location label ("Binghamton Wash", "Milford Wash"). When a real
person submits a work request from one of these accounts, the
pre-fill auto-populates with the location name and the operator hits
submit — so the request's "Requested by:" footer ends up saying
"Binghamton Wash" instead of identifying the actual human who
submitted. Attribution is lost.

Approximately 30 accounts are individually-owned (where the pre-fill
worked correctly); every location additionally has a shared account.
The shared accounts are the common case.

**Decision: blank the default, keep `required`, add a placeholder
and help text.** Individual-account users will type their name once
per submit — small friction in exchange for reliable attribution.
Alternatives like email-pattern detection or a `maintainx_users.is_shared`
flag were considered and rejected (brittle / requires ongoing
maintenance) by the operator on 2026-05-11.

**MaintainX-side attribution is unchanged.** `creatorContactInfo` on
the MaintainX work request stays as the operator's session email
(line 862 of `apps/workorders-worker/src/index.ts`). For shared
accounts that remains the shared-account email — that's acceptable.
The actual person's name goes into the description footer's
`Requested by:` line, which is the only place that field has ever
captured submitter identity.

## Scope

### Phase 1 — Drop the pre-fill on the Requester Name input

Single file: `apps/web/app/workorders/_components/NewRequestForm.tsx`.

The current input block (~L108-118) reads roughly:

```tsx
<FieldRow label="Requester Name" htmlFor="nr-requester-name" required>
  <input
    id="nr-requester-name"
    name="requester_name"
    type="text"
    required
    maxLength={80}
    defaultValue={currentUser.full_name ?? ""}
    className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
  />
</FieldRow>
```

Replace with:

```tsx
<FieldRow label="Requester Name" htmlFor="nr-requester-name" required>
  <input
    id="nr-requester-name"
    name="requester_name"
    type="text"
    required
    maxLength={80}
    defaultValue=""
    placeholder="Your name"
    className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
  />
  <p className="mt-1 text-xs text-splash-navy/60">
    Enter the name of the person submitting this request — even when using a shared location account.
  </p>
</FieldRow>
```

Changes:
- `defaultValue={currentUser.full_name ?? ""}` → `defaultValue=""`
- Add `placeholder="Your name"`
- Add a `<p>` of help text directly under the input, styled with the
  same muted small-text Tailwind classes used elsewhere in this form

### Phase 2 — Don't touch the worker

The worker side of the flow is already correct:
- `apps/workorders-worker/src/index.ts` line 761 reads the trimmed
  form value
- Line 792 rejects empty `requesterName` with 303
  `request_error=Requester name is required.`
- Line 847 composes `requesterName` into the description footer's
  `Requested by:` line

No worker change. No API contract change. `currentUser.full_name`
stays on the `/workorders/api/list` response shape (harmless — just
ignored by the form now). Removing the field and its
`getMaintainXUserByEmail` round-trip is a defensible cleanup but out
of scope here; the field may be useful for future surfaces and
removing it touches more files than this brief warrants.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 Visual smoke (operator-side, post-deploy): load `/workorders`,
switch to New Request tab, verify:
  - Requester Name input renders empty (no auto-populated value)
  - Placeholder "Your name" shows in the input
  - Help text "Enter the name of the person submitting this
    request — even when using a shared location account." renders
    directly under the input, muted
  - Submitting with the field empty produces the existing 303-back
    `request_error=Requester name is required.` banner (this path
    is unchanged from Brief 74; we're confirming we didn't regress
    it)
  - Submitting with a typed name produces the same successful work
    request as before, with the typed name appearing in the WO
    description's `Requested by:` line in MaintainX

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 103 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 103 (2026-05-11) — work-request Requester Name no longer
    pre-fills from `maintainx_users.full_name` to avoid shared-account
    submissions auto-populating the location label ("Binghamton Wash"
    etc.). Manual entry required. `currentUser.full_name` still
    served on the API for possible future use.
  - No worker change; no API contract change; no migration.

4.3 CLAUDE.md — Glossary "Work Orders" entry (Brief 74) has a
line about the Requester Name defaulting to MaintainX `full_name`.
Update that line to reflect the new behavior: "Requester Name
defaults to empty; operator types the actual submitter on every
request. Brief 103 (2026-05-11) dropped the auto-pre-fill from
`maintainx_users.full_name` because shared per-location accounts
(e.g., `binghamtonwash@splashcarwashes.com` → full_name 'Binghamton
Wash') were silently degrading attribution."

## Out of scope

- Removing the `currentUser.full_name` field from the
  `/workorders/api/list` response shape. Defensible cleanup but
  touches the worker and the apps/web type contract; not worth
  bundling into this UX fix. v2 candidate if the field never finds
  a new use.
- Removing the `getMaintainXUserByEmail` round-trip from the
  workorders-worker's list handler. Same rationale.
- Trying to detect shared accounts via email pattern matching (e.g.,
  `*wash@splashcarwashes.com`) and only blanking the default for
  those. Operator rejected this approach on 2026-05-11 — brittle and
  requires ongoing maintenance for naming-convention drift.
- Adding an `is_shared` flag on `maintainx_users` to power the same
  per-account pre-fill behavior. Same operator rejection.
- Auto-populating Requester Phone from any source. Phone has never
  been pre-filled (Brief 74's default behavior, retained by Brief 75
  when phone became required). No change.
- Changing the MaintainX `creatorContactInfo` field (still the
  session email, including shared-account emails). That's a MaintainX
  data-modeling discussion, not a workorders-form change.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/workorders/_components/NewRequestForm.tsx` Requester
  Name input has:
  - `defaultValue=""`
  - `placeholder="Your name"`
  - A help-text `<p>` directly below explaining "Enter the name of
    the person submitting this request — even when using a shared
    location account."
- No other file changes besides BRIEFS/INDEX.md, BUILD_STATE.md, and
  CLAUDE.md.
- `pnpm typecheck` passes for all packages.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Confirmation of the diff size (likely 10-15 lines net, one .tsx
  edit plus the doc rows)
- Confirmation the worker side was NOT touched (Phase 2 says no
  change; verify by `git diff apps/workorders-worker/`)
- Validation results
- Any decisions made on the operator's behalf
- Latent issues found, if any

## Outcome

**Files modified (5):**

- `apps/web/app/workorders/_components/NewRequestForm.tsx` — Requester
  Name input: `defaultValue={currentUser.full_name ?? ""}` →
  `defaultValue=""`; added `placeholder="Your name"`; added a muted
  `<p className="mt-1 text-xs text-splash-navy/60">` directly under
  the input with copy "Enter the name of the person submitting this
  request — even when using a shared location account." Net +6/-1
  lines on the input block (the brief estimated 10-15 net; the actual
  change is closer to the lower bound because the surrounding markup
  was already structured for the new help-text paragraph).
- `BRIEFS/INDEX.md` — Brief 103 row inserted above the Brief 102 row
  (most-recent-first ordering matches the immediately preceding
  entries).
- `BUILD_STATE.md` — "Last updated" line bumped to summarize Brief 103;
  new row appended to the top of the Findings & decisions log table
  (above the Brief 100 row, since Briefs 101/102 are not in the
  findings table on this file's current state — the operator
  evidently tracks them only via the "Last updated" line plus
  BRIEFS/INDEX.md, so this brief follows that convention).
- `CLAUDE.md` — Glossary "Work Orders" entry updated. The closing
  paragraph that previously read "`currentUser.full_name` (also new
  on the read response) defaults the Requester Name input to the
  operator's MaintainX `full_name` via the new `getMaintainXUserByEmail`
  helper in `@splash/db-supabase`." now reads "Requester Name defaults
  to empty; operator types the actual submitter on every request.
  Brief 103 (2026-05-11) dropped the auto-pre-fill from
  `maintainx_users.full_name` because shared per-location accounts
  (e.g., `binghamtonwash@splashcarwashes.com` → full_name 'Binghamton
  Wash') were silently degrading attribution. `currentUser.full_name`
  (sourced via `getMaintainXUserByEmail` in `@splash/db-supabase`)
  still ships on the `/workorders/api/list` response shape —
  harmless, ignored by the form now; v2 cleanup candidate if no
  future surface picks it up." Brief copy matched verbatim where
  practical and lightly reflowed to the existing 60-col-ish paragraph
  width.
- `BRIEFS/brief-103-workorders-request-no-prefill-requester-name.md`
  — this brief's Status bumped to `Completed (2026-05-11)` and
  Outcome filled in.

**Worker untouched (confirmed):** `git diff --stat
apps/workorders-worker/` returns empty. The worker-side flow
(`apps/workorders-worker/src/index.ts` lines 761 trim, 792 empty-name
reject, 847 description-footer compose) is unchanged. The
`currentUser.full_name` field on the `/workorders/api/list` response
also stays — removing it was explicitly out of scope.

**Decisions made on the operator's behalf:**

- BUILD_STATE.md findings-table placement: inserted the new Brief 103
  row immediately above Brief 100 (the most recent row currently in
  the table). Briefs 101 and 102 are not present as rows in this
  file's current state — they appear only in the "Last updated"
  prelude. I did not retroactively add 101/102 rows; that's a
  separate housekeeping decision and outside this brief's scope.
- CLAUDE.md replacement copy used full-paragraph reflow (rather than
  a strict one-line swap) so the existing paragraph reads cleanly
  with the new behavior. The brief copy was preserved verbatim where
  feasible.
- No worker-side cleanup attempted (currentUser.full_name removal,
  getMaintainXUserByEmail removal). Brief Phase 2 explicitly says
  "no worker change"; deferring per spec.

**Latent issues found:**

- None new. The pre-existing observation that `currentUser.full_name`
  + the worker-side `getMaintainXUserByEmail` round-trip are now
  dead-weight on the read path is already flagged as a v2 candidate
  in this brief's Out-of-scope section; no separate finding needed.

**Validation results:**

- `pnpm typecheck` → 17/17 successful, 16 cached, 7.617s wall.
  `@splash/web` ran fresh (post-edit) and passed. All other packages
  cache-hit.
- `pnpm --filter @splash/web build` → success. `/workorders` route
  surface: 5.45 kB route-specific, 107 kB First-Load JS — unchanged
  versus the Brief 102 baseline (the diff is markup-only inside an
  existing client island, no new dependencies, no bundle impact).
- `git diff --stat apps/workorders-worker/` → empty. Per Phase 2.
- Total diff per `git diff --stat`: 5 files changed, 21 insertions(+),
  6 deletions(-). Within the brief's 10-15-line net estimate when
  excluding the doc-row prose (which the brief flagged as additional).

**Smoke test (deferred to operator):** the four post-deploy visual
checks called out in Phase 3.3 — empty input + placeholder + help text
+ submit-empty produces existing 303-back error banner + submit-typed
produces successful WO with typed name in description footer — are
non-automatable from the apps/web side without standing up a CF
preview environment with a live MaintainX work-request submission.
The operator runs these against the splash-web workers.dev preview or
the staging deploy after Workers Builds picks up the merged change.
