# Brief 127: Outbound email queue + workflow email steps + Brief 125 outcome webhook migration

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — but unlocks the operator's vision of "one PA
flow handles all monorepo emails." All future forms-related email
routing (workflow assignment notifications, outcome notifications,
arbitrary form-step emails) flows through this queue. Existing
damage / fleet / workorders webhooks stay where they are at this
brief; the queue table is designed to accept their migration in a
future cleanup.
**Dependencies:** Brief 120 (workflow schema + transition handler).
Brief 121 (digest webhook fail-soft pattern). Brief 125 (workflow
builder + outcome notification webhook — this brief migrates
125's webhook to the queue).

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 120 / 121 / 125 entries
  + the new outbound_emails table doc this brief adds)
- BRIEFS/brief-120-forms-workflow-schema-and-transitions.md
  (workflow schema, transition handler — adds new `kind: "email"`
  stage support)
- BRIEFS/brief-125-forms-workflow-builder-ux-redesign.md
  (the workflow builder + `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`
  that this brief migrates to queue-based)
- BRIEFS/brief-121-forms-pending-approvals-dashboard-and-digest.md
  (digest webhook pattern — superseded for new fires, kept for the
  daily digest itself which is cron-driven not event-driven)
- apps/forms-worker/src/notifications.ts (Brief 125's helper —
  `fireOutcomeNotification` becomes `enqueueOutcomeEmail` here)
- apps/forms-worker/src/submit/index.ts +
  src/admin/submissions.ts (transition handler — adds the email
  step cascade)
- apps/web/app/admin/forms/[id]/_workflow/* (Brief 125's workflow
  tab — this brief adds the Email step card + Quick patterns
  button)
- packages/forms-schema/src/types.ts +
  validators/field-config.ts (schema additions: `kind: "email"`
  stage variant)
- supabase/forms-tables.sql (operator runs the new table SQL once)

## Context

Operator's architectural goal: a single Power Automate flow handles
every email the monorepo's forms feature needs to send (workflow
assignment notifications, outcome notifications, per-form
submission emails, future workflow email steps), and the
arrangement scales to other workers in the future without forcing
a per-worker PA flow per email purpose.

Two-part redesign in this brief:

**1. Move from webhook-fire-per-event to polling-from-queue.** A
new `outbound_emails` table stores fully-rendered emails (subject,
body, recipient, attachments). A single PA flow polls every 5
minutes via a claim/confirm protocol, sends the batch via the
Office 365 connector, marks them sent. Webhooks fan-out badly as
workers multiply; a queue table doesn't.

**2. Make email a first-class workflow step type.** Workflows already
have approval steps and outcomes. Adding an "email step" makes
workflows the universal email router: a "just email RM when
submitted" form becomes a one-step workflow with an email step. A
"RM approves, then notify GM, then close" workflow is approval +
email + outcome. One mental model, one builder UI, one queue.

This subsumes the per-form "email notifications" Settings tab
section that was originally considered — operators express that
use case as a one-step email workflow instead.

The Brief 125 outcome notification webhook
(`FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`) migrates from
webhook-fire to queue-enqueue as part of this brief, before any
PA flow has actually been wired to that secret. Same payload data,
different transport. Brief 125's notifications panel (the three
checkboxes for "Email approver on assignment / Email submitter on
outcome / Email approvers on outcome") is REMOVED — those use
cases now expressed as actual email steps in the workflow, with
sensible one-click templates exposed via the new Quick patterns
button.

## Scope

### Phase 1 — Supabase table + indexes

Operator runs once in the Supabase SQL editor. Add to
`supabase/forms-tables.sql` for reference (file is documentation;
operator's editor is authoritative).

```sql
CREATE TABLE outbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_worker text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  recipient text NOT NULL,
  cc text[] NOT NULL DEFAULT ARRAY[]::text[],
  reply_to text,
  subject text NOT NULL,
  body_html text,
  body_text text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_id uuid,
  sent_at timestamptz,
  send_attempts int NOT NULL DEFAULT 0,
  last_error text
);

-- Idempotent enqueue: re-firing the same (source_worker, source_kind,
-- source_id, recipient) tuple is a no-op via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX outbound_emails_dedup_idx
  ON outbound_emails (source_worker, source_kind, source_id, recipient);

-- Partial index over the eligible-for-send pool. Pending rows whose
-- scheduled_for has passed AND aren't currently claimed (or claim is
-- stale > 10 min).
CREATE INDEX outbound_emails_pending_idx
  ON outbound_emails (scheduled_for)
  WHERE sent_at IS NULL;

-- For the admin viewer (Brief 128 deferred) — narrow source filter.
CREATE INDEX outbound_emails_source_idx
  ON outbound_emails (source_worker, source_kind, created_at DESC);
```

Service-key access only. No RLS policies for end users — admin
viewer (Brief 128) will use the service-key endpoint.

### Phase 2 — Shared enqueue helper

New module `packages/db-supabase/src/outbound-emails.ts` exporting
a single `enqueueOutboundEmail(env, payload)` function. Workers
call this to add a row to the queue.

```ts
export interface OutboundEmailPayload {
  source_worker: string;          // e.g. "forms"
  source_kind: string;            // e.g. "workflow-email-step"
  source_id: string;              // submission id
  recipient: string;              // one row per recipient
  cc?: string[];
  reply_to?: string;
  subject: string;                // already rendered
  body_html?: string;             // already rendered
  body_text?: string;             // already rendered
  attachments?: OutboundEmailAttachment[];
  scheduled_for?: string;         // ISO 8601, defaults to now()
}

export interface OutboundEmailAttachment {
  filename: string;
  /** Either r2_key (worker fetches at send-prep time) or
   *  base64 (already inlined). r2_key is preferred — keeps queue
   *  rows small. */
  r2_key?: string;
  base64?: string;
  mime: string;
  size_bytes: number;
}

export async function enqueueOutboundEmail(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  payload: OutboundEmailPayload
): Promise<{ id: string; was_duplicate: boolean }>;
```

Implementation: PostgREST INSERT with
`Prefer: resolution=ignore-duplicates,return=representation` so the
unique dedup index treats re-enqueue as a no-op (returns the
existing row's id with `was_duplicate: true`).

Recipient + subject + body are pre-rendered by the caller — the
helper does not interpret templates. Recipient is a single email;
multi-recipient sends are multiple calls (one per recipient).

Service-key required. Workers that don't bind `SUPABASE_SERVICE_KEY`
can't enqueue.

### Phase 3 — Queue claim/confirm endpoints on splash-forms

Two new endpoints under `/forms/internal/api/email-queue/*`. Auth
is shared-secret via `X-Email-Queue-Token` HTTP header (new optional
secret `FORMS_EMAIL_QUEUE_TOKEN`); PA flow stores the token in its
connection config and includes it on every call.

When the secret is unbound, both endpoints return 503. This makes
the queue idle but doesn't break worker enqueueing — rows still pile
up safely, PA flow starts draining once bound.

**3a. `POST /forms/internal/api/email-queue/claim?limit=50`**

Request: optional `limit` query param (default 50, max 200).

Logic:
1. Generate `claim_id = uuid4()`.
2. SQL (one UPDATE returning the rows):
   ```sql
   UPDATE outbound_emails SET
     claimed_at = now(),
     claim_id = $claim_id
   WHERE id IN (
     SELECT id FROM outbound_emails
     WHERE sent_at IS NULL
       AND scheduled_for <= now()
       AND send_attempts < 5
       AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')
     ORDER BY scheduled_for
     LIMIT $limit
     FOR UPDATE SKIP LOCKED
   )
   RETURNING id, source_worker, source_kind, source_id, recipient,
             cc, reply_to, subject, body_html, body_text, attachments;
   ```
   `FOR UPDATE SKIP LOCKED` allows multiple PA runs (e.g., if
   you ever run two flows in parallel) to claim disjoint rows
   without blocking.
3. For each claimed row, if any attachment has an `r2_key`, fetch
   it from the appropriate R2 bucket (forms uses `FORMS_FILES`),
   base64-encode, replace the `r2_key` field with `base64`. This
   makes the response self-contained so PA doesn't need R2 access.
   Skip if attachment already has `base64`. Per-attachment 5MB cap;
   skip + log the attachment on overflow (worker continues to send
   the email without the attachment rather than fail the row).
4. Return `{claim_id, items: [...]}`.

Cloudflare Worker `fetch()` against Supabase PostgREST for the
UPDATE-returning. PostgREST doesn't directly expose `FOR UPDATE
SKIP LOCKED`; use the Postgres function pattern (declare a SQL
function `claim_outbound_emails(p_claim_id uuid, p_limit int)` in
Supabase, call via PostgREST `POST /rest/v1/rpc/claim_outbound_emails`).
Add the function SQL to the Phase 1 migration block.

**3b. `POST /forms/internal/api/email-queue/confirm`**

Request body:
```json
{
  "claim_id": "...",
  "results": [
    { "id": "uuid", "status": "sent" },
    { "id": "uuid", "status": "failed", "error": "Office 365 returned 502" }
  ]
}
```

Logic:
1. Verify `claim_id` matches at least one row's `claim_id` (rejects
   replay / spoofed confirms).
2. For each result:
   - `status === "sent"`: UPDATE row WHERE id = $id AND claim_id =
     $claim_id SET sent_at = now(), last_error = NULL.
   - `status === "failed"`: UPDATE row WHERE id = $id AND claim_id
     = $claim_id SET claimed_at = NULL, claim_id = NULL,
     send_attempts = send_attempts + 1, last_error = $error.
3. Returns `{ confirmed_sent: N, confirmed_failed: M, skipped: K }`.

`send_attempts >= 5` rows naturally drop out of the claim query's
eligible pool (Phase 3a step 2's `send_attempts < 5` filter) — no
separate "stuck" state needed at v1; admin viewer (Brief 128) sees
them by querying without the attempts filter.

**3c. Module location.** `apps/forms-worker/src/email-queue/`
folder: `claim.ts`, `confirm.ts`, `attachments.ts` (helper to
fetch + base64 R2 attachments). Routes wired into `index.ts`.

### Phase 4 — Workflow schema: email step variant

Extend `packages/forms-schema/src/types.ts` to add `kind` to
`WorkflowStage` with two variants currently in active use:

```ts
type WorkflowStage =
  | ApprovalStage
  | EmailStage
  | OutcomeStage;

interface ApprovalStage {
  id: string;
  label: string;
  kind: "approval";  // optional; predicate fallback maintained
  approver_source: ApproverSource;
  transitions: WorkflowTransition[];
}

interface EmailStage {
  id: string;
  label: string;
  kind: "email";
  recipients: ApproverSource[];   // one OR multiple; same picker shape
  subject_template: string;
  body_template: string;
  /** Email steps auto-advance after enqueue. Single transition
   *  (the "Then go to" dropdown), no Approve/Deny branching. */
  transitions: [WorkflowTransition];  // exactly one
}

interface OutcomeStage {
  id: string;
  label: string;
  kind: "outcome";
  transitions: [];  // empty
}
```

Existing stages without `kind` continue to be classified via the
Brief 123 predicate (`approver_source` present + transitions non-
empty → approval; empty transitions + no approver → outcome).
Email is the NEW kind — predicate fallback returns "approval" for
ambiguous cases, so any existing workflow's stages classify the
same way they did before.

Zod validator updates in `validators/field-config.ts`:
- Strict (publish) validator accepts the new shape, refuses to
  publish an email stage whose `recipients` list is empty OR whose
  `transitions` length is not exactly 1.
- Subject and body templates accepted as raw strings — no template
  validation at publish (operator can use any placeholder syntax;
  invalid placeholders render literally at enqueue, which is
  visible / debuggable).

### Phase 5 — Workflow builder UI: email step card + Quick patterns

Update `apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx`
(introduced by Brief 125).

**5a. "+ Add step" choice menu.** The existing "+ Add approval
step" dashed button gains a choice popover on click. Two options:

```
+ Add step
├─ Approval step  (someone reviews and approves/denies)
└─ Email step     (send an email and move on)
```

Each option creates a new stage with the appropriate `kind`. Email
step defaults: label `"Email"`, single empty recipient, default
subject template `"New {form.title} submission"`, default body
template (see Phase 5c).

**5b. Email step card.** Similar shape to the approval step card,
different fields:

```
┌──────────────────────────────────────────────────────────────┐
│ ⋮⋮  Step 2  [Email] Email submitter      Duplicate  Remove  │
├──────────────────────────────────────────────────────────────┤
│ To                                                           │
│ [ Submitter email (from the form's submitter session) ▼ ]    │
│                                                              │
│ Subject                                                      │
│ [ Your submission was approved                          ]    │
│                                                              │
│ Body                                                         │
│ [ Hi {submitter.name},                                 ]      │
│ [                                                      ]      │
│ [ Your {form.title} submission was approved at         ]      │
│ [ {outcome.reached_at}.                                ]      │
│ [                                                      ]      │
│ [ — Splash team                                        ]      │
│                                                              │
│ Then go to                                                   │
│ [ Outcome: Approved ▼ ]                                      │
└──────────────────────────────────────────────────────────────┘
```

Recipient picker reuses the Brief 125 approver picker component
(same auto-detection from form fields, same `auth_unified`
autosuggest), just rebranded "To" instead of "Who approves?". The
Brief 125 `recipients` field accepts an array — operators add
multiple via "+ Add another recipient" if needed.

Subject + body inputs are plain text + textarea with a small inline
help link "Use placeholders like `{field.label}` or `{field.key}`"
that expands a list of every available placeholder for THIS form
(every field's label + key, plus a small set of built-ins:
`{submitter.email}`, `{submitter.name}` (when available),
`{form.title}`, `{form.url}`, `{outcome.reached_at}` (only resolves
in outcome-context email steps), `{outcome.label}`).

Email step is visually distinguished from approval step: amber-toned
header badge (vs. blue for approval). Both share drag handle /
numbered badge / Duplicate / Remove controls.

**5c. Default body template** (auto-populated for new email steps,
operator can rewrite):

```
Hi,

A new {form.title} submission was received.

{payload.summary}

Open in Splash: {submission.url}

— Splash team
```

`{payload.summary}` is a built-in placeholder that renders as a
multi-line `key: value` list of every field on the form. Operators
can replace with explicit `{field.label}` references for selective
fields.

**5d. Quick patterns button.** Below the step stack, alongside
"+ Add step", a smaller button labeled "Quick patterns…" opens a
popover with one-click templates:

- **Email submitter on outcome** — adds an email step right before
  each outcome (Approved / Denied / etc.). Default recipient =
  `{submitter.email}`, subject = `"Your {form.title} submission
  was {outcome.label}"`, body = sensible default.
- **Email approver when assigned** — adds an email step right
  before each approval step. Recipient = the approval step's
  approver source (same shape, evaluated at enqueue time). Subject
  = `"You have a new {form.title} item to review"`, body links to
  the per-submission review page.
- **Email RM on submission** — adds a single email step right
  after Form Submitted, recipient = first detected `rm_email`-like
  lookup field, subject + body sensible.
- **Email a specific person on submission** — adds an email step
  with empty recipient (operator picks), template stub.

Clicking a pattern inserts the email step(s) into the workflow at
the appropriate position, marks the form dirty, lets the operator
edit / accept / discard before publish. Patterns are pure UI sugar
— they produce normal email-step schema entries, nothing special
in the data layer.

**5e. Flow preview update.** Mermaid renderer (Brief 125 / 123)
adds a third node class `:::emailstep` (amber-toned) alongside
`:::step` (approval, blue) and `:::outcome` (varied tint). Edge
labels remain "Approve" / "Deny" for approval steps; email steps
get a single unlabeled edge to their destination (email steps
auto-advance, no action label needed).

### Phase 6 — Worker auto-advance through email steps

Update the worker's transition + submit code paths so that when a
submission's `workflow_stage` lands on an email-kind stage, the
worker:

1. Renders the subject + body templates against the submission's
   payload + a small `runtime_context` map containing:
   - `submitter.email` — from `form_submissions.submitter_email`
   - `submitter.name` — from `submitter_email` userId lookup (best-
     effort via `auth_unified` view; falls back to email's
     local-part if no name)
   - `form.title` — from the form row
   - `form.url` — `https://splashcarwashes.info/forms/{slug}`
   - `submission.url` — `https://splashcarwashes.info/admin/forms/{form_id}/submissions/{submission_id}`
   - `outcome.label`, `outcome.reached_at` — only when the
     transition INTO the email step came from a non-outcome stage
     AND the email step's `transitions[0].to` IS an outcome. (Means
     "this is an outcome-paired email step"; otherwise these resolve
     empty.)
   - `payload.summary` — multi-line key:value rendering of every
     field with a non-empty value.
2. Resolves the `recipients` list (the array on the email stage)
   via the same `resolveApproverEmails` helper, treating each
   element as one resolution call and merging the results
   (deduped, lowercased).
3. For each resolved recipient, calls `enqueueOutboundEmail` with:
   - `source_worker: "forms"`
   - `source_kind: "workflow-email-step"`
   - `source_id: "{submission_id}:{stage_id}"` (compound for
     uniqueness — same stage shouldn't fire twice for the same
     submission)
   - `recipient`, `subject`, `body_text` (Phase 7 layout
     considers html-vs-text)
4. Stamps a `workflow_history` entry: `{from, to: stage.id,
   actor_kind: "system", at: now(), kind: "email", recipients:
   [...], enqueued_email_ids: [...]}` — captures the audit trail
   so the per-submission detail page renders "Email step fired
   to X, Y at HH:MM".
5. Updates `workflow_stage` to `stage.transitions[0].to`.
6. Recomputes `current_approver_emails` for the new stage (same
   logic Brief 120 had — empty for outcome/email, resolved for
   approval).
7. **Recurses if the new stage is also an email step.** Cap depth
   at 10 to prevent infinite-loop bugs (operator built a workflow
   with email-step cycles — strict validator should reject this
   at publish; depth cap is defense-in-depth).

This cascade runs both:
- At submit time, after the workflow seed (so a form whose default
  stage is an email step fires the email + advances immediately).
- At transition time, after a transition lands on an email step
  (so an approval → email → outcome chain advances all the way to
  the outcome in one POST).

The cascade is wrapped in `ctx.waitUntil` style — the enqueue
calls are awaited inside the transition (so the workflow_history
entry has the email_ids), but if enqueue throws, the transition
proceeds anyway (fail-soft, log
`[forms.workflow.email-step] enqueue failed for stage {id}`).

### Phase 7 — Migrate Brief 125 outcome notification webhook to queue

Brief 125 wired `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` —
unused at the moment (no PA flow built behind it). This brief
removes the webhook fire entirely and replaces with queue
enqueue. The Brief 125 `notifications` block stays in the schema
for back-compat but its booleans don't fire webhooks any more.
The block is documented as deprecated; future readers see in
`packages/forms-schema/src/types.ts` that operators should use
explicit email steps instead.

The `fireOutcomeNotification` and `fireAssignmentNotification`
helpers in `apps/forms-worker/src/notifications.ts` become
no-ops at this brief (with a log line
`[forms.notify.{kind}] deprecated webhook path; use workflow
email steps`). They're not deleted at this brief because Brief
125's transition handler still calls them — those call sites
get removed in this brief, but the functions stay as documented
no-ops for one cycle in case any operator config references the
old webhook URL secret.

`FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` secret is documented
as obsolete in BUILD_STATE.md. Operator can unbind it at their
convenience.

### Phase 8 — PA flow build doc

New file
`C:\Users\Coppsrv\Documents\splash-info\PA_FLOWS_BRIEF_127.md`
documents the polling pattern. Sections:

- **Connection setup** — Office 365 Outlook connector + the
  `X-Email-Queue-Token` shared secret stored in PA's connection
  config.
- **Trigger** — Recurrence, every 5 minutes.
- **Action 1: Claim batch.** HTTP — POST to
  `https://staging.splashcarwashes.info/forms/internal/api/email-queue/claim?limit=50`,
  header `X-Email-Queue-Token: {{token}}`. Parse JSON response,
  capture `claim_id` and `items[]`.
- **Action 2: Loop over items.** For each:
  - Office 365 — Send an email. To: `item.recipient`. From:
    {default mailbox}. Reply-To: `item.reply_to` (when present).
    CC: `item.cc` (when non-empty). Subject: `item.subject`.
    Body: `item.body_html` (or `item.body_text` as fallback).
    Attachments: `item.attachments[]` (PA's connector accepts
    base64).
  - Compose result `{id: item.id, status: "sent"}` (or "failed"
    + error string on connector failure).
- **Action 3: Confirm batch.** HTTP — POST to
  `https://staging.splashcarwashes.info/forms/internal/api/email-queue/confirm`,
  body `{claim_id, results: [...]}`, same auth header.
- **Production flip** — when ready, point at production hostname.
- **Failure modes** — claim endpoint returns 503 (secret unbound,
  worker down): PA flow logs and exits cleanly, next 5-minute
  tick retries. Confirm endpoint failure: rows stay stuck-claimed;
  10-minute stale-claim recovery (Phase 3a step 2 query) reclaims
  them on the next tick.

This is the operator's work item, not Claude Code's — the doc is
the deliverable from this brief, not a built PA flow.

### Phase 9 — Validation

9.1 `pnpm typecheck` — must pass.
9.2 `pnpm --filter @splash/web build` — must succeed.
9.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
9.4 New table SQL provided for operator (Phase 1 block) — operator
    runs ONCE in Supabase SQL editor + adds the SQL function for
    the FOR UPDATE SKIP LOCKED claim.
9.5 New secret bind (deferred operator step):
    `pnpm --filter @splash/forms-worker exec wrangler secret put
    FORMS_EMAIL_QUEUE_TOKEN` once PA flow is built and the token
    is generated.
9.6 Operator post-deploy smoke (deferred):
    - Open a form in the builder. Workflow tab. Click "+ Add step"
      → choice menu → Email step. Email step card renders with
      recipient picker + subject + body + then-go-to.
    - Build a one-step workflow: Form Submitted → Email step →
      Outcome "Done". Publish.
    - Submit the form. Open Supabase — `outbound_emails` has one
      row with status pending, recipient set, subject + body
      rendered correctly.
    - Wait 5 minutes (or manually POST to the claim endpoint with
      the token to simulate). Row gets claimed, then confirmed
      sent. `sent_at` populated.
    - Build a more complex workflow: Form Submitted → Approval
      step → Email step (notify GM) → Outcome. Submit. Approve.
      Approve transition cascades through the email step
      (enqueues GM email) and lands on the outcome. `workflow_history`
      shows three entries: approve, email-step-fired, outcome.
    - Click "Quick patterns…" → "Email submitter on outcome".
      Pattern inserts an email step before each outcome with
      `{submitter.email}` as recipient. Operator accepts. Publish.
      New submission, approve → email fires to submitter.

### Phase 10 — Updates

10.1 BRIEFS/INDEX.md: Brief 127 row appended.

10.2 BUILD_STATE.md: Findings entry noting:
  - Brief 127 (YYYY-MM-DD) — outbound email queue: shared
    `outbound_emails` table + polling claim/confirm endpoints
    on splash-forms + `FORMS_EMAIL_QUEUE_TOKEN` shared-secret
    auth. Workflow gains email-step type (`kind: "email"`).
    Brief 125 outcome notification webhook migrated to queue
    enqueue. Notifications panel checkboxes removed from
    Workflow tab — replaced by explicit email steps + Quick
    patterns button.
  - Schema additions: `kind: "approval" | "email" | "outcome"`
    on stages; email stages carry `recipients` /
    `subject_template` / `body_template` + single auto-advance
    `transitions[0]`.
  - PA flow build doc: PA_FLOWS_BRIEF_127.md.

10.3 CLAUDE.md `forms-worker` glossary: extend the Brief 125
paragraph with a Brief 127 follow-up sentence documenting the
outbound queue infrastructure + email-step support + the
deprecation of `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`.

10.4 Add new top-level CLAUDE.md glossary entry **outbound_emails
table** documenting the schema, dedup index, claim function,
who's allowed to write (any worker with SUPABASE_SERVICE_KEY),
and the polling contract.

## Out of scope

- Migrating damage-worker (Brief 32 / 101 / 102), fleet-worker
  (Brief 105), workorders-worker, signup-worker, jotform-worker
  emails to the queue. Per operator: not reworking past ones.
  Their existing per-purpose PA flows continue to work.
- Approval digest (Brief 121). Daily cron, per-recipient single
  POST — already efficient; migrating adds no value at v1.
- Admin email-queue viewer (Brief 128 — drafted separately,
  queued after this brief).
- PDF attachment generation for outcome emails (separate brief —
  candidate Brief 129).
- SMS, push notifications, in-app notifications, or any
  non-email channel.
- Rich HTML email composition beyond placeholder substitution
  (no markdown rendering, no conditional sections). Operators
  can use plain HTML in body_template if they want — escape
  responsibility is the operator's.
- Per-workflow rate limiting (e.g., "don't email this approver
  more than once per hour"). Not needed at v1's volume.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `outbound_emails` table SQL provided in the brief; operator-run
  in Supabase confirms it lands (deferred verification).
- `enqueueOutboundEmail` helper exported from
  `@splash/db-supabase/outbound-emails`.
- `claim_outbound_emails(p_claim_id, p_limit)` SQL function exists
  in Supabase + accessible via PostgREST RPC.
- `POST /forms/internal/api/email-queue/claim` returns claimable
  rows with R2 attachments inlined as base64.
- `POST /forms/internal/api/email-queue/confirm` updates rows
  (sent_at or send_attempts + last_error).
- Workflow schema accepts `kind: "approval" | "email" | "outcome"`;
  validators accept the email shape.
- Workflow builder's "+ Add step" choice menu + email step card +
  Quick patterns button all render and function.
- Worker auto-advances through email steps at both submit time
  and transition time; cascade depth capped at 10.
- Brief 125's outcome notification webhook fires removed; helpers
  become documented no-ops.
- `FORMS_EMAIL_QUEUE_TOKEN` is read by the worker; both endpoints
  503 when unbound.
- PA_FLOWS_BRIEF_127.md exists.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 10.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- The SQL function for `claim_outbound_emails` — whether
  PostgREST RPC handled the FOR UPDATE SKIP LOCKED pattern
  cleanly, or whether a different approach was needed.
- R2 attachment inlining cost (per-claim batch size impact on
  response payload). If 50 attachments × 5MB = 250MB per claim
  call, that's a problem; recommendation if so.
- Any subtle cases in the cascade where workflow_history
  double-stamps or skips an entry.
- Any approver_source resolution differences between the email
  step's `recipients` and the approval step's `approver_source`
  (should be identical — both call `resolveApproverEmails`).

## Outcome

### Diff size estimate

- 7 new files: `packages/db-supabase/src/outbound-emails.ts` (~135 LOC);
  `apps/forms-worker/src/email-queue/{claim,confirm,attachments}.ts`
  (~155 + ~170 + ~130 LOC); `apps/forms-worker/src/workflow-email-step.ts`
  (~370 LOC); `apps/web/app/admin/forms/[id]/_workflow/{AddStepPopover,
  EmailStepCard,QuickPatternsPopover}.tsx` (~80 + ~290 + ~100 LOC);
  `PA_FLOWS_BRIEF_127.md` (~270 LOC).
- 1 file deleted: `apps/web/app/admin/forms/[id]/_workflow/NotificationsPanel.tsx`.
- 13 files modified: SQL (`supabase/forms-tables.sql`), schema package
  (`packages/db-supabase/src/index.ts`, `packages/forms-schema/src/
  types.ts`, `packages/forms-schema/src/validators/field-config.ts`),
  forms-worker (`apps/forms-worker/src/{index,notifications,submit/index,
  admin/submissions}.ts`, `apps/forms-worker/wrangler.toml`), apps/web
  (`apps/web/app/admin/forms/[id]/_builder/{reducer,BuilderClient}.tsx`,
  `apps/web/app/admin/forms/[id]/_workflow/{WorkflowTab,
  WorkflowFlowPreview}.tsx`).
- 3 documentation files updated: `CLAUDE.md` (forms-worker glossary
  Brief 127 paragraph + new `outbound_emails table` glossary entry),
  `BUILD_STATE.md` (Findings entry + Last updated bumped),
  `BRIEFS/INDEX.md` (Brief 127 row inserted above Brief 119).

### Validation results

- Root `pnpm typecheck`: **18/18 green** (no cache hits — all packages
  reran due to the type changes + new modules).
- `pnpm --filter @splash/web build`: **succeeded**. New route bundle
  metrics: `/admin/forms/[id]` 36.5 kB / 144 kB First-Load JS (+2 kB
  vs Brief 125 baseline of 34.5 kB, all the email-step UI). Mermaid
  remains code-split into its own chunk; First Load unchanged for
  other routes.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`: **succeeded**. Bundle 1127.87 KiB raw /
  216.90 KiB gzipped (≈ +24 KiB raw / +5 KiB gzip vs Brief 125
  baseline of 1103.92 / 211.76). `.tmp-build` removed.

### `claim_outbound_emails` SQL function — PostgREST RPC fit

Clean. PostgREST's `POST /rest/v1/rpc/{name}` accepts the function's
named parameters as JSON body keys (`{p_claim_id, p_limit}`) and
returns the `RETURNS TABLE` row set directly. The
`FOR UPDATE OF inner_oe SKIP LOCKED` is inside the function body, so
PostgREST never sees it — no `Prefer` header gymnastics needed. The
function is `LANGUAGE plpgsql` (PL/pgSQL) because the UPDATE…FROM…SELECT
pattern doesn't fit cleanly in a plain SQL function returning a table.
Future-friendly: parallel PA runs (if the operator ever runs two
flows in parallel) claim disjoint rows automatically because the
SKIP LOCKED clause skips rows another transaction has already locked.

### R2 attachment inlining — payload-size cost

Per-attachment cap is 5 MB raw (a base64 string of ~6.67 MB).
Theoretical worst case at `limit=200`: 200 × 6.67 MB = ~1.3 GB of
response body — but Cloudflare Workers `fetch()` response body has a
hard cap (~100 MB for free-tier, larger for paid), so a real-world
batch that fat would hit infrastructure ceilings well before PA. The
expected steady-state is `limit=50`, typically with 0–1 attachments
per row at ~12 KB (signature PNG) — total response body ~30–50 KB per
poll. Recommendation: keep `limit=50` for the PA flow and only raise
if the queue grows persistently. If a future workflow ships
attachments-heavy emails (PDF receipts, photo bundles), revisit the
per-attachment cap or split attachments into a separate "fetch on
send" PA action. Documented in the brief's PA flow guide.

### `workflow_history` double-stamping at cascade boundaries

None observed. The cascade appends one history entry per email step
it walks through (`actor_email: "system@forms"`, `note` describing
the recipient list). For a transition that LANDS on an email step,
the caller pushes the operator's transition entry first
(`{from: prevStage, to: emailStageId, actor_email: session.email}`)
and then the cascade walks from emailStageId forward; the cascade's
entries have `from = emailStageId` (the step the cascade entered the
loop on) and `to = transitions[0].to`. Net result: one operator entry
+ N email-step entries per transition. For a submit-time cascade
where the default stage IS an email step, only cascade entries are
appended (`from = stage.id` for the first hop because there's no
prior stage). No accidental duplication.

### Approver-source resolution: email recipients vs approval `approver_source`

Identical, by design. Both call `resolveApproverEmails(env, source,
{schema, payload})` — the same Brief 120 helper. The only semantic
difference is at the cascade layer:
`resolveEmailRecipients(env, schema, payload, stage)` iterates over
the email stage's `recipients` array, calling `resolveApproverEmails`
once per entry, and unions the results. For an email step with one
recipient source, behavior is byte-for-byte identical to an approval
step's approver resolve. The one synthetic case is
`payload_field: "submitter.email"` (introduced by the Quick patterns
"Email submitter on outcome" template): the cascade's
`normaliseSubmitterEmailSource` helper translates this into a
`static_emails` source backed by the runtime `submitterEmail` (passed
via the `__submitter_email__` synthetic payload key). This keeps the
`ApproverSource` discriminator clean without adding a 4th type.

### Decisions made on operator's behalf

(See BUILD_STATE.md's full decisions list — 10 decisions documented
there. Highlights below.)

1. **`outbound_emails` worker ownership**: the table is "owned by"
   `splash-forms` (forms-worker exposes the claim/confirm endpoints +
   has existing PA-flow infrastructure), but the
   `enqueueOutboundEmail` helper lives in `@splash/db-supabase` so
   ANY worker can enqueue. Future migrations of damage / fleet /
   workorders / signup / jotform email fires are an `import` away.
2. **`kind` enum widened, not replaced**: existing published forms
   carry `kind: "step"` from Brief 125's seeds. Brief 127 widens to
   `"step" | "approval" | "email" | "outcome"` instead of switching
   wholesale to `"approval" | "email" | "outcome"` — back-compat
   matters more than enum tidiness. New seeds write `"approval"`.
3. **`recipients` is an array of `ApproverSource`** (not single): one
   queue row per recipient is the natural mapping to PA's Office 365
   "Send an email" connector which handles one address at a time.
4. **Quick patterns produce normal email-step entries**: pure UI
   sugar, no special data shape. Operator can immediately edit the
   inserted step before publish.
5. **`fireAssignmentNotification` / `fireOutcomeNotification` kept as
   no-ops**: deferred deletion by one cycle so any operator config
   still referencing `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` doesn't
   error at the call site. Future executors can delete the helpers
   once confirmed unused.
6. **`body_html` plumbed but not used by the cascade at v1**: the
   schema + queue + PA flow doc support HTML bodies; the cascade
   only writes `body_text`. Operators who want HTML can write raw
   HTML in `body_template` and PA's connector accepts either.
7. **Cascade depth cap 10**: defense in depth. Strict validator
   should catch all real cycles; the cap halts gracefully if a
   hand-edited JSONB constructs one.

### Latent issues / forward flags

- (a) `kind: "step"` legacy values continue to validate; new seeds
  write `"approval"`. Schema migration to normalize is a v2 candidate.
- (b) `body_html` field path is plumbed but the cascade only writes
  `body_text` at v1.
- (c) Per-purpose webhook fires on damage / fleet / workorders / signup
  / jotform NOT migrated at this brief (operator scope decision).
- (d) Approval digest (Brief 121) NOT migrated to the queue — daily
  cron is already efficient.
- (e) Admin email-queue viewer drafted as Brief 128, queued after.
- (f) PDF attachment generation for outcome emails: v2 candidate.
- (g) Per-workflow rate limiting + non-email channels (SMS, push)
  explicitly out of scope.
- (h) Cascade depth cap (10): defense in depth; strict validator
  catches real cycles.
- (i) `__submitter_email__` synthetic payload key injected via
  `payloadWithSubmitterSynthetic` is never persisted (caller invokes
  on a copy of payload right before cascade).
- (j) `notify_*` booleans in workflow schema persist as `@deprecated`
  back-compat; can be deleted once confirmed no consumer reads them.

### Files created

- `packages/db-supabase/src/outbound-emails.ts`
- `apps/forms-worker/src/email-queue/claim.ts`
- `apps/forms-worker/src/email-queue/confirm.ts`
- `apps/forms-worker/src/email-queue/attachments.ts`
- `apps/forms-worker/src/workflow-email-step.ts`
- `apps/web/app/admin/forms/[id]/_workflow/AddStepPopover.tsx`
- `apps/web/app/admin/forms/[id]/_workflow/EmailStepCard.tsx`
- `apps/web/app/admin/forms/[id]/_workflow/QuickPatternsPopover.tsx`
- `PA_FLOWS_BRIEF_127.md`

### Files modified

- `supabase/forms-tables.sql`
- `packages/db-supabase/src/index.ts`
- `packages/forms-schema/src/types.ts`
- `packages/forms-schema/src/validators/field-config.ts`
- `apps/forms-worker/src/index.ts`
- `apps/forms-worker/src/notifications.ts`
- `apps/forms-worker/src/submit/index.ts`
- `apps/forms-worker/src/admin/submissions.ts`
- `apps/forms-worker/wrangler.toml`
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts`
- `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx`
- `apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx`
- `apps/web/app/admin/forms/[id]/_workflow/WorkflowFlowPreview.tsx`
- `BRIEFS/INDEX.md`
- `BUILD_STATE.md`
- `CLAUDE.md`

### Files deleted

- `apps/web/app/admin/forms/[id]/_workflow/NotificationsPanel.tsx`

### Operator post-deploy smoke (deferred per brief Phase 9.6)

See BUILD_STATE.md Findings entry for the 9-step verification
checklist. Key requirement: operator must run the Phase 1 SQL block
(CREATE TABLE outbound_emails + indexes + `claim_outbound_emails`
function) in the Supabase SQL editor before binding
`FORMS_EMAIL_QUEUE_TOKEN` + building the PA flow.
