# Brief 176: Site visit action items

**Status:** Planned
**Started:**
**Completed:**
**Blocks:** Neither
**Dependencies:** Brief 129 (`FieldBase` flag pattern + `AdvancedSection`), Brief 92
(`${key}_r2` companion-input pattern), Brief 127 (`outbound_emails` queue),
Brief 71 (`getLocationsByContactEmail` + `matched_via` scoping)

## Read first
- BUILD_STATE.md
- CLAUDE.md — forms-worker glossary; the `outbound_emails` entry, especially the
  dedup-tuple paragraph
- `packages/forms-schema/src/types.ts` — `FieldBase`, where `exclude_from_pdf`
  and `show_in_queue` live. The new flag is a sibling, not a new concept.
- `apps/forms-worker/src/submit/parse.ts` — the `file` branch reads a hidden
  `${key}_r2` companion into the payload. That is the shape the action-item
  companions copy.
- `apps/forms-worker/src/submit/index.ts` — the `location_code` stamping block
- `packages/db-supabase/src/locations.ts` — `getLocationsByContactEmail`
- `apps/forms-worker/src/cron/approval-digest.ts` — the queue-backed digest to
  model the reminders on, including why `source_id` carries a date

## Context

Regional managers run a periodic "site visit": a deep-dive audit of everything
about a location, currently on a standalone JotForm (NOT one of the five in
`jotform_forms` — there is no ingested history to migrate). The form moves to
custom forms, and the point of the exercise is not the form: it is the
follow-up work the visit generates.

So while filling it out, the RM ticks "create action item" on any question that
needs follow-up. Those become rows the site and the RM work off afterwards,
with a status either can move, a due date, and an RM verification step.

**Almost none of this is new machinery.** Four existing mechanisms carry it:

| Need | Existing |
|---|---|
| Per-question "eligible" flag | `FieldBase.exclude_from_pdf` / `show_in_queue` via shared `AdvancedSection.tsx`, inherited by all 16 field types |
| Extra per-question data at submit | `file` already ships hidden `${key}_r2`, read in `parse.ts` |
| Which site a submission is for | `form_submissions.location_code`, stamped server-side |
| "Site or RM?" | `getLocationsByContactEmail` → `matched_via` |
| Reminder mail | `outbound_emails` — 5 workers, one drain, no new flow |

## The actual form (read 2026-09-23)

`https://splashcarwashes.jotform.com/251016031343036` — "RM Visit Form", 73
fields. Read from the PUBLIC form page, not the API: `JOTFORM_API_KEY` is a
Cloudflare secret on `splash-jotform` and cannot be read back locally, and the
form page carries the full question list anyway.

Shape:

| Block | Fields | Ports to |
|---|---|---|
| Site, Date, Time, RM name | 1–4 | `location`, `date`, `time`, `short_text` |
| RM / AM / Site / GM email | 5–8 | `lookup` — resolved from the site, not typed |
| Exit Pad? / Store on site? | 9–10 | `dropdown` (Yes/No) |
| 8 inspection sections, Pass/Fail/NA | 11–57 (**47 rows**) | see the field-type problem below |
| Follow-up / correction block | 58–70 (**13 fields**) | **DELETED — this feature replaces it** |
| RM Email (duplicate of 5), Submit | 71–73 | drop the duplicate |

### The form already contains a hand-rolled version of this feature

Fields 58–70 are: "Items in Need of Attention", "Items Needing Plan and
Follow-up" (1/2/3/4/5/More than 5), then FIVE fixed pairs of "Correction Item
and Plan N" + "Correction N Follow Up Date", plus "Reminder Email Desired?",
"Reminder Email Date" and "Calendar Title".

That is `action_items` — capped at five, typed as free text, with no status, no
completion, no verification, and a reminder date the RM has to set by hand. The
whole block collapses into the ticked-question mechanism this brief describes.
Do not port it.

### The conditional logic is confined to the block being deleted

Fields 62–70 ARE conditional (shown only when "Reminder Email Desired?" is
Yes). The operator's "no meaningful conditional logic" answer holds, but for a
sharper reason than it first appeared: the form's ONLY conditionals live in the
correction block, and that block does not survive the port. Nothing in fields
1–57 branches.

### The field-type problem is bigger than first assessed

**47 of 73 fields are Pass / Fail / NA radio rows** grouped under 8 section
headings. That is the form.

`FieldType` has no `radio`. The nearest is `dropdown`, which means 47 select
boxes where JotForm shows 47 three-option radio rows — each one two taps and a
scroll instead of one tap, on a tablet, while walking a site. That is a
materially worse instrument for the job, and it is the bulk of the form rather
than an edge.

**DECIDED (2026-09-23): add a `radio` field type. Not `matrix`.**

`matrix` — one field holding many rows over a shared option set — was the other
candidate, and it is what this form structurally IS. It was rejected because
its three benefits do not survive contact with the plan:

- *fill-time taps*: `radio` already fixes this. One tap per row either way.
- *builder tedium*: moot. The form is authored by SQL (below), so nobody drags
  47 cards or retypes options 47 times regardless.
- *visual density*: real, and the only surviving advantage.

Against that, `matrix` costs: per-ROW action-item companions rather than
per-field (`${key}__ai__{row}`), which complicates the one mechanism this brief
exists to build; expansion logic in the Brief 119 wide table and the CSV export,
both of which assume one field is one column; and its own PDF case. It is a
feature in its own right and would make Phase 1 harder while the action-items
idea is still unproven. Revisit once this ships.

`radio` by contrast is a `dropdown` whose payload shape is identical — a single
option value — so every existing consumer handles it by treating it exactly as
a dropdown.

### Improvements available on the port

- Site becomes a `location` field, which drives `scope_location_field_key` and
  therefore stamps `location_code` — the same column `action_items` keys off.
- RM / AM / Site emails become `lookup` fields resolved from the site instead
  of four addresses retyped per visit, which is also how they stop being wrong.
- Section headings become `heading` fields; they carry no payload and are
  correctly not action-item-eligible.

**Operator decisions already taken** (2026-09-23):
1. The current JotForm does not meaningfully use conditional show/hide, so the
   builder's lack of conditional field logic is NOT a blocker. (It remains a
   real gap — see Out of scope.)
2. Fill-time is TICK ONLY. No priority/due/description typing mid-walkthrough.
3. RM verification is available only on `done`, and LOCKS the item.

## Sequence

0. **`radio` field type.** Prerequisite, and independent of action items.
1. **Phase 1 — capture** (flag, checkbox companion, table, creation at submit).
2. **Author the form as a DRAFT via SQL**, validated locally first (below).
3. **Operator publishes from the UI.** Not optional — see the warning.
4. **Phase 2 — the page.** 5. **Phase 3 — reminders.**

### Authoring by SQL: two things that will bite

**The field type must exist in code first.** `formSchemaSchema` is a
discriminated union on `field.type` and the renderer is a switch over it, so an
unknown type fails Zod at publish AND at render no matter how the row arrived.
Writing SQL skips the builder UI, not the codebase.

**Write the DRAFT version and publish through the normal path. Do NOT insert a
published `form_versions` row directly.** Publish is not a copy — `handlePublish`
in `admin/forms.ts` also designates a `site_number` scope field and calls
`setFormScopeFieldKey`, which sets `forms.scope_location_field_key`. That column
is what makes the submit path resolve and stamp `form_submissions.location_code`
— the exact column `action_items.location_code` is denormalized from and the
whole site/RM scoping model keys on.

Skip publish and `scope_location_field_key` stays NULL, submissions land with a
null `location_code`, and every action item belongs to no site. There is no
error on any of those steps. It is silent.

**Validate the hand-authored schema locally before it touches the database.**
Run the JSON through `formSchemaSchema.safeParse` with `tsx` before inserting.
The operator has already hit `422 schema_invalid ["fields",8,"keyFieldId"]`
once from hand-edited schema; that is avoidable at zero cost.

## Scope

### Phase 0 — the `radio` field type

The 5-step path from the CLAUDE.md forms-worker entry, plus the consumers that
switch on field type. `radio`'s payload is a single option value, identical in
shape to `dropdown`, so every consumer treats it as one:

- `packages/forms-schema/src/types.ts` — `RadioField` + the `Field` union
- `validators/field-config.ts` — `radioFieldSchema` + the discriminated union
- `validators/payload.ts` — enum over option values, same as dropdown
- `apps/forms-worker/src/render/fields/radio.ts` + the dispatcher case.
  Renders a real `<input type="radio">` group; `layout: "inline"` puts
  Pass/Fail/NA on one line, which is the whole point for 47 rows on a tablet
- `apps/forms-worker/src/pdf/layout-payload.ts` — value→label, 2 sites
- `apps/forms-worker/src/admin/submissions.ts` — the REPORT PDF aggregates
  dropdown/multi into per-question charts. Including `radio` there gives
  Pass/Fail/NA breakdowns per question for free, which is most of what an RM
  report wants
- apps/web `PayloadRenderer` / `AnswerCell` / `WideSubmissionsTable`
- apps/web `_field-types/radio/{index,Renderer,Inspector}` + registry

Adding `RadioField` to the `Field` union FIRST makes TypeScript enumerate every
site that needs a case — more reliable than grepping for them.

### Phase 1 — capture

**Schema flag.** `FieldBase.action_item_eligible?: boolean`, strict + draft Zod,
surfaced through `AdvancedSection.tsx` so all 16 field types inherit it (the
Brief 129 deviation-from-brief applies: wire it once in the `FieldInspector`
wrapper, not per type). Display-only types (`heading`, `image`) carry no payload
and must not be flaggable, same rule `show_in_queue` uses.

WHY a builder-time flag at all: without it every question renders a checkbox,
including the site-number lookup, the signature and the headings. The flag is
what makes the checkbox mean something.

**Renderer.** An eligible field renders a "Create action item" checkbox beneath
its input, emitting `${key}__ai` as a companion. `parse.ts` reads it alongside
the field's own value. Follow the `_r2` precedent exactly — a companion keyed
off `field.key`, read in the same loop.

**Table** (operator-applied SQL, per constraint #10, unless instructed
otherwise):

```
public.action_items
  id              uuid pk default gen_random_uuid()
  submission_id   uuid not null references form_submissions(id) on delete cascade
  location_code   text not null
  field_key       text not null
  question_label  text not null
  answer_snapshot text
  description     text not null
  priority        text not null check (priority in ('High','Medium','Low'))
  due_date        date
  status          text not null default 'open'
                    check (status in ('open','in_progress','done'))
  completed_at    timestamptz
  completed_by    uuid references auth.users(id)
  rm_verified_at  timestamptz
  rm_verified_by  uuid references auth.users(id)
  created_at      timestamptz not null default now()
  created_by      uuid references auth.users(id)
```

RLS enabled, ZERO policies, like every other table here. Index on
`(location_code, status)` for the site page, and on `submission_id` for the
per-visit rollup.

`question_label` and `answer_snapshot` are DENORMALIZED deliberately. Forms are
versioned; a later version can rename or delete the question this came from, and
without the snapshot the action item is prose with no referent. Same reasoning
as `form_submission_comments.author_email` and `form_submissions.submitter_email`.

`location_code` is denormalized from the submission so the site page is an
indexed filter, not a join back through `form_submissions` → `forms`.

**Creation at submit.** In `submit/index.ts`, after the submission row lands and
`location_code` is resolved. Defaults, since fill-time is tick-only:
- `description` ← the question's label
- `answer_snapshot` ← the submitted value, rendered to one line
- `priority` ← `'Medium'`
- `due_date` ← submitted date + 14 days, computed in EASTERN (a due date of
  "today" must mean today where the site is; see
  `apps/workorders-worker/src/eastern-time.ts` for the DST-correct pattern)

**Failure posture.** Do NOT fail the submission when action-item insert fails.
Return success with a loud warning naming the failure, and log it. Losing a
40-question site visit is worse than losing rows that can be rebuilt — and they
CAN be rebuilt, because the tick lives in the payload. The payload is the source
of truth; `action_items` is a materialization. Any backfill is a re-read of
`form_submissions.payload`.

### Phase 2 — the page

`/action-items` TOP-LEVEL, not under `/admin/*` — sites use it, the same reason
`/workorders` sits outside `/admin` (Brief 70). Being top-level also sidesteps
the `ADMIN_KNOWN_SUBPATHS` rule; add it to the `Header.tsx` gate instead, which
already special-cases `/workorders`.

Endpoints on forms-worker (it owns the submit path that creates these; an
eleventh worker for one table is not warranted):
- `GET /forms/api/action-items?location=&status=&submission_id=`
- `PATCH /forms/api/action-items/{id}` — `status`, plus `description`,
  `priority`, `due_date` (editable because fill-time is tick-only; the refining
  happens here)
- `POST /forms/api/action-items/{id}/verify`

**Authority — no new permission model.** `getLocationsByContactEmail(email)`
answers both questions in one indexed read:
- which sites the caller sees → the returned rows
- whether they are the site or the RM → `matched_via`

`matched_via === 'rm_email'` (plus admin tier) gates verify. `site_email` or
`rm_email` gates the status toggle and the edits. This is exactly what
`/workorders` runs on. It needs no `dc_role`, no tool grant, no new table, and —
unlike role-based grants — takes effect immediately rather than after a
sign-out/in.

`completed_at` / `completed_by` are stamped SERVER-SIDE on the transition into
`done`, and cleared on transition out. Never client-supplied.

Verification: allowed only when `status = 'done'`; once set, the row is frozen
(status and fields reject further writes) except by admin tier. A "verified"
item that can be reopened means nothing, which is the whole reason for the
button.

### Phase 3 — reminders

Two digests on `outbound_emails`, new cron `"30 12 * * *"` (11:00 cleanup,
11:30 workorders sync, 12:00 approvals digest and 13:00 damage summary are
taken). Dispatch on the literal cron string in `index.ts`'s `scheduled`.

- **To the site** — open and overdue items at this location
- **To the RM** — per-visit rollup: what is done, what is not

`source_id` MUST carry the period — `"{location_code}:{date}"` for the site
reminder, `"{submission_id}:{date}"` for the RM rollup. The dedup tuple is
`(source_worker, source_kind, source_id, recipient)` with ignore-duplicates, so
a constant `source_id` sends ONCE EVER and no-ops silently every day after. This
is not hypothetical: it is the trap the approvals digest was built around, and
the workorders daily and greeter weekly digests both solve it the same way.

Render via `@splash/email-shell`, like every other mail in the monorepo.

## Out of scope

- **Conditional field logic in the builder.** The schema has none — only
  workflow branching. Confirmed not needed here because the form's only
  conditionals are in the correction block this feature deletes. It stays a
  real gap for any future audit-shaped form.
- **A `radio` / `matrix` field type.** NOT out of scope so much as undecided —
  see "The field-type problem" above. 47 of 73 fields depend on the answer.
- Migrating historical JotForm site-visit submissions — the form was never
  ingested, so there is no history in `jotform_submissions` to carry over.
- Rebuilding the form itself in the builder. That is operator work, tracked
  separately from this machinery.
- Action items created by hand, outside a submission. Every row here is born
  from a ticked question; a free-standing "add an action item" button is a v2
  candidate and would need `submission_id` to become nullable.
- Assigning an item to a named person. Ownership is the site, collectively.
- Per-item comment threads (Brief 174 exists for submissions; reuse is a v2
  candidate if the reminders prove insufficient for back-and-forth).

## Definition of done

- `pnpm typecheck` clean across the workspace
- `pnpm --filter @splash/web build` succeeds
- SQL applied and VERIFIED BY RE-QUERY, not by trusting a success flag: RLS on,
  zero policies, indexes present
- A test submission with two ticked questions produces exactly two rows with
  correct `location_code`, labels and Eastern-correct due dates
- A site-email user can move status and cannot verify; an RM-email user can do
  both; neither sees another location's rows
- Status → `done` stamps `completed_at`; moving back out clears it
- A verified row rejects further edits from site and RM
- One digest run produces one queue row per recipient per day, and a second run
  the same day produces none

## Outcome

_(to be filled in on execution)_
