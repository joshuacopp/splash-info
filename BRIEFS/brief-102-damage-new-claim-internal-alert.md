# Brief 102: New-claim internal notification — rm/site/am/incidents alert with PDF + photo links

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither (fully additive; fail-soft when webhook unbound)
**Dependencies:** Brief 32 (`CUSTOMER_CLAIM_WEBHOOK_URL` pattern this
brief parallels; same `handleClaimSubmission` post-submit block),
Brief 48 (added `site_email` lookup against pricing_simple; this brief
extends the same helper to also return `am_email`), Brief 49 (the
`pricing_simple`-as-source-of-truth read path), Brief 101 (introduced
`apps/damage-worker/src/notifications.ts` and extended
`getLocationContactInfo` to return `rm_email` — this brief widens the
same helper one more step).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-032-claim-summary-pdf-and-customer-email.md (parallel
  webhook in the same handler — same fail-soft posture, same R2 PDF
  payload pattern, same 4 MB base64 ceiling)
- BRIEFS/brief-048-customer-webhook-add-site-email.md (added
  `site_email` to the contact helper)
- BRIEFS/brief-049-getlocationcontactinfo-read-from-pricing-simple.md
  (the read path; reminder that pricing_simple is the trigger-synced
  denormalization of `locations` — `am_email` lives on both)
- BRIEFS/brief-101-damage-manage-update-notifications.md (this
  brief depends on Brief 101 having widened the helper to include
  `rm_email`; this brief widens it once more)
- apps/damage-worker/src/index.ts (`handleClaimSubmission` ~L2277,
  the post-submit PDF block ~L2700-2751 — this brief adds a parallel
  internal-webhook fire next to the existing customer-webhook fire)
- apps/damage-worker/src/notifications.ts (new module from Brief 101;
  reuse the fire-helper pattern for the new internal webhook)
- packages/db-supabase/src/locations.ts (`getLocationContactInfo` —
  widen the return shape one more time)

## Context

Today, when a customer submits a damage claim, the damage-worker
generates a customer-facing PDF, stores it in R2, and (when
`CUSTOMER_CLAIM_WEBHOOK_URL` is bound) POSTs Power Automate a payload
so PA emails the customer a confirmation with the PDF attached.

Operator wants a parallel **internal** notification: PA-side fan-out
to the location's RM, GM (site_email), AM (Regional Director), and a
shared incidents inbox. Same PDF available (URL + base64-when-small),
plus photo URLs for the photos the customer uploaded with the claim.

**Two webhooks, not one.** This brief adds a separate secret
`INTERNAL_NEW_CLAIM_WEBHOOK_URL` instead of multiplexing through the
existing customer webhook. Reasons:

- The PA email templates are very different (customer apology vs.
  internal heads-up with action link). Separate flows are easier to
  edit and disable independently.
- Failure of the internal flow cannot affect the customer flow and
  vice versa.
- Mirrors the convention established by Brief 65's
  `DAILY_SUMMARY_WEBHOOK_URL` — one secret per PA flow.

**Recipients.** Four roles per location, plus a configurable
incidents address:

| Source | Resolved from | Notes |
|--------|---------------|-------|
| `rm_email` | `pricing_simple.rm_email` | Regional Manager |
| `site_email` | `pricing_simple.site_email` | GM / on-site inbox |
| `am_email` | `pricing_simple.am_email` | Regional Director (label divergence — see CLAUDE.md) |
| `incidents_email` | `[vars] INCIDENTS_EMAIL` on damage-worker | Operator-configured constant; same value across all locations |

Recipients are resolved server-side and shipped in a `recipients[]`
array; PA loops over the array to send emails. Empty entries (e.g.,
location has no `am_email` set) are dropped server-side so PA doesn't
attempt to send to `null`. **No actor exclusion** — the claim
submitter is the public customer; their email is not a contact on
the location.

**PDF availability.** The existing
`buildAndStoreClaimSummaryPdf` already runs in the post-submit
pipeline (Brief 32) and lands the PDF in R2 at
`claims/<claimId>/summary.pdf`. This brief reuses both `pdfBytes`
(for the base64 attachment when ≤ 4 MB) and the same
`summary_pdf_url` (the public `/claims-api/summary/<claimId>` serve
route) the customer webhook already uses. No duplicate PDF
generation.

**Photo URLs.** Each row in `claim_photos` for the freshly-inserted
claim is exposed via the existing public photo serve route
`/claims-api/photo/<r2-key>`. Brief 102's payload includes a
`photos[]` array of `{url, mime, original_filename, photo_type}` so
PA can either render thumbnails inline or attach. At submission
time, only `Damage` photos exist (Quote / Receipt come later from
the manage page), but the brief queries `claim_photos` rather than
filtering by type so future expansions are no-effort. Photos are
listed server-side from D1 right after the insert.

**Admin link.** Same `admin_url` field as Brief 101:
`${APPS_WEB_BASE_URL}/admin/damage/{claim_id}`. Recipients click
through to the detail page.

## Scope

### Phase 1 — `packages/db-supabase/locations.ts` — third widening

1.1 Extend `getLocationContactInfo` to also return `am_email`:

```ts
export async function getLocationContactInfo(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<{
  site_email: string | null;
  rm_email: string | null;
  am_email: string | null;
}>
```

  - PostgREST select becomes `select=site_email,rm_email,am_email`.
  - Existing fail-soft branches return all three nulls.
  - Brief 101's call sites still work (read `site_email` and
    `rm_email`; ignore the additional `am_email`).
  - Brief 32's call site still works (reads `site_email` only).

1.2 No rename. Helper name and module placement unchanged.

### Phase 2 — Damage-worker — internal webhook helper

2.1 In `apps/damage-worker/src/notifications.ts` (the module Brief
101 introduced), add:

```ts
export interface ClaimPhotoForWebhook {
  url: string;
  mime: string | null;
  original_filename: string | null;
  photo_type: string | null;     // 'Damage' | 'Quote' | 'Receipt' | …
  uploaded_at: string;
}

export interface InternalNewClaimPayload {
  claim_id: string;
  submitted_at: string;
  location_code: string;
  location_pretty: string | null;
  admin_url: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  vehicle: string;                // year/make/model/color assembled
  damage_type: string;
  damage_other: string | null;
  issue_description: string | null;
  recipients: string[];
  // Audit / debug: which addresses were the source.
  candidates: {
    rm_email: string | null;
    site_email: string | null;
    am_email: string | null;
    incidents_email: string | null;
  };
  summary_pdf_url: string;
  // Omitted when PDF > 4 MB raw — same ceiling as the customer
  // webhook's CUSTOMER_WEBHOOK_BASE64_MAX_BYTES (~3 MB raw after
  // base64 expansion).
  summary_pdf_base64?: string;
  photos: ClaimPhotoForWebhook[];
}

export async function fireInternalNewClaimWebhook(
  webhookUrl: string,
  payload: InternalNewClaimPayload
): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      console.error(
        `[internal-new-claim] POST failed for ${payload.claim_id}: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(
      `[internal-new-claim] POST error for ${payload.claim_id}:`,
      err
    );
  }
}

export function resolveInternalRecipients(
  contacts: {
    rm_email: string | null;
    site_email: string | null;
    am_email: string | null;
  },
  incidentsEmail: string | null
): string[] {
  const out: string[] = [];
  const push = (addr: string | null | undefined) => {
    if (!addr) return;
    const norm = addr.trim().toLowerCase();
    if (!norm) return;
    if (!out.includes(norm)) out.push(norm);
  };
  push(contacts.rm_email);
  push(contacts.site_email);
  push(contacts.am_email);
  push(incidentsEmail);
  return out;
}
```

  - No actor-exclusion variant; customer is not a contact.

2.2 In `apps/damage-worker/src/index.ts`:

  - Add to the `Env` interface:
    - `INTERNAL_NEW_CLAIM_WEBHOOK_URL?: string` (secret)
    - `INCIDENTS_EMAIL?: string` (`[vars]` entry)
  - Import the new helpers from `./notifications`.

2.3 Append to the `[vars]` block in
`apps/damage-worker/wrangler.toml`:

```toml
# Brief 102 (YYYY-MM-DD): incidents inbox copied on every new
# customer claim submission via INTERNAL_NEW_CLAIM_WEBHOOK_URL.
# Edit this value to change the recipient; no secret rotation
# required because it's not sensitive.
INCIDENTS_EMAIL = "incidents@splashcarwashes.com"
```

  Replace the address with whatever the operator confirms during
  the brief (the value above is a placeholder for the executor to
  flag in the outcome — operator confirms or amends before
  push).

2.4 In `handleClaimSubmission` (`apps/damage-worker/src/index.ts`),
inside the existing Brief 32 post-submit block (~L2700-2751), AFTER
the customer webhook fire and BEFORE the catch:

```ts
// Brief 102 — internal new-claim notification. Parallel webhook to
// the customer-email path. Fail-soft when secret unbound, on
// contact-lookup throw, and on photo-list throw. Reuses pdfBytes
// from above.
if (env.INTERNAL_NEW_CLAIM_WEBHOOK_URL && pdfBytes) {
  try {
    await fireInternalNewClaimNotification({
      env,
      pdfBytes,
      summaryPdfUrl,
      claimData,
      requestUrl
    });
  } catch (notifyErr) {
    console.error(
      `[internal-new-claim] pipeline failed for ${claimData.claimId}:`,
      notifyErr
    );
  }
}
```

  - `summaryPdfUrl` is the same variable the customer webhook uses
    (already declared at L2705).
  - Wrapped in its own try/catch as defense-in-depth even though
    the inner helpers swallow their own errors.

2.5 `fireInternalNewClaimNotification` body (new local function in
index.ts, placed near `fireCustomerClaimWebhook` ~L3195):

```ts
async function fireInternalNewClaimNotification(args: {
  env: Env;
  pdfBytes: Uint8Array;
  summaryPdfUrl: string;
  claimData: ClaimSubmissionPayload;
  requestUrl: URL;
}): Promise<void> {
  const { env, pdfBytes, summaryPdfUrl, claimData, requestUrl } = args;
  if (!env.INTERNAL_NEW_CLAIM_WEBHOOK_URL) return;

  // Contacts. Fail-soft: any throw collapses to all-nulls.
  let contacts: {
    site_email: string | null;
    rm_email: string | null;
    am_email: string | null;
  } = { site_email: null, rm_email: null, am_email: null };
  try {
    contacts = await getLocationContactInfo(env, claimData.location);
  } catch (err) {
    console.warn(
      `[internal-new-claim] contact lookup threw for ${claimData.location}`,
      err
    );
  }

  const incidents = (env.INCIDENTS_EMAIL ?? "").trim();
  const recipients = resolveInternalRecipients(
    contacts,
    incidents || null
  );

  // Photos. Fail-soft: lookup throw or empty list → photos: [].
  let photos: ClaimPhotoForWebhook[] = [];
  try {
    const rows = await listPhotosForClaim(env.DB, claimData.claimId);
    const baseOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
    photos = rows
      .filter((p) => !p.deleted_at && p.r2_key)
      .map((p) => ({
        url: `${baseOrigin}/claims-api/photo/${p.r2_key}`,
        mime: p.mime ?? null,
        original_filename: p.original_filename ?? null,
        photo_type: p.photo_type ?? null,
        uploaded_at: p.uploaded_at
      }));
  } catch (err) {
    console.warn(
      `[internal-new-claim] photo list threw for ${claimData.claimId}`,
      err
    );
  }

  const vehicleParts = [
    claimData.vehicleYear,
    claimData.vehicleMake,
    claimData.vehicleModel
  ].filter((p) => (p ?? "").toString().trim());
  let vehicle = vehicleParts.join(" ");
  if (claimData.vehicleColor && claimData.vehicleColor.trim()) {
    vehicle = vehicle
      ? `${vehicle} - ${claimData.vehicleColor.trim()}`
      : claimData.vehicleColor.trim();
  }

  const includeBase64 = pdfBytes.byteLength <= CUSTOMER_WEBHOOK_BASE64_MAX_BYTES;

  const payload: InternalNewClaimPayload = {
    claim_id: claimData.claimId,
    submitted_at: claimData.submittedAt,
    location_code: claimData.location,
    location_pretty: claimData.locationPretty || null,
    admin_url: `${buildAdminBase(env)}/admin/damage/${encodeURIComponent(claimData.claimId)}`,
    customer_name: claimData.customerName,
    customer_email: claimData.customerEmail,
    customer_phone: claimData.customerPhone || null,
    vehicle: vehicle || "—",
    damage_type: claimData.damageType,
    damage_other: claimData.damageOther || null,
    issue_description: claimData.issueDescription || null,
    recipients,
    candidates: {
      rm_email: contacts.rm_email,
      site_email: contacts.site_email,
      am_email: contacts.am_email,
      incidents_email: incidents || null
    },
    summary_pdf_url: summaryPdfUrl,
    ...(includeBase64 ? { summary_pdf_base64: bytesToBase64(pdfBytes) } : {}),
    photos
  };

  await fireInternalNewClaimWebhook(env.INTERNAL_NEW_CLAIM_WEBHOOK_URL, payload);
}
```

  - Reuses `CUSTOMER_WEBHOOK_BASE64_MAX_BYTES` constant from index.ts
    (~L196).
  - Reuses `bytesToBase64`, `listPhotosForClaim`, `buildAdminBase`
    (the latter added in Brief 101).
  - Photo URLs assemble against the request's origin (so dev /
    staging / production all work without a per-env hardcode) —
    same pattern Brief 32 uses for `summaryPdfUrl`.
  - The Brief 32 customer-webhook block already lives inside a
    `try { ... } catch (pdfErr) { ... }` that swallows all errors;
    this new fire sits inside that same try, so the existing
    catch is the outer safety net.

2.6 No schema change. No D1 migration. No Supabase column add.

### Phase 3 — Power Automate flow (operator-side, out-of-code)

3.1 Operator creates a new PA flow:
  - Trigger: HTTP request received
  - Schema via "Use sample payload to generate schema" — sample
    payload provided in this brief's outcome
  - Apply to each: loop `triggerBody()?['recipients']`
  - Action: Send an email (V2)
    - To: current item
    - Subject: "New damage claim at {location_pretty} — {customer_name}"
    - Body (HTML):
      - Customer details: name, email, phone
      - Vehicle line
      - Damage type + description
      - "View claim in Splash admin" button → `admin_url`
      - PDF attachment from `summary_pdf_base64` when present, or a
        "Download summary PDF" link to `summary_pdf_url` when not
      - Photo thumbnails (or links) from `photos[]`
  - Save the trigger URL. Bind as `INTERNAL_NEW_CLAIM_WEBHOOK_URL`
    via wrangler secret per the operator follow-up below.

3.2 Operator confirms or amends `INCIDENTS_EMAIL` before push.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all packages.
4.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
4.3 Local smoke (deferred to first post-deploy verification):
    - Submit a test claim via `/claims/{loc}` on workers.dev.
    - In CF Workers Logs, look for `[internal-new-claim]` log lines
      and verify the contact-lookup + photo-list succeeded.
    - Verify PA received the payload and the email rendered.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 102 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - New `INTERNAL_NEW_CLAIM_WEBHOOK_URL` secret on damage-worker
    fires a fail-soft internal notification on every customer
    claim submission, parallel to `CUSTOMER_CLAIM_WEBHOOK_URL`
  - Recipients: location's `rm_email`, `site_email`, `am_email`,
    plus the configurable `INCIDENTS_EMAIL` `[vars]` entry
  - Reuses the Brief 32 `pdfBytes` + `summaryPdfUrl` so there's
    no duplicate PDF generation
  - Photos collected from `claim_photos` immediately after the
    insert; URLs point at the existing `/claims-api/photo/` serve
    route
  - Same 4 MB PDF base64 ceiling as the customer webhook
  - Operator follow-up: confirm `INCIDENTS_EMAIL` value; build PA
    flow per Phase 3; `wrangler secret put
    INTERNAL_NEW_CLAIM_WEBHOOK_URL` after deploy

5.3 CLAUDE.md updates:
  - Glossary: add **INTERNAL_NEW_CLAIM_WEBHOOK_URL** and
    **INCIDENTS_EMAIL** entries
  - Bindings table for damage-worker: add the two new envs

5.4 PRE_DEPLOY_DAMAGE.md: append section documenting the new
secret + var, the recipient resolution, and the operator's
PA-flow setup steps. Mirror the layout of the existing
`CUSTOMER_CLAIM_WEBHOOK_URL` section.

## Configuration

| Name | Type | Required | Default | How to set |
|------|------|----------|---------|------------|
| `INTERNAL_NEW_CLAIM_WEBHOOK_URL` | secret | optional | unbound | `pnpm --filter @splash/damage-worker exec wrangler secret put INTERNAL_NEW_CLAIM_WEBHOOK_URL` after the worker deploys |
| `INCIDENTS_EMAIL` | `[vars]` | required to surface incidents in recipients | unbound | Edit `apps/damage-worker/wrangler.toml` `[vars]` block; operator confirms the address during the brief |

No new D1 columns. No Supabase column adds. No new tables.

## Out of scope

- Notifications when an internal user adds a claim from the admin
  side (today's customer-form is the only entry point; no internal
  add-claim flow exists). Re-evaluate when / if Brief X adds one.
- Per-recipient unsubscribe. PA can render an unsubscribe link, but
  the on/off is operator-controlled at the secret-bind level
  (unbind = nobody gets emailed).
- Routing to additional contacts based on damage type / equipment
  involvement. Today every internal new-claim email goes to the
  same four recipients. v2 could route equipment-related claims to
  facilities also.
- Splitting incidents into per-RM-group inboxes. Single shared
  `INCIDENTS_EMAIL` value for v1.
- Sending photos as actual email attachments (currently linked).
  Email attachments balloon size; PA can either link or attach via
  template — operator's choice in the PA flow, not in the worker.
- Customer-replied conversations routing — out of scope; PA owns
  thread / Reply-To headers (Brief 48 wired this for the customer
  flow).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `getLocationContactInfo` returns
  `{ site_email, rm_email, am_email }` and all existing call sites
  still compile.
- `apps/damage-worker/src/notifications.ts` exports
  `fireInternalNewClaimWebhook`, `resolveInternalRecipients`,
  `InternalNewClaimPayload`, `ClaimPhotoForWebhook`.
- `handleClaimSubmission`'s post-submit block fires
  `fireInternalNewClaimNotification` when
  `INTERNAL_NEW_CLAIM_WEBHOOK_URL` is bound, after the customer
  webhook fire, fail-soft.
- Payload includes `recipients[]` (lowercased, deduped, nulls
  dropped), `candidates`, `summary_pdf_url`, optional
  `summary_pdf_base64`, and `photos[]` with URLs against the
  request origin.
- `apps/damage-worker/wrangler.toml` declares
  `INCIDENTS_EMAIL` in `[vars]` (operator confirms value).
- `pnpm typecheck` passes for all packages.
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run` bundle succeeds and cleans up after.
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md, PRE_DEPLOY_DAMAGE.md
  updated.
- Sample payload JSON included in the outcome for operator's PA-flow
  setup.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (likely 150-220 lines net: helper widening in
  db-supabase + notifications.ts additions +
  fireInternalNewClaimNotification in index.ts +
  handleClaimSubmission patch + wrangler.toml + PRE_DEPLOY_DAMAGE.md
  + BUILD_STATE.md / INDEX.md / CLAUDE.md edits)
- Confirmation:
  - The new helper widening doesn't break Brief 32 / Brief 101
    call sites
  - The internal webhook fires AFTER the customer webhook so a
    failure in one doesn't block the other
  - PDF and photo URLs both point at the request's origin so
    workers.dev / staging / production all serve correctly
- Sample payload for the operator's PA-flow setup
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files modified

- `packages/db-supabase/src/locations.ts` — widened
  `getLocationContactInfo` return shape from `{ site_email, rm_email }`
  (Brief 101) to `{ site_email, rm_email, am_email }`. Single PostgREST
  select now requests all three columns; trim + null-coerce posture
  preserved on each. Brief 101's call sites (which read only
  `site_email` + `rm_email`) and Brief 32's call site (which reads only
  `site_email`) continue to compile because they consume a structural
  subset of the new return type.
- `apps/damage-worker/src/notifications.ts` — extended in place
  (not a sibling module) with the Brief 102 section. New exports:
  `ClaimPhotoForWebhook` (per-photo payload shape — `url`, `mime`,
  `original_filename`, `photo_type`, `uploaded_at`),
  `InternalNewClaimPayload` (full webhook body shape including
  `recipients[]` / `candidates` / `summary_pdf_url` / optional
  `summary_pdf_base64` / `photos[]`), `resolveInternalRecipients`
  (lowercase + dedupe + drop nulls/blanks; rm → site → am → incidents
  order; NO actor exclusion — customer submitter is not a location
  contact), and `fireInternalNewClaimWebhook` (15s `AbortSignal.timeout`,
  non-2xx logged + swallowed; mirrors Brief 101's `fireClaimUpdateWebhook`
  posture).
- `apps/damage-worker/src/index.ts`:
  - Imported `fireInternalNewClaimWebhook`, `resolveInternalRecipients`,
    and the two notification types from `./notifications.js`.
  - Added `INTERNAL_NEW_CLAIM_WEBHOOK_URL?: string` (secret) and
    `INCIDENTS_EMAIL?: string` (`[vars]`) to the `Env` interface.
  - Added the `fireInternalNewClaimNotification` private helper placed
    next to `fireCustomerClaimWebhook` — resolves contacts via the
    widened `getLocationContactInfo`, lists photos via
    `listPhotosForClaim` and maps each row to the
    `ClaimPhotoForWebhook` shape against the request `baseOrigin`,
    assembles the vehicle string, builds the payload reusing
    `pdfBytes` + `summaryPdfUrl` (no duplicate PDF generation) under
    the same `CUSTOMER_WEBHOOK_BASE64_MAX_BYTES` ceiling, and fires.
  - `handleClaimSubmission`: in the Brief 32 post-submit block, AFTER
    the customer-webhook fire and INSIDE the same `try { ... } catch
    (pdfErr) { ... }`, calls
    `await fireInternalNewClaimNotification({env, pdfBytes,
    summaryPdfUrl, claimData, baseOrigin})` when
    `env.INTERNAL_NEW_CLAIM_WEBHOOK_URL` is bound; wrapped in its own
    try/catch as defense-in-depth even though the inner helper
    swallows its own errors.
- `apps/damage-worker/wrangler.toml`:
  - `[vars]` block appended `INCIDENTS_EMAIL =
    "incidents@splashcarwashes.com"` (placeholder — operator confirms
    or amends before push; set to `""` to drop incidents from the
    recipient list while keeping the three location addresses).
  - Bindings comment block extended with the
    `INTERNAL_NEW_CLAIM_WEBHOOK_URL` documentation entry mirroring the
    existing CUSTOMER_CLAIM_WEBHOOK_URL / CLAIM_UPDATE_WEBHOOK_URL
    blocks.
- `PRE_DEPLOY_DAMAGE.md`:
  - Added `INTERNAL_NEW_CLAIM_WEBHOOK_URL` + `INCIDENTS_EMAIL` rows to
    the secrets / vars table.
  - Added `INTERNAL_NEW_CLAIM_WEBHOOK_URL` to the
    `wrangler secret put` bash block.
  - Extended the fail-soft contract paragraph to include the new
    secret.
  - Appended a "Brief 102 — internal new-claim notification" section
    covering: recipient resolution table, full sample payload,
    operator's PA-flow setup steps, and the `INCIDENTS_EMAIL`
    operator-confirm step.
- `BRIEFS/INDEX.md` — appended the Brief 102 row.
- `CLAUDE.md` — added two new glossary entries:
  `INTERNAL_NEW_CLAIM_WEBHOOK_URL` (full description matching the
  Brief 101 `CLAIM_UPDATE_WEBHOOK_URL` glossary shape) and
  `INCIDENTS_EMAIL` (non-secret `[vars]` description).
- `BUILD_STATE.md` — bumped "Last updated" marker to
  `2026-05-11 — Brief 102 completed (...)` and folded the Brief 102
  summary into the master Findings line in the same shape as Brief 101
  (no separate Findings-log table row — Brief 101's executor
  established this convention and Brief 102 follows it).

### Files created

None. Brief 102 reuses the `apps/damage-worker/src/notifications.ts`
module Brief 101 introduced rather than spawning a new sibling — this
matches the convention CLAUDE.md spells out for damage-worker
notification surfaces ("Future notification surfaces should reuse
`apps/damage-worker/src/notifications.ts` rather than spawning a new
module per feature").

### Decisions made on the operator's behalf

1. **`getLocationContactInfo` widened in place rather than forking.**
   Matches Brief 101 Decision 1. The new `am_email` field is additive:
   Brief 32's call site reads `contact.site_email` only and Brief 101's
   call site reads `{site_email, rm_email}`; both continue to compile
   because the new return shape is a structural superset.

2. **`fireInternalNewClaimNotification` lives in `index.ts` rather
   than `notifications.ts`.** Matches Brief 101 Decision 2 — placing
   the orchestrator in `index.ts` lets it close over the `Env` type
   plus the `getLocationContactInfo`, `bytesToBase64`, and
   `listPhotosForClaim` imports already at module scope. The pure
   pieces (`InternalNewClaimPayload` type, `ClaimPhotoForWebhook`
   type, `resolveInternalRecipients` helper, `fireInternalNewClaimWebhook`
   fire helper) live in `notifications.ts` and remain unit-testable
   in isolation.

3. **`APPS_WEB_BASE_URL` fallback inlined, not extracted into a
   shared `buildAdminBase` helper.** Matches Brief 101 Decision 3 —
   the two-line `const baseUrl = env.APPS_WEB_BASE_URL ??
   "https://splashcarwashes.info";` + ``` `${baseUrl}/admin/damage/...`
   ``` pattern is already present at four call sites (Brief 42's WO
   description, Brief 65's daily-summary digest, Brief 101's
   `notifyClaimUpdate`, and now Brief 102). Extracting now would
   churn four call sites for marginal gain; defer until a fifth use
   appears.

4. **Field-name mapping divergence between brief and D1.** The brief
   specified `mime`, `original_filename`, and `uploaded_at` on the
   `ClaimPhotoForWebhook` shape, but the D1 `claim_photos` row exposes
   `content_type`, `filename`, and has no per-row timestamp column.
   Decision: preserve the brief's PA-facing payload shape (operator's
   downstream PA flow consumes `mime` etc.) but fix the source-field
   mapping inside the helper:
     - `mime` ← `p.content_type`
     - `original_filename` ← `p.filename`
     - `uploaded_at` ← `claimData.submittedAt` (at submit time every
       photo arrives with the claim, so the claim's submission
       timestamp is the authoritative upload time; documented in the
       `ClaimPhotoForWebhook` TSDoc and in CLAUDE.md's glossary entry).
   Flagged here so a future expansion (e.g., adding Quote / Receipt
   photos to a "claim updated" webhook later) knows that
   `uploaded_at` for non-Damage photos would need a different source
   — most likely the `claim_activity_log.created_at` row for the
   doc-upload activity.

5. **Recipient ordering rm → site → am → incidents.** The brief's
   sample `resolveInternalRecipients` uses this order; preserved.
   Rationale: location-scoped recipients first (the field people who
   need to act), broadcast inbox last.

6. **`INCIDENTS_EMAIL` placeholder kept as the brief's value
   `incidents@splashcarwashes.com`.** The brief said the value was a
   placeholder for the executor to flag for operator confirmation
   before push. Flagged in BUILD_STATE.md, wrangler.toml comment, and
   PRE_DEPLOY_DAMAGE.md as an operator-confirm step. Setting the
   value to `""` (or removing the line) drops incidents from the
   recipient list entirely while keeping the three location
   addresses.

### Latent issues found

None blocking. Two notes:

- `claim_photos` rows carry no per-row upload timestamp column. The
  helper uses `claimData.submittedAt` as `uploaded_at` for every
  photo, which is accurate at submit time (all photos arrive with the
  claim). A future expansion that fires the internal-new-claim
  webhook on a non-submit event would need to source `uploaded_at`
  from elsewhere — most likely from `claim_activity_log.created_at`
  for the corresponding `document_added` activity row. Not relevant
  for Brief 102's submit-only fire scope.
- The `INCIDENTS_EMAIL` placeholder `incidents@splashcarwashes.com`
  ships in wrangler.toml as a literal string. If the operator pushes
  without amending and the address doesn't exist (or has no mailbox),
  PA will see a non-deliverable address in `recipients[]` and the
  resulting bounce / NDR depends entirely on the PA flow's
  send-email behavior. Documented as an operator-confirm step; set
  to `""` to drop entirely.

### Validation results

- `pnpm typecheck` — **17/17 packages green** (no errors).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — **bundle OK**, 1728.60 KiB raw / 391.03 KiB
  gzipped (≈ +5 KiB raw / +1 KiB gzipped vs the Brief 101 baseline of
  1723.98 KiB / 390.38 KiB; well under CF's 3 MiB free-tier compressed
  limit). Wrangler binding summary correctly shows the new
  `env.INCIDENTS_EMAIL ("incidents@splashcarwashes.com")` Environment
  Variable alongside the existing
  `MAINTAINX_MODE` / `MAINTAINX_BASE_URL` / `APPS_WEB_BASE_URL`
  entries. `.tmp-build` cleaned up after.
- Local smoke tests — **deferred to first post-deploy verification**
  per Phase 4.3:
  - Submit a test claim via `/claims/{loc}` on workers.dev (with the
    secret bound and a real PA flow listening) → expect an
    `[internal-new-claim]` log line in CF Workers Logs followed by
    PA receiving the payload and emails landing in the four
    recipient inboxes.
  - With `INTERNAL_NEW_CLAIM_WEBHOOK_URL` unbound → no `[internal-
    new-claim]` log line; customer-email path, PDF generation, and
    claim write all still succeed (verifies fail-soft).
  - With `INCIDENTS_EMAIL` set to `""` → `recipients[]` contains
    only the three location addresses (or fewer if any are null);
    `candidates.incidents_email` is `null`.

### Sample payload (for operator's PA-flow setup)

This is one fire from a customer submission at the Binghamton location
where the location has all three contact addresses populated, a single
Damage photo was uploaded, and the PDF is small enough to inline as
base64 (< ~3 MB raw):

```json
{
  "claim_id": "BIN-20260511-143055-AB12",
  "submitted_at": "2026-05-11T14:30:55.123Z",
  "location_code": "binghamton",
  "location_pretty": "Binghamton",
  "admin_url": "https://splashcarwashes.info/admin/damage/BIN-20260511-143055-AB12",
  "customer_name": "Jane Doe",
  "customer_email": "jane@example.com",
  "customer_phone": "5551234567",
  "vehicle": "2020 Honda Civic - Blue",
  "damage_type": "Exterior",
  "damage_other": null,
  "issue_description": "Front bumper scratch noticed after the wash.",
  "recipients": [
    "rm@splashcarwashes.com",
    "binghamton-site@splashcarwashes.com",
    "rd@splashcarwashes.com",
    "incidents@splashcarwashes.com"
  ],
  "candidates": {
    "rm_email": "rm@splashcarwashes.com",
    "site_email": "binghamton-site@splashcarwashes.com",
    "am_email": "rd@splashcarwashes.com",
    "incidents_email": "incidents@splashcarwashes.com"
  },
  "summary_pdf_url": "https://splashcarwashes.info/claims-api/summary/BIN-20260511-143055-AB12",
  "summary_pdf_base64": "JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+CnN0cmVhbQp...etc...",
  "photos": [
    {
      "url": "https://splashcarwashes.info/claims-api/photo/claims/BIN-20260511-143055-AB12/vehicle_overview_1.jpg",
      "mime": "image/jpeg",
      "original_filename": "front-bumper.jpg",
      "photo_type": "Damage",
      "uploaded_at": "2026-05-11T14:30:55.123Z"
    }
  ]
}
```

When the PDF is larger than ~3 MB raw (the
`CUSTOMER_WEBHOOK_BASE64_MAX_BYTES` ceiling), `summary_pdf_base64`
is omitted — PA fetches via `summary_pdf_url` instead.

### Confirmations (per Report section of the brief)

- **The new helper widening doesn't break Brief 32 / Brief 101 call
  sites.** Verified by reading the call sites: line 2793 of
  `apps/damage-worker/src/index.ts` (Brief 32 customer-webhook path)
  destructures only `contact.site_email`; line 3401 (Brief 101
  `notifyClaimUpdate`) reads `{rm_email, site_email}`. Both compile
  because the new return shape is a structural superset. Typecheck
  green confirms.
- **The internal webhook fires AFTER the customer webhook.** Verified
  by reading the Brief 32 post-submit block: the customer-webhook
  `await fireCustomerClaimWebhook(...)` (line 2804) precedes the
  Brief 102 `if (env.INTERNAL_NEW_CLAIM_WEBHOOK_URL) { try { await
  fireInternalNewClaimNotification(...) } catch ... }` block. A failure
  in the customer webhook cannot prevent the internal webhook from
  firing (and vice versa) because each is wrapped in its own try/catch
  inside the outer Brief 32 PDF try/catch.
- **PDF and photo URLs both point at the request's origin so
  workers.dev / staging / production all serve correctly.**
  `summaryPdfUrl` is built from `baseOrigin` at line 2780 (Brief 32
  pattern). The new `fireInternalNewClaimNotification` accepts
  `baseOrigin` as an argument and uses it for every
  `${baseOrigin}/claims-api/photo/${p.r2_key}` URL. `admin_url` uses
  `APPS_WEB_BASE_URL` for clickthrough into apps/web (different
  worker; different domain after cutover).

### Operator follow-up

1. **Confirm or amend `INCIDENTS_EMAIL`** in
   `apps/damage-worker/wrangler.toml`. Default placeholder is
   `incidents@splashcarwashes.com`. Set to `""` to drop incidents
   from the recipient list entirely.
2. **Build the PA flow** per the "Brief 102 — internal new-claim
   notification" section of `PRE_DEPLOY_DAMAGE.md`. Paste the sample
   payload above into "Use sample payload to generate schema" so PA
   exposes dynamic content for the email body.
3. **Bind the trigger URL** after the worker deploys:
   ```bash
   pnpm --filter @splash/damage-worker exec wrangler secret put INTERNAL_NEW_CLAIM_WEBHOOK_URL
   ```
4. **Smoke test** by submitting a real claim via `/claims/{loc}` on
   workers.dev with the secret bound; tail CF Workers Logs for an
   `[internal-new-claim]` line and verify the four recipient inboxes
   receive the email.
5. Until the secret is bound, the worker silently no-ops the
   internal-notification path on every claim submission — the
   customer-email webhook, the PDF generation, and the claim write
   are unaffected and continue working immediately on next push-
   triggered deploy.
