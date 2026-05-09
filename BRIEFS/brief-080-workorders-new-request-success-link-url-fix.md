# Brief 80: Work Orders New Request — fix post-submit "View in MaintainX" link 404

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** The "View in MaintainX ↗" link on the New Request success
banner 404s. Operator submitted a work request 2026-05-09; banner
rendered with a link pointing at
`https://app.getmaintainx.com/workrequests/11706935` which 404'd
("Hmm! Looks like you're lost"). The actual MaintainX UI URL for
work requests is `https://app.getmaintainx.com/requests/{id}` —
operator confirmed by manually substituting the path and finding the
request rendered correctly.

**Dependencies:**
- Brief 74 (the brief that introduced the New Request banner with
  this link; the inferred URL pattern landed at L752 of brief-074
  with a "same pattern as work orders" rationale that turned out to
  be wrong).
- No code dependencies — one-line edit in
  `WorkOrdersTabsClient.tsx`.

## Read first

- CLAUDE.md (Work Orders glossary entry — Phase 4 of this brief
  extends it with the corrected URL pattern)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md
  (the introducer; L752 is the original inference site)
- apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx
  (the one file getting edited — line 227)

## Context

### What's wrong

`apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx` L227
constructs:
```tsx
href={`https://app.getmaintainx.com/workrequests/${banner.requestId}`}
```
That URL 404s in MaintainX. The actual UI URL is
`https://app.getmaintainx.com/requests/${banner.requestId}` (no
`work` prefix on the segment).

### Why the wrong URL landed

Brief 74's executor copied the work-ORDER URL pattern
(`/workorders/{id}`, used at L524 of the same file and at L523 of
`/admin/damage/[id]/page.tsx` — both correct for work-ORDERS) and
prefixed `work` onto the work-REQUEST segment by analogy. MaintainX
exposes work-orders at `/workorders/{id}` but work-requests at
`/requests/{id}` — the segments aren't symmetric. Same bug class as
Brief 74 → 75 → 76 (singular `/attachment/` vs plural `/attachments/`
on the API side): inferring a URL by analogy instead of probing the
real one. Operator caught it on the first post-deploy submit.

### What to NOT touch

The other UI URL `https://app.getmaintainx.com/workorders/${wo.id}`
at L524 of the same file is for work ORDERS (the row click-out from
the Reactive / Preventative tabs) — that's the correct pattern,
matches `/admin/damage/[id]/page.tsx:523`, leave it alone. Same for
the API URL comment at `NewRequestForm.tsx:132` referencing
`/v1/workrequests/{id}/attachments/{filename}` — that's the
MaintainX REST API path (different concept from the UI URL),
correct, leave alone.

### Lesson worth capturing

This is the third URL-by-analogy bug on the Work Orders feature:
- Brief 74 → 75 → 76: API path `/attachment/` (singular) vs
  `/attachments/` (plural). Brief 74 inferred from doc heading;
  Brief 75 retreated on wrong diagnosis; Brief 76 fixed with
  empirical evidence.
- Brief 80 (this one): UI path `/workrequests/{id}` vs
  `/requests/{id}`. Brief 74 inferred from work-order URL pattern.
- Brief 42 → 62: Supabase join-key on `pricing_simple.site` text
  with mismatched widths between `pricing_simple.site` (zero-padded)
  and `locations.site_number` (integer-as-text). Same bug class —
  inference instead of empirical probe.

The CLAUDE.md "Working with workers" / "MaintainX integration"
section gains a one-line warning: "Probe MaintainX URLs (UI and
API) before inferring; segments aren't symmetric across resources
(`/workorders/{id}` but `/requests/{id}`; `/v1/workrequests/{id}/
thumbnail/{filename}` singular but `/v1/workrequests/{id}/
attachments/{filename}` plural)."

## Scope

### Phase 1 — One-line URL fix

**File:** `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`

Change L227 from:
```tsx
href={`https://app.getmaintainx.com/workrequests/${banner.requestId}`}
```
to:
```tsx
href={`https://app.getmaintainx.com/requests/${banner.requestId}`}
```

That's it. The text content of the link ("View in MaintainX ↗"),
the link styling, the conditional `banner.requestId != null`
guard, the `target="_blank"` / `rel="noreferrer"` — all stay.

### Phase 2 — Sweep for any other `/workrequests/` UI URLs

Run `Grep` across the repo for `app\.getmaintainx\.com/workrequests`
to confirm L227 is the only site with this bug. Per the 2026-05-09
audit, it is — but a future surface (digest email, mobile widget,
scheduled-job notification) could grow another. If the sweep finds
others, fix them in the same brief. Do NOT touch:
- `app.getmaintainx.com/workorders/{id}` references (correct work-
  ORDER UI URL).
- `/v1/workrequests/{id}/...` references (correct API path; this
  segment IS plural for the REST API even though the UI segment
  isn't `workrequests` at all).

### Phase 3 — Validation

```sh
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
```
A full repo `pnpm typecheck` is overkill for a one-line text-content
edit but doesn't hurt.

Smoke test (after operator deploys):
1. Submit a New Request via `/workorders` form
2. Click "View in MaintainX ↗" on the green success banner
3. Confirm the new tab loads the work-request detail page (not
   the 404 page)

### Phase 4 — Update documentation

1. **CLAUDE.md** — under the existing Work Orders glossary entry
   (or under "Working with workers" if there's a more general
   integration block), add a sentence near the existing
   `app.getmaintainx.com/workorders/{id}` mention:
   > MaintainX UI URLs: work orders are at
   > `app.getmaintainx.com/workorders/{id}`; work requests are at
   > `app.getmaintainx.com/requests/{id}` (NO `work` prefix —
   > segments aren't symmetric). REST API paths are also
   > asymmetric (`/v1/workorders/{id}` for orders;
   > `/v1/workrequests/{id}/...` plural for requests).
   > Probe before inferring.

2. **BUILD_STATE.md** — bump "Last updated" to 2026-05-09 and add
   a Findings entry pointing at this brief, including the
   URL-by-analogy lesson and a list of the three bugs in this
   class (Brief 76, Brief 80, Brief 62) for future grep-ability.

3. **BRIEFS/INDEX.md** — append Brief 80 row.

4. **BRIEFS/QUEUE.md** — entry already appended; this brief
   self-checks.

## Definition of Done

- L227 of `WorkOrdersTabsClient.tsx` reads
  `href={\`https://app.getmaintainx.com/requests/${banner.requestId}\`}`
- Repo grep for `app\.getmaintainx\.com/workrequests` returns zero
  source-code matches (brief-074 reference at L752 stays — that's
  the historical inference site, archival).
- `pnpm --filter @splash/web build` succeeds.
- CLAUDE.md gains the URL-asymmetry sentence.
- BUILD_STATE.md "Last updated" bumped + Findings entry added.
- BRIEFS/INDEX.md row added.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)` with
  the `## Outcome` section filled in.

## Out of scope

- Refactoring brief-074 retroactively to remove the wrong
  inference. Keep it as historical record + use this brief's
  Outcome to point at it.
- Adding a runtime URL-validation step (HEAD request to MaintainX
  before rendering the link). Adds complexity and a network round-
  trip for every successful submit; one-line text fix is cheaper.
- A unit test asserting the URL string. Pure constant string in a
  template literal; the smoke test post-deploy is sufficient.

## Outcome

**Files modified:**

- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx` —
  L227: `https://app.getmaintainx.com/workrequests/${banner.requestId}` →
  `https://app.getmaintainx.com/requests/${banner.requestId}`. Surrounding
  link styling, conditional `banner.requestId != null` guard,
  `target="_blank"`, `rel="noreferrer"`, and link text ("View in MaintainX ↗")
  preserved verbatim per brief.
- `CLAUDE.md` — under the existing Work Orders glossary entry, appended
  a paragraph after the Brief 79 line documenting both UI URL forms
  (`app.getmaintainx.com/workorders/{id}` for orders;
  `app.getmaintainx.com/requests/{id}` for requests) and the asymmetric
  REST API path forms (`/v1/workorders/{id}` vs `/v1/workrequests/{id}/...`
  plural; with `/thumbnail/` singular but `/attachments/` plural
  underneath). Closes with "Probe before inferring — Briefs 76, 80, 62
  all closed bugs caused by inferring a path by analogy from a sibling
  resource (Brief 80 was the work-request UI URL caught on first
  post-deploy submit)" so future readers can grep this class.
- `BUILD_STATE.md` — `Last updated` preamble bumped (already 2026-05-09
  from Brief 79; extended with Brief 80 narrative); new Findings &
  decisions row inserted above the Brief 79 row.
- `BRIEFS/INDEX.md` — Brief 80 row's status flipped from `Ready for
  Claude Code` to `Completed (2026-05-09)` (row was already present).
- `BRIEFS/brief-080-workorders-new-request-success-link-url-fix.md`
  (this brief) — `Status:` flipped to `Completed (2026-05-09)`; this
  Outcome section filled in.

**Files created:** none.

**Files NOT modified (intentional, per brief's `What to NOT touch`):**

- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx:524`
  (`https://app.getmaintainx.com/workorders/${wo.id}`) — correct
  work-ORDER UI URL for the row click-out from the Reactive /
  Preventative tabs.
- `apps/web/app/admin/damage/[id]/page.tsx:523` — same correct
  work-ORDER UI URL pattern, used by the Brief 42 / 43 WO-create
  surface to link from a damage claim into the resulting MaintainX
  work order.
- `apps/web/app/workorders/_components/NewRequestForm.tsx:132` — the
  comment referencing `/v1/workrequests/{id}/attachments/{filename}`
  is the MaintainX REST API path (the correct plural form per Brief
  76), not a UI URL. Different concept; left alone.
- `BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md:752`
  — the historical inference site documented in the original brief.
  Per Brief 80's "Out of scope" call, kept as historical record;
  this brief points at it instead of rewriting it.

**Sweep grep result.** Per Phase 2, ran `Grep` for
`app\.getmaintainx\.com/workrequests` repo-wide. Five remaining matches
after the source fix, all intentional doc / brief references:

- `BUILD_STATE.md:121` — Brief 74's narrative (historical).
- `BRIEFS/brief-080-workorders-new-request-success-link-url-fix.md` L8,
  L40, L98 — this brief's bug description (cites the wrong URL as the
  canonical "what was wrong" reference).
- `BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md:752`
  — the historical inference site.
- `BRIEFS/INDEX.md:88` — this brief's row in the index, which cites
  the wrong URL when describing the bug.

Zero `.tsx` / `.ts` / production-code source matches. The DoD
"source-code matches" bar is met.

**Decisions made on operator's behalf.** None of substance. The brief
was a one-line text edit with prescribed Phase 4 doc updates; only
local choices were:

- Where to place the CLAUDE.md URL-asymmetry paragraph: chose to fold
  it into the existing Work Orders glossary entry (`## Glossary` →
  `**Work Orders**`) right after the Brief 79 line, since that's the
  block CLAUDE.md instructs readers to consult before working on the
  Work Orders feature. The brief offered "or under 'Working with
  workers' if there's a more general integration block" as an
  alternative — chose the glossary block because the asymmetry
  applies specifically to MaintainX UI URLs, and the existing
  `app.getmaintainx.com/workorders/{id}` mention sits in the Work
  Orders entry.
- Whether to enumerate the API path detail as well as the UI path
  detail: the brief's prescribed sentence covers both, so I included
  both. Future reader looking up "why is `/attachments/` plural but
  `/thumbnail/` singular?" finds the answer in the same paragraph as
  "why is the work-request UI URL `/requests/` not `/workrequests/`?"

**Latent issues / forward flags.**

- **Build infrastructure.** First `pnpm --filter @splash/web build`
  attempt aborted with `TypeError: fetch failed [cause]: Error: bad
  port` from Next.js's build worker via undici 7.24.8. Identical
  symptom to the transient documented in Brief 78's outcome — the
  Next telemetry/build-worker init reaches out over the network at
  startup, and a malformed URL in env or a transient blip in the
  network stack returns the bad-port error. Second attempt clean.
  Not a blocker for this brief (the diff is a pure constant-string
  swap inside a JSX template literal — no build-mechanic impact)
  but if this becomes more than once-per-day for the operator,
  worth a forward investigation: trace which env var is the source
  of the bad-port URL, or pin Next/undici to a version known to
  retry on this error.
- **MaintainX URL audit.** This brief's Phase 2 sweep covered the
  `/workrequests/` UI URL specifically. There may be other
  resource-level URL patterns in MaintainX worth probing — e.g., if
  apps/web ever surfaces a deep link to a MaintainX **asset** page
  or **location** page or **part** page, the executor of that brief
  should empirically open the URL in their browser before committing
  the inferred path. The CLAUDE.md paragraph this brief added is
  the deterrent against future executors making the same mistake.
- **No runtime URL validation.** The brief explicitly ruled out a
  HEAD-request URL probe before rendering the link (cost / network
  round-trip vs. one-line fix). If MaintainX ever changes its UI
  URL scheme (or renames `/requests/` to something else), the
  banner link will silently 404 again with no in-app detection.
  Mitigation: operator post-deploy smoke test in Phase 3 below
  catches it on first submit, same as today.

**Validation results.**

- `pnpm --filter @splash/web typecheck` → green (apps/web cache-missed
  and re-typechecked clean).
- `pnpm --filter @splash/web build` → green on retry (first attempt
  aborted with the transient bad-port error documented above; second
  attempt clean; Next.js 15.5.15 compiled in 4.3s; all 13 routes
  generated; `/workorders` route bundle 5.39 kB / 107 kB First Load
  JS — no observable delta vs the Brief 79 baseline of 5.39 kB,
  consistent with a pure constant-string swap).
- Smoke test deferred to operator post-deploy per Phase 3: submit a
  New Request via `/workorders` form, click "View in MaintainX ↗"
  on the green success banner, confirm the new tab loads the
  work-request detail page (not the 404 page).
