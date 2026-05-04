// suspicious_phones + phone_usage_log. Mirrors legacy/signupworker.js
// fraud-detection helpers.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SuspiciousPhoneRow,
  SuspiciousPhoneTier,
  PhoneUsageLogRow
} from "@splash/types/signups";

/**
 * Lookup an existing suspicious_phones row by phone (10-digit, no formatting).
 * Returns null when there's no row (most phones).
 *
 * Source: legacy/signupworker.js:246 suspiciousCheck.
 */
export async function getSuspiciousPhone(
  client: SupabaseClient,
  phone: string
): Promise<SuspiciousPhoneRow | null> {
  // SELECT all 9 columns of the authoritative SuspiciousPhoneRow shape.
  // Legacy only consulted `tier` + `usage_count`, but the new worker may
  // need `manually_flagged` to gate auto-mutation of admin rows.
  const { data, error } = await client
    .from("suspicious_phones")
    .select(
      "id,phone,tier,usage_count,first_seen,last_seen,updated_at,notes,manually_flagged"
    )
    .eq("phone", phone)
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as SuspiciousPhoneRow[];
  return rows[0] ?? null;
}

/**
 * Set tier + count on an existing suspicious_phones row, or insert one if
 * absent. Returns true on a successful write, false on no-op (skipped) or
 * non-fatal error.
 *
 * Preserves the legacy PATCH-then-INSERT sequence from
 * legacy/signupworker.js:460-526. Does NOT use upsert: legacy comment notes
 * the table may not have a unique constraint on `phone`, and upsert
 * requires onConflict to specify a unique column.
 *
 * BUG FIX vs LEGACY (Chunk 3 — explicit Josh directive):
 * Honors the `manually_flagged` immutability rule. When the existing row
 * has manually_flagged = true, this helper SKIPS the write entirely
 * (returns false). Admin-curated rows are immutable from worker code;
 * auto-detection logs but does not mutate.
 *
 * Rationale: manually_flagged = true rows are seed/admin entries — the
 * hardcoded Deny patterns ('0000000000', '1111111111', etc.) plus any
 * row an admin manually created or escalated. Auto-tier-escalation
 * against those rows would overwrite the admin's tier/count. The legacy
 * worker does NOT filter on manually_flagged before its PATCH and
 * therefore had this drift bug.
 *
 * Adds one extra SELECT per call (to check manually_flagged before the
 * PATCH) — fraud-detection writes are infrequent so the subrequest cost
 * is acceptable.
 */
export async function createOrUpdateSuspicious(
  client: SupabaseClient,
  args: { phone: string; tier: SuspiciousPhoneTier; count: number }
): Promise<boolean> {
  // Pre-check: honor manually_flagged immutability.
  const existing = await getSuspiciousPhone(client, args.phone);
  if (existing?.manually_flagged === true) {
    console.log(
      `createOrUpdateSuspicious: skipping write for ${args.phone} — row is manually_flagged`
    );
    return false;
  }

  const now = new Date().toISOString();
  const payload = {
    phone: args.phone,
    tier: args.tier,
    usage_count: args.count,
    last_seen: now,
    updated_at: now
  };

  // Existing row is auto-detected (or absent). UPDATE-then-INSERT.
  if (existing) {
    const updateResp = await client
      .from("suspicious_phones")
      .update(payload)
      .eq("phone", args.phone)
      .eq("manually_flagged", false) // belt-and-suspenders against TOCTOU
      .select();
    if (updateResp.error) {
      console.error("createOrUpdateSuspicious UPDATE failed:", updateResp.error);
      return false;
    }
    return (updateResp.data ?? []).length > 0;
  }

  // No row — INSERT (manually_flagged defaults false at the DB).
  const insertResp = await client
    .from("suspicious_phones")
    .insert(payload)
    .select();
  if (insertResp.error) {
    console.error("createOrUpdateSuspicious INSERT failed:", insertResp.error);
    return false;
  }
  return true;
}

/**
 * Bump usage_count + last_seen on an existing suspicious_phones row.
 * Source: legacy/signupworker.js:529 updateUsageCount.
 *
 * BUG FIX vs LEGACY (Chunk 3): WHERE clause filters on `manually_flagged
 * = false` so admin-curated rows are not silently mutated by the
 * auto-detection bump. Same rationale as createOrUpdateSuspicious.
 */
export async function updateUsageCount(
  client: SupabaseClient,
  phone: string,
  count: number
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error, data } = await client
    .from("suspicious_phones")
    .update({ usage_count: count, last_seen: now, updated_at: now })
    .eq("phone", phone)
    .eq("manually_flagged", false)
    .select();
  if (error) {
    console.error("updateUsageCount failed:", error);
    return false;
  }
  // 0 rows updated: either no row exists for this phone, or the row is
  // manually_flagged. Either way, the count bump is a no-op — caller
  // typically doesn't act on this (the count will catch up next time).
  return (data ?? []).length > 0;
}

/**
 * Append a row to phone_usage_log. Used for every signup attempt — allowed,
 * blocked, warned, or flagged.
 * Source: legacy/signupworker.js:561 logUsage.
 */
export async function logPhoneUsage(
  client: SupabaseClient,
  // Auto-generated `id` excluded from input. `timestamp` defaulted to now()
  // when caller omits it.
  row: Omit<PhoneUsageLogRow, "id" | "timestamp"> & { timestamp?: string }
): Promise<void> {
  const payload: Omit<PhoneUsageLogRow, "id"> = {
    ...row,
    timestamp: row.timestamp ?? new Date().toISOString()
  };
  const { error } = await client.from("phone_usage_log").insert(payload);
  if (error) {
    console.error("logPhoneUsage failed:", error);
    // Match legacy: log + swallow. Fraud-detection write failures
    // should not block the signup flow itself.
  }
}
