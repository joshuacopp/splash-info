# Brief 74: Work Orders — Medium pill fix + age alignment + "New Request" tab (create MaintainX work request with up to 5 photos)

**Status:** Completed (2026-05-08)
**Started:** 2026-05-08
**Completed:** 2026-05-08
**Blocks:** Two issues + one feature on `/workorders`. Visual: Medium-
priority rows render as plain text (no pill background), and the age
text under the priority pill is left-aligned with the pill's edge
rather than the pill's text. Feature: operators currently can only
view MaintainX work orders; this brief adds a "New Request" tab for
creating MaintainX work requests with up to 5 photos, all from one
form.
**Dependencies:**
- Brief 71 (the `WorkOrdersTabsClient`, `PriorityPill`, and worker
  read endpoint this brief extends).
- Brief 72 (conditional pagination — independent change, no
  conflict).
- Brief 73 (the age-under-priority placement and DueDatePill — also
  independent; Phase 1 of this brief touches the same priority cell
  but the changes are additive).
- Brief 37 / 38 (the plain-`<form>`-bypass-server-actions multipart
  upload pattern — this brief mirrors it for the photo upload form
  to sidestep the Next 15 / OpenNext-on-CF-Workers server-action
  multipart edge case that bit the damage upload path).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-071-workorders-v2-gating-grouping-assignees-types.md
  (the page architecture this brief extends)
- BRIEFS/brief-073-workorders-due-date-pill-and-age-under-priority.md
  (Phase 1 of this brief touches the priority cell that Brief 73
  modifies; sequencing matters — Brief 73 should land first, this
  brief layers the alignment fix on top)
- BRIEFS/brief-037-mobile-upload-legacy-port-plus-add-doc-anchor.md
  (the multipart-upload-bypassing-server-actions pattern this brief
  copies for photo handling — `<form action="/workorders/api/request"
  method="POST" enctype="multipart/form-data">` posting straight to
  the worker, server-rendered redirect on success)
- apps/workorders-worker/src/index.ts (the handler file gaining a
  POST endpoint for work-request creation)
- apps/workorders-worker/src/maintainx.ts (the helper file gaining
  `createWorkRequest` and `uploadWorkRequestThumbnail` /
  `uploadWorkRequestAttachment` exports)
- apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx (the
  client island where the new tab is added; tabs become Reactive /
  Preventive / New Request, the third tab renders a form instead of
  a list)
- apps/web/app/workorders/_components/PriorityPill.tsx (the file
  with the missing-MEDIUM-mapping bug)
- apps/web/app/workorders/page.tsx (the server component that
  passes data to `WorkOrdersTabsClient`; this brief extends the
  worker-fetch response shape to include `accessibleLocations[]` so
  the form's Location dropdown has data without an extra fetch)
- apps/web/app/workorders/_lib/worker-fetch.ts (response-shape
  type updated to include `accessibleLocations[]`)
- packages/db-supabase/src/locations.ts (the
  `getLocationsByContactEmail` helper this brief reuses for both
  the existing read path AND the new write path's location-list
  surface)
- packages/db-supabase/src/maintainx-users.ts (the
  `getMaintainXUsersByIds` / similar helper Brief 71 added — this
  brief adds a sibling `getMaintainXUserByEmail(env, email)` for
  the requester-attribution lookup)

## Context

### Visual issues

1. **MEDIUM priority rows have no pill background.** Operator
   screenshot 2026-05-07 shows OPEN status with a blue pill, ON_HOLD
   gray, HIGH red, LOW pill (light blue), but MEDIUM renders as
   plain text "Medium" with no rounded-full background. The
   `PRIORITY_CLASSES` map in `PriorityPill.tsx` is missing the
   `MEDIUM` key (or has it keyed wrong — e.g., on the humanized
   string "Medium" instead of the API enum value `"MEDIUM"`). One-
   line fix.

2. **Age text is misaligned under the priority pill.** Brief 73
   added a small "Nd" muted text below the priority pill in the
   first column. Because the pill has `px-2` horizontal padding,
   the pill's visible text starts ~0.5rem in from the cell's left
   edge — but the age `<div>` below has no padding and starts at
   the cell's left edge. The result reads as misaligned (age looks
   indented to the LEFT of the pill text). Fix: add matching `px-2`
   horizontal padding on the age wrapper so the two stack with
   their TEXT aligned, not their left edges.

### "New Request" feature

Operators currently use `/workorders` to view but not create. To
file a new request today they have to log into MaintainX directly.
This brief adds a third tab — "New Request" — that renders a form
instead of a list. The form posts to a new worker endpoint that
calls MaintainX's `POST /v1/workrequests` followed by per-file
`PUT /v1/workrequests/{id}/thumbnail/{filename}` (first photo) and
`PUT /v1/workrequests/{id}/attachment/{filename}` (additional
photos, up to 4 more). Total upload limit: 5 photos.

**Form fields** (operator decision 2026-05-07):
- Request Title (text, required) → MaintainX `title`
- Description of Issue and Troubleshooting Performed (textarea,
  required) → MaintainX `description` with a footer block
  appended (see Decisions)
- Priority (select: HIGH / MEDIUM / LOW; "NONE" not exposed because
  operators always set a real priority for new requests) →
  MaintainX `priority`
- Requester Name (text, required, defaults to maintainx_users
  full_name lookup by session email) → appended to description
- Requester Phone (text, optional) → appended to description
- Location (select, required, no default — operator must pick)
  → MaintainX `locationId`
- Photo(s) (file input, accept image/*, multiple, max 5)
  → first photo to /thumbnail, remaining to /attachment

**Location dropdown** (operator decision 2026-05-07): no default —
operator must explicitly pick to avoid accidental cross-site
submissions. Dropdown options come from
`getLocationsByContactEmail`'s response (already used for the read
path's email gate). Single-location users still see the dropdown
with one option and have to actively click — slight friction, but
the operator preferred this over auto-fill so a sloppy submit
can't accidentally land on the wrong site.

**Requester attribution** (operator decision 2026-05-07):
`creatorContactInfo` gets the operator's session email (matched to
maintainx_users → email). The form's Requester Name + Phone fields
get appended to description as a structured footer:

```
{form description}

---
Requested by: {requester_name}
Phone: {requester_phone or "—"}
Submitted via: Splash /workorders
```

The Requester Name input defaults to the operator's `full_name`
from `maintainx_users` (editable in case the operator is submitting
on behalf of a coworker without MaintainX access).

### Multipart upload posture

The form posts directly to the worker as `multipart/form-data` via
a plain `<form action="/workorders/api/request" method="POST"
enctype="multipart/form-data">` — bypassing Next 15 server actions.
This is the same pattern Brief 37/38 used for the damage-document
upload after the iPhone Safari multipart-server-action white-page
incident. On success, the worker 303-redirects back to
`/workorders?tab=new&request_ok=<id>`. On failure, redirects to
`/workorders?tab=new&request_error=<message>`. The page reads the
search params and renders a banner above the form.

## Scope

### Phase 1 — PriorityPill fixes

1.1 Modify `apps/web/app/workorders/_components/PriorityPill.tsx`:

  - Audit current `PRIORITY_CLASSES` and `PRIORITY_LABELS` maps.
    Confirm they're keyed on the API enum values
    (`"HIGH" | "MEDIUM" | "LOW" | "NONE"`), NOT humanized strings.
    If keyed wrong, fix.
  - Add MEDIUM mapping. Color: gray pill matching the visual
    weight of LOW/NONE — neither alarming (HIGH red) nor invisible
    (current state). Spec:
    ```ts
    const PRIORITY_CLASSES = {
      HIGH:   "bg-red-100   text-red-800",
      MEDIUM: "bg-gray-100  text-gray-800",
      LOW:    "bg-blue-100  text-blue-800",
      NONE:   "bg-gray-100  text-gray-500"
    } as const;
    ```
    (Adjust LOW's color if it's currently different; keep matching
    the existing visual style. The point is MEDIUM gets the same
    pill base structure as the other tiers.)

1.2 If `PriorityPill` consumes a `priority?: string | null` and
falls back to NONE for null/undefined, leave that branch alone —
just ensure MEDIUM doesn't fall through to it.

### Phase 2 — Age alignment fix

2.1 In `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`,
locate the priority cell render (Brief 73 added the age below the
priority pill).

2.2 Wrap the age `<div>` in `px-2` matching the pill's horizontal
padding so both items align on their text content, not their
container edges:

```tsx
<td>
  <PriorityPill priority={wo.priority} />
  <div className="text-xs text-gray-500 mt-0.5 px-2">
    {ageLabel(wo.createdAt)}
  </div>
</td>
```

  - Alternative: instead of `px-2` on the age div, wrap both
    elements in a flex column with `pl-2` on the wrapper. Same
    visual result. Executor's call.
  - Acceptance: visual inspection on staging post-deploy. The
    "Nd" text should sit under the priority text inside the pill,
    NOT under the pill's left edge.

### Phase 3 — Worker: POST /workorders/api/request

3.1 In `apps/workorders-worker/src/maintainx.ts`, add three new
exports:

```ts
export interface CreateWorkRequestInput {
  title: string;
  description: string;
  priority: "HIGH" | "MEDIUM" | "LOW";  // NONE not exposed to operators
  locationId: number;
  creatorContactInfo: string;            // operator's email
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}

export interface CreateWorkRequestResult {
  ok: boolean;
  requestId: number | null;              // null on failure
  error: string | null;
  status: number;
}

/** Calls MaintainX POST /v1/workrequests. Fail-soft. */
export async function createMaintainXWorkRequest(
  input: CreateWorkRequestInput
): Promise<CreateWorkRequestResult>;

export interface UploadWorkRequestFileInput {
  requestId: number;
  filename: string;       // sanitized; preserved extension
  body: ArrayBuffer | Uint8Array;
  apiKey: string;
  baseUrl: string;
  /** "thumbnail" or "attachment" */
  endpoint: "thumbnail" | "attachment";
  signal?: AbortSignal;
}

export interface UploadWorkRequestFileResult {
  ok: boolean;
  publicUrl: string | null;
  filename: string | null;
  fileKey: string | null;
  error: string | null;
  status: number;
}

/**
 * PUT /v1/workrequests/{id}/{thumbnail|attachment}/{filename}
 * Content-Type: application/octet-stream, body is binary.
 * Fail-soft.
 */
export async function uploadMaintainXWorkRequestFile(
  input: UploadWorkRequestFileInput
): Promise<UploadWorkRequestFileResult>;
```

3.2 Implementation details:

  - `createMaintainXWorkRequest`:
    - URL: `${baseUrl}/workrequests`
    - Method: POST, `Content-Type: application/json`,
      `Authorization: Bearer ${apiKey}`.
    - Body: `{ title, description, priority, locationId,
      creatorContactInfo }`. Optional fields (`assetId`,
      `approverTeamId`, `extraFields`) omitted in v1.
    - Response: parse JSON, extract `id` (top-level per the API
      spec). Return result with `requestId: body.id`. On non-2xx
      or parse failure, return `{ ok: false, requestId: null,
      error: <`MX ${status}: ${truncated body}`>, status }`.

  - `uploadMaintainXWorkRequestFile`:
    - URL: `${baseUrl}/workrequests/${requestId}/${endpoint}/${encodeURIComponent(filename)}`
    - Method: PUT, `Content-Type: application/octet-stream`,
      `Authorization: Bearer ${apiKey}`.
    - Body: raw binary (`ArrayBuffer` / `Uint8Array`).
    - Response: parse JSON `{ publicUrl, filename, fileKey }`.
      Return result with those fields. On failure, return
      `{ ok: false, publicUrl: null, filename: null, fileKey:
      null, error, status }`.

3.3 In `apps/workorders-worker/src/index.ts`, add a new handler
mounted on `POST /workorders/api/request`:

  - Auth: same email-on-locations gate as the read path. If the
    user's email matches no location, 403 (cannot file a request
    without a covered location).
  - CSRF: `isOriginAllowed` gate — the form's submit comes from
    apps/web, which posts cross-origin in dev and same-origin in
    prod. Origin check matches the existing damage-worker pattern.
  - Parse multipart:
    - `request.formData()` — gets all the text fields and files.
    - Required text fields: `title`, `description`, `priority`,
      `requester_name`, `location_id`. Reject with 303 redirect
      to `/workorders?tab=new&request_error=<reason>` on missing.
    - Optional text fields: `requester_phone`.
    - Files: read all `photo` keys (multi-file inputs come
      through as multiple entries with the same name). Cap at 5.
      Reject with 303 redirect on >5.
    - Validate `location_id` is in the user's accessible set
      (defense-in-depth — UI already constrains the dropdown).
    - Validate `priority` is one of the three allowed values.
  - Compose `description`:
    ```
    {raw description from form}

    ---
    Requested by: {requester_name}
    Phone: {requester_phone or "—"}
    Submitted via: Splash /workorders
    ```
  - Look up `creatorContactInfo`:
    - Use the session email directly. (Could also look up
      `maintainx_users` by email and use the canonical row's
      email, but session email is simpler and equally
      correct.)
  - Call `createMaintainXWorkRequest`. On failure, 303 redirect
    with `request_error`.
  - On success, iterate photos:
    - First photo → `uploadMaintainXWorkRequestFile` with
      `endpoint: "thumbnail"`.
    - Photos 2–5 → `uploadMaintainXWorkRequestFile` with
      `endpoint: "attachment"`.
    - Each upload's failure is logged but DOES NOT roll back the
      created request — the work request exists in MaintainX
      either way, and partial photo uploads are an acceptable
      degraded outcome. Activity-log-style note: append failure
      details to the success redirect's query so the page can
      surface "request created (#N) but 2 of 5 photos failed to
      upload — re-add manually in MaintainX."
  - On full success, 303 redirect to
    `/workorders?tab=new&request_ok=<requestId>`.

3.4 Filename sanitization for the binary upload URL:
  - Uploaded files come with a `name` from the browser. Sanitize:
    strip leading dots, replace anything outside
    `[a-zA-Z0-9._-]` with `_`, lowercase the extension. Cap
    length at 80 chars (preserving extension).
  - URL-encode the sanitized filename when building the PUT URL.

3.5 Per-upload timeout: 15 seconds via `AbortController`. Total
endpoint timeout (creation + 5 uploads): 90 seconds. Acceptable
for a single user-driven submit.

### Phase 4 — apps/web: New Request tab + form

4.1 Extend the worker's `GET /workorders/api/list` response shape
to include `accessibleLocations: AccessibleLocation[]` where:

```ts
interface AccessibleLocation {
  maintainx_id: number | null;     // null when locations row exists but
                                    // not yet mapped to MaintainX
  location_address: string | null;  // for display fallback
  location_name: string | null;     // pulled from MX expand=location during
                                    // the read fetch where available; null
                                    // when no WO has yet referenced this loc
}
```

  - The worker already calls `getLocationsByContactEmail` to
    determine which `maintainx_id` to pass to MaintainX. Surface
    the resolved list in the response shape so apps/web doesn't
    need a second fetch for the form.
  - For the form: filter to entries with `maintainx_id !== null`
    (a request can't post to an unmapped location).

4.2 In `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`:

  - Tab state goes from `"reactive" | "preventive"` to
    `"reactive" | "preventive" | "new"`.
  - Tab nav: third pill labeled "New Request" (no count badge).
  - When `activeTab === "new"`, render a new
    `NewRequestForm` component instead of the list.
  - On mount, read URL search params for `?tab=new&request_ok=N`
    or `?tab=new&request_error=...`. Set active tab to "new" if
    those are present (operator returning from a submit).

4.3 New file
`apps/web/app/workorders/_components/NewRequestForm.tsx`:

  - Plain `<form action="/workorders/api/request" method="POST"
    enctype="multipart/form-data">` — bypassing Next 15 server
    actions per Brief 37/38 pattern.
  - Form action URL: relative `/workorders/api/request` —
    resolves through CF same-zone routing in production /
    staging, or `next.config.mjs` rewrites in dev.
  - Fields (in render order):
    1. Location (select, required, no default option) — populated
       from the `accessibleLocations` prop. Each option is
       `<option value="{maintainx_id}">{location_name ?? location_address}</option>`.
    2. Request Title (text input, required, max 120 chars).
    3. Priority (radio button group: HIGH / MEDIUM / LOW; no
       default — operator must pick).
    4. Description (textarea, required, max 4000 chars).
    5. Requester Name (text input, required, max 80 chars,
       defaults to operator's full_name from maintainx_users via
       a new `currentUser` prop on the page). Editable.
    6. Requester Phone (text input, optional, max 30 chars).
    7. Photo(s) (file input with `accept="image/*" multiple`,
       max 5 files; small client-side check + a server-side
       guard for defense-in-depth).
    8. Submit button.
  - On the operator's session, derive their email server-side and
    pass through props. Don't include email as a form field — the
    worker reads it from the session cookie.
  - Result banners (above the form):
    - `?request_ok=N` → green banner "Request #N created. View
      in MaintainX: <link>". Stays visible until next submit or
      tab switch.
    - `?request_error=...` → red banner with the URL-decoded
      message. Form values cleared on error (since this is a
      page reload, all inputs reset by default — operator
      retypes; acceptable for v1).
  - The banner text could surface partial-upload failures with
    `request_warn=2-of-5-photos-failed` query param — left as a
    nice-to-have; v1 just shows ok/error, partial-photo-fail
    becomes "ok" in the banner with a console.warn server-side.

4.4 Server component changes in `apps/web/app/workorders/page.tsx`:
  - Pass through to `WorkOrdersTabsClient`:
    - `accessibleLocations` (from the new response field)
    - `currentUser` ({ email, full_name } — full_name from
      maintainx_users lookup, served via the worker's response or
      a separate small fetch)
  - The worker's response can include `currentUser` alongside
    `accessibleLocations` to keep this single-fetch.

4.5 The worker's response-shape extension:

```ts
{
  reactive: { groups: [...] },
  preventive: { groups: [...] },
  fetchedAt: "...",
  truncated: false,
  pageCount: 1,
  // Brief 74 additions:
  accessibleLocations: AccessibleLocation[],
  currentUser: {
    email: string,
    full_name: string | null   // from maintainx_users lookup; null when no row
  }
}
```

### Phase 5 — Supabase helper

5.1 In `packages/db-supabase/src/maintainx-users.ts`, add:

```ts
export async function getMaintainXUserByEmail(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  email: string
): Promise<MaintainXUserRow | null>;
```

  - Query: `?email=ilike.<email>&select=id,full_name,email&limit=1`
    (case-insensitive match because user emails in maintainx_users
    are mixed case but session.email is lowercased by Brief 71's
    gating helper).
  - Return null on no match or any throw.

5.2 Export from `packages/db-supabase/src/index.ts`.

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass for all 14 packages.

6.2 `pnpm --filter @splash/web build` — must succeed.

6.3 `pnpm --filter @splash/workorders-worker exec wrangler deploy
--dry-run` — must succeed.

6.4 No D1 schema change. No Supabase schema change.

6.5 Live smoke test (operator post-deploy):
  - (a) Verify visual fix: Medium-priority rows render with a
    gray pill background. Age "Nd" text aligns under the
    priority text, not the pill edge.
  - (b) Submit a test request via the New Request tab — title,
    description, priority MEDIUM, no photos, single-site-user
    location. Confirm it lands in MaintainX with the operator's
    email in the requester contact info, name+phone in the
    description footer.
  - (c) Submit a second test request with 3 photos. Confirm the
    first photo appears as the WO thumbnail, the other two as
    attachments.
  - (d) Try to submit with 6 photos — confirm the form rejects
    client-side, OR if it bypasses to the worker, confirm 303
    redirect with `request_error=too_many_photos`.
  - (e) As a multi-location user, confirm the Location dropdown
    has no default and rejects submission without a pick.
  - (f) Confirm `?tab=new&request_ok=N` URL renders the green
    success banner.

### Phase 7 — Documentation updates

7.1 CLAUDE.md — under the "Work Orders" glossary entry, append:

```
- Brief 74: New Request tab on /workorders. Form posts to
  POST /workorders/api/request (multipart/form-data, plain HTML
  form bypassing Next 15 server actions per Brief 37/38 pattern);
  worker calls MaintainX POST /v1/workrequests then per-photo
  PUT /v1/workrequests/{id}/{thumbnail|attachment}/{filename}.
  Up to 5 photos: first → thumbnail, rest → attachments.
  Requester attribution: creatorContactInfo = operator's session
  email; requester name + phone appended to description footer.
  Location dropdown has no default — operator must explicitly
  pick.
```

7.2 BUILD_STATE.md:
  - Bump "Last updated".
  - New row in "Open work — prioritized" for Brief 74.
  - Findings entry covering: PriorityPill MEDIUM fix, age
    alignment fix, and the new write surface.

7.3 BRIEFS/INDEX.md — append Brief 74 row.

7.4 BRIEFS/QUEUE.md — append Brief 74 filename.

## Out of scope

- Editing or deleting work requests after submission. Operators
  do that in MaintainX directly.
- Polling or webhook-based status updates of submitted requests.
- Adding the New Request form to the dashboard or as a standalone
  page (e.g., `/workorders/new`). Tab on the existing page is
  sufficient v1.
- Attachment file types beyond `image/*`. PDF / video / audio
  attachments could be useful in future iterations.
- Asset selection for the request (`assetId`). Operators describe
  the asset in the title / description for v1; MaintainX team can
  link the asset post-submission.
- Approver / approverTeamId selection. v1 leaves it null; admin
  team handles routing in MaintainX.
- Custom extraFields. v1 doesn't expose; future brief if needed.
- Don't deploy from headless. Push triggers CF Workers Builds
  auto-deploy on splash-workorders + apps/web.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/workorders/_components/PriorityPill.tsx`
  has a MEDIUM pill render path producing a gray pill background
- Age `<div>` in `WorkOrdersTabsClient.tsx` has matching `px-2`
  alignment under the priority pill text
- `apps/workorders-worker/src/maintainx.ts` exports
  `createMaintainXWorkRequest` and `uploadMaintainXWorkRequestFile`
- `apps/workorders-worker/src/index.ts` mounts
  `POST /workorders/api/request` with email-on-locations gate +
  CSRF Origin check + multipart parse + ≤5-photo cap + create-
  then-upload flow + 303-redirect response posture
- `packages/db-supabase/src/maintainx-users.ts` exports
  `getMaintainXUserByEmail`
- `apps/web/app/workorders/_components/NewRequestForm.tsx` exists,
  submits to `/workorders/api/request` as multipart, has the seven
  fields + photo input
- Tab state in `WorkOrdersTabsClient.tsx` extended to
  `"reactive" | "preventive" | "new"`; URL search param
  `?tab=new&request_ok=...` / `?tab=new&request_error=...` drives
  banner display
- Worker's `/list` response shape extended with
  `accessibleLocations: AccessibleLocation[]` and `currentUser`
- pnpm typecheck passes for all 14 packages
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated
- Status set to Completed (YYYY-MM-DD)

## Report

- Files created (~3: NewRequestForm.tsx,
  maintainx-users.ts may already exist from Brief 71 — extend
  in place; helper additions in maintainx.ts)
- Files modified (~5-7: PriorityPill.tsx,
  WorkOrdersTabsClient.tsx, page.tsx, worker-fetch.ts, worker
  index.ts + maintainx.ts, plus CLAUDE.md + BUILD_STATE.md)
- Bundle deltas: workorders-worker (new helpers + handler) and
  apps/web `/workorders` (new client form + tab state)
- Validation results
- Empirical observations:
  - Confirmation that MaintainX `POST /v1/workrequests`
    response really does have the work-request id at top-level
    `body.id` (verify during executor's smoke test, document
    actual shape)
  - Confirmation that the thumbnail/attachment endpoints
    accept `application/octet-stream` with binary body and
    return the documented `{ publicUrl, filename, fileKey }`
    shape
- Decisions made on the operator's behalf
- Latent issues / forward flags

## Outcome

**Files created (1):**
- `apps/web/app/workorders/_components/NewRequestForm.tsx` — client island
  rendering the seven-field form (Location dropdown / Title / Priority radios
  / Description / Requester Name / Requester Phone / Photos), posting to
  `/workorders/api/request` as multipart/form-data.

**Files modified (12):**
- `apps/web/app/workorders/_components/PriorityPill.tsx` — Phase 1: MEDIUM
  swapped from `bg-yellow-100 text-yellow-900` (read as plain text per
  operator's 2026-05-07 screenshot) to Splash-brand `bg-gray-light
  text-splash-navy/80`. Other three states verbatim.
- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx` — Phase 2
  + Phase 4: age `<div>` under the priority pill gains `px-2` for text
  alignment under the pill. Tab state extended to
  `"reactive" | "preventive" | "new"`. URL-search-param init in
  `useEffect` clears `?request_ok` / `?request_error` / `?request_warn`
  via `history.replaceState` so refresh doesn't resurrect the banner.
  `RequestResultBannerView` renders three-color banner (green / amber /
  red). `TabNav` extended with a third "New Request" tab (no count
  badge — `TabButton.count?` made optional). `BucketEmptyState` and
  `GroupSection` narrowed to `tab: "reactive" | "preventive"` since
  they're never rendered with `tab="new"`.
- `apps/web/app/workorders/page.tsx` — passes `accessibleLocations` and
  `currentUser` through to `WorkOrdersTabsClient`.
- `apps/web/app/workorders/_lib/worker-fetch.ts` — added
  `AccessibleLocation` and `WorkOrdersCurrentUser` interfaces;
  `WorkOrdersListResponse` extended with `accessibleLocations: AccessibleLocation[]`
  and `currentUser: WorkOrdersCurrentUser`.
- `apps/workorders-worker/src/index.ts` — Phase 3: new `POST
  /workorders/api/request` route mounted on the default-export
  `fetch` handler. New `handleCreateRequest` with `isOriginAllowed`
  CSRF gate, email-on-locations defense-in-depth gate (matches read
  path's `getLocationsByContactEmail`), multipart parse, ≤5 photo cap,
  ≤15 MB per-photo cap, sequential photo upload with first → thumbnail
  / rest → attachment, partial-failure-non-fatal posture. New
  `buildRequestRedirect` (303 to `${origin}/workorders?tab=new&...`).
  New `sanitizeFilename` (strip leading dots, replace non-`[a-zA-Z0-9._-]`
  with `_`, lowercase extension, cap at 80 chars). `handleList`
  extended to populate `accessibleLocations` (harvesting MX-side
  `expand=location.name` from the WO list as the `location_name`
  source) and `currentUser.full_name` (via the new
  `getMaintainXUserByEmail` helper).
- `apps/workorders-worker/src/maintainx.ts` — Phase 3 helpers:
  `createMaintainXWorkRequest` (POST `/v1/workrequests`; defensive
  envelope-shape probing for `body.id` / `body.workRequest.id` /
  `body.data.id`) and `uploadMaintainXWorkRequestFile` (PUT
  `/v1/workrequests/{id}/{thumbnail|attachment}/{filename}` with
  `application/octet-stream` body; tolerates empty success body).
  Both fail-soft (never throw; non-2xx / fetch error / parse failure
  → `ok: false` with error string + status).
- `packages/db-supabase/src/maintainx-users.ts` — Phase 5: new
  `getMaintainXUserByEmail(env, email)` using PostgREST
  `email=ilike.<sanitized>` for case-insensitive match. Fail-soft to
  null. Exported via `index.ts`'s existing `export *` chain.
- `CLAUDE.md` — Workorders-worker endpoints entry extended with the
  Brief 74 surfaces (POST `/workorders/api/request`); Work Orders
  glossary entry extended with the Brief 74 New Request tab summary.
- `BUILD_STATE.md` — bumped "Last updated" to 2026-05-08; new
  Findings & decisions log row.
- `BRIEFS/INDEX.md` — appended Brief 74 row.
- `BRIEFS/QUEUE.md` — Brief 74 marked as completed (commented out).
- `BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md`
  — Status flipped to Completed (2026-05-08); this Outcome section
  filled in.

**Decisions made on the operator's behalf:**
1. MEDIUM color: brief's spec example used `bg-gray-100 text-gray-800`
   (default Tailwind palette); chose Splash-brand `bg-gray-light
   text-splash-navy/80` for consistency with HIGH/LOW/NONE (all use
   brand classes already). Both render gray; brand path keeps the
   palette uniform.
2. Filename sanitization: 80-char cap with extension preserved — when
   over the cap the stem is trimmed, never the extension.
3. Per-photo size cap: 15 MB (matches the damage-document cap
   precedent from Briefs 37/38).
4. Photo upload failures non-fatal — request stays created in
   MaintainX, partial-success banner explicitly tells operator to
   re-add missing photos in MaintainX directly.
5. `creatorContactInfo` = session email directly (skipped a
   `maintainx_users` round-trip; both are equivalent and session
   email is simpler).
6. `request_warn` query-param shape: `{N}-of-{M}-photos-failed`;
   banner replaces hyphens with spaces for display.
7. Worker response shape additions (`accessibleLocations` +
   `currentUser`) ride alongside the existing `email` /
   `accessibleLocationCount` / `mappedLocationCount` fields rather
   than nesting under a `forNewRequest: { ... }` sub-object — the
   existing fields are also debug-friendly flat scalars, and the
   form pulls from the same flat shape on the apps/web side.
8. URL-search-param banner cleanup uses `history.replaceState`
   immediately on mount so a page refresh doesn't resurrect a stale
   banner. The banner state stays in React state; the URL becomes
   the trigger, not the source-of-truth for display.

**Latent issues / forward flags:**
1. **MaintainX `POST /v1/workrequests` response shape unverified
   empirically.** The helper tries three envelope shapes (`body.id`
   / `body.workRequest.id` / `body.data.id`); operator's first live
   submit will reveal which is canonical. If MX returns a different
   shape (e.g., `body.result.id` or `body.workRequestId`), the helper
   will return "response missing work-request id" — clear signal in
   the worker logs.
2. **MaintainX `PUT /v1/workrequests/{id}/{thumbnail|attachment}/{filename}`
   body shape unverified.** Helper sends `application/octet-stream`
   with raw `ArrayBuffer`. If MX rejects (415 or similar), v2 swap
   candidates: (a) `multipart/form-data` with `file=<binary>`, (b)
   `application/json` with base64 body. Worker logs will surface
   the upstream error message verbatim.
3. **No client-side submit spinner.** Operator clicks submit, browser
   shows nothing for up to ~90s while photos upload. v2 candidate:
   client-side submit handler that disables the button and renders
   a spinner. Out of scope per Brief 74; leaving for operator
   feedback after first live use.
4. **Form data lost on validation error.** Worker redirects rather
   than re-rendering with prior values; on a `request_error` banner
   the operator retypes. v2 candidate: `request_form_state` cookie
   round-trip, or move validation client-side via JS. Acceptable for
   v1.
5. **Photos field `accept="image/*"` only.** Brief flags PDF / video
   / audio attachments as out-of-scope; future iteration if MX
   supports them on the work-request endpoint.
6. **No `assetId` selector.** Operator describes the asset in
   title/description; MX team links the asset post-submission. v2
   candidate: an autocomplete sourced from MaintainX's asset
   endpoint, scoped to the chosen location.
7. **Single-location users still see the dropdown with one option**
   — operator preferred this (per brief context) so a sloppy submit
   can't accidentally land on the wrong site, even when there's only
   one accessible site.
8. **Origin fallback for the 303 redirect:** when the request lacks
   an `Origin` header, falls back to the worker's own URL origin —
   would redirect to e.g., `splash-workorders.workers.dev/workorders`,
   which 404s in apps/web's frame. This only happens when Origin
   AND Referer are both missing (server-to-server probe), which is
   blocked at the `isOriginAllowed` gate anyway, so the fallback is
   defensive-only.
9. **MaintainX work-request ID URL pattern unverified for the
   success-banner deep link.** Helper renders
   `https://app.getmaintainx.com/workrequests/{id}` — same pattern as
   Brief 42's WO link (`/workorders/{id}`), assumed parallel. If MX
   uses a different path (e.g., `/work-requests/`), the link will
   404 but the request itself is unaffected.

**Validation results:**
- `pnpm typecheck` — 14 / 14 packages green. (One typecheck
  iteration: hit `Type 'ArrayBuffer | Uint8Array<ArrayBufferLike>'
  is not assignable to type 'BodyInit'` on the `PUT` body in
  CF Workers' RequestInit shape; narrowed `UploadWorkRequestFileInput.body`
  to `ArrayBuffer` only. Re-run green.)
- `pnpm --filter @splash/web build` — green. `/workorders` route
  5.29 kB / 107 kB First Load JS (+1.83 kB vs Brief 73's 3.46 kB
  baseline — accounted for by the new `NewRequestForm` client
  island and the banner state-machine).
- `pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run` — green. 748.05 KiB / 142.38 KiB gzip (~+30 KiB
  vs Brief 73 baseline for the new helpers and handler).

**Bundle deltas (summary):**
- splash-workorders worker: ~+30 KiB raw / ~+5 KiB gzip.
- apps/web `/workorders` route: +1.83 kB raw client bundle.

**Empirical MaintainX-API observations:** deferred — operator's first
live submit will confirm `body.id` extract path and the
octet-stream body acceptance on `/thumbnail` / `/attachment`
endpoints. Worker logs surface upstream errors verbatim, so any
mismatch between assumed and actual shape is observable
post-deploy without code changes.
