# Plan: personnel forms — who can see what

Status (2026-11-13): Phase 1 done (tables, view, seed, location sync, and the
"Personnel placement" sysadmin card). Phase 2 (Employee field) built, not yet
pushed/tested live. Phases 3-4 not built.
The decisions this plan implements are logged in `BUILD_STATE.md`
(2026-11-13, "Decided (planning only, NOTHING BUILT): forms organisation and
personnel-form security"). This file is the build order, not a second copy of
those decisions.

Each phase is usable on its own and ships separately. Nothing in a later phase
is needed for an earlier one to be worth having.

---

## The idea in one paragraph

A personnel form (warning notice, pay change, termination, injury report) is
*about* someone — the **subject**. Whoever reads it must (a) hold the grant for
that kind of document, (b) cover the subject's site, and (c) sit at a **higher
org level** than the subject. Peers and the subject themselves can't read it.
Levels and departments come from a small editable table, seeded from the
operator's spreadsheet, rather than being worked out from Beekeeper titles at
run time.

---

## Phase 1 — Placements table

**What you get:** one place that says, for each employee, their org level
(1–8), department, and where they actually work. Nothing reads it yet; it is
the foundation.

- New table `personnel_placements`, keyed by Beekeeper user id:
  `level` (1–8, nullable), `department` (fixed list), `works_at`
  (`site` / `office_011` / `office_101` / `regional`), `notes`,
  `updated_at`, `updated_by`.
- New table `beekeeper_locations`: Beekeeper location (org unit) id → name →
  Splash `site_number`. Names synced from Beekeeper; site numbers auto-matched
  where the name contains one ("Cortland - 126"), the rest filled once by hand.
  101 = Grubka-area management, 011 = SMG.
- Seeded once from `C:\Users\Coppsrv\Documents\forms-personnel-placements-2026-11-13.xlsx`
  by a script run from this machine. **The seed data is NOT committed** — it
  names employees and their levels. Only the table definitions go in the repo.
- `personnel_title_levels`: Beekeeper job title → default level (GM 3,
  AGM 2, site titles 1). Covers the ~1,500 ordinary site staff, who have no
  placement row. Editable, not in code.
- View `personnel_effective`: level = placement, else title, else 7.
- Rules the table encodes:
  - No placement and no recognised title → treated as **level 7** when deciding who can read
    *their* records (only executives and HR leadership). Safe direction.
  - Level grants nothing by itself. It only decides who sits above whom.
- Editing: a small super_admin-only page under `/admin/sysadmin` to change a
  person's level / department / works-at, every change written to
  `sysadmin_audit_log`. (Until that page exists, edits are SQL.)

**Done when:** both tables exist, the seed has run, unmatched Beekeeper
locations are listed for a one-time fill, and a new hire with no row behaves as
level 7.

**Size:** small. Two SQL files, one seed script, one sync addition to
beekeeper-worker, one sysadmin card.

---

## Phase 2 — Site-filtered employee picker

**Opt-in only:** Employee is one more field type in the builder's palette.
It appears only on forms where someone adds it; no existing form changes and
nothing adds it automatically.

**What you get:** a new form field type, **Employee**, that searches the
Beekeeper roster. When the form has a site field, the search shows only that
site's people. Usable on any form, personnel or not — this is the field the
later phases hang the "subject" on.

- Roster for a site = people in that site's Beekeeper location(s), **minus**
  anyone whose placement says office (011 / 101) or regional. Office staff
  wrongly filed at a site in Beekeeper (the Greenwich cases) therefore never
  appear in a site's list.
- Site 011 or 101 on the form → office / management people for that group.
- Works on link-only forms (no sign-in) because the search is scoped by the
  site the filler typed, not by who they are. Returns name + title only.
- **No match? Type the name.** If the person isn't in the list (new hire not
  in Beekeeper yet, a misspelling in Beekeeper), the filler types the name
  and submits. The form still routes exactly as it would otherwise — routing
  goes by the site on the form, not by who the subject is — so the right
  people still get it. The submission is marked **unverified subject**.
- For the Phase 3 access rule, an unverified subject at a real site counts as
  **site staff (level 1)** at that site, so the site's HRT / RM / GM can still
  read it. To stop that being a way round the rule, a typed name that closely
  matches anyone on the roster (any site or office) is refused with "did you
  mean …?". HR can later link the submission to the real Beekeeper person,
  and the rule then uses that person's actual level.
- Stored value: Beekeeper user id + name as shown at the time, or the typed
  name with `unverified: true`.
- Builder: one new field type in the usual 6 places (schema type, Zod config,
  payload validator, public renderer, builder renderer + inspector).

**Done when:** a Greenwich form shows Greenwich site staff and not Caitlin,
Melissa or Avery; a form set to 011 shows office staff; a form with no site
field shows a "pick a site first" message.

**Size:** medium. Mostly the new field type; the roster query reuses the
shift-scheduling pattern (`org_unit_ids` containment).

---

## Phase 3 — Confidential forms and the access rule

**What you get:** a form can be marked **confidential**, and its submissions
are then readable only under the rule above. This is the phase that makes it
safe to move warning notices etc. off JotForm.

Form settings (builder Settings tab):
- **Department** (fixed list) and **Sensitivity**: standard / site-restricted /
  confidential. Standard = today's behaviour, unchanged.
- **Subject field**: which Employee field the record is about (required for
  confidential).
- **Document type** (warning notice, pay change, termination, injury report…)
  — what the read grant is for.

Who can read a confidential submission — ALL of:
1. A grant for that document type (defaults from department × level, with
   per-person add/remove; changes logged).
2. Coverage of the subject's site (`locations.hrt_email`/`hrt1`/`hrt2`,
   `rm_email`, `am_email`; office/regional people by their placement).
3. Level strictly above the subject's. Department heads also see their own
   department's records below them.

Plus: the people acting on that submission's workflow (approvers, history
actors) still see it — otherwise acting on a ticket would hide it.

Applies everywhere a submission can leak, not just the detail page:
submissions list and wide table, CSV export (confidential rows excluded),
Pending Approvals / My Requests, emailed copies (recipients filtered by the
same rule; email carries a link, not the content, unless the email *is* the
delivery), PDF attachments, and worker logs (no payload values).

The existing paths that would bypass this — admin tier, the
`form_submissions` tool grant, access tags, CRD coverage — are switched off
for confidential forms. Admins get in only via Phase 4.

**Done when:** a test warning notice about a GM is readable by that region's
HRT and RM, not by another GM, not by another region's HRT, not by the GM
themselves, not by a plain admin; and it does not appear in a CSV export.

**Size:** the big one. Split into two briefs: (3a) form settings + the rule +
detail/list/export; (3b) emails, PDFs, approvals views, logs.

---

## Phase 4 — Testing → live switch and break-glass

**What you get:** while a form is in **testing**, super_admins see its
submissions normally (for building and bug-fixing). Flipping it **live** ends
that: from then on a super_admin reads a confidential submission only by
"acting as" with a logged reason.

- Per-form `live_at` timestamp; the flip is one-way from the UI (reverting is
  SQL and logged).
- Break-glass: typed reason, time-limited (e.g. 2 hours), banner while active,
  permanent log row, and a notice to HR leadership. Built on the existing
  impersonation grant and banner, not a second mechanism.

**Done when:** after flipping live, opening a confidential submission as a
super_admin shows the break-glass prompt, and using it leaves a log row and a
notice.

**Size:** small–medium, mostly reuse of impersonation.

---

## Alongside Phase 3 — organising the forms list

Department and sensitivity on each form (added in Phase 3) also drive the
`/admin/forms` and `/forms` lists: filter and group by department; confidential
forms marked as such. No separate phase needed.

## Later, not scheduled

- **Retention:** purge injury-report contents 90 days after their workflow
  completes, leaving a stub. Only injury reports; everything else stays under
  restricted access until HR decides. A small cron job once Phase 3 exists.
- Moving the actual personnel forms off JotForm, one at a time, after Phase 3.

---

## Open items (none block Phase 1)

- 19 people are "Not sure" for where they work and 3 have no level in the
  spreadsheet. They default safely (Beekeeper location for the picker, level 7
  for visibility) and can be fixed one row at a time.
- Which Beekeeper location is the unnamed 6-person management group
  (`f3444c5a…`) — resolved automatically once location names are synced in
  Phase 1.
- Default grants per department × level — drafted as a table for review at the
  start of Phase 3, not before.
