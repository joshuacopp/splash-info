# Brief 66: RM can revert from `Approved — Pending Quotes` and `Pending RM Quote Approval` (send back to GM Review, RM Review, or Closed — Denied)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator confirmed 2026-05-07 (testing as RM dc_role
across cortland/cicero/leray/binghamton/oswego) that an RM
reviewing a GM-approved claim cannot send it back. Use case: GM
approved erroneously, RM catches it during quote-gathering, RM
needs to either (a) bounce it to GM Review, (b) bounce it to RM
Review, or (c) deny it outright. Today all three "send back"
buttons are greyed out with "Requires admin or higher".
**Dependencies:** Brief 21 (the show-disabled gating that surfaces
the "admin or higher" hint), Brief 20 (`clearApprovalDetails`
flag — required on every send-back to scrub stale approval
columns).

## Read first

- CLAUDE.md (Damage detail's transition gating note;
  `clearApprovalDetails` requirement on send-back transitions)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-020-staging-bug-batch.md (introduced
  `clearApprovalDetails`)
- BRIEFS/brief-021-dcrole-gating-cleanup.md (show-disabled
  pattern; the file `apps/web/app/admin/damage/_lib/transitions.ts`
  this brief patches in lockstep with the worker)
- BRIEFS/brief-061-sysadmin-set-dc-role-tool.md (dc_role write
  path — operator confirmed RM rows + dc_locations populating
  correctly post-Brief-64)
- apps/damage-worker/src/transitions.ts (`CLAIM_TRANSITIONS`
  ~L129 — single source of truth; the `tx({ ... role: "admin"
  ... })` rows this brief modifies)
- apps/web/app/admin/damage/_lib/transitions.ts (the apps/web
  mirror that carries human-readable `label` strings; must stay
  in lockstep with the worker)

## Context

Today's relevant transitions (worker `transitions.ts` ~L243-263):

```ts
// "Approved — Pending Quotes" → "Pending GM Review"      role: "admin"
// "Approved — Pending Quotes" → "Pending RM Review"      role: "admin"
// "Approved — Pending Quotes" → (no Closed — Denied)     missing
// "Pending RM Quote Approval" → "Pending GM Review"      role: "admin"
// "Pending RM Quote Approval" → "Pending RM Review"      missing
// "Pending RM Quote Approval" → "Closed — Denied"        role: "rm" (already RM-allowed; no change)
```

Operator's request:
- From `Approved — Pending Quotes`: RM can send back to GM
  Review, send back to RM Review, or close as denied. (3
  changes — 2 role widening + 1 new transition.)
- From `Pending RM Quote Approval`: RM can send back to GM
  Review or RM Review or deny. (2 changes — 1 role widening + 1
  new transition; deny path already exists.)

`Pending RM Review → Pending GM Review` (worker L168) already
has `role: "rm"` so that revert is fine. We're not touching it.

`Closed — Denied` is a terminal closed state; reopen path stays
admin-only (worker L332-344).

Beyond `Pending RM Quote Approval`, the post-approval chain
(Approved — In House — Parts Ordered → Repaired → Check Request
Submitted → Submitted for Payment → Check Issued) involves work
already in progress or finance touching the row. Those reverts
stay admin-only.

The `clearApprovalDetails: true` flag must be present on every
"revert to a pre-approval state" transition (Brief 20's pattern):
when a claim reverts from `Approved — Pending Quotes` to
`Pending GM Review`, the `approved_amount` /
`approved_quote_id` / `parts_ordered` / `vendor_name` columns
must be NULLed and the gm/rm/ceo audit stamps reset, otherwise
the detail page renders a stale "Approval Details" box.

## Scope

### Phase 1 — Worker transitions.ts: widen + add

1.1 In `apps/damage-worker/src/transitions.ts`:

  **Existing transitions to modify (4 of them):**

  - L243-249: `Approved — Pending Quotes → Pending GM Review`
    — change `role: "admin"` → `role: "rm"`. Keep
    `requiresNote: true` and `clearApprovalDetails: true`.
  - L250-256: `Approved — Pending Quotes → Pending RM Review`
    — same change.
  - L257-263: `Pending RM Quote Approval → Pending GM Review`
    — same change.
  - (No change to `Pending RM Quote Approval → Approved —
    Pending Quotes` at L264-270; that's a different revert
    direction — admin-only stays.)

  **New transitions to add (2 of them):**

  - `Approved — Pending Quotes → Closed — Denied`:
    ```ts
    tx({
      from: "Approved — Pending Quotes",
      to: "Closed — Denied",
      role: "rm",
      requiresNote: true,
      clearApprovalDetails: true
    }),
    ```
    Position: in the "From `Approved — Pending Quotes`" block
    (~L177-179), after the existing two forward transitions.
  - `Pending RM Quote Approval → Pending RM Review`:
    ```ts
    tx({
      from: "Pending RM Quote Approval",
      to: "Pending RM Review",
      role: "rm",
      requiresNote: true,
      clearApprovalDetails: true
    }),
    ```
    Position: in the "From `Pending RM Quote Approval`" block
    (~L181-191), after the existing forward + denied
    transitions.

1.2 Verify nothing else under "Admin escape hatches" needs
adjusting. The existing block (~L243-314) covers the
`role: "admin"` reverts; only the four entries listed in 1.1
shift to `role: "rm"`. The remaining admin-only reverts (Parts
Ordered → Pending GM Review, Submitted for Payment ↔ Check
Request Submitted, Check Issued → Check Request Submitted,
all the "Closed — Paid → reopen" rows, etc.) stay as-is —
those involve work-in-progress or finance and are correctly
admin-gated.

1.3 Add a Brief 66 note to the section docblock that
introduces "Admin escape hatches" (~L231-242) explaining that
the four `Approved — Pending Quotes` and `Pending RM Quote
Approval` reverts are RM-allowed (not just admin) per the
operator's 2026-05-07 decision: "GM erroneously approves, RM
needs to bounce it back without admin escalation."

### Phase 2 — apps/web transitions.ts: labels + role hints

2.1 In `apps/web/app/admin/damage/_lib/transitions.ts`,
locate the four matching entries (the file mirrors the worker's
list with `label` strings added):

  - `Approved — Pending Quotes → Pending GM Review` (~L305-310)
  - `Approved — Pending Quotes → Pending RM Review` (~L313-318)
  - `Pending RM Quote Approval → Pending GM Review` (~L321-326)
  - For each, change `role: "admin"` → `role: "rm"`.

2.2 Update the `label` strings on those three to drop the
"(admin)" suffix:
  - `"Send back to GM Review (admin)"` →
    `"Send back to GM Review"`
  - `"Send back to RM Review (admin)"` →
    `"Send back to RM Review"`

2.3 Add the two new entries (Closed — Denied + Pending RM Review
revert) with appropriate labels:

  ```ts
  {
    from: "Approved — Pending Quotes",
    to: "Closed — Denied",
    label: "Close — Denied",
    role: "rm",
    requiresNote: true,
    clearApprovalDetails: true
  },
  {
    from: "Pending RM Quote Approval",
    to: "Pending RM Review",
    label: "Send back to RM Review",
    role: "rm",
    requiresNote: true,
    clearApprovalDetails: true
  },
  ```

  Position consistently with the worker file's ordering so a
  side-by-side diff is easy to verify.

2.4 Don't touch the `"Send back to Pending Quotes (admin)"`
entry (Pending RM Quote Approval → Approved — Pending Quotes,
~L329-334) — that revert intentionally stays admin-only (it's
moving the claim FORWARD again past where the RM might want to
revert from).

2.5 Don't touch the role-hint copy generator anywhere else. The
existing pattern shows "Requires admin or higher" only when the
session.dcRole isn't in `allowedRoles`; for an rm now in the
allow-list, the button just renders enabled. No copy change
needed.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up afterward.
3.3 `pnpm --filter @splash/web build` — must succeed.
3.4 No schema changes. No new endpoints. No new env vars.
3.5 Confirm the worker's `CLAIM_TRANSITIONS` and apps/web's
   transition list stay structurally aligned post-edit (the
   executor reads both side-by-side and confirms every from/to
   pair has the same role + flags in both files).

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 66 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - RM can now revert from `Approved — Pending Quotes` (to
    GM Review / RM Review / Denied) and from `Pending RM Quote
    Approval` (to GM Review / RM Review). Operator's use case:
    GM approves erroneously, RM catches it during quote
    gathering, RM bounces or denies without escalating to
    admin.
  - 4 transitions changed from `role: "admin"` to `role: "rm"`;
    2 new RM-allowed transitions added.
  - Post-Brief-20 invariant preserved: every send-back path
    has `clearApprovalDetails: true` so reverted claims don't
    keep stale approval columns.
  - In-progress / finance-touched states (`Approved — In House
    *`, `Approved — Check Request Submitted`,
    `Submitted for Payment`, `Check Issued`, all `Closed —
    Paid` reopens) stay admin-only.
  - Operator follow-up: re-test the same RM user
    (4309ed6f-95f6-4927-b8e6-715d9aca5f95) on a claim in
    `Approved — Pending Quotes` and confirm the three buttons
    (Send back to GM Review, Send back to RM Review, Close —
    Denied) now render enabled.

4.3 CLAUDE.md updates:
  - Damage detail glossary entry: extend the show-disabled
    note with one line about the Brief 66 widening — RM can
    revert pre-quote-approval states without admin
    escalation; admin-only revert paths now begin at
    Parts Ordered.

## Out of scope

- Widening RM access on the post-approval chain
  (`Approved — In House *`, `Check Request Submitted`,
  `Submitted for Payment`, `Check Issued`). Work is in flight
  or finance has touched the row; revert at those points needs
  admin oversight. v2 if operator decides.
- Reopens from any `Closed —` state. Admin-only stays.
- New `Closed — Approved/No Response` revert paths for RM. The
  state is reached only after RM affirmatively closes; the RM
  shouldn't be both closing and reopening without admin sign-off.
- GM gaining revert access on Approved-family states. GM's role
  ends at "I approved this and routed forward"; rolling back
  belongs to RM or admin.
- Adding an audit-log entry that names the prior approval
  values for forensic reconstruction. The status_change activity
  row already records from/to + actor + notes; the
  `clearApprovalDetails` NULLs are recoverable from the
  Power Automate / SharePoint write history if anyone ever
  needs them.
- Changing the "Send back to Pending Quotes (admin)" path —
  that's a forward step (RM Quote Approval → back to Approved
  — Pending Quotes), not a revert; admin-only stays.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Worker `CLAIM_TRANSITIONS` has the 4 widened roles + 2 new
  RM transitions documented in Phase 1.1
- apps/web transitions.ts mirrors the worker exactly: roles
  match, labels updated to drop "(admin)" on the three
  send-back rows, two new entries added with appropriate labels
- Every send-back transition retains `requiresNote: true` and
  `clearApprovalDetails: true`
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 30-50 lines net: 4 role swaps + 4 label
  edits + 2 new transitions × 2 files + docblock notes)
- Confirmation that the worker file and apps/web file stay
  structurally aligned post-edit (same from/to pairs, same
  role values, same flags)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Status:** Completed (2026-05-07).

### Files modified

1. `apps/damage-worker/src/transitions.ts` (canonical state machine)
   - Three existing entries widened from `role: "admin"` →
     `role: "rm"`, all in the "Admin escape hatches" block:
     - `Approved — Pending Quotes → Pending GM Review`
     - `Approved — Pending Quotes → Pending RM Review`
     - `Pending RM Quote Approval → Pending GM Review`
   - Two NEW RM-allowed entries added:
     - `Approved — Pending Quotes → Closed — Denied`
       (positioned in the "From `Approved — Pending Quotes`"
       per-status block, after the existing two forward
       transitions, with a Brief 66 comment block above)
     - `Pending RM Quote Approval → Pending RM Review`
       (positioned in the "From `Pending RM Quote Approval`"
       per-status block, after the existing forward + Closed —
       Denied transitions, with a Brief 66 comment block above)
   - All five send-back paths carry `requiresNote: true` +
     `clearApprovalDetails: true` (Brief 20 invariant preserved).
   - "Admin escape hatches" docblock extended with a Brief 66
     note explaining that three of its rows are now RM-allowed
     per the operator's 2026-05-07 decision; remaining admin-only
     entries (Parts Ordered → Pending GM Review, Submitted for
     Payment ↔ Check Request Submitted / Pending RM Quote
     Approval, Check Issued → Check Request Submitted, plus
     `Pending RM Quote Approval → Approved — Pending Quotes`)
     stay admin-only.

2. `apps/web/app/admin/damage/_lib/transitions.ts` (UI mirror)
   - Same three role widenings, in the "Admin escape hatches"
     section.
   - Three labels lost their `(admin)` suffix:
     - `"Send back to GM Review (admin)"` →
       `"Send back to GM Review"` (×2: from
       `Approved — Pending Quotes` and from
       `Pending RM Quote Approval`)
     - `"Send back to RM Review (admin)"` →
       `"Send back to RM Review"` (from
       `Approved — Pending Quotes`)
   - Two NEW UI entries added with appropriate labels:
     - `"Close — Denied"` for
       `Approved — Pending Quotes → Closed — Denied`
     - `"Send back to RM Review"` for
       `Pending RM Quote Approval → Pending RM Review`
   - Both new UI entries land in the per-status forward blocks,
     mirroring the worker's positioning so a side-by-side diff is
     easy to verify.
   - Comment block above the "Admin escape hatches" section
     extended with a Brief 66 note matching the worker file.
   - `Pending RM Quote Approval → Approved — Pending Quotes`
     entry retains its `(admin)` label and `role: "admin"` per
     Phase 2.4 (forward step, not a revert).

3. `CLAUDE.md`
   - "Damage detail (`/admin/damage/[id]`) renders every
     valid-from-status transition…" bullet extended with a
     Brief 66 note: RMs can now revert pre-quote-approval states
     without admin escalation; admin-only revert paths now begin
     at `Approved — In House — Parts Ordered`.

4. `BUILD_STATE.md`
   - "Last updated" line bumped to 2026-05-07 with full Brief 66
     context (Brief 65 summary preserved as suffix).
   - New 2026-05-07 entry appended to the Findings & decisions
     log table summarizing the work, validation results, and
     operator follow-up.

5. `BRIEFS/INDEX.md`
   - Brief 66 row appended to the table.

6. `BRIEFS/brief-066-rm-revert-from-approved-pending-quotes.md`
   - Status: `Ready for Claude Code` → `Completed (2026-05-07)`.
   - Completed: `—` → `2026-05-07`.
   - This Outcome section filled in.

### Files created

None. Pure modification of existing files.

### Decisions made on the operator's behalf

1. **The three previously-admin transitions stayed in the
   "Admin escape hatches" block in both the worker file and the
   apps/web mirror** rather than relocating to the per-status
   forward blocks alongside the other transitions for those
   statuses. Reasoning: those entries share the same
   `clearApprovalDetails: true` posture as the other admin
   reverts in the block, and the block's docblock documents the
   invariant. Splitting the rows out would dilute that comment
   block. The block docblock now explicitly calls out that three
   rows are RM-allowed per Brief 66, with a cross-reference to
   the 2026-05-07 operator decision date, so a future reader
   sees the mixed-role nature of the block immediately.

2. **The two NEW transitions landed in the per-status forward
   blocks** (per the brief's positioning instructions in §1.1
   and §2.3). They aren't admin escape hatches by definition,
   and putting them next to the other forward transitions for
   those statuses keeps the per-status blocks complete.

3. **No other transitions were modified** beyond the five the
   brief specified. Verified the post-approval / finance-touched
   reverts and `Closed —` reopens still carry `role: "admin"`.

### Latent issues found

None.

### Side-by-side structural alignment confirmation

For every (from, to) pair touched by Brief 66, the worker file
and the apps/web mirror agree on (role, requiresNote,
clearApprovalDetails):

| from | to | role | requiresNote | clearApprovalDetails |
|---|---|---|---|---|
| Approved — Pending Quotes | Pending GM Review | rm | true | true |
| Approved — Pending Quotes | Pending RM Review | rm | true | true |
| Approved — Pending Quotes | Closed — Denied (NEW) | rm | true | true |
| Pending RM Quote Approval | Pending GM Review | rm | true | true |
| Pending RM Quote Approval | Pending RM Review (NEW) | rm | true | true |

The unchanged `Pending RM Quote Approval → Approved — Pending Quotes`
remains `role: "admin"` in both files.

### Validation results

- `pnpm typecheck`: **13/13 successful** (cache hit on 11,
  cache miss + clean compile on `@splash/damage-worker` and
  `@splash/web`). Total time 3.938s.
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build`: **bundle succeeded**.
  Total Upload: 1717.17 KiB / gzip 388.88 KiB (Brief 65
  baseline ~1715 KiB; +~2 KiB from added comment blocks + two
  new transitions — within budget). `.tmp-build` directory
  cleaned up post-run.
- `pnpm --filter @splash/web build`: **succeeded**. All 13
  routes compiled and statically generated:
  `/`, `/_not-found`, `/admin/damage`, `/admin/damage/[id]`,
  `/admin/damage/reporting`, `/admin/dashboard`,
  `/admin/performance`, `/admin/pricing`,
  `/admin/pricing/[location]`, `/admin/signups`,
  `/admin/signups/[location]`, `/admin/sysadmin`,
  `/change-password`, `/login`, `/logout`. Middleware: 34.1 kB.
- Diff size: ~50 lines net across the two transitions files
  (3 role swaps × 2 files + 2 new transition entries × 2 files
  with comment blocks + 3 label edits + docblock note expansions
  in worker and apps/web).

### Operator follow-up

- Push to trigger CF Workers Builds for damage-worker and
  apps/web.
- Re-test as the RM user
  (`4309ed6f-95f6-4927-b8e6-715d9aca5f95`) on a claim currently
  in `Approved — Pending Quotes`; confirm the three buttons
  (Send back to GM Review, Send back to RM Review, Close —
  Denied) render **enabled** instead of greyed out with
  "Requires admin or higher".
- On a claim currently in `Pending RM Quote Approval`, confirm
  Send back to GM Review and Send back to RM Review render
  enabled (Deny was already RM-allowed; Send back to Pending
  Quotes intentionally stays admin-only).
- After at least one revert, confirm the detail page's
  "Approval Details" box no longer renders for the reverted
  claim (Brief 20's `clearApprovalDetails` posture).
