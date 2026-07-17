// Brief 101 — manage-page update notifications.
//
// Sibling module to `transitions.ts`: the two policy tables live together
// so future readers find them in one place. `transitions.ts` answers
// "who is allowed to move a claim from A to B"; this file answers
// "when a claim lands at status X (or a note is added), who needs to
// know about it".
//
// Fail-soft posture matches the existing `CUSTOMER_CLAIM_WEBHOOK_URL`
// (Brief 32 / 48) and `DAILY_SUMMARY_WEBHOOK_URL` (Brief 65) webhooks:
// unbound secret → no notification, no error, claim writes unaffected.
// All thrown errors inside the fire helper are logged and swallowed.

import type { ClaimStatus } from "@splash/types/claims";

/**
 * Status-to-next-actor map. Keyed by `to` status because every transition
 * that lands at one of these statuses needs the same next-actor regardless
 * of the path taken (forward step, Brief 66 RM revert, admin escape hatch,
 * reopen). `gm` resolves to the location's `site_email`; `rm` resolves to
 * `rm_email`. Statuses not in this map don't fire a status-change
 * notification (finance / closed / vestigial states).
 *
 * Adding a new ClaimStatus to the union does NOT silently bypass
 * notifications — the type below uses Partial<Record<...>> so a missing
 * key is fine, but reviewers should consciously decide whether the new
 * status warrants a notify when they add it to the transitions table.
 */
export const STATUS_NOTIFIES_NEXT: Partial<Record<ClaimStatus, "gm" | "rm">> = {
  "Pending GM Review": "gm",
  "No Responsibility — Pending Review": "gm",
  "Pending RM Review": "rm",
  "Pending RM Quote Approval": "rm",
  "Approved — Pending Quotes": "gm"
};

export type ClaimUpdateChangeType = "note" | "status";

export interface ClaimUpdateWebhookPayload {
  change_type: ClaimUpdateChangeType;
  claim_id: string;
  customer_name: string | null;
  location_code: string;
  location_pretty: string | null;
  /** Direct link to the apps/web admin claim detail page. */
  admin_url: string;
  actor: { email: string; dc_role: string | null };
  // Populated for status changes:
  from_status?: string;
  to_status?: string;
  /**
   * Populated for notes AND for status changes that carried an
   * accompanying note text. Truncated to 5000 chars (same ceiling
   * the note + transition handlers already enforce on input).
   */
  note_text?: string;
  /**
   * Resolved server-side, with actor's email excluded and deduped.
   * Lowercased. PA loops over this array to send emails; an empty array
   * means "fire was attempted but had nobody to email" and PA no-ops.
   */
  recipients: string[];
  /**
   * For audit / debug: which of the two location addresses were
   * candidates before exclusion. Helpful when verifying "why did /
   * didn't this user get an email".
   */
  candidates: { rm_email: string | null; site_email: string | null };
}

/**
 * Notification target. `"both"` is used for notes (notify GM and RM);
 * status changes pass either `"gm"` or `"rm"` (never `"both"` today,
 * but the helper accepts it defensively).
 */
export type NotificationTarget = "gm" | "rm" | "both";

/**
 * Build the recipient array for a notification, applying the
 * case-insensitive actor-self-exclusion. Returns lowercased addresses,
 * deduped, preserving "site_email before rm_email" order when both are
 * present (the same order operators see in the location editor).
 */
export function resolveRecipients(
  notifies: NotificationTarget,
  contacts: { rm_email: string | null; site_email: string | null },
  actorEmail: string
): string[] {
  const actor = (actorEmail ?? "").trim().toLowerCase();
  const out: string[] = [];
  const push = (addr: string | null): void => {
    if (!addr) return;
    const norm = addr.trim().toLowerCase();
    if (!norm) return;
    if (norm === actor) return;
    if (out.includes(norm)) return;
    out.push(norm);
  };
  if (notifies === "gm" || notifies === "both") push(contacts.site_email);
  if (notifies === "rm" || notifies === "both") push(contacts.rm_email);
  return out;
}

/**
 * Fire-and-forget POST of the payload to the webhook URL. Fail-soft:
 * try/catch wraps the fetch, non-2xx is logged but never thrown,
 * abort / network errors are logged but swallowed. 15s timeout matches
 * the daily-summary cron posture (Brief 65).
 */
export async function fireClaimUpdateWebhook(
  webhookUrl: string,
  payload: ClaimUpdateWebhookPayload
): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Brief 101 fix v2 — bounded at 5s because this fetch is now awaited in
      // handleAddNote / handleStatusTransition (not waitUntil'd), so it sits on
      // the response's critical path. Fail-soft either way: a timeout is caught
      // below and the note/transition still succeeds.
      signal: AbortSignal.timeout(5_000)
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

/* ============================================================
 * Brief 102 — internal new-claim notification
 * ============================================================
 *
 * Parallel webhook to the Brief 32 `CUSTOMER_CLAIM_WEBHOOK_URL` (customer
 * confirmation email). Fired by `handleClaimSubmission` after the customer
 * webhook in the same post-submit block, when
 * `INTERNAL_NEW_CLAIM_WEBHOOK_URL` is bound. Recipients are the four roles
 * resolved server-side from `pricing_simple` (rm_email / site_email /
 * am_email) plus the operator-configured `INCIDENTS_EMAIL` [vars] entry.
 *
 * No actor exclusion — the claim submitter is the public customer; their
 * email is not a location contact. Same fail-soft posture as the customer
 * webhook: unbound secret → no notification, no error, claim submission
 * unaffected.
 */

/**
 * One row of the `photos[]` array on the internal new-claim payload.
 * Field mapping note: the D1 `claim_photos` row exposes `content_type`
 * and `filename`; this shape renames them to `mime` and
 * `original_filename` for PA-friendly naming, and stamps `uploaded_at`
 * from the claim's `submitted_at` (photos arrive with the claim, so the
 * claim's submission timestamp is the authoritative upload time at
 * submit-time — D1 doesn't carry a per-photo timestamp).
 */
export interface ClaimPhotoForWebhook {
  url: string;
  mime: string | null;
  original_filename: string | null;
  /** 'Damage' | 'Quote' | 'Receipt' | 'Check Request' | ... */
  photo_type: string | null;
  uploaded_at: string;
}

export interface InternalNewClaimPayload {
  claim_id: string;
  submitted_at: string;
  location_code: string;
  location_pretty: string | null;
  /** Direct link to the apps/web admin claim detail page. */
  admin_url: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  /** Assembled "year make model - color" string, or "—" when all empty. */
  vehicle: string;
  damage_type: string;
  damage_other: string | null;
  issue_description: string | null;
  /**
   * Resolved server-side. Lowercased, deduped, nulls dropped. PA loops over
   * this array to send emails; an empty array means "fire was attempted but
   * had nobody to email" and PA no-ops.
   */
  recipients: string[];
  /**
   * For audit / debug: which addresses were the source candidates before
   * dedupe. Helpful when verifying "why did / didn't this user get an email".
   */
  candidates: {
    rm_email: string | null;
    site_email: string | null;
    am_email: string | null;
    incidents_email: string | null;
  };
  summary_pdf_url: string;
  /**
   * Omitted when the PDF is larger than the customer-webhook ceiling
   * (~3 MB raw, kept under PA's common 4 MB inbound limit after base64
   * expansion). PA can still fetch the URL when the inline attachment
   * is unavailable.
   */
  summary_pdf_base64?: string;
  photos: ClaimPhotoForWebhook[];
}

/**
 * Build the recipient array for the internal new-claim notification.
 * Lowercases each address, drops blanks, dedupes. No actor exclusion
 * (customer is the actor and is not a location contact). Order:
 * rm_email → site_email → am_email → incidents_email, so the field
 * recipients appear before the broadcast inbox.
 */
export function resolveInternalRecipients(
  contacts: {
    rm_email: string | null;
    site_email: string | null;
    am_email: string | null;
  },
  incidentsEmail: string | null
): string[] {
  const out: string[] = [];
  const push = (addr: string | null | undefined): void => {
    if (!addr) return;
    const norm = addr.trim().toLowerCase();
    if (!norm) return;
    if (out.includes(norm)) return;
    out.push(norm);
  };
  push(contacts.rm_email);
  push(contacts.site_email);
  push(contacts.am_email);
  push(incidentsEmail);
  return out;
}

/**
 * Fire-and-forget POST of the internal new-claim payload. Same fail-soft
 * posture as `fireClaimUpdateWebhook` (Brief 101) and
 * `fireCustomerClaimWebhook` (Brief 32): try/catch around the fetch,
 * non-2xx logged but never thrown, 15s timeout.
 */
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

/* ============================================================
 * Brief 140 — D1-failure operator alert
 * ============================================================
 *
 * Fired by `handleClaimSubmission` when the D1 INSERT batch threw and
 * `d1Success` stayed false. Shares the `INTERNAL_NEW_CLAIM_WEBHOOK_URL`
 * with the Brief 102 internal new-claim notification; PA branches on the
 * top-level `alert_type` discriminator field to choose the right email
 * template ("new claim received" vs "D1 failure — orphan claim, manual
 * backfill required").
 *
 * Recipients are intentionally narrow: ONLY `INCIDENTS_EMAIL`. This is
 * an internal infra alert ("the claim wasn't persisted to admin
 * storage"), not a field-side claim notification — looping the
 * location's RM / GM in would just confuse them.
 *
 * Same fail-soft + 15s `AbortSignal` posture as the Brief 101 / 102
 * helpers. Returns void; never throws. Callers should wrap in
 * `ctx.waitUntil()` so the customer response isn't blocked on the
 * webhook round-trip.
 */

export interface D1FailureAlertPayload {
  alert_type: "d1_failed";
  claim_id: string;
  location_code: string;
  customer_name: string;
  customer_email: string;
  /**
   * The R2 key for the canonical submission JSON archive
   * (`submissions/{claim_id}.json`) — the operator's recovery source for
   * a one-off backfill INSERT. No HTTP serve endpoint today; pasted into
   * the R2 bucket UI to retrieve.
   */
  r2_submission_url: string;
  /**
   * Customer-facing PDF copy. Omitted when PDF generation also failed
   * (vanishingly rare — would mean both D1 and PDF pipelines threw).
   */
  summary_pdf_url?: string;
  /** D1 throw message, truncated to 500 chars for log-friendly emails. */
  error_message: string;
  /**
   * Resolved server-side. Single-entry array when INCIDENTS_EMAIL is
   * bound; empty array means "fire was attempted but no incidents inbox
   * configured" and PA no-ops.
   */
  recipients: string[];
}

export async function fireD1FailureAlert(args: {
  env: { INTERNAL_NEW_CLAIM_WEBHOOK_URL?: string; INCIDENTS_EMAIL?: string };
  claimData: {
    claimId: string;
    location: string;
    customerName: string;
    customerEmail: string;
  };
  summaryPdfUrl?: string;
  errorMessage: string;
}): Promise<void> {
  const { env, claimData, summaryPdfUrl, errorMessage } = args;
  if (!env.INTERNAL_NEW_CLAIM_WEBHOOK_URL) return;

  const incidents = (env.INCIDENTS_EMAIL ?? "").trim().toLowerCase();
  const recipients = incidents ? [incidents] : [];

  const payload: D1FailureAlertPayload = {
    alert_type: "d1_failed",
    claim_id: claimData.claimId,
    location_code: claimData.location,
    customer_name: claimData.customerName,
    customer_email: claimData.customerEmail,
    r2_submission_url: `submissions/${claimData.claimId}.json`,
    ...(summaryPdfUrl ? { summary_pdf_url: summaryPdfUrl } : {}),
    error_message: errorMessage.slice(0, 500),
    recipients
  };

  try {
    const res = await fetch(env.INTERNAL_NEW_CLAIM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      console.error(
        `[d1-failure] POST failed for ${claimData.claimId}: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(
      `[d1-failure] POST error for ${claimData.claimId}:`,
      err
    );
  }
}
