// maxpass_signups inserts + reads. Source: legacy/signupworker.js:392-457.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MaxpassSignupInsert } from "@splash/types/signups";

/**
 * Insert one maxpass_signups row. Mirrors legacy/signupworker.js:392 but
 * delegates UUID generation to the caller (kept out of the data layer so
 * tests can pin the token).
 */
export async function insertSignup(
  client: SupabaseClient,
  row: MaxpassSignupInsert
): Promise<void> {
  const { error } = await client
    .from("maxpass_signups")
    .insert(row);
  if (error) throw error;
}

/**
 * Count of existing successful submissions for a phone number — drives
 * fraud-detection tier escalation. Returns the row count, not the rows
 * themselves (legacy uses the same .length check).
 *
 * Source: legacy/signupworker.js:289 usageCheck.
 */
export async function countSignupsByPhone(
  client: SupabaseClient,
  phone: string
): Promise<number> {
  const { data, error, count } = await client
    .from("maxpass_signups")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone);
  if (error) throw error;
  // `count` is non-null with `count: "exact"`. Fall back to data.length
  // as a defensive default.
  return count ?? (Array.isArray(data) ? data.length : 0);
}
