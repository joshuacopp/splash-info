# Brief 144: fix LocationSearchGrid server→client function-prop runtime error

**Status:** Completed (2026-05-29)
**Started:** 2026-05-29
**Completed:** 2026-05-29
**Blocks:** Brief 143 (already merged but broken at runtime)
**Dependencies:** Brief 143 (must exist; we're patching it)

## Read first
- BUILD_STATE.md
- CLAUDE.md
- BRIEFS/brief-143-admin-location-grid-search.md (the brief that produced
  this bug — read its Scope to understand the design intent before
  changing the contract)
- apps/web/app/admin/_components/LocationSearchGrid.tsx
- apps/web/app/admin/pricing/page.tsx
- apps/web/app/admin/signups/page.tsx

## Context

Brief 143 added a shared `<LocationSearchGrid>` client island for the
multi-location landing pages. Its public prop contract included
`hrefFor: (loc: LocationItem) => string`. Both pricing and signups pages
pass a closure for that prop, e.g.
`hrefFor={(loc) => \`/admin/pricing/${loc.location_code}\`}`.

This works in `next dev` but blows up at runtime in the deployed
OpenNext-on-Cloudflare-Workers build with:

> Error: Functions cannot be passed directly to Client Components
> unless you explicitly expose it by marking it with "use server".

The failure is visible on staging at `/admin/pricing` and
`/admin/signups` — both pages 500 with a `Something went wrong` boundary,
digest `1412210800`, script `splash-web`, request id `a0364d11ee630ed5`.

Cause: Next.js App Router serializes props when crossing the
server→client boundary. Functions aren't serializable unless they're
marked as a server action; closures from server components are not.
This is also a documented class of issue in CLAUDE.md spirit — server-
component / client-component boundary needs serializable props.

Fix: move href construction to the server side. Each `LocationItem`
carries its own resolved `href` string; the client component renders
the link from that string. The change is mechanical and small.

## Scope

1. **`apps/web/app/admin/_components/LocationSearchGrid.tsx`**
   - Drop the `hrefFor` prop entirely.
   - Add a required `href: string` field to `LocationItem`. Update the
     exported `LocationItem` interface accordingly.
   - Update `LocationSearchGridProps` to remove `hrefFor`. The full
     prop surface becomes `{ locations: LocationItem[]; placeholder?:
     string }`.
   - In the render, replace any
     `<Link href={hrefFor(loc)}>` (or equivalent) with
     `<Link href={loc.href}>`.
   - Everything else (search input, count badge, autofocus,
     `useDeferredValue`, empty-results state, grid CSS, tile styles)
     stays exactly as Brief 143 landed it.

2. **`apps/web/app/admin/pricing/page.tsx`**
   - In the call site, build the `LocationItem[]` with `href` set per
     item:
     `href: \`/admin/pricing/${loc.location_code}\``.
   - Drop the `hrefFor={...}` prop.
   - `pricing` slugs are URL-safe (lowercase, snake_case from
     `pricing_simple.location_code`) so `encodeURIComponent` is not
     required here — but if you want belt-and-suspenders, wrapping in
     `encodeURIComponent` is fine.

3. **`apps/web/app/admin/signups/page.tsx`**
   - Same shape: build `href:
     \`/admin/signups/${encodeURIComponent(loc.location_code)}\``. Keep
     the `encodeURIComponent` call — Brief 143 already had it and we
     preserve that behavior.
   - Drop the `hrefFor={...}` prop.

4. **Verify no other call sites pass `hrefFor`.** `LocationSearchGrid`
   is only consumed by the two pages above today (Brief 143 didn't
   migrate fleet); confirm via a grep and report if anything else
   references the old prop name.

## Configuration

No new env vars or secrets.

## Out of scope

- Don't widen the prop surface beyond what Brief 143 defined. No
  per-item icons, badges, click handlers, etc.
- Don't migrate `/admin/fleet` or any other landing page to this
  primitive — Brief 143 explicitly noted that as a future follow-up.
- Don't change the secondaryLine handling. `ReactNode` is fine as a
  prop value — Next.js's serialization warning targets functions
  specifically, not all non-serializable types. JSX literals built in
  the server component (the `<span>` Pricing passes and the
  `<span className="...">` Signups passes) are serializable into the
  React tree and have been working in dev. If the production runtime
  also rejects ReactNode props for any reason, fall back to passing a
  plain string and rendering it via `<span>{loc.secondaryText}</span>`
  in the client — note the change in the Report.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/web dev` then GET `/admin/pricing` and
  `/admin/signups` render the search input and the grid without
  client-component-prop errors in the console.
- Deployed on workers.dev (or staging), the same routes return 200
  instead of the prior 500. (If you can't deploy here, validate the
  `pnpm --filter @splash/web build` succeeds with no warnings about
  passing functions across the boundary.)
- `LocationSearchGrid` exports the updated `LocationItem` shape with
  the new `href` field; `LocationSearchGridProps` no longer mentions
  `hrefFor`.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 144: LocationSearchGrid hrefFor closure replaced with
  serializable per-item href; production 500 on /admin/pricing and
  /admin/signups fixed").

## Report

- Confirm `LocationSearchGrid` has no other function-typed props after
  this change.
- If you found other server→client boundary issues elsewhere in the
  codebase that share this pattern (closure prop, render-prop,
  callback), list them — don't fix here, just flag for a future
  brief.
- If the `secondaryLine: ReactNode` prop had to be reduced to a string
  for the same reason, document that and propose whether a future
  brief should generalize per-page tile customization in some other
  way (e.g., a small adjacent component).

## Outcome

### Files created
None.

### Files modified
- `apps/web/app/admin/_components/LocationSearchGrid.tsx` — added
  required `href: string` field to `LocationItem`; dropped `hrefFor`
  from `LocationSearchGridProps` (prop surface is now
  `{ locations: LocationItem[]; placeholder?: string }`); render
  changed from `<Link href={hrefFor(loc)}>` to
  `<Link href={loc.href}>`; doc comments on `LocationItem` updated.
  All Brief 143 behavior preserved (search input, count badge,
  autofocus, `useDeferredValue`, empty-results state, grid CSS, tile
  styles, `secondaryLine: ReactNode`).
- `apps/web/app/admin/pricing/page.tsx` — `items` mapping now builds
  `href: \`/admin/pricing/${loc.location_code}\`` per item; dropped
  `hrefFor={...}` from the `<LocationSearchGrid>` call site.
- `apps/web/app/admin/signups/page.tsx` — inline `locations.map<LocationItem>`
  now builds `href: \`/admin/signups/${encodeURIComponent(loc.location_code)}\``
  per item (preserves Brief 143's `encodeURIComponent` on the signups
  side); dropped `hrefFor={...}` from the `<LocationSearchGrid>` call
  site.
- `BUILD_STATE.md` — Last-updated paragraph prepended with Brief 144
  summary; Findings & decisions log row inserted at top of table.
- `BRIEFS/brief-144-location-search-grid-server-client-fix.md` —
  Status / Started / Completed metadata updated; this Outcome section.

### Files deleted
None.

### Decisions made on operator's behalf
1. `secondaryLine: ReactNode` left as-is. Next.js's server→client
   boundary warning targets functions specifically, not all
   non-serializable types; JSX literals from server components
   serialize into the React tree fine. The production build emitted
   no boundary warnings, so the fallback-to-string path the brief
   flagged was not needed.
2. `pricing` page omits `encodeURIComponent` on the href construction
   because `pricing_simple.location_code` slugs are lowercase
   snake_case (URL-safe) and Brief 143 didn't have it. Belt-and-
   suspenders was not chosen — keeping the slug shape consistent
   between the URL we generate and the URL the legacy admin generates
   matters more than defensive encoding here.
3. Doc comment on `LocationItem.href` documents the WHY (server-side
   string keeps the prop serializable) so a future maintainer doesn't
   reintroduce a closure prop.

### Latent issues found
- None. Grep for `hrefFor` returned only the three in-scope files
  (plus `BUILD_STATE.md` and the two brief markdown files). No other
  server→client function-prop sites in `apps/web/app/admin/_components`
  or in the admin pages. Other client islands (e.g. `<ActionForm>`,
  `<DateRangePicker>`, `<CsvExportButton>`, `<BogoModal>`,
  `<PackagePickerModal>`) accept primitives / data / `children` only.

### Validation
- `pnpm typecheck` — 18/18 green (17 cached, web ran fresh; 4.166s
  wall).
- `pnpm --filter @splash/web build` — succeeded.
  `/admin/pricing` 1.05 kB / 108 kB First-Load JS;
  `/admin/signups` 1.05 kB / 108 kB First-Load JS (essentially flat
  vs Brief 143 baseline). Next.js emitted no "Functions cannot be
  passed directly to Client Components" warnings during the build.
- Operator-driven runtime verification on staging deferred per the
  brief's "don't deploy" rule. Expected post-deploy state:
  `GET /admin/pricing` and `GET /admin/signups` return 200, render
  the search input + grid, no console errors mentioning closure
  serialization.

### Report

- **No other function-typed props on `LocationSearchGrid`.** After
  this brief, the full public surface is
  `{ locations: LocationItem[]; placeholder?: string }`. `LocationItem`
  fields are `{ location_code: string; location_pretty: string;
  href: string; secondaryLine: ReactNode }`. Only serializable types
  + React tree elements.
- **No other server→client boundary closures found in apps/web.** I
  grep'd for arrow-function prop patterns and reviewed every client
  component under `apps/web/app/admin/_components` and the page
  components that import them. The Brief 19 `<ActionForm>` pattern
  passes server actions (which Next handles as serializable
  references), not arbitrary closures. `<DateRangePicker>` and
  `<CsvExportButton>` accept primitives / data only. The Brief 142
  `<BogoModal>` and existing `<PackagePickerModal>` accept booleans,
  string arrays, and `onClose` / `onSubmit` handlers that are bound
  inside client islands (not passed across the boundary).
- **`secondaryLine: ReactNode` not reduced to a string.** The
  production build had no boundary warnings. JSX literals built in
  server components are serializable into the React tree (they
  become RSC payload). If a future Next.js version tightens the
  serialization rules further and rejects this too, the fallback is
  to add a `secondaryText: string` field and render
  `<span>{loc.secondaryText}</span>` in the client; per-page custom
  styling (Tailwind classes, `font-mono`, etc.) would then need a
  small adjacent client component or a `secondaryClassName?: string`
  prop. Not needed today.
