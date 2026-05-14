# Brief 133: Workflow transition three-bug pass — uuid type, dedup 409, PDF Unicode

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — three small correctness fixes that together block
the full workflow approval flow from completing. Bug A is user-facing
(every transition into a terminal outcome returns 500
`transition_failed` to the operator); Bugs B + C are fail-soft but
spam errors into Workers Logs every transition and prevent the
completed-form PDF from generating.
**Dependencies:** None. Brief 132 (approver_source seed fix) and
Brief 131 (workflow correctness pass) both shipped.

## Read first

- CLAUDE.md (forms-worker glossary entries on Briefs 120 / 127 / 129 /
  131 — context for the auto-status update, outbound queue, PDF
  generator)
- `apps/forms-worker/src/admin/submissions.ts` — the transition handler
  with the `status_updated_by: "system@workflow"` patch (line 673)
- `packages/db-supabase/src/outbound-emails.ts` — `enqueueOutboundEmail`
  helper with the missing `?on_conflict=...` query param
- `apps/forms-worker/src/pdf/layout-workflow-history.ts` — workflow
  history page renderer with the hardcoded `→` character (line 91)
- `supabase/forms-tables.sql` line 73 (`status_updated_by uuid`) —
  confirms Bug A's column type

## Context

Real-world testing of the full workflow flow today (operator clicked
Approve on a submission with signature attached) surfaced three
distinct bugs in one transition attempt:

### Bug A — `status_updated_by` column rejects "system@workflow"

`apps/forms-worker/src/admin/submissions.ts:670–674`:

```ts
statusPatch = {
  status: "closed",
  status_updated_at: new Date().toISOString(),
  status_updated_by: "system@workflow"
};
```

Brief 131 Phase 5 added this auto-status update so terminal-outcome
transitions automatically flip `form_submissions.status` to `"closed"`.
But `form_submissions.status_updated_by` is defined as `uuid`
(`supabase/forms-tables.sql:73`), NOT `text`. Writing the literal
string `"system@workflow"` triggers Postgres error
`22P02 invalid input syntax for type uuid`, the PATCH 400s, the
transition handler 500s, the operator gets a `transition_failed`
banner.

This is the actual user-facing failure visible in today's screenshot.

The Brief 131 executor pattern-matched this off Brief 105's fleet
`status_updated_by` (which IS `text`) without checking that
`form_submissions` uses a different column type. The fleet table
stores operator emails directly; the forms table mirrors `auth.users`
referential semantics.

### Bug B — `enqueueOutboundEmail` returns 409 Conflict on dedup

`packages/db-supabase/src/outbound-emails.ts:97–107`. The helper sends:

```ts
const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
const headers = {
  ...
  Prefer: "resolution=ignore-duplicates,return=representation"
};
```

The intent (per Brief 127 design + this file's docblock) is that
re-firing the same `(source_worker, source_kind, source_id, recipient)`
tuple is a silent no-op. The unique index on the table is configured
correctly — that's why we see the `Key (...)=(...) already` message
in the error body. But PostgREST's `Prefer: resolution=ignore-duplicates`
ONLY honors the no-op semantics when the request URL carries an
`?on_conflict=<column-list>` query param. Without that param, PostgREST
lets the underlying Postgres `23505 unique_violation` propagate as
409 Conflict.

PostgREST docs:
> "To make POST work as a UPSERT, you can specify a target via
>  on_conflict query parameter."
> "Without on_conflict, the request behaves as a plain INSERT and
>  duplicate-key violations return 409."

Real-world impact: every transition that re-enters an email step
that's already enqueued (e.g., operator clicks Approve, hits 500 on
Bug A, retries) logs a `[forms.workflow.email-step] enqueue failed`
ERROR. The cascade itself is fail-soft so the operator-facing
transition isn't broken by this — but the logs are full of false
positives and the helper's `was_duplicate: true` return path can
never trigger because we never reach it.

### Bug C — PDF generation can't encode `→` U+2192

`apps/forms-worker/src/pdf/layout-workflow-history.ts:90–93`:

```ts
// From → To header.
const arrow = "→";
const headerText = `${fromLabel} ${arrow} ${toLabel}`;
cursor.page.drawText(headerText, { ... });
```

pdf-lib's standard Helvetica font uses WinAnsi encoding, which doesn't
include U+2192 RIGHTWARDS ARROW. `drawText` throws
`WinAnsi cannot encode "→" (0x2192)`. The PDF generator's outer
try/catch (Brief 129) catches this and the workflow proceeds without
a PDF attachment — but the operator's email step's `attach_pdf: true`
never gets an actual PDF, and the error spams logs.

CLAUDE.md's Brief 129 glossary entry explicitly notes "Helvetica +
Helvetica-Bold standard fonts only" — embedding a Unicode-capable
TTF is out of scope here. The fix is to sanitize / replace Unicode
characters before passing to `drawText`.

Bug C also lurks in any other PDF text site that interpolates user-
generated strings (transition labels, notes, typed_name fields).
Brief 133 hardens the workflow-history renderer; a broader audit /
helper is flagged for follow-up but not in scope.

## Scope

### Phase 1 — Fix `status_updated_by` for system actor (Bug A)

`apps/forms-worker/src/admin/submissions.ts`, around line 670–674:

**Option 1 (preferred):** Drop `status_updated_by` from the
`statusPatch` entirely for system-initiated updates. The
`workflow_history` JSONB array already captures who triggered the
transition (the human operator), so `status_updated_by` being null
when the system flips status doesn't lose audit info — the timeline
in `workflow_history[-1].actor_email` is the canonical answer to
"who closed this submission".

```ts
statusPatch = {
  status: "closed",
  status_updated_at: new Date().toISOString()
  // status_updated_by intentionally omitted — system-initiated
  // status flip on terminal outcome. The triggering operator is
  // captured in workflow_history.
};
```

**Option 2 (alternative if operator wants explicit system audit):**
Add a sentinel UUID const at the top of `submissions.ts`:

```ts
const SYSTEM_ACTOR_UUID = "00000000-0000-0000-0000-000000000000";
```

and use it. Document in a comment that this UUID is the convention
for system-initiated updates. Add a CLAUDE.md glossary line noting
the convention so future readers know.

Operator preference: go with Option 1 unless explicit audit on the
`status_updated_by` column is needed. The history JSONB carries the
fuller story.

### Phase 2 — Fix `enqueueOutboundEmail` dedup (Bug B)

`packages/db-supabase/src/outbound-emails.ts`, around line 97:

Add the `on_conflict` query param so PostgREST honors
`resolution=ignore-duplicates`:

```ts
const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
url.searchParams.set(
  "on_conflict",
  "source_worker,source_kind,source_id,recipient"
);
```

After this fix:
- Fresh enqueue → 201 with the new row
- Dedup hit → 201 with the EXISTING row (matches the helper's
  `was_duplicate` heuristic at line 156–158)
- Real transport/auth failures still throw

Verify the existing `was_duplicate` heuristic (compares `row.created_at`
against `Date.now()` with 3s clock-skew tolerance) still works once
dedup actually returns 201 instead of 409.

### Phase 3 — Sanitize the PDF arrow character (Bug C)

`apps/forms-worker/src/pdf/layout-workflow-history.ts`, around line 91:

Replace the hardcoded `→` with an ASCII equivalent that WinAnsi can
encode:

```ts
// pdf-lib's standard Helvetica is WinAnsi-only; U+2192 RIGHTWARDS
// ARROW isn't representable. Use ASCII "→" stand-in.
const arrow = "->";
const headerText = `${fromLabel} ${arrow} ${toLabel}`;
```

Audit the rest of `layout-workflow-history.ts` and the other
`apps/forms-worker/src/pdf/layout-*.ts` files for any other
hardcoded non-WinAnsi characters (bullets `•`, em-dashes `—`,
typographic quotes `"`/`"`/`'`/`'`, ellipsis `…`). Replace each with
an ASCII equivalent. If a defensive helper is the cleanest path,
add one to `layout-utils.ts`:

```ts
/** Replace common non-WinAnsi characters with ASCII equivalents
 *  so pdf-lib's standard Helvetica can render the string. Add new
 *  mappings as they surface. */
export function sanitizeForWinAnsi(s: string): string {
  return s
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/•/g, "*")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/"|"/g, '"')
    .replace(/'|'/g, "'")
    .replace(/…/g, "...");
}
```

Then wrap every `drawText` call in the layout-* files that interpolates
user-generated content with `sanitizeForWinAnsi(...)`. Hardcoded
literal strings owned by Splash code (e.g., section labels) should
be edited to ASCII at the source — only call the helper on values
that come from user input or from the form schema.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.
4.2 `pnpm --filter @splash/forms-worker build` — must succeed.
4.3 `pnpm --filter @splash/web build` — must succeed (uses
    `enqueueOutboundEmail` indirectly via the helper).
4.4 No worker / Supabase / R2 / wrangler.toml / secret changes
    EXCEPT the source code patches.
4.5 Operator post-deploy smoke (deferred):
    - Submit a new test form submission against the fixed worker
    - Click Approve with signature attached
    - Confirm: (a) transition succeeds (200, no `transition_failed`
      banner), (b) `form_submissions.status` flips to `"closed"`,
      (c) email step enqueues without 409 in logs, (d) PDF
      generates and lands as an attachment on the queued email row
    - Workers Logs for the splash-forms worker should show NO
      `[forms.admin] transition: PATCH failed`, NO
      `[forms.workflow.email-step] enqueue failed`, and NO
      `[forms.pdf] generation threw` entries for this transition
    - Negative test: re-submit the same logical email (re-trigger
      a transition into the same email step) — second enqueue
      should be a silent dedup (no 409), `was_duplicate` returns
      true

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 133 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Brief 133 (YYYY-MM-DD) — Three small correctness fixes that
    together unblock the workflow approval flow's terminal-
    outcome path. (a) Removed `status_updated_by: "system@workflow"`
    string write that 22P02'd against the `uuid` column type;
    `workflow_history` JSONB is the canonical audit. (b) Added
    `?on_conflict=...` query param to `enqueueOutboundEmail`'s
    PostgREST URL so dedup returns 201 with the existing row
    instead of 409. (c) Replaced hardcoded U+2192 with ASCII
    `->` in PDF workflow-history layout + added
    `sanitizeForWinAnsi` helper for user-generated strings
    interpolated into PDF text.

5.3 CLAUDE.md `forms-worker` glossary: append a one-liner under
    Brief 131 noting Brief 133 closed the `status_updated_by`
    type mismatch + email queue dedup behavior + PDF Unicode
    sanitization. Note the `sanitizeForWinAnsi` helper as the
    canonical home for future PDF Unicode issues. Note that
    `workflow_history` (not `status_updated_by`) is the
    canonical actor-audit surface for system-initiated status
    transitions.

## Out of scope

- Embedding a Unicode-capable TTF font in the PDF (would solve
  the encoding issue but adds 100–500 KB to the worker bundle —
  v2 candidate if operators want Unicode-rendered output).
- Changing `form_submissions.status_updated_by` from `uuid` to
  `text` — schema-invasive, breaks any future referential
  integrity, and `workflow_history` is the better canonical
  source anyway.
- Rebuilding the PDF layout to dispatch on field type for
  Unicode (e.g., emoji-heavy submitter notes). Flag any specific
  failures and address in a follow-up.
- The widening to other workers' Unicode interpolation sites
  (damage check-request PDF, etc.) — fix when surfaced.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `status_updated_by` no longer written with a non-UUID value in
  the system-initiated terminal-outcome auto-status path.
- `enqueueOutboundEmail` URL carries `?on_conflict=source_worker,
  source_kind,source_id,recipient`.
- `layout-workflow-history.ts` no longer writes `→` to drawText.
- `sanitizeForWinAnsi` helper added to `layout-utils.ts` and
  applied to every user-content interpolation site in the PDF
  layout files.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/forms-worker build` succeeds.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 5.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (line count + file count).
- Validation results.
- The full list of files touched.
- Whether Option 1 (drop column from patch) or Option 2 (sentinel
  UUID) was chosen for Bug A, with rationale.
- The full list of Unicode characters surfaced + their ASCII
  replacements in `sanitizeForWinAnsi`.
- Any other Unicode-spewing sites found during the audit (PDF
  files outside `pdf/layout-*.ts`).

## Outcome

### Diff summary

- **Files modified:** 9 (1 worker handler, 1 shared helper, 5 PDF
  layout files, 1 schema-style metadata file, 1 docs).
- **Files created:** 0.
- **Files deleted:** 0.
- **Approximate line count:** ~80 lines of source change (60 of which
  are `sanitizeForWinAnsi` + its wiring; 10 for Bug A; 10 for Bug B).

### Files touched

- `apps/forms-worker/src/admin/submissions.ts` — Bug A: dropped
  `status_updated_by` from the `statusPatch` inline type AND from the
  write site at line 670. Kept the optional column on `TransitionPatch`
  (in `db/admin-submissions.ts`) so a future caller writing a real
  UUID actor still works. Added a comment block explaining the column
  is `uuid` and pointing at `workflow_history[-1].actor_email` as the
  canonical system-actor audit.
- `packages/db-supabase/src/outbound-emails.ts` — Bug B: added
  `url.searchParams.set("on_conflict", "source_worker,source_kind,
  source_id,recipient")` matching the unique index in
  `supabase/forms-tables.sql`. Added a comment block explaining why
  `Prefer: resolution=ignore-duplicates` requires `on_conflict`.
- `apps/forms-worker/src/pdf/layout-utils.ts` — Bug C: new
  `sanitizeForWinAnsi(s: string): string` export (8 character
  mappings, see "Unicode surfaced" below). Sanitization inside
  `wrapText` (sanitize input before measure/wrap) and
  `truncateToWidth` (sanitize input + ASCII ellipsis). Defensive
  `sanitizeForWinAnsi(...)` wraps inside `drawLabelValue`,
  `drawSectionHeading`, `drawKeyValueGrid` for the label drawText
  sites. ASCII source literals: `"…"` → `"..."` ellipsis, every
  `"—"` placeholder → `"-"`.
- `apps/forms-worker/src/pdf/layout-header.ts` — Bug C: imported
  `sanitizeForWinAnsi`, wrapped `titleText` (operator-authored form
  title), changed `subText` `•` → `*`.
- `apps/forms-worker/src/pdf/layout-footer.ts` — Bug C: `BRAND_LINE`
  em-dash → hyphen.
- `apps/forms-worker/src/pdf/layout-payload.ts` — Bug C: imported
  `sanitizeForWinAnsi`, wrapped the two `cursor.page.drawText(
  label.toUpperCase(), ...)` sites at the signature + file label
  surfaces, changed every `"—"` placeholder in `stringifyScalar` /
  `renderChoice` / `renderFile` to `"-"`.
- `apps/forms-worker/src/pdf/layout-workflow-history.ts` — Bug C
  primary fix site: `const arrow = "→"` → `"->"`. Imported
  `sanitizeForWinAnsi`, wrapped `headerText` + `actorText` +
  `drawSubLabel` label. Changed `•` → `*` in `actorText`.
- `apps/forms-worker/src/pdf/layout-metadata.ts` — Bug C: every
  `"—"` placeholder for submitter/version/outcome fallbacks → `"-"`,
  outcome separator `" — "` → `" - "`.
- `BRIEFS/INDEX.md` — Brief 133 row inserted above Brief 132.
- `BUILD_STATE.md` — Last-updated bump + Findings entry prepended.
- `BRIEFS/brief-133-workflow-transition-three-bug-pass.md` — this
  file (Status → Completed, Outcome filled).
- `CLAUDE.md` — forms-worker glossary Brief 133 paragraph appended
  under the Brief 132 entry.

### Bug A — Option chosen

**Option 1 (drop column from patch)** was chosen.

Rationale: the brief explicitly noted operator preference for Option 1
unless explicit audit on `status_updated_by` is needed. The
`workflow_history` JSONB array already captures the operator who
triggered the terminal-outcome transition (in the immediately preceding
entry's `actor_email`), so the column being null for system-initiated
flips doesn't lose audit information. Option 2 (sentinel UUID const +
CLAUDE.md glossary line) was rejected as ceremony — no caller reads
the column today and the convention would need defending whenever a
future executor wonders why a magic UUID is in the codebase.

### Unicode characters surfaced + ASCII replacements

The `sanitizeForWinAnsi` mapping table:

| Codepoint | Char  | Name                  | ASCII replacement |
|-----------|-------|-----------------------|-------------------|
| U+2192    | `→`  | RIGHTWARDS ARROW      | `->`              |
| U+2190    | `←`  | LEFTWARDS ARROW       | `<-`              |
| U+2022    | `•`  | BULLET                | `*`               |
| U+2014    | `—`  | EM DASH               | `-`               |
| U+2013    | `–`  | EN DASH               | `-`               |
| U+201C    | `“`  | LEFT DOUBLE QUOTE     | `"`               |
| U+201D    | `”`  | RIGHT DOUBLE QUOTE    | `"`               |
| U+2018    | `‘`  | LEFT SINGLE QUOTE     | `'`               |
| U+2019    | `’`  | RIGHT SINGLE QUOTE    | `'`               |
| U+2026    | `…`  | HORIZONTAL ELLIPSIS   | `...`             |

The `→` and `•` were the user-visible offenders in current runtime
flows (workflow-history header + actor lines); the rest are added as
defensive mappings so the same class of bug doesn't bite when an
operator pastes typographic content from Word / iOS / Slack into a
form field's text.

### Other Unicode-spewing sites discovered during audit

Ran a Python scan of every `apps/forms-worker/src/pdf/*.ts` file
listing non-ASCII codepoints in non-comment runtime string literals.
**All offenders were within the `apps/forms-worker/src/pdf/layout-*.ts`
files** — no other Unicode-spewing sites in cascade-attach.ts /
generate.ts (those files have Unicode only in comments, which esbuild
strips at bundle time). The `sanitizeForWinAnsi` regex source itself
contains the Unicode chars being matched (necessary; the regex object
doesn't drawText anywhere).

**Cross-worker audit (deliberately out of scope per the brief):** other
workers' PDF generation sites — damage-worker's check-request PDF
(Brief 32) most notably — were NOT scanned. The `sanitizeForWinAnsi`
helper has a stable export from `apps/forms-worker/src/pdf/layout-utils.ts`
that the damage-worker could import (with a small refactor to avoid
the cross-worker dep) if/when that audit surfaces a bug. Flagged as a
v2 candidate in BUILD_STATE.md's latent-issues list.

### Decisions made on operator's behalf

1. **Option 1 for Bug A** over Option 2 — `workflow_history` JSONB is
   the better canonical audit surface than a sentinel UUID on a column
   nobody reads today.
2. **`on_conflict` column list copied verbatim** from the unique-index
   definition in `supabase/forms-tables.sql`, NOT inferred from the
   helper's prose docblock — schema is the authoritative source.
3. **Layered Unicode sanitization** (source literals → ASCII, helpers
   sanitize input, explicit wraps at direct drawText sites) is
   intentional redundancy — a future field type that bypasses the
   wrapText/truncateToWidth pipeline still gets sanitized at the
   drawText boundary.
4. **Defensive sanitization of Splash-owned labels** (drawLabelValue /
   drawSectionHeading / drawKeyValueGrid label arguments) is cheap —
   `sanitizeForWinAnsi` on a pure-ASCII string is O(n) regex scans
   returning the same string — and protects against a future caller
   passing a dynamic label.
5. **`sanitizeForWinAnsi` exported from layout-utils.ts** rather than
   scoped inline so cross-worker PDF surfaces can import when audited.
   A move to `@splash/storage-r2` or a new shared `@splash/pdf-utils`
   package is a candidate when (if) the second worker adopts.
6. **Brief 131's `TransitionPatch.status_updated_by?` schema entry
   preserved** as an optional column accepted at the DB layer — the
   immediate fix is purely "stop the caller from writing the bad
   value." Removing the schema entry would be a breaking-API change
   for no benefit.
7. **`"…"` ellipsis in `truncateToWidth` replaced with ASCII `"..."`**
   at source rather than relying on the sanitize helper to convert it
   — keeps the function self-contained + avoids a redundant regex on
   every truncate call.
8. **Source literal `"—"` placeholders replaced with `"-"` everywhere**
   rather than left for the sanitize helper to convert at runtime —
   keeps the source code WinAnsi-clean and grep-able.

### Latent issues / forward flags

- Other workers' PDF Unicode sites (damage check-request PDF,
  signup-worker's any future PDF, etc.) NOT audited or fixed per the
  brief's out-of-scope. Fix when surfaced.
- Fail-soft posture of Brief 129's PDF generator means future Unicode
  surprises will silently lose attachments. A "PDF attachment audit"
  surface on the admin email-queue viewer (Brief 128) — flagging rows
  where `attach_pdf: true` produced an attachment-free row — would
  help operators catch this proactively.
- `enqueueOutboundEmail`'s 3s clock-skew tolerance for `was_duplicate`
  detection: severe drift on the worker would mis-classify fresh
  inserts as duplicates. Operationally harmless (row still drains).
- Brief 131's `TransitionPatch.status_updated_by?` schema entry is now
  unused. Deletion candidate one cycle out if no caller picks it up.
- `sanitizeForWinAnsi`'s curly-quote character classes use the
  Unicode literals `[“”]` / `[‘’]` rather than `[“”]` /
  `[‘’]` escapes. Equivalent at the regex level; if a future
  TS config flips on a non-ASCII-source lint the literals would need
  swapping.

### Validation results

| Check | Result |
|---|---|
| `pnpm typecheck` (root, all 20 packages) | **PASS** — 18/18 successful (forms-worker + db-supabase + web ran fresh; rest cached; 8.314s wall) |
| `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build` | **PASS** — bundle 2013.01 KiB raw / 442.47 KiB gzipped (≈ +0.5 KiB raw / +0.15 KiB gzip vs Brief 131 baseline of 2012.50 / 442.32, all `sanitizeForWinAnsi` helper + source-literal swap). `.tmp-build` cleaned up after. |
| `pnpm --filter @splash/web build` | **PASS** — `/admin/forms/[id]` 37.9 kB / 145 kB First-Load JS unchanged from Brief 132; no other route size changed |

No worker / Supabase / R2 / wrangler.toml / secret changes.

### Operator post-deploy smoke (deferred per brief Phase 4.5)

1. Push triggers CF Workers Builds → splash-forms redeploys.
2. Submit a new test form submission against the deployed worker.
3. Click Approve with signature attached → expect HTTP 200, no
   `transition_failed` banner.
4. Inspect `form_submissions` row: `status` is `"closed"`,
   `status_updated_at` populated, `status_updated_by` is NULL.
5. Inspect `outbound_emails`: email step row enqueued (no 409).
6. Inspect Workers Logs: NO `[forms.admin] transition: PATCH failed`,
   NO `[forms.workflow.email-step] enqueue failed`, NO
   `[forms.pdf] generation threw`.
7. Inspect R2 `form-submission-pdfs/{form_id}/{submission_id}.pdf`
   → object exists. Next PA poll fetches the queue row + base64-
   inlines the PDF attachment.
8. Negative dedup test: re-trigger a transition into the same email
   step → second enqueue is silent (no 409, helper returns
   `was_duplicate: true`).
