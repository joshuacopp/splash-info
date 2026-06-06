# PRE_DEPLOY_PROMO.md

Pre-deploy notes for `splash-promo` (Brief 153 onward). Mirrors the
shape of PRE_DEPLOY_FORMS.md.

## 1. Worker overview

`splash-promo` is the promotions feature's runtime — internal-tooling
JSON API at `/promo/api/*` (read/write) and `/promo/admin/api/*`
(admin-scoped reads, future briefs). No public-customer surface today.
Path-carved on apps/web's hostname (same reasoning as forms-worker /
Brief 89: cookie + download simplicity). See Briefs 153+ for the
per-surface implementation breakdown.

At Brief 157 the live routes are `GET /promo/api/ping` (smoke),
`GET /promo/api/promos` (list with filters + counts),
`POST /promo/api/promos` (create promo + ticket + locations + log,
super_admin / it / marketing only),
`GET /promo/api/promos/{id}` (deep detail tree — now includes
`announcements[]` capped at 20 most-recent; `internal_note` stripped
at the seam for non-IT callers), the five Brief 155 write surfaces
under `/promo/api/promos/{id}/...` (ticket / status / assignees /
location progress), the four Brief 156 surfaces:
`POST /promo/api/promos/{id}/materials` (multipart upload — 50 MB
hard cap, 20-per-promo soft cap, MIME-sniff via `file-type` with
deny-list, R2 path `promo-materials/{promoId}/{materialId}.{ext}`),
`DELETE /promo/api/promos/{id}/materials/{materialId}`,
`GET /promo/api/promos/{id}/materials/{materialId}/file` (any
non-null `promoRole`; inline for images, attachment otherwise),
`PUT /promo/api/promos/{id}/ptp` (upsert — three required text
fields, max 10 000 chars each), and the new Brief 157 surface:
`POST /promo/api/promos/{id}/announce` (super_admin / it / marketing
— snapshot a `promo_announcements` row + fan out one
`outbound_emails` row per recipient via Brief 127's shared queue;
materials selected at compose time ride along as `bucket:
"PROMO_FILES"` attachments). apps/web pages and the live-view
"Compose announcement" affordance land in Brief 158.

## 2. Bindings

(Filled in incrementally by subsequent briefs as bindings get added.
Brief 153 lands `SUPABASE_URL` (non-secret var) + `SUPABASE_SERVICE_KEY`
+ `SUPABASE_ANON_KEY` (both secrets) + the `PROMO_FILES` R2 binding.)

Required secrets (bind via `pnpm --filter @splash/promo-worker exec
wrangler secret put NAME`, NOT the dashboard UI — CLAUDE.md
constraint #4):

- `SUPABASE_SERVICE_KEY` — for `promotions` / `promo_*` writes and
  reads (service key, NOT the legacy `_SERVICE_ROLE_KEY` name; see
  CLAUDE.md constraint #3). Same value already bound on every other
  monorepo worker that holds it.
- `SUPABASE_ANON_KEY` — for `@splash/auth authenticate()` on the
  `/auth/v1/user` cookie-validation round-trip. Required from day one
  because every promo endpoint is cookie-gated (no public surface).

No webhook secrets specific to promo-worker — Brief 157's announcement
send uses Brief 127's shared `outbound_emails` queue table (PA flow on
splash-forms drains every monorepo email). Internal note notifications
and any other per-event webhooks are deferred to their own briefs.

**Cross-worker dependency (Brief 157):** forms-worker is the queue
drain — its `/forms/internal/api/email-queue/claim` endpoint inlines
R2-backed attachments at PA poll time and dispatches on
`attachment.bucket` to pick the right R2 binding. Promo announcement
materials ride along with `bucket: "PROMO_FILES"`, so forms-worker
needs the `splash-promo-files` bucket bound as `PROMO_FILES` on its
own wrangler config to inline them. Before the first promo
announcement with attachments goes out, the operator must add this
block to `apps/forms-worker/wrangler.toml`:

```toml
[[r2_buckets]]
binding     = "PROMO_FILES"
bucket_name = "splash-promo-files"
```

…and redeploy `splash-forms`. The forms-worker code (Brief 157)
already dispatches on `bucket` and tolerates an unbound `PROMO_FILES`
by skipping the attachment with a log line — the email still sends
without it, just without the attached materials. Adding the binding
makes attachments arrive cleanly.

## 3. Schema

9 Supabase tables added by `supabase/promo-tables.sql` (operator already
applied):

- promotions
- promo_locations
- promo_tickets
- promo_ticket_assignees
- promo_materials
- promo_ptp
- promo_announcements
- promo_activity_log
- promo_user_roles

Plus a `auth_unified` view extension surfacing `promo_role` (operator
already applied via the template at the bottom of the SQL file).

## 4. R2 bucket

`splash-promo-files` (Public Access Disabled, Standard storage) — operator
already created. Bound as `PROMO_FILES` in `apps/promo-worker/wrangler.toml`.

Brief 153 namespace: `promo-materials/{promo_id}/{material_id}.{ext}`.
Single-bucket, single-prefix today; future briefs can add sibling
prefixes (e.g. `promo-announcement-attachments/`) without spawning a
second bucket.

## 5. Cutover plan

Pre-cutover state at Brief 153: workers.dev only; `splash-promo` for
direct testing. Staging route bound on
`staging.splashcarwashes.info/promo/*` (path-carved). Production routes
commented in `apps/promo-worker/wrangler.toml`.

No production cutover happens at Brief 153 — there's no user-visible
surface yet. Subsequent briefs will populate `/promo/api/*` and
eventually wire `/admin/promotions/*` on apps/web; production routes
flip operator-driven, same posture as the rest of the monorepo.

## 6. Smoke tests

Run in order after `wrangler deploy` to workers.dev:

1. `GET https://splash-promo.<account>.workers.dev/promo/api/ping`
   returns 200 JSON. All four binding flags
   (`supabase_url_set`, `supabase_service_key_set`,
   `supabase_anon_key_set`, `promo_files_bound`) MUST be `true`. If any
   reports `false`, the corresponding `wrangler secret put` step (or
   the `[vars]` / `[[r2_buckets]]` block in `wrangler.toml`) was
   skipped.
2. `GET https://splash-promo.<account>.workers.dev/promo/api/anything-else`
   returns 404 with body
   `{"error":"Promo worker scaffolding only; see Brief 154+ for endpoints."}`.
3. `GET https://staging.splashcarwashes.info/promo/api/ping` returns
   the same JSON shape as (1) — confirms the staging route binding
   picked up via CF's most-specific-match-wins routing.
4. (post-Brief-154) `GET https://splash-promo.<account>.workers.dev/promo/api/promos`
   with a valid session cookie (caller has any non-null `promo_role`)
   returns `{"promos": [], "total": 0, "limit": 100, "offset": 0}` for
   an empty DB. Calls without a session cookie return 401 `unauthorized`;
   calls from a user with `promo_role = NULL` return 403 `forbidden`.
5. (post-Brief-156) Seed one promo via the Brief 154 create endpoint;
   copy the returned promo id. Then exercise the materials lifecycle:
   - `curl -X POST -H "Cookie: <session>" -F "name=Test image"
     -F "kind=image" -F "file=@small.jpg"
     https://splash-promo.<account>.workers.dev/promo/api/promos/{id}/materials`
     → 201 JSON with `material.r2Key` matching
     `promo-materials/{id}/{materialId}.jpg`. Check the CF dashboard
     `splash-promo-files` bucket — the object should be present.
   - `curl -L -H "Cookie: <session>"
     https://splash-promo.<account>.workers.dev/promo/api/promos/{id}/materials/{materialId}/file`
     → JPEG bytes back with `Content-Type: image/jpeg` and
     `Content-Disposition: inline; filename="Test image"`.
   - `curl -X DELETE -H "Cookie: <session>"
     https://splash-promo.<account>.workers.dev/promo/api/promos/{id}/materials/{materialId}`
     → 200 `{ok: true, removed: true}`. R2 object gone, DB row gone,
     `promo_activity_log` shows `material_removed`.
   - Upload a `.html` file → 415 `unsupported_mime`.
   - Upload a > 50 MB file → 413 `file_too_large`.
   - Upload as a user whose `promo_role = 'ops'` → 403 `forbidden`.
   - `PUT /promo/api/promos/{id}/ptp` with
     `{"purpose":"...", "tools":"...", "process":"..."}` → 200 + row in
     `promo_ptp`. Re-PUT with one field changed → 200 +
     `promo_activity_log` shows `ptp_updated` with
     `details.fields = ["purpose"]`. Re-PUT with no changes → 200 +
     no new activity row.
6. (post-Brief-157, requires the materials seed from step 5):
   - `curl -X POST -H "Cookie: <session>" -H "Content-Type:
     application/json" -d '{"subject":"Test", "bodyText":"Hi team",
     "recipientEmails":["a@example.com","b@example.com"],
     "selectedMaterialIds":["{materialId}"], "includePtp": true}'
     https://splash-promo.<account>.workers.dev/promo/api/promos/{id}/announce`
     → 201 with `{ok: true, announcementId, enqueuedCount: 2,
     failedRecipients: [], sentAt}`. Supabase: 1 new row in
     `promo_announcements`, 2 new rows in `outbound_emails` with
     `source_kind='promo-announcement'` and matching `source_id =
     announcementId`. The activity log carries a `announcement_sent`
     entry.
   - Re-POST the same body → 201 still, but the 2 `outbound_emails`
     rows are unchanged (Brief 127's `ignore-duplicates` dedup on
     `(source_worker, source_kind, source_id, recipient)`). Count is
     still 2.
   - POST a DIFFERENT announcement (new subject) → 2 new
     `outbound_emails` rows (different `source_id` = new
     announcement id).
   - POST with `recipientEmails:["name.@gmail.com"]` (trailing dot per
     Brief 152) → 400 `invalid_recipients` with `invalid:
     ["name.@gmail.com"]`.
   - POST with a `selectedMaterialIds` UUID that belongs to a DIFFERENT
     promo → 400 `material_not_on_promo` with `missing: [...]`.
   - `GET /promo/api/promos/{id}` → response includes the announcement
     in `announcements[]`.
   - Open `/admin/email-queue` (Brief 128) → see the new rows with
     `source_kind='promo-announcement'`. The PA "Email Queue Drain"
     flow picks them up on the next poll; if the forms-worker
     `PROMO_FILES` binding is in place, attachments arrive base64-
     inlined; if not, the email sends without attachments and the
     forms-worker logs `[forms.email-queue] attachment ... references
     unsupported or unbound bucket PROMO_FILES; skipping`.

7. (post-Brief-158a, apps/web read pages — requires the seeded promo
   from steps 4–6 above) After deploying `splash-web` with the
   PROMO_WORKER service binding live (Brief 153 already adds it to
   `apps/web/wrangler.toml`):
   - Visit `/admin/dashboard/operations` as a `super_admin` →
     "Promotions" AND "IT Promotions Queue" tiles both render under
     the Operations group.
   - Visit `/admin/dashboard/operations` as a `marketing` user (any
     non-null `promoRole` except `it`) → ONLY the "Promotions" tile
     renders. Queue tile hidden.
   - Visit `/admin/dashboard/operations` as a user with
     `promoRole = null` → neither tile renders. If the Operations
     group has zero other visible tiles, the group itself drops out
     (Brief 117 behavior).
   - Visit `/admin/promotions` as a `marketing` user → list page
     renders. Card grid shows every promo the worker returns; filter
     bar (status / priority / search / assigned-to-me) updates the
     URL on Apply and the grid re-renders. "+ New promotion" button
     visible (links to `/admin/promotions/new` which 404s until 158b).
   - Click a promo card → live view (`/admin/promotions/{id}`)
     renders with status pill, priority pill, status pipeline,
     details grid, location progress, materials grid, PTP card,
     announcement history, and activity timeline. The "Open IT
     ticket →" link is visible to super_admin / it only.
   - As an `it` user, visit `/admin/promotions/queue` → table view
     of promos sorted priority desc → go-live asc. "Assigned to me"
     checkbox is pre-checked. Toggle it off → see the broader IT
     queue.
   - As a `marketing` user, visit `/admin/promotions/queue` → see
     the `NoAccessCard` "IT only" state.
   - Visit `/admin/promotions/{id}/ticket` as `it` → IT ticket page
     renders with "Submitted request" + "IT response" cards.
     `internal_note` renders in the amber-tinted "IT only" callout
     when set; "(no internal note set)" placeholder otherwise.
   - Visit `/admin/promotions/{id}/ticket` as `marketing` → see the
     `NoAccessCard` "IT only" state. Confirm the worker also strips
     `internalNote` from `GET /promo/api/promos/{id}` for marketing
     callers — defense in depth.
   - Visit a malformed promo id like `/admin/promotions/not-a-uuid`
     → `notFound()` (Next 404 page). Same for a valid-shape UUID
     that doesn't exist in `promotions`.
   - Hit a legacy bookmark-shaped URL `/admin/promotions` (no
     trailing slug) — confirm the middleware does NOT rewrite to
     `/admin/pricing/promotions` (i.e., `"promotions"` is in
     `ADMIN_KNOWN_SUBPATHS`).

8. (post-Brief-158b, apps/web write affordances — runs end-to-end
   against the seeded promo from steps 4–7 above)
   - As a `super_admin`, visit `/admin/promotions/new` → multi-
     select location picker loads with rows ordered by
     `location_pretty`. Pick 2–3 locations, fill title + start/end
     dates + go-live date + priority + promoType=`BOGO` (which
     un-disables the POS-behavior textarea — required), submit.
     `router.replace` lands on `/admin/promotions/{newId}` and the
     activity timeline shows `created`. Try submitting with
     `promoType=Same` and a POS-behavior value populated — confirm
     the textarea is disabled in the UI, so the operator can't
     populate it (defense in depth — the worker accepts the field
     for `Same` since it's optional there).
   - On the live view's status pipeline card, pick `Building` from
     the StatusEditor dropdown → Save. Status pill + pipeline
     re-render. Pick the same value again → "Status unchanged"
     banner; no new activity row.
   - On the IT ticket page, type a date into Ready-by, type some
     roadblocks text, leave internal note empty, hit Save → success
     banner. The activity log shows a single `ticket_updated` row
     with `details.fields` listing the two changed fields. Re-save
     with no changes → "No changes to save." (action no-ops; no
     activity row).
   - Type your own email into the assignees autocomplete; pick
     yourself; click Add → success banner echoes "Added — status
     auto-advanced to Scoped." (Brief 155 auto-flip fires because
     `readyByDate` is set AND assignee count became 1). The pipeline
     card re-renders to Scoped on the next `router.refresh()`.
   - Toggle one of the per-location checkboxes → checkbox flips
     instantly (useOptimistic); activity log shows
     `location_marked_complete`. Toggle it back → the inverse.
   - Back on the live view, click "+ Add material" → modal opens.
     Upload a small JPEG (≤50 MB) → success; chip appears in the
     materials grid with inline thumbnail; activity log shows
     `material_added`. Click the chip's Delete button → confirm →
     chip disappears; activity log shows `material_removed`.
   - Click "+ Build PTP" → modal opens with three textareas. Fill
     all three, save → success; PTP card re-renders. Re-open the
     modal → fields are pre-populated.
   - Click "Compose announcement email" → modal opens; recipients
     are pre-populated from the promo's locations'
     `am_email/rm_email/site_email`. Remove one with × ; add an
     ad-hoc address; uncheck a material checkbox; ensure include-
     PTP is checked. Send → success banner with enqueued count =
     recipients count. Check Supabase `outbound_emails` — N new
     rows with `source_kind='promo-announcement'` and matching
     `source_id = announcementId`. Also confirm the announcement
     timeline entry under "Announcements".
   - As a `marketing` user, visit a promo's IT ticket page → see
     `NoAccessCard` (IT-only). On the live view, the "Open IT
     ticket" link is hidden but the modals (materials, PTP,
     announce) all surface — marketing has write access to those
     per Brief 156/157.
   - As an `ops` user (or any non-null promoRole that isn't
     super_admin / it / marketing), visit the live view → cards
     render but every "+" affordance is hidden. StatusEditor is
     also hidden (status PATCH is super_admin / it / marketing
     only).
   - Try `POST /promo/api/users/search?q=...` as a `marketing`
     user via curl → 403 `forbidden` (worker-side gate; the
     autocomplete is IT-only).

No cron at Brief 153 — no scheduled triggers configured. Future briefs
may add an 11:00–13:00 UTC ± something if a cleanup or digest is
needed (slot inventory across the project: 11:00 UTC forms cleanup,
11:30 UTC workorders MaintainX sync, 12:00 UTC forms approval digest,
13:00 UTC damage daily summary).

## 6.5 PA flow widening (Brief 160 — inline attachments)

Brief 160 adds CID inline-image support to the announcement send path.
Operator-side PA work is required before inline-flagged images render
embedded in the body — without it, inline-flagged images degrade to
regular attachments (the body HTML still ships, just without the
embedded images).

The shared "drain outbound_emails" flow (the one PA built for Brief
127) needs two new expressions on the per-attachment loop that maps the
queue row's `attachments[]` JSONB onto Send Email V2's `Attachments`
array:

- **IsInline (boolean)** — set to:
  ```
  @if(item()?['is_inline'], true, false)
  ```
- **ContentId (string)** — set to:
  ```
  @if(item()?['is_inline'], item()?['content_id'], null)
  ```

The existing `Name` / `ContentBytes` / `ContentType` mappings stay
unchanged.

**Behavior on a partially-widened flow.** If the operator has not yet
edited PA, `is_inline` + `content_id` are just JSONB keys PA never
reads; Send Email V2 treats every attachment as a regular attachment.
The recipient gets the body HTML (with `<img src="cid:...">` that
won't resolve — Outlook shows a broken-image placeholder, Gmail just
hides it) AND the same image as a downloadable attachment. Not pretty,
but the announcement still arrives. After PA is edited the
broken-image placeholder disappears and the image renders embedded in
the body.

**Recipient client coverage.** CID inline attachments are the standard
embed mechanism for transactional email and render in every modern
client we support: Outlook desktop 365 / 2019 / 2016, Outlook on the
web, Gmail (web + iOS + Android), Apple Mail (macOS + iOS), Yahoo,
default Android Mail. The `<img>` is hidden if the attachment
parsing fails (e.g., very old clients) — no broken-image marker.

## 7. Known limitations / v2 candidates

- No promo CRUD endpoint at Brief 153 — landed Brief 154.
- No material upload endpoint at Brief 153 — landed Brief 156.
- No PTP write endpoint at Brief 153 — landed Brief 156.
- No announcement send endpoint at Brief 156 — landed Brief 157.
- Brief 157 v2 candidates (out of scope): operator-authored HTML
  bodies (today the queue row's `body_html` is null and PA renders
  `body_text` only); auto-derived recipient lists from
  `pricing_simple.am_email / rm_email / site_email` per affected
  location (apps/web in Brief 158 will resolve and present an
  editable to-list per-send); PDF rendering of the snapshot for
  archive; paginated `GET /promo/api/promos/{id}/announcements`
  endpoint to browse history beyond the 20-row detail-response cap;
  "resend to a subset of failed recipients" — today the operator
  copy-pastes subject/body into a new POST.
- No daily R2 orphan sweep cron for promo materials (Brief 97 added
  one for forms submission files). Inline R2 rollback on upload
  failure handles 99% of the orphan window; if accumulation becomes
  observable post-launch, follow the forms-worker pattern in
  `apps/forms-worker/src/cron/` to add one.
- No apps/web pages (`/admin/promotions/*`) — at least one worker
  endpoint must ship first.
- No RLS policies — service-key-only access per the rest of the
  monorepo.
- No per-promo ACL (created_by + assignees override) — role-only at
  v1; widening the gate signature with a promoId is a v2 candidate.
- Production custom domain route — operator-driven cutover only;
  CLAUDE.md constraint #6 posture mirrors forms / fleet / jotform at
  similar stages of their respective rollouts.
