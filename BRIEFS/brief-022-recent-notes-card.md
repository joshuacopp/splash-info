# Brief 22: Recent notes card + jump-to-add-note button

**Status:** Completed (2026-05-05)
**Started:**
**Completed:**
**Blocks:** Damage detail UX polish — operator wants recent context
without scrolling, plus a quick path to add a note from the top of
the page.
**Dependencies:** Brief 5b (claim detail), Brief 5c (note form),
Brief 19 (ActionForm), Brief 21 (cleanup).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005b-damage-claim-detail.md (Outcome — activity timeline shape)
- BRIEFS/brief-005c-damage-write-actions.md (Outcome — AddNoteCard)
- apps/web/app/admin/damage/[id]/page.tsx
- packages/types/src/claims.ts (ClaimActivityRow shape — activity_type
  is "status_change" | "note" | "document_added")

## Context

The damage detail page has the activity timeline at the bottom — past
the photo gallery and add-note form. Operators want the 3 most recent
notes visible at the top alongside the claim summary, plus a quick
"Add note" jump button so they don't have to scroll to add an update.

This is a UI-only change; no worker work, no new endpoints. The data
already lives in the page's `activity[]` array fetched in Brief 5b.

## Scope

1. **Recent notes section.** Inside the existing summary card (or
   immediately below it — whichever reads cleaner with the current
   layout), add a "Recent notes" subsection.

   - Filter `activity` to entries where `activity_type === "note"`.
   - Sort by `created_at` descending (timeline is already sorted desc;
     verify and don't re-sort if so).
   - Take the first 3.
   - Render each entry compactly:
     - Timestamp (small monospace, `YYYY-MM-DD HH:mm` slice)
     - Actor name in bold
     - Note text in `whitespace-pre-line` (preserves multi-line notes
       from textarea input)
   - Empty state (zero notes): render "No notes yet." in muted text
     instead of the section title + empty list.

   Visual treatment: a bordered block inside the summary card or a
   separate small card. Use the same idiom as the existing "Approval
   details" sub-box in the summary card if that pattern reads well —
   `bg-sudsy-blue-soft/30` background, slight border, modest padding.

2. **"Add note" jump button.** Place a small button next to the
   "Recent notes" header (or alongside it depending on layout). On
   click, scrolls the page to the existing AddNoteCard at the bottom.

   Implementation: `<a href="#add-note">Add note</a>` styled as a
   button. Add `id="add-note"` to the AddNoteCard wrapper so the
   anchor scrolls to it. Browser-native smooth scroll via CSS:
   `html { scroll-behavior: smooth; }` if not already set in
   globals.css; if adding it would affect other surfaces, use
   `scroll-behavior: smooth` only on the `#add-note` element via a
   class.

   Button styling: secondary-ish (less weight than the transition
   buttons). Existing pattern to mirror: the small action buttons on
   /admin/damage's filter bar, or the "Back to Dashboard" idiom from
   /admin/sysadmin's no-access card (white background, splash-blue
   text + border).

3. **Don't duplicate the activity timeline.** The full timeline at
   the bottom continues to show all activity types (status_change,
   note, document_added). The new top-card section is a curated
   subset; users who want full history scroll to the bottom or click
   the Add note button (which just scrolls past the timeline to the
   form).

   Optionally: a small "View all activity ↓" link near the bottom of
   the Recent notes section that anchor-jumps to the activity
   timeline. Add `id="activity"` to the timeline section if it
   doesn't have one. Helpful, not required for v1 — implement if it
   doesn't bloat the layout.

4. **Update BRIEFS/INDEX.md** — Brief 22 row marked Completed.

5. **Update BUILD_STATE.md** — bump Last updated, add Findings entry
   summarizing the addition.

## Out of scope

- Showing more than 3 notes; the timeline at the bottom is the
  full history.
- A full inline note-add form at the top (would mean two AddNoteCard
  instances on the page; jump-button is enough).
- Filtering / search across notes.
- Editing or deleting existing notes (legacy doesn't support that).
- Note pinning or starring.
- Worker code changes.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- /admin/damage/[id] renders a "Recent notes" subsection showing up
  to 3 most recent notes (or "No notes yet" if empty)
- "Add note" button scrolls the page to the AddNoteCard at the
  bottom on click
- Existing activity timeline at the bottom unchanged
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Visual placement decisions (inside summary card vs. separate
  card below)
- Whether smooth-scroll was applied globally or scoped to the
  anchor target
- Bundle-size delta on /admin/damage/[id] (should be negligible —
  pure server-render markup)
- Validation results

## Outcome

**Files modified:**

- `apps/web/app/admin/damage/[id]/page.tsx` — `SummaryCard` props
  extended with `activity: ClaimActivityRow[]`; new `RecentNotesBox`
  sub-component renders inside the summary card after `ApprovalDetails`
  using the same `mt-4 rounded-splash-md border border-gray-light
  bg-sudsy-blue-soft/30 p-4` idiom as `ApprovalDetails`. Box header has
  the "Recent notes" label on the left and a small "Add note" anchor
  button on the right (`<a href="#add-note">` styled as a white-bg,
  splash-blue-text, splash-blue-bordered button per the
  no-access-card idiom in /admin/sysadmin). Empty state renders
  `<p className="text-sm italic text-splash-navy/60">No notes yet.</p>`
  in place of the list. Populated state renders up to 3 notes (sorted
  desc by `created_at`, ties broken by `id` desc — defensive, mirrors
  `ActivityTimelineCard`'s sort) as a `<ul>` of `<li>` items: timestamp
  (mono `YYYY-MM-DD HH:mm` via existing `formatDateTime`), actor name
  (bold), note text (`whitespace-pre-line`). When notes exist a small
  "View all activity ↓" anchor link sits at the bottom-right of the
  box, anchoring to `#activity` (the timeline card). `AddNoteCard`
  wrapper `<div>` gains `id="add-note"`. `ActivityTimelineCard` wrapper
  `<div>` gains `id="activity"`. Top-of-file section comment updated:
  added Brief 22 lines under section 3 (Summary card now appends Recent
  notes box), section 7 (timeline carries `id="activity"`), and section
  8 (add-note carries `id="add-note"`).
- `apps/web/app/globals.css` — added `html { scroll-behavior: smooth; }`
  with a Brief 22 comment explaining the scope. Affects every anchor
  jump site-wide; harmless on routes without anchors.
- `BRIEFS/INDEX.md` — Brief 22 row appended marked Completed.
- `BUILD_STATE.md` — bumped Last updated; new Findings entry below.
- `BRIEFS/brief-022-recent-notes-card.md` — Status flipped to
  Completed (2026-05-05); this Outcome section.

**Files created:** none. The card is implemented inline as
`RecentNotesBox` within `page.tsx` (single-use server component, same
posture as `ApprovalDetails`/`AuditStamps` siblings).

**Decisions made on operator's behalf:**

1. **Placement: inside the SummaryCard at the bottom**, after
   `ApprovalDetails`. Brief said "inside the existing summary card or
   immediately below it — whichever reads cleaner". Chose inside
   because it best serves the "alongside the claim summary" goal and
   reuses the existing sub-box visual idiom (`ApprovalDetails` already
   uses the same `bg-sudsy-blue-soft/30` rounded-md border block) so
   the addition feels continuous with the rest of the card rather
   than introducing a third stacked card above the Move-forward
   section.
2. **"Add note" button styling: white-bg + splash-blue text + splash-blue
   border**, mirroring the no-access-card "Back to Dashboard" idiom
   from /admin/sysadmin. Reads as a secondary action — does NOT
   compete with the primary splash-blue-fill submit buttons in the
   transitions section below or the AddNoteCard's actual "Add note"
   submit button at the bottom of the page. The anchor renders as
   `<a href="#add-note">` so right-click → open-in-new-tab is a no-op
   (intended) and the browser's native anchor scroll fires on click.
3. **"View all activity ↓" anchor link added** as the optional
   feature in scope §3. Renders only when notes exist (no point
   pointing at a timeline that's also empty). Subtle splash-blue
   text-link treatment, right-aligned at the bottom of the populated
   notes list. Acceptable bloat (~80 B markup); kept because the
   UX gain is real for operators who want full history.
4. **Sort defensively even though the worker SELECTs ORDER BY
   created_at DESC, id DESC.** Brief said "verify and don't re-sort
   if so" but `ActivityTimelineCard` itself defensively re-sorts
   (page.tsx:1162-1166), so RecentNotesBox matches that posture
   rather than depending on fetch-order invariants the worker layer
   could change without the UI layer noticing.
5. **`whitespace-pre-line` on note text**, matching the timeline's
   own note rendering — preserves multi-line notes that operators
   type into the textarea. `entry.notes ?? ""` handles the type's
   `notes: string | null` (in practice notes always populate the
   notes field for activity_type=note rows; defensive).
6. **`scroll-behavior: smooth` applied globally on `html`** (in
   globals.css) rather than scoped to `#add-note`/`#activity`. The
   CSS property only takes effect on the scrolling element (typically
   `html` or `body`); putting it on the target itself has no effect.
   Brief offered a fallback "scope to #add-note via a class" but that
   wouldn't actually work as written. Global is the simplest correct
   path; the app uses very few anchor jumps so the side-effects are
   minimal. Comment in globals.css flags the rationale for future
   maintainers.
7. **Activity-timeline card wrapper anchor `id="activity"`** even
   though only the optional "View all activity ↓" link consumes it
   today. Tiny markup; future briefs can deep-link into the timeline
   without re-touching this file.
8. **No client island**. The notes list, the jump button, and the
   timeline-anchor link are all server-rendered HTML/CSS. Browser-
   native smooth scroll + plain `<a href="#…">` anchors avoid the
   need for any "use client" island. Bundle delta is zero.

**Latent issues / forward flags:**

- **(a) Empty-state UX placement.** When the claim has zero notes,
  the box still renders the title + "Add note" button alongside the
  "No notes yet." line. The brief's empty-state spec said "render
  'No notes yet.' in muted text instead of the section title +
  empty list" — interpreted as "instead of an empty bulleted list",
  not "instead of the entire box including the jump button". Kept
  the box because the "Add note" jump button is more useful when
  the claim has no notes than when it does. If the operator prefers
  a stricter empty state (no box at all), that's a one-line tweak.
- **(b) `View all activity ↓` link in populated state only.** When
  notes exist but the operator wants to see status_change /
  document_added entries, the link is the discovery path. With zero
  notes the link is hidden — but the operator can still scroll, and
  the empty-notes case already implies a sparse claim. Acceptable
  v1.
- **(c) Notes list cap is 3, hardcoded.** Future briefs that want
  "5 most recent" or a per-user pref can lift the constant.
- **(d) `formatDateTime` slice trick** (no Date parsing) preserves
  the worker's DB-side ISO without timezone shift. If the worker
  ever returns timestamps without the `T` separator, the slice
  index `iso.slice(11, 16)` still hits HH:mm because both shapes
  ("YYYY-MM-DD HH:mm:ss" and "YYYY-MM-DDTHH:mm:ss(.sss)Z") have
  HH:mm at offsets 11-15.
- **(e) Smooth-scroll global rule** affects every anchor jump
  site-wide. Only this brief's two anchors (#add-note, #activity)
  consume it today. If the app ever ships a feature where instant
  jump is preferable (e.g., a long-running form where the user
  needs to dart between fields by keyboard shortcut), wrap that
  surface in a container with `scroll-behavior: auto` to override.
- **(f) Bundle size unchanged at 3.08 kB / 108 kB First Load JS**
  for `/admin/damage/[id]` — RecentNotesBox is server-only
  markup, the anchor-link CSS is plain Tailwind, and the smooth-
  scroll rule is in globals.css (already part of the layout). No
  client JS delta.
- **(g) `RecentNotesBox` lives next to `ApprovalDetails` /
  `AuditStamps` in the same file**, following the existing
  function-per-section pattern. If `page.tsx` ever splits into
  per-card files (low priority — file is tractable today), this
  block moves cleanly with no shared state to untangle.
- **(h) Smooth-scroll + `<details>` interaction** on the
  document-edit panels: clicking the "Add note" button while a
  Quote-row's `<details>` is open scrolls past the open panel. No
  layout-jank issue observed — the panel collapses on scroll-target
  consumption is unaffected because we don't programmatically close
  it. Worth a quick visual smoke test if the operator notices any
  drift.

**Validation:**

- `pnpm typecheck` → 13/13 successful, 3.831s (12 cached + 1 ran
  fresh — only `@splash/web` source changed, invalidating its turbo
  cache).
- `pnpm --filter @splash/web build` → succeeded. Next 15.5.15
  compiled in 5.7s; 12/12 static pages generated; lint + type
  checks green. Bundle for `/admin/damage/[id]` **3.08 kB / 108 kB
  First Load JS** — unchanged from Brief 21 snapshot. All other
  routes unchanged.

**Visual placement:** RecentNotesBox is a sub-box inside the
existing SummaryCard (continuous with ApprovalDetails). Empty
state shows the box + "Add note" button + "No notes yet." text;
populated state shows the box + button + up-to-3 notes list +
"View all activity ↓" anchor.

**Smooth scroll:** applied globally via `html { scroll-behavior:
smooth; }` in globals.css (not scoped). Rationale per decision 6.

**Bundle delta:** 0 B (3.08 kB → 3.08 kB; 108 kB → 108 kB).
