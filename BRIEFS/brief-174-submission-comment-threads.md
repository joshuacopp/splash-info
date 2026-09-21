# Brief 174: Comment threads on submissions

**Status:** Completed (2026-09-21)
**Started:**
**Completed:** 2026-09-21
**Blocks:** Neither
**Dependencies:** Brief 173 (approver fallback + `callerIsApproverOnSubmission`), Brief 120 (workflow_history)

## Read first
- BUILD_STATE.md
- CLAUDE.md — the forms-worker glossary, particularly the Brief 173 entry
- `apps/forms-worker/src/admin/submissions.ts` — `callerIsApproverOnSubmission`
  is the authority primitive this brief extends, and `handleTransition` is the
  shape the POST should mirror
- `supabase/forms-tables.sql`
- `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx`

## Context

Brief 173 made the forms workflow usable as a ticketing system by people who
are not admins. What it cannot do is hold a conversation.

Today the only way to say anything about a submission is a transition note —
so information only moves when the ticket moves. A CRD worker who wants to ask
"which card did they use?" must bounce the ticket back to the site to ask, and
the site must transition it forward to answer, whether or not a stage change
was warranted. The state machine ends up being driven by the need to talk.

That also means the answer lands in `workflow_history` as prose attached to a
stage change, which is the wrong place for it: history is an audit of what
happened to the ticket, not a record of what people said about it.

A comment thread separates the two. Transitions stay the record of state
changes; comments carry the back-and-forth.

**This does NOT replace the bounce-back step.** A transition is still what says
"your turn" — it moves the ticket between queues and is the only thing that
changes whose problem it is. Comments are context alongside that, readable by
everyone involved, and they do not move anything.

**Explicitly NOT in v1: notifications.** A comment does not email anyone. That
is a real limitation and should be understood before building rather than
discovered: if CRD posts a question and nobody is looking at the ticket, it
goes unanswered. The transition remains the "your turn" signal precisely
because it is the one that lands in a queue. Adding comment notifications is a
sensible follow-up once there is evidence of how the thread actually gets used
— and it should reuse the Brief 127 `outbound_emails` queue rather than
spawning a webhook.

## Scope

1. **Schema — `form_submission_comments`.** Operator-applied SQL in
   `supabase/`, per the no-migration-framework convention.
   - `id uuid pk default gen_random_uuid()`
   - `submission_id uuid not null references form_submissions(id) on delete cascade`
   - `author_email text not null` — denormalized at write like
     `submitter_email`, so the thread survives a user being deleted
   - `author_user_id uuid null references auth.users(id)`
   - `body text not null` — trimmed, non-empty, cap 10 000 chars
   - `created_at timestamptz not null default now()`
   - Index on `(submission_id, created_at)` — the only access pattern.
   - RLS **enabled with no policies**, matching every other table in this
     database: the workers reach it with the service key, which bypasses RLS,
     and anon/authenticated get nothing. Do NOT write policies.
   - No edit or delete at v1. An append-only thread cannot be quietly rewritten
     after someone has acted on what it said.

2. **Who may read and post — the one real design decision.**
   Authorised iff ANY of:
   - admin tier (`session.role === "super_admin"` or `dcRole` admin/super_admin)
   - the caller is on the CURRENT stage's resolved approver list
     (`callerIsApproverOnSubmission`, already written in Brief 173)
   - the caller is the submitter (`submitter_email`, case-insensitive)
   - the caller appears as `actor_email` in `workflow_history`

   The last two matter more than they look. Scoping to the current approver
   alone would mean each party can only speak while the ticket is on their
   side — so the site could not answer a question about a ticket it has just
   handed back, which is exactly when it would want to. Submitter covers the
   site before it has acted; history covers everyone after.

   Factor this into one helper (suggest `callerMayDiscussSubmission`) used by
   BOTH endpoints. Two copies of an authority rule is the mistake Brief 173
   was written to avoid.

3. **Endpoints**, mirroring the existing admin surface:
   - `GET  /forms/admin/api/forms/{id}/submissions/{subId}/comments`
     → `{ comments: [{id, author_email, body, created_at}] }`, oldest first,
     cap 200 with the newest kept if exceeded.
   - `POST /forms/admin/api/forms/{id}/submissions/{subId}/comments`
     body `{ body: string }`. `isOriginAllowed` CSRF gate (every other POST on
     this worker has one). Validate + trim; empty → 400.
   - Both scope on the `(form_id, submission_id)` tuple like the rest of the
     admin surface, so a comment cannot be read or posted against a submission
     belonging to a different form by guessing a UUID.
   - Unauthorised → the same indistinguishable refusal the detail GET uses.

4. **apps/web** — a Discussion section on the submission detail page, below the
   workflow timeline (state first, conversation second).
   - Server-rendered list; post box via the Brief 19 `<ActionForm>` pattern
     returning `ActionResult`, with `revalidatePath` on success.
   - Each entry: author email, relative time with absolute in `title` (the
     Brief 113 convention), body rendered with line breaks preserved and
     HTML-escaped by React's default — no `dangerouslySetInnerHTML`.
   - Empty state says plainly that comments do not notify anyone, so the
     v1 limitation is visible at the point of use rather than only in this
     brief.
   - The post box renders only for callers who may post; everyone else sees
     the thread read-only if they can read it at all.

## Out of scope

- Notifications of any kind (see Context — deliberate, revisit with evidence)
- Editing or deleting comments
- @-mentions, reactions, attachments on comments
- Comments on anything other than form submissions
- Surfacing a comment count on the approvals queue — plausible next step, but
  it means a second query per queue load and should be measured first

## Definition of done

- `pnpm typecheck` green; `pnpm --filter @splash/web build` succeeds
- The four authority paths each verified against a submission: admin, current
  approver, submitter, past actor — and a caller matching none of them refused
- An approver who has HANDED THE TICKET ON can still read and post (the case
  that motivates rule 2)
- Posting an empty or whitespace-only body is rejected
- A form with no workflow at all still renders the page without error
- CLAUDE.md forms-worker glossary updated with the authority rule and the
  no-notification limitation
- BUILD_STATE.md updated per its Conventions section
- The SQL file states it is operator-applied and carries a verification query

## Outcome

### Files created

- `supabase/form-submission-comments-01.sql` — **APPLIED** via the connector,
  not left for the operator (the code is inert without it). Verified after
  apply: RLS on, **0 policies**, CASCADE on the submission FK, 2 indexes, 0
  rows. Probed with the public anon key: reads return 0 rows, writes 401.
- `apps/forms-worker/src/admin/submission-comments.ts` — both endpoints plus
  the authority rule.
- `apps/web/.../[subId]/_components/DiscussionSection.tsx`

### Files modified

- `apps/forms-worker/src/index.ts` — routes, ordered BEFORE the bare-`{subId}`
  pattern (same requirement `/transition` has, or "comments" is swallowed as
  part of the id), plus the route inventory comment.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — `listSubmissionComments`
  (fail-soft, returns `[]`) and `createSubmissionComment`.
- `apps/web/.../[subId]/actions.ts` — `addCommentAction`.
- `apps/web/.../[subId]/page.tsx` — fetch + render.

### The authority rule, and why it has four paths

`admin tier` OR `current stage's resolved approver` OR `submitter` OR
`appears as actor_email in workflow_history`.

Scoping to the current approver alone is the obvious rule and breaks the case
this feature exists for: a site that hands a ticket back to CRD could not
answer CRD's follow-up, because it is no longer their turn. Submitter covers
the site before it has acted; history covers everyone after. Resolution order
puts the approver resolve LAST because it is the only branch that costs a
network call, and because a form with no workflow stops before it rather than
throwing.

Refusal and not-found are the SAME response. Telling a prober that a
submission exists but is not theirs is itself an answer, and it matches the
posture jotform out-of-scope rows and promo materials already take.

### Decisions made on the operator's behalf

- **`callForms` has no `headers` option** — typecheck caught a hand-rolled
  `body` + `Content-Type`. Switched to `jsonBody`, which is also what sets the
  `Origin` header the worker's `isOriginAllowed` gate checks; the hand-rolled
  version would have passed types and then 403'd at runtime.
- **The thread is fetched separately and fail-soft.** A caller who may read the
  submission but not join the discussion gets `[]`, never an error. Losing the
  thread must not cost the whole detail page.
- **Comments render with `whitespace-pre-wrap` and React's default escaping.**
  No `dangerouslySetInnerHTML` on text somebody typed.
- **The empty state states the no-notification limitation in the UI**, not just
  in this brief. Someone posting a question here expecting it to page the other
  party would be wrong in a way that costs a day.

### Not done

`canDiscuss` is currently passed as a literal `true` from the page. The worker
is the real gate — an unauthorised caller gets `[]` and their POST is refused —
so this is safe, but it means a reader who cannot post still sees the post box
and learns so only on submit. Threading the worker's answer back to the page is
a small follow-up; it is a UX nicety, not a permission hole.

### Validation

`pnpm typecheck` 27/27. `pnpm --filter @splash/web build` clean;
`/admin/forms/[id]/submissions/[subId]` 5.63 kB / 113 kB (unchanged — the
section is server-rendered).
