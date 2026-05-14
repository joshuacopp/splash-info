# Brief 126: Forms "My Requests" view — submissions you submitted

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — companion to the Pending Approvals dashboard
(Brief 121). Approvals shows items waiting on YOU; My Requests shows
items YOU submitted with their current status (waiting on whom,
approved, denied).
**Dependencies:** Brief 120 (workflow schema + history). Brief 121
(pending-approvals endpoint — this brief mirrors that pattern).
Brief 117 (dashboard drill-down).

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 120 / 121 entries)
- BRIEFS/brief-121-forms-pending-approvals-dashboard-and-digest.md
  (mirror endpoint + page + tile structure)
- apps/forms-worker/src/admin/pending-approvals.ts (closest
  reference implementation — Brief 121)
- apps/web/app/admin/approvals/page.tsx (Brief 121 page — clone +
  retarget)
- apps/web/app/admin/dashboard/_lib/tiles.tsx (Brief 117 registry —
  add the My Requests tile)
- apps/web/middleware.ts ADMIN_KNOWN_SUBPATHS (CLAUDE.md rule — add
  `"my-requests"`)

## Context

After Brief 121 landed the Pending Approvals dashboard, the natural
complement is "what about MY requests?" — submissions that the
caller submitted, with their current workflow status. Today the
operator has to go form-by-form via the Brief 96 per-form
submissions list, filter by submitter, and eyeball the workflow_stage
column. That's not workable when an org has dozens of forms.

User mental model: an email inbox split between "items waiting on
me" (Pending Approvals — Brief 121) and "items I'm waiting on"
(My Requests — this brief). Submission, stage, who's blocking it,
outcome when done.

Data is already in the row. Brief 120 stamped `submitter_email` on
every submission. Brief 120's `workflow_stage` +
`current_approver_emails` + `workflow_history` carry every fact
needed to render "stage X — waiting on rm@example.com" or
"Approved at 2026-05-14 11:30 AM".

## Scope

### Phase 1 — Worker endpoint

New handler at
`apps/forms-worker/src/admin/my-requests.ts` (mirror Brief 121's
`pending-approvals.ts` structure):

`GET /forms/admin/api/my-requests`

Auth: any authenticated session (mirrors `/pending-approvals`). The
caller's email is matched against `form_submissions.submitter_email`
to surface their submissions.

Query params:
- `status=waiting|done|all` — defaults to `all`. `waiting`
  filters to rows where `workflow_stage` is non-null AND the
  stage has approver_source (i.e., still in flight).
  `done` filters to rows whose `workflow_stage` is a terminal
  outcome (no approver_source, no transitions out). `all` returns
  both buckets.
- `limit` — default 200, max 500.
- `offset` — default 0.

PostgREST query against `form_submissions` with embeds:
- `form:forms!inner(id,title)`
- `version:form_versions!inner(id,schema)`

Filter: `submitter_email=eq.{caller_email_lowercase}`. The
`submitter_email` column is normalized at insert time per Brief 120
(lower-cased, trimmed), so case-insensitive matching works without
ilike.

`order=submitted_at.desc`.

Response shape per item:

```ts
interface MyRequestItem {
  submission_id: string;
  form_id: string;
  form_title: string;
  workflow_stage: string;
  /** Stage label resolved from the row's version schema. */
  stage_label: string;
  /**
   * "waiting" when the current stage has an approver_source,
   * "outcome" when it's a terminal stage. Mirrors the
   * approval-step vs outcome distinction from Brief 125.
   */
  status_kind: "waiting" | "outcome";
  /**
   * Pill tint hint for the UI. "info" for in-flight, "success"
   * for approved-family outcomes, "danger" for denied-family,
   * "neutral" for anything else.
   * Derived server-side from the stage's `kind` hint (Brief 125)
   * + label keyword fallback ("approv*" / "den*").
   */
  status_tint: "info" | "success" | "danger" | "warning" | "neutral";
  /** Approver list when status_kind === "waiting", empty otherwise. */
  current_approver_emails: string[];
  submitted_at: string;
  /** When the outcome was reached (last workflow_history entry
   *  whose destination is a terminal stage). Null when still
   *  waiting. */
  outcome_reached_at: string | null;
  /** Direct link target for the Open button. */
  detail_path: string;
}
```

Cap at 500. Surface a `limit_hit: boolean` in the response when
hit; operator narrows date range.

The status_kind / status_tint derivation lives server-side so
apps/web doesn't have to walk the schema for every row.

### Phase 2 — apps/web page

New route `apps/web/app/admin/my-requests/page.tsx`:

- Auth: any authenticated session (worker scopes by
  `submitter_email`).
- Server-rendered list.
- **Filter tabs**: All | Waiting | Approved | Denied (the latter
  two are convenience surfaces over `status=done` filtered by
  `status_tint` client-side).
- Pagination via offset (Prev / Next, page size 50).
- **Table columns**:
  - Form (with form_title link to the per-form submissions list).
  - Submitted at (relative + absolute on hover, EST per the Brief
    113 `formatEst()` helper).
  - Status pill (uses `status_tint` — info pill "{stage_label} —
    waiting on {approver}" for in-flight; success pill
    "{stage_label}" for approved-family; danger pill for
    denied-family).
  - For waiting rows: a compact "Waiting on" cell listing approver
    emails (or "you" if the caller is in the list — defense in
    depth; in practice a submitter would not also be an approver
    on their own submission, but possible).
  - For outcome rows: "Reached at" cell with the
    `outcome_reached_at` timestamp.
  - Open → button linking to the per-submission detail page
    (`/admin/forms/{form_id}/submissions/{submission_id}` — the
    Brief 96 detail page).
- Empty state for the All tab: "You haven't submitted any
  workflow-enabled forms yet. Visit /forms to fill one out."
- Empty state for Waiting tab when caller has zero in-flight
  submissions: "Nothing waiting on approval right now."
- Empty state for Approved/Denied: "No {approved|denied}
  submissions in this view."

The empty-state copy intentionally avoids the word "stage" or any
schema vocabulary.

### Phase 3 — Dashboard tile

Add a "My Requests" tile to the Submissions group in
`apps/web/app/admin/dashboard/_lib/tiles.tsx`:

```ts
{
  id: "my-requests",
  group: "submissions",
  eyebrow: "WORKFLOW",
  title: "My Requests",
  description: "Submissions you submitted — waiting, approved, denied.",
  href: "/admin/my-requests",
  visibleTo: () => true
}
```

Mirrors the Brief 121 Pending Approvals tile. Visible to any
authenticated session — the underlying query naturally returns
empty when the caller has no submissions to display, so there's no
risk of leaking existence.

### Phase 4 — Middleware allow-list

**Per CLAUDE.md's "Working with apps/web" mandatory rule** (added
post-Brief-121 to prevent the `/admin/jotform` and
`/admin/approvals` redirect-to-pricing bug class): add
`"my-requests"` to `ADMIN_KNOWN_SUBPATHS` in
`apps/web/middleware.ts`. Without this, the single-segment legacy
redirect rule rewrites `/admin/my-requests` to
`/admin/pricing/my-requests` and 404s.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
5.4 No Supabase / R2 / wrangler.toml / secret changes.
5.5 Operator post-deploy smoke (deferred):
    - Submit a workflow-enabled form against your own email.
      Navigate to `/admin/dashboard` → Submissions group → My
      Requests tile visible.
    - Click → land on `/admin/my-requests`. Just-submitted row
      visible with status pill showing the current stage label +
      who's waiting on it.
    - Filter to Waiting tab → row still visible.
    - Have an approver transition the submission to Approved.
      Refresh `/admin/my-requests` → status pill updates to
      "Approved" with success tint.
    - Filter to Approved tab → row visible. Filter to Denied tab
      → empty state.
    - Submit a second form, have it denied. My Requests Denied
      tab → row visible.
    - For a user who has never submitted: empty state on All tab.
    - Direct-URL probe `/admin/my-requests` from a fresh
      incognito → middleware redirects to /login (auth gate).

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 126 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 126 (YYYY-MM-DD) — "My Requests" view at
    `/admin/my-requests` + dashboard tile in Submissions group;
    mirror of Brief 121's Pending Approvals but scoped by
    `submitter_email` instead of `current_approver_emails`. New
    worker endpoint `GET /forms/admin/api/my-requests` with
    `status=waiting|done|all` filter; server-side resolution of
    stage label + status_tint per row so apps/web doesn't walk
    the schema.

6.3 CLAUDE.md `forms-worker` glossary entry: append a Brief 126
paragraph documenting the my-requests endpoint + page + tile.

## Out of scope

- Cancel / withdraw a submission. v2 candidate (needs a new
  workflow transition type "submitter cancels" + an
  approver-revoke audit trail).
- Re-submit a denied submission. v2 — would need either a clone-
  form-with-prefill UX or an "edit and resubmit" reset path.
- Workflow history rendering on this page (the per-submission
  detail page Brief 120 built already has the timeline; no need
  to duplicate).
- Email notifications to the submitter on outcome — covered by
  Brief 125's `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` outcome
  webhook (this brief just renders the in-app view).
- Submissions WITHOUT a workflow (workflow_stage IS NULL) —
  filtered out at v1. They have no status to display in this view.
  If operator wants a "everything I ever submitted" view, that's
  a separate brief.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `GET /forms/admin/api/my-requests` endpoint exists and returns
  `{items, total, scope, caller_email, limit_hit}` scoped to
  caller's submissions.
- `/admin/my-requests` page renders the table with filter tabs
  and pagination.
- "My Requests" tile present in the Submissions group on the
  dashboard.
- `"my-requests"` added to `ADMIN_KNOWN_SUBPATHS` in
  `apps/web/middleware.ts`.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- Any submissions in operator's test data that don't render
  cleanly (e.g., workflow_stage references a stage that doesn't
  exist in the form's current version's schema — surface as a
  neutral pill with the raw stage_id).

## Outcome

**Completed by Claude Code on 2026-05-14.**

### Diff size estimate

- 2 files created (~480 LOC total)
  - `apps/forms-worker/src/admin/my-requests.ts` (~210 LOC)
  - `apps/web/app/admin/my-requests/page.tsx` (~270 LOC)
- 6 files modified
  - `apps/forms-worker/src/index.ts` — route mount + header comment update
  - `apps/web/app/admin/forms/_lib/worker-fetch.ts` — `listMyRequestsAdmin`
    helper + `MyRequestItem` / `MyRequestsResponse` / `MyRequestStatusFilter`
    / `MyRequestStatusKind` / `MyRequestStatusTint` types
  - `apps/web/app/admin/dashboard/_lib/tiles.tsx` — My Requests tile in
    Submissions group + inline `sendIcon` SVG
  - `apps/web/middleware.ts` — `"my-requests"` added to
    `ADMIN_KNOWN_SUBPATHS`
  - `CLAUDE.md` — `forms-worker` glossary entry gains a Brief 126
    paragraph
  - `BRIEFS/INDEX.md` — Brief 126 row inserted above Brief 125
- 1 file's Outcome filled in (this file) + 1 file updated (BUILD_STATE.md
  Last-updated banner + Findings entry).

### Decisions made on operator's behalf

1. **Status tint resolution.** Brief mentioned "kind hint (Brief 125)" but
   Brief 125's `tint` field is what carries the visual color (success /
   danger / etc); used `stage.tint` first, label-keyword heuristic
   (`/\bapprov/` → success, `/\bden/` → danger) as fallback.
2. **Approved + Denied tab implementation.** The worker has no
   `tint=success|danger` filter at v1; Approved + Denied tabs request
   `status=done` from the worker and narrow client-side by `status_tint`.
   Cheap because per-call result counts are small.
3. **Pagination resets on tab change.** A different status query has
   nothing to do with the prior offset, so resetting avoids "Showing rows
   51–100 of 12" weirdness.
4. **Status pill renders `stage_label` only** (not "Stage X — waiting on
   Y") to keep the pill compact; "Waiting on …" lives as a separate
   sub-line. Approver list caps at 3 emails with `+N more` suffix to
   avoid wrap mayhem with committee approvers.
5. **`outcome_reached_at` walks `workflow_history` newest-first** for
   the first entry whose `to` matches the current `workflow_stage`. Null
   when no matching entry (rare — hand-edited JSONB or submissions
   predating the current config).
6. **`submitter_email=eq.{lower}` not `ilike`** — Brief 120 normalizes
   the column at insert time, so case-insensitive prefix matching would
   just create round-trip overhead.
7. **`limit_hit` reports SQL-fetch cap, not items.length cap.**
   `rows.length >= requested_limit` is the indicator that the page cap
   was reached at the SQL layer. A per-status `count=exact` round-trip
   for accurate post-filter totals is a v2 candidate.
8. **Defensive fallback for unknown stages.** If `workflow_stage`
   references a stage that isn't in the row's version schema (rare —
   typically only via hand-edited `form_versions.schema` JSONB), the
   row surfaces as `status_kind: "outcome"` + neutral tint with the
   raw `workflow_stage` slug as label. Surfaced in the brief's Report
   section.
9. **`stageIsOutcome` predicate duplicated privately** in
   `my-requests.ts` rather than imported from `notifications.ts` — keeps
   the my-requests endpoint from pulling the notifications module into
   a path that doesn't need it. Mirrors Brief 121's
   `extractLocationCode` duplication pattern.
10. **Tile in Submissions group, not Operations.** Brief specified
    Submissions; matches the user-mental-model split (Approvals is
    Operations because it's about acting on others' work, My Requests
    is Submissions because it's about your own submissions).

### Latent issues / forward flags

- (a) Per-status `count=exact` for accurate pagination totals deferred
  to v2 — current `limit_hit` reports SQL-fetch cap, not items.length
  after filter. Acceptable for v1; documented inline.
- (b) Cancel / withdraw a submission deferred to v2 (needs a new
  "submitter cancels" transition type + approver-revoke audit trail).
- (c) Re-submit a denied submission deferred to v2 (clone-form-with-
  prefill UX or "edit and resubmit" reset path).
- (d) Submissions WITHOUT a workflow filtered out at v1 — they have no
  status to display. A separate "everything I ever submitted" view
  could be its own brief.
- (e) Workflow history rendering deferred — per-submission detail page
  Brief 120 built already has the timeline; no duplication.
- (f) Email notifications on outcome covered by Brief 125's
  `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`; this brief just renders
  the in-app view.
- (g) Edge case: a row whose `workflow_stage` references a stage that
  isn't in the row's version schema (hand-edited JSONB) renders as a
  neutral pill with the raw stage_id slug. Per the brief's Report
  section.

### Validation

- `pnpm typecheck` — **18/18 green** (forms-worker + web ran fresh;
  16 cache hits).
- `pnpm --filter @splash/web build` — **succeeds**. `/admin/my-requests`
  193 B / 107 kB First-Load JS (other routes unchanged).
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — **succeeds**. Bundle 1108.89 KiB raw /
  212.49 KiB gzipped (≈ +5 KiB raw / +1 KiB gzip vs Brief 125 baseline
  of 1103.92 / 211.76, all my-requests handler). `.tmp-build` cleaned
  up after.
- **No Supabase / R2 / wrangler.toml / secret changes.** Brief 120 owns
  the underlying `workflow_stage` / `workflow_history` /
  `current_approver_emails` columns; this brief is read-only over them.

### Report (per brief Phase 6)

- Diff size: ~480 LOC added across 2 new files + 6 modified files. No
  package.json additions, no new dependencies.
- Validation: all three required steps green.
- Test-data rendering: not actually exercised end-to-end in headless
  mode (no submission data probe possible from here); the defensive
  fallback at the `stageIsOutcome` call site (stage not found in the
  row's version schema → render as neutral outcome pill with the raw
  stage_id slug) defends against the rendering edge case the brief
  flagged. Operators should validate post-deploy that any submissions
  with stage-id-mismatch surface cleanly.

No deploy / branch / push performed (per CLAUDE.md).
