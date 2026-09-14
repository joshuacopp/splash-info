# Brief 98: Forms — polish (dashboard tile, error boundary, rate limit, smoke pass)

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** none — wraps the form-builder feature.
**Dependencies:** Briefs 89–97 (the entire feature).

## Read first

- BUILD_STATE.md.
- CLAUDE.md.
- BRIEFS/brief-031-server-action-id-stability.md (the segment-level error boundary pattern at `apps/web/app/admin/error.tsx`; this brief adds a forms-specific one).
- BRIEFS/brief-078-dashboard-tile-rename-signup-sysadmin-workorders.md (precedent — dashboard tile add).
- apps/web/app/admin/dashboard/page.tsx (where the new tile gets added).
- apps/web/middleware.ts (verify `/admin/forms/*` is covered by the `/admin/:path*` matcher; expect no change needed).

## Architecture context

This brief wraps the 10-brief form-builder feature with three small additions and one large documentation pass:

**Dashboard tile.** Adds "Forms" to `/admin/dashboard`'s tile grid. lucide `ClipboardList` icon. Per Brief 78 precedent — gated unconditionally (per-tool access enforced at destination). Tile links to `/admin/forms`.

**Error boundary.** Adds `apps/web/app/admin/forms/error.tsx` (segment-level boundary). Catches throws from any `/admin/forms/*` page. Same pattern as Brief 31's `/admin/error.tsx`. The forms-specific boundary lives below the global admin one and provides forms-aware error copy ("Couldn't load form builder.") with a Reload button.

**CF rate limit.** Per Decision 8c, link-only forms have no Turnstile and no auth — leaked URLs are a spam vector. CF's native [Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) are wired at the route level: 5 submissions per 5 minutes per source IP. Operator-managed via CF dashboard, NOT worker code (the rule lives at the zone level, applied to `/forms/api/submit/*`). Brief documents the operator step; no code change required.

**Final smoke pass.** PRE_DEPLOY_FORMS.md gets an end-to-end script that exercises every brief's deliverables in order, plus a cutover checklist for when production routes get bound.

## Context

Tenth and final brief in the feature. After this brief lands, the form-builder is shippable end-to-end on workers.dev / staging. Production cutover (binding `splashcarwashes.info/forms/*` route on `splash-forms`) is operator-driven and explicitly out of scope.

## Scope

### Phase 1 — Dashboard tile

**File:** `apps/web/app/admin/dashboard/page.tsx` (MODIFY).

Append a new tile after the existing 7 (Pricing / Damage / Performance / Sysadmin / Signup Admin / Work Orders / Fleet Inquiries):

```tsx
import { ClipboardList } from "lucide-react";

// In the tile grid:
<DashboardTile
  href="/admin/forms"
  icon={<ClipboardList />}
  title="Forms"
  description="Build and manage admin-built forms."
/>
```

(Executor copies the exact `<DashboardTile>` component shape from one of the existing tiles — should already be a shared component or repeated pattern in the file.)

### Phase 2 — Error boundary

**File:** `apps/web/app/admin/forms/error.tsx` (NEW).

```tsx
"use client";
import { useEffect } from "react";

export default function FormsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[forms] segment error", error);
  }, [error]);

  // The Brief 31 pattern catches Next 15 server-action ID mismatches.
  // For forms, the most likely throw is a worker fetch failure or schema parse error.
  const isActionMismatch = error.message?.includes("UnrecognizedActionError") ||
                           error.message?.includes("Server Action") && error.message?.includes("not found");

  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-bold text-red-700 mb-2">Couldn't load form builder</h1>
      <p className="text-gray-700 mb-4">
        {isActionMismatch
          ? "The page got out of sync with the server (this can happen after a deploy). Reload to continue."
          : "Something went wrong loading this page. Try again — if it keeps happening, check the worker logs."}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => isActionMismatch ? window.location.reload() : reset()}
          className="bg-blue-600 text-white px-4 py-2 rounded font-medium"
        >
          {isActionMismatch ? "Reload" : "Try again"}
        </button>
      </div>
      {error.digest && <p className="text-xs text-gray-400 mt-4 font-mono">Error digest: {error.digest}</p>}
    </main>
  );
}
```

### Phase 3 — Verify middleware coverage

**File:** `apps/web/middleware.ts` (VERIFY — likely no change).

Grep for the matcher config. Expect `/admin/:path*` covers `/admin/forms/*`. If `ADMIN_KNOWN_SUBPATHS` (Brief 83 introduced) needs `"forms"` appended, do that — otherwise the legacy `/admin/{slug}` redirect rule might intercept `/admin/forms` and 308 to `/admin/pricing/forms`.

```ts
// Inside ADMIN_KNOWN_SUBPATHS array, ensure "forms" is present.
const ADMIN_KNOWN_SUBPATHS = [
  // existing: dashboard, pricing, sysadmin, damage, performance, signups, fleet, workorders
  "forms"   // Brief 98
];
```

(Executor verifies the existing array shape and adds if needed.)

### Phase 4 — CF rate limit (operator step, documented)

No code change. Documented in PRE_DEPLOY_FORMS.md operator step:

> ### Production rate limit on `POST /forms/api/submit/*`
>
> Link-only forms have no Turnstile and no auth gate — slug acts as the gate. To prevent abuse if a slug leaks publicly, configure a CF Rate Limiting Rule:
>
> 1. CF Dashboard → splashcarwashes.info → Security → WAF → Rate limiting rules → Create rule.
> 2. Rule name: `splash-forms-submit-rate-limit`.
> 3. If incoming requests match: `URI Path contains "/forms/api/submit/"` AND `Request Method equals POST`.
> 4. Then: Block.
> 5. With characteristics: IP source.
> 6. Period: 5 minutes. Requests: 5.
> 7. Action duration: 10 minutes.
>
> Public-audience forms are also covered (Turnstile is the primary defense; rate limit is defense in depth). Internal forms are also covered (operators submitting at >1/minute is unusual; if it becomes a real workflow, the rule can be relaxed).
>
> The rule lives at the zone level, NOT in worker code. Editing it doesn't require a code deploy.

### Phase 5 — Final PRE_DEPLOY_FORMS.md pass

**File:** `PRE_DEPLOY_FORMS.md` (MODIFY).

Sections to fill in / consolidate:

**Section 4 — Cutover plan.**

```markdown
## 4. Cutover plan

The form-builder feature is built across Briefs 89–98. Pre-cutover state:
all bound on `staging.splashcarwashes.info/forms/*` only; `splash-forms`
worker on workers.dev for direct testing. Production routes commented in
`apps/forms-worker/wrangler.toml`.

Cutover steps (operator-driven, not Claude Code):

1. **Pre-flight checks.**
   - Schema migrations from Brief 89 already run on Supabase production.
   - `splash-forms` worker deployed to production CF account.
   - All secrets bound: `SUPABASE_SERVICE_KEY`, `TURNSTILE_SECRET_KEY`,
     `FORMS_SUBMISSION_WEBHOOK_URL` (optional but recommended).
   - R2 bucket `splash-forms-files` exists.
   - apps/web service binding `FORMS_WORKER` declared.
   - Rate limit rule from Brief 98 Phase 4 in place.

2. **Bind production route.** Uncomment the production routes block in
   `apps/forms-worker/wrangler.toml`:
   ```toml
   routes = [
     { pattern = "splashcarwashes.info/forms/*", zone_name = "splashcarwashes.info" }
   ]
   ```
   Push to GitHub. CF Builds redeploys.

3. **Smoke test in production.** Run all 10 briefs' smoke tests against
   `splashcarwashes.info/forms/*`. Confirm no regressions vs. staging.

4. **Distribute first form URL.** Operator picks a real form to launch
   (likely a small internal form first). Build via `/admin/forms/new`,
   add a few fields, publish, share the URL with intended users.

5. **Monitor.** Watch CF Workers Logs for `[forms.submit]`,
   `[forms.webhook]`, `[forms.cleanup]` lines. Verify Power Automate
   flows fire correctly.

6. **Daily ops.** Submissions accumulate in `form_submissions`. Operator
   reviews via `/admin/forms/[id]/submissions`. CSV exports for offline
   work. Splash Notes + status enum for tracking.
```

**Section 5 — Smoke tests.**

Consolidate every brief's smoke tests (89-97) into one ordered checklist. Each section already exists from prior briefs — Brief 98 just verifies they're present and adds a top-level "Run all in order" note.

**Section 6 — Known limitations / v2 candidates.**

```markdown
## 6. Known limitations (v2 candidates)

- **Per-form custom webhook URLs.** v1 ships with a single
  worker-level secret. Per-form URLs need a domain allowlist + UI in
  the builder; deferred for security per planning Decision 6.
- **Auto-save in builder.** v1 requires explicit Save Draft button.
  Auto-save with debounce is a v2 add per planning Decision 3.
- **Per-location submission scoping.** v1 only super_admin + admin see
  any submissions. Per-location scoping for GMs to see their site's
  submissions is a v2 add per planning Decision 7.
- **Submitter-can-see-own-submissions.** Internal-form submitters
  can't see their own past submissions in the admin UI — they get
  the email confirmation (when webhook is wired) and that's it.
  v2 candidate.
- **Version diff renderer.** `/admin/forms/[id]/versions` shows the
  audit-trail table but no field-level diff between versions. v2.
- **Multi-file upload UX.** `FileField.allowMultiple = true` is
  declared in the schema but UI/handler treats as single-file v1.
- **CSV export across forms.** Cross-form aggregate CSV (e.g., "all
  submissions across all forms in date range") is a v2 add.
- **Form Delete from UI.** v1 explicitly omits — destructive,
  cascade to submissions and R2. SQL with sysadmin support is the v1
  path. v2 candidate: soft-delete flag + retention period.
- **Edge caching of public form HTML.** v1 renders fresh on every
  request. If measured load shows the renderer is the bottleneck,
  60s edge cache keyed on `form_id + version_id` is a small add.
- **Image dimensions.** Form-asset upload (Brief 94) doesn't extract
  width/height server-side. Brief 95 inspector can probe via
  client-side `<img>`; landed as null in DB v1.
- **Per-form rate limit overrides.** All forms get the zone-level
  rate limit. Per-form overrides (e.g., a high-traffic public survey)
  would need worker-side rate limiting tracked per form ID.
```

### Phase 6 — Final BUILD_STATE.md + INDEX.md pass

**File:** `BUILD_STATE.md` (MODIFY). Bump "Last updated"; add a Findings entry summarizing the entire form-builder feature with brief-by-brief recap. Update prioritized work list — flip all 10 briefs to `completed` (assuming Brief 98 lands last in the chain).

**File:** `BRIEFS/INDEX.md` (MODIFY). Add Brief 98 row.

### Phase 7 — Validation

```sh
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

### Phase 8 — End-to-end smoke (operator-driven)

After this brief deploys, operator runs the consolidated smoke test list from PRE_DEPLOY_FORMS.md Section 5. Each brief's smoke entries should pass in sequence:

- Brief 89: schema exists, worker boots, returns 404 stub.
- Brief 90: 3 test forms render correctly across all 3 audiences.
- Brief 91: text-field submissions land in `form_submissions`.
- Brief 92: file + signature submissions land in R2 + `form_submission_files`.
- Brief 93: lookup fields populate dynamically; server re-resolves at submit.
- Brief 94: admin API endpoints respond correctly via curl.
- Brief 95: builder UI works end-to-end (drag-drop, save draft, publish).
- Brief 96: submissions admin UI lists, filters, CSV-exports correctly.
- Brief 97: webhook fires on submit; cleanup cron runs without errors.
- Brief 98: dashboard tile clickable; error boundary catches a forced throw; rate limit rule blocks 6th request in 5 min.

## Configuration

No new env vars. Operator must complete the CF rate limit rule setup (Phase 4) for production link-only protection.

## Out of scope

- Production route binding — operator-driven cutover, NOT Claude Code.
- Anything in the v2 candidates list.
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- Dashboard tile "Forms" appears on `/admin/dashboard`.
- `apps/web/app/admin/forms/error.tsx` exists with the segment-level boundary.
- `apps/web/middleware.ts` `ADMIN_KNOWN_SUBPATHS` (or equivalent) includes `"forms"`.
- PRE_DEPLOY_FORMS.md sections 4 (Cutover plan), 5 (Smoke tests consolidated), 6 (v2 candidates) are filled in.
- BUILD_STATE.md updated with the form-builder summary; prioritized work list reflects completion.
- BRIEFS/INDEX.md has the Brief 98 row.
- `pnpm --filter @splash/web build` green.
- `pnpm typecheck` green.
- All operator-driven smoke tests pass.
- Brief Status flips to Completed.

## Report

- **Dashboard tile placement.** Confirm placement matches the existing tile grid order; surface if you re-ordered for visual balance.
- **Middleware change.** Was the `"forms"` entry added, or was it already covered by a wildcard? Surface either way.
- **CF rate limit rule.** Confirm the rule is documented in PRE_DEPLOY_FORMS.md but NOT actually created (operator-driven step).
- **Smoke results.** If operator ran the consolidated smoke pass before this brief's outcome lands, surface any failures or regressions. Otherwise note "deferred to operator."
- **v2 candidates.** Surface any candidates that came up during Brief 98 execution that weren't already in the Section 6 list.

## Outcome

**Files created:**

- `apps/web/app/admin/forms/error.tsx` — segment-level error boundary
  for `/admin/forms/*`. Mirrors `apps/web/app/admin/error.tsx` (Brief 31)
  in shape: `"use client"` + React error-boundary signature, detects
  `UnrecognizedActionError` via the same message-substring check
  (`"Server Action"` + `"was not found on the server"`), renders
  "App was updated / Reload" with `window.location.reload()` on the
  stale-action branch and "Couldn't load form builder / Try again"
  with `reset()` on the generic branch. Forms-aware copy throughout.

**Files modified:**

- `apps/web/app/admin/dashboard/page.tsx` — appended "Forms" tile to
  the `TILES` array (8th tile, after Fleet Inquiries). Inline SVG
  (lucide ClipboardList path-set) per the existing convention used by
  the seven sibling tiles. Eyebrow "Builder", title "Forms",
  description "Build and manage admin-built forms.", `href` =
  `/admin/forms`.
- `apps/web/middleware.ts` — added `"forms"` to `ADMIN_KNOWN_SUBPATHS`
  alphabetically between `"fleet"` and `"performance"`. Without this
  the legacy `/admin/{slug}` redirect rule (Brief 2) would 308
  `/admin/forms` to `/admin/pricing/forms`.
- `PRE_DEPLOY_FORMS.md` — Section 4 (Cutover plan) filled in;
  Section 5 gained the top-level "run all in order" note and 5
  Brief-98 smoke entries; new Section 6 (Known limitations / v2
  candidates — 12 entries); new Section 7 (CF Rate Limiting Rule
  operator step).
- `BUILD_STATE.md` — `Last updated` line bumped to mention Brief 98;
  prioritized work list gained a Brief 98 row marked **completed**;
  Findings & decisions log gained a Brief 98 entry above the Brief 97
  entry.
- `BRIEFS/INDEX.md` — Brief 98 row added above the Brief 97 row.
- `BRIEFS/brief-098-forms-polish-and-smoke-tests.md` — Status flipped
  to `Completed (2026-05-10)`, this Outcome section filled in.

**Files deleted:** none.

**Decisions made on operator's behalf:**

1. **Inline SVG, not lucide-react.** The brief's example used
   `import { ClipboardList } from "lucide-react"`, but the existing
   seven dashboard tiles all use inline SVG path-sets directly
   (Truck for Fleet, gear for Sysadmin, bars for Performance, etc.).
   Followed convention rather than introducing a new dep + pattern.
   The tile's icon is the lucide ClipboardList shape (clipboard with
   horizontal lines representing list items), inlined.
2. **Tile placement: end of array (8th tile).** Matches the Brief 78
   precedent of appending new tiles. Side effect: in the
   `lg:grid-cols-3` layout, the Forms tile sits alone in the third
   row (Pricing/Damage/Performance, Sysadmin/MaintainX/Fleet, then
   Forms). If operators want a balanced grid, future polish could
   re-order — out of scope here.
3. **Error boundary copy aligned with `/admin/error.tsx`.** The
   global admin boundary already uses "App was updated / Reload" for
   the stale-action branch. The brief drafted "got out of sync with
   the server" copy; I used the established phrasing for cross-app
   consistency. Operators see this exact wording elsewhere already.
4. **Generic-branch heading "Couldn't load form builder".** Matches
   the brief's draft. Body copy slightly tightened: "Something went
   wrong loading this page. Try again — if it keeps happening, check
   the worker logs."
5. **`forms` slotted alphabetically into `ADMIN_KNOWN_SUBPATHS`.** The
   existing array is alphabetical (`dashboard`, `damage`, `fleet`,
   `performance`, `pricing`, `signups`, `sysadmin`, `api`). Inserted
   `forms` between `fleet` and `performance`.
6. **CF rate-limit rule documented but NOT created.** Per Decision 8c
   and the brief's "No code change. Documented in PRE_DEPLOY_FORMS.md
   operator step." Section 7 has the full create-rule walkthrough
   ready for the operator.
7. **CLAUDE.md NOT extended.** The form-builder glossary section is
   already comprehensive across Briefs 89–97; Brief 98 is pure
   UI/middleware/docs polish with no new architectural concept worth
   adding.
8. **Section 5 "run all in order" note placed above the Brief 90
   header.** Brief mentioned "verifies they're present and adds a
   top-level 'Run all in order' note" — placed it once at the top of
   Section 5 rather than repeating per-brief.

**Latent issues / forward flags:**

- (a) **CF rate-limit rule untested.** Headless cannot create the
  rule and cannot verify the 429 behavior. Flagged in Section 5
  Brief-98 smoke entry #5 for operator post-rule-creation.
- (b) **Stale-action branch uses the same code shape as the global
  boundary.** React's error-boundary semantics walk up the tree, so
  the closest boundary catches first — the forms-specific boundary
  IS the closest for `/admin/forms/*`. Verified by reading the
  Brief 31 boundary file and confirming both boundaries return UI
  rather than rethrow.
- (c) **No "Save Draft" / "Publish" smoke test in Brief 98.** Those
  are covered by Brief 95's smoke list; Brief 98 only adds the
  boundary + tile + middleware tweak.
- (d) **Brief 95's form-meta persistence latent issue** (FormMeta
  Inspector edits stay client-side; only `schema.fields` persists)
  is now also surfaced in PRE_DEPLOY_FORMS.md Section 6 as a v2
  candidate.
- (e) **Tile order leaves Forms alone in the third grid row.** See
  decision 2 above.
- (f) **Smoke pass deferred to operator.** Headless cannot exercise
  the dashboard tile click, the legacy-redirect non-interception,
  the forced-throw error boundary, or the CF rate-limit. All five
  Brief-98 smoke entries are written for the operator to run
  post-deploy.

**Validation results:**

- `pnpm --filter @splash/web typecheck` → green (no output = no
  errors; tsc --noEmit returned 0).
- `pnpm --filter @splash/web build` → green. `next build` compiled
  successfully in 5.0s; all 25 routes generated. Route bundle deltas:
  `/admin/dashboard` unchanged (161 B / 105 kB First Load JS — the
  inline SVG addition is server-rendered and not part of the client
  bundle); `/admin/forms` unchanged from Brief 95 (717 B / 106 kB
  First Load JS); error boundary code-splits into a lazy chunk that
  doesn't count against any route bundle.
- `pnpm typecheck` (root) → 17/17 successful, 16 cache hits, 1 fresh
  build (`@splash/web` only — only apps/web changed). 2.849s.

**Smoke test status:** deferred to operator. The 5 Brief-98 smoke
entries in PRE_DEPLOY_FORMS.md Section 5 require either a live deploy
of `splash-web` (tile click, middleware non-interception, error
boundary, stale-action branch) or a CF zone-level rule + IP source
(rate limit). Headless cannot exercise any of them.

**v2 candidates surfaced during execution:** none beyond what's
already in Section 6's 12-entry list. The form-meta persistence
caveat from Brief 95 was already a forward flag and is now
documented in Section 6.

**Operator action items:**

1. After deploying `splash-web` next, run the 5 Brief-98 smoke
   entries in PRE_DEPLOY_FORMS.md Section 5.
2. Configure the CF Rate Limiting Rule per Section 7 before
   production cutover.
3. When ready to cut the production route over, follow Section 4's
   step-by-step.
