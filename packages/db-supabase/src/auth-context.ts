// Single-query auth context loader.
//
// Reads the `auth_unified` Supabase view and returns the camelCased Session
// shape, or null when the user has no row (typical for users that
// authenticated but never had a permissions row created).
//
// SECURITY: this is the canonical query path for every auth context read.
// Do NOT query user_permissions / user_tool_access / damage_claim_user_roles /
// damage_claim_user_locations directly anywhere in worker code; the view
// aggregates them with the correct semantics:
//   - role:                MAX over user_permissions rows
//   - locations:           array_agg over user_permissions.location_code
//   - must_change_password: BOOL_OR over user_permissions rows
//   - tools:               array_agg over user_tool_access
//   - dc_role:             damage_claim_user_roles.dc_role (CHECK-constrained
//                          to gm|rm|admin|super_admin)
//   - dc_locations:        array_agg over damage_claim_user_locations
//
// IMPORTANT: damage_claim_user_roles.must_change_password (if it exists) is
// INTENTIONALLY IGNORED by the view. user_permissions.must_change_password
// is the canonical source. See @splash/auth/index.ts security contract item #5.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolName, UserRole } from "@splash/types/auth";
import type { DamageRole } from "@splash/types/claims";
import type { PromoRole } from "@splash/types/promo";
import type { Session } from "@splash/types/session";

/** Raw row shape returned by the view. Mapped to camelCase Session below. */
interface AuthUnifiedRow {
  user_id: string;
  email: string;
  role: UserRole;
  locations: string[] | null;
  must_change_password: boolean;
  tools: string[] | null;
  dc_role: DamageRole | null;
  dc_locations: string[] | null;
  promo_role: PromoRole | null;
}

/**
 * Load the Session for a user_id. Returns null when the user has no row in
 * auth_unified (no permissions, no tools — effectively no session).
 *
 * Use the service-key client — auth_unified has RLS enabled, but we want
 * to read every authenticated user's row from worker code regardless of
 * RLS policies.
 */
export async function getAuthContext(
  client: SupabaseClient,
  userId: string
): Promise<Session | null> {
  const { data, error } = await client
    .from("auth_unified")
    .select(
      "user_id,email,role,locations,must_change_password,tools,dc_role,dc_locations,promo_role"
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as AuthUnifiedRow;
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password,
    tools: (row.tools ?? []) as ToolName[],
    locations: row.locations ?? [],
    dcRole: row.dc_role,
    dcLocations: row.dc_locations ?? [],
    promoRole: row.promo_role
  };
}
