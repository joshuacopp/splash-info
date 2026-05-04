// Auth / role / tool-access types.
// Column names extracted directly from legacy/sysadmin.js.

/**
 * Roles used by the legacy code (legacy/sysadmin.js:304 VALID_ROLES).
 *
 *     const VALID_ROLES = new Set(["super_admin", "location_admin"]);
 *
 * The migration plan §5 step 1 also lists "regional_manager", "area_manager",
 * "site_manager" as user roles — but those aren't roles in
 * `user_permissions.role`. They appear as relationship columns on
 * `pricing_simple` (rm_email, am_email, site_email) and `locations`
 * (regional_manager, area_manager). They identify *people who manage that
 * location*, not authorization roles.
 *
 * Treating only super_admin and location_admin as real roles here. See
 * Step 5A findings for the open question.
 */
export type UserRole = "super_admin" | "location_admin";

export const USER_ROLES: readonly UserRole[] = ["super_admin", "location_admin"] as const;

/**
 * Tool grants written into `user_tool_access.tool`.
 * Source: legacy/sysadmin.js:303 VALID_TOOLS.
 *
 *     const VALID_TOOLS = new Set(["pricing", "claims", "pertrack"]);
 *
 * Note: "claims" gates access to /manage/* in damage-worker (see plan §5
 * step 5 — checkToolAccess generalization). "pricing" gates /admin/* in
 * signup-worker. "pertrack" gates /pertrack/* in performance-worker.
 * sysadmin-worker is super_admin-only and not gated by a tool grant.
 */
export type ToolName = "pricing" | "claims" | "pertrack";

export const VALID_TOOLS: readonly ToolName[] = ["pricing", "claims", "pertrack"] as const;

/**
 * Row shape of `user_permissions`.
 * Source:
 *   - legacy/sysadmin.js:254 select (role, location_code, must_change_password, created_at)
 *   - legacy/sysadmin.js:434-438 super_admin insert (user_id, email, role, must_change_password)
 *   - legacy/sysadmin.js:467-472 location_admin insert (+ location_code)
 *   - legacy/signupworker.js:728 select (role, must_change_password)
 *
 * `email` is NOT NULL per the comment on legacy/sysadmin.js:394.
 */
export interface UserPermissionRow {
  user_id: string;
  email: string;
  role: UserRole;
  /** Only set when role === "location_admin"; null for super_admin. */
  location_code: string | null;
  must_change_password: boolean;
  created_at: string;
}

/**
 * Row shape of `user_tool_access`.
 * Source: legacy/sysadmin.js:261 select + legacy/sysadmin.js:321-326 insert body.
 */
export interface UserToolAccessRow {
  user_id: string;
  tool: ToolName;
  granted_at: string;
  /** UUID of the actor who granted (NULL for legacy/system grants). */
  granted_by: string | null;
  notes: string | null;
}

/**
 * Auth user identity returned from /auth/v1/user.
 * Subset of the Supabase User shape — only the fields the legacy workers read.
 */
export interface AuthUser {
  id: string;
  email: string;
  created_at?: string | null;
  last_sign_in_at?: string | null;
}

/**
 * Outcome of legacy/performancetracker.js checkToolAccess. Used by the auth
 * package to gate worker entry points.
 */
export type ToolAccessStatus = "authorized" | "forbidden" | "unauthenticated";

export interface ToolAccessResult {
  status: ToolAccessStatus;
  user: AuthUser | null;
}
