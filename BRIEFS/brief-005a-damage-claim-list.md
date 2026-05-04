# Brief 5a: Damage claim list page (/admin/damage)

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Admin-facing UI parity (functional via curl today)
**Dependencies:** Brief 1 (login), Brief 2 (Header), Brief 4 (dashboard tile linking here)

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- AUDIT_REPORT.md (section 5 — claims UI state)
- apps/damage-worker/src/index.ts (especially lines 313-385 for the list +
  detail endpoints, the dc_role scoping logic, and the filter contract)
- packages/types/src/claims.ts (ClaimRow, ClaimStatus, LifecycleState,
  DamageRole)
- packages/types/src/session.ts (Session.dcRole, Session.role)
- apps/web/app/admin/pricing/page.tsx (reference pattern for a real,
  filter-driven server-component admin page)
- apps/web/app/admin/pricing/_lib/worker-fetch.ts (reference pattern for
  the per-tool worker-fetch helper with the cross-origin dev fork)
- apps/web/app/_lib/worker-urls.ts (damageUrl helper)
- legacy/damagemanager.js — sections around `renderManagerList` (search
  for that identifier; the legacy worker rendered the manager UI inline,
  this is the visual reference)

## Context

Brief 5 is the damage-manager UI port. It's too large for a single headless
brief, so it's split into four sub-briefs that ship sequentially:

  5a — claim list page at /admin/damage (this brief)
  5b — claim detail at /admin/damage/[id] (read-only)
  5c — write actions on detail (transitions, notes, check-request PDF preview)
  5d — documents (Quote/Receipt upload, edit, delete, photo modals)

This brief is 5a only. Out-of-scope work for this brief stays out — leave
TODO comments where 5b/5c/5d will plug in, but don't pre-build anything.

The damage-worker exposes the JSON API at /manage/api/* and is fully
ported (per BUILD_STATE.md). The route is auth-gated server-side via
checkToolAccess(session, "claims") and dc_role scoping (super_admin/admin
see everything; gm/rm see only their dcLocations). On 403 "no damage role
assigned" the user genuinely has no access — render that state cleanly,
don't try to recover.

The /admin/damage page in apps/web is currently a Step-4 placeholder. The
Header's Dashboard tile already routes here via Brief 4.

## Scope

1. Damage worker-fetch helper (new file).
   - Create `apps/web/app/admin/damage/_lib/worker-fetch.ts`.
   - Mirror the pattern in `apps/web/app/admin/pricing/_lib/worker-fetch.ts`
     verbatim, swapping the env var:
        - Use `process.env.NEXT_PUBLIC_DAMAGE_WORKER_URL` for the dev
          cross-origin shortcut.
        - Same fallback to host-based absolute URL construction for
          production same-origin.
        - Same cookie forwarding via `cookies()` from `next/headers`.
        - Same null-on-401/403, throw-on-other-non-2xx contract.
   - The function name should be `damageGetJson<T>(path: string)` to mirror
     `workerGetJson` from pricing, but in a damage-namespaced location so
     future damage-worker calls don't share state with pricing.
   - Document the same comment-block context as the pricing helper
     (cross-origin dev caveat + production same-origin assumption).

2. Replace `apps/web/app/admin/damage/page.tsx` placeholder with a real
   server-component list page.

   Filter contract (from damage-worker GET /manage/api/claims, see
   apps/damage-worker/src/index.ts:313-358):
     - `search`    — substring on customer_name (string, optional)
     - `location`  — single location_code OR "All" (default "All")
     - `status`    — full ClaimStatus string OR "All" (default "All")
     - `lifecycle` — "Open" | "Closed" | "All" (default "Open" — matches
                     the legacy default)

   Page shape:
     - Server component reads `searchParams` (Next.js 15+ async).
     - Builds a query string honoring the four filters; missing/empty
       filter values omitted from the request.
     - Calls `damageGetJson<ClaimRow[]>("/manage/api/claims?...")`.
     - Renders a `<form method="GET">` filter bar at the top — the form
       action is the same path (`/admin/damage`), each filter input is a
       named field, submit re-navigates with new query string. Server-
       rendered, no client JS needed for the filter form itself.
     - Below the filter bar, render the claims table OR an empty/no-access
       state per branch.

   Filter UI:
     - `search` — `<input type="text" name="search" defaultValue={...}>`
       with placeholder "Search customer name…".
     - `location` — `<select name="location">` with `<option value="All">All
       locations</option>` plus one option per location_code observed in
       the result set so far. Since the worker doesn't currently expose a
       /manage/api/locations endpoint, derive the options from a uniqued
       set of `claim.location_code` values across the results (using
       location_pretty as the label). This is a v1 compromise — not perfect
       (locations with zero matching claims won't appear) but acceptable
       and avoids touching worker code.
     - `status` — `<select name="status">` with "All" + every value of
       `ClaimStatus` from `@splash/types/claims` (15 values, ordered as in
       the type union for legibility). Use status string verbatim — the
       worker validates against the same enum.
     - `lifecycle` — `<select name="lifecycle">` with "Open" (default),
       "Closed", "All".
     - Submit button labeled "Apply filters".

   Results table:
     - Columns (left to right):
       1. Claim ID (short hash; clickable link)
       2. Customer name
       3. Vehicle (year + make + model — comma-joined, "—" if all null)
       4. Location (location_pretty + small location_code below it in monospace)
       5. Status (`claim.claim_status`)
       6. Lifecycle (small badge — green for Open, gray for Closed)
       7. Submitted (formatted as `YYYY-MM-DD`)
     - Each row is a clickable `<Link>` (or wraps the row in one) to
       `/admin/damage/{claim_id}`. That detail page lands in Brief 5b — a
       placeholder is acceptable until then; do NOT create it as part of
       this brief beyond ensuring the link target won't 404 catastrophically
       (the existing /admin/damage/page.tsx behavior is fine; if there's no
       /admin/damage/[id] route at all, Next.js 404s, which is acceptable
       and gets fixed in 5b).
     - Use Tailwind only — no inline `style={{ ... }}` like the older
       pricing pages. Match the visual idiom of the dashboard tiles
       (`rounded-splash-lg`, `border`, `shadow-splash-card`, white card
       background, splash-navy text). The list itself can be a simple
       table inside one outer card.

   States to handle explicitly:
     - `damageGetJson` returns `null` (401/403):
       - Render "You don't have access to Damage Claims" message + Sign
         In button (mirror the Brief 11 pattern from the pricing page —
         button styling, ?return=%2Fadmin%2Fdamage encoded once).
     - `damageGetJson` throws (5xx, network, malformed):
       - Server component renders an error card with the message; no
         retry button (page reload retries).
     - Empty result set:
       - "No claims match these filters." Suggest clearing filters
         (Show all claims link with no query string).
     - dcRole === "denied" path:
       - The worker returns 403 "no damage role assigned" for this case.
         damageGetJson returns null → falls into the no-access branch
         above. Distinguishing "no claims tool grant" from "no damage role"
         requires inspecting the response body, which damageGetJson
         currently throws away. Acceptable v1 — the message text is
         generic enough to cover both.

   Page banner (above filter bar):
     - "INTERNAL TOOLS" eyebrow (sudsy-blue, uppercase, tracked) + h1
       "Damage Claims" — same pattern as the dashboard banner. The global
       Header is already global; this is the per-page hierarchy marker.

3. Update BUILD_STATE.md per its Conventions:
   - Bump "Last updated"
   - Add a Findings entry summarizing what changed and any latent issues
     (especially the location-dropdown compromise + the 403 disambiguation
     limitation)
   - Mark item 5 in the prioritized work list as "in progress (5a/5b/5c/5d)"
     OR add a sub-bullet for 5a completed if you prefer. Don't mark item 5
     fully completed — that's after 5d lands.

4. Update BRIEFS/INDEX.md:
   - Add a row for Brief 5a → Completed (today's date) with file link.
   - Update item 5 description to indicate split: "Damage manager UI at
     /admin/damage (split into 5a/5b/5c/5d)".

## Configuration

No new env vars. The `NEXT_PUBLIC_DAMAGE_WORKER_URL` already exists in
apps/web/.env.example with the workers.dev URL.

## Out of scope

- Detail page at /admin/damage/[id] — that's Brief 5b. Don't create it.
- Any write actions (transitions, notes, document upload) — those are
  Briefs 5c/5d. Don't add buttons or POST handlers.
- Photo display, photo modals — Brief 5b.
- Activity timeline rendering — Brief 5b.
- Adding /manage/api/locations to damage-worker for a richer location
  dropdown — worker code change, deferred. The v1 compromise (derive
  from result-set codes) is fine for this brief.
- Modifying middleware.ts or any other worker.
- Don't deploy, don't bind production routes, don't commit to git or push.

## Definition of done

- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- /admin/damage renders the filter bar + claims table when authed (with a
  fake or real cookie)
- Filter form GET-submits and the results refresh accordingly
- "No access" branch renders with a Sign In button matching the Brief 11
  styling
- Empty-results branch renders cleanly
- Each table row is a clickable link to /admin/damage/{claim_id}
- New file `apps/web/app/admin/damage/_lib/worker-fetch.ts` exists and
  matches the pricing helper's pattern
- BUILD_STATE.md updated
- BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Visual decisions and any deviations from the dashboard's Tailwind idiom
- How the location-dropdown compromise played out in practice (any
  surprises?)
- Whether the 403 disambiguation limitation feels acceptable, or if a
  small body-parse upgrade in damageGetJson would be worth it for 5b
- Any latent issues found in the existing code while reading the
  damage-worker (don't fix — just flag)
- Validation results (typecheck output summary, build output summary)
- Anything Brief 5b should know about that surfaced during this work

## Outcome

### Files created

- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — server-side fetch helper
  that mirrors `apps/web/app/admin/pricing/_lib/worker-fetch.ts` verbatim with
  `NEXT_PUBLIC_DAMAGE_WORKER_URL` swapped in. Same null-on-401/403 +
  throw-on-other-non-2xx contract. Function name: `damageGetJson<T>`. Lives in
  a damage-namespaced location so future damage-worker calls don't share state
  with the pricing helper.

### Files modified

- `apps/web/app/admin/damage/page.tsx` — replaced the Step-4 placeholder with
  a real server-component list page. Reads `search` / `location` / `status` /
  `lifecycle` from `searchParams` (Next 15 async), builds a worker query
  string, calls `damageGetJson<ClaimListRow[]>("/manage/api/claims?...")`,
  renders a `<form method="GET">` filter bar above a Tailwind table. Handles
  no-access (null), error (throw), and empty-results branches explicitly.
- `BUILD_STATE.md` — bumped Last updated, added Findings entry, marked
  prioritized work item 5 as "5a completed; 5b/5c/5d not started".
- `BRIEFS/INDEX.md` — added 5a/5b/5c/5d sub-rows; updated item 5 description
  to indicate the split.

### Decisions made on operator's behalf

1. **List response type narrowed to `Pick<ClaimRow, ...>`** (alias
   `ClaimListRow`) reflecting what the worker actually returns. The brief
   suggested `ClaimRow[]` but `packages/db-d1/src/claims.ts:listClaims`
   selects only 11 grid columns (claim_id, location_code, location_pretty,
   customer_name, vehicle_year/make/model, submitted_at, claim_status,
   lifecycle_state, contact_status). Typing the page against the full
   `ClaimRow` would mistype the null fields the SELECT doesn't include.

2. **Location dropdown sticky-fallback.** Per the brief, dropdown options are
   derived from the result-set's location_codes. One extra: when an active
   `?location=...` filter narrows the results so far that the filter's own
   code wouldn't appear in the option list, we preserve it as a fallback
   option (labeled with the code itself, since we don't have its
   location_pretty). Without this, toggling the filter would visually drop
   the user's selection mid-page-load.

3. **Sign In return-path includes filter query string.** Filters survive a
   sign-in round-trip — small UX win, no extra cost. Mirrors the Brief 11
   pattern with the location-page returnPath logic.

4. **Added a "Reset" link** next to "Apply filters" — `<Link
   href="/admin/damage">`. Stays inside the brief's "no client JS" constraint
   (it's just a server-rendered link), but gives users a clean way to clear
   filters that might otherwise pile up in the URL.

5. **Lifecycle badge uses Tailwind opacity utilities** (`bg-splash-success/15
   text-splash-success` for Open, `bg-splash-navy/10 text-splash-navy/80` for
   Closed). Chosen over full-saturation pills for legibility against the
   white card surface. The brief said "small badge — green for Open, gray
   for Closed"; this is the most idiomatic Tailwind expression of that.

6. **`formatVehicle` returns a U+2014 em-dash when all three fields are
   null/empty,** matching the brief. Em-dashes elsewhere in the file
   (`CLAIM_STATUSES`) survived the Write tool with no flakiness this run —
   verified post-write per the BUILD_STATE.md note about Brief 2's em-dash
   truncation.

### Latent issues / flags for Brief 5b

- **`damageGetJson` collapses 401 vs 403** into a single `null` return. The
  no-access card uses generic copy that covers both "no claims tool grant"
  and "no damage role assigned", so it's correct in v1. If 5b wants to show
  different copy for the two cases (e.g. "Ask your admin for the Claims tool
  grant" vs "You're not assigned a Damage Manager role"), a small upgrade
  to return `{ data, error }` instead of `T | null` is the right shape —
  the worker already returns distinct `jsonError(403, "no damage role
  assigned")` vs `jsonError(403, "forbidden")` bodies.

- **gm/rm out-of-scope filter returns 200 + empty array** (per
  `apps/damage-worker/src/index.ts:340-345`). The list page renders this as
  an empty-results card with a "Show all claims" link — correct anti-leak
  behavior, but means a gm/rm can construct URLs that hide the real reason
  for an empty state. Documented; intentional.

- **`listClaims` LIMIT is hardcoded at 100** (`packages/db-d1/src/claims.ts:232`).
  Fine for v1; if claim volume warrants pagination later, that's where to
  start. No UI affordance for paging in this brief.

### 403-disambiguation question (per Report section)

The current generic message is acceptable for v1. Worth a small
`damageGetJson` upgrade in 5b only if the destination message text needs
to differentiate for support/operations clarity. Suggest revisiting when
5b lands the detail page — same helper will see the same auth states and
can carry the upgrade for both surfaces.

### Latent issues found in damage-worker (read-only flags, not fixed)

- **Lifecycle filter passthrough cast at `apps/damage-worker/src/index.ts:351`:**
  `lifecycle: (lifecycleParam === "All" ? "All" : lifecycleParam) as LifecycleState | "All"`.
  If the client sends `?lifecycle=Garbage`, this casts the string to the
  union type without validation, then `listClaims` will issue
  `lifecycle_state = 'Garbage'` against D1 (returns 0 rows, no error).
  Soft-fails to empty list, so it's safe — but a small `if (param !== "Open"
  && param !== "Closed" && param !== "All") return jsonError(400, ...)` would
  match the rest of the worker's strictness. Not blocking 5a.

- **`statusParam` cast at `apps/damage-worker/src/index.ts:352`** has the
  same shape — passes through any string as `ClaimStatus`. Same soft-fail
  to empty list, same suggested validation. Not blocking 5a.

- **No `/manage/api/locations` endpoint.** The brief flagged this as the
  reason for the v1 location-dropdown compromise. Adding it would let the
  filter bar offer the user's full dcLocations even when results are empty.
  Worker code change, deferred per brief — works fine without.

### Validation results

- `pnpm typecheck` — **PASS.** 13/13 packages, 3.5s. 12 cached + `@splash/web`
  ran fresh (cache miss as expected). No diagnostics.
- `pnpm --filter @splash/web build` — **PASS.** Next 15.5.15 compiled in 3.8s,
  12/12 static pages generated. `/admin/damage` now listed as `ƒ`
  (server-rendered) at 169 B / 105 kB First Load JS — same shape as the other
  ƒ admin routes (`/admin/pricing`, `/admin/dashboard`, `/admin/sysadmin`).
  No build warnings.

### Anything Brief 5b should know

- The `_lib/worker-fetch.ts` is in place; 5b can import `damageGetJson` from
  `../_lib/worker-fetch` and reuse the cookie-forwarding + null-on-auth-fail
  contract.
- Row links target `/admin/damage/{encodeURIComponent(claim_id)}`. Once 5b
  lands `app/admin/damage/[id]/page.tsx`, the links light up with no list-page
  changes needed.
- The list page intentionally does not pass any state into the detail page
  via query string (no `?from=...&filters=...` round-trip). If 5b wants a
  "Back to list with filters preserved" affordance, it will need to either
  read the referrer header or accept that detail-page Back goes to a
  filter-default list. Suggest the latter for v1.
- The brief intentionally did NOT create `app/admin/damage/[id]/page.tsx`.
  Clicking a row currently 404s — acceptable per brief, gets fixed in 5b.
