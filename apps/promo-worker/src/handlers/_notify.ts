// Brief 162 — promo create → IT notification email.
//
// Single fire site for the "new promo submitted" notification that goes
// to every IT-tier user (promo_role IN {'it', 'super_admin'}) right
// after `handleCreatePromo` returns 201 to the operator. Rides the
// Brief 127 `outbound_emails` queue — one row per recipient — so a
// single Power Automate flow drains and sends. Zero new infrastructure
// vs. Brief 157's announcement send.
//
// Fail-soft on every layer:
//   - Recipient resolution failure → log + skip the entire fan-out.
//   - Empty recipient list → log + return cleanly (valid v1 state when
//     no IT users exist yet).
//   - Per-recipient enqueue failure → log + collect; never blocks other
//     recipients; never blocks the parent response (this whole helper
//     runs inside `ctx.waitUntil` from handleCreatePromo).
//
// Dedup posture: the `outbound_emails` unique index on
// `(source_worker, source_kind, source_id, recipient)` makes re-firing
// the same `(promo-worker, promo-create-it-notify, promoId, recipient)`
// tuple a no-op via PostgREST `Prefer: resolution=ignore-duplicates`.
// Each promo notifies each IT user at most once.
//
// Underscore prefix on the filename signals "internal helper module"
// (same convention as `_activity.ts`).

import { enqueueOutboundEmail } from "@splash/db-supabase";
import type { Env } from "../index.js";
import { renderCreateNotify } from "../announce/render-create-notify.js";

interface AuthUnifiedItRow {
  email: string | null;
  promo_role: string | null;
}

/**
 * Resolve the IT notification recipient list — every `auth_unified` user
 * whose `promo_role` is `'it'` or `'super_admin'` AND whose email is
 * non-null. Deduplicated case-insensitive (first-occurrence casing
 * preserved) and returned sorted.
 *
 * Returns an empty array (not throws) when zero recipients match; the
 * caller logs + skips. Throws on transport / auth failures so the
 * caller can surface them in logs and skip the fan-out.
 */
export async function resolveItNotificationRecipients(
  env: Env
): Promise<string[]> {
  const url = new URL("/rest/v1/auth_unified", env.SUPABASE_URL);
  url.searchParams.set("select", "email,promo_role");
  url.searchParams.set("promo_role", "in.(it,super_admin)");
  url.searchParams.set("email", "not.is.null");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `auth_unified IT lookup: ${resp.status} ${resp.statusText} — ${errText.slice(0, 200)}`
    );
  }
  const rows = (await resp.json().catch(() => [])) as AuthUnifiedItRow[];

  const dedup = new Map<string, string>(); // lowercase → original casing
  for (const r of rows) {
    if (typeof r.email !== "string") continue;
    const trimmed = r.email.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!dedup.has(key)) dedup.set(key, trimmed);
  }
  return Array.from(dedup.values()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
}

/**
 * Resolve the apps/web origin for building admin links inside the
 * notification body. Operators click these from email — workers.dev
 * origins MUST get rewritten to production. `staging.splashcarwashes.info`
 * passes through so staging-test promos link to staging apps/web.
 *
 * Mirrors damage-worker's `resolveAdminBase` helper. Pass `null` for
 * `request` (we're inside `ctx.waitUntil` without easy access to the
 * inbound URL post-response) to fall through to env.APPS_WEB_BASE_URL.
 */
function resolveAppsWebBase(env: Env, request: Request | null): string {
  const fallback = env.APPS_WEB_BASE_URL || "https://splashcarwashes.info";
  if (!request) return fallback;
  try {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".workers.dev")) {
      return fallback;
    }
    if (url.hostname.endsWith("splashcarwashes.info")) {
      return `${url.protocol}//${url.hostname}`;
    }
  } catch {
    // fall through
  }
  return fallback;
}

export interface FireCreateNotifyInput {
  promoId: string;
  title: string;
  promoType: string;
  posBehavior: string | null;
  priority: string;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  locationCodes: string[];
  submitterEmail: string;
}

/**
 * Fan out one `outbound_emails` row per IT recipient. ALL failures are
 * caught + logged here; this function never throws. Designed to be
 * called inside `ctx.waitUntil(...)` so the parent response returns
 * immediately while the fan-out runs in background.
 */
export async function fireCreateNotify(
  env: Env,
  request: Request | null,
  input: FireCreateNotifyInput
): Promise<void> {
  let recipients: string[];
  try {
    recipients = await resolveItNotificationRecipients(env);
  } catch (err) {
    console.error(
      "[promo.create] IT recipient resolution failed (fail-soft):",
      err
    );
    return;
  }

  if (recipients.length === 0) {
    console.log(
      `[promo.create] no IT recipients — skipping notify for promo ${input.promoId}`
    );
    return;
  }

  const appsWebBase = resolveAppsWebBase(env, request);
  const ticketUrl = `${appsWebBase}/admin/promotions/${input.promoId}/ticket`;
  const liveViewUrl = `${appsWebBase}/admin/promotions/${input.promoId}`;

  let rendered: ReturnType<typeof renderCreateNotify>;
  try {
    rendered = renderCreateNotify({
      promoId: input.promoId,
      title: input.title,
      promoType: input.promoType,
      posBehavior: input.posBehavior,
      priority: input.priority,
      proposedStartDate: input.proposedStartDate,
      proposedEndDate: input.proposedEndDate,
      requestedGoLiveDate: input.requestedGoLiveDate,
      locationCodes: input.locationCodes,
      submitterEmail: input.submitterEmail,
      ticketUrl,
      liveViewUrl
    });
  } catch (err) {
    console.error(
      "[promo.create] notification render failed (fail-soft):",
      err
    );
    return;
  }

  const subject = `New promo: ${input.title}`;
  const failed: string[] = [];
  let enqueued = 0;

  for (const recipient of recipients) {
    try {
      await enqueueOutboundEmail(env, {
        source_worker: "promo-worker",
        source_kind: "promo-create-it-notify",
        source_id: input.promoId,
        recipient,
        subject,
        body_text: rendered.plainText,
        body_html: rendered.html,
        attachments: []
      });
      enqueued += 1;
    } catch (err) {
      console.error(
        `[promo.create] notify enqueue failed for ${recipient}:`,
        err
      );
      failed.push(recipient);
    }
  }

  if (failed.length > 0) {
    console.error(
      `[promo.create] IT notify partial — promo=${input.promoId} enqueued=${enqueued}/${recipients.length} failed=${JSON.stringify(failed)}`
    );
  } else {
    console.log(
      `[promo.create] IT notify ok — promo=${input.promoId} enqueued=${enqueued}`
    );
  }
}
