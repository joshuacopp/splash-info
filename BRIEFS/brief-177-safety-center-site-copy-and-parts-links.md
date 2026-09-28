# Brief 177 — Safety Center: copy the checklist back to the site, and link what it flagged to what they order

Status: Completed (2026-09-28)

## Problem

Two gaps on the Safety Center Compliance Checklist (`safety-center`, form
`2ce69e09-42d1-4fc2-bdbe-569708aa9169`), both raised by the operator.

**The site got nothing back.** Brief-era `safety-center-form-01.sql` sent the
completed checklist to the RM and deliberately nothing to the person who filled
it in, reasoning that there is no manager email on the paper form and inventing
a field to carry one was a bad trade. That left the site with no record of what
it had just certified except My Requests.

**A "No" told nobody what to buy.** A site short of gloves learns it is short of
gloves and then has to work out, unaided, what to order and from whom.

## Scope

1. **`supabase/parts-directory-03-form-field-keys.sql`** — new
   `parts_directory.form_field_keys text[]` + GIN index, and 17 seeded
   name-only rows under a new `Safety Supplies` equipment group.
2. **`apps/forms-worker/src/parts-lookup.ts`** (new) — one overlap query
   returning parts grouped by the field key they answer. Fail-soft throughout.
3. **`packages/forms-schema/src/types.ts`** — `negativeAnswerKeys` +
   `flaggedFieldKeys`, the shared definition of "a bad answer".
4. **`apps/forms-worker/src/workflow-email-step.ts`** — `{parts.needed}` email
   token (plain + HTML).
5. **`apps/forms-worker/src/pdf/layout-checklist.ts`** — `unflaggedNegatives`
   now calls the shared rule instead of carrying its own copy.
6. **`apps/forms-worker/src/action-items/handlers.ts`** — list response carries
   `parts` per row.
7. **apps/web** — `ActionItem.parts` on the wire type, order links on the row,
   and `?q=` seeding on the parts directory so those links land on a part.
8. **`scripts/gen-safety-center.ts`** — `site_email` lookup + the `notify_site`
   email step; **`supabase/safety-center-form-02-site-copy.sql`** applies it.

## Decisions made

- **The mapping lives on `parts_directory`, not on the form schema.** The
  alternative was a field flag beside `action_item_eligible`. More precise, but
  every change would mean editing a draft, republishing a form, and editing a
  generator script. On the parts table the operator curates it in the UI it
  already uses, several parts can answer one question (glove sizes, kit
  refills), and nothing republishes. Operator chose this.
- **`form_field_keys`, not `safety_item_keys`.** The array holds form field
  keys and a key is not safety-specific; the AM assessment and RM visit
  checklists raise action items from the same mechanism and can reuse the
  column with no second migration.
- **`{parts.needed}` keys off `flaggedFieldKeys`, which is WIDER than
  `_action_items`.** This is the load-bearing decision of the brief. Ticks come
  from an explicit checkbox in `submit/parse.ts` — `action_item_eligible` makes
  the checkbox appear, it does not auto-tick on a No. Keying parts off ticks
  alone would have meant the most common case (answered No, did not tick)
  produced no order links at all, silently. `flaggedFieldKeys` is ticked ∪
  negatives, where a negative is the second option of a two-option
  action-item-eligible question — the same second-is-the-bad-one convention the
  PDF's rating grid marks with an X.
- **That rule was LIFTED into `@splash/forms-schema` rather than copied.**
  `layout-checklist.ts` already had a private implementation of it
  (`unflaggedNegatives`). Writing a second one in the email path is exactly the
  drift the action-items module warns about, so the PDF now calls the shared
  function and its behaviour is unchanged (negatives minus ticked).
- **The token emits its own heading and nothing when empty.** A template cannot
  express "print this heading only if the list is non-empty", so a clean
  checklist would otherwise get `Items to order:` above blank space.
- **Parts are resolved once per cascade, and only when a template asks.** A
  substring check for `{parts.needed}` gates the query, so every other form's
  email cascade is untouched.
- **17 of 21 items mapped.** HazCom, Spill Response and the SDS Program are
  programs, not purchases. `Current SDS Binder Available` is arguably orderable
  and was left out; adding it is one row.
- **Seeded rows are name-only.** part_number / vendor / unit_cost / vendor_url
  are NULL for the operator to fill in. Inventing a vendor or a part number
  would put a wrong number in front of somebody ordering against it. The email
  and the action item both degrade cleanly: no `vendor_url` means the link goes
  to the directory card instead of a vendor.
- **`notify_site` is the default stage, ahead of `notify_rm`.** Email steps
  auto-advance, so both emails go out in one cascade at submit and the PDF is
  generated once for both (Brief 129 reuse keys on the workflow_history
  timestamp).
- **A site with no `site_email` sends nothing, silently.** It must not block
  the RM's copy, which is the one the source document actually requires.

## Latent issues / notes

- **Only submissions made AFTER Publish get the site copy.** The `site_email`
  lookup does not exist on earlier versions, so there is nothing to resolve.
  In-flight submissions keep their version and are unaffected — by design.
- **`{payload.summary}` includes the `rm_email` and `site_email` lookup rows.**
  Harmless and arguably useful (it says who else got it), but it is visible.
- The parts directory page filters client-side; `?q=` only seeds the initial
  value. A part whose name is later edited leaves older emails linking to a
  search that finds nothing. Linking by id would need the page to resolve ids,
  which it does not do today.

## Validation

- `scripts/gen-safety-center.ts` — passes its own assertions plus BOTH
  `formSchemaSchema` and `draftFormSchemaSchema`: `fields=54 items=21 paired=21
  headings=5 stages=5` (was 53 / 4).
- `pnpm typecheck` — 27/27.
- `pnpm --filter @splash/web build` — compiled successfully.
- `wrangler deploy --dry-run` on forms-worker — 3065.70 KiB / 699.49 KiB gzip.
- Emitted SQL verified byte-identical to the re-run generator output.
- **Both SQL files APPLIED to the live project on 2026-09-28 via psql**
  (`SUPABASE_DB_URL`, transaction pooler on 6543), each with
  `ON_ERROR_STOP=1 --single-transaction`. Verified after apply: 17 Safety
  Supplies rows all carrying a mapping, draft at fields=54 / stages=5 /
  default_stage=notify_site, and **0 seeded keys that do not match a field on
  the form** — a mapping to a renamed or misspelled key would link a No to
  nothing, silently.
- Caught during apply: **`parent_equipment` is `text[]`, not `text`.**
  `parts-directory-02-multi-equipment.sql` changed it on 2026-09-12 and the
  seed was written against the shape in file 01. `--single-transaction` meant
  the failed run rolled back whole rather than leaving the column added and the
  seed missing. Fixed to `ARRAY[v.equipment]`; the verify query in the file
  was containment-corrected with it.
- The form was confirmed **already published**, so the literal draft id
  recorded in form-01 was indeed stale and resolving through
  `forms.draft_version_id` was load-bearing rather than defensive.
- No runtime smoke test: needs Publish, which is the operator's.

## Follow-up, same day — the mapping picker

The first pass added `form_field_keys` with no UI, so a part created through
the editor answered no checklist question and only SQL could map one. Closed:

- **`GET /forms/admin/api/action-item-questions`** (new,
  `apps/forms-worker/src/admin/action-item-questions.ts`) — mappable questions
  grouped by form, PUBLISHED versions only. Lives on forms-worker because a
  question is a fact about a form schema; teaching the parts worker to read
  `form_versions.schema` would give a second worker an opinion about what a
  form field is. apps/web holds bindings to both and does the join.
- **`form_field_keys` is now writable** end to end: `PartsDirectoryInput` /
  `PARTS_COLS` / `normalizeRow` / `buildWritableBody` in `@splash/db-supabase`,
  `readFormFieldKeys` in `apps/workorders-worker/src/parts.ts`. The apps/web
  write proxy forwards bodies verbatim and needed no change.
- **Picker in `PartEditor`** — checkboxes grouped by form, with a filter
  because there are 165 mappable questions across the three checklists today.

Decisions:

- **Keys are validated against `^[a-z][a-z0-9_]*$` but NOT against a live
  form.** A typo produces no error anywhere — it just matches no question and
  the part never appears against the answer it was meant for. Rejecting a
  malformed key is the only moment anything can notice. A part may also
  legitimately be mapped before its form is published.
- **A checked question stays visible through the filter.** Otherwise typing
  hides what you already picked and the box reads as though you had picked
  nothing.
- **The Set is seeded from the ROW, not the picker.** A key the picker cannot
  display (mapped by SQL, or against an unpublished form) survives a save
  instead of being silently dropped. The trade is that it cannot be REMOVED
  here either — which is the right way round.
- **Editing a part was already safe** before this: `buildWritableBody` builds a
  sparse body and PostgREST leaves absent columns untouched, so the seeded
  mappings were never at risk from a UI edit. Verified rather than assumed,
  because a full-row write would have wiped every mapping on first edit with
  nothing to indicate it.

Verified against live data before shipping: the endpoint's query returns 90 /
54 / 21 mappable questions for the AM assessment, RM visit and Safety Center
respectively, and **all 17 seeded keys resolve to a question the picker will
show** — a seeded key that matched nothing would have been a dead mapping.

## Operator steps

1. ~~Run `supabase/parts-directory-03-form-field-keys.sql`~~ — DONE 2026-09-28.
2. ~~Run `supabase/safety-center-form-02-site-copy.sql`~~ — DONE 2026-09-28.
3. **Deploy** (push — forms-worker and apps/web both change).
4. Open `/admin/forms/2ce69e09-42d1-4fc2-bdbe-569708aa9169` and **Publish**.
5. Fill in vendor / part number / cost / order URL on the 17 rows at
   `/admin/parts/directory` under **Safety Supplies**.

**Order matters between 3 and 4.** The published schema will contain
`{parts.needed}`, and a forms-worker that predates this brief does not know
that token — `renderTemplate` returns the raw `{parts.needed}` text unchanged
for an unrecognised token, so publishing before deploying puts a literal
`{parts.needed}` in front of a site. Deploy first.

Step 5 can happen whenever — until it does, links point at the directory card
rather than a vendor, which is correct behaviour rather than a broken state.
