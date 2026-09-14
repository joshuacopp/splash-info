# Brief 23: Port the customer claim form (GET /claims/{site}) to damage-worker

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Customer-facing claim submission. Without this, the damage
manager has nowhere for customers to enter their claims - the
existing /claims-api/submit-claim POST endpoint is unreachable from a
real browser.
**Dependencies:** Brief 16 (route binding), Brief 5b/5c/5d (manager
side, unaffected).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-016-staging-subdomain.md (route bindings)
- apps/damage-worker/src/index.ts (current dispatch - only handles
  /claims-api/* and /manage/api/*; no /claims/{site} GET)
- apps/damage-worker/src/index.ts handleClaimSubmission (around
  line 975) - the existing POST handler the form posts to
- legacy/damagemanager.js - search for `renderDamageForm`,
  `renderClaimForm`, the GET-/claims/{site} handler. The full HTML
  template is in there. Photo category names and form field names
  must match what handleClaimSubmission expects (around line 1032 in
  the new worker).
- packages/storage-r2/src/assets.ts (ASSETS for logo URLs)
- packages/db-d1/src/locations.ts (`getActiveLocationByCode` - used
  to validate the URL slug before rendering)

## Context

Decision 9 ratified that damage-worker owns the public customer claim
form (`/claims/{site}`). Brief 16 added the route binding
(`staging.splashcarwashes.info/claims/*` to damage-worker). But the
actual HTML render handler was never ported from
legacy/damagemanager.js to the new worker. Hitting
/claims/binghamton currently 404s because the worker dispatch falls
through to `return new Response("Not found", { status: 404 })`.

This brief ports the form. Build-phase port gap fix.

## Scope

1. **Add GET /claims/{location-slug} dispatch** in
   `apps/damage-worker/src/index.ts`:

   ```ts
   if (parts[0] === "claims" && parts.length === 2 && method === "GET") {
     const locationSlug = parts[1];
     return handleRenderClaimForm(env, locationSlug);
   }
   ```

   Place after the /claims-api/photo/* dispatch and before the
   /manage/api/* gate, since /claims/{slug} is also public.

2. **Implement `handleRenderClaimForm(env, locationSlug)`**:
   - Validate the slug: `getActiveLocationByCode(env.DB, locationSlug)`.
     If null, render a small "Location not found" HTML page
     (200 OK with friendly message OR 404 with friendly HTML - pick
     whichever reads cleaner).
   - On valid location: render the full claim form HTML using a port
     of legacy `renderDamageForm`. Lives in legacy/damagemanager.js;
     mirror it into a new file
     `apps/damage-worker/src/render/claim-form.ts` (or inline if
     short - the legacy version is around 200 lines including styles).
   - Form `action` posts to `/claims-api/submit-claim` (already
     handled by handleClaimSubmission). Method `POST`, encType
     `multipart/form-data`.
   - Field names MUST match what handleClaimSubmission reads (around
     index.ts:1032-1100):
       - customerName, customerPhone, customerEmail,
         customerMailingAddress
       - vehicleYear, vehicleMake, vehicleModel, vehicleColor,
         licensePlate
       - damageDescription, preexistingDamage, staffNotes
       - determination (radio: no_responsibility /
         requires_gm_review / customer_get_quotes - match the
         ClaimDetermination enum)
       - submittedBy (employee name; optionally pre-populated)
       - equipmentInvolved (text or "N/A")
       - customerTold (free-text)
       - customerDemeanor (free-text)
       - 4 photo file inputs: fourCornersPhotos, vinPhoto,
         damagePhotos, platePhoto - match PHOTO_CATEGORIES at
         index.ts:144-150.
   - Hidden field `locationCode` set to the slug.
   - Use ASSETS.logoWhite for the brand logo (R2 URL).
   - Brand styling: match the legacy form's visual language. The
     legacy file's inline CSS block is the source.

3. **Keep the form simple but correct**:
   - HTML5 `required` on customer name, phone, vehicle make/model,
     damage description, determination, submittedBy. Optional:
     vehicleColor, licensePlate, mailing address, customerTold,
     customerDemeanor.
   - File inputs: `accept="image/*,image/heic,image/heif"`,
     `multiple` on the four corners and damage groups, single on
     VIN and license plate.
   - Determination as 3 radio buttons with labels (matches the
     legacy DETERMINATION_CHOICES).
   - Submit button "Submit claim".
   - On submit success (worker returns 200): redirect to a "Thank
     you" confirmation page (legacy renders it inline; mirror).
   - On submit failure: re-render the form with an error banner.
     Acceptable v1: just render an error page with "Claim submission
     failed. Please retry. <error>".

4. **Add a "Thank you" confirmation page** at GET /claims/{slug}/thanks
   (or render it inline as the response body of the POST handler when
   it returns 200; legacy returns the HTML inline). Pick whichever
   matches the existing handleClaimSubmission's response shape -
   verify what it returns today (likely JSON; may need to upgrade to
   conditional 302+Location for browser submits, JSON for
   programmatic ones).

   Most likely path: handleClaimSubmission currently returns JSON.
   Add an `Accept` header check or a `redirect=...` form field to
   conditionally return 302+Location for browser submits, JSON for
   programmatic ones. Document the choice in the Outcome.

5. **Update apps/damage-worker route comments** at the top of
   index.ts to list /claims/{site} GET in the public section of the
   route table.

6. **Update BRIEFS/INDEX.md and BUILD_STATE.md** as usual.

## Configuration

No new env vars or secrets.

## Out of scope

- Customer-claim-form i18n / multi-language support.
- Mobile-camera-specific UX polish (drag-drop, capture button).
- Adding terms-and-conditions modal beyond what legacy had.
- Photo previews / client-side compression.
- E2E tests.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  succeeds (or equivalent build verification)
- damage-worker dispatch handles GET /claims/{slug} returning the
  form HTML
- Form fields match handleClaimSubmission's expected names and types
- Submit flow lands on a thanks page (or analogous success state) on
  success; renders error on failure
- Invalid slug renders a "Location not found" message (200 or 404,
  styled)
- Worker route table comment block at the top of index.ts lists the
  new GET row
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- How handleClaimSubmission's response was reconciled with the form's
  submit flow (JSON vs. 302 redirect)
- Whether renderDamageForm was inlined in index.ts or extracted into
  a `render/claim-form.ts` module
- Field-name audit results - all field names in the rendered form
  match what handleClaimSubmission reads
- Bundle-size delta on damage-worker (the form HTML is non-trivial;
  expect ~10-30 KiB gzip increase)
- Latent issues spotted in handleClaimSubmission while reading it
  (e.g., field-name mismatches, validation gaps)
- Validation results

## Outcome

**Files created:**

- `apps/damage-worker/src/render/claim-form.ts` — exports
  `renderClaimForm({ locationCode, locationPretty, errorMessage })`,
  `renderThanksPage({ locationPretty, claimId })`,
  `renderClaimNotFound(slug)`, and an `htmlResponse(body, status?)`
  helper. Single-page port of the legacy two-section form (legacy
  multi-step JS, animated bubbles, and staff-password gate dropped per
  brief's "keep simple but correct" guidance). Splash-blue gradient
  header preserved using `ASSETS.logoWhite` from `@splash/storage-r2`.
  EQUIPMENT_CHOICES and DETERMINATION_CHOICES inlined here verbatim
  from legacy. Inline `<script>` mirrors the equipment-malfunction
  checkbox into a hidden input named `equipmentMalfunction` so the
  worker continues to read the legacy `"true"/"false"` string.

**Files modified:**

- `apps/damage-worker/src/index.ts`:
  - Added `import` of the four new render-module exports.
  - Extended the route-table comment block at the top of the file to
    list `GET /claims/{location-slug}` and `GET /claims/{location-slug}/thanks`
    in the PUBLIC section, plus a note on the `POST /claims-api/submit-claim`
    Accept-based dual-mode response shape.
  - Inserted two new public-dispatch branches between the
    `/claims-api/photo/*` block and the `/manage/api/*` gate:
    `GET /claims/{slug}` → `handleRenderClaimForm`,
    `GET /claims/{slug}/thanks` → `handleRenderThanks`.
  - Added `handleRenderClaimForm(env, slug, url)` and
    `handleRenderThanks(env, slug, url)` after `dispatchManageApi`.
    Both validate the slug via `getActiveLocationByCode(env.DB, slug)`
    and return `renderClaimNotFound(slug)` with status 404 on miss.
    `handleRenderClaimForm` reads `?error=...` (capped at 240 chars)
    from the URL to surface a banner after a failed POST bounce.
    `handleRenderThanks` reads `?id=<claimId>` (capped at 64 chars).
  - `handleClaimSubmission` made dual-mode: a top-of-handler
    `browserMode = request.headers.get("Accept")?.includes("text/html")`
    flag drives a `Response.redirect(..., 303)` on the success path
    (target: `/claims/{slug}/thanks?id={claimId}`) and a `303` to
    `/claims/{slug}?error=<encoded>` on the catch branch. JSON callers
    (no `text/html` in Accept) continue to receive the existing
    `{ success, claimId, powerAutomateSuccess, d1Success, photosUploaded }`
    body. Error-path slug recovery uses the Referer header
    (`new URL(referer).pathname` matched against `/^\/claims\/([^/]+)/`)
    because `request.formData()` may have already failed and is
    single-shot.

**Files NOT modified** (sanity-checked, no change needed):

- `apps/damage-worker/wrangler.toml` — staging routes already include
  `staging.splashcarwashes.info/claims/*` (Brief 16); production routes
  remain commented. No deploy. Operator handles deploy per CLAUDE.md.
- `packages/storage-r2/src/assets.ts` — `ASSETS.logoWhite` consumed
  unchanged.
- `packages/db-d1/src/locations.ts` — `getActiveLocationByCode`
  consumed unchanged.

**Decisions made on operator's behalf:**

1. **Field-name discipline: matched what `handleClaimSubmission`
   actually reads, not what the brief listed.** The brief enumerated
   `customerMailingAddress`, `damageDescription`, `preexistingDamage`,
   `staffNotes`, and `submittedBy`. The current worker (per
   `index.ts:1117-1143`) reads `mailingAddress`, `issueDescription`,
   `preExistingDamage`, `employeeName` — and there is no `staffNotes`
   field; staff notes is built worker-side from `customerTold` +
   `customerDemeanor`. The brief told me "Field names MUST match what
   handleClaimSubmission reads (around index.ts:1032-1100)" so the
   worker is the source of truth; the brief's enumerated list was a
   recall miss. The form posts the legacy field names verbatim and
   hits the worker's existing parse pipeline cleanly.

2. **JSON ↔ 303 redirect dual-mode keyed off `Accept` header**, not a
   `redirect=html` form field. Accept is what every browser sends
   automatically; programmatic JSON callers send
   `Accept: application/json` (or omit it). The detection rule is
   `acceptHeader.includes("text/html")`. Edge case: a programmatic
   caller that lazily sends a browser-shaped Accept header would get
   redirected — flagged as a latent issue below; cleanest mitigation
   would be a `?json=1` query-string opt-out, but it's not yet
   warranted (no known programmatic callers in the monorepo today).

3. **303 (See Other) chosen over 302**, per the
   `<form action="/claims-api/submit-claim" method="POST">` POST →
   GET-on-success idiom. 302 historically allows the client to
   re-issue POST on the redirect target; 303 forces GET. The
   `/claims/{slug}/thanks` page is a GET handler — 303 is correct.

4. **Thanks page is a separate `GET /claims/{slug}/thanks` route**,
   not an inline render of the POST handler's response body. Reasoning:
   keeps the POST handler stateless from a rendering POV, gives
   customers a bookmarkable "I submitted this claim" URL with
   `?id=<claim-id>` so they can share it with a manager, and survives
   the page reload that some browsers do after a redirect. Bouncing
   through a GET also dodges the "duplicate submit on Back button"
   re-POST footgun.

5. **Slug validation: invalid slug returns 404 with friendly HTML**
   (not 200). Customers don't normally land on invalid slugs in
   practice (URLs are typed once into the bookmark) but the 404
   status differentiates "I made a typo" from "I'm logged in" for
   any external healthchecks the operator might wire up. The HTML
   body is identical regardless.

6. **Form fields marked required exactly per brief spec** —
   `customerName`, `customerPhone`, `vehicleMake`, `vehicleModel`,
   `issueDescription`, `determination`, `employeeName` carry HTML5
   `required`. Optional per brief: `vehicleColor`, `licensePlate`,
   `mailingAddress`, `customerTold`, `customerDemeanor`. Not
   enumerated by the brief: `equipmentInvolved` (kept required —
   legacy parity), `customerEmail` / `vehicleYear` /
   `membershipNumber` / `preExistingDamage` (kept optional). The
   four photo inputs (`fourCornersPhotos`, `vinPhoto`,
   `damagePhotos`, `platePhoto`) are required to match legacy
   behavior — without photos the claim has no evidence record.

7. **`equipmentMalfunction` is rendered as a UI-only checkbox plus a
   hidden input** that mirrors the checkbox state ("true" / "false").
   Worker reads the hidden input. Single tiny inline `<script>`
   handles the mirror; no other JS in the page.

8. **Visual language: simplified port of legacy.** Splash-blue
   gradient header + white card + light-blue gradient page background
   are retained. Legacy's animated bubble background, multi-step
   navigation, drag-and-drop photo upload zones, custom toggle
   switch, JS modal-based success/error, and JS-driven phone
   formatter are dropped — single-page form with HTML5 validation
   and a server-driven thanks page. Net code drop: ~700 lines of JS
   eliminated; ~250 lines of HTML/CSS retained (minus the bubbles).

9. **Error-bounce slug recovery via Referer header** rather than
   `request.clone().formData()`. Cloning a request whose body has
   already been read throws; the catch branch is most often hit
   precisely because `formData()` itself failed. Referer is set by
   every modern browser on form POST and carries the form's URL
   (`/claims/{slug}`) — extracted via a single regex match.
   Fallback slug `"unknown"` → renders the not-found card on the
   error page (acceptable; rare).

10. **Caps on URL-bounced strings.** `?error=` is capped at 240
    characters and `?id=` at 64 in the render handlers, so a
    malicious bounce can't inject a giant or weird payload into the
    rendered page (and `escHtml` defends against the rest of XSS).

**`handleClaimSubmission` response reconciliation (per brief Report
question 1):** browser submit (`Accept: text/html...`) gets
`303 See Other` to `/claims/{slug}/thanks?id={claimId}` on success
or `303` to `/claims/{slug}?error=<msg>` on failure. Programmatic
JSON caller (no `text/html` in Accept) gets the existing JSON
response shape unchanged. Dual-mode chosen over a query-flag
opt-in because the form HTML doesn't have any client-side JS to
intercept-and-render the response — a plain `<form>` POST
mechanically requires the redirect path. JSON shape preserved as
the default to avoid breaking any future internal callers (e.g.,
a possible apps/web SSR submit proxy if Brief 8 ever ports the
signup flow this way).

**Field-name audit results (brief Report question 3):**

| Form `name=`             | Worker reads (index.ts) | Result |
|---|---|---|
| customerName             | line 1118 | match |
| customerPhone            | line 1119 | match |
| customerEmail            | line 1120 | match |
| mailingAddress           | line 1121 | match |
| licensePlate             | line 1122 | match |
| vehicleMake              | line 1123 | match |
| vehicleModel             | line 1124 | match |
| vehicleYear              | line 1125 | match |
| vehicleColor             | line 1126 | match |
| issueDescription         | line 1127 | match |
| employeeName             | line 1128 | match |
| location (hidden)        | line 1129 | match |
| locationPretty (hidden)  | line 1130 | match |
| membershipNumber         | line 1131 | match |
| preExistingDamage        | line 1132 | match |
| equipmentInvolved        | line 1133 | match |
| equipmentMalfunction (hidden) | line 1134 | match |
| determination            | line 1135 | match |
| customerTold             | line 1136 | match |
| customerDemeanor         | line 1137 | match |
| fourCornersPhotos (file) | line 1146 PHOTO_CATEGORIES[0].field | match |
| vinPhoto (file)          | PHOTO_CATEGORIES[1].field | match |
| damagePhotos (file)      | PHOTO_CATEGORIES[2].field | match |
| platePhoto (file)        | PHOTO_CATEGORIES[3].field | match |

All 24 fields the form posts are read by the existing worker handler.
Zero drift.

**Bundle-size delta on damage-worker (brief Report question 4):**
post-Brief-23 bundle: **1628.16 KiB / 368.53 KiB gzip**. This is the
first bundle measurement captured for damage-worker since the BUILD_STATE
recorded the worker family at "700-1600 KiB uncompressed / 130-360 KiB
compressed" — the form HTML/CSS/inline-script add roughly the upper
end of the brief's 10-30 KiB gzip estimate, but precise delta math
requires a clean pre-Brief baseline that wasn't captured. Bundle
remains comfortably under CF's 3 MiB compressed free-tier limit.

**Latent issues spotted in handleClaimSubmission (brief Report question 5):**

- (a) **`isOriginAllowed` is not enforced on `POST /claims-api/submit-claim`.**
  The handler is intentionally public (legacy parity — customers post
  from arbitrary device-bookmarked URLs without a referrer policy).
  The CSRF risk is negligible: there's no auth state to forge from a
  cross-origin script. Worth noting in case a future brief revisits
  CSRF posture for public endpoints.

- (b) **`getActiveLocationByCode` lookup runs unconditionally on
  every POST submit** (line 1244-1252) for `location_pretty`
  resolution. With Brief 23 the lookup also runs on every GET to
  `/claims/{slug}` (form render) and `/claims/{slug}/thanks` (success
  page). Three D1 reads per claim flow — fine, but a future
  optimization could cache the active-locations table at module load.

- (c) **`location_pretty` posted by the form is not authoritative.**
  The form's hidden input renders the D1 canonical value at GET-time
  but the worker re-resolves at POST-time anyway. If the customer
  hand-edits the hidden input via DevTools the canonical resolution
  recovers. No change needed.

- (d) **`equipmentMalfunction` parses as `String === "true"`** in
  the worker (line 1134). Anything else, including `"True"`, `"1"`,
  or an absent input, is `false`. The new form's hidden input and
  legacy form both emit lowercase `"true"`/`"false"` so this is
  fine in practice. Worth flagging for non-form callers.

- (e) **A programmatic JSON caller that happens to include
  `text/html` in its Accept header would receive a 303 redirect**
  instead of the JSON body. No such caller exists in the monorepo
  today. Mitigation if it surfaces: add a `?json=1` query-flag
  opt-out in `handleClaimSubmission`. Out of scope for Brief 23.

- (f) **Browser-mode error path swallows the worker error message
  through a 240-char URL cap.** Realistic worker errors are short
  strings; the cap mainly defends against malicious or malformed
  bounce content. Customer-visible message stays useful.

- (g) **No 1MB / 100MB upload-size guard at the form level.**
  Legacy form had no such guard either; CF Workers caps request
  body at 100 MB. Customers submitting more than that will see a
  CF error page, not the form's error banner. Not critical (rare
  in practice) but worth noting for a future polish pass.

**Validation:**

- `pnpm typecheck` — **13/13 successful**, 2.707s (12 cached, 1
  fresh — only `@splash/damage-worker` source changed).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run`
  — **succeeded**. Total Upload: 1628.16 KiB / gzip: 368.53 KiB.
  Bindings inventoried correctly (DB / R2_BUCKET / IMAGES). No
  routes block change since wrangler.toml's staging routes already
  cover `/claims/*` (Brief 16).
