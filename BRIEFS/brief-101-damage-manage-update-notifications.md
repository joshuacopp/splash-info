# Brief 101: Damage-claim manage-page update notifications — note + status-change webhook, plus "needs quotes" UI indicator

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither (fully additive; fail-soft when webhook unbound)
**Dependencies:** Brief 19 (ActionForm pattern — already in use on the
note + transition forms), Brief 32 / 48 / 49 (the
`CUSTOMER_CLAIM_WEBHOOK_URL` and `getLocationContactInfo` patterns this
brief mirrors), Brief 65 (`DAILY_SUMMARY_WEBHOOK_URL` fail-soft posture
+ `ctx.waitUntil` pattern), Brief 66 (the RM-revert transition rows
this brief categorizes by next-actor), Brief 68/69 (the
`AgePill`-style status pill this brief's UI piece mirrors).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-019-action-result-refresh.md (the `<ActionForm>` pattern
  — referenced because the note + transition forms it wraps are the
  intercept points this brief hooks into; no change to that contract)
- BRIEFS/brief-032-claim-summary-pdf-and-customer-email.md (existing
  damage-worker webhook pattern — same fail-soft posture)
- BRIEFS/brief-048-customer-webhook-add-site-email.md (added the
  `getLocationContactInfo` Supabase round-trip used here; this brief
  extends the same helper)
- BRIEFS/brief-049-getlocationcontactinfo-read-from-pricing-simple.md
  (the pricing_simple-as-source-of-truth read path, including the join
  fix Brief 62 also touched — this brief reads `rm_email` from the
  same row)
- BRIEFS/brief-065-daily-open-claims-summary-cron.md (mirror this
  brief's fail-soft + ctx.waitUntil + per-recipient resolution)
- BRIEFS/brief-066-rm-revert-from-approved-pending-quotes.md (defines
  the RM revert paths; this brief's status→notifies map relies on the
  current transition table)
- apps/damage-worker/src/index.ts (`handleAddNote` ~L1351,
  `handleStatusTransition` ~L1397; the two intercept points)
- apps/damage-worker/src/transitions.ts (the full transition table —
  this brief's status→notifies map is keyed by `to` status, not by
  transition pair)
- packages/db-supabase/src/locations.ts (`getLocationContactInfo` —
  extend the return shape to include `rm_email`)
- apps/web/app/admin/damage/page.tsx (~L424 — where the list-row
  status text renders; add a "Needs quotes" indicator beside it)
- apps/web/app/admin/damage/[id]/page.tsx (~L399 — where the detail
  status pill renders; add a "Needs quotes" indicator beside it)
- apps/web/app/admin/damage/_components/AgePill.tsx (pill component
  pattern — Tailwind utility classes, no new shared package needed)
- PRE_DEPLOY_DAMAGE.md (the section where webhook secrets are
  documented — append the new secret)

## Context

Operator wants notification emails when activity happens on the
manage page for a damage claim, scoped so the volume stays low and
the right person is alerted. Two specific update events trigger the
webhook:

1. **A note is added** to a claim (any role, any status, via the
   `/manage/api/claim/{id}/note` POST handler in damage-worker). The
   notification goes to BOTH `rm_email` and `site_email` for the
   claim's location, minus the actor's own email if they happen to
   own one of those addresses.

2. **A status changes** to a status that requires a specific
   field-side role to act next. The notification goes to ONE
   recipient based on a `to`-keyed map:

   - `Pending GM Review` → `site_email` (GM acts)
   - `No Responsibility — Pending Review` → `site_email` (GM
     escalates)
   - `Pending RM Review` → `rm_email` (RM acts)
   - `Pending RM Quote Approval` → `rm_email` (RM acts)
   - `Approved — Pending Quotes` → `site_email` (GM uploads quotes)
   - Every other `to` status (admin/finance/closed/vestigial) → no
     notification.

The `to`-keyed map is the right shape because every transition that
arrives at one of these statuses needs the same next-actor — it
doesn't matter whether the transition came from a forward step or
from a Brief 66 RM-revert path; what matters is who's now expected
to act. Specifically: this means the RM-revert transitions added in
Brief 66 (`Approved — Pending Quotes → Pending GM Review`,
`Approved — Pending Quotes → Pending RM Review`,
`Pending RM Quote Approval → Pending GM Review`) all fire
notifications under this brief, because their destination statuses
are in the map. That's the desired behavior — a bounce-back IS the
event the field needs to know about.

**Webhook-to-PA, not direct SMTP.** Same pattern as
`CUSTOMER_CLAIM_WEBHOOK_URL` and `DAILY_SUMMARY_WEBHOOK_URL`: a new
secret `CLAIM_UPDATE_WEBHOOK_URL` on damage-worker, fired via
`ctx.waitUntil` after the D1 write commits, with a 15-second
`AbortSignal.timeout`. PA owns templating, deliverability, retries.
When the secret is unbound, the worker logs a single line and
exits — the note / transition itself is unaffected (same posture as
Brief 32 / 65 — operator confirmed this is the required behavior
for this brief too).

**Actor exclusion.** If the actor's email is the location's
`rm_email` (an RM acting on their own RM-scope claim) or
`site_email` (GM acting on their own location), strip the actor's
email from the recipient list server-side. The webhook payload's
`recipients` array is what PA loops over to send emails; an empty
array means "fire was attempted but had nobody to email" and PA
no-ops. Self-notify exclusion uses case-insensitive email match.

**Admin / super_admin actors.** No special-case. If Josh adds a note
from `/admin/damage/[id]`, the webhook fires with both `rm_email`
and `site_email` as recipients (minus Josh, if his address happens
to be on the location, which is unlikely but the exclusion is the
right defense). This matches Decision 2 from the planning
conversation: notify always, exclude actor.

**`Approved — Pending Quotes` UI indicator.** Operator wants the
list view (`/admin/damage`) and detail view (`/admin/damage/[id]`)
to make it obvious that a claim in `Approved — Pending Quotes`
needs the GM to upload quotes. The visual treatment is a small
amber pill labeled "Needs quotes" rendered beside the existing
status text/pill. Reuse the Tailwind utility-class pattern from
`AgePill.tsx`; no new shared component package.

## Scope

### Phase 1 — `packages/db-supabase/locations.ts` — widen the contact helper

1.1 Extend `getLocationContactInfo` to return BOTH `site_email` and
`rm_email`:

```ts
export async function getLocationContactInfo(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<{ site_email: string | null; rm_email: string | null }>
```

  - PostgREST select becomes `select=site_email,rm_email`.
  - All existing fail-soft branches return
    `{ site_email: null, rm_email: null }` (same trim/lowercase
    posture as the current implementation).
  - The existing single call site in damage-worker
    (`handleClaimSubmission`'s Brief 48 block at ~L2724) keeps
    working because it reads `contact.site_email` only — the
    additional `rm_email` field is ignored.
  - **Do not** rename the helper. `getLocationContactInfo` is the
    natural name and the new return shape is additive.

1.2 Re-export from `packages/db-supabase/src/index.ts` — already
exported; no change beyond confirming the named export keeps
working with the new shape.

### Phase 2 — Damage-worker — status→notifies map + webhook helper

2.1 In a new module `apps/damage-worker/src/notifications.ts`,
declare the status→notifies map and helper:

```ts
import type { ClaimStatus } from "@splash/types/claims";

/**
 * Brief 101 — which next-actor (if any) gets notified when a claim
 * arrives at a given status. Keyed by `to` status because every
 * transition that lands here needs the same actor regardless of
 * the path taken (forward step, Brief 66 RM revert, admin escape
 * hatch, reopen). `gm` resolves to the location's `site_email`;
 * `rm` resolves to `rm_email`. Statuses not in this map don't fire
 * a status-change notification.
 *
 * Adding a new ClaimStatus to the union does NOT silently bypass
 * notifications — the type below uses Partial<Record<...>> so a
 * missing key is fine, but reviewers should consciously decide
 * whether the new status warrants a notify when they add it to
 * the transitions table.
 */
export const STATUS_NOTIFIES_NEXT: Partial<Record<ClaimStatus, "gm" | "rm">> = {
  "Pending GM Review": "gm",
  "No Responsibility — Pending Review": "gm",
  "Pending RM Review": "rm",
  "Pending RM Quote Approval": "rm",
  "Approved — Pending Quotes": "gm"
};
```

  - Place the file alongside `transitions.ts` so future readers find
    the two policy tables together.
  - Export from `notifications.ts` (no barrel — damage-worker doesn't
    use one for these helpers).

2.2 In the same file, add the payload type and fire helper:

```ts
export type ClaimUpdateChangeType = "note" | "status";

export interface ClaimUpdateWebhookPayload {
  change_type: ClaimUpdateChangeType;
  claim_id: string;
  customer_name: string | null;
  location_code: string;
  location_pretty: string | null;
  admin_url: string;             // e.g., `${APPS_WEB_BASE_URL}/admin/damage/{id}`
  actor: { email: string; dc_role: string | null };
  // Populated for status changes:
  from_status?: string;
  to_status?: string;
  // Populated for notes AND for status changes that carried an
  // accompanying note text. Truncated to 5000 chars (same ceiling
  // the note + transition handlers already enforce).
  note_text?: string;
  // Resolved server-side, with actor's email excluded. PA loops
  // over this array. Empty array means "nobody to email" — PA
  // no-ops gracefully.
  recipients: string[];
  // For audit / debug: which of the two location addresses were
  // candidates before exclusion. Helpful when verifying "why did /
  // didn't this user get an email".
  candidates: { rm_email: string | null; site_email: string | null };
}

export async function fireClaimUpdateWebhook(
  webhookUrl: string,
  payload: ClaimUpdateWebhookPayload
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
        `[claim-update] POST failed for ${payload.claim_id}: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(
      `[claim-update] POST error for ${payload.claim_id}:`,
      err
    );
  }
}
```

  - Match the existing `fireCustomerClaimWebhook` shape (lines
    3195+ of index.ts): try/catch wraps the fetch; non-2xx is
    logged but never thrown; abort/network errors logged but
    swallowed.
  - 15-second `AbortSignal.timeout` matches the daily-summary cron
    posture.

2.3 Add a small resolver helper in the same module:

```ts
export function resolveRecipients(
  notifies: "gm" | "rm" | "both",
  contacts: { rm_email: string | null; site_email: string | null },
  actorEmail: string
): string[] {
  const actor = actorEmail.trim().toLowerCase();
  const out: string[] = [];
  const push = (addr: string | null) => {
    if (!addr) return;
    const norm = addr.trim().toLowerCase();
    if (!norm || norm === actor) return;
    if (!out.includes(norm)) out.push(norm);
  };
  if (notifies === "gm" || notifies === "both") push(contacts.site_email);
  if (notifies === "rm" || notifies === "both") push(contacts.rm_email);
  return out;
}
```

  - `"both"` is the case used by `handleAddNote` (notes go to both
    addresses). Status changes pass either `"gm"` or `"rm"`.

2.4 In `apps/damage-worker/src/index.ts`:

  - Add `CLAIM_UPDATE_WEBHOOK_URL?: string` and `APPS_WEB_BASE_URL?: string`
    (if not already present — Brief 42 added the latter as a `[vars]`
    entry; verify it's on the `Env` interface and add if missing) to
    the `Env` interface.
  - Import `STATUS_NOTIFIES_NEXT`, `fireClaimUpdateWebhook`,
    `resolveRecipients` from `./notifications`.
  - Import `getLocationContactInfo` (already imported for the
    customer webhook; reuse).
  - Add a small private helper `buildAdminUrl(env, claimId)` that
    falls back to a sensible default when `APPS_WEB_BASE_URL` is
    unset (e.g., `https://splashcarwashes.info`) — the same
    inference posture used by forms-worker's `inferAdminBase`
    (Brief 97). The brief's executor may extract this to a shared
    module if `APPS_WEB_BASE_URL` is already imported via
    `maintainx.ts`; otherwise inline it.

2.5 Wire into `handleAddNote` (around L1378, after `touchClaim`
returns and BEFORE `return json({ ok: true })`):

```ts
// Brief 101 — fire-and-forget update webhook. Fail-soft when
// secret unbound or recipients empty. Never throws into the
// caller; we use ctx.waitUntil semantics by spawning the fetch
// without awaiting it from the handler return path.
//
// NOTE: damage-worker's handlers don't currently take `ctx` as a
// parameter; the brief's executor either threads ctx through OR
// fires the webhook eagerly with `void fireAndForgetClaimUpdate(...)`.
// Eager-fire is the simpler choice — the helper already swallows
// throws — and matches Brief 32's customer-webhook posture.
if (env.CLAIM_UPDATE_WEBHOOK_URL) {
  void notifyClaimUpdate({
    env,
    changeType: "note",
    claim: guard.claim,
    actorEmail: session.email,
    actorRole: session.dcRole ?? null,
    noteText
  });
}
```

  - `notifyClaimUpdate` is a new local async function in index.ts
    (or notifications.ts — executor's call) that wraps the
    contact-resolve + recipient-build + fire pipeline. It MUST
    catch and swallow all errors — same posture as the customer
    webhook.

2.6 Wire into `handleStatusTransition` (around L1660, after the
`env.DB.batch(...)` commits and BEFORE the MaintainX block at
L1668):

```ts
// Brief 101 — status-change notification. Skips when the to-status
// isn't in STATUS_NOTIFIES_NEXT. Note text is passed when present.
if (env.CLAIM_UPDATE_WEBHOOK_URL) {
  void notifyClaimUpdate({
    env,
    changeType: "status",
    claim,
    actorEmail: session.email,
    actorRole: session.dcRole ?? null,
    fromStatus: claim.claim_status,
    toStatus: finalTo,
    noteText: noteText || undefined
  });
}
```

  - Placement is AFTER the batch commits (otherwise a notification
    could fire for a write that rolled back) and BEFORE the
    MaintainX path so the two side-effects don't serialize on each
    other.
  - `notifyClaimUpdate` checks
    `STATUS_NOTIFIES_NEXT[toStatus]` and exits early when there's
    no map entry — finance/closed transitions never fire.

2.7 `notifyClaimUpdate` body (concretely):

```ts
async function notifyClaimUpdate(args: {
  env: Env;
  changeType: ClaimUpdateChangeType;
  claim: ClaimRow;
  actorEmail: string;
  actorRole: string | null;
  fromStatus?: ClaimStatus;
  toStatus?: ClaimStatus;
  noteText?: string;
}): Promise<void> {
  const { env, changeType, claim, actorEmail, actorRole, fromStatus, toStatus, noteText } = args;
  try {
    if (!env.CLAIM_UPDATE_WEBHOOK_URL) return;

    // Resolve the location's contact addresses. Fail-soft: any
    // throw here collapses to nulls and we'll fire a webhook with
    // an empty recipients array (PA no-ops).
    let contacts: { rm_email: string | null; site_email: string | null } = {
      rm_email: null,
      site_email: null
    };
    try {
      contacts = await getLocationContactInfo(env, claim.location_code);
    } catch (err) {
      console.warn(
        `[claim-update] getLocationContactInfo threw for ${claim.location_code}; treating as null contacts`,
        err
      );
    }

    let notifies: "gm" | "rm" | "both";
    if (changeType === "note") {
      notifies = "both";
    } else if (toStatus && STATUS_NOTIFIES_NEXT[toStatus]) {
      notifies = STATUS_NOTIFIES_NEXT[toStatus]!;
    } else {
      return; // status change to a non-notifying status
    }

    const recipients = resolveRecipients(notifies, contacts, actorEmail);

    const payload: ClaimUpdateWebhookPayload = {
      change_type: changeType,
      claim_id: claim.claim_id,
      customer_name: claim.customer_name ?? null,
      location_code: claim.location_code,
      location_pretty: claim.location_pretty ?? null,
      admin_url: `${buildAdminBase(env)}/admin/damage/${encodeURIComponent(claim.claim_id)}`,
      actor: { email: actorEmail, dc_role: actorRole },
      recipients,
      candidates: contacts,
      ...(fromStatus ? { from_status: fromStatus } : {}),
      ...(toStatus ? { to_status: toStatus } : {}),
      ...(noteText ? { note_text: noteText.slice(0, 5000) } : {})
    };

    await fireClaimUpdateWebhook(env.CLAIM_UPDATE_WEBHOOK_URL, payload);
  } catch (err) {
    // Defense-in-depth: nothing reaches here unless one of the
    // inner helpers throws unexpectedly. Logged and swallowed.
    console.error(
      `[claim-update] notifyClaimUpdate failed for ${claim.claim_id}:`,
      err
    );
  }
}
```

2.8 `apps/damage-worker/wrangler.toml` — append to the `[vars]`
block (under the existing `MAINTAINX_*` vars and `APPS_WEB_BASE_URL`):

```toml
# Brief 101 (YYYY-MM-DD): manage-page update notifications. Fail-soft:
# unbound secret = no notification, no error, claim writes unaffected.
# Bind out-of-code:
#   pnpm --filter @splash/damage-worker exec wrangler secret put CLAIM_UPDATE_WEBHOOK_URL
```

No new `[vars]` or `[triggers]` block needed — the secret is bound
via `wrangler secret put`, matching `CUSTOMER_CLAIM_WEBHOOK_URL`.

2.9 No schema change. No D1 migration. No Supabase column add.

### Phase 3 — Apps/web — "Needs quotes" indicator on list + detail

3.1 New component `apps/web/app/admin/damage/_components/StatusActionPill.tsx`:

```tsx
// Brief 101 — small visual indicator beside a claim status that
// makes specific pending-action states obvious. Today the only
// status that surfaces a pill is "Approved — Pending Quotes"
// (operator asked for a clear "needs quotes" signal). Adding more
// states later is a single map entry below.

import type { ClaimStatus } from "@splash/types/claims";

interface PillConfig {
  label: string;
  classes: string;       // Tailwind utility classes
  title?: string;        // tooltip text
}

const STATUS_ACTION_PILLS: Partial<Record<ClaimStatus, PillConfig>> = {
  "Approved — Pending Quotes": {
    label: "Needs quotes",
    classes: "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
    title: "GM should upload one or more quotes from approved vendors."
  }
};

export function StatusActionPill({ status }: { status: ClaimStatus }) {
  const config = STATUS_ACTION_PILLS[status];
  if (!config) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${config.classes}`}
      title={config.title}
    >
      {config.label}
    </span>
  );
}
```

  - Co-located under `_components/` next to `AgePill.tsx` — same
    pattern as the existing pills in this folder.
  - No new shared package; this is damage-specific.

3.2 Update `apps/web/app/admin/damage/page.tsx` — wrap the status
text cell (around L423-425) so the pill sits beside the text:

```tsx
<td className="px-4 py-3 text-splash-navy/80">
  <div className="flex flex-wrap items-center gap-2">
    <span>{c.claim_status}</span>
    <StatusActionPill status={c.claim_status} />
  </div>
</td>
```

  - Import `StatusActionPill` at the top of the file alongside
    `AgePill`.
  - `flex flex-wrap items-center gap-2` keeps the status text and
    pill on one line when there's room, wrapping to the next line
    on narrow viewports.

3.3 Update `apps/web/app/admin/damage/[id]/page.tsx` — wrap the
detail status pill (around L399-401) so the action pill sits to
its right:

```tsx
<div className="mt-1 flex flex-wrap items-center gap-2">
  <span className="inline-flex items-center rounded-full bg-sudsy-blue-soft px-2.5 py-0.5 text-xs font-semibold text-splash-navy">
    {claim.claim_status}
  </span>
  <StatusActionPill status={claim.claim_status} />
  {claim.contact_status && claim.contact_status !== "Not Started" ? (
    <span className="text-xs text-splash-navy/60">{claim.contact_status}</span>
  ) : null}
</div>
```

  - The existing `flex flex-wrap items-center gap-2` wrapper already
    exists at L398; only the new `<StatusActionPill>` line is added
    between the status pill and the contact-status span.
  - Import `StatusActionPill` at the top of the file.

3.4 No change to the worker API. The pill renders purely off the
already-served `claim_status` field. No new fields, no list-query
changes.

### Phase 4 — Power Automate flow (operator-side, out-of-code)

4.1 Operator creates a new PA flow:
  - Trigger: HTTP request received
  - Use "Use sample payload to generate schema" with the sample
    payloads in the brief's Outcome section (one note example, one
    status-change example) to populate dynamic content
  - Apply to each: loop over `triggerBody()?['recipients']`
  - Action: Send an email (V2)
    - To: current item (the email)
    - Subject: branch on `change_type`:
      - `note` → "{actor_name} added a note on {customer_name}'s claim at {location_pretty}"
      - `status` → "{customer_name}'s claim at {location_pretty} → {to_status}"
    - Body: HTML with `admin_url` rendered as a "View claim" button,
      the note text (when present) in a blockquote, and the
      from/to status pair when `change_type === 'status'`
  - Save the trigger URL. Bind as `CLAIM_UPDATE_WEBHOOK_URL` via
    wrangler secret per Phase 2.8.

4.2 PA flow is operator-owned. If the flow isn't set up yet when the
worker deploys, the secret stays unbound and no notifications fire —
the brief's whole point is that this is non-blocking.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass for all packages.
5.2 `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=.tmp-build`
    — bundle must succeed; clean up afterward.
5.3 `pnpm --filter @splash/web build` — must succeed.
5.4 Local smoke (deferred to first post-deploy verification):
    - Add a note from `/admin/damage/[id]`; check CF Workers Logs
      for a `[claim-update]` log line on the next note POST.
    - Status transition `Pending GM Review → Approved — Pending Quotes`
      from a non-GM session; check the log line shows
      `to_status: "Approved — Pending Quotes"` and `recipients`
      contains the location's `site_email`.
    - Visit `/admin/damage` with at least one claim in
      `Approved — Pending Quotes`; verify the amber "Needs quotes"
      pill renders beside the status text.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 101 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - New `CLAIM_UPDATE_WEBHOOK_URL` secret on damage-worker fires
    fail-soft notifications on note adds (rm_email + site_email)
    and on status changes whose `to` status is in
    `STATUS_NOTIFIES_NEXT` (gm-acts → site_email, rm-acts → rm_email)
  - Self-notify exclusion: actor's email never appears in
    `recipients[]`
  - When secret unbound: no notification, no error, writes
    unaffected
  - Apps/web `/admin/damage` and `/admin/damage/[id]` render a
    "Needs quotes" amber pill beside `Approved — Pending Quotes`
    statuses
  - Operator follow-up: build the PA flow per Phase 4, then
    `wrangler secret put CLAIM_UPDATE_WEBHOOK_URL` with the
    flow's HTTP-trigger URL

6.3 CLAUDE.md updates:
  - "Working with workers" section: add a one-liner noting the new
    `CLAIM_UPDATE_WEBHOOK_URL` secret on damage-worker. Future
    notification surfaces should reuse the
    `apps/damage-worker/src/notifications.ts` module rather than
    creating a new one per feature.
  - Glossary: add **CLAIM_UPDATE_WEBHOOK_URL** entry —
    fail-soft per-event notification fired on note add and on
    status changes whose destination is in `STATUS_NOTIFIES_NEXT`.

6.4 PRE_DEPLOY_DAMAGE.md: append section documenting the new
secret, the status→recipient map, and the operator's PA-flow
setup steps. Mirror the layout of the existing
`CUSTOMER_CLAIM_WEBHOOK_URL` section.

## Configuration

| Name | Type | Required | Default | How to set |
|------|------|----------|---------|------------|
| `CLAIM_UPDATE_WEBHOOK_URL` | secret | optional | unbound | `pnpm --filter @splash/damage-worker exec wrangler secret put CLAIM_UPDATE_WEBHOOK_URL` after the worker deploys |
| `APPS_WEB_BASE_URL` | `[vars]` | already present (Brief 42) | `https://splashcarwashes.info` (inferred) | Edit `apps/damage-worker/wrangler.toml` `[vars]` block |

No new D1 columns. No Supabase column adds. No new tables.

## Out of scope

- Per-claim or per-location mute switch. Deferred per planning
  decision 5 — operator may add a `claims.notify_field` boolean
  later if specific claims need silencing.
- Notifications when an attachment (quote / receipt) is uploaded.
  Today the activity log records uploads but doesn't trigger
  notifications. v2 if the operator finds the field wants to know
  when a quote was just uploaded.
- Notifications when a claim's `equipment_related` flag flips
  (Brief 43's no→yes override). Adjacent to status change but
  doesn't require a specific field-side actor. Skip for v1.
- Notifications for the daily-summary path (Brief 65) — that's a
  separate digest, not a per-event notification.
- Notifications for new-claim submissions to internal contacts
  (rm_email / site_email / am_email / incidents) — that's Brief 102.
- A super_admin "always also CC me" mode. Specific super_admins
  who want notifications today should ensure their email is on the
  location's contact roster.
- A per-recipient unsubscribe link. PA can render one but it's
  template work, not worker work.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `getLocationContactInfo` returns `{ site_email, rm_email }` and
  all existing call sites still compile.
- `apps/damage-worker/src/notifications.ts` exports
  `STATUS_NOTIFIES_NEXT`, `resolveRecipients`,
  `fireClaimUpdateWebhook`, and the `ClaimUpdateWebhookPayload`
  type.
- `handleAddNote` fires `notifyClaimUpdate({changeType:"note"})`
  on success (after the D1 write commits), fail-soft.
- `handleStatusTransition` fires
  `notifyClaimUpdate({changeType:"status"})` on success (after the
  batch commits, before the MaintainX hook), fail-soft.
- Webhook payload includes `recipients[]` (lowercased, actor
  excluded, deduped), `candidates`, `admin_url`, and the
  change-type-specific fields per Phase 2.2.
- `apps/web/app/admin/damage/_components/StatusActionPill.tsx`
  exports `<StatusActionPill>`. The list page and detail page
  render it beside the status text.
- `pnpm typecheck` passes for all packages.
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run` bundle succeeds and clean-up after.
- `pnpm --filter @splash/web build` succeeds.
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md, PRE_DEPLOY_DAMAGE.md
  updated.
- Sample payload JSON (one note, one status change) included in
  the outcome for operator PA-flow setup.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (likely 250-350 lines net: notifications.ts module +
  helper widening in db-supabase + two handler patches +
  StatusActionPill + two apps/web JSX edits + wrangler.toml +
  PRE_DEPLOY_DAMAGE.md + BUILD_STATE.md / INDEX.md / CLAUDE.md
  edits)
- Confirmation:
  - getLocationContactInfo's new shape doesn't break the Brief 32
    customer-webhook path
  - The status→notifies map matches the documented behavior:
    five `to` statuses notify, all others don't
  - Actor exclusion is case-insensitive and dedupes
- Two sample payloads (one note, one status change to
  `Approved — Pending Quotes`) for the operator's PA-flow setup
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created

- `apps/damage-worker/src/notifications.ts` — exports
  `STATUS_NOTIFIES_NEXT` (the 5-entry `to`-keyed map),
  `resolveRecipients`, `fireClaimUpdateWebhook`,
  `ClaimUpdateChangeType`, `NotificationTarget`, and
  `ClaimUpdateWebhookPayload`. Sits alongside `transitions.ts` so the
  two policy tables live together.
- `apps/web/app/admin/damage/_components/StatusActionPill.tsx` —
  exports `<StatusActionPill>`. Renders an amber "Needs quotes" pill
  for `Approved — Pending Quotes`; returns null otherwise.

### Files modified

- `packages/db-supabase/src/locations.ts` — widened
  `getLocationContactInfo` return shape from `{ site_email }` to
  `{ site_email, rm_email }`. Single PostgREST select now requests
  both columns; trim + null-coerce posture preserved.
- `apps/damage-worker/src/index.ts`:
  - Imported `STATUS_NOTIFIES_NEXT`, `fireClaimUpdateWebhook`,
    `resolveRecipients`, and the two notification types from the new
    `./notifications.js` module.
  - Added `CLAIM_UPDATE_WEBHOOK_URL?: string` to the `Env` interface.
  - Added the `notifyClaimUpdate(args)` private helper (immediately
    after `fireCustomerClaimWebhook`, before the Brief 65 section) —
    resolves contacts via `getLocationContactInfo`, picks recipients
    via `resolveRecipients`, builds the payload, and calls
    `fireClaimUpdateWebhook`. Internally fail-soft (try/catch around
    every external touch; logs `[claim-update]` lines).
  - `handleAddNote`: after the D1 write commits, when
    `env.CLAIM_UPDATE_WEBHOOK_URL` is bound, fires
    `void notifyClaimUpdate({changeType:"note", claim: guard.claim,
    actorEmail: session.email, actorRole: session.dcRole ?? null,
    noteText})`.
  - `handleStatusTransition`: after `env.DB.batch(...)` commits and
    BEFORE the MaintainX block, when `env.CLAIM_UPDATE_WEBHOOK_URL`
    is bound, fires
    `void notifyClaimUpdate({changeType:"status", claim, actorEmail:
    session.email, actorRole: session.dcRole ?? null, fromStatus:
    claim.claim_status, toStatus: finalTo, noteText: noteText ||
    undefined})`. Non-mapped destinations exit cleanly inside the
    helper.
- `apps/damage-worker/wrangler.toml` — appended a
  `CLAIM_UPDATE_WEBHOOK_URL` entry to the bindings comment block.
  No new `[vars]` / `[triggers]` (secret is bound out-of-code).
- `apps/web/app/admin/damage/page.tsx` — imported `StatusActionPill`;
  wrapped the status cell in a `flex flex-wrap items-center gap-2`
  container so the pill sits beside the status text.
- `apps/web/app/admin/damage/[id]/page.tsx` — imported
  `StatusActionPill`; added the pill between the existing status pill
  and the (conditional) contact_status span.
- `PRE_DEPLOY_DAMAGE.md` — added the `CLAIM_UPDATE_WEBHOOK_URL` row
  to the secrets table (and to the `wrangler secret put` bash block),
  extended the fail-soft contract paragraph, and appended a full
  "Brief 101 — manage-page update notifications" section documenting
  the status→recipient map, payload shape, and PA-flow setup steps.
- `CLAUDE.md` — added the `CLAIM_UPDATE_WEBHOOK_URL` glossary entry;
  appended a Brief 101 note to the "Damage-worker manage endpoints"
  paragraph pointing future notification surfaces at
  `apps/damage-worker/src/notifications.ts`.
- `BRIEFS/INDEX.md` — appended the Brief 101 row.
- `BUILD_STATE.md` — bumped "Last updated" to 2026-05-11 and folded
  the Brief 101 summary into the master Findings line in the same
  shape as Briefs 98 / 99 / 100.

### Decisions made on the operator's behalf

1. **`getLocationContactInfo` widened in place rather than forking a
   new helper.** The brief left the executor to choose between a new
   helper and widening the existing one; widening is additive (existing
   call sites continue to compile unchanged because they only read
   `contact.site_email`) and avoids two parallel helpers reading the
   same row.

2. **`notifyClaimUpdate` lives in `index.ts` rather than
   `notifications.ts`.** The brief said "executor's call". Putting it
   in `index.ts` lets it close over the `Env` type and the
   `getLocationContactInfo` import already at module scope (matches
   the placement of `fireCustomerClaimWebhook`). The pure pieces
   (`STATUS_NOTIFIES_NEXT`, `resolveRecipients`,
   `fireClaimUpdateWebhook`, the `ClaimUpdateWebhookPayload` type)
   are in `notifications.ts` and unit-testable in isolation.

3. **`buildAdminUrl` was inlined, not extracted.** The brief
   suggested optional extraction to a shared module if
   `APPS_WEB_BASE_URL` was already imported via `maintainx.ts`. It
   isn't — `maintainx.ts` accepts `appsWebBaseUrl` as a function
   argument. Inlining inside `notifyClaimUpdate` (two lines:
   ``const baseUrl = env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info"``
   and `` `${baseUrl}/admin/damage/${encodeURIComponent(claim.claim_id)}` ``)
   matches the existing inline fallback pattern at line 1855 inside
   `tryCreateMaintainXIfMissing`.

4. **Eager fire-and-forget via `void notifyClaimUpdate(...)`** rather
   than threading `ctx` into `handleAddNote` / `handleStatusTransition`.
   The brief flagged this as the simpler choice; `notifyClaimUpdate`
   already swallows every error path, so an unawaited promise can't
   surface an unhandled-rejection warning. Matches Brief 32's
   customer-webhook posture.

5. **Recipient ordering: `site_email` before `rm_email` when both
   apply.** The brief specified the "both" case for notes but didn't
   pick an order. site_email-first matches the order operators see in
   the Update Location editor and reads top-down "the people on the
   ground first".

### Latent issues found

None blocking. Two notes:

- `getLocationContactInfo`'s existing helper still reads from
  `pricing_simple` (the post-Brief-49 single-query path). Brief 71
  switched the workorders-worker read path to direct `locations` reads
  (different rationale: site-number zero-padding mismatch on the
  pricing_simple→locations join key). The damage-worker contact-helper
  doesn't suffer from that bug because it never crosses the join; both
  columns are on the same row. No action required.
- The shape of `ClaimRow.location_pretty` is `string` (not
  `string | null`) per `packages/types/src/claims.ts:124` even though
  the manage-API JSON payload sometimes has null in the wild for very
  old rows. The webhook payload's `location_pretty` field is typed
  `string | null` and the runtime coerces nullish to null via
  `claim.location_pretty ?? null`. Compiler-side this is a no-op; it's
  defensive against the data drift.

### Validation results

- `pnpm typecheck` — **17/17 packages green** (no errors).
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — **bundle OK**, 1723.98 KiB raw /
  390.38 KiB gzipped (well under CF's 3 MiB free-tier compressed
  limit). `.tmp-build` cleaned up after.
- `pnpm --filter @splash/web build` — **succeeded**. Page sizes:
  `/admin/damage` 167 B / 105 kB First Load JS (unchanged at
  3-sig-fig precision); `/admin/damage/[id]` 4.17 kB / 109 kB First
  Load JS (unchanged at 3-sig-fig precision — the StatusActionPill
  import adds ~10 B but rounds out at this precision).
- Smoke tests (deferred to first post-deploy verification, per
  Phase 5.4):
  - Add a note from `/admin/damage/[id]` → expect a `[claim-update]
    POST` log line in CF Workers Logs with `change_type: "note"`,
    `recipients` non-empty for locations whose rm_email or
    site_email is set.
  - Transition into `Approved — Pending Quotes` from a non-GM
    session → expect a log line with
    `to_status: "Approved — Pending Quotes"` and `recipients`
    containing the location's `site_email`.
  - Visit `/admin/damage` with a claim in `Approved — Pending
    Quotes` → the amber "Needs quotes" pill renders beside the
    status text.

### Confirmations (per Report section of the brief)

- **`getLocationContactInfo`'s new shape doesn't break the Brief 32
  customer-webhook path.** Verified by reading line 2730 of
  `apps/damage-worker/src/index.ts`: the call site only reads
  `contact.site_email`; `rm_email` is silently ignored. Typecheck
  green confirms the widened type is structurally compatible.
- **The status→notifies map matches the documented behavior.** Five
  `to` statuses fire (`Pending GM Review`,
  `No Responsibility — Pending Review`, `Pending RM Review`,
  `Pending RM Quote Approval`, `Approved — Pending Quotes`); all
  others (admin escape hatches into `Approved — In House —*`,
  `Approved — Check Request Submitted`,
  `Approved — Submitted for Payment`, `Approved — Check Issued`,
  `Closed — *`) fall off the map and exit
  `notifyClaimUpdate` early. Brief 66 RM-revert paths fire because
  their destinations (`Pending GM Review`, `Pending RM Review`) ARE
  in the map.
- **Actor exclusion is case-insensitive and dedupes.** The
  `resolveRecipients` helper lowercases both `actorEmail` and each
  candidate before comparison, and uses `out.includes(norm)` as the
  dedupe guard. Empty array fall-through is preserved.

### Sample payloads

**Note added by `gm@example.com` on a claim at Binghamton (assumes
site_email = `binghamton-site@splashcarwashes.com` and rm_email =
`rm@splashcarwashes.com`):**

```json
{
  "change_type": "note",
  "claim_id": "CL-1aBc2dEf3GhI",
  "customer_name": "Jane Doe",
  "location_code": "binghamton",
  "location_pretty": "Binghamton",
  "admin_url": "https://splashcarwashes.info/admin/damage/CL-1aBc2dEf3GhI",
  "actor": { "email": "gm@example.com", "dc_role": "gm" },
  "note_text": "Customer called back; she wants the new repair date confirmed.",
  "recipients": [
    "binghamton-site@splashcarwashes.com",
    "rm@splashcarwashes.com"
  ],
  "candidates": {
    "rm_email": "rm@splashcarwashes.com",
    "site_email": "binghamton-site@splashcarwashes.com"
  }
}
```

**Status change `Pending GM Review → Approved — Pending Quotes`,
performed by an RM acting on a GM's claim. RM's email is excluded
from `recipients` because they own `rm_email`:**

```json
{
  "change_type": "status",
  "claim_id": "CL-9zYx8wVu7tSr",
  "customer_name": "John Smith",
  "location_code": "oswego",
  "location_pretty": "Oswego",
  "admin_url": "https://splashcarwashes.info/admin/damage/CL-9zYx8wVu7tSr",
  "actor": { "email": "rm@splashcarwashes.com", "dc_role": "rm" },
  "from_status": "Pending GM Review",
  "to_status": "Approved — Pending Quotes",
  "note_text": "Approving on GM's behalf — they're out today.",
  "recipients": ["oswego-site@splashcarwashes.com"],
  "candidates": {
    "rm_email": "rm@splashcarwashes.com",
    "site_email": "oswego-site@splashcarwashes.com"
  }
}
```

(Notice the second payload: `notifies = "gm"` per
`STATUS_NOTIFIES_NEXT["Approved — Pending Quotes"]`, so only
`site_email` is a candidate — the RM's address never enters the
recipients list. If the GM had performed this same transition,
`recipients` would still be `["oswego-site@splashcarwashes.com"]`
unless the GM personally owned that address, in which case the array
would be empty and PA would no-op.)

### Operator follow-up

1. Build the PA flow per `PRE_DEPLOY_DAMAGE.md` "Brief 101 —
   manage-page update notifications" section. Two sample payloads
   above can be pasted into "Use sample payload to generate schema"
   to get the dynamic-content shape right.
2. Bind the trigger URL:
   ```bash
   pnpm --filter @splash/damage-worker exec wrangler secret put CLAIM_UPDATE_WEBHOOK_URL
   ```
3. Smoke: add a note from `/admin/damage/[id]`, tail CF Workers Logs
   for the `[claim-update]` POST, verify PA flow ran and sent email.
4. Until the secret is bound, the worker silently no-ops the
   notification path — claim writes and the UI pill continue to work
   immediately on next push-triggered deploy.
