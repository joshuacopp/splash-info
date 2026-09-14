# Brief 121: Pending Approvals dashboard surface + daily digest cron + single PA flow

**Status:** Completed (2026-05-13)
**Started:** 2026-05-13
**Completed:** 2026-05-13
**Blocks:** Neither — but waiting on Brief 120's workflow data
model to land first. This brief reads the
`current_approver_emails` column Brief 120 writes.
**Dependencies:** Brief 120 (workflow schema + transition
machinery + `current_approver_emails` denormalization). Brief 65
(damage daily summary cron — pattern reused here). Brief 101
(notification helper module — reused for the single digest email).
Brief 117 (dashboard drill-down — new "Pending Approvals" tile).

## Read first

- CLAUDE.md (`forms-worker` + damage daily summary +
  notifications glossary)
- BRIEFS/brief-120-forms-workflow-schema-and-transitions.md
  (Outcome — the data model this brief builds on)
- BRIEFS/brief-065-damage-daily-summary-cron.md (pattern
  reference for the scheduled handler)
- BRIEFS/brief-101-damage-claim-update-webhook.md (notification
  helper module reused here)
- apps/forms-worker/src/* (worker structure — adds scheduled
  handler + pending-approvals endpoint)
- apps/web/app/admin/dashboard/_lib/tiles.ts (Brief 116/117
  registry — adds the Pending Approvals tile)

## Context

Operator wants approval flows on custom forms to be completed
**in the dashboard**, not via per-form Power Automate flows.
One single digest email per approver per day is acceptable for
heads-up notification, but the actual approve/deny actions happen
inside apps/web.

The plumbing Brief 120 lands:
- `form_submissions.current_approver_emails text[]` — denormalized
  email list for the current stage's approvers. Updated on every
  transition.
- Transition endpoint exists; UI for approving lives on the
  per-submission detail page.

What Brief 121 adds:
- **Cross-form "pending for me" query** — `WHERE my_email = ANY(
  current_approver_emails)` on `form_submissions`. Returns
  every submission across every form where the caller is in the
  approver set for the current stage. Fast (GIN index from Brief
  120).
- **Pending Approvals page** at `/admin/approvals` — list of
  pending items, drill-through to the per-submission detail page
  where the operator approves/denies via Brief 120's UI.
- **Pending Approvals dashboard tile** in the Operations group
  — visible to any authenticated session (most users will have
  pending items at some point).
- **Daily digest cron** — once-daily scheduled handler fires at
  e.g. 12:00 UTC (7 AM EDT, before damage's 13:00 UTC summary).
  Queries pending approvals grouped by approver email, fires
  one POST per recipient to a **single** Power Automate flow
  (one PA flow for the entire forms feature, regardless of how
  many forms have workflows).

## Scope

### Phase 1 — Pending Approvals worker endpoint

Edit `apps/forms-worker/src/handlers/`. New endpoint:

`GET /forms/admin/api/pending-approvals`

Auth: any authenticated session.

Logic:
1. Read `session.email`.
2. Query Supabase:
   ```sql
   SELECT s.id, s.form_id, s.workflow_stage, s.submitted_at,
          s.payload, s.workflow_history,
          f.title AS form_title,
          v.schema AS version_schema
   FROM form_submissions s
   JOIN forms f ON f.id = s.form_id
   JOIN form_versions v ON v.id = s.form_version_id
   WHERE :email = ANY(s.current_approver_emails)
   ORDER BY s.submitted_at DESC
   LIMIT 500;
   ```
3. Return `{ items: [...], total: ... }` where each item
   contains: submission id, form title, current stage label
   (resolved from `version_schema.workflow.stages`), submitter,
   submitted-at, link to `/admin/forms/{form_id}/submissions/{id}`.

500-row safety cap; if a single user has more pending than that
they have bigger problems and the dashboard can prompt them.

### Phase 2 — Pending Approvals page

New route `apps/web/app/admin/approvals/page.tsx`:

- Auth: any authenticated session.
- Server-rendered list grouped by **form** (each form's pending
  items as a section), then sorted by submitted-at desc within
  each section.
- Each row: form title (group header), submitter (from session
  email at submit-time, if captured) / site / stage / submitted-
  at / "Review →" button linking to the per-submission page.
- Empty state: "No pending approvals — you're all caught up."
- Header copy explains the model: "These are submissions waiting
  on your approval. Click Review to view details and approve or
  decline."

Also add an "All Approvals" filter toggle (super_admin / admin
only) — show pending items across the whole org, not just the
caller's. Useful for ops oversight. Defaults off.

### Phase 3 — Dashboard tile

Edit `apps/web/app/admin/dashboard/_lib/tiles.ts` (Brief 117).
Add to the Operations group:

```ts
{
  id: "pending-approvals",
  group: "operations",
  eyebrow: "WORKFLOW",
  title: "Pending Approvals",
  description: "Submissions waiting on your review.",
  href: "/admin/approvals",
  visibleTo: () => true
}
```

Optional polish: include a count badge ("3 waiting") on the tile
if the count > 0. Requires an upstream fetch on dashboard render —
might be worth deferring to v2 to keep the dashboard fast.

### Phase 4 — Daily digest scheduled handler

Edit `apps/forms-worker/src/index.ts` to add a `scheduled`
export alongside the existing `fetch`:

```ts
export default { fetch, scheduled };

async function scheduled(event, env, ctx) {
  if (event.cron === "0 12 * * *") {
    await runDailyApprovalDigest(env);
  }
}
```

Edit `wrangler.toml` to add the cron trigger:

```toml
[triggers]
crons = ["0 12 * * *"]  # 12:00 UTC = 7 AM EDT
```

The `runDailyApprovalDigest` function:
1. Query Supabase for every distinct approver email across all
   `form_submissions` with non-NULL `current_approver_emails`.
2. For each approver email:
   - Count their pending items (per form, total).
   - Fire one POST to `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` (new
     secret) with payload:
     ```json
     {
       "recipient_email": "rm@splashcarwashes.com",
       "total_pending": 7,
       "by_form": [
         { "form_title": "Equipment Repair Request", "count": 4, "oldest_submitted_at": "..." },
         { "form_title": "PTO Request", "count": 3, "oldest_submitted_at": "..." }
       ],
       "dashboard_url": "https://splashcarwashes.info/admin/approvals"
     }
     ```
   - Fail-soft (Brief 65 / 101 pattern — 15s timeout, swallow
     non-2xx, log `[forms.approval-digest]` line).
3. Skip-on-empty: if approver has zero pending, no POST.

Single PA flow ("Forms Approval Digest") fans out one email per
recipient with a deep link to `/admin/approvals`. Bind via
`pnpm --filter @splash/forms-worker exec wrangler secret put
FORMS_APPROVAL_DIGEST_WEBHOOK_URL` once PA flow URL exists.

When unbound, the cron still runs (logs the digest counts) but
silently skips the POST. Fail-soft.

### Phase 5 — Mark "viewed" / "snooze" (v2 candidate, NOT in scope)

Out of scope for v1. Flagged here:
- "Mark as viewed" to suppress from next day's digest (would need
  per-approver-per-submission `digest_dismissed_at` column).
- "Snooze for X days" — same.

v1 sends the digest daily until the operator transitions the
submission out of their stage.

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass.
6.2 `pnpm --filter @splash/web build` — must succeed.
6.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
6.4 No Supabase / R2 schema changes (Brief 120 owns the
    `form_submissions` column adds).
6.5 Operator post-deploy smoke (deferred):
    - As an RM, navigate to `/admin/dashboard` → Operations group
      → Pending Approvals tile visible.
    - Click → land on `/admin/approvals`. Empty state for an RM
      with no pending items.
    - Have someone submit a form against a workflow whose
      `site_role: rm_email` stage maps to this RM. Refresh page →
      pending item visible. Click "Review →" → land on
      Brief 96 detail page → Brief 120 transition modal.
    - Manually trigger the cron via CF Workers dashboard "Send
      test event" → verify one POST per pending approver hits
      the PA flow (if bound) or one log line per approver
      (if not).
    - Test PA flow: trigger one digest, confirm a single email
      arrives summarizing all pending forms (not one email per
      form).

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 121 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - Brief 121 (YYYY-MM-DD) — Pending Approvals dashboard
    surface at `/admin/approvals` + tile in Operations group;
    daily digest cron (12:00 UTC) sends one POST per approver
    per day to `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` PA flow.
    Built on Brief 120's `current_approver_emails`
    denormalization for fast queries.
  - Single PA flow design: no per-form notification setup —
    adding new forms with workflows automatically participates
    in the digest, zero PA work per form.

7.3 CLAUDE.md `forms-worker` glossary entry: append a Brief 121
paragraph documenting the pending-approvals endpoint, the
dashboard tile, the daily cron + secret name.

7.4 PA flow build guide: new doc
`C:\Users\Coppsrv\Documents\splash-info\PA_FLOWS_BRIEF_121.md`
with step-by-step PA flow construction (mirrors the Brief
101/102/105 guide pattern).

## Out of scope

- Per-event notifications (immediate "you have a new approval")
  — daily digest only at v1. v2 candidate.
- Snooze / mark-viewed UX (Phase 5 placeholder).
- Department approvers (waiting on Brief 120 v2 / department
  source type).
- Count badge on the dashboard tile (defer to v2 unless
  performance allows easy fetch).
- Cross-form bulk transitions (approve N items at once). v2.
- Email customization per form (digest is form-agnostic at v1).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `GET /forms/admin/api/pending-approvals` endpoint exists and
  returns `{ items: [...] }` scoped to caller's email.
- `/admin/approvals` page renders pending items grouped by form
  with Review buttons; "All Approvals" toggle for admin-tier.
- "Pending Approvals" tile present in Operations group on the
  dashboard.
- Forms-worker default export becomes `{ fetch, scheduled }`;
  `wrangler.toml` includes `[triggers] crons = ["0 12 * * *"]`.
- `runDailyApprovalDigest` queries Supabase, groups by approver,
  fires per-recipient POST to `FORMS_APPROVAL_DIGEST_WEBHOOK_URL`.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 7.
- PA_FLOWS_BRIEF_121.md exists.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- Any concerns about the GIN index performance at scale (e.g.,
  if `current_approver_emails` arrays grow large for forms with
  multi-email static approver lists).
- Any quirks of CF Workers' scheduled trigger that needed
  workaround.

## Outcome

### Files created

- `apps/forms-worker/src/admin/pending-approvals.ts` — ~170 LOC handler
  for `GET /forms/admin/api/pending-approvals`. Any-session auth via
  `authenticate()`; `?all=1` admin-tier widens scope to every pending
  approval in the org (non-admins silently coerced back to "me").
  PostgREST query filters `workflow_stage IS NOT NULL` AND either
  `current_approver_emails cs.{caller_email}` (me scope) or
  `current_approver_emails neq.{}` (all scope); embeds
  `forms!inner(id,title)` + `form_versions!inner(id,schema)`. 500-row
  cap. Returns `{items, total, scope, caller_email, limit_hit}` with
  per-item `submission_id`/`form_id`/`form_title`/`workflow_stage`/
  `stage_label` (resolved off `schema.workflow.stages[*].label`)/
  `current_approver_emails`/`submitter_email`/`submitter_kind`/
  `submitted_at`/`location_code` (best-effort `extractLocationCode`
  schema walk)/`review_path`. Private `escapePgrstArrayLiteral()`
  defends against pathological emails inside the PostgREST array
  literal.
- `apps/forms-worker/src/cron/approval-digest.ts` — ~225 LOC daily
  digest. `runDailyApprovalDigest(env)` queries up to 5000
  pending rows in one shot, groups by approver email × form_id with
  per-bucket count + oldest_submitted_at, fires one POST per
  recipient to `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` with payload
  `{recipient_email, total_pending, by_form: [...], dashboard_url}`.
  `by_form` sorted by count desc with alphabetical tie-break.
  Dashboard URL hardcoded to production apps/web origin (matches
  Brief 97's `inferAdminBase` posture). Per-recipient timeout 15s,
  swallow non-2xx + throws (`[forms.approval-digest]` log line),
  cron always completes. When secret unbound the per-recipient
  branch logs `would-fire (no webhook bound)` and increments
  `recipientsSkippedNoUrl`. Returns a `DigestResult` with counters
  for observability (`recipientsConsidered`/`recipientsFired`/
  `recipientsSkippedNoUrl`/`recipientsFailed`/`rowsScanned`/`errors`).
- `apps/web/app/admin/approvals/page.tsx` — ~245 LOC server
  component. Reads `?scope=all` (admin-tier only — coerced to "me"
  for non-admins so the toggle UI stays honest). Calls
  `listPendingApprovalsAdmin({all})`. Groups items by form (forms
  with more items float; alphabetical tie-break). Renders per-row
  Stage pill (amber), submitter (italic "anonymous" when null),
  optional `@ location_code`, submitted-at relative time
  (just-now / N min / N hr / N d / date), "Review →" link to
  `/admin/forms/{form_id}/submissions/{submission_id}`. Admin-tier
  renders a "Mine / All Approvals" toggle. Empty-state copy varies
  by scope. Limit-hit amber banner when 500-row cap is tripped.
  Back-link to `/admin/dashboard/operations`.
- `PA_FLOWS_BRIEF_121.md` — PA flow build guide mirroring the
  Brief 101/102/105 pattern. Single PA flow handles the entire
  forms feature regardless of how many forms have workflows;
  adding a new workflow automatically participates. Documents the
  sample payload, the trigger schema, Send email construction
  (Office 365 V2), bind command, log-line expectations, empty-state
  behavior, and v2 candidates.

### Files modified

- `apps/forms-worker/src/index.ts` — `Env` widened with optional
  `FORMS_APPROVAL_DIGEST_WEBHOOK_URL`. Pending-approvals route
  mounted at the existing `/forms/admin/api/lookup-sources` block.
  `scheduled` handler rewritten to dispatch on `event.cron`:
  `"0 12 * * *"` runs `runDailyApprovalDigest`, anything else
  (including the existing `"0 11 * * *"` cleanup cron) falls
  through to `runDailyCleanup`. Imports added for the new module
  + handler. Header comment route table extended.
- `apps/forms-worker/wrangler.toml` — `[triggers] crons` widened
  to `["0 11 * * *", "0 12 * * *"]`. New optional secret
  `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` documented in the bindings
  comment block. Slot inventory documented in the triggers
  comment.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — new
  `listPendingApprovalsAdmin({all?})` helper + `PendingApprovalItem`
  + `PendingApprovalsResponse` types. Matches the existing service-
  binding-first + URL-fallback pattern.
- `apps/web/app/admin/dashboard/_lib/tiles.tsx` — new
  `pending-approvals` tile in the Operations group (`anySession`
  visibility). New inline `checkCircleIcon` SVG. Links to
  `/admin/approvals`.
- `CLAUDE.md` — `forms-worker` glossary entry gains a Brief 121
  paragraph documenting the endpoint, dashboard tile, daily cron +
  secret.
- `BRIEFS/INDEX.md` — Brief 121 row inserted above Brief 120.
- `BUILD_STATE.md` — Last-updated bumped + findings entry written +
  previous Brief 120 entry demoted to "(Previously: …".
- `BRIEFS/brief-121-forms-pending-approvals-dashboard-and-digest.md`
  — this Outcome section + Status set to Completed.

### Decisions made on operator's behalf

1. **`?scope=all` parameter at the apps/web URL level rather than the
   brief's raw `?all=1` flag.** `scope=me|all` is more self-describing
   for operator URL bookmarks. The worker endpoint still accepts the
   brief's literal `?all=1` shape internally, so the URL layer can be
   widened later without a worker contract change.
2. **`current_approver_emails neq.{}` is the all-scope filter** rather
   than ranging across approver emails. Empty-array exclusion is the
   right gate ("at least one approver assigned") AND matches the
   digest cron's predicate so the two surfaces stay coherent.
3. **Stage label resolution happens server-side in the worker** rather
   than client-side in apps/web. Keeps the apps/web list page from
   walking every row's schema, and the version-schema embed is
   already on the row from the existing FK join.
4. **Dashboard URL inside the digest payload hardcoded to
   `https://splashcarwashes.info/admin/approvals`.** Matches Brief
   97's `inferAdminBase` posture for the per-submission webhook —
   the cron runs on `splash-forms` which has no native concept of
   its own hostname. If a future operator wants to test the digest
   against staging, they can override via secret rotation.
5. **Tile placed in the Operations group**, not Admin. Most users
   with workflow access will eventually have an item; gating it more
   tightly would push the operator to manually scan multiple pages.
6. **`scheduled` handler dispatches on `event.cron` literal with a
   fallback to the cleanup pass.** Defensive: unrecognized crons fall
   through to the idempotent cleanup pass so the worker never
   silently no-ops a scheduled run.
7. **Count badge on the dashboard tile deferred to v2** per the brief's
   "Optional polish" — fetching the count for the dashboard render
   is a perf trade-off and the brief explicitly flags it as out of
   scope for v1.
8. **"Mark as viewed" / "Snooze for X days" out of scope** per Phase 5
   of the brief — would need a per-approver-per-submission
   `digest_dismissed_at` column.
9. **Helper `listPendingApprovalsAdmin` returns null on 401/403** so the
   apps/web page can short-circuit to `<NoAccessCard>` (matches the
   existing `listFormsAdmin` / `getFormAdmin` pattern).

### Latent issues / forward flags

- (a) Count badge on the dashboard tile deferred to v2 — performance
  trade-off requires an upstream fetch on dashboard render.
- (b) "Mark as viewed" / "Snooze for N days" deferred to v2 per
  Phase 5.
- (c) Per-event notifications ("you have a new approval right now")
  deferred to v2 — daily digest only at v1.
- (d) Stage-label resolution falls back to the raw stage id when a
  stage was renamed in a later version (only happens if the
  per-version schema is hand-edited via SQL — Brief 95's builder
  never produces a stage-id-without-label state).
- (e) The 500-row safety cap and 5000-row digest cap can be widened
  if approver populations grow; current caps cover the operator's
  stated team size with comfortable headroom.
- (f) GIN-index perf at scale — `current_approver_emails` arrays are
  typically 1-element (a single rm_email or site_email); only
  `static_emails` with multi-email lists grows the array. For 10K
  rows with arrays of 1-3 elements the GIN index is well-sized.
  Document for re-eval if the operator onboards forms with
  committee-style approver lists of 20+ emails.
- (g) Per-recipient digest POSTs run sequentially in the cron; for
  very large approver populations a future enhancement could
  parallelize, but at the expected population (tens of approvers,
  not thousands) serial is sufficient.

### Self-correction

Initial implementation of the relative-time helper used
`RELATIVE_TIME_THRESHOLDS[i].ms` array-element references and
triggered TS2532 under `noUncheckedIndexedAccess`. Refactored to
explicit `MIN_MS`/`HOUR_MS`/`DAY_MS`/`MONTH_MS` constants. Caught
by `pnpm typecheck` on the first run; fixed in place.

### Validation

- `pnpm typecheck` — 18/18 green. forms-worker + web ran fresh;
  other packages cached.
- `pnpm --filter @splash/web build` — succeeds.
  `/admin/approvals` 179 B / 105 kB First-Load JS. Other routes
  unchanged.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — succeeds. Bundle 1091.41 KiB
  raw / 209.31 KiB gzipped (≈ +10 KiB raw / +2 KiB gzip vs Brief
  120 baseline — all digest + pending-approvals + dispatcher
  widening). `.tmp-build` cleaned up after.
- No Supabase / R2 schema changes (Brief 120 owns the column
  adds).
- No deploy / branch / push performed.

### Operator post-deploy smoke (deferred per brief Phase 6.5)

1. As an RM with workflow access, navigate to `/admin/dashboard` →
   Operations → see the Pending Approvals tile.
2. Click → land on `/admin/approvals`. Empty-state copy if no
   pending items.
3. Have someone submit a test form with a workflow whose
   `site_role: rm_email` stage maps to the test RM. Refresh
   `/admin/approvals` → pending item visible with form group
   header + Review → button.
4. Click Review → land on Brief 96's detail page → Brief 120's
   transition modal works as expected.
5. As super_admin, click "All Approvals" toggle → URL becomes
   `/admin/approvals?scope=all` → see every pending approval
   across the org.
6. Manually trigger the 12:00 UTC cron via CF dashboard
   "Send test event" → either log lines per approver (secret
   unbound) or PA emails delivered (secret bound). Verify
   one POST per recipient in PA's run history.
7. Bind PA flow URL via `pnpm --filter @splash/forms-worker exec
   wrangler secret put FORMS_APPROVAL_DIGEST_WEBHOOK_URL`,
   re-run the cron test, confirm the PA email arrives with the
   expected `total_pending` + `by_form` + dashboard link.

### Report

- **Diff size estimate.** ~870 LOC total: worker
  pending-approvals handler (~170) + digest cron (~225) +
  index.ts/wrangler.toml edits (~50) + apps/web page (~245) +
  worker-fetch + tile edits (~50) + PA_FLOWS doc (~140).
- **Validation.** As above — 18/18 typecheck green; web build
  succeeds with `/admin/approvals` at 179 B / 105 kB First-Load
  JS; wrangler dry-run succeeds at 1091.41 KiB raw / 209.31 KiB
  gzipped.
- **GIN-index perf concern.** Typical approver-email lists are
  1-element (single rm_email or site_email per `site_role`
  stage); `static_emails` with multi-email committees grows the
  array but those are rare. At expected scale (low thousands of
  pending rows, single-digit average array length) the GIN index
  delivers indexed lookups in the low-millisecond range — flagged
  for re-eval if the operator onboards forms with 20+ -email
  approver lists.
- **CF Workers' scheduled-trigger quirks.** The single
  `scheduled` handler must dispatch on `event.cron` literal
  because CF fires it for every cron in the array. Done via a
  simple `if/else` branch with the cleanup pass as the fallback.
  Workers Logs's `[observability.logs]` block from Brief 89
  covers scheduled invocations automatically (`eventType:
  scheduled` in CF dashboard).
