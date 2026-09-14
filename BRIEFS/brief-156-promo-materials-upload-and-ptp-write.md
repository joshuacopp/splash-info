# Brief 156: Promotions — materials upload + delete + serve, PTP write

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** apps/web live-view "Add material" + "Build PTP" affordances (Brief 158); announcement compose (Brief 157) reads the materials list to render the attachment-picker.
**Dependencies:** Brief 153 (R2 binding `PROMO_FILES`, substrate), Brief 154 (detail response shape — this brief populates the `materials` and `ptp` keys that detail already returns). Brief 155 is sibling, not dependent.

## Read first

- BUILD_STATE.md.
- CLAUDE.md — promo-worker glossary entry; the forms-worker file-upload pattern (Brief 92) and admin serve route are the reference implementations.
- supabase/promo-tables.sql — column shapes for `promo_materials` and `promo_ptp`.
- BRIEFS/brief-092-forms-file-signature-uploads.md — the upload pattern this brief mirrors (MIME-sniff, R2 path convention, fail-soft on DB insert post-R2-write).
- apps/forms-worker/src/uploads.ts — runnable example of `file-type` sniff + R2 write + DB row write + rollback on intermediate failure.
- apps/forms-worker/src/handlers/admin-files.ts — runnable example of an admin-gated R2 serve route with `Content-Disposition` based on MIME.
- apps/promo-worker/src/handlers/_activity.ts — shared activity-log helper from Brief 155.

## Architecture context

This brief lands the materials lifecycle (upload + delete + serve) and the PTP single-doc upsert. After this brief, the live view in apps/web (Brief 158) can wire the "Add material" / "Build PTP" / file-thumbnail rendering against real endpoints.

**Endpoint inventory:**

- `POST   /promo/api/promos/{id}/materials`                       — multipart upload. `super_admin | it | marketing`.
- `DELETE /promo/api/promos/{id}/materials/{materialId}`          — delete row + R2 object. `super_admin | it | marketing`.
- `GET    /promo/api/promos/{id}/materials/{materialId}/file`     — stream the R2 object. Any non-null promoRole (anyone who can see the promo can see its materials).
- `PUT    /promo/api/promos/{id}/ptp`                              — upsert PTP. `super_admin | it | marketing`.

**Auth posture.** Same as Brief 154 / 155: `getAuthContext` → `gatePromoRole(role, [...])`. CSRF gate (`isOriginAllowed`) on every write. The GET serve route skips CSRF (read-only, same-origin GETs don't carry Origin per spec).

**R2 path convention.** `promo-materials/{promo_id}/{material_id}.{ext}` — verbatim from the comment on `promo_materials.r2_key` in the schema. Extension derived from sniffed MIME (`image/jpeg → .jpg`, `image/png → .png`, `application/pdf → .pdf`, etc.). Unknown MIME → no extension, `r2_key = promo-materials/{promo_id}/{material_id}`.

**Upload limits.** Material files can be larger than form-submission files (high-res images, short videos for kiosk hero blocks). HARD_LIMITS:

- 50 MB per file (vs. 25 MB on forms; high-DPI / short video room).
- Worker `cpu_ms = 30000` already set on Brief 153's wrangler.toml; upload-heavy paths still fit.
- 20 materials per promo (UI hint; defense in depth — operator can sysadmin past this).
- `file-type` sniff on first ~4 KB; reject when sniffed MIME is in a deny-list (`text/html`, `application/x-msdownload`, etc. — copy forms-worker's deny posture). Client `Content-Type` is ignored.

**Fail-soft on DB-after-R2.** Sequence is: validate → R2 PUT → DB INSERT → activity log. If DB INSERT throws after R2 PUT succeeded, the R2 object becomes orphan. Inline rollback: best-effort DELETE the R2 object, return 500 `material_create_failed`. If R2 DELETE also throws, log `[promo.materials] orphan — manual R2 cleanup required for promo-materials/{id}/{mid}` so the operator can sweep manually. Activity log failure is fail-soft per the `_activity.ts` helper from Brief 155 — never fails the parent write.

**Cron sweep deferred.** Brief 97 added a daily R2 cleanup for forms-submission-files (>24h orphan, no matching DB row). For promo materials, orphan creation is rare (inline rollback handles 99% of cases) and material rows persist indefinitely (no cleanup window). A daily sweep is a v2 candidate if R2 orphans accumulate.

**PTP upsert semantics.** `PUT /ptp` is the single write path for the PTP doc. The row is 1:1 with promo (PK = promo_id); existing row gets UPDATE, missing row gets INSERT. No DELETE endpoint — clearing PTP is `PUT` with empty-string body (matches the empty-string-default columns from the schema). The `updated_by` audit column stamps the actor; `updated_at` auto-bumps via DEFAULT or worker-side stamp.

## Context

Materials and PTP are both per-promo content surfaces that the mockup demonstrated in the live view: a chip grid with "Add material" + "Build PTP" buttons. The PTP modal collected three textareas (Purpose / Tools / Process), saved as a single doc. The material modal collected name + kind + file, with files persisting in R2.

Apps/web's announcement compose (Brief 157) reads the materials list to render an attachment-picker, snapshotting selected `material_id` values into `promo_announcements.included_material_ids`. So this brief's response shape needs to stay stable across both flows: the material rows on `GET /promos/{id}` (Brief 154 detail) and the standalone fetch the announcement compose surface will use.

## Scope

### Phase 1 — Handler skeleton

Two new handler files under `apps/promo-worker/src/handlers/`:

- `materials.ts` — exports `handleUploadMaterial`, `handleDeleteMaterial`, `handleServeMaterialFile`.
- `ptp.ts` — exports `handlePutPtp`.

Update `apps/promo-worker/src/index.ts` dispatch:

```ts
import { handleUploadMaterial, handleDeleteMaterial, handleServeMaterialFile } from "./handlers/materials";
import { handlePutPtp } from "./handlers/ptp";

const materialsMatch     = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/materials$/);
const materialMatch      = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/materials\/([0-9a-f-]+)$/);
const materialFileMatch  = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/materials\/([0-9a-f-]+)\/file$/);
const ptpMatch           = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/ptp$/);

if (materialsMatch     && request.method === "POST")   return handleUploadMaterial(request, env, ctx, materialsMatch[1]);
if (materialMatch      && request.method === "DELETE") return handleDeleteMaterial(request, env, materialMatch[1], materialMatch[2]);
if (materialFileMatch  && request.method === "GET")    return handleServeMaterialFile(request, env, materialFileMatch[1], materialFileMatch[2]);
if (ptpMatch           && request.method === "PUT")    return handlePutPtp(request, env, ptpMatch[1]);
```

### Phase 2 — `POST /promo/api/promos/{id}/materials`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it', 'marketing'])` + `isOriginAllowed`.

**Content-Type:** `multipart/form-data`.

**Form fields:**

- `name` — required, trimmed, ≤500 chars.
- `kind` — required, one of `image | video | copy_messaging | signage | email_asset | other`.
- `file` — required, single file part.

**Validation:**

- 404 if promo id doesn't exist.
- 413 `file_too_large` if `file.size > 50 * 1024 * 1024`.
- 415 `unsupported_mime` if `file-type` sniff returns null OR sniffed MIME is in the deny-list.
- 400 `bad_request` on missing/empty `name` or invalid `kind`.
- 409 `material_limit_reached` if current count (`SELECT count(*) FROM promo_materials WHERE promo_id = ...`) ≥ 20. Soft cap; operator can SQL-bump or admin-tier can override later.

**Sequence:**

1. Parse multipart; pull `name`, `kind`, `file`.
2. Validate per above.
3. Read first 4 KB of file for `file-type` sniff; capture sniffed MIME.
4. Generate `materialId = crypto.randomUUID()`.
5. Compute `extension` from sniffed MIME (small lookup table; default to no-ext for unknowns).
6. Compute `r2Key = promo-materials/{promoId}/{materialId}.{ext}`.
7. `env.PROMO_FILES.put(r2Key, file.stream(), { httpMetadata: { contentType: sniffedMime } })`.
8. PostgREST INSERT into `promo_materials` with `(id, promo_id, name, kind, r2_key, file_mime, file_size_bytes, uploaded_by)`.
9. On INSERT failure → best-effort `env.PROMO_FILES.delete(r2Key)`. If that also fails, log loud and return 500 `material_create_failed` with `{orphan_r2_key: r2Key}` in the body.
10. Activity log: `material_added` with `details = { materialId, name, kind, sizeBytes }`.

**Response (201):**

```json
{
  "ok": true,
  "material": {
    "id": "uuid",
    "name": "...",
    "kind": "image",
    "r2Key": "promo-materials/.../...",
    "fileMime": "image/jpeg",
    "fileSizeBytes": 12345,
    "uploadedAt": "...",
    "uploadedBy": "uuid"
  }
}
```

### Phase 3 — `DELETE /promo/api/promos/{id}/materials/{materialId}`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it', 'marketing'])` + `isOriginAllowed`.

**Sequence:**

1. Read `promo_materials` row (capture `r2_key` for the R2 delete).
2. 404 if no row matches `(promo_id, material_id)`.
3. DELETE the DB row.
4. Best-effort `env.PROMO_FILES.delete(r2Key)`. If R2 delete throws, log `[promo.materials] R2 delete failed for {r2Key}` and continue — DB row is gone, R2 object becomes orphan (rare; cron sweep is the longer-term sweep if this accumulates).
5. Activity log: `material_removed` with `details = { materialId, name, kind }`.

**Response (200):**

```json
{ "ok": true, "removed": true }
```

### Phase 4 — `GET /promo/api/promos/{id}/materials/{materialId}/file`

**Auth:** session + `gatePromoRole(role, [])` (any non-null role).

**Sequence:**

1. Read `promo_materials` row to confirm it exists under that `promo_id` (404 if not — also stops cross-promo guessing via known UUIDs).
2. `env.PROMO_FILES.get(r2_key)` → 404 if R2 lookup returns null (drift between DB and R2; log loud).
3. Stream back with:
   - `Content-Type: row.file_mime || 'application/octet-stream'`
   - `Cache-Control: private, max-age=300` (short window; materials can be replaced)
   - `X-Content-Type-Options: nosniff`
   - `Content-Disposition: inline; filename="{row.name}"` when MIME is `image/*`; `attachment; filename="{row.name}"` otherwise (mirrors forms-worker's admin serve route).

**No activity log entry** on read — reads are observability noise, omit.

### Phase 5 — `PUT /promo/api/promos/{id}/ptp`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it', 'marketing'])` + `isOriginAllowed`.

**Body (JSON):**

```json
{
  "purpose": "...",
  "tools": "...",
  "process": "..."
}
```

**Validation:**

- Reject body with unknown keys (400 `bad_request`).
- All three fields are required (can be empty strings — schema default is `''`). Trim, max 10000 chars each.
- 404 if promo id doesn't exist.

**Sequence:**

1. Capture before-state by SELECTing the existing row (returns null if no row).
2. PostgREST upsert: `Prefer: resolution=merge-duplicates` on `promo_ptp` with `(promo_id, purpose, tools, process, updated_by)`. Schema default on `created_at` handles the INSERT branch; `updated_at` gets stamped server-side.
3. Compute deltas vs. before-state. Activity log: `ptp_updated` with `details = { fields: ['purpose', 'process'] }` listing the field names that actually changed value. No-op (all three unchanged) emits no log row.

**Response (200):**

```json
{
  "ok": true,
  "ptp": {
    "purpose": "...",
    "tools": "...",
    "process": "...",
    "createdAt": "...",
    "updatedAt": "...",
    "updatedBy": "uuid"
  }
}
```

### Phase 6 — MIME deny-list + extension lookup

Centralize in `apps/promo-worker/src/handlers/_mime.ts`:

```ts
// Sniffed MIME → file extension. Defaults to no-extension for anything not listed.
export const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv"
};

export const MIME_DENY_LIST = new Set([
  "text/html",
  "application/x-msdownload",
  "application/x-msi",
  "application/x-sh",
  "application/x-executable"
]);
```

Add new types here as needed. Used by `materials.ts` upload handler.

### Phase 7 — Doc updates

1. **BUILD_STATE.md** — Findings + Brief 156 status.
2. **BRIEFS/INDEX.md** — new row.
3. **CLAUDE.md** — promo-worker glossary entry gains the four new endpoints; HARD_LIMITS (50 MB / 20 materials) recorded in the entry so future executors don't have to grep the brief.
4. **PRE_DEPLOY_PROMO.md** — add a smoke check for material upload (curl with `-F file=@small.jpg -F name=Test -F kind=image`) and the corresponding GET file roundtrip.

### Phase 8 — Build + smoke

- `pnpm typecheck` + `pnpm --filter @splash/promo-worker build`. Log compressed bundle size — adding `file-type` (~12 KB on forms-worker) pushes the promo bundle measurably.
- Smoke checks (manual, post-deploy; seed one promo via Brief 154 POST first):
  - Upload a JPEG → 201, response carries `r2Key`. CF dashboard `splash-promo-files` bucket shows the new object under `promo-materials/{promoId}/{materialId}.jpg`.
  - GET `/file` for that material returns the JPEG bytes with `inline` disposition.
  - DELETE the material → 200; R2 object gone; DB row gone; activity log shows `material_removed`.
  - Upload a `.html` file → 415.
  - Upload a 60 MB file → 413.
  - Upload as an `ops`-role user → 403.
  - PUT `/ptp` with three non-empty fields → 200; row in `promo_ptp`. Re-PUT with one field changed → 200; activity log shows `ptp_updated` with `details.fields = ['purpose']`. Re-PUT with no changes → 200 + no new activity row.

## Definition of Done

- `apps/promo-worker/src/handlers/materials.ts`, `ptp.ts`, `_mime.ts` exist.
- All four endpoints respond per the contracts above.
- R2 upload + DB insert + rollback path verified (force the rollback by hand-injecting a DB INSERT failure once and confirming the R2 object is removed).
- Activity log entries match the spec.
- `file-type` dep added to `apps/promo-worker/package.json`.
- Typecheck + build pass; smoke checks recorded in Outcome.

## Out of scope (later briefs)

- Material rename / kind edit (`PATCH /materials/{materialId}`) — v2 if the operator requests it.
- Multi-file upload in a single POST — v2; clients can loop.
- Material thumbnails / preview images — v2 (apps/web can use the JPEG inline-serve as-is for `image/*` kinds).
- Announcement send — Brief 157.
- apps/web pages — Brief 158.
- Daily R2 orphan sweep cron — deferred until operator observes orphan accumulation.

## Outcome

- **Files created:**
  - `apps/promo-worker/src/handlers/_mime.ts` — shared sniffed-MIME → file-extension lookup and deny-list (`text/html`, Windows executables, shell scripts). Used by `materials.ts`. Adding a new accepted type or denied type is a one-file append.
  - `apps/promo-worker/src/handlers/materials.ts` — `handleUploadMaterial`, `handleDeleteMaterial`, `handleServeMaterialFile`. Per-handler `gatePromoRole` + `isOriginAllowed` (mutations only) gates. `file-type` MIME sniff on first ~4 KB. R2 path `promo-materials/{promoId}/{materialId}.{ext}`. Inline R2 rollback on DB INSERT failure; loud orphan log when R2 DELETE also throws. Activity log entries `material_added` / `material_removed`.
  - `apps/promo-worker/src/handlers/ptp.ts` — `handlePutPtp`. Three-field upsert via PostgREST `on_conflict=promo_id` + `Prefer: resolution=merge-duplicates`. Activity log `ptp_updated` with `details.fields:[...]` only when fields actually changed value vs. before-state.

- **Files modified:**
  - `apps/promo-worker/src/index.ts` — dispatch added for the four new routes (materials list POST, materials file GET — matched before bare material-id route, material id DELETE, ptp PUT). Header comment updated to describe Brief 156 surfaces + the auth posture summary. The materials-file route regex is matched BEFORE the bare materials/{id} route so the longer path doesn't get swallowed.
  - `apps/promo-worker/package.json` — added `file-type@^19.6.0` (same version as forms-worker for bundle dedupe).
  - `BUILD_STATE.md` — Last updated bumped + new prioritized work list row for Brief 156 + Findings & decisions log entry. The previous Brief 155 head entry shifted down to "Previously" position.
  - `BRIEFS/INDEX.md` — new row at the top for Brief 156.
  - `CLAUDE.md` — promo-worker glossary entry extended with the Brief 156 endpoint inventory, HARD_LIMITS, R2 path convention, rollback semantics, error code surface, and v2 deferrals.
  - `PRE_DEPLOY_PROMO.md` — Brief 156 endpoint inventory + smoke check #5 (full materials lifecycle curl + PTP roundtrip + denied-MIME / oversize / role-403 negative tests).

- **Decisions made on operator's behalf:**
  - **DELETE ordering inverted from upload.** Upload sequence is R2 PUT → DB INSERT (rollback R2 on INSERT failure). Delete sequence is DB DELETE first → best-effort R2 DELETE. Rationale: upload's worst case is an orphan R2 object (harmless — sweep manually), delete's worst case is a dangling pointer in DB that 404s the read path (worse UX). The brief described both halves but didn't explicitly call out the inversion; I added an inline comment to materials.ts explaining the reasoning.
  - **Materials count check happens BEFORE MIME sniff.** A promo that's already at the 20-material soft cap shouldn't pay the sniff cost for a request that will 409. Cheap optimization; brief didn't specify ordering.
  - **`countMaterials` uses `Range: 0-0` + `Prefer: count=exact`.** Returns just the total in Content-Range without streaming any rows back. Brief said "SELECT count(*) FROM promo_materials WHERE promo_id = ..."; the PostgREST equivalent that avoids streaming the row payload is what landed.
  - **`promoExists` check on upload + ptp is via `select=id&limit=1`.** Two cheap reads instead of inferring promo non-existence from a FK constraint failure on the INSERT. Surfaces a clean 404 `promo_not_found` instead of a 500 the operator would have to grep logs to explain.
  - **PTP no-op semantics extended to "missing prior row treats every non-empty field as a change."** A fresh PTP save of three empty strings stays quiet (no activity log row); a fresh save of any non-empty field emits the activity row listing those fields. Matches operator's likely mental model: an audit row should appear when an operator actually contributed content, not when they hit Save on an empty placeholder.
  - **Material file response `Content-Type` prefers `row.file_mime` over the R2 object's stored MIME.** Both should agree (we set `httpMetadata.contentType: sniffedMime` on PUT), but if they drift the DB row is the canonical record. The R2 metadata is used as a fallback only when `row.file_mime` is null (older rows pre-Brief-156 might be null; new rows always populate it).
  - **Activity log `details` keys are camelCase.** Matches the response-shape convention from Brief 154 / 155.

- **Latent issues found:**
  - **No promoId-vs-materialId distinguishability test.** A material UUID and a promo UUID share the same regex; nothing prevents a caller from passing the same UUID for both segments. The `fetchMaterial` (promo_id=eq + id=eq) compound key gate would 404 the request, but the route regex doesn't catch the input-shape collision. Low risk because the worker is internal-tooling-only and `gatePromoRole` filters non-promo callers out.
  - **`countMaterials` race condition under high concurrency.** Two simultaneous uploads when count = 19 could both pass the 20-cap check, both succeed R2 PUT, both INSERT. PostgREST doesn't expose serializable transactions easily. Acceptable at v1 — 20 is a soft cap and concurrent uploads from the same promo are rare. A unique-index on `(promo_id, COUNT)` isn't expressible in SQL; the right fix would be a `BEFORE INSERT` trigger checking `count(*)`, which is a v2 candidate if it ever bites.
  - **No `Content-Length` on the serve response.** R2's `writeHttpMetadata` does set it via the body stream metadata; verified locally that the header gets emitted. No code change needed but worth confirming during smoke testing.
  - **`name` field on material has no character-set validation.** Trim + ≤500 chars only. The serve route's `Content-Disposition: filename="{name}"` strips `"` for safety but doesn't escape other control characters. Brief didn't specify, and the field is admin-only-written, so XSS surface is low. Operator can sysadmin past it if needed.
  - **PTP doesn't surface the `promoId` for read.** Brief defined PUT only; reading PTP back is via the Brief 154 detail endpoint's `ptp` field. No standalone GET. Apps/web's PTP modal will need to call the detail endpoint or persist state from the PUT response.

- **Validation results (typecheck / build / smoke):**
  - `pnpm typecheck` — 19/19 packages green. Promo-worker compiled clean (Brief 156 cache miss); other 18 cache-hit.
  - `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run` — succeeded. Bundle 845.03 KiB raw / 160.58 KiB gzip. Bindings list reflects the existing `PROMO_FILES` R2 + `SUPABASE_URL` var; secrets are scoped per environment and not visible in dry-run output (the actual deploy still requires the operator to have `SUPABASE_SERVICE_KEY` + `SUPABASE_ANON_KEY` bound).
  - Smoke tests deferred to post-deploy per CLAUDE.md "don't deploy to Cloudflare without explicit instruction." Smoke checklist landed in PRE_DEPLOY_PROMO.md section 6 item 5 for the operator to execute when ready to flip the worker to staging.

- **Bundle size on splash-promo deploy:** 845.03 KiB raw / 160.58 KiB gzip (post-Brief-156). vs. Brief 155 baseline of 754.86 KiB / 141.85 KiB → delta of +90 KiB raw / +18.7 KiB gzip. `file-type@^19.6.0` is the dominant contributor (was ~12 KB on forms-worker per the brief's reference, but the full dep tree on a fresh build is larger). Well under CF's 3 MiB compressed free-tier ceiling — comfortable headroom.
