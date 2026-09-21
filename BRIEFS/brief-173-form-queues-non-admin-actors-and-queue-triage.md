# Brief 173: Form queues — non-admin actors and triage from the queue

**Status:** Ready for Claude Code
**Started:**
**Completed:**
**Blocks:** Neither
**Dependencies:** Briefs 120 / 121 / 125 / 129 / 131 (workflow, approvals queue, field flags)

## Read first
- BUILD_STATE.md
- CLAUDE.md — the forms-worker glossary entry, and Brief 131's closing
  "Latent for follow-up" paragraph, which is item 1 of this brief's Scope
- `apps/forms-worker/src/admin/auth.ts` — `submissionGate`, and why it is NOT
  the gate this brief widens
- `apps/forms-worker/src/admin/pending-approvals.ts`
- `apps/web/app/admin/approvals/page.tsx`
- `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx`

## Context

The forms workflow is already a ticketing system wearing approval vocabulary.
A stage with `static_emails` is a shared work queue, `current_approver_emails`
is "this ticket is yours", transitions are dispositions, and
`workflow_history` is the audit trail. Brief 125 already renamed the builder's
own language to steps / actions / outcomes.

Two things stop it being usable by the people who would actually work a queue.

**1. The actors cannot reach the ticket.** The transition endpoint authorises
on approver-email membership and is happy to accept any resolved approver
(`apps/forms-worker/src/admin/submissions.ts` ~line 895). But both apps/web
surfaces are hard admin-tier: `/admin/approvals` (page.tsx:62) and the
submission detail page (page.tsx:63) each require
`session.role === "super_admin" || session.dcRole === "admin" | "super_admin"`.
So a non-admin approver sees their queue 403 and can never open the ticket.
CLAUDE.md flags exactly this at the end of Brief 131 as a known follow-up.

**The fix is NOT to widen `submissionGate` or to grant these users a role.**
`submissionGate` offers full-admin-tier (everything) or the `form_submissions`
tool grant scoped to `session.locations` (their own sites only). There is no
"all rows for THIS form, not an org admin" tier, and inventing one means a new
per-form permission model. `current_approver_emails` already IS a
per-submission grant — it needs no new model, and it scopes an actor to
precisely the tickets routed to them and nothing else in the system. That is
why the queue surface here is `/admin/approvals` and not the Brief 119 wide
submissions table.

**2. You cannot triage without opening every ticket.** `/admin/approvals`
returns form title, stage, submitter, submitted-at and location code — no
payload. For a queue of hundreds, an actor must open each ticket to learn what
it is, which is both slow and (once a claim mechanism exists) generates false
signals. The form maker should decide which fields identify a ticket at a
glance.

**Driving use case.** A POS-operator changeover produces hundreds of broken
customer accounts. Site staff submit barcode / name / phone / email / plan
type; two CRD staff work the resulting queue, sometimes bouncing a ticket back
for more information before they can act. The customer PII in the payload is
data CRD handles as their job — the widening below is scoped to tickets routed
to them, not to the form corpus.

**Explicitly deferred: the claim / lock.** Two actors coordinate verbally
faster than a badge helps, and the transition handler already re-reads the
current stage and 403s a stale double-action, so collisions waste effort but
cannot corrupt state. A claim is additively retrofittable (two nullable
columns plus a button) and should be added when the team grows past roughly
four, or the first time duplicated work is actually observed — not before,
because a TTL guessed wrong produces stale badges people learn to ignore.

## Scope

1. **Widen the two apps/web gates from admin-tier to "admin-tier OR a
   resolved approver on this submission".**
   - `apps/web/app/admin/approvals/page.tsx` — a non-admin caller already gets
     a correctly-scoped list from the worker (it filters on
     `current_approver_emails cs.{email}`), so the page gate is the only thing
     rejecting them. Keep `?scope=all` admin-only; a non-admin asking for it
     must still coerce back to "me" rather than error.
   - `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx` — an
     approver must be able to open only the tickets currently routed to them.
     **The check reads `current_approver_emails` off the worker's submission
     response rather than re-deriving authority in apps/web.** Operator-
     confirmed, not a choice left open. A second implementation of "who may
     act" is a second thing to get wrong, and it would drift silently the
     moment `resolveApproverEmails` changes.
   - A caller who is NEITHER admin-tier NOR an approver on that submission
     must get the existing `NoAccessCard reason="forbidden"`, not a 500 and
     not a blank page.
   - The worker is already correct and needs no gate change. Do not loosen
     `submissionGate`.

2. **`show_in_queue` field flag, surfaced as queue columns.**
   - Add optional `show_in_queue?: boolean` to `FieldBase` in
     `packages/forms-schema/src/types.ts` plus its Zod schema (strict AND
     draft variants) — same shape and same place as Brief 129's
     `exclude_from_pdf`.
   - Expose it in the builder via the shared
     `_field-types/_shared/AdvancedSection.tsx`, which is wired into the
     `FieldInspector` wrapper once rather than per type, so all 16 field types
     inherit it with no per-type work (the Brief 129 precedent).
   - `apps/forms-worker/src/admin/pending-approvals.ts` — for each item,
     resolve the flagged fields from that submission's OWN version schema and
     return them as an ordered `queue_fields: {key, label, value}[]`. Read
     payload values by `field.key`, NEVER `field.id` (Brief 131 established
     this empirically in three places).
   - Cap the number of flagged fields honoured per form at **5** so a form
     maker ticking every box cannot make the queue unreadable. Over the cap,
     take schema order and drop the rest — do not error.
   - Render them as additional columns on `/admin/approvals`. Long values
     truncate with a hover title, per the Brief 119 `AnswerCell` convention.
   - Display-only field types (`heading`, `image`) must not be flaggable.

3. **Operator prerequisite, documented not automated.** CRD actors need plain
   logins via the sysadmin Create User card. After item 1 they need NO
   elevated role — no `dc_role`, no `form_submissions` tool grant, no
   locations. State this in the Outcome so the operator does not over-grant.

## Worked example (the driving form, for sizing only — not built here)

Fields the operator will create: Location, customer barcode, name, phone,
email, last 4 of card, a `multi` of common issues (account inactive / account
not found / double charge / ...), and a `long_text` description.

Of those, the ones that identify a ticket at a glance — and so would carry
`show_in_queue` — are roughly: **barcode, name, common issues, location**.
Four of the five permitted. Phone, email, card digits and the description stay
in the ticket body, which is the distinction the flag exists to draw: the queue
answers "which ticket is this", the ticket answers "what do I do".

One guard worth applying when the form is built: make the card field
`short_text` constrained to 4 characters and label it explicitly as the last
four. Storing the last four is fine; the constraint is what stops somebody
pasting a full card number into a JSONB payload that is then exportable to CSV.

## Out of scope

- Any claim / lock / assignment mechanism (see Context for when to revisit)
- Widening `submissionGate` or adding a per-form permission model
- Bulk actions on multiple tickets
- SLA / aging / escalation
- Building the POS-changeover form itself — that is operator work in the
  builder once this lands, and needs no code. VERIFIED: every field type it
  needs already exists (`multi` for the common-issues multiselect, `phone`,
  `email`, `short_text`, `long_text`, `location`), so no field-type work is
  hiding in this brief.
- Free-form comment threads outside transitions

## Definition of done

- `pnpm typecheck` green across the workspace
- `pnpm --filter @splash/web build` succeeds
- A non-admin session that is a resolved approver on a submission can load
  `/admin/approvals`, see that ticket with its `show_in_queue` columns
  populated, open it, and transition it
- The same session gets `forbidden` on a submission it is NOT an approver for
- An admin-tier session sees no behaviour change anywhere
- A form with zero `show_in_queue` fields renders `/admin/approvals` exactly
  as it does today (no empty columns)
- CLAUDE.md forms-worker glossary updated: the Brief 131 "Latent for
  follow-up" paragraph is resolved, and the queue-vs-wide-table reasoning from
  this brief's Context is recorded so the next reader does not re-derive it
- BUILD_STATE.md updated per its Conventions section

## Outcome

(Filled in by Claude Code.)
