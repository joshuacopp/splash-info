# Brief 104: Strip `claims/` prefix in internal-new-claim webhook photo URLs

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither — bug fix in a fail-soft optional webhook;
internal email's photo links currently 404 but the rest of the
webhook (admin link, customer details, claim_id) works correctly.
**Dependencies:** Brief 102 (`fireInternalNewClaimNotification` —
the bug is in its photo URL construction at
`apps/damage-worker/src/index.ts` ~L3403-3408).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-102-damage-new-claim-internal-alert.md (introduced
  the bug)
- apps/damage-worker/src/index.ts (`fireInternalNewClaimNotification`
  photo URL build ~L3403-3408)
- packages/storage-r2/src/index.ts (`serveClaimPhoto` ~L212-230 —
  prepends `claims/` to the suffix it receives; `uploadClaimPhoto`
  ~L121 — writes the full key `claims/{claimId}/{slug}_{n}.{ext}`)
- apps/web/app/admin/damage/_lib/worker-fetch.ts (`damagePhotoUrl`
  ~L140-144 — the existing reference helper that strips `claims/`
  and URL-encodes path segments before building the
  `/claims-api/photo/{suffix}` URL; the bug is that Brief 102 didn't
  follow this pattern)

## Context

Operator reported on 2026-05-11 that photo links inside the
internal-new-claim email (built by Brief 102) all resolve to "Photo
not found" when clicked. URL pattern from the report:

```
https://staging.splashcarwashes.info/claims-api/photo/claims/MIL-20260511-141906-LOMM/damage_1.jpg
```

**Root cause:** the R2 key in `claim_photos.r2_key` includes the
`claims/` prefix (e.g., `claims/MIL-20260511-141906-LOMM/damage_1.jpg`)
— that's what `uploadClaimPhoto` writes at packages/storage-r2 L121.
The damage-worker route `/claims-api/photo/{suffix}` then passes
`{suffix}` to `serveClaimPhoto`, which **prepends another `claims/`**
before the R2 `.get()`. So `claim_photos.r2_key` of
`claims/MIL-…/damage_1.jpg` produces a lookup against
`claims/claims/MIL-…/damage_1.jpg`, which doesn't exist.

The existing apps/web admin damage detail page handles this correctly
via `damagePhotoUrl` (apps/web/app/admin/damage/_lib/worker-fetch.ts
L140-144), which strips the leading `claims/` and URL-encodes path
segments. Brief 102's
`fireInternalNewClaimNotification` did not replicate that pattern —
it built the URL as `${baseOrigin}/claims-api/photo/${p.r2_key}`
verbatim.

**Scope of the bug:** photo links inside emails fired by
`INTERNAL_NEW_CLAIM_WEBHOOK_URL` (Brief 102). The customer-claim
webhook (Brief 32) does NOT include photo URLs in its payload, so
customer emails are unaffected. The `summary_pdf_url` field
(present in both webhooks' payloads) uses a different route
(`/claims-api/summary/{claim_id}`) and is correct — only the photo
URLs are broken.

## Scope

### Phase 1 — Fix the photo URL build in damage-worker

Single file: `apps/damage-worker/src/index.ts`.

Locate the photo URL construction in
`fireInternalNewClaimNotification` (~L3400-3410). Currently:

```ts
photos = rows
  .filter((p) => !p.deleted_at && p.r2_key)
  .map((p) => ({
    url: `${baseOrigin}/claims-api/photo/${p.r2_key}`,
    mime: p.mime ?? null,
    original_filename: p.original_filename ?? null,
    photo_type: p.photo_type ?? null,
    uploaded_at: p.uploaded_at
  }));
```

Replace the `url` line so it strips the leading `claims/` (if
present) and URL-encodes path segments, mirroring
`damagePhotoUrl` in apps/web:

```ts
photos = rows
  .filter((p) => !p.deleted_at && p.r2_key)
  .map((p) => {
    const stripped = p.r2_key.startsWith("claims/")
      ? p.r2_key.slice("claims/".length)
      : p.r2_key;
    const segments = stripped.split("/").map(encodeURIComponent).join("/");
    return {
      url: `${baseOrigin}/claims-api/photo/${segments}`,
      mime: p.mime ?? null,
      original_filename: p.original_filename ?? null,
      photo_type: p.photo_type ?? null,
      uploaded_at: p.uploaded_at
    };
  });
```

The `.startsWith("claims/")` check is defensive — every row written
by `uploadClaimPhoto` has the prefix today, but the check makes the
fix resilient to any historical or future row that might not.

### Phase 2 — Consider extracting a shared helper (optional)

The same strip-and-encode pattern now lives in two places:
- `apps/web/app/admin/damage/_lib/worker-fetch.ts` `damagePhotoUrl`
- `apps/damage-worker/src/index.ts` `fireInternalNewClaimNotification`
  (after this fix)

A shared helper in `packages/storage-r2` (e.g.,
`buildPhotoServeUrl(baseOrigin, r2Key)`) would centralize the logic.
Defer for now — duplication is small (3 lines) and the brief is
intentionally scoped to the fix. If a third caller needs the pattern,
extract then.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
    after.
3.3 No D1 / Supabase / R2 schema change. No new env / secret. No
    wrangler.toml change.
3.4 Operator post-deploy smoke (deferred — out of brief's hands):
    submit a test claim via `/claims/{slug}` on workers.dev or
    staging, wait for the internal email, click any photo link.
    Should now load the image inline (image/jpeg, Content-Type from
    R2 object metadata) instead of "Photo not found".

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 104 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 104 (2026-05-11) — fix for Brief 102: internal-new-claim
    webhook photo URLs failed to load because the URL built was
    `/claims-api/photo/{r2_key}` verbatim, but `r2_key` includes
    the `claims/` prefix that `serveClaimPhoto` re-prepends —
    double-prefix → 404. Strip the prefix before URL build,
    matching the existing `damagePhotoUrl` helper pattern in
    apps/web. No data / contract change; PA flow B does not need
    to be re-edited.

4.3 CLAUDE.md glossary INTERNAL_NEW_CLAIM_WEBHOOK_URL entry: append
a one-liner noting the Brief 104 fix so future readers find the
strip-and-encode pattern when modifying this code path.

## Out of scope

- Extracting a shared `buildPhotoServeUrl` helper in
  `packages/storage-r2`. v2 candidate when a third caller appears.
- Changing `serveClaimPhoto` to accept either prefixed or unprefixed
  keys (i.e., remove the implicit `claims/` prepend). That would be
  a contract change with risk of breaking existing callers — Brief
  104 stays surgical.
- Changing the customer-claim webhook (Brief 32) — it doesn't
  include photo URLs in its payload, so it has no exposure to this
  bug.
- Adjusting the PA Flow B template. The flow uses the
  `triggerBody()?['photos']?[*]?['url']` field as-is; fixing the
  worker-side build is sufficient — once the URL the worker emits
  is correct, the flow's existing rendering works.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/damage-worker/src/index.ts` `fireInternalNewClaimNotification`
  photo URL construction strips a leading `claims/` from `r2_key`
  and URL-encodes path segments.
- `pnpm typecheck` passes for all packages.
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run` bundle succeeds and cleans up after.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size confirmation (likely 8-12 lines net inside
  `fireInternalNewClaimNotification`, plus the doc rows)
- Validation results
- Confirmation the strip-and-encode matches `damagePhotoUrl`
  exactly (so the two helpers don't drift)
- Any decisions made on the operator's behalf

## Outcome

**Files modified.**

- `apps/damage-worker/src/index.ts` — `fireInternalNewClaimNotification`
  photo URL build (~L3402-3413). The `.map()` body was rewritten from a
  one-expression arrow returning the photo object literal to a
  block-bodied arrow that derives the stripped + URL-encoded path
  before constructing the URL. Net diff inside the helper: ~10 lines.
  Field-name shape preserved (`p.content_type` → `mime`, `p.filename`
  → `original_filename`) — the brief's verbatim "currently" and
  "replacement" example used `p.mime` / `p.original_filename` which
  don't exist on the row type returned by `listPhotosForClaim`. The
  actual Brief 102 code path used `content_type` / `filename`, and
  that's preserved.
- `CLAUDE.md` — `INTERNAL_NEW_CLAIM_WEBHOOK_URL` glossary entry
  extended with a Brief 104 paragraph documenting the strip-and-encode
  pattern and cross-referencing the `damagePhotoUrl` helper. Future
  readers modifying any `/claims-api/photo/...` URL-build site will
  find the convention.
- `BRIEFS/INDEX.md` — Brief 104 row appended (slotted next to Brief
  102's row at the bottom of the table, before "Folded items").
- `BUILD_STATE.md` — "Last updated" line bumped to 2026-05-11 with a
  Brief 104 summary; new Findings entry at the top of the table
  describing the root cause, fix, scope of the bug, and the field-name
  decision.

**Decisions made on the operator's behalf.**

1. Preserved existing `p.content_type` / `p.filename` field-name
   shape rather than adopting the brief's example shape
   (`p.mime` / `p.original_filename`). Reason: those field names
   don't exist on the actual row type returned by `listPhotosForClaim`
   — the brief's "currently" example was a paraphrase; the Brief 102
   code path was using the canonical column names from
   `claim_photos`. Following the brief verbatim would have introduced
   a typecheck failure.

**Latent issues found.**

- None new. The pre-existing duplication of the strip-and-encode
  pattern in `damagePhotoUrl` + the now-fixed worker-side build
  remains; the brief calls out a `buildPhotoServeUrl` shared helper
  in `packages/storage-r2` as a v2 candidate when a third caller
  appears.
- Workers Logs `[forms.webhook]`-style instrumentation isn't added
  for `INTERNAL_NEW_CLAIM_WEBHOOK_URL` photo URL construction —
  fail-soft webhook + observable via the operator post-deploy click-
  test smoke; consistent with the existing posture for this code
  path.

**Validation results.**

- `pnpm typecheck` (root, Turbo orchestration): 17/17 successful.
  16 cache hits + 1 cache miss on `@splash/damage-worker` (fresh
  build, completed successfully).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`: bundle succeeded at 1728.81 KiB raw / 391.10
  KiB gzipped (≈ unchanged vs Brief 102 baseline of 1728.60 KiB raw
  / 391.03 KiB gzipped). All 7 bindings present and resolved (`DB`,
  `R2_BUCKET`, `IMAGES`, `MAINTAINX_MODE`, `MAINTAINX_BASE_URL`,
  `APPS_WEB_BASE_URL`, `INCIDENTS_EMAIL`). `.tmp-build` directory
  cleaned up after the run.
- No D1 / Supabase / R2 schema change. No new env / secret. No
  wrangler.toml change.
- Operator post-deploy smoke (deferred per Definition of Done §3.4):
  submit a test claim via `/claims/{slug}` on workers.dev or staging,
  wait for the internal email, click any photo link. The image
  should now load inline (`image/jpeg`, Content-Type from R2 object
  metadata) instead of "Photo not found".

**Confirmation of `damagePhotoUrl` exactness.** The new construction
inside `fireInternalNewClaimNotification` matches
`apps/web/app/admin/damage/_lib/worker-fetch.ts` L141-143
character-for-character on the strip-and-encode logic:

```ts
const stripped = p.r2_key.startsWith("claims/")
  ? p.r2_key.slice("claims/".length)
  : p.r2_key;
const segments = stripped.split("/").map(encodeURIComponent).join("/");
```

If a future executor extracts `buildPhotoServeUrl(baseOrigin, r2Key)`
to `packages/storage-r2`, both call sites can be updated in lockstep
without diffs in semantics.
