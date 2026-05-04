// User permissions + tool grants. Mirrors legacy/sysadmin.js helpers.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  UserPermissionRow,
  UserRole,
  UserToolAccessRow,
  ToolName
} from "@splash/types/auth";

/**
 * Compact user-search row returned by searchUsersByEmail. Drives the sysadmin
 * UserPicker dropdown — includes role + tools so the picker can show current
 * grants alongside the email match.
 */
export interface UserSearchRow {
  user_id: string;
  email: string;
  role: UserRole | null;
  tools: ToolName[];
  must_change_password: boolean;
}

/**
 * All user_permissions rows for one user (a user may have multiple — one per
 * location_admin location). Source: legacy/sysadmin.js:254.
 */
export async function getUserPermissions(
  client: SupabaseClient,
  userId: string
): Promise<UserPermissionRow[]> {
  const { data, error } = await client
    .from("user_permissions")
    .select("user_id,email,role,location_code,must_change_password,created_at")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as unknown as UserPermissionRow[];
}

/**
 * True if the user has a super_admin row in user_permissions.
 * Source: legacy/sysadmin.js:144.
 */
export async function isSuperAdmin(
  client: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data, error } = await client
    .from("user_permissions")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ role: string }>).length > 0;
}

/**
 * All tool grants for a user (sorted by tool name in legacy).
 * Source: legacy/sysadmin.js:261.
 */
export async function listToolGrants(
  client: SupabaseClient,
  userId: string
): Promise<UserToolAccessRow[]> {
  const { data, error } = await client
    .from("user_tool_access")
    .select("user_id,tool,granted_at,granted_by,notes")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as unknown as UserToolAccessRow[];
}

/**
 * True if user has an explicit grant for `tool`. Does NOT consider
 * super_admin bypass — callers compose with isSuperAdmin() if they want
 * the bypass behavior. Source: legacy/performancetracker.js:154.
 */
export async function hasToolGrant(
  client: SupabaseClient,
  userId: string,
  tool: ToolName
): Promise<boolean> {
  const { data, error } = await client
    .from("user_tool_access")
    .select("tool")
    .eq("user_id", userId)
    .eq("tool", tool)
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ tool: string }>).length > 0;
}

/* ============================================================
 * Writes (sysadmin-only)
 * ============================================================ */

/**
 * Idempotent grant. Returns whether a new row was inserted.
 * Source: legacy/sysadmin.js:306 apiGrantTool.
 *
 * Uses PostgREST Prefer: resolution=ignore-duplicates with on_conflict on
 * the (user_id, tool) composite PK, which supabase-js exposes as
 * `.upsert({...}, { onConflict: 'user_id,tool', ignoreDuplicates: true })`.
 */
export async function grantTool(
  client: SupabaseClient,
  args: { userId: string; tool: ToolName; grantedBy: string; notes?: string }
): Promise<{ ok: true; was_new: boolean }> {
  const { data, error } = await client
    .from("user_tool_access")
    .upsert(
      {
        user_id: args.userId,
        tool: args.tool,
        granted_by: args.grantedBy,
        notes: args.notes ?? "Granted via Splash Admin"
      },
      { onConflict: "user_id,tool", ignoreDuplicates: true }
    )
    .select();
  if (error) throw new Error(`Grant failed: ${error.message}`);
  return { ok: true, was_new: Array.isArray(data) && data.length > 0 };
}

/**
 * Delete a tool grant. Returns whether a row was actually present.
 * Source: legacy/sysadmin.js:349 apiRevokeTool.
 */
export async function revokeTool(
  client: SupabaseClient,
  args: { userId: string; tool: ToolName }
): Promise<{ ok: true; was_present: boolean; before: UserToolAccessRow | null }> {
  // Capture before-state for the audit log — caller wires that up.
  const beforeResp = await client
    .from("user_tool_access")
    .select("user_id,tool,granted_at,granted_by,notes")
    .eq("user_id", args.userId)
    .eq("tool", args.tool)
    .limit(1);
  if (beforeResp.error) throw beforeResp.error;
  const before = ((beforeResp.data ?? []) as unknown as UserToolAccessRow[])[0] ?? null;

  const { error } = await client
    .from("user_tool_access")
    .delete()
    .eq("user_id", args.userId)
    .eq("tool", args.tool);
  if (error) throw new Error(`Revoke failed: ${error.message}`);

  return { ok: true, was_present: !!before, before };
}

/**
 * Replace all user_permissions rows for a user with one row of the given role.
 * Source: legacy/sysadmin.js:383 apiSetRole.
 *
 * Caller is responsible for resolving the user's email (we need it because
 * user_permissions.email is NOT NULL).
 *
 * SECURITY (Josh's policy, see @splash/auth/index.ts): the existing
 * must_change_password value is PRESERVED across the role change.
 *
 * Legacy/sysadmin.js apiSetRole hardcoded `must_change_password: false` on
 * the new row, which silently wiped the forced-reset gate for any user
 * mid-reset who got re-roled — same bug class as the dashboard SSO bypass
 * and the admin reset-without-flag bug. Preserving the flag means:
 *   • User has completed forced reset (flag=false): stays false. No nag.
 *   • User has NOT completed forced reset (flag=true): stays true. Gate
 *     remains in place. Admin role change does not bypass it.
 *
 * The "any row has true" semantic matches how every gate reads the flag
 * (legacy/signupworker.js:737 — `perms.some(p => p.must_change_password)`).
 */
export async function setRole(
  client: SupabaseClient,
  args: {
    userId: string;
    email: string;
    role: UserRole;
    /** Required for location_admin; ignored for super_admin. */
    locationCode?: string | null;
  }
): Promise<UserPermissionRow[]> {
  // Read existing must_change_password BEFORE the delete so we can
  // preserve it on the new row.
  const beforeResp = await client
    .from("user_permissions")
    .select("must_change_password")
    .eq("user_id", args.userId);
  if (beforeResp.error) throw beforeResp.error;
  const beforeRows = (beforeResp.data ?? []) as Array<{ must_change_password: boolean | null }>;
  const preservedMustChange = beforeRows.some((r) => r.must_change_password === true);

  // Wipe existing rows.
  const del = await client
    .from("user_permissions")
    .delete()
    .eq("user_id", args.userId);
  if (del.error) throw del.error;

  // Insert new row with the preserved flag.
  const insertRow: Partial<UserPermissionRow> = {
    user_id: args.userId,
    email: args.email,
    role: args.role,
    must_change_password: preservedMustChange,
    location_code: args.role === "location_admin" ? (args.locationCode ?? null) : null
  };

  const { data, error } = await client
    .from("user_permissions")
    .insert(insertRow)
    .select();
  if (error) throw new Error(`Set role failed: ${error.message}`);
  return (data ?? []) as unknown as UserPermissionRow[];
}

/**
 * Delete all user_permissions rows for a user (clearing all roles).
 * Source: legacy/sysadmin.js:404.
 */
export async function clearRole(
  client: SupabaseClient,
  userId: string
): Promise<UserPermissionRow[]> {
  // Capture before-state for audit.
  const beforeResp = await client
    .from("user_permissions")
    .select("user_id,email,role,location_code,must_change_password,created_at")
    .eq("user_id", userId);
  if (beforeResp.error) throw beforeResp.error;
  const before = (beforeResp.data ?? []) as unknown as UserPermissionRow[];

  const { error } = await client
    .from("user_permissions")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
  return before;
}

/**
 * Set must_change_password to a specific value across ALL user_permissions
 * rows for a user. Legacy/signupworker.js:690 only ever cleared (false);
 * Josh's policy adds a path that sets true (admin-triggered reset). The
 * boolean parameter covers both directions.
 *
 * Note: user_permissions has multiple rows per user (one per location for
 * location_admins). Legacy updates ALL of them — preserve that.
 */
export async function setMustChangePassword(
  client: SupabaseClient,
  userId: string,
  value: boolean
): Promise<void> {
  const { error } = await client
    .from("user_permissions")
    .update({ must_change_password: value })
    .eq("user_id", userId);
  if (error) throw error;
}

/**
 * Insert a single user_permissions row for a NEWLY-onboarded user.
 *
 * SECURITY (Josh's policy, see @splash/auth/index.ts): the default for
 * `mustChangePassword` is TRUE. Newly-onboarded users always hit the
 * forced-reset gate on first login because their initial password was
 * chosen by an admin. Pass `mustChangePassword: false` only with explicit
 * justification.
 *
 * Use this helper from sysadmin's apiCreateUser path. Existing-user role
 * reassignment uses `setRole` instead (which preserves legacy
 * mustChangePassword=false default for that distinct intent).
 */
export async function createUserPermissionsRow(
  client: SupabaseClient,
  args: {
    userId: string;
    email: string;
    role: UserRole;
    /** Required for location_admin; ignored for super_admin. */
    locationCode?: string | null;
    /** Default TRUE — see policy block above. */
    mustChangePassword?: boolean;
  }
): Promise<UserPermissionRow> {
  const insertRow: Partial<UserPermissionRow> = {
    user_id: args.userId,
    email: args.email,
    role: args.role,
    must_change_password: args.mustChangePassword ?? true,
    location_code: args.role === "location_admin" ? (args.locationCode ?? null) : null
  };
  const { data, error } = await client
    .from("user_permissions")
    .insert(insertRow)
    .select()
    .single();
  if (error) throw new Error(`Create user_permissions failed: ${error.message}`);
  return data as unknown as UserPermissionRow;
}

/* ============================================================
 * User search (sysadmin UserPicker — Brief 18)
 * ============================================================ */

/**
 * Substring search over auth_unified by email, returning compact rows for
 * the sysadmin UserPicker typeahead. Used by GET /sysadmin/api/users.
 *
 * Empty / whitespace-only query returns []. Worker-side enforcement of the
 * super_admin gate is the auth control; this helper does no scoping.
 *
 * Source view: auth_unified — already the canonical session-shape source
 * across the workers (see auth-context.ts). Including role + tools lets
 * the picker surface "current grants" alongside the email match.
 */
export async function searchUsersByEmail(
  client: SupabaseClient,
  query: string,
  limit = 20
): Promise<UserSearchRow[]> {
  const needle = (query ?? "").trim();
  if (needle.length === 0) return [];

  // Escape wildcard chars so a stray '%' or ',' doesn't widen / break the OR.
  const escaped = needle.replace(/[%_,()*]/g, "");
  if (escaped.length === 0) return [];

  const { data, error } = await client
    .from("auth_unified")
    .select("user_id,email,role,tools,must_change_password")
    .ilike("email", `%${escaped}%`)
    .order("email", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    user_id: string;
    email: string;
    role: UserRole | null;
    tools: string[] | null;
    must_change_password: boolean | null;
  }>;
  return rows.map((r) => ({
    user_id: r.user_id,
    email: r.email,
    role: r.role,
    tools: (r.tools ?? []) as ToolName[],
    must_change_password: r.must_change_password === true
  }));
}
