# PRE_DEPLOY_FORMS.md

Pre-deploy notes for `splash-forms` (Brief 89 onward). Mirrors the
shape of PRE_DEPLOY_FLEET.md.

## 1. Worker overview

`splash-forms` is the form-builder feature's runtime — owns public form
rendering (`/forms/{slug}`), public submission (`/forms/api/submit/{slug}`),
file uploads (`/forms/api/upload/{slug}`), lookup resolution
(`/forms/api/lookup/{slug}`), and the admin builder API
(`/forms/admin/api/*`). Path-carved on apps/web's hostname (planning
Decision 2). See Briefs 89–98 for the per-surface implementation
breakdown.

## 2. Bindings

(Filled in incrementally by subsequent briefs as bindings get added.
Brief 89 lands `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + Turnstile
keys + `FORMS_SUBMISSION_WEBHOOK_URL` + the `FORMS_FILES` R2 bucket.)

Brief 91 adds `SUPABASE_ANON_KEY` as a required secret for the
internal-audience submit path — `@splash/auth authenticate()` uses the
anon key on its `/auth/v1/user` round-trip. Bind via:

```
pnpm --filter @splash/forms-worker exec wrangler secret put SUPABASE_ANON_KEY
```

Same value already bound on splash-damage / splash-sysadmin /
splash-workorders. Without it, internal-audience form submits 401 with
`session_expired` (the structured JSON error `handleSubmit` returns when
authenticate() fails). Public + link-only audiences are unaffected.

## 3. Schema

5 Supabase tables added in Brief 89:
  - forms
  - form_versions
  - form_assets
  - form_submissions
  - form_submission_files

Operator runs `supabase/forms-tables.sql` in the Supabase SQL editor
before queueing Brief 90.

## 4. Cutover plan

The form-builder feature is built across Briefs 89–98. Pre-cutover state:
all bound on `staging.splashcarwashes.info/forms/*` only; `splash-forms`
worker on workers.dev for direct testing. Production routes commented in
`apps/forms-worker/wrangler.toml`.

Cutover steps (operator-driven, not Claude Code):

1. **Pre-flight checks.**
   - Schema migrations from Brief 89 already run on Supabase production
     (`supabase/forms-tables.sql`).
   - `splash-forms` worker deployed to production CF account.
   - All secrets bound: `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`,
     `TURNSTILE_SECRET_KEY`, `FORMS_SUBMISSION_WEBHOOK_URL` (optional but
     recommended).
   - Non-secret `[vars]` entries in `apps/forms-worker/wrangler.toml`:
     `SUPABASE_URL`, `TURNSTILE_SITE_KEY`.
   - R2 bucket `splash-forms-files` exists.
   - apps/web service binding `FORMS_WORKER` declared in
     `apps/web/wrangler.toml`.
   - `[observability.logs]` block on `splash-forms` (Brief 89 — covers
     scheduled invocations automatically).
   - `[triggers] crons = ["0 11 * * *"]` on `splash-forms` (Brief 97).
   - Rate limit rule from Section 7 (Brief 98 Phase 4) in place at the
     zone level.

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
   work. Splash Notes + status enum (`new` / `in_progress` / `closed`)
   for tracking.

## 5. Smoke tests

Run the per-brief checklists below in order — Brief 89 first, then 90,
then 91, etc. Each section's pre-reqs assume the prior briefs' smoke
tests have passed. The full sequence exercises every deliverable in the
form-builder feature end-to-end.

### Brief 90 — public render

1. Operator runs `supabase/forms-test-data.sql` once. (Idempotent on slug — re-running fails with unique-constraint violation; operator deletes the test rows first if re-running. See the file header for the DELETE statement.)
2. Visit `https://splash-forms.<account>.workers.dev/forms/test-public` (or staging equivalent `https://staging.splashcarwashes.info/forms/test-public`). Expect: rendered form with Splash navy header bar, white-script logo, name / email / phone / location / comments fields, Turnstile widget (when `TURNSTILE_SITE_KEY` is bound on the worker; widget absent otherwise — fail-soft).
3. Visit `/forms/test-internal` without an `sb-access-token` cookie. Expect: 302 redirect to `/login?next=/forms/test-internal`.
4. Visit `/forms/test-internal` with a valid `sb-access-token` cookie (operator can pull one from a logged-in apps/web tab via DevTools → Application → Cookies). Expect: rendered form with `site_number` text input, two lookup fields rendered DISABLED with placeholder text "Select Site number (3 digits) to populate", issue textarea.
5. Visit `/forms/test-link-only-x4kp9q2m7nf3` without auth or Turnstile. Expect: rendered form. No Turnstile widget (link-only audience).
6. Visit `/forms/nonexistent-slug` → 404 page ("Form not found").
7. Click Submit on any test form → POST to `/forms/api/submit/{slug}` returns 404 (Brief 91 wires it).
8. View source on the test-public page; confirm `<input type="hidden" name="pending_submission_id" value="...">` is present and contains a UUID.

### Brief 91 — public submit

1. Open `/forms/test-public` (Brief 90 test form). Fill in name / email / phone / location / comments. Solve the Turnstile (or skip if `TURNSTILE_SECRET_KEY` is unbound — submit will succeed fail-soft per CLAUDE.md fleet posture). Click Submit.
   Expected: server-rendered thank-you page renders with the form's `success_message` ("Thanks for testing!") and a "Fill out another" button. Click the button → returns to the blank form (relative URL — Brief 85 pattern; works on workers.dev / staging / production).
2. Verify the row landed:
   ```sql
   SELECT id, submitter_kind, submitter_user_id, submitter_email,
          submitter_ip, submitted_at, payload
     FROM form_submissions
    WHERE form_id = (SELECT id FROM forms WHERE slug = 'test-public')
    ORDER BY submitted_at DESC LIMIT 1;
   ```
   Expected: `submitter_kind = 'anonymous'`, `submitter_user_id IS NULL`, `submitter_email IS NULL`, `submitter_ip` populated, `payload` JSONB contains the four fields keyed by their `key` (`full_name`, `email`, `phone`, `site`, optionally `comments`).
3. Re-POST the same `pending_submission_id` (curl test):
   ```sh
   PEND=<uuid-from-step-1-DOM-or-DB>
   curl -i -X POST https://staging.splashcarwashes.info/forms/api/submit/test-public \
     -H "Origin: https://staging.splashcarwashes.info" \
     -F "pending_submission_id=$PEND" \
     -F "full_name=Same Person" -F "email=same@example.com" \
     -F "phone=5555555555" -F "site=oswego"
   ```
   Expected: 200 with the thank-you HTML (no duplicate row). Re-run the SELECT in step 2 — only one row exists for that pending_submission_id.
4. Open `/forms/test-internal` while logged in to apps/web as super_admin (cookie present). Fill in `site_number = 147`, type some text in the `issue` textarea, click Submit.
   Expected: thank-you page. Verify the row has `submitter_kind = 'authenticated'`, `submitter_user_id` matches your `auth.users.id`, `submitter_email` matches your login email.
5. Open `/forms/test-internal` in a fresh incognito window (no cookie). The render-time gate (Brief 90) should 302 to `/login?next=...` BEFORE you see the form. To test the submit-time path, curl direct:
   ```sh
   curl -i -X POST https://staging.splashcarwashes.info/forms/api/submit/test-internal \
     -H "Origin: https://staging.splashcarwashes.info" \
     -F "pending_submission_id=$(uuidgen)" \
     -F "site_number=147" -F "issue=test"
   ```
   Expected: 401 `{"error":"session_expired: log in again in a new tab and click Retry on the form"}`.
6. Open `/forms/test-link-only-x4kp9q2m7nf3` (no auth required, no Turnstile). Pick a satisfaction value, click Submit.
   Expected: thank-you page. Row inserted with `submitter_kind = 'anonymous'` (or `'authenticated'` if you happened to be logged in to apps/web in the same tab — link-only captures the session opportunistically).
7. Submit `/forms/test-public` with deliberately invalid email (curl, bypassing client validation):
   ```sh
   curl -i -X POST https://staging.splashcarwashes.info/forms/api/submit/test-public \
     -H "Origin: https://staging.splashcarwashes.info" \
     -F "pending_submission_id=$(uuidgen)" \
     -F "full_name=Test" -F "email=not-an-email" \
     -F "phone=5555555555" -F "site=oswego"
   ```
   Expected: 422 `{"error":"validation_failed","fields":{"email":"Invalid email address"}}`. (Turnstile will fail first if `TURNSTILE_SECRET_KEY` is bound and the curl omits `cf-turnstile-response` — to test validation only, temporarily flip the form's `turnstile_required` to false in Supabase.)
8. Cross-origin POST defense:
   ```sh
   curl -i -X POST https://staging.splashcarwashes.info/forms/api/submit/test-public \
     -H "Origin: https://evil.example.com" \
     -F "pending_submission_id=$(uuidgen)"
   ```
   Expected: 403 `{"error":"bad_origin"}`.

### Brief 92 — file + signature uploads

Pre-req: append a file field + signature field to the `test-public` form's
schema. Operator runs in Supabase SQL editor:

```sql
UPDATE form_versions
   SET schema = jsonb_set(
       schema,
       '{fields}',
       (schema->'fields') || jsonb_build_array(
         jsonb_build_object(
           'id', gen_random_uuid()::text,
           'type', 'file',
           'key', 'attachment',
           'label', 'Attach a photo or PDF',
           'required', false,
           'maxSizeMb', 5,
           'allowedMimeTypes', jsonb_build_array('image/*', 'application/pdf')
         ),
         jsonb_build_object(
           'id', gen_random_uuid()::text,
           'type', 'signature',
           'key', 'sig',
           'label', 'Sign here',
           'required', false,
           'format', 'png'
         )
       )
   )
 WHERE id = (SELECT current_version_id FROM forms WHERE slug = 'test-public');
```

1. Reload `/forms/test-public`. File input visible; signature canvas
   renders. Sign on the canvas — within ~1 sec a "Signature saved" status
   appears below it (debounced 800ms after the last stroke).
2. Choose a small JPEG with the file picker. "Uploaded {name} (XX KB)"
   status appears below the input.
3. Submit. Thank-you page renders. Verify both columns:
   ```sql
   SELECT payload FROM form_submissions
    WHERE form_id = (SELECT id FROM forms WHERE slug = 'test-public')
    ORDER BY submitted_at DESC LIMIT 1;
   SELECT field_key, r2_key, mime, size_bytes, original_filename
     FROM form_submission_files
    WHERE submission_id = (SELECT id FROM form_submissions
                            WHERE form_id = (SELECT id FROM forms WHERE slug = 'test-public')
                            ORDER BY submitted_at DESC LIMIT 1);
   ```
   Expected: `payload` carries `{r2_key, mime, size_bytes, original_filename}`
   under `attachment` and `{r2_key, format}` under `sig`. The
   `form_submission_files` SELECT returns one row per upload with the
   matching r2_key.
4. Open R2 dashboard for `splash-forms-files`. Confirm objects exist at
   `form-submission-files/{form_id}/{submission_id}/attachment/{filename}`
   and `form-submission-files/{form_id}/{submission_id}/sig/signature.png`.
5. MIME-spoof rejection — rename a Windows `.exe` to `.jpg` and choose it
   in the file picker:
   ```sh
   cp /path/to/anything.exe spoof.jpg
   # in the form, pick spoof.jpg
   ```
   Expected: inline status reads "mime_not_allowed: file type
   application/x-msdownload not permitted for this field" (or similar
   sniffed type). No upload to R2.
6. Size cap — generate a 30 MB file:
   ```sh
   dd if=/dev/zero of=big.jpg bs=1M count=30 2>/dev/null
   # the field config above sets maxSizeMb=5, so this hits the per-field cap first
   ```
   Expected: inline status reads "file_too_large: file exceeds 5 MB
   limit". (Hard 25 MB ceiling kicks in only when the per-field cap is
   above 25, which it can't be at this point — operator inspector
   clamping happens in Brief 95.)
7. Admin serve route — while logged in as super_admin in apps/web (so
   the `sb-access-token` cookie is set on `staging.splashcarwashes.info`):
   ```
   https://staging.splashcarwashes.info/forms/admin/api/files/form-submission-files/{form_id}/{submission_id}/attachment/{filename}
   ```
   Expected: image inlines / PDF downloads. Visit while logged out (or
   with cookie deleted) → 401.
8. Cross-origin upload defense — same shape as the submit handler's
   bad_origin test above; expect 403 on a wrong-Origin POST to
   `/forms/api/upload/test-public`.

### Brief 93 — lookup mechanism

Pre-req: `test-internal` (from Brief 90's `forms-test-data.sql`) already
has two lookup fields keyed off the `site_number` short-text input:
`location_name` (lookup `pricing_simple.location_pretty`,
`prefill_visible` mode) and `rd_email` (lookup `pricing_simple.am_email`,
`prefill_hidden` mode). Operator must be logged in to apps/web (so the
`sb-access-token` cookie reaches `staging.splashcarwashes.info`).

1. Open `/forms/test-internal`. Type a real site number — e.g. `147` —
   into Site number. Within ~250 ms (debounced) the visible "Location
   name" field populates with the matching `location_pretty` value;
   the hidden Regional Director email gets its value silently.
2. Open DevTools → Network. The change above should fire one POST per
   lookup field: `POST /forms/api/lookup/test-internal` with body
   `{"lookup_field_id":"<uuid>","key_value":"147"}` and a 200 response
   `{"value":"<resolved>","resolved_at":"..."}`.
3. Type a non-existent site like `999`. Both lookup fields show `(no
   match)` (display-only mode) or empty (visible / hidden) — no row
   in `pricing_simple` matches.
4. Click Submit. Verify `form_submissions.payload`:
   ```sql
   SELECT payload FROM form_submissions
    WHERE form_id = (SELECT id FROM forms WHERE slug = 'test-internal')
    ORDER BY submitted_at DESC LIMIT 1;
   ```
   Expected: `location_name` matches what `pricing_simple.location_pretty`
   shows for site `147`; `rd_email` matches `pricing_simple.am_email`
   for site `147` (filled in even though the input was hidden — server
   re-resolved it).
5. Drift defense — in DevTools Console, after the lookup populated, run
   `document.querySelector('[name="location_name"]').value = "Tampering"`
   and submit. Verify the inserted row's `payload.location_name` is
   still the canonical `pricing_simple.location_pretty` value (the
   server re-resolved and ignored the tampered client value). Worker
   logs (`wrangler tail`) show `[forms.lookup] drift detected at submit`.
6. block_submit test — flip Regional Director email's `nullBehavior` to
   `block_submit` in Supabase:
   ```sql
   UPDATE form_versions
      SET schema = jsonb_set(
            schema,
            '{fields}',
            (
              SELECT jsonb_agg(
                CASE WHEN f->>'key' = 'rd_email'
                     THEN f || jsonb_build_object('nullBehavior', 'block_submit', 'required', true)
                     ELSE f END
              )
                FROM jsonb_array_elements(schema->'fields') AS f
            )
          )
    WHERE id = (SELECT current_version_id FROM forms WHERE slug = 'test-internal');
   ```
   Submit with site number `999` (no match). Expected: 422
   `{"error":"lookup_failed","fields":{"rd_email":"Could not resolve ..."}}`.
   No row inserted.
7. Curl the lookup endpoint directly:
   ```sh
   curl -i -X POST https://staging.splashcarwashes.info/forms/api/lookup/test-internal \
     -H "Origin: https://staging.splashcarwashes.info" \
     -H "Content-Type: application/json" \
     --data '{"lookup_field_id":"<uuid-from-schema>","key_value":"147"}'
   ```
   Expected: 200 `{"value":"...","resolved_at":"..."}`. Cross-origin
   POST returns 403 `{"error":"bad_origin"}`. Empty `key_value` returns
   200 `{"value":null,"resolved_at":"..."}`. Unknown field id returns 400
   `{"error":"unknown_field: ..."}`.

### Brief 94 — admin API

Cookie-gated admin API at `/forms/admin/api/*`. Auth gate (in
`apps/forms-worker/src/admin/auth.ts`) allows when:

- `session.role === "super_admin"`, OR
- `session.dcRole === "admin"`, OR
- `session.dcRole === "super_admin"`.

Same posture as fleet (Brief 83). 503 returned uniformly when
`SUPABASE_SERVICE_KEY` is unbound; 401 when the cookie is missing /
invalid; 403 when authenticated but not in the allow-list.

Endpoint inventory:

- `GET    /forms/admin/api/forms` (list; query: `status`, `search`)
- `POST   /forms/admin/api/forms` (create; body: `{slug, title, description, audience}`)
- `GET    /forms/admin/api/forms/{id}` (detail incl. draft schema + version history)
- `PATCH  /forms/admin/api/forms/{id}/draft` (body: `{schema}`)
- `POST   /forms/admin/api/forms/{id}/publish`
- `POST   /forms/admin/api/forms/{id}/unpublish`
- `POST   /forms/admin/api/forms/{id}/republish`
- `POST   /forms/admin/api/forms/{id}/assets` (multipart; returns `{asset_id, r2_key, ...}`)
- `DELETE /forms/admin/api/forms/{id}/assets/{assetId}`
- `GET    /forms/admin/api/lookup-sources` (returns Brief 89's LOOKUP_SOURCES registry)

Smoke tests (curl, while logged in as super_admin — pull
`sb-access-token` from a logged-in apps/web tab):

1. `curl -H "Cookie: $COOKIE" "https://staging.splashcarwashes.info/forms/admin/api/forms?status=draft"` → 200, JSON `{items: [...]}`. Pre-Brief 90 test forms appear here too.
2. Create:
   ```sh
   curl -i -X POST "https://staging.splashcarwashes.info/forms/admin/api/forms" \
     -H "Cookie: $COOKIE" \
     -H "Origin: https://staging.splashcarwashes.info" \
     -H "Content-Type: application/json" \
     --data '{"slug":"smoke-94","title":"Brief 94 Smoke","audience":"public"}'
   ```
   Expected: 201, `{form_id, draft_version_id}`.
3. `curl -H "Cookie: $COOKIE" "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>"` → 200; verify `draftSchema = {fields:[]}`, `versions = [{versionNumber:1, isDraft:true, publishedAt:null, ...}]`, `currentVersionNumber = null`.
4. Save a draft schema:
   ```sh
   curl -i -X PATCH "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>/draft" \
     -H "Cookie: $COOKIE" \
     -H "Origin: https://staging.splashcarwashes.info" \
     -H "Content-Type: application/json" \
     --data '{"schema":{"fields":[{"id":"f1","type":"name","key":"full_name","label":"Name","required":true}]}}'
   ```
   Expected: 200, `{ok:true}`. Subsequent GET shows the field in `draftSchema.fields`.
5. Publish:
   ```sh
   curl -i -X POST "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>/publish" \
     -H "Cookie: $COOKIE" \
     -H "Origin: https://staging.splashcarwashes.info"
   ```
   Expected: 200, `{published_version_number:1, new_draft_id:<uuid>}`. Subsequent GET shows `currentVersionNumber:1`, `versions` contains both v1 (isDraft:false, publishedAt set) and a fresh v2 (isDraft:true).
6. Visit `/forms/smoke-94` → form renders with the Name field (Brief 90 path). Submit (Brief 91) → row inserted in `form_submissions`.
7. Unpublish:
   ```sh
   curl -i -X POST "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>/unpublish" \
     -H "Cookie: $COOKIE" \
     -H "Origin: https://staging.splashcarwashes.info"
   ```
   Expected: 200, `{ok:true,status:"archived"}`. Visit `/forms/smoke-94` → 404.
8. Republish (from archived):
   ```sh
   curl -i -X POST "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>/republish" \
     -H "Cookie: $COOKIE" \
     -H "Origin: https://staging.splashcarwashes.info"
   ```
   Expected: 200, `{ok:true,status:"published"}`. Visit `/forms/smoke-94` → renders again.
9. Auth gating:
   - Same calls with NO `Cookie` header → 401 `{"error":"unauthenticated"}`.
   - Same calls with a non-admin cookie (e.g., a location_admin or gm) → 403 `{"error":"forbidden",...}`.
   - Same calls when `SUPABASE_SERVICE_KEY` is unbound → 503 `{"error":"service_key_unbound"}`.
10. Slug validation:
    - Duplicate slug on create → 409 `{"error":"slug_taken"}`.
    - Bad slug (uppercase, special chars, leading hyphen, <3 chars) → 400 `{"error":"invalid_slug:..."}`.
    - Missing audience → 400 `{"error":"audience_required:..."}`.
11. Schema validation on PATCH /draft — POST a malformed schema (e.g., missing `type` on a field) → 422 `{"error":"schema_invalid","issues":[...]}`. The Zod boundary rejects bodies the public renderer would reject too.
12. CSRF:
    - POST/PATCH/DELETE without an `Origin` header → 403 `{"error":"bad_origin"}` (defense-in-depth over SameSite=Lax cookies).
13. Asset upload:
    ```sh
    curl -i -X POST "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>/assets" \
      -H "Cookie: $COOKIE" \
      -H "Origin: https://staging.splashcarwashes.info" \
      -F file=@./test.png \
      -F alt_text="Test image"
    ```
    Expected: 200, `{asset_id, r2_key, mime:"image/png", size_bytes, alt_text:"Test image"}`. Followed by:
    - Upload of a 12 MB file → 413 `{"error":"file_too_large:..."}`.
    - Upload of a non-image (PDF, SVG) → 415 `{"error":"mime_not_allowed:..."}`.
    - Upload to a foreign form_id → still uploads (no cross-form gate on POST), but DELETE rejects on form_mismatch.
14. Asset delete:
    ```sh
    curl -i -X DELETE "https://staging.splashcarwashes.info/forms/admin/api/forms/<form_id>/assets/<asset_id>" \
      -H "Cookie: $COOKIE" \
      -H "Origin: https://staging.splashcarwashes.info"
    ```
    Expected: 200, `{ok:true}`. Verify the row is gone in `form_assets`; verify the R2 object is also gone (or scheduled for the cron sweep if R2 delete failed — check worker logs for the cron-fallback message).
15. Lookup sources:
    `curl -H "Cookie: $COOKIE" "https://staging.splashcarwashes.info/forms/admin/api/lookup-sources"` → 200, JSON `{sources: [...11 entries...]}`. Cache header is `private, max-age=300` (browser caches but admin builder UI in Brief 95 still picks up changes within 5 minutes).

### Brief 95 — admin builder UI

apps/web pages live at `/admin/forms` (list), `/admin/forms/new`
(create), and `/admin/forms/[id]` (3-column builder: palette, canvas,
inspector). Auth gate: `session.role === "super_admin"` OR
`session.dcRole === "admin"|"super_admin"` — same posture as fleet
admin (Brief 83). The builder client island uses `dnd-kit/core` +
`dnd-kit/sortable` for drag-to-reorder and `nanoid(8)` for field IDs
+ key suffixes. Save Draft + Publish are server actions that wrap the
worker-fetch SSR helpers (BuilderClient is a client component and
can't import `next/headers` directly).

Smoke tests (signed in as super_admin):

1. Visit `/admin/forms`. Expect: list page renders; FormsAdminTabs row
   with the "All Forms" pill active; "+ Create form" link visible;
   forms from Briefs 90/94 smoke-tests appear in the table.
2. Filter: pick `?status=draft` from the dropdown → only drafts shown.
   Type a substring in Search → results narrow to title/slug matches.
3. Click "+ Create form" → `/admin/forms/new`. Fill slug
   "smoke-builder", title "Builder Smoke Test", audience "internal".
   Submit → redirects to `/admin/forms/<id>`.
4. Builder page loads with empty canvas (placeholder text), palette on
   the left (16 entries), and FormMetaInspector on the right (no field
   selected).
5. Click `Short text` in the palette → canvas gets a Short text card,
   ShortTextInspector opens on the right with editable label/key/etc.
   Repeat with Email and Lookup; verify Lookup inspector shows the
   Source table dropdown and the Source column dropdown narrows when
   you flip tables.
6. Drag the Lookup card above the Email card via the `⋮⋮` handle on
   the right → order updates and the "Unsaved changes" pill appears.
7. Keyboard reorder: tab to a card's drag handle, press Space to lift,
   arrow up/down to move, press Space again to drop. Verify dnd-kit
   accessibility wiring works.
8. Click "Save Draft" → button flips to "Saving…" then "Saved ✓"; the
   "Unsaved changes" pill disappears.
9. Reload the page → fields persist (proves PATCH landed in
   `form_versions.schema`).
10. Type an invalid character (e.g. uppercase, hyphen, leading digit)
    in a field's Key inspector input → KeyEditor strips it from the
    sanitized value; if the resulting key is invalid (empty / wrong
    first char) the input border turns red and the message
    `Invalid key — must match /^[a-z][a-z0-9_]*$/` shows.
11. Click "Publish" → confirm dialog if dirty, then alert "Published
    as version 1." then page reloads. TopBar status pill flips to
    "Published v1".
12. Visit `/forms/smoke-builder` (signed in — internal audience) →
    public renderer (Brief 90) shows the three fields.
13. Add another field, click Publish → alert says version 2; the
    public renderer reflects v2 immediately (no edge cache to bust).
14. Lookup wiring (Brief 93 end-to-end):
    - Add a Location field (key `location`).
    - Add a Lookup field; in inspector pick Key field = the location,
      Source table = `pricing_simple`, Source column = `address`,
      Resolution mode = "Visible".
    - Save Draft + Publish.
    - On `/forms/smoke-builder`, picking a location populates the
      Lookup input with the resolved address.
15. Asset upload (Image field):
    - Add an Image field, click "Choose file", upload a small PNG.
    - Inspector shows the asset_id; canvas renderer shows asset
      reference in a placeholder card.
    - Save Draft → reload → asset_id persists.
16. Beforeunload warning: edit a field, then try to close the tab →
    browser prompts for confirmation. Save Draft, try again → no
    warning.
17. As a non-admin (e.g., location_admin), visit `/admin/forms` →
    NoAccessCard renders ("Access denied"); the worker also returns
    403 on direct `/forms/admin/api/forms` calls (defense in depth).
18. As an unauthenticated user, visit `/admin/forms` → NoAccessCard
    "Sign in required" with the `/login?return=/admin/forms` link.

Bundle size: `/admin/forms/[id]` First-Load JS clocked at 131 kB on
the first build (route-specific chunk 25.8 kB) — comfortably under
the 150 kB target flagged in the brief Report.

Latent issue (form-meta persistence): the FormMetaInspector renders
editable inputs for title/description/audience/notify_webhook/etc.,
but Save Draft only persists `schema.fields` to the worker. Form-level
metadata edits stay client-side until a future brief widens the
admin PATCH endpoint or adds a sibling endpoint. The TopBar title
input has the same caveat. Dashboard tile + global error boundary
land in Brief 98.

### Brief 96 — submissions admin UI + version history

Brief 96 wires three new pages plus five worker endpoints. No new env vars,
no new bindings — the existing `SUPABASE_SERVICE_KEY` covers everything.

**Worker endpoints** (under the existing `/forms/admin/api/*` prefix; same
auth gate as Brief 94):

```
GET   /forms/admin/api/forms/{id}/submissions
GET   /forms/admin/api/forms/{id}/submissions.csv
GET   /forms/admin/api/forms/{id}/submissions/{subId}
PATCH /forms/admin/api/forms/{id}/submissions/{subId}
GET   /forms/admin/api/forms/{id}/versions
```

CSV is **schema-union across all versions in the date range** — header row
is the union of every field key ever used (`heading` and `image` field
types skipped since they have no payload), and each row has empty cells
where a key doesn't exist on that submission's version. Rows capped at
10000; 416 on overflow with a "narrow the date range" body. Same-origin
URL works because forms is path-carved (Brief 89 / Decision 2) — no
Brief 88-style proxy route is needed.

**apps/web pages**:

```
/admin/forms/[id]/submissions             — list (DateRangePicker + status + submitter-kind filter + CSV)
/admin/forms/[id]/submissions/[subId]     — detail (ActionForm: status + splash_notes; payload + metadata)
/admin/forms/[id]/versions                — audit-trail table (no diff renderer at v1)
```

Detail page renders the payload against THE SUBMISSION'S version's schema
(NOT the form's current schema — past submissions render under their own
version per Decision 1's versioning posture). Lookup payload entries get
a `(resolved from <key field label>)` annotation. File payload entries
render image MIME inline as thumbnails; non-image MIME render as styled
download links via `/forms/admin/api/files/{r2_key}` (the Brief 92
serve route). Signature entries render the saved PNG inline (or a
"Download signature" link for non-image formats). Any payload key not
present in the version's schema renders in an "Other payload entries"
appendix — defense against schema drift / hand-edited JSONB.

**Smoke tests** (operator runs after Brief 95 smoke-builder form is
published):

1. Submit 2–3 entries on the smoke-builder form via `/forms/{slug}`.
2. Visit `/admin/forms/{id}/submissions`. Expect: list with
   DateRangePicker (default last 30 days), Status + Submitter dropdowns,
   "Export CSV" button at the right, table with the submitted rows
   sorted newest-first.
3. Apply each filter in turn (Status: New; Submitter: Authenticated;
   shrink the date range). Verify the table updates on Filter click.
4. Click a row → detail page. Expect: status pill in the header,
   ActionForm with Status dropdown + Splash Notes textarea + Save
   button, Form payload section rendering each non-display field's
   value, Metadata section with submission ID / submitted at /
   submitter kind / IP / version / audit columns.
5. Type notes, change Status to "In progress", click Save. Expect:
   "Saved." banner, status pill above flips to "In progress" after
   `router.refresh()`. Reload the page — values persist. Set Status
   to "Closed", reload — still persists.
6. CSV: click "Export CSV" on the list page. Browser downloads
   `form-{id}-submissions-{from}-to-{to}.csv`. Open it: header row
   has `submission_id, submitted_at, status, submitter_kind,
   submitter_email, version_number, splash_notes, <field keys
   sorted ascending>`. Rows have one entry per submission with
   payload values in the matching columns (empty cells where a
   key doesn't apply).
7. Multi-version CSV check (proves schema-union):
   - Add a new field to the smoke-builder, save draft, publish v2.
   - Submit a new entry under v2.
   - Re-export the CSV. Expect: header row now contains BOTH the
     old fields AND the new field's key; v1 rows have empty cells
     for the new field; v2 row has cells for every field.
8. Visit `/admin/forms/{id}/versions`. Expect: table with one row
   per version (newest first), status pill (Draft / Published),
   Published at + Published by, field count, submission count.
9. As an unauthenticated user, visit
   `/admin/forms/{id}/submissions` → NoAccessCard "Sign in
   required". As a non-admin (e.g., location_admin), visit it →
   NoAccessCard "Access denied".
10. CSRF defense: `curl -X PATCH https://staging.splashcarwashes.info/forms/admin/api/forms/{id}/submissions/{subId} -d '{"splash_notes":"x"}' -H 'Content-Type: application/json'`
    (no Origin / Referer) → 403 `bad_origin`.
11. Sub-id / form-id mismatch: PATCH to a `subId` that exists but
    belongs to another form → 404 `not_found` (the WHERE clause is
    scoped to both `id` AND `form_id`).

### Brief 97 — webhook + cron

Brief 97 wires two surfaces:

- **Submission webhook**: `FORMS_SUBMISSION_WEBHOOK_URL` (worker secret,
  optional, fail-soft when unbound). Fired via `ctx.waitUntil` after
  `form_submissions` insert succeeds — does NOT block the success page
  response. Per-form opt-out via `forms.notify_webhook = false`.
  Files-by-URL in payload (planning Decision 6 — NOT base64): each file
  / signature entry carries a `download_url` pointing at
  `/forms/admin/api/files/{r2_key}` (Brief 92 admin-gated serve route).
  PA fetches the URL when needed. 15s `AbortController` timeout. Skipped
  on idempotent re-submits — only `inserted.wasNew === true` fires.
- **Daily R2 cleanup cron**: `[triggers] crons = ["0 11 * * *"]` in
  `apps/forms-worker/wrangler.toml`. Two passes: orphan submission files
  (`form-submission-files/{form_id}/{pending_submission_id}/...` paths
  >24h with no matching `form_submissions.id` row) and orphan form
  assets (`form-assets/...` paths >1h with no matching
  `form_assets.r2_key` row). Hard pagination caps (50 pages × 1000 =
  50K submission files; 20 pages × 1000 = 20K assets per run) prevent
  runaway. Logs `[forms.cleanup] complete` with counts on every run.

1. Bind the webhook secret (production-recommended; dev OK to skip):
   ```
   pnpm --filter @splash/forms-worker exec wrangler secret put FORMS_SUBMISSION_WEBHOOK_URL
   ```
2. Submit a public form. Verify the Power Automate flow receives JSON
   with the expected shape:
   ```json
   {
     "form": {"id":"...","slug":"test-public","title":"...","version_number":N},
     "submission": {"id":"...","submitted_at":"...","submitter_kind":"anonymous","submitter_email":null,"submitter_user_id":null,"submitter_ip":"1.2.3.4","splash_admin_url":"https://splashcarwashes.info/admin/forms/{form_id}/submissions/{sub_id}"},
     "payload": {...},
     "files": [{"field_key":"attachment","r2_key":"...","mime":"image/jpeg","size_bytes":12345,"download_url":"https://staging.splashcarwashes.info/forms/admin/api/files/..."}]
   }
   ```
3. Per-form opt-out: PATCH `notify_webhook = false` on the test form via
   the Brief 94 admin endpoint or direct SQL. Submit again. Verify PA
   does NOT receive the payload.
4. File-bearing webhook: submit a `test-public` entry with the file +
   signature fields from Brief 92's smoke setup. Verify the webhook
   `files` array contains both entries with their `download_url` strings.
   Click the URL from PA (signed in as super_admin) — file inlines /
   downloads via the Brief 92 serve route.
5. Idempotent re-submit: re-POST the same `pending_submission_id` (the
   curl pattern from Brief 91 smoke #3). Verify the SECOND POST does
   NOT trigger a webhook fire (look for the absence of a second
   `[forms.webhook]`-prefixed line in `wrangler tail`).
6. Trigger the cron manually: in CF dashboard → Workers & Pages →
   splash-forms → Triggers → Cron Triggers → `0 11 * * *` → Trigger.
   Watch `wrangler tail` (or CF Workers Logs) for `[forms.cleanup]
   complete` with the four count fields and `errorCount: 0`.
7. Pre-create an orphan: hit `POST /forms/api/upload/test-public` with
   a fake `pending_submission_id` (a fresh UUID that never gets
   submitted). DO NOT submit. Wait until the next 11:00 UTC cron run
   (or temporarily lower `ORPHAN_TTL_HOURS` in
   `apps/forms-worker/src/cron/cleanup.ts` for testing). Trigger the
   cron. Verify the R2 object is deleted from
   `splash-forms-files/form-submission-files/{form_id}/{pending_uuid}/...`.
8. Pre-create an orphan asset: upload an asset via `POST
   /forms/admin/api/forms/{id}/assets` (Brief 94), then manually
   `DELETE FROM form_assets WHERE id = '...'` in Supabase WITHOUT
   deleting the R2 object (simulates Brief 94's DELETE-handler R2
   delete failing). Wait >1h, trigger cron, verify the R2 object is
   deleted.
9. Workers Logs: in CF dashboard, scheduled invocations show with
   `eventType: scheduled` (the Brief 89 `[observability.logs]` block
   covers them automatically per CLAUDE.md / Brief 63).
10. Webhook failure path: temporarily set `FORMS_SUBMISSION_WEBHOOK_URL`
    to a dead URL (e.g., `https://httpstat.us/500`). Submit a form.
    Verify: the user STILL sees the success page (fail-soft); the
    `wrangler tail` logs include `[forms.webhook] non-2xx response: 500`
    or `[forms.webhook] fire failed (fail-soft)`.

### Brief 98 — polish (dashboard tile, error boundary, rate limit)

1. Visit `/admin/dashboard` while logged in as super_admin. Expect: a
   "Forms" tile (clipboard-list icon, "Builder" eyebrow,
   "Build and manage admin-built forms." description) appears in the
   tile grid alongside the existing seven. Click the tile → lands on
   `/admin/forms` (the Brief 95 list page).
2. Visit `/admin/forms` with no `sb-access-token` cookie (incognito).
   Expect: middleware (Brief 1, extended in Brief 98) gates the route
   and redirects to `/login?return=/admin/forms`. The `/admin/{slug}`
   legacy redirect (Brief 2) does NOT intercept (`forms` is in
   `ADMIN_KNOWN_SUBPATHS`).
3. Force a render error to confirm the segment-level error boundary
   fires. Easiest method: temporarily edit `apps/web/app/admin/forms/page.tsx`
   to throw at the top of the page component, run `next dev` (or push
   to staging). Visit `/admin/forms` → expect: "Couldn't load form
   builder" heading, "Try again" button (calls `reset()` —
   re-renders the segment without a hard reload), error digest in
   small font. Revert the throw after testing.
4. Force a stale-server-action error: open `/admin/forms/[id]` in one
   tab, redeploy `splash-web` with a real source change to the builder
   actions, then click Save Draft in the original tab. Expect: the
   forms-specific boundary catches the `UnrecognizedActionError`
   throw and renders "App was updated / Reload" copy. Click Reload →
   page hard-reloads and works again.
5. CF rate-limit verification (production only — staging shares the
   zone but the rule is scoped to `/forms/api/submit/*` regardless of
   subdomain). After Section 7's rule is in place, run a small loop
   from a single source IP that POSTs 6 times in 5 minutes to
   `/forms/api/submit/test-link-only-x4kp9q2m7nf3`. Expect: requests
   1–5 land normally (200 thank-you); request 6 returns 429 (CF's
   default block response). Wait 10 minutes for the action duration
   to expire; the next POST succeeds again.

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
- **Form-meta persistence in builder.** Brief 95's FormMetaInspector
  renders editable inputs for title/description/audience/notify_webhook
  but Save Draft only persists `schema.fields`. Form-level metadata
  edits stay client-side until a future brief widens the
  PATCH /draft endpoint or adds a sibling endpoint.

## 7. Production rate limit on `POST /forms/api/submit/*`

Link-only forms have no Turnstile and no auth gate — slug acts as the
gate. To prevent abuse if a slug leaks publicly, configure a CF Rate
Limiting Rule. The rule lives at the zone level, NOT in worker code —
editing it doesn't require a code deploy.

1. CF Dashboard → splashcarwashes.info → Security → WAF → Rate limiting
   rules → Create rule.
2. Rule name: `splash-forms-submit-rate-limit`.
3. If incoming requests match: `URI Path contains "/forms/api/submit/"`
   AND `Request Method equals POST`.
4. Then: Block.
5. With characteristics: IP source.
6. Period: 5 minutes. Requests: 5.
7. Action duration: 10 minutes.

Public-audience forms are also covered (Turnstile is the primary
defense; rate limit is defense in depth). Internal forms are also
covered (operators submitting at >1/minute is unusual; if it becomes a
real workflow, the rule can be relaxed).
