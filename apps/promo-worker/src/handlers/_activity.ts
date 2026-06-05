// Brief 155 — shared activity-log helper.
//
// Single insert point for `promo_activity_log` rows. Every promo-writes
// handler in promo-writes.ts (and the auto-status flip in handlePatchTicket
// / handleAddAssignee) routes through this helper so the activity_type
// enum, the details JSONB shape, and the fail-soft posture stay consistent.
//
// Fail-soft on intent: activity log is observability, not correctness. A
// failed insert here MUST NOT fail the parent write — the row already
// landed. Log loudly via console.warn / console.error and return.
//
// Underscore prefix on the filename signals "internal helper module"
// (same convention used elsewhere in Splash worker code where shared
// helpers sit alongside the handlers that consume them).

import type { Env } from "../index.js";

/**
 * Allow-list of activity_type values that match the `promo_activity_log`
 * CHECK constraint in supabase/promo-tables.sql. Brief 155 introduces no
 * new values — every type here was already declared at Brief 153.
 */
export type PromoActivityType =
  | "created"
  | "status_changed"
  | "assignment_changed"
  | "ticket_updated"
  | "roadblocks_updated"
  | "internal_note_updated"
  | "material_added"
  | "material_removed"
  | "ptp_updated"
  | "location_marked_complete"
  | "location_marked_incomplete"
  | "announcement_sent";

/**
 * Insert one `promo_activity_log` row. Fail-soft: logs and returns rather
 * than throwing so the parent write never gets rolled back by an
 * observability failure.
 *
 * @param env             worker env (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)
 * @param promoId         the promo this activity belongs to
 * @param actorUserId     auth.users.id of the actor, or null for system
 *                        actors (cron, auto-flips can pass the operator id)
 * @param activityType    one of the CHECK-constraint allow-list values
 * @param details         free-form JSONB payload — keep keys camelCase to
 *                        match the rest of the worker's response shape
 */
export async function logActivity(
  env: Env,
  promoId: string,
  actorUserId: string | null,
  activityType: PromoActivityType,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    const url = new URL("/rest/v1/promo_activity_log", env.SUPABASE_URL);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        promo_id: promoId,
        actor_user_id: actorUserId,
        activity_type: activityType,
        details
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(
        "[promo.activity] insert failed (non-fatal)",
        activityType,
        resp.status,
        errText
      );
    }
  } catch (err) {
    console.warn("[promo.activity] insert threw (non-fatal)", activityType, err);
  }
}
