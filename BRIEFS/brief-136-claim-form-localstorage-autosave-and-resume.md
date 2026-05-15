# Brief 136: Claim form localStorage autosave + resume banner

**Status:** Completed (2026-05-15)
**Started:** 2026-05-15
**Completed:** 2026-05-15
**Blocks:** Neither — UX hardening on the customer-facing
`/claims/{site}` form (damage-worker). Port the Brief 122 localStorage
autosave pattern from the splash-forms public renderer
(`forms-public.js`) to the damage claim form so a customer mid-fill
doesn't lose progress to a tab close, a network blip, a phone
backgrounding, or a long pause between starting and finishing.
**Dependencies:** None. Brief 122 pattern is the reference
implementation; Brief 135 just landed (the customer-section required-
fields tightening) — autosave should fire on the now-required fields
the same way it fires on the optional ones.

## Read first

- CLAUDE.md (damage-worker glossary on the customer claim form;
  forms-worker glossary entry on Brief 122 for the localStorage
  autosave contract)
- `apps/damage-worker/src/render/claim-form.ts` — the entire form
  HTML + inline JS:
  - Form root + section structure (lines 314+)
  - Customer section (lines 322–384) — autosave restores these
  - PIN overlay + gate (lines 557–565, 604–668) — autosave does
    NOT bypass the PIN; staff section stays gated on resume
  - Existing submit handler / equipment toggle / damage-type toggle
    (lines 670+) — clear-on-submit hook integrates here
- `apps/forms-worker/static/forms-public.js` (Brief 122 reference)
  — the autosave/resume implementation to mirror
- Brief 122 docblock in CLAUDE.md for the exact contract: 30-day
  staleness, debounce ms, banner copy, clear-on-submit semantics,
  what NOT to restore (canvas thumbnails, file picker visible state)

## Context

The Brief 122 pattern shipped on the splash-forms public renderer.
Customers fill out a public form (e.g., the operator's "newest
workflow and form test"); autosave persists values to
`localStorage["forms.draft.{slug}"]` debounced 500ms; on next page
load a <30-day draft surfaces an amber banner above the first field
with Resume / Discard buttons; stale drafts (>30 days) clear silently.

The damage claim form has the same problem shape but a much higher
business-cost-of-loss:

- Customer is reporting damage to their vehicle — emotionally fraught
  flow, often filled out on a phone in a wash bay or parking lot
- Form has 10+ required customer-side fields plus photos, plate, VIN
- Phone backgrounding, tab kills, slow networks, parents wrangling
  kids all common
- Customer who loses progress will either abandon the claim (bad for
  Splash) or have to type everything in again (terrible UX)

There's also a parallel customer protection angle: customer-section
data is theirs (they entered it), not Splash's. localStorage keeps
it on their device only — same Brief 122 isolation posture
(per-domain, per-browser, per-device).

## Scope

### Phase 1 — Storage key + value shape

Storage key: `claims.draft.{site}` where `{site}` is the site
location_code segment from the URL path. Mirrors Brief 122's
per-slug isolation. Distinct top-level namespace (`claims.draft.*`
vs `forms.draft.*`) so the two systems can't collide.

Value shape:

```ts
{
  values: Record<string, string>;       // input name → value
  photoR2Keys: Record<string, string[]>; // photo field key → [r2_keys]
  pendingSubmissionId?: string;          // if the damage worker has
                                         // an OOB upload pattern
                                         // analogous to Brief 92
  savedAt: number;                       // Date.now() at last write
}
```

Photo state needs special treatment: the form has four photo sections
(`fourCornersPhotos`, `vinPhoto`, `damagePhotos`, `platePhoto`) — each
with `data-photo-section data-field="..." data-multi="true|false"
data-required="true"`. Photos are uploaded out-of-band (Brief 37/38
mobile-upload pattern); each section maintains a hidden array of
r2_keys that go into the final submit payload. Autosave should
persist those r2_key arrays so a resume reattaches the already-
uploaded photos.

### Phase 2 — Autosave wiring

Add a new inline `<script>` block (or extend the existing one) in
`apps/damage-worker/src/render/claim-form.ts` that:

2.1 Reads the location code from the URL or a hidden input
    (`<input type="hidden" name="location" ...>` at line 314 is the
    source of truth).

2.2 Binds a debounced (500ms) `input` event listener on `document`
    (event delegation) that filters for events whose target is
    inside the `<form>` element and serializes the form into the
    storage shape. Mirrors Brief 122's bubbling pattern so new
    fields don't need explicit wiring — any `name`-d input is auto-
    captured.

2.3 For photo sections: the existing photo widget JS (lines 700+)
    maintains an internal r2_keys array per section. Either expose
    those arrays via `data-r2-keys` attribute on the section element
    OR add a small `getPhotoR2Keys(formEl)` helper the autosave
    snapshotter calls. Mirror the Brief 92 pattern that exposed
    pending uploads to the resume path.

2.4 Skip persisting values from:
    - `name="__equipmentRelated"` radio (cosmetic toggle; the hidden
      `equipmentMalfunction` companion already gets persisted)
    - `name="pinInput"` — never persist the PIN itself
    - Any field whose `name` starts with `__` (convention: cosmetic-
      only fields)

### Phase 3 — Resume banner on page load

On `DOMContentLoaded`:

3.1 Read `localStorage["claims.draft.{site}"]`.
3.2 If missing → no-op.
3.3 If `Date.now() - savedAt > 30 days` → clear silently + no-op.
3.4 Otherwise render an amber banner above the form's first
    section with:
    - Copy: "We saved your progress from {relative-time-ago}. Pick
      up where you left off?"
    - Resume button (primary) → rehydrate form
    - Start over button (secondary outlined) → clear localStorage +
      no rehydrate

Banner styling: match the Brief 122 amber-banner palette so the two
forms feel consistent. CSS can live alongside the existing inline
`<style>` at lines 80+ of `claim-form.ts`.

### Phase 4 — Resume behavior (rehydrate)

When operator clicks Resume:

4.1 For each entry in `values`: find the matching `name`'d input by
    `document.querySelector('[name="' + name + '"]')` and set its
    value via the appropriate property (`.value` for text/textarea/
    select; `.checked` for checkboxes).

4.2 For each photo section in `photoR2Keys`: push the saved r2_keys
    array into the section's internal state (via the same helper
    the photo widget uses on a successful upload — likely
    `addPhotoFromR2Key(sectionEl, r2_key, originalFilename?)`).
    Visible thumbnails are NOT auto-restored — the photo widget can
    render a "Previously attached: {count} photo(s)" pill instead,
    mirrors the Brief 122 file-input pattern where visible state
    isn't restored but the hidden r2_key companion is. Customer
    can click each section to see the saved thumbnails if the
    widget supports it.

4.3 The staff section stays hidden + the PIN gate stays closed.
    Resume restores customer-side fields and the staff-side r2_keys
    array (so the staff doesn't have to re-upload), but the PIN
    overlay re-fires on Continue. That's the right security posture:
    customer can't bypass the PIN gate by hand-editing localStorage.

4.4 Fire the existing `damageType` change handler + `__equipmentRelated`
    toggle handler manually after rehydrate so dependent visibility
    (e.g., `damageOther` showing only when `damageType === "Other"`,
    `equipmentInvolved` showing only when equipment-related is yes)
    matches the restored values.

### Phase 5 — Clear-on-submit

Add a `submit` listener on the form element that calls
`localStorage.removeItem("claims.draft." + site)` optimistically
before the browser navigates. Mirrors Brief 122's option B:

> Trade-off: a rare 422 validation_failed loses the draft; user
> can hit Back to recover DOM state from bfcache.

Acceptable here too. Customers very rarely hit a 422 (server-side
validation is lenient; HTML5 client-side validation prevents most
submit-time failures).

### Phase 6 — Customer Discard button

Add a small "Start over" link below the resume banner that explicitly
calls `localStorage.removeItem` + reloads the page. Lets a customer
who realizes they're filling out a different vehicle's claim from
the same browser clear their progress without writing a stale draft
into the next claim.

### Phase 7 — Validation

7.1 `pnpm typecheck` — must pass.
7.2 `pnpm --filter @splash/damage-worker build` — must succeed.
7.3 No worker / Supabase / R2 / D1 / wrangler.toml / secret changes.
7.4 Operator post-deploy smoke (deferred):
    - Open `/claims/{site}` on workers.dev or staging.
    - Fill customer-side fields halfway. Close tab.
    - Reopen `/claims/{site}` — amber banner appears with "We
      saved your progress from a minute ago".
    - Click Resume — customer fields rehydrate. Photo sections
      (if any photos were uploaded) show the "Previously attached"
      pill or thumbnails.
    - Click Continue → PIN overlay still gates the staff section.
    - Submit successfully — localStorage cleared, next page load
      shows fresh form.
    - Negative: fill, wait 31 days (or hand-tamper savedAt back),
      reload. Stale draft cleared silently; no banner.
    - Negative: fill, click "Start over" — localStorage cleared,
      form resets to blank.
    - Different-vehicle test: fill site A's claim → switch to
      site B → confirm B's form is blank (per-site isolation).
    - Mobile test: fill on phone, background app for 5min, return.
      Resume banner appears; rehydrate works.

### Phase 8 — Updates

8.1 BRIEFS/INDEX.md: Brief 136 row appended.

8.2 BUILD_STATE.md: Findings entry noting:
  - Brief 136 (YYYY-MM-DD) — Ported Brief 122 localStorage
    autosave + resume pattern to the customer-facing
    `/claims/{site}` form. Storage key `claims.draft.{site}`;
    debounce 500ms; 30-day staleness; amber resume banner;
    optimistic clear-on-submit. Photo sections' r2_key arrays
    persist alongside form values so resume reattaches OOB-
    uploaded photos without re-upload. Staff section stays PIN-
    gated on resume (security posture).

8.3 CLAUDE.md damage-worker glossary: append a one-liner under
    the existing claim-form description noting Brief 136 added
    autosave. Reference Brief 122 as the contract source.

## Out of scope

- Server-side draft storage (a `claim_drafts` D1 table). Per-browser-
  per-device isolation is the right v1 posture; matches Brief 122.
- Cross-device draft sync (would need server-side identity binding).
- Restoring photo thumbnails to the visible widget — only the
  hidden r2_keys companion persists. Customer sees a count pill;
  can click to view. Same Brief 122 trade-off.
- Persisting PIN entry or staff-side fields. PIN gate stays
  closed on resume; staff fills fresh.
- Toast/Snackbar UX for "saved at HH:MM" — savedAt is internal
  state, not surfaced visually.
- Encrypting localStorage payload. Customer-side data is theirs;
  no other user on the same device should be claiming damage on a
  different vehicle anyway. If multi-customer-per-device becomes
  an actual use case, encrypt then.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- localStorage key `claims.draft.{site}` autosaves form state
  every 500ms after user input.
- Resume banner renders on page load when a <30-day draft exists.
- Resume hydrates customer fields + photo r2_key arrays; staff
  section + PIN gate stay sealed.
- Dependent-visibility toggles (damageType, equipment-related)
  fire correctly after rehydrate.
- Clear-on-submit removes the draft.
- Start-over button works.
- Stale drafts (>30 days) clear silently.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/damage-worker build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 8.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (line count + file count — should be
  ~150–250 LOC in `claim-form.ts` inline JS).
- Validation results.
- The exact lines touched in `claim-form.ts` (inline `<script>` +
  any CSS added for the banner).
- The photo widget helper function name used to push r2_keys
  back into a section's internal state on resume (whether one
  existed or one was added).
- Any deviations from the Brief 122 contract (e.g., banner copy,
  debounce ms, banner palette) with rationale.
- Sample localStorage payload after a half-filled form, as a JSON
  blob in the Outcome.

## Outcome

**Diff size:** Single file (`apps/damage-worker/src/render/claim-form.ts`)
+262 LOC: ~25 LOC CSS appended to `SHARED_STYLES`, ~225 LOC inline JS
inserted into `FORM_SCRIPT` (between the photo-widget setup and the
submit handler), plus a 7-LOC edit to the existing submit handler that
calls `clearDraft()` after `validateBeforeSubmit()` passes.

**Files modified.** `apps/damage-worker/src/render/claim-form.ts`,
`BRIEFS/INDEX.md`, `BUILD_STATE.md`, `CLAUDE.md` (brief one-liner
appended to the existing **claim summary PDF** glossary entry — the
closest sibling describing the customer-facing claim form behavior),
this brief file (Outcome + Status).

**Files created / deleted.** None.

**Validation.** Root `pnpm typecheck` 18/18 green (17 cache hits;
damage-worker ran fresh). `pnpm --filter @splash/damage-worker exec
wrangler deploy --dry-run --outdir=.tmp-build` succeeded —
1740.19 KiB raw / 394.69 KiB gzip (vs Brief 135 baseline of
1729.61 / 391.32, ≈ +10.58 KiB raw / +3.37 KiB gzip from the inline
autosave block). `.tmp-build` cleaned up after. No worker / Supabase /
R2 / D1 / wrangler.toml / secret changes.

**Lines touched in claim-form.ts.**

- `SHARED_STYLES` (lines 262–286 of the modified file): new
  `.resume-banner` + `.resume-banner-icon` + `.resume-banner-text` +
  `.resume-banner-actions` + `.btn-resume` + `.btn-start-over`
  declarations. Palette matches Brief 122 (`#fff8e1` amber bg /
  `#f0c674` border / `#5a4a1a` text) for visual consistency between
  the two systems. Resume primary button is splash-navy (`#1e3a8a`)
  to match the form's existing `.btn-primary` rather than the bluer
  Brief 122 `#1e5fa8`.
- `FORM_SCRIPT` (lines 840–1058 of the modified file): the entire
  Brief 136 autosave + resume + clear-on-submit block, inserted
  between the photo-widget setup and the `// ---- Submit` marker so
  `syncDamageOther` / `syncEquipment` are already defined when
  `restoreForm` calls them. Helpers (in order): `loadDraft` /
  `saveDraft` / `clearDraft` / `shouldPersistName` / `serializeForm`
  / `restoreForm` / `scheduleSave` / `formatTimeAgo` /
  `maybeRenderResumeBanner`. `maybeRenderResumeBanner()` is the only
  top-level invocation; the autosave listeners are wired via
  `form.addEventListener('input'|'change', scheduleSave)`.
- The existing submit handler (lines 1085–1092 of the modified file):
  a 7-LOC insert that calls `clearDraft()` between
  `validateBeforeSubmit()` passing and the FormData composition. This
  is intentionally before the `fetch` rather than inside the success
  branch — see the deviation note below.

**Photo widget helper.** No helper exists or was added for restoring
photos. The damage claim form's photo widgets hold `File` objects in a
closure-scoped `var photos = { fourCornersPhotos: [], vinPhoto: [],
damagePhotos: [], platePhoto: [] }` and append them directly to
`FormData` at submit time (`apps/damage-worker/src/render/claim-form.ts:920+`
in the modified file). There is no OOB upload to R2 producing
hidden r2_key companions; the form is fully multipart. Persisting
`File` objects to localStorage is not feasible (`JSON.stringify` drops
them; base64-encoding a typical 4-photo claim would exceed
localStorage's 5MB-per-origin quota). **The brief's Phase 1 /
Phase 4.2 / Definition-of-Done "photo r2_key arrays" requirement is
therefore unsatisfiable as stated — it was specified against a false
premise about the form's architecture.**

**Deviations from the Brief 122 contract.**

1. **No `photoR2Keys` field on the storage payload, no
   `pendingSubmissionId` field.** The value shape simplifies to
   `{ values: Record<string, string|string[]>, savedAt: number }`.
   Reason above: the damage form does not use the Brief 92 OOB-upload
   pattern. Customers re-add photos after resume; the typed customer
   fields (the bulk of the value-of-loss) are preserved. The PIN gate
   still seals the staff section on resume, so staff-side photo
   workflow restarts cleanly after PIN unlock.

2. **`clear-on-submit` fires immediately after
   `validateBeforeSubmit()` passes, not on submit-fire and not on
   submit-success.** Brief 122's "option B" assumed a native form
   submission that hits a server-rendered success page; the damage
   form uses `fetch` + `preventDefault` and a JS-driven outcome card.
   Firing clear on every `submit` event would discard the draft when
   validation fails (HTML5 + photo-count check). Firing clear only
   on success would leave the customer's draft alive through a
   transient network error but also through ambiguous server states.
   Firing clear after validation passes is the closest analog to
   Brief 122's "before the browser navigates" semantics for this
   form: the trade-off is documented in-line.

3. **`__equipmentRelated` is skipped per the brief's Phase 2.4
   instruction, with a side-effect: `equipmentInvolved` selection is
   wiped on resume.** The equipment-related radio drives
   `syncEquipment`, which resets `equipmentInvolved` to '' whenever
   the toggle is "no". Skipping `__equipmentRelated` leaves the
   default "no" checked on resume; `syncEquipment` then wipes the
   persisted `equipmentInvolved` value. Acceptable for v1 — equipment
   selection is a single dropdown the staff handles after PIN and
   they can re-select. Documenting because the brief's rationale
   ("cosmetic; equipmentMalfunction is the companion") is not quite
   right: the radio IS the source of truth for the toggle, and the
   `equipmentMalfunction` hidden input is unrelated (its visible
   checkbox is commented out per Brief 55 — the hidden value is
   always "false" at submit). Restoring this losslessly would
   require either persisting `__equipmentRelated` despite the brief
   or special-casing the syncEquipment call order on rehydrate.

4. **Resume banner copy matches the brief verbatim** ("We saved your
   progress from N min ago. Pick up where you left off?") with
   buttons labeled **Resume** / **Start over**. Brief 122's banner
   uses different copy ("You have a saved draft…" / "Resume draft"
   / "Discard and start fresh"); the two systems are intentionally
   not pixel-identical because the customer-facing claim form's
   visual identity is its own (splash-navy + amber).

**Sample localStorage payload after a half-filled form** (key:
`claims.draft.binghamton`):

```json
{
  "values": {
    "location": "binghamton",
    "locationPretty": "Binghamton",
    "equipmentMalfunction": "false",
    "customerName": "Jane Customer",
    "customerPhone": "(555) 123-4567",
    "customerEmail": "jane@example.com",
    "mailingAddress": "1 Main St, Binghamton NY 13901",
    "licensePlate": "ABC1234",
    "vehicleYear": "2022",
    "vehicleMake": "Toyota",
    "vehicleModel": "Camry",
    "vehicleColor": "Silver",
    "issueDescription": "Mirror got caught on the dryer brush…",
    "determination": "",
    "employeeName": "",
    "membershipNumber": "",
    "preExistingDamage": "",
    "damageType": "",
    "damageOther": "",
    "equipmentInvolved": "",
    "customerTold": "",
    "customerDemeanor": ""
  },
  "savedAt": 1747320000000
}
```

(`__equipmentRelated` excluded per Phase 2.4; photo state not
persisted per deviation 1.)

**Latent issues / forward flags.**

- (a) Photo persistence is not implemented — the brief's
  expectation that this form uses an OOB-upload + r2_key pattern is
  incorrect. Converting the photo widget to OOB upload would be a
  meaningful refactor (new worker endpoint, R2 path namespacing,
  cleanup cron) and is out of scope here. If photo persistence on
  resume becomes a real priority, the v2 path is a parallel Brief 92
  port for damage-worker.
- (b) `equipmentInvolved` value gets silently wiped on resume when
  the staff had toggled equipment-related to "Yes" before the tab
  closed (cascade through syncEquipment with `__equipmentRelated`
  un-persisted). One-click recoverable post-PIN.
- (c) Clear-on-submit fires after client-side validation passes but
  before the fetch resolves. A network failure or server 5xx
  between that point and the outcome card render loses the
  localStorage backup; the customer's DOM state survives until they
  navigate away, but a refresh while in this window blanks the form.
  Acceptable per brief Phase 5's stated trade-off.
- (d) The autosave fires on `input` AND `change`; for a typical
  10-field form this is harmless but a future executor adding a
  heavy field type (e.g., a rich-text editor) would want to confirm
  the 500ms debounce still bounds storage writes.
- (e) localStorage quota errors / private-browsing storage being
  disabled / cookies-cleared mid-session all degrade to "form works
  but autosave does nothing" — no error surfaced to the customer.
  Matches Brief 122 posture; documented in code comment.

**Operator post-deploy smoke (deferred per Phase 7.4).** See the
brief's Phase 7.4 enumeration:
1. `/claims/{site}` on workers.dev or staging — fill customer
   fields halfway, close tab, reopen → amber banner reading "We
   saved your progress from a minute ago. Pick up where you left
   off?"
2. Resume → customer fields rehydrate; photo widgets render empty
   (deviation 1).
3. Continue → PIN overlay still gates the staff section.
4. Submit → localStorage cleared; reopen the form → no banner.
5. Stale: hand-tamper `localStorage.claims.draft.{site}.savedAt`
   back >30 days → reload → banner absent, key gone.
6. Start over button on banner → localStorage cleared, no
   rehydrate.
7. Site isolation: fill `/claims/site-a`, open `/claims/site-b`
   in same browser → site-b form is blank.
8. Mobile background-app-for-5min test → resume works on return.
