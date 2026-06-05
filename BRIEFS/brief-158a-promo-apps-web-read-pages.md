# Brief 158a: Promotions — apps/web read pages (dashboard list, IT queue, live-view detail, IT ticket page)

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** Brief 158b (write affordances — create form, edit modals, server actions) builds on the components + helpers this brief lands.
**Dependencies:** Brief 153 (PROMO_WORKER service binding exists, AuthSession.promoRole populated), Brief 154 (list + detail endpoints), Brief 155 (detail response carries assignees + locations with completion flags), Brief 156 (detail response carries materials + ptp), Brief 157 (detail response carries announcements).

## Read first

- BUILD_STATE.md.
- CLAUDE.md — the `apps/web` working notes; the **MANDATORY ADMIN_KNOWN_SUBPATHS** rule (every new top-level `/admin/{subpath}` must be added to the allow-list — bug class that bit Briefs 109, 118, 121); Brief 17 service-binding pattern; Brief 116 / 117 dashboard tile structure; Brief 19 ActionForm pattern (this brief reads only — writes land in 158b — but components from this brief feed 158b's forms).
- BRIEFS/brief-117-dashboard-drill-down-two-level-navigation.md — the `GROUPS` + `TILES` structure in `_lib/tiles.tsx`.
- BRIEFS/brief-094-forms-admin-api-crud.md and brief-095-forms-admin-builder-ui.md — closest analog (admin-tier listed table + per-record detail page sourced from a path-carved worker via service binding).
- apps/web/app/admin/forms/_lib/worker-fetch.ts — runnable example of the service-binding-first, URL-fallback worker-fetch pattern used here.
- apps/web/app/admin/forms/page.tsx + apps/web/app/admin/forms/[id]/page.tsx — runnable list + detail page examples.
- apps/web/app/admin/dashboard/_lib/tiles.tsx — where the new Promotions tile + (IT-only) IT Queue tile register.
- apps/web/middleware.ts — `ADMIN_KNOWN_SUBPATHS` must gain `"promotions"` in the same change set.
- apps/promo-worker/src/handlers/promos.ts (post-Brief-154/156/157) — wire-format contract this brief consumes.

## Architecture context

This brief lands the four read surfaces the mockup demonstrated, sourced live from the splash-promo worker via the existing Brief 153 service binding:

- `/admin/promotions` — dashboard list of every promo. **Any non-null `promoRole`**. Filterable.
- `/admin/promotions/queue` — IT ticket queue (work-queue oriented). **`super_admin | it` only.**
- `/admin/promotions/[id]` — live view (status pipeline + locations + materials + PTP + recent activity + announcement history button). **Any non-null `promoRole`**. `internalNote` field is already stripped at the worker seam for non-IT callers per Brief 154 — apps/web doesn't have to re-gate it, but the IT-only "Internal note" section is conditionally rendered to avoid an empty card for non-IT viewers.
- `/admin/promotions/[id]/ticket` — IT ticket view with assignment + ready-by + roadblocks + internal note (read-only at 158a; edit lands in 158b). **`super_admin | it` only.**

**Service-binding flow.** All four pages SSR-fetch via the Brief 17 pattern: try `getCloudflareContext({ async: true })` → `env.PROMO_WORKER.fetch(internalRequest)`; on throw (e.g. `next dev`) fall through to a URL-based fetch using `NEXT_PUBLIC_PROMO_WORKER_URL` if set, otherwise same-origin (production same-zone after cutover). Cookie forwarded via `cookies().toString()`. Origin header explicitly set so the worker's `isOriginAllowed` CSRF gate passes (even though this brief only reads — sets up 158b's writes too).

**Dashboard tile structure.** Two new tiles register in `_lib/tiles.tsx`:

1. **Promotions** under the `operations` group — `visibleTo: (s) => s.promoRole != null`. Links to `/admin/promotions`.
2. **IT Promotions Queue** under the `operations` group — `visibleTo: (s) => s.promoRole === 'super_admin' || s.promoRole === 'it'`. Links to `/admin/promotions/queue`.

Group-tile visibility (Brief 117) is already a derived OR across sub-tiles, so the Operations group surfaces automatically when either of the two new sub-tiles is visible.

**Middleware allow-list.** Brief 109/118/121 each forgot to add the new admin subpath. This brief adds `"promotions"` to `ADMIN_KNOWN_SUBPATHS` in `apps/web/middleware.ts`. Multi-segment paths (`/admin/promotions/queue`, `/admin/promotions/{id}`, `/admin/promotions/{id}/ticket`) bypass the single-segment rewrite rule, but the top-level `promotions` registration is still required for the dashboard tile link to not redirect.

**Component sharing.** Components live in `apps/web/app/admin/promotions/_components/`. Two reused by 158b without modification (the write forms in 158b read these via children-as-props rather than re-implementing): `PromoStatusPill`, `PromoPriorityPill`, `PromoStatusPipeline`, `LocationProgress`, `MaterialChip`, `ActivityTimeline`. The 158b additions are forms + modals, not pills.

## Context

The mockup's read surfaces are concrete: a card-grid dashboard, a table-style IT queue, a multi-card live view (status pipeline + details + materials + PTP + announcement send button + activity timeline), and an IT ticket page (the read-only render of ticket fields + per-location checklist). 158a builds all four; 158b wires every write affordance onto them.

Splitting the brief at the read/write boundary keeps each PR focused. 158a is mechanical (data → JSX); 158b deals with the harder bits (form validation, multipart upload UX, optimistic state for checkboxes, status auto-flip echoed in the UI).

## Scope

### Phase 1 — Worker-fetch helpers

**File:** `apps/web/app/admin/promotions/_lib/worker-fetch.ts` (new).

Three SSR helpers, all returning typed shapes that mirror the Brief 154/156/157 wire contract:

```ts
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { PromoListResponse, PromoDetail } from "@/app/admin/promotions/_lib/types";

export async function listPromos(params: {
  status?: string;          // comma-separated allowed
  priority?: "High" | "Medium" | "Low";
  assignedToMe?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<PromoListResponse> { ... }

export async function getPromo(id: string): Promise<PromoDetail | null> { ... }

// For the IT queue: same backing endpoint as listPromos, but the caller layers
// the ?assigned_to_me filter on top. Kept as a separate helper for clarity at
// the page level; internally just calls listPromos.
export async function listMyAssignments(): Promise<PromoListResponse> { ... }
```

Internally:

1. Build the path: `/promo/api/promos?...query...` for list, `/promo/api/promos/{id}` for detail.
2. Try service binding: `const ctx = await getCloudflareContext({ async: true }); const r = await ctx.env.PROMO_WORKER.fetch(new Request("https://internal" + path, { headers: { Cookie: cookies().toString(), Origin: "https://internal" } }));`
3. On throw (dev) fall back to URL-based: `await fetch(new URL(path, process.env.NEXT_PUBLIC_PROMO_WORKER_URL || ...), { headers: ... })`.
4. Type-narrow the JSON response. `getPromo` returns `null` on 404 so callers can `notFound()`.

**File:** `apps/web/app/admin/promotions/_lib/types.ts` (new) — TypeScript shapes mirroring the worker responses. Re-export from `@splash/types` if any shapes are stable across worker + apps/web (currently `PromoRole` already lives there from Brief 153; add `PromoStatus`, `PromoPriority`, `PromoType` if not already there).

### Phase 2 — Shared components

**Folder:** `apps/web/app/admin/promotions/_components/`.

Components (all server components unless noted):

1. `PromoStatusPill.tsx` — six-state pill with the mockup's color palette (Submitted neutral, Scoped sudsy-blue, Building amber, Tested teal, Live green, Ended gray). Reuses the existing `apps/web/app/_components/Pill` if it exists; otherwise inline Tailwind.
2. `PromoPriorityPill.tsx` — three-state pill (High red, Medium amber, Low green).
3. `PromoStatusPipeline.tsx` — horizontal stepper with the six states. Past states muted, current state primary, future states ghosted. Mirrors the mockup's `.pipeline` flex row.
4. `LocationProgress.tsx` — renders `N of M complete` text + the location list as a checkbox-grid (read-only at 158a; 158b toggles them).
5. `MaterialChip.tsx` — chip with name + kind + size + a download link (the Brief 156 `/file` serve URL). Inline thumbnail when `kind === 'image'` (the worker's `Content-Disposition: inline` makes this work via `<img src="/promo/api/promos/{id}/materials/{materialId}/file">` — note the same-origin path-carve makes this a simple relative URL on apps/web SSR).
6. `ActivityTimeline.tsx` — vertical timeline of `promo_activity_log` entries (most recent first). Per-activity-type icon + actor email + relative timestamp + structured details (e.g. `status_changed` shows `Submitted → Scoped`; `material_added` shows the name + kind; `location_marked_complete` shows the location_code).
7. `PromoFilterBar.tsx` — client island. Search input + status multi-select dropdown + priority dropdown + "Assigned to me" checkbox. URL-search-param-driven (mirrors `DateRangePicker.tsx` from Brief 83). Pushes `?status=...&priority=...&assigned_to_me=1&search=...` on change.
8. `AnnouncementHistoryButton.tsx` — client island button that opens an inline `<details>` (or modal in 158b) listing each `promo_announcements` row's subject + sent_at + recipient count + selected materials. Read-only at 158a.

### Phase 3 — Dashboard list page

**File:** `apps/web/app/admin/promotions/page.tsx`.

Server component. Reads `searchParams` for filters. Auth-gate: redirect to `/login` if no session; show "No access" placeholder if `session.promoRole === null`.

Layout:

- Page header: "Promotions" + a "+ New promotion" link (button styling) pointing to `/admin/promotions/new` (404 at 158a since 158b builds the form).
- `<PromoFilterBar>` for filtering.
- Card grid (responsive: 1 col mobile, 2 col tablet, 3 col desktop):
  - One card per promo.
  - Card shows: title (linked to `/admin/promotions/{id}`), `<PromoStatusPill>`, `<PromoPriorityPill>`, `locationCount` + `completedLocationCount` as a small N/M, `assigneeCount`, `requestedGoLiveDate` formatted via `formatEst` (Brief 113).
- Pagination footer: previous/next buttons reading `?offset=`. Hide previous when offset=0; hide next when `offset + limit >= total`.
- Empty state when zero promos visible: "No promotions yet. Create your first one." (CTA links to `/admin/promotions/new`).

### Phase 4 — IT queue page

**File:** `apps/web/app/admin/promotions/queue/page.tsx`.

Server component. Auth-gate: redirect to `/login` if no session; render `<NoAccessCard>` if `session.promoRole !== 'super_admin' && session.promoRole !== 'it'`.

Layout:

- Page header: "IT Promotions Queue".
- `<PromoFilterBar>` with the "Assigned to me" checkbox defaulting to ON for IT users (mirrors Brief 121's pending-approvals page pattern where the active filter pre-checks "Mine").
- Table view (vs. cards on the dashboard list) for the work-queue feel:
  - Columns: Title | Priority | Status | Ready by | Assignees (count + first-N initials) | Locations done (N/M) | Roadblocks (truncated) | Internal note preview (IT-only; truncated to ~50 chars).
  - Row click → `/admin/promotions/{id}/ticket`.
- Sortable header click → re-fetch with the order param (deferred to 158b if non-trivial; at 158a, fixed sort by `priority desc, requested_go_live_date asc`).

### Phase 5 — Live-view detail page

**File:** `apps/web/app/admin/promotions/[id]/page.tsx`.

Server component. Auth-gate: redirect to `/login`; render `<NoAccessCard>` if `session.promoRole === null`. Call `getPromo(id)`; `notFound()` on null.

Layout (multi-card stack, matches the mockup's live view):

1. **Header card** — title + `<PromoStatusPill>` + `<PromoPriorityPill>` + "Open IT ticket →" link (visible to IT/super_admin only).
2. **Status pipeline card** — `<PromoStatusPipeline>`. Read-only at 158a; 158b wires status PATCH.
3. **Details card** — promo_type, pos_behavior, proposed window (start → end), requested go-live, IT done-by (`ticket.readyByDate`), assignees (read names from a small `auth_unified` lookup — see Phase 7), roadblocks. NO internal note here (lives only on the IT ticket page).
4. **Locations card** — `<LocationProgress>` showing each location + checkbox state. Read-only at 158a.
5. **Materials card** — grid of `<MaterialChip>` items + a "+ Add material" button (no-op stub at 158a; 158b wires the modal).
6. **PTP card** — Purpose / Tools / Process as three read-only blocks. "+ Build PTP" button (stub at 158a).
7. **Announcement card** — "Compose announcement email" button (stub at 158a) + `<AnnouncementHistoryButton>` for sent history.
8. **Activity timeline card** — `<ActivityTimeline>` showing the 20 most recent rows from `promo.activity`.

### Phase 6 — IT ticket page

**File:** `apps/web/app/admin/promotions/[id]/ticket/page.tsx`.

Server component. Auth-gate: redirect to `/login`; render `<NoAccessCard>` if `session.promoRole !== 'super_admin' && session.promoRole !== 'it'`. Call `getPromo(id)`; `notFound()` on null.

Layout (mirrors mockup's IT ticket detail):

1. **Header** — Title + `<PromoStatusPill>` + back-link to `/admin/promotions/queue` (or `/admin/promotions/{id}` if accessed from the live view via the "Open IT ticket" link — use referrer-based logic only if trivial; otherwise always link back to the queue).
2. **Submitted request card** — read-only render of every promo field (title, locations, dates, priority, promo_type, pos_behavior, requested_go_live_date). Mirrors the mockup's "Promotion details (read-only)" section.
3. **IT response card** — read-only at 158a:
   - Ready by: `ticket.readyByDate` formatted.
   - Assignees: list of names + emails (lookup via Phase 7 helper).
   - Roadblocks: prose render.
   - Internal note: prose render in a tinted-amber callout box with an "IT only" badge (defense in depth — the worker already strips this for non-IT, but the badge makes audience clear).
4. **Per-location progress card** — `<LocationProgress>` (read-only at 158a).
5. **Update promo card** — placeholder text "Edit affordances land in Brief 158b" (or just don't render this card until 158b adds it).

### Phase 7 — Lightweight user-info lookup

To render assignee names + emails on both the dashboard list (assignee initials) and the IT ticket page (full names), apps/web needs a way to resolve `user_id` → `{email, fullName}`. Reuse the existing `auth_unified` read via Supabase service-key client (the same client that powers the Brief 95 PersonAutosuggest on forms).

**File:** `apps/web/app/admin/promotions/_lib/user-lookup.ts` (new).

```ts
import { createClient } from "@supabase/supabase-js";

export async function lookupUserNames(userIds: string[]): Promise<Record<string, { email: string; fullName: string | null }>> {
  if (userIds.length === 0) return {};
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data, error } = await supabase
    .from("auth_unified")
    .select("user_id, email")  // full_name not yet on auth_unified per Brief 125 note; fall through to email
    .in("user_id", userIds);
  if (error || !data) return {};
  return Object.fromEntries(data.map((r) => [r.user_id, { email: r.email, fullName: null }]));
}
```

Note the brief acknowledges `auth_unified` doesn't surface `full_name` yet (per CLAUDE.md Brief 125 note about future widening); for now, render email as the display name and a future brief can swap to `fullName` when the view exposes it.

### Phase 8 — Dashboard tile + middleware

**File:** `apps/web/app/admin/dashboard/_lib/tiles.tsx` — add two entries to the `TILES` array under the `operations` group:

```tsx
{
  id: "promotions",
  group: "operations",
  label: "Promotions",
  description: "Plan, scope, and run promotional campaigns across locations.",
  href: "/admin/promotions",
  visibleTo: (s) => s?.promoRole != null
},
{
  id: "promotions-queue",
  group: "operations",
  label: "IT Promotions Queue",
  description: "Items waiting on the IT team for scoping or build.",
  href: "/admin/promotions/queue",
  visibleTo: (s) => s?.promoRole === "super_admin" || s?.promoRole === "it"
}
```

**File:** `apps/web/middleware.ts` — add `"promotions"` to the `ADMIN_KNOWN_SUBPATHS` array.

### Phase 9 — Doc updates

1. **BUILD_STATE.md** — Findings + Brief 158a status.
2. **BRIEFS/INDEX.md** — new row.
3. **CLAUDE.md** — extend the **promo-worker** glossary entry with one line noting the apps/web read surfaces landed in 158a; document the four routes' auth gates.
4. **PRE_DEPLOY_PROMO.md** — add smoke entries for the apps/web reads (visit `/admin/promotions` and confirm rendering against any promos seeded via Brief 154's POST).

### Phase 10 — Build verify

- `pnpm typecheck`.
- `pnpm --filter @splash/web build` — must produce a clean dist. Log the route-specific chunk sizes for the four new pages.
- Manual smoke (post-deploy):
  - Visit `/admin/dashboard/operations` as super_admin → see both Promotions tiles.
  - Visit `/admin/dashboard/operations` as a marketing user → see only the "Promotions" tile (queue is IT-only).
  - Visit `/admin/promotions` → see the list of promos seeded earlier.
  - Click into one → see the live view with all cards populated.
  - Visit `/admin/promotions/queue` as super_admin → see the IT queue.
  - Visit `/admin/promotions/queue` as a marketing user → see `<NoAccessCard>`.
  - Visit `/admin/promotions/{id}/ticket` as super_admin → see the IT ticket page with internal note rendered.
  - Visit the same as marketing → see `<NoAccessCard>`.
  - Visit `/admin/promotions/queue?assigned_to_me=1` → filtered to your assignments.

## Definition of Done

- Four pages render against real worker responses end-to-end.
- Auth gates work per the architecture context.
- `ADMIN_KNOWN_SUBPATHS` includes `"promotions"`.
- Two dashboard tiles register with correct `visibleTo` predicates.
- `pnpm typecheck` + `pnpm --filter @splash/web build` pass.
- Smoke checks recorded in Outcome.

## Out of scope (158b)

- `/admin/promotions/new` — create form (server action wraps Brief 154's POST).
- Write affordances on every read page (status PATCH, ticket field edits, assignee add/remove, location checkbox toggles, material upload modal, PTP modal, announcement compose modal).
- Optimistic UI for toggle/edit actions.
- ActionForm-based error/success banners on every write.
- Cross-page navigation polish (e.g., "Promo created → redirect to live view").
- A `GET /promo/api/promos/{id}/announcements` paginated endpoint if operators want >20 announcements per promo (deferred until requested).

## Outcome

- **Files created (15):**
  - `apps/web/app/admin/promotions/_lib/types.ts` — wire-shape types (`PromoStatus`, `PromoPriority`, `PromoType`, `PromoListItem`, `PromoListResponse`, `PromoDetail`, full ticket / location / material / ptp / activity / announcement sub-shapes); re-exports `PromoRole` from `@splash/types/promo`.
  - `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — three SSR helpers (`listPromos`, `listMyAssignments`, `getPromo`) following the Brief 17 / 94 / 109 service-binding-first pattern with URL fallback for `next dev`. 401/403 → `null` so pages render `<NoAccessCard>`; 404 → `null` so callers `notFound()`.
  - `apps/web/app/admin/promotions/_lib/user-lookup.ts` — Phase 7 stub (see Decisions below). Exports `lookupUserNames` (returns empty map), `shortenUserId`, `displayUserLabel`.
  - `apps/web/app/admin/promotions/_components/PromoStatusPill.tsx` — six-state pill (Submitted neutral / Scoped sudsy / Building amber / Tested teal / Live emerald / Ended gray).
  - `apps/web/app/admin/promotions/_components/PromoPriorityPill.tsx` — three-state pill (High red / Medium amber / Low emerald).
  - `apps/web/app/admin/promotions/_components/PromoStatusPipeline.tsx` — horizontal six-step stepper (past muted / current primary / future ghosted).
  - `apps/web/app/admin/promotions/_components/LocationProgress.tsx` — `N of M complete` + read-only checkbox grid, sort incomplete-first-alphabetical so active work surfaces.
  - `apps/web/app/admin/promotions/_components/MaterialChip.tsx` — chip with image thumbnails inline, kind label + size + download link to the Brief 156 `/file` serve URL (same-origin relative path — path-carved per Brief 153).
  - `apps/web/app/admin/promotions/_components/ActivityTimeline.tsx` — vertical timeline; per-activity-type colored dot + headline-builder per type (`status_changed` shows `from → to`; `material_added` shows name + kind; `location_marked_complete` shows code; etc.) + relative timestamp via `formatEst` (Brief 113).
  - `apps/web/app/admin/promotions/_components/PromoFilterBar.tsx` — client island, URL-search-param-driven; status / priority dropdowns + search input + "Assigned to me" checkbox; optional `defaultAssignedToMe` prop for the IT queue page.
  - `apps/web/app/admin/promotions/_components/AnnouncementHistoryButton.tsx` — `<details>`-collapsible inline list of announcement snapshots (subject + sent_at + recipient count + materials count + click-to-expand body preview).
  - `apps/web/app/admin/promotions/_components/NoAccessCard.tsx` — three-state (`signin` / `no-promo-role` / `it-only`); mirrors `apps/web/app/admin/forms/_components/NoAccessCard.tsx`.
  - `apps/web/app/admin/promotions/page.tsx` — Phase 3 dashboard list. Filter bar + responsive card grid (1/2/3 cols) + total + offset pagination + "+ New promotion" button (gated to super_admin/it/marketing).
  - `apps/web/app/admin/promotions/queue/page.tsx` — Phase 4 IT queue. Table view sorted priority desc → requested_go_live_date asc. "Assigned to me" defaults ON when URL param absent.
  - `apps/web/app/admin/promotions/[id]/page.tsx` — Phase 5 live view. 8-card stack: header / status pipeline / details / locations / materials grid / PTP / announcements / activity timeline. Write affordances rendered as disabled `<StubButton>` placeholders (158b lands the modals).
  - `apps/web/app/admin/promotions/[id]/ticket/page.tsx` — Phase 6 IT ticket. Submitted-request read-only card + IT-response card with amber-tinted "IT only" callout for `internalNote`. Cross-link to live view.

- **Files modified (4):**
  - `apps/web/middleware.ts` — added `"promotions"` to `ADMIN_KNOWN_SUBPATHS` alphabetically between `"pricing"` and `"scorm-builder"` per the CLAUDE.md mandatory rule.
  - `apps/web/app/admin/dashboard/_lib/tiles.tsx` — added two new tiles under the `operations` group: "Promotions" (`visibleTo: s?.promoRole != null`, megaphone icon) + "IT Promotions Queue" (`visibleTo: s?.promoRole === 'super_admin' || 'it'`, ticket icon). Added two inline SVG icon defs (`megaphoneIcon` / `ticketIcon`) following the existing inline-lucide convention.
  - `CLAUDE.md` — extended the `promo-worker` glossary entry with a Brief 158a paragraph documenting the four routes, their auth gates, the shared component inventory, the worker-fetch helper, and the Phase 7 user-name stub deviation.
  - `BRIEFS/INDEX.md` — added a Brief 158a row at the top of the table.
  - `PRE_DEPLOY_PROMO.md` — added smoke-test entry 7 covering the apps/web read pages (10 sub-checks: dashboard tile visibility per role, list page card grid + filter bar, live view all-cards-populated, IT queue table sort + "Assigned to me" default, IT ticket page internal_note rendering, no-access cards for marketing on IT surfaces, defense-in-depth `internalNote` strip, 404 on bad UUIDs, middleware allow-list check).

- **Decisions made on operator's behalf:**
  1. **Phase 7 user-name resolution stubbed**, not implemented per the brief's prescribed `@supabase/supabase-js createClient` path. Two compounding issues blocked the prescribed implementation: (a) `@supabase/supabase-js` is NOT in `apps/web/package.json` (the only direct-Supabase consumers in the monorepo are the workers; apps/web SSR-fetches through service bindings exclusively) and (b) `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` are NOT bindings on `splash-web`'s `wrangler.toml` — adding them is a scope expansion touching secrets management + CF Workers deploy plumbing. The brief itself acknowledges (Phase 7 epilogue) that `auth_unified` doesn't surface `full_name` yet, so even with the prescribed path operators would see emails-as-names. Stubbed at `_lib/user-lookup.ts` with a stable signature so a future brief can wire either (a) a new `GET /promo/api/users?ids=...` endpoint on `splash-promo`, (b) a wide `auth_unified` view, or (c) widening the existing `getPromo` detail response to embed resolved `{email, fullName}` per assignee. The UI gracefully falls back to a shortened user_id snippet via `shortenUserId` so operators get a recognizable UUID prefix in the meantime.
  2. **Sorted queue in apps/web, not the worker.** The brief said "fixed sort by `priority desc, requested_go_live_date asc`" at 158a. Worker `listPromos` returns `created_at.desc`; the queue page re-sorts client-side post-fetch. No worker change — keeps 158a apps/web-only as the brief intended. 158b can move the sort to a worker query param if it grows.
  3. **Default pagination 24 on the dashboard list**, not the 100 that the worker accepts as `limit` default. Card grid is 3 cols × 8 rows = 24 — fits one screen with no scroll on a typical laptop. 100 would force operators to scroll past 25–30 cards to find pagination.
  4. **Re-sort by completion status in `LocationProgress`** — incomplete first (alphabetical), then complete (alphabetical). Brief mockup didn't specify; this surfaces the active work, which is the operationally-useful default. Alternative (alphabetical only) buries pending locations among completed ones.
  5. **AnnouncementHistoryButton uses `<details>` + per-row expand state**, not a modal. Brief said "inline `<details>` (or modal in 158b)" — picked inline for 158a so operators get a working surface without 158b's modal infrastructure.
  6. **PromoFilterBar's single-status dropdown**, not multi-select. The worker accepts comma-separated `?status=A,B,C` but the UI ships single-select at v1 for legibility — multi-select pills are a 158b polish candidate.
  7. **"+ New promotion" button visible to super_admin / it / marketing** — matches the Brief 154 `POST /promo/api/promos` role gate. Operations users (ops promoRole) see the list but no create button.
  8. **No back-link from live view to the queue when the prior page was the queue.** Brief said "use referrer-based logic only if trivial; otherwise always link back to the queue" for the IT ticket page; same choice for the live view → always links back to `/admin/promotions`. Trivially extends in 158b.
  9. **Two new inline SVG icons (`megaphoneIcon` + `ticketIcon`)** rather than importing a lucide-react package. Matches the existing 12-icon inline convention in `tiles.tsx` (the file's comment block makes this convention explicit).
  10. **Smoke tests added as a new section 7 step in `PRE_DEPLOY_PROMO.md`**, not a new top-level section. Keeps the smoke list in one chronological flow so operators can run it linearly.
  11. **`PROMO_FILES` R2 binding NOT mirrored on apps/web** — material download URLs are same-origin path-carved (`/promo/api/promos/{id}/materials/{matId}/file`) and go through the worker's serve route directly. The apps/web Worker doesn't need direct R2 access.

- **Latent issues found:**
  - The Phase 7 stub is the largest deviation from the brief — flagged for follow-up. The cleanest path is to add `GET /promo/api/users?ids=uuid1,uuid2,...` to the promo-worker (admin-tier or any-non-null-promoRole gate) returning `[{userId, email, fullName?}, ...]`. The stub's `lookupUserNames` signature already accepts an array of ids and returns a `Record<userId, UserInfo>` so swapping in the real call is a one-function-body edit.
  - `formatEst` accepts an ISO string. For date-only fields (`requestedGoLiveDate`, `proposedStartDate`, etc.) the pages append `T00:00:00Z` before formatting. This works but introduces a 4–5 hr UTC→EST shift display ambiguity for the boundary case (a date that lands at midnight EST). Acceptable v1 — for true date-only display a future helper that bypasses TZ conversion would be cleaner.
  - The activity timeline's relative-time text rebuilds on every page load (server-rendered) — for long-lived tabs it'll go stale until the operator refreshes. Acceptable v1; client-side ticker is a polish candidate.
  - `AnnouncementHistoryButton` is a client island per the brief's prescribed shape, but the `<details>`/`<summary>` it wraps would work as a pure server component if per-row expand state weren't tracked. Trade-off accepted — per-row expand UX is operationally useful.
  - The dashboard's "Promotions" tile under the Operations group reads as a parallel to "Damage Claims" and "Work Orders" but its workflow is much heavier (multi-team coordination). If operators want it elsewhere (e.g., a new "Campaigns" group), the GROUPS array in `tiles.tsx` would need a fourth entry plus a `GROUP_DESCRIPTIONS` row.
  - Brief mentions "`internal_note` field is already stripped at the worker seam for non-IT callers per Brief 154 — apps/web doesn't have to re-gate it, but the IT-only Internal note section is conditionally rendered to avoid an empty card for non-IT viewers." The IT ticket page is itself IT-only-gated so this never fires; the live view doesn't render `internalNote` at all (it only renders on the IT ticket page). Confirmed via grep.

- **Validation results (typecheck / build):**
  - `pnpm typecheck` — **19/19 successful** (18 cached, `@splash/web` ran fresh). 5.288s total.
  - `pnpm --filter @splash/web build` — **succeeded.** All 40 routes generated cleanly. Compile 13.6s.

- **Route-specific chunk sizes (4 pages):**
  - `/admin/promotions` — **1.21 kB / 108 kB First-Load JS**
  - `/admin/promotions/queue` — **1.21 kB / 108 kB First-Load JS**
  - `/admin/promotions/[id]` — **1.22 kB / 108 kB First-Load JS**
  - `/admin/promotions/[id]/ticket` — **191 B / 107 kB First-Load JS** (no client islands on this page; the live view's `AnnouncementHistoryButton` + filter bar are why the others are slightly heavier)

  Shared First-Load JS: 104 kB. Each promo page sits at or just above the apps/web shared baseline — no bundle-size red flags.
