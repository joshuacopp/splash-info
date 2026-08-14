// User permissions + tool grants. Mirrors legacy/sysadmin.js helpers.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  UserPermissionRow,
  UserRole,
  UserToolAccessRow,
  ToolName
} from "@splash/types/auth";
import type { DamageRole } from "@splash/types/claims";
import type { PromoRole } from "@splash/types/promo";

/**
 * dc_role + dc_locations are the damage-claim permission domain — separate
 * from user_permissions.role / user_tool_access. The view auth_unified
 * surfaces them as `dc_role` (single value, CHECK-constrained to gm | rm |
 * admin | super_admin) and `dc_locations` (array of location_code).
 *
 * `super_admin` and `admin` bypass location scoping on every damage-worker
 * read; `gm` / `rm` users are restricted to their dc_locations.
 */
export type DcRole = DamageRole;

/**
 * Re-export of PromoRole so consumers can `import type { PromoRole } from
 * "@splash/types/db-supabase"`-style alongside DcRole.
 */
export type { PromoRole } from "@splash/types/promo";

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
 * Set a user's role on user_permissions.
 * Source: legacy/sysadmin.js:383 apiSetRole.
 *
 * Caller is responsible for resolving the user's email (we need it because
 * user_permissions.email is NOT NULL).
 *
 * ADDITIVE LOCATION GRANTS (bugfix)
 * ---------------------------------
 * user_permissions is one row per (user, location) for location_admins.
 * This helper used to unconditionally delete every row for the user and
 * insert a single new one — so granting a location_admin one more location
 * silently revoked every location they already had. (Observed in prod:
 * adding auburn to a location_admin who held seven other sites left them
 * with auburn only.)
 *
 * Two paths now:
 *
 *   ADDITIVE — the user is already a location_admin and the requested role
 *   is location_admin. Insert a row per newly-granted location and leave
 *   the existing rows untouched. Locations the user already holds are
 *   filtered out, so re-granting is a no-op rather than a duplicate row.
 *
 *   REPLACE — every other case: first-time grant, or a role transition
 *   (location_admin <-> super_admin). Collapse to a single row, because a
 *   super_admin row carries location_code = NULL and leaving stale
 *   location_admin rows behind would misrepresent the user's scope.
 *
 * There is deliberately no "replace the location set" path here. Removal is
 * a separate, explicit operation — the ✕ affordances in PermissionsViewer,
 * backed by the delete-one-location endpoint. Making a grant destructive by
 * default is what caused the incident above.
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
    /** Required (non-empty) for location_admin; ignored for super_admin.
     *  Mirrors setDcRole's `locationCodes` array shape — one row is written
     *  per code, so several locations can be granted in one submit. */
    locationCodes?: string[] | null;
  }
): Promise<{ before: UserPermissionRow[]; after: UserPermissionRow[] }> {
  // Read the full current row set BEFORE mutating: it feeds the additive/
  // replace decision, the preserved must_change_password flag, and the
  // caller's audit-log before-snapshot.
  const before = await readPermissionRows(client, args.userId);
  const preservedMustChange = before.some((r) => r.must_change_password === true);

  // De-dupe within the request — the operator can't select the same site
  // twice in the picker, but the endpoint is callable directly.
  const requested = Array.from(
    new Set(
      (args.locationCodes ?? [])
        .map((c) => (typeof c === "string" ? c.trim() : ""))
        .filter((c) => c.length > 0)
    )
  );

  if (args.role === "location_admin" && requested.length === 0) {
    throw new Error("Set role failed: at least one location_code is required for location_admin");
  }

  // Additive only when this is a pure location_admin -> location_admin
  // grant. Mixed row sets (shouldn't happen, but the schema permits it)
  // fall through to REPLACE so the state gets normalized.
  const isAdditiveGrant =
    args.role === "location_admin" &&
    before.length > 0 &&
    before.every((r) => r.role === "location_admin");

  if (isAdditiveGrant) {
    const held = new Set(
      before
        .map((r) => r.location_code)
        .filter((c): c is string => typeof c === "string" && c.length > 0)
    );
    const toInsert = requested.filter((code) => !held.has(code));

    // Every requested location is already granted — return unchanged rather
    // than inserting duplicates. Callers compare before/after to see that
    // nothing moved.
    if (toInsert.length === 0) {
      return { before, after: before };
    }

    const insertResp = await client.from("user_permissions").insert(
      toInsert.map((code) => ({
        user_id: args.userId,
        email: args.email,
        role: args.role,
        must_change_password: preservedMustChange,
        location_code: code
      })) as Partial<UserPermissionRow>[]
    );
    if (insertResp.error) {
      throw new Error(`Add locations failed: ${insertResp.error.message}`);
    }

    // Re-read so `after` is the user's complete scope, not just the new rows.
    return { before, after: await readPermissionRows(client, args.userId) };
  }

  // REPLACE — first grant or a role transition. Wipe, then write the full
  // requested set: one row per location for location_admin, a single
  // location_code = NULL row for super_admin.
  const del = await client
    .from("user_permissions")
    .delete()
    .eq("user_id", args.userId);
  if (del.error) throw del.error;

  const insertRows: Partial<UserPermissionRow>[] =
    args.role === "location_admin"
      ? requested.map((code) => ({
          user_id: args.userId,
          email: args.email,
          role: args.role,
          must_change_password: preservedMustChange,
          location_code: code
        }))
      : [
          {
            user_id: args.userId,
            email: args.email,
            role: args.role,
            must_change_password: preservedMustChange,
            location_code: null
          }
        ];

  const { data, error } = await client
    .from("user_permissions")
    .insert(insertRows)
    .select();
  if (error) throw new Error(`Set role failed: ${error.message}`);
  return { before, after: (data ?? []) as unknown as UserPermissionRow[] };
}

/** Full user_permissions row set for one user. Shared by setRole's
 *  before/after snapshots so both sides select identical columns. */
async function readPermissionRows(
  client: SupabaseClient,
  userId: string
): Promise<UserPermissionRow[]> {
  const resp = await client
    .from("user_permissions")
    .select("user_id,email,role,location_code,must_change_password,created_at")
    .eq("user_id", userId);
  if (resp.error) throw resp.error;
  return (resp.data ?? []) as unknown as UserPermissionRow[];
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
 * dc_role + dc_locations  (Brief 61)
 * ============================================================ */

interface DamageRoleRow {
  user_id: string;
  dc_role: DcRole;
}

interface DamageLocationRow {
  user_id: string;
  location_code: string;
}

/**
 * Set a user's dc_role + dc_locations atomically. Mirrors the
 * setRole/clearRole pattern but for the damage-claim permission tables
 * (damage_claim_user_roles + damage_claim_user_locations).
 *
 *   - role !== null: upsert damage_claim_user_roles + replace
 *     damage_claim_user_locations rows. For gm/rm, locationCodes is
 *     required and each row gets one (user_id, location_code) row. For
 *     super_admin/admin, the locations write is skipped (those roles
 *     bypass scoping by design); existing dc_locations rows are wiped to
 *     prevent stale-data leakage if the role is later downgraded.
 *   - role === null: delete from both tables (clears DC access).
 *
 * Schema note (Brief 64): writes to `damage_claim_user_roles` pass only
 * `(user_id, dc_role)`. Email lives on `auth.users` and is joined by
 * the `auth_unified` view at read time — DO NOT add `email` to either
 * the upsert payload or the RETURNING select; the column does not
 * exist on this table (Postgres 42703). The `email` argument is kept
 * on the function signature for the audit-log path (the caller passes
 * session.email; future audit detail could surface it in target labels).
 *
 * Atomicity: Supabase JS client doesn't expose transactions; the calls
 * run sequentially. If a step fails mid-flight, the helper throws and
 * the caller's audit log captures whatever state it ended in. Mirrors
 * how setRole's delete-then-insert handles its own non-rollback path.
 */
export async function setDcRole(
  client: SupabaseClient,
  args: {
    userId: string;
    email: string;
    role: DcRole | null;
    /** Required for gm/rm; ignored for super_admin/admin/null. */
    locationCodes?: string[];
  }
): Promise<{
  before: { role: DcRole | null; location_codes: string[] };
  after: { role: DcRole | null; location_codes: string[] };
}> {
  // 1. Read current state for the audit-log before snapshot.
  const beforeRoleResp = await client
    .from("damage_claim_user_roles")
    .select("user_id,dc_role")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (beforeRoleResp.error) throw beforeRoleResp.error;
  const beforeRoleRow = beforeRoleResp.data as DamageRoleRow | null;

  const beforeLocsResp = await client
    .from("damage_claim_user_locations")
    .select("user_id,location_code")
    .eq("user_id", args.userId);
  if (beforeLocsResp.error) throw beforeLocsResp.error;
  const beforeLocs = (
    (beforeLocsResp.data ?? []) as unknown as DamageLocationRow[]
  )
    .map((r) => r.location_code)
    .sort();

  const before = {
    role: (beforeRoleRow?.dc_role ?? null) as DcRole | null,
    location_codes: beforeLocs
  };

  // 2. Apply the change.
  if (args.role === null) {
    const delRole = await client
      .from("damage_claim_user_roles")
      .delete()
      .eq("user_id", args.userId);
    if (delRole.error) throw new Error(`Clear dc_role failed: ${delRole.error.message}`);

    const delLocs = await client
      .from("damage_claim_user_locations")
      .delete()
      .eq("user_id", args.userId);
    if (delLocs.error) {
      throw new Error(`Clear dc_locations failed: ${delLocs.error.message}`);
    }

    return {
      before,
      after: { role: null, location_codes: [] }
    };
  }

  // role is set — upsert the role row. Schema is (user_id, dc_role);
  // email is intentionally absent (Brief 64).
  const upsertResp = await client
    .from("damage_claim_user_roles")
    .upsert(
      {
        user_id: args.userId,
        dc_role: args.role
      },
      { onConflict: "user_id" }
    )
    .select("user_id,dc_role")
    .single();
  if (upsertResp.error) {
    throw new Error(`Set dc_role failed: ${upsertResp.error.message}`);
  }

  // Always wipe existing locations rows. For gm/rm this is the prelude
  // to inserting the new set; for super_admin/admin this prevents stale
  // dc_locations rows from leaking after a downgrade.
  const delLocsResp = await client
    .from("damage_claim_user_locations")
    .delete()
    .eq("user_id", args.userId);
  if (delLocsResp.error) {
    throw new Error(`Clear dc_locations failed: ${delLocsResp.error.message}`);
  }

  let afterLocs: string[] = [];
  if (args.role === "gm" || args.role === "rm") {
    const codes = (args.locationCodes ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    // Dedupe to avoid composite-PK conflict on accidental duplicates
    // from the multi-picker.
    const unique = Array.from(new Set(codes));
    if (unique.length > 0) {
      const insRows = unique.map((code) => ({
        user_id: args.userId,
        location_code: code
      }));
      const insResp = await client
        .from("damage_claim_user_locations")
        .insert(insRows);
      if (insResp.error) {
        throw new Error(`Insert dc_locations failed: ${insResp.error.message}`);
      }
    }
    afterLocs = unique.sort();
  }

  return {
    before,
    after: { role: args.role, location_codes: afterLocs }
  };
}

/* ============================================================
 * promo_role  (Brief 159)
 * ============================================================ */

interface PromoRoleRow {
  user_id: string;
  promo_role: PromoRole;
}

/**
 * Set a user's promo_role atomically. Mirrors setDcRole but for the
 * promotions permission table. promo_user_roles is a single-scalar table —
 * no companion locations table (promo_role is feature-level, not
 * per-location).
 *
 *   - role !== null: upsert promo_user_roles with the new role.
 *   - role === null: delete the row (revokes all /admin/promotions access).
 *
 * Schema note: writes to `promo_user_roles` pass only `(user_id,
 * promo_role)` plus `created_by` for first-time inserts. Email lives on
 * `auth.users` and is joined by `auth_unified` at read time — no `email`
 * column on this table (mirrors the dc_role pattern fixed in Brief 64).
 * `created_by` is an audit column on the table; we set it on upsert so a
 * re-grant by a different super_admin overwrites it with the latest
 * granter, which matches the table's intent ("who created this grant").
 *
 * Atomicity: Supabase JS doesn't expose transactions; calls run
 * sequentially. If a step fails mid-flight, the helper throws and the
 * caller's audit log captures whatever state it ended in.
 */
export async function setPromoRole(
  client: SupabaseClient,
  args: {
    userId: string;
    role: PromoRole | null;
    /** auth.users.id of the super_admin performing the change; stamps
     * promo_user_roles.created_by on upsert. */
    createdBy?: string;
  }
): Promise<{
  before: { role: PromoRole | null };
  after: { role: PromoRole | null };
}> {
  // 1. Read current state for the audit-log before snapshot.
  const beforeResp = await client
    .from("promo_user_roles")
    .select("user_id,promo_role")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (beforeResp.error) throw beforeResp.error;
  const beforeRow = beforeResp.data as PromoRoleRow | null;
  const before = {
    role: (beforeRow?.promo_role ?? null) as PromoRole | null
  };

  // 2. Apply the change.
  if (args.role === null) {
    const del = await client
      .from("promo_user_roles")
      .delete()
      .eq("user_id", args.userId);
    if (del.error) throw new Error(`Clear promo_role failed: ${del.error.message}`);
    return { before, after: { role: null } };
  }

  const upsertPayload: Record<string, unknown> = {
    user_id: args.userId,
    promo_role: args.role
  };
  if (args.createdBy) {
    upsertPayload.created_by = args.createdBy;
  }

  const upsertResp = await client
    .from("promo_user_roles")
    .upsert(upsertPayload, { onConflict: "user_id" })
    .select("user_id,promo_role")
    .single();
  if (upsertResp.error) {
    throw new Error(`Set promo_role failed: ${upsertResp.error.message}`);
  }

  return {
    before,
    after: { role: args.role }
  };
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
