// Splash Sysadmin Worker.
//
// Super_admin-only mutations for user management. Read-paths (admin shell,
// user list, drawer detail) move to apps/web in Step 7 (server-fetched via
// @splash/db-supabase). This worker keeps the 5 mutation endpoints, plus a
// thin email-search read added in Brief 18 to back the apps/web UserPicker
// and a pricing_simple bulk-insert added in Brief 24 (Add Location).
//
// Owned routes (Step 7 — production):
//   POST  /sysadmin/api/grant-tool       — grant a tool to a user
//   POST  /sysadmin/api/revoke-tool      — revoke a tool from a user
//   POST  /sysadmin/api/set-role         — set / clear role on user_permissions
//   POST  /sysadmin/api/reset-password   — admin-triggered password reset
//                                          (FLIPS must_change_password = true
//                                          per Josh's password-set policy —
//                                          see @splash/auth/index.ts)
//   POST  /sysadmin/api/create-user      — invite + initial permissions row
//                                          (must_change_password defaults TRUE
//                                          on the new user_permissions row —
//                                          policy default in
//                                          createUserPermissionsRow)
//   POST  /sysadmin/api/pricing-simple/create-location
//                                        — Brief 24. Insert N pricing_simple
//                                          rows (one per package) for a brand-
//                                          new location. Atomic via Supabase
//                                          REST array POST (all rows or none).
//                                          Hardcodes pricing = 'full'.
//                                          Brief 29: also INSERTs a single
//                                          row into `locations` first (so the
//                                          locations editor / triggers can
//                                          find the new location) and accepts
//                                          a new `address` field that lands
//                                          in locations.location +
//                                          pricing_simple.address. Best-
//                                          effort rollback DELETE of the
//                                          locations row on pricing_simple
//                                          insert failure.
//   PATCH /sysadmin/api/pricing-simple/package
//                                        — Brief 26. Update one pricing_simple
//                                          row by composite PK
//                                          (location_code, pkg). Editable
//                                          fields only — denormalized columns
//                                          (am_email/site/etc.) are rejected
//                                          400 because the locations->
//                                          pricing_simple sync trigger would
//                                          revert any direct edit.
//   PATCH /sysadmin/api/locations        — Brief 27. Update one locations row
//                                          (selected by `id` or `site_number`).
//                                          Editable fields are the denormalized
//                                          ones (am_email/rm_email/site_email/
//                                          area_manager/regional_manager/
//                                          location/hrt_email/rm_group/site).
//                                          Two DB triggers cascade outward:
//                                          locations->pricing_simple sync, and
//                                          pricing_simple->user_permissions.
//                                          Editing locations is the ONLY
//                                          supported way to change these
//                                          fields anywhere in the system.
//   GET   /sysadmin/api/users?q=...      — email-substring search backing
//                                          the UserPicker typeahead (Brief 18).
//                                          Empty q -> []. Limit 20.
//   GET   /sysadmin/api/pricing-simple/search?q=...
//                                        — Brief 26. ilike substring match
//                                          across location_code,
//                                          location_pretty, site. Returns up
//                                          to 50 rows. Empty q -> [].
//   GET   /sysadmin/api/pricing-simple/locations?q=...
//                                        — Brief 39. Distinct (location_code,
//                                          location_pretty, site) tuples for
//                                          the Set Role location-picker. ilike
//                                          substring match on the same three
//                                          fields as /pricing-simple/search,
//                                          but deduped to one row per
//                                          location_code. Returns up to 50
//                                          distinct entries. Empty q -> [].
//   GET   /sysadmin/api/locations/search?q=...
//                                        — Brief 27. ilike substring match
//                                          across site, location, area_manager,
//                                          regional_manager (plus site_number
//                                          .eq when q is numeric). Up to 50
//                                          rows. Empty q -> [].
//   POST  /sysadmin/api/users/{userId}/dc-role
//                                        — Brief 61. Set/clear a user's
//                                          dc_role + dc_locations atomically.
//                                          Body: { role, location_codes? }.
//                                          super_admin gate. Writes both
//                                          damage_claim_user_roles and
//                                          damage_claim_user_locations; for
//                                          super_admin/admin the locations
//                                          write is skipped (those roles
//                                          bypass scoping). Audit action
//                                          set_dc_role; target_type
//                                          damage_claim_user_roles.
//   GET   /sysadmin/api/audit-log        — Brief 30. Filtered read of
//                                          sysadmin_audit_log. Filters: actor
//                                          (ilike substring), action (exact;
//                                          allowed list), table (exact;
//                                          allowed target_type list), user_id
//                                          (UUID — pins target_type to
//                                          user-related rows), location_code
//                                          (pins target_type to
//                                          pricing_simple/locations and
//                                          matches target_id eq or `code/%`),
//                                          since/until (ISO-8601), limit
//                                          (default 50, max 200), offset.
//                                          Response: { rows, total_estimate,
//                                          next_offset }.
//
// AUTH GATE POSITION:
//   ALL endpoints — single authenticate() + super_admin check at the top
//   of fetch(), then dispatch on path/method. Performance-worker uses a
//   tool-grant variant (checkToolAccess); this worker is super_admin-only
//   so the gate is straight isSuperAdmin without any user_tool_access read.
//
// AUDIT LOG: every successful mutation writes a sysadmin_audit_log row via
// logSysadminAudit (best-effort — failures are logged + swallowed; mutation
// must not be reported as failed because audit failed).

import {
  adminCreateUser,
  adminGetUser,
  adminResetPassword,
  authenticate
} from "@splash/auth";
import {
  clearRole,
  createServiceClient,
  createUserPermissionsRow,
  grantTool,
  logSysadminAudit,
  revokeTool,
  searchUsersByEmail,
  setDcRole,
  setRole,
  type DcRole,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import type { ToolName, UserRole } from "@splash/types/auth";

type Env = SupabaseEnv;

const VALID_TOOLS: ReadonlySet<ToolName> = new Set(["pricing", "claims", "pertrack"]);
const VALID_ROLES: ReadonlySet<UserRole> = new Set(["super_admin", "location_admin"]);
const VALID_DC_ROLES: ReadonlySet<DcRole> = new Set(["gm", "rm", "admin", "super_admin"]);

const DC_ROLE_MAX_LOCATIONS = 50;
const DC_ROLE_PATH_RE = /^\/sysadmin\/api\/users\/([^/]+)\/dc-role$/;

const OWNED_POST_PATHS = new Set([
  "/sysadmin/api/grant-tool",
  "/sysadmin/api/revoke-tool",
  "/sysadmin/api/set-role",
  "/sysadmin/api/reset-password",
  "/sysadmin/api/create-user",
  "/sysadmin/api/pricing-simple/create-location"
]);

const OWNED_PATCH_PATHS = new Set([
  "/sysadmin/api/pricing-simple/package",
  "/sysadmin/api/pricing-simple/packages-bulk",
  "/sysadmin/api/locations"
]);

const OWNED_GET_PATHS = new Set([
  "/sysadmin/api/users",
  "/sysadmin/api/pricing-simple/search",
  "/sysadmin/api/pricing-simple/locations",
  "/sysadmin/api/locations/search",
  "/sysadmin/api/audit-log"
]);

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    const isOwnedPost = OWNED_POST_PATHS.has(path);
    const isOwnedPatch = OWNED_PATCH_PATHS.has(path);
    const isOwnedGet = OWNED_GET_PATHS.has(path);
    // Brief 61 — dynamic POST /sysadmin/api/users/{userId}/dc-role.
    const dcRolePathMatch = DC_ROLE_PATH_RE.exec(path);
    const isOwnedDcRolePost = dcRolePathMatch !== null;
    if (!isOwnedPost && !isOwnedPatch && !isOwnedGet && !isOwnedDcRolePost) {
      return new Response("Not found", { status: 404 });
    }

    if ((isOwnedPost || isOwnedDcRolePost) && method !== "POST") {
      return jsonError(405, "POST required");
    }
    if (isOwnedPatch && method !== "PATCH") {
      return jsonError(405, "PATCH required");
    }
    if (isOwnedGet && method !== "GET") {
      return jsonError(405, "GET required");
    }

    // CSRF defense-in-depth — state-changing endpoints only (POST + PATCH).
    // Per Brief 11b's sweep, GET endpoints don't carry the gate (browsers
    // omit Origin on same-origin GETs and the read is not state-changing).
    if ((method === "POST" || method === "PATCH") && !isOriginAllowed(request)) {
      return jsonError(403, "bad origin");
    }

    // Single auth gate before any handler logic.
    const auth = await authenticate(request, env);
    if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
    if (auth.session.role !== "super_admin") return jsonError(403, "forbidden");
    const actor = { id: auth.session.userId, email: auth.session.email };

    try {
      if (isOwnedGet) {
        if (path === "/sysadmin/api/users") {
          return await handleSearchUsers(env, url);
        }
        if (path === "/sysadmin/api/pricing-simple/search") {
          return await handleSearchPricingSimple(env, url);
        }
        if (path === "/sysadmin/api/pricing-simple/locations") {
          return await handleSearchPricingSimpleLocations(env, url);
        }
        if (path === "/sysadmin/api/locations/search") {
          return await handleSearchLocations(env, url);
        }
        if (path === "/sysadmin/api/audit-log") {
          return await handleSearchAuditLog(env, url);
        }
      }

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonError(400, "Invalid JSON");
      }

      if (isOwnedDcRolePost && dcRolePathMatch) {
        const userId = decodeURIComponent(dcRolePathMatch[1] ?? "");
        return await handleSetDcRole(env, userId, body, actor);
      }

      switch (path) {
        case "/sysadmin/api/grant-tool":
          return await handleGrantTool(env, body, actor);
        case "/sysadmin/api/revoke-tool":
          return await handleRevokeTool(env, body, actor);
        case "/sysadmin/api/set-role":
          return await handleSetRole(env, body, actor);
        case "/sysadmin/api/reset-password":
          return await handleResetPassword(env, body, actor);
        case "/sysadmin/api/create-user":
          return await handleCreateUser(env, body, actor);
        case "/sysadmin/api/pricing-simple/create-location":
          return await handleCreateLocation(env, body, actor);
        case "/sysadmin/api/pricing-simple/package":
          return await handleUpdatePackage(env, body, actor);
        case "/sysadmin/api/pricing-simple/packages-bulk":
          return await handleUpdatePackagesBulk(env, body, actor);
        case "/sysadmin/api/locations":
          return await handleUpdateLocation(env, body, actor);
      }
    } catch (err) {
      console.error("sysadmin handler failed:", path, err);
      return jsonError(500, err instanceof Error ? err.message : "Internal error");
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

/* ============================================================
 * Handlers
 * ============================================================ */

async function handleGrantTool(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const userId = stringOrNull(body.user_id);
  const tool = stringOrNull(body.tool);
  if (!userId || !tool) return jsonError(400, "user_id and tool required");
  if (!VALID_TOOLS.has(tool as ToolName)) return jsonError(400, `Invalid tool: ${tool}`);

  const sb = createServiceClient(env);
  const result = await grantTool(sb, {
    userId,
    tool: tool as ToolName,
    grantedBy: actor.id,
    notes: "Granted via Splash Admin"
  });

  // Brief 20: distinguish state-change from no-op so the UI can render a
  // distinct message ("Granted X" vs. "Already had X (no change)") and the
  // audit log shows attempted-but-no-op cases for super_admin review.
  if (result.was_new) {
    await logSysadminAudit(sb, {
      actor,
      action: "grant_tool",
      target_type: "user_tool_access",
      target_id: `${userId}|${tool}`,
      before: null,
      after: { user_id: userId, tool, granted_by: actor.id }
    });
  } else {
    await logSysadminAudit(sb, {
      actor,
      action: "grant_tool_noop",
      target_type: "user_tool_access",
      target_id: `${userId}|${tool}`,
      before: { user_id: userId, tool },
      after: { user_id: userId, tool },
      notes: "Grant attempted; tool was already granted (no change)"
    });
  }
  return json({ ok: true, changed: result.was_new });
}

async function handleRevokeTool(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const userId = stringOrNull(body.user_id);
  const tool = stringOrNull(body.tool);
  if (!userId || !tool) return jsonError(400, "user_id and tool required");
  if (!VALID_TOOLS.has(tool as ToolName)) return jsonError(400, `Invalid tool: ${tool}`);

  const sb = createServiceClient(env);
  const result = await revokeTool(sb, { userId, tool: tool as ToolName });

  // Brief 20: see comment on handleGrantTool. Symmetric no-op handling.
  if (result.was_present) {
    await logSysadminAudit(sb, {
      actor,
      action: "revoke_tool",
      target_type: "user_tool_access",
      target_id: `${userId}|${tool}`,
      before: result.before,
      after: null
    });
  } else {
    await logSysadminAudit(sb, {
      actor,
      action: "revoke_tool_noop",
      target_type: "user_tool_access",
      target_id: `${userId}|${tool}`,
      before: null,
      after: null,
      notes: "Revoke attempted; tool was not granted (no change)"
    });
  }
  return json({ ok: true, changed: result.was_present });
}

async function handleSetRole(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const userId = stringOrNull(body.user_id);
  const role = stringOrNull(body.role);
  const locationCode = stringOrNull(body.location_code);
  if (!userId) return jsonError(400, "user_id required");
  if (role && !VALID_ROLES.has(role as UserRole)) {
    return jsonError(400, `Invalid role: ${role}`);
  }
  // Brief 18 guard — flagged in Brief 7 outcome. Without this check
  // location_admin rows could be inserted with location_code = NULL,
  // producing a functionally-misconfigured permissions row.
  if (role === "location_admin" && !locationCode) {
    return jsonError(400, "location_code is required when role is location_admin");
  }

  const sb = createServiceClient(env);

  if (!role) {
    // Clear all roles.
    const before = await clearRole(sb, userId);
    await logSysadminAudit(sb, {
      actor,
      action: "clear_role",
      target_type: "user_permissions",
      target_id: userId,
      before,
      after: null
    });
    return json({ ok: true, cleared: true });
  }

  // Resolve email — user_permissions.email is NOT NULL.
  const userObj = await adminGetUser(env, userId);
  if (!userObj.email) return jsonError(400, "User has no email on file");

  const after = await setRole(sb, {
    userId,
    email: userObj.email,
    role: role as UserRole,
    locationCode
  });
  await logSysadminAudit(sb, {
    actor,
    action: role === "super_admin" ? "set_role_super_admin" : "set_role_location_admin",
    target_type: "user_permissions",
    target_id: userId,
    before: null, // setRole captured-and-replaced; we don't pass before through the helper
    after
  });
  return json({ ok: true, after });
}

/**
 * Brief 61 — POST /sysadmin/api/users/{userId}/dc-role.
 *
 * Sets / clears a user's dc_role + dc_locations atomically. The user's
 * email is resolved from the auth admin API (damage_claim_user_roles.email
 * is NOT NULL on inserts). The setDcRole helper writes both
 * damage_claim_user_roles and damage_claim_user_locations and returns
 * before/after snapshots for the audit log.
 *
 * For role === "super_admin" | "admin" | null, location_codes is ignored.
 * For role === "gm" | "rm", location_codes is required and each entry
 * must match LOCATION_CODE_RE; max DC_ROLE_MAX_LOCATIONS entries.
 */
async function handleSetDcRole(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  if (!UUID_RE.test(userId)) {
    return jsonError(400, "Invalid user_id in path");
  }

  const roleRaw = body.role;
  if (roleRaw !== null && typeof roleRaw !== "string") {
    return jsonError(400, "role must be a string or null");
  }
  let role: DcRole | null;
  if (roleRaw === null) {
    role = null;
  } else if (VALID_DC_ROLES.has(roleRaw as DcRole)) {
    role = roleRaw as DcRole;
  } else {
    return jsonError(400, `Invalid role: ${roleRaw}`);
  }

  // location_codes is required for gm/rm; ignored otherwise.
  let locationCodes: string[] = [];
  if (role === "gm" || role === "rm") {
    const raw = body.location_codes;
    if (!Array.isArray(raw) || raw.length === 0) {
      return jsonError(
        400,
        "location_codes is required and must be a non-empty array for role gm/rm"
      );
    }
    if (raw.length > DC_ROLE_MAX_LOCATIONS) {
      return jsonError(
        400,
        `location_codes may contain at most ${DC_ROLE_MAX_LOCATIONS} entries`
      );
    }
    const codes: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string") {
        return jsonError(400, "location_codes entries must be strings");
      }
      const trimmed = entry.trim();
      if (!LOCATION_CODE_RE.test(trimmed)) {
        return jsonError(400, `Invalid location_code: ${entry}`);
      }
      codes.push(trimmed);
    }
    locationCodes = codes;
  }

  // Resolve email — damage_claim_user_roles.email is NOT NULL.
  const userObj = await adminGetUser(env, userId);
  if (!userObj.email) return jsonError(400, "User has no email on file");

  const sb = createServiceClient(env);
  const { before, after } = await setDcRole(sb, {
    userId,
    email: userObj.email,
    role,
    locationCodes
  });

  await logSysadminAudit(sb, {
    actor,
    action: "set_dc_role",
    target_type: "damage_claim_user_roles",
    target_id: userId,
    before,
    after
  });

  return json({
    ok: true,
    user_id: userId,
    role: after.role,
    location_codes: after.location_codes
  });
}

async function handleResetPassword(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const userId = stringOrNull(body.user_id);
  const newPassword = stringOrNull(body.new_password);
  if (!userId || !newPassword) return jsonError(400, "user_id and new_password required");
  if (newPassword.length < 8) return jsonError(400, "Password must be at least 8 characters");

  // adminResetPassword sets must_change_password = true FIRST, then sets the
  // password — see ordering rationale in @splash/auth/admin.ts. This is the
  // only sanctioned admin-side password mutation; do NOT call the legacy
  // raw "PUT /auth/v1/admin/users/{id}" path here.
  await adminResetPassword(env, userId, newPassword);

  const sb = createServiceClient(env);
  await logSysadminAudit(sb, {
    actor,
    action: "reset_password",
    target_type: "auth.users",
    target_id: userId,
    before: null,
    after: null,
    notes: "Password reset by super_admin (must_change_password set to true)"
  });
  return json({ ok: true });
}

async function handleCreateUser(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const email = stringOrNull(body.email);
  const password = stringOrNull(body.password);
  const role = stringOrNull(body.role);
  const locationCode = stringOrNull(body.location_code);
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((t): t is ToolName => typeof t === "string" && VALID_TOOLS.has(t as ToolName))
    : [];

  if (!email || !password) return jsonError(400, "email and password required");
  if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");
  if (role && !VALID_ROLES.has(role as UserRole)) {
    return jsonError(400, `Invalid role: ${role}`);
  }
  // Brief 18 guard — symmetric with handleSetRole. A location_admin row
  // without location_code is misconfigured; reject at the boundary.
  if (role === "location_admin" && !locationCode) {
    return jsonError(400, "location_code is required when role is location_admin");
  }

  // 1) Create auth user.
  const created = await adminCreateUser(env, { email, password });
  const newUserId = created.id;

  const sb = createServiceClient(env);

  // 2) Insert user_permissions if a role was specified.
  //    must_change_password defaults to TRUE in createUserPermissionsRow —
  //    closes the legacy bug where admin-known default passwords stayed
  //    valid until the user proactively changed them.
  //    Brief 18: forward location_code when role = location_admin (was
  //    hardcoded null until now, requiring a two-step Create + Set role
  //    workflow to attach a location).
  if (role) {
    await createUserPermissionsRow(sb, {
      userId: newUserId,
      email: created.email,
      role: role as UserRole,
      locationCode: role === "location_admin" ? locationCode : null
    });
  }

  // 3) Insert tool grants.
  for (const tool of tools) {
    await grantTool(sb, {
      userId: newUserId,
      tool,
      grantedBy: actor.id,
      notes: "Initial grant on user creation"
    });
  }

  // 4) Audit.
  await logSysadminAudit(sb, {
    actor,
    action: "create_user",
    target_type: "auth.users",
    target_id: newUserId,
    before: null,
    after: { email: created.email, role: role ?? null, tools }
  });

  return json({ ok: true, user_id: newUserId, email: created.email });
}

/* ============================================================
 * POST /sysadmin/api/pricing-simple/create-location  (Brief 24)
 *
 * Insert one pricing_simple row per package for a brand-new location.
 * Atomic — Supabase REST POST with a JSON array commits all rows or none.
 * Hardcodes `pricing: 'full'` for new locations (server-side; not
 * caller-controllable). The composite primary key is (location_code, pkg);
 * we pre-check uniqueness on location_code via a SELECT 1.
 *
 * `pkg$` is the literal column name (CLAUDE.md critical constraint #2).
 * The JSON body MUST use the literal key "pkg$"; bracket notation in TS
 * (`row["pkg$"]`) is the only way to read/write it.
 *
 * Email validation is intentionally permissive — we just check shape so
 * obvious typos surface; the worker doesn't try to verify deliverability.
 *
 * TODO (cross-worker cache invalidation): the signup-worker caches the
 * pricing_simple_resolved view for 5 minutes (caches.default in
 * apps/signup-worker). Adding a brand-new location won't take effect on
 * the customer signup form until that cache expires (or the operator
 * triggers a manual invalidation). A future brief will add a manual
 * "Clear pricing cache" button on /admin/sysadmin and/or wire the
 * signup-worker to invalidate on a sysadmin-emitted message.
 * ============================================================ */

interface CreatePackageInput {
  pkg: string;
  /** Literal column name — see comment above. */
  "pkg$": number;
  single: number;
  flash2: number;
  flash5: number;
  sort?: number | null;
}

interface PricingSimpleInsertRow {
  location_code: string;
  location_pretty: string;
  pkg: string;
  "pkg$": number;
  single: number;
  flash2: number;
  flash5: number;
  sort: number | null;
  pricing: "full";
  site: string | null;
  area_manager: string | null;
  regional_manager: string | null;
  site_email: string | null;
  am_email: string | null;
  rm_email: string | null;
  address: string | null;
}

interface LocationsInsertRow {
  site_number: number;
  site: string;
  location: string | null;
  area_manager: string | null;
  regional_manager: string | null;
  am_email: string | null;
  rm_email: string | null;
  site_email: string | null;
}

const LOCATION_CODE_RE = /^[a-z0-9_]+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function handleCreateLocation(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const locationPretty = stringOrNull(body.location_pretty);
  const locationCode = stringOrNull(body.location_code);
  if (!locationPretty) return jsonError(400, "location_pretty is required");
  if (!locationCode) return jsonError(400, "location_code is required");
  if (!LOCATION_CODE_RE.test(locationCode)) {
    return jsonError(
      400,
      "location_code must contain only lowercase letters, numbers, and underscores"
    );
  }

  const site = stringOrNull(body.site);
  const areaManager = stringOrNull(body.area_manager);
  const regionalManager = stringOrNull(body.regional_manager);
  const siteEmail = stringOrNull(body.site_email);
  const amEmail = stringOrNull(body.am_email);
  const rmEmail = stringOrNull(body.rm_email);
  const address = stringOrNull(body.address);

  // Brief 29 — `site` is now required because we derive locations.site_number
  // from it and the locations row is inserted unconditionally.
  if (!site) {
    return jsonError(400, "Site number required (used as locations.site_number)");
  }
  const siteNumber = Number(site);
  if (!Number.isInteger(siteNumber) || siteNumber <= 0) {
    return jsonError(400, "Site number must be a positive integer");
  }

  for (const [field, value] of [
    ["site_email", siteEmail],
    ["am_email", amEmail],
    ["rm_email", rmEmail]
  ] as const) {
    if (value !== null && !EMAIL_RE.test(value)) {
      return jsonError(400, `${field} is not a valid email address`);
    }
  }

  if (!Array.isArray(body.packages)) {
    return jsonError(400, "packages must be an array");
  }
  if (body.packages.length < 1) {
    return jsonError(400, "At least one package is required");
  }

  const seenPkgs = new Set<string>();
  const packages: CreatePackageInput[] = [];
  for (let i = 0; i < body.packages.length; i++) {
    const raw = body.packages[i];
    if (!raw || typeof raw !== "object") {
      return jsonError(400, `packages[${i}] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    const pkg = stringOrNull(r.pkg);
    if (!pkg) return jsonError(400, `packages[${i}].pkg is required`);
    if (seenPkgs.has(pkg)) {
      return jsonError(400, `Duplicate package: ${pkg}`);
    }
    seenPkgs.add(pkg);

    const pkgPrice = nonNegativeNumber(r["pkg$"]);
    if (pkgPrice === null) {
      return jsonError(400, `packages[${i}].pkg$ must be a non-negative number`);
    }
    const single = nonNegativeNumber(r.single);
    if (single === null) {
      return jsonError(400, `packages[${i}].single must be a non-negative number`);
    }
    const flash2 = nonNegativeNumber(r.flash2);
    if (flash2 === null) {
      return jsonError(400, `packages[${i}].flash2 must be a non-negative number`);
    }
    const flash5 = nonNegativeNumber(r.flash5);
    if (flash5 === null) {
      return jsonError(400, `packages[${i}].flash5 must be a non-negative number`);
    }

    let sort: number | null = null;
    if (r.sort !== undefined && r.sort !== null && r.sort !== "") {
      const sortNum = typeof r.sort === "number" ? r.sort : Number(r.sort);
      if (!Number.isInteger(sortNum) || sortNum < 1) {
        return jsonError(400, `packages[${i}].sort must be a positive integer`);
      }
      sort = sortNum;
    }

    packages.push({
      pkg,
      "pkg$": pkgPrice,
      single,
      flash2,
      flash5,
      sort
    });
  }

  // Pre-check uniqueness on location_code via Supabase REST. The composite
  // PK is (location_code, pkg); duplicate-code inserts fail at the DB level,
  // but a 409 ahead of the round-trip gives the UI a friendlier error.
  const existsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pricing_simple?location_code=eq.${encodeURIComponent(
      locationCode
    )}&select=location_code&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!existsResp.ok) {
    const errText = await existsResp.text().catch(() => "");
    return jsonError(
      500,
      `Pre-check failed: ${existsResp.status} ${errText}`
    );
  }
  const existing = (await existsResp.json().catch(() => [])) as unknown[];
  if (Array.isArray(existing) && existing.length > 0) {
    return jsonError(409, "Location code already in use");
  }

  // Brief 29 — pre-check uniqueness on locations.site_number. The locations
  // table doesn't carry a location_code column (only site_number is the
  // unique business key), so site_number is the only collision key here.
  const locExistsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/locations?site_number=eq.${siteNumber}&select=id&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!locExistsResp.ok) {
    const errText = await locExistsResp.text().catch(() => "");
    return jsonError(500, `Locations pre-check failed: ${locExistsResp.status} ${errText}`);
  }
  const locExisting = (await locExistsResp.json().catch(() => [])) as unknown[];
  if (Array.isArray(locExisting) && locExisting.length > 0) {
    return jsonError(409, "Location already exists in locations table");
  }

  // Brief 29 — INSERT locations row FIRST. The trg_sync_pricing_simple
  // trigger fires `ON locations AFTER UPDATE` (not INSERT), so we don't
  // rely on the trigger to populate pricing_simple's denormalized columns
  // here — the pricing_simple INSERT below carries them directly.
  const locInsertRow: LocationsInsertRow = {
    site_number: siteNumber,
    site: locationPretty,
    location: address,
    area_manager: areaManager,
    regional_manager: regionalManager,
    am_email: amEmail,
    rm_email: rmEmail,
    site_email: siteEmail
  };
  const locInsertResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/locations`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(locInsertRow)
    }
  );
  if (!locInsertResp.ok) {
    const errText = await locInsertResp.text().catch(() => "");
    return jsonError(
      500,
      `Locations insert failed: ${locInsertResp.status} ${errText}`
    );
  }
  const locInsertedRows = (await locInsertResp.json().catch(() => [])) as Array<{
    id?: number | string;
  }>;
  const insertedLocationId =
    Array.isArray(locInsertedRows) && locInsertedRows.length > 0
      ? locInsertedRows[0]!.id ?? null
      : null;

  // Build the pricing_simple row array and POST atomically.
  const rows: PricingSimpleInsertRow[] = packages.map((p) => ({
    location_code: locationCode,
    location_pretty: locationPretty,
    pkg: p.pkg,
    "pkg$": p["pkg$"],
    single: p.single,
    flash2: p.flash2,
    flash5: p.flash5,
    sort: p.sort ?? null,
    pricing: "full",
    site,
    area_manager: areaManager,
    regional_manager: regionalManager,
    site_email: siteEmail,
    am_email: amEmail,
    rm_email: rmEmail,
    address
  }));

  const insertResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pricing_simple`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(rows)
    }
  );

  if (!insertResp.ok) {
    const errText = await insertResp.text().catch(() => "");

    // Brief 29 — best-effort rollback of the just-inserted locations row.
    // If the DELETE fails, surface BOTH errors and flag the audit log so
    // the operator knows manual cleanup is required.
    let cleanupNote = "";
    let needsManualCleanup = false;
    if (insertedLocationId !== null) {
      const cleanupResp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/locations?id=eq.${encodeURIComponent(
          String(insertedLocationId)
        )}`,
        {
          method: "DELETE",
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
          }
        }
      ).catch((err) => {
        cleanupNote = ` Cleanup DELETE threw: ${err instanceof Error ? err.message : String(err)}.`;
        return null;
      });
      if (cleanupResp && !cleanupResp.ok) {
        const cleanupText = await cleanupResp.text().catch(() => "");
        cleanupNote = ` Cleanup DELETE failed: ${cleanupResp.status} ${cleanupText}.`;
        needsManualCleanup = true;
      } else if (!cleanupResp) {
        needsManualCleanup = true;
      }
    }

    if (needsManualCleanup) {
      // Best-effort audit entry flagging the orphan.
      try {
        const sb = createServiceClient(env);
        await logSysadminAudit(sb, {
          actor,
          action: "create_location_failed",
          target_type: "locations",
          target_id: String(insertedLocationId ?? "unknown"),
          before: null,
          after: {
            location_code: locationCode,
            site_number: siteNumber,
            needs_manual_cleanup: true,
            orphan_location_id: insertedLocationId
          },
          notes: "pricing_simple insert failed AND rollback DELETE on locations failed; manual cleanup required"
        });
      } catch {
        // swallow; audit best-effort
      }
    }

    return jsonError(
      500,
      `Supabase insert failed: ${insertResp.status} ${errText}.${cleanupNote}`
    );
  }

  // Audit log — mirror the existing logSysadminAudit shape.
  const sb = createServiceClient(env);
  await logSysadminAudit(sb, {
    actor,
    action: "create_location",
    target_type: "pricing_simple",
    target_id: locationCode,
    before: null,
    after: {
      location_code: locationCode,
      location_pretty: locationPretty,
      location_id: insertedLocationId,
      site_number: siteNumber,
      address,
      package_count: packages.length
    }
  });

  return json({
    ok: true,
    location_code: locationCode,
    location_id: insertedLocationId,
    site_number: siteNumber,
    package_count: packages.length
  });
}

/* ============================================================
 * GET /sysadmin/api/users?q=<email-substring>  (Brief 18)
 *
 * Email substring typeahead backing apps/web's UserPicker. Empty q -> [].
 * Default limit 20. Auth gate is super_admin (single gate at the top of
 * fetch()).
 * ============================================================ */

async function handleSearchUsers(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length === 0) return json([]);

  const sb = createServiceClient(env);
  const rows = await searchUsersByEmail(sb, q, 20);
  return json(rows);
}

/* ============================================================
 * GET /sysadmin/api/pricing-simple/search?q=<substring>  (Brief 26)
 *
 * Substring typeahead backing apps/web's PackageSearchPicker on the
 * "Update package" sysadmin card. ilike match against location_code,
 * location_pretty, and site. Returns up to 50 rows (a single location
 * has ~10 packages, so 50 covers ~5 locations of typeahead bandwidth).
 *
 * Empty / whitespace-only q returns [] (don't dump the full table).
 * Sanitize against PostgREST or() separators — drop ',', '(', ')', '*' —
 * and the ILIKE multi-char wildcard '%'. We do NOT strip '_' (single-char
 * wildcard) because dropping it corrupts queries containing literal
 * underscores in location_codes (e.g., batavia_ii). Treating literal '_'
 * as a single-char wildcard is behaviorally equivalent for the operator's
 * intent of substring search (Brief 52 fix to Brief 26's defect).
 *
 * Auth gate is super_admin (single gate at the top of fetch()). No
 * isOriginAllowed gate per Brief 11b convention (browsers omit Origin
 * on same-origin GETs and the read is not state-changing).
 * ============================================================ */

async function handleSearchPricingSimple(env: Env, url: URL): Promise<Response> {
  const raw = (url.searchParams.get("q") ?? "").trim();
  if (raw.length === 0) return json([]);
  const escaped = raw.replace(/[%,()*]/g, "");
  if (escaped.length === 0) return json([]);
  const needle = encodeURIComponent(`%${escaped}%`);

  const restUrl =
    `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
    `?or=(location_code.ilike.${needle},location_pretty.ilike.${needle},site.ilike.${needle})` +
    `&order=location_code.asc,sort.asc,pkg.asc` +
    `&limit=50`;

  const resp = await fetch(restUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `Search failed: ${resp.status} ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as unknown[];
  return json(rows);
}

/* ============================================================
 * GET /sysadmin/api/pricing-simple/locations?q=<substring>  (Brief 39)
 *
 * Distinct (location_code, location_pretty, site) typeahead backing
 * apps/web's LocationCodePicker on the "Set role" sysadmin card. Same
 * ilike substring match as `/pricing-simple/search` (across
 * location_code, location_pretty, site) but deduped to one row per
 * location_code so the picker shows one entry per location regardless
 * of how many packages match. PostgREST has no SQL DISTINCT projection,
 * so we fetch up to 200 raw rows ordered by site then dedupe in the
 * worker, returning up to 50 distinct location entries.
 *
 * Empty / whitespace-only q returns []. Sanitize against PostgREST
 * or() separators — drop ',', '(', ')', '*' — and the ILIKE multi-char
 * wildcard '%'. We do NOT strip '_' (single-char wildcard) because
 * dropping it corrupts queries containing literal underscores in
 * location_codes (e.g., batavia_ii). Treating literal '_' as a
 * single-char wildcard is behaviorally equivalent for the operator's
 * intent of substring search (Brief 52 fix; same posture as
 * handleSearchPricingSimple).
 *
 * Auth gate is super_admin (single gate at the top of fetch()). No
 * isOriginAllowed gate per Brief 11b convention.
 * ============================================================ */

interface LocationCodeSearchRow {
  location_code: string;
  location_pretty: string | null;
  site: string | null;
}

async function handleSearchPricingSimpleLocations(
  env: Env,
  url: URL
): Promise<Response> {
  const raw = (url.searchParams.get("q") ?? "").trim();
  if (raw.length === 0) return json([]);
  const escaped = raw.replace(/[%,()*]/g, "");
  if (escaped.length === 0) return json([]);
  const needle = encodeURIComponent(`%${escaped}%`);

  const restUrl =
    `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
    `?select=location_code,location_pretty,site` +
    `&or=(location_code.ilike.${needle},location_pretty.ilike.${needle},site.ilike.${needle})` +
    `&order=site.asc` +
    `&limit=200`;

  const resp = await fetch(restUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `Search failed: ${resp.status} ${errText}`);
  }
  const rawRows = (await resp.json().catch(() => [])) as LocationCodeSearchRow[];

  const seen = new Set<string>();
  const deduped: LocationCodeSearchRow[] = [];
  for (const row of rawRows) {
    if (!row || typeof row.location_code !== "string") continue;
    if (seen.has(row.location_code)) continue;
    seen.add(row.location_code);
    deduped.push({
      location_code: row.location_code,
      location_pretty: row.location_pretty ?? null,
      site: row.site ?? null
    });
    if (deduped.length >= 50) break;
  }

  return json(deduped);
}

/* ============================================================
 * PATCH /sysadmin/api/pricing-simple/package  (Brief 26)
 *
 * Update one pricing_simple row identified by composite PK
 * (location_code, pkg). Editable fields are limited to per-package
 * pricing values (`pkg$`, `single`, `flash2`, `flash5`, `sort`),
 * the pricing-mode column (`pricing`), the display name
 * (`location_pretty`), and an optional `pkg_new` rename of the
 * composite-PK pkg part.
 *
 * The denormalized columns (am_email, rm_email, site_email, area_manager,
 * regional_manager, address, site) are REJECTED with 400 if present in
 * the body — they're synced FROM locations INTO pricing_simple by the
 * `trg_sync_pricing_simple` trigger, so any direct edit here would be
 * silently reverted on the next locations-side update. Operators edit
 * those via the Update Location editor (Brief 27).
 *
 * Why PATCH semantically: this is a partial update of one row; PATCH
 * matches REST convention for partial updates and the Supabase REST
 * call we issue downstream is also PATCH. The `OWNED_PATCH_PATHS`
 * dispatch in the top-level fetch() routes the method.
 *
 * Brief 36 — DEPRECATED in favor of `/pricing-simple/packages-bulk`
 * (multi-row pricing-only edit). Kept as a one-row fallback for
 * rename/pricing-mode/flash2/flash5/location_pretty edits that the
 * bulk endpoint intentionally drops. No consumer in apps/web today;
 * remove once the operator confirms the bulk flow covers all needs.
 * ============================================================ */

const REJECTED_DENORM_FIELDS = [
  "area_manager",
  "regional_manager",
  "am_email",
  "rm_email",
  "site_email",
  "address"
] as const;

const VALID_PRICING_MODES: ReadonlySet<string> = new Set([
  "full",
  "same",
  "flash5",
  "flash2",
  "special"
]);

interface PricingSimpleSearchRow {
  location_code: string;
  pkg: string;
  [key: string]: unknown;
}

async function handleUpdatePackage(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const locationCode = stringOrNull(body.location_code);
  const pkg = stringOrNull(body.pkg);
  if (!locationCode) return jsonError(400, "location_code is required");
  if (!LOCATION_CODE_RE.test(locationCode)) {
    return jsonError(
      400,
      "location_code must contain only lowercase letters, numbers, and underscores"
    );
  }
  if (!pkg) return jsonError(400, "pkg is required");

  // Reject any denormalized field. Edits to these get reverted by the
  // locations-side sync trigger; surface the misuse loudly instead of
  // silently dropping the field.
  for (const field of REJECTED_DENORM_FIELDS) {
    if (field in body) {
      return jsonError(
        400,
        `${field} cannot be edited here — edit via Update Location (sync trigger reverts changes here).`
      );
    }
  }

  // Build the editable-fields PATCH payload. Only fields present in body
  // are included; missing fields are left alone.
  const patch: Record<string, unknown> = {};

  if ("pkg$" in body) {
    const v = nonNegativeNumber(body["pkg$"]);
    if (v === null) return jsonError(400, "pkg$ must be a non-negative number");
    patch["pkg$"] = v;
  }
  if ("single" in body) {
    if (body.single === null || body.single === "") {
      patch.single = null;
    } else {
      const v = nonNegativeNumber(body.single);
      if (v === null) return jsonError(400, "single must be a non-negative number or null");
      patch.single = v;
    }
  }
  if ("flash2" in body) {
    if (body.flash2 === null || body.flash2 === "") {
      patch.flash2 = null;
    } else {
      const v = nonNegativeNumber(body.flash2);
      if (v === null) return jsonError(400, "flash2 must be a non-negative number or null");
      patch.flash2 = v;
    }
  }
  if ("flash5" in body) {
    if (body.flash5 === null || body.flash5 === "") {
      patch.flash5 = null;
    } else {
      const v = nonNegativeNumber(body.flash5);
      if (v === null) return jsonError(400, "flash5 must be a non-negative number or null");
      patch.flash5 = v;
    }
  }
  if ("sort" in body) {
    if (body.sort === null || body.sort === "") {
      patch.sort = null;
    } else {
      const sortNum = typeof body.sort === "number" ? body.sort : Number(body.sort);
      if (!Number.isInteger(sortNum) || sortNum < 1) {
        return jsonError(400, "sort must be a positive integer or null");
      }
      patch.sort = sortNum;
    }
  }
  if ("pricing" in body) {
    const mode = stringOrNull(body.pricing);
    if (!mode || !VALID_PRICING_MODES.has(mode)) {
      return jsonError(
        400,
        `pricing must be one of: ${[...VALID_PRICING_MODES].join(", ")}`
      );
    }
    patch.pricing = mode;
  }
  if ("location_pretty" in body) {
    const lp = stringOrNull(body.location_pretty);
    if (!lp) return jsonError(400, "location_pretty cannot be empty");
    patch.location_pretty = lp;
  }

  // Optional rename of the pkg composite-PK part. When provided and
  // different from `pkg`, validate uniqueness of (location_code, pkg_new)
  // before issuing the PATCH so the UI can render a friendly 409 instead
  // of letting Supabase return its own constraint violation.
  let pkgNew: string | null = null;
  if ("pkg_new" in body) {
    pkgNew = stringOrNull(body.pkg_new);
    if (!pkgNew) return jsonError(400, "pkg_new cannot be empty");
  }
  const renaming = pkgNew !== null && pkgNew !== pkg;
  if (renaming) {
    patch.pkg = pkgNew;
  }

  if (Object.keys(patch).length === 0) {
    return jsonError(400, "No editable fields supplied");
  }

  // Pre-check existence of the row identified by (location_code, pkg).
  const existsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
      `?location_code=eq.${encodeURIComponent(locationCode)}` +
      `&pkg=eq.${encodeURIComponent(pkg)}` +
      `&select=*&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!existsResp.ok) {
    const errText = await existsResp.text().catch(() => "");
    return jsonError(500, `Pre-check failed: ${existsResp.status} ${errText}`);
  }
  const existingRows = (await existsResp.json().catch(() => [])) as PricingSimpleSearchRow[];
  if (!Array.isArray(existingRows) || existingRows.length === 0) {
    return jsonError(404, "Package not found");
  }
  const beforeRow = existingRows[0]!;

  // If renaming the pkg, ensure the target name isn't already taken.
  if (renaming) {
    const collideResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
        `?location_code=eq.${encodeURIComponent(locationCode)}` +
        `&pkg=eq.${encodeURIComponent(pkgNew!)}` +
        `&select=pkg&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      }
    );
    if (!collideResp.ok) {
      const errText = await collideResp.text().catch(() => "");
      return jsonError(500, `Rename pre-check failed: ${collideResp.status} ${errText}`);
    }
    const collide = (await collideResp.json().catch(() => [])) as unknown[];
    if (Array.isArray(collide) && collide.length > 0) {
      return jsonError(409, "Target package name already exists");
    }
  }

  // Issue the PATCH. Single atomic call covers any combination of
  // editable-field changes plus the optional rename.
  const patchResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
      `?location_code=eq.${encodeURIComponent(locationCode)}` +
      `&pkg=eq.${encodeURIComponent(pkg)}`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(patch)
    }
  );
  if (!patchResp.ok) {
    const errText = await patchResp.text().catch(() => "");
    return jsonError(500, `Supabase update failed: ${patchResp.status} ${errText}`);
  }
  const updatedRows = (await patchResp.json().catch(() => [])) as PricingSimpleSearchRow[];
  const afterRow = Array.isArray(updatedRows) && updatedRows.length > 0 ? updatedRows[0]! : null;

  // Audit log — capture before + after snapshots.
  const sb = createServiceClient(env);
  const finalPkg = renaming ? pkgNew! : pkg;
  await logSysadminAudit(sb, {
    actor,
    action: "update_package",
    target_type: "pricing_simple",
    target_id: `${locationCode}/${finalPkg}`,
    before: beforeRow,
    after: afterRow
  });

  // TODO (cross-worker cache invalidation): see comment on
  // handleCreateLocation. signup-worker caches pricing_simple_resolved
  // for 5 minutes; package-edit changes won't surface on the customer
  // signup form until that cache expires. Manual cache-clear button
  // planned in a future brief.

  return json({
    ok: true,
    location_code: locationCode,
    pkg: finalPkg,
    updated_at:
      afterRow && typeof afterRow.updated_at === "string" ? afterRow.updated_at : null
  });
}

/* ============================================================
 * PATCH /sysadmin/api/pricing-simple/packages-bulk  (Brief 36)
 *
 * Bulk pricing-only edit: one location, multiple packages, atomic-ish
 * iteration. Replaces the per-row Brief 26 endpoint as the operator's
 * primary editor — the common workflow is "raise every package at this
 * location by $X", which previously required N round-trips.
 *
 * Body shape (worker rejects everything else):
 *   {
 *     location_code: string,        // /^[a-z0-9_]+$/, single location
 *     updates: Array<{              // 1..20 entries
 *       pkg: string,                // composite-PK pkg part
 *       "pkg$"?: number | null,
 *       single?: number | null,
 *       sort?: number | null
 *     }>
 *   }
 *
 * Editable fields are intentionally limited to pkg$/single/sort. Rename
 * (pkg_new), pricing-mode, flash2/flash5, and location_pretty stay on
 * the deprecated single-row endpoint — the multi-select UI doesn't
 * surface them. The denormalized columns from Brief 26 are still
 * rejected here for the same reason (sync trigger reverts them).
 *
 * Per-row partial-success: each pkg is patched independently; failures
 * don't roll back successful peers. The response has per-row results
 * plus updated/failed counts for the UI's success message. Worker-level
 * 500 only when validation/auth/network fails before the loop starts.
 *
 * Audit log: ONE entry per bulk request (action = "update_packages_bulk")
 * with target_id = location_code. before = { location_code, rows: [...] }
 * captures the pre-edit state of the fields the bulk endpoint can touch
 * (pkg, pkg$, single, sort) via a single pkg=in.(...) GET issued before
 * the patch loop. after = { location_code, updates: [...], updated,
 * failed } captures the patch intent + per-row outcome counts. The
 * before-snapshot fetch is fail-soft (catch + before:null fallback) so
 * audit-log degradation never blocks the bulk update itself. Per-row
 * audit entries would spam the log; the bulk entry preserves provenance
 * without flooding.
 * ============================================================ */

const BULK_MAX_UPDATES = 20;

const BULK_REJECTED_FIELDS = [
  // Sync-trigger-reverted denormalized columns (same as Brief 26 list).
  "area_manager",
  "regional_manager",
  "am_email",
  "rm_email",
  "site_email",
  "address",
  // Brief 36 scope decision: single-row endpoint owns these.
  "pkg_new",
  "flash2",
  "flash5",
  "pricing",
  "location_pretty"
] as const;

interface BulkUpdateEntry {
  pkg: string;
  patch: Record<string, unknown>;
}

interface BulkRowResult {
  pkg: string;
  ok: boolean;
  error?: string;
}

interface BulkBeforeRow {
  pkg: string;
  "pkg$": number | null;
  single: number | null;
  sort: number | null;
}

async function handleUpdatePackagesBulk(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  const locationCode = stringOrNull(body.location_code);
  if (!locationCode) return jsonError(400, "location_code is required");
  if (!LOCATION_CODE_RE.test(locationCode)) {
    return jsonError(
      400,
      "location_code must contain only lowercase letters, numbers, and underscores"
    );
  }

  const rawUpdates = body.updates;
  if (!Array.isArray(rawUpdates)) {
    return jsonError(400, "updates must be an array");
  }
  if (rawUpdates.length === 0) {
    return jsonError(400, "updates must contain at least one entry");
  }
  if (rawUpdates.length > BULK_MAX_UPDATES) {
    return jsonError(
      400,
      `updates may not exceed ${BULK_MAX_UPDATES} entries per request`
    );
  }

  // Validate every entry up front; reject the whole request on the first
  // bad entry so the client can correct it before any PATCH issues.
  const entries: BulkUpdateEntry[] = [];
  const seenPkgs = new Set<string>();
  for (let i = 0; i < rawUpdates.length; i++) {
    const item = rawUpdates[i];
    if (!item || typeof item !== "object") {
      return jsonError(400, `updates[${i}] must be an object`);
    }
    const entry = item as Record<string, unknown>;

    for (const field of BULK_REJECTED_FIELDS) {
      if (field in entry) {
        return jsonError(
          400,
          `This endpoint only edits pkg$, single, sort. Use Update Package single-row endpoint for other fields, or Update Location for cascading fields. (offending field: ${field})`
        );
      }
    }

    const pkg = stringOrNull(entry.pkg);
    if (!pkg) {
      return jsonError(400, `updates[${i}].pkg is required`);
    }
    if (seenPkgs.has(pkg)) {
      return jsonError(400, `updates[${i}].pkg duplicates a prior entry: ${pkg}`);
    }
    seenPkgs.add(pkg);

    const patch: Record<string, unknown> = {};

    if ("pkg$" in entry) {
      if (entry["pkg$"] === null || entry["pkg$"] === "") {
        return jsonError(400, `updates[${i}]["pkg$"] cannot be null`);
      }
      const v = nonNegativeNumber(entry["pkg$"]);
      if (v === null) {
        return jsonError(400, `updates[${i}]["pkg$"] must be a non-negative number`);
      }
      patch["pkg$"] = v;
    }

    if ("single" in entry) {
      if (entry.single === null || entry.single === "") {
        patch.single = null;
      } else {
        const v = nonNegativeNumber(entry.single);
        if (v === null) {
          return jsonError(
            400,
            `updates[${i}].single must be a non-negative number or null`
          );
        }
        patch.single = v;
      }
    }

    if ("sort" in entry) {
      if (entry.sort === null || entry.sort === "") {
        patch.sort = null;
      } else {
        const sortNum =
          typeof entry.sort === "number" ? entry.sort : Number(entry.sort);
        if (!Number.isInteger(sortNum) || sortNum < 1) {
          return jsonError(400, `updates[${i}].sort must be a positive integer or null`);
        }
        patch.sort = sortNum;
      }
    }

    if (Object.keys(patch).length === 0) {
      return jsonError(
        400,
        `updates[${i}] must include at least one of pkg$, single, sort`
      );
    }

    entries.push({ pkg, patch });
  }

  // Before-snapshot: one GET against pricing_simple covering every pkg
  // about to be patched. Used by the audit-log entry below so the diff
  // panel can render BEFORE/AFTER (Brief 54). Fail-soft — on any error
  // the audit entry falls back to before:null and the bulk update still
  // proceeds normally.
  let beforeSnapshots: BulkBeforeRow[] | null = null;
  try {
    const beforeUrl =
      `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
      `?location_code=eq.${encodeURIComponent(locationCode)}` +
      `&pkg=in.(${entries.map((e) => encodeURIComponent(e.pkg)).join(",")})` +
      `&select=pkg,%22pkg%24%22,single,sort`;
    const beforeResp = await fetch(beforeUrl, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (beforeResp.ok) {
      const rows = (await beforeResp.json()) as unknown;
      if (Array.isArray(rows)) beforeSnapshots = rows as BulkBeforeRow[];
    }
  } catch {
    // Fail-soft: leave beforeSnapshots as null. The audit-log entry
    // will record before:null in this rare path; the bulk update
    // itself proceeds normally.
  }

  // Per-row PATCH loop. Failures don't abort the rest — the operator
  // sees per-row results in the response. Audit log captures the whole
  // request as one entry regardless of partial failure.
  const results: BulkRowResult[] = [];
  let updated = 0;
  let failed = 0;

  for (const entry of entries) {
    const url =
      `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
      `?location_code=eq.${encodeURIComponent(locationCode)}` +
      `&pkg=eq.${encodeURIComponent(entry.pkg)}`;

    let rowOk = false;
    let rowError: string | undefined;

    try {
      const patchResp = await fetch(url, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(entry.patch)
      });
      if (!patchResp.ok) {
        const errText = await patchResp.text().catch(() => "");
        rowError = `Supabase ${patchResp.status}${errText ? `: ${errText}` : ""}`;
      } else {
        const updatedRows = (await patchResp.json().catch(() => [])) as unknown[];
        if (Array.isArray(updatedRows) && updatedRows.length > 0) {
          rowOk = true;
        } else {
          rowError = "Package not found";
        }
      }
    } catch (err) {
      rowError = err instanceof Error ? err.message : String(err);
    }

    if (rowOk) {
      updated++;
      results.push({ pkg: entry.pkg, ok: true });
    } else {
      failed++;
      results.push({ pkg: entry.pkg, ok: false, error: rowError ?? "Unknown error" });
    }
  }

  // Audit log — one entry covering the whole request. Captures the
  // submitted updates verbatim (including any that failed downstream) so
  // the operator can reconstruct intent from the log even if Supabase
  // partially rejected.
  const sb = createServiceClient(env);
  await logSysadminAudit(sb, {
    actor,
    action: "update_packages_bulk",
    target_type: "pricing_simple",
    target_id: locationCode,
    before:
      beforeSnapshots !== null
        ? {
            location_code: locationCode,
            rows: beforeSnapshots
          }
        : null,
    after: {
      location_code: locationCode,
      updates: entries.map((e) => ({ pkg: e.pkg, ...e.patch })),
      updated,
      failed
    }
  });

  // TODO (cross-worker cache invalidation): see comments on
  // handleCreateLocation / handleUpdatePackage. signup-worker caches
  // pricing_simple_resolved for 5 minutes; bulk-edit changes won't
  // surface on the customer signup form until that cache expires.

  return json({
    ok: true,
    location_code: locationCode,
    results,
    updated,
    failed
  });
}

/* ============================================================
 * GET /sysadmin/api/locations/search?q=<substring>  (Brief 27)
 *
 * Substring typeahead backing apps/web's LocationsSearchPicker on the
 * "Update location" sysadmin card. ilike match against site, location,
 * area_manager, and regional_manager. When q is purely numeric, also
 * adds a site_number.eq.{q} clause so operators can type a site number
 * directly. Returns up to 50 rows.
 *
 * Empty / whitespace-only q returns [] (don't dump the full table).
 * Sanitize against PostgREST or() separators — drop ',', '(', ')', '*',
 * '%', '_' — same posture as handleSearchPricingSimple (Brief 26).
 *
 * Auth gate is super_admin (single gate at the top of fetch()). No
 * isOriginAllowed gate per Brief 11b convention (browsers omit Origin
 * on same-origin GETs and the read is not state-changing).
 *
 * The select uses select=* so the worker passes through the entire
 * locations row to the picker — apps/web is the source of truth for
 * which columns it actually consumes.
 * ============================================================ */

async function handleSearchLocations(env: Env, url: URL): Promise<Response> {
  const raw = (url.searchParams.get("q") ?? "").trim();
  if (raw.length === 0) return json([]);
  const escaped = raw.replace(/[%_,()*]/g, "");
  if (escaped.length === 0) return json([]);
  const needle = encodeURIComponent(`%${escaped}%`);

  const orClauses = [
    `site.ilike.${needle}`,
    `location.ilike.${needle}`,
    `area_manager.ilike.${needle}`,
    `regional_manager.ilike.${needle}`
  ];
  // If q is a plain integer, also match by exact site_number — ilike
  // can't apply to integer columns so this needs its own arm.
  if (/^\d+$/.test(escaped)) {
    orClauses.push(`site_number.eq.${escaped}`);
  }

  const restUrl =
    `${env.SUPABASE_URL}/rest/v1/locations` +
    `?or=(${orClauses.join(",")})` +
    `&order=site_number.asc` +
    `&limit=50` +
    `&select=*`;

  const resp = await fetch(restUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `Search failed: ${resp.status} ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as unknown[];
  return json(rows);
}

/* ============================================================
 * PATCH /sysadmin/api/locations  (Brief 27)
 *
 * Update one row of the `locations` table identified by either `id` or
 * `site_number` (exactly one). Editable fields are the denormalized
 * columns the rest of the system consumes:
 *   - site                (display name, e.g. "Binghamton")
 *   - location            (postal address — cascades to
 *                          pricing_simple.address via trigger)
 *   - area_manager        (cascades to pricing_simple)
 *   - regional_manager    (cascades to pricing_simple)
 *   - am_email            (cascades to pricing_simple AND grants
 *                          permission via trg_sync_user_permissions)
 *   - rm_email            (cascades — same)
 *   - site_email          (cascades — same)
 *   - hrt_email           (locations-only; no cascade)
 *   - rm_group            (locations-only; no cascade)
 *
 * Two DB triggers fire on a successful update:
 *   1. trg_sync_pricing_simple ON locations AFTER UPDATE — copies the
 *      denormalized fields into pricing_simple.
 *   2. trg_sync_user_permissions ON pricing_simple AFTER UPDATE —
 *      propagates email-based permissions into user_permissions.
 *
 * This editor is the ONLY supported way to change these denormalized
 * fields. Brief 26's Update Package endpoint rejects them at the
 * pricing_simple level for the same reason.
 *
 * Selector validation: exactly one of `id` or `site_number` must be
 * present. Both/neither -> 400.
 *
 * Audit fields (`created_at`, `updated_at`) and PK fields not used as
 * selector are rejected with 400 if present in the body.
 * ============================================================ */

const LOCATION_EDITABLE_FIELDS = [
  "site",
  "location",
  "area_manager",
  "regional_manager",
  "am_email",
  "rm_email",
  "site_email",
  "hrt_email",
  "rm_group"
] as const;

const LOCATION_EMAIL_FIELDS: ReadonlySet<string> = new Set([
  "am_email",
  "rm_email",
  "site_email",
  "hrt_email"
]);

const LOCATION_REJECTED_FIELDS = ["created_at", "updated_at"] as const;

interface LocationsRow {
  id?: number | string;
  site_number?: number | null;
  [key: string]: unknown;
}

async function handleUpdateLocation(
  env: Env,
  body: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<Response> {
  // Selector — exactly one of `id` or `site_number`.
  const hasId = "id" in body && body.id !== null && body.id !== "";
  const hasSiteNumber =
    "site_number" in body && body.site_number !== null && body.site_number !== "";
  if (hasId === hasSiteNumber) {
    return jsonError(
      400,
      "Selector required: exactly one of `id` or `site_number` must be present"
    );
  }

  let selectorKind: "id" | "site_number";
  let selectorValue: string;
  if (hasId) {
    selectorKind = "id";
    const idNum =
      typeof body.id === "number" ? body.id : Number(String(body.id).trim());
    if (!Number.isFinite(idNum)) {
      return jsonError(400, "`id` must be a number");
    }
    selectorValue = String(idNum);
  } else {
    selectorKind = "site_number";
    const snNum =
      typeof body.site_number === "number"
        ? body.site_number
        : Number(String(body.site_number).trim());
    if (!Number.isInteger(snNum)) {
      return jsonError(400, "`site_number` must be an integer");
    }
    selectorValue = String(snNum);
  }

  // Reject auto-managed audit columns if present.
  for (const field of LOCATION_REJECTED_FIELDS) {
    if (field in body) {
      return jsonError(400, `${field} cannot be edited (auto-managed by the database)`);
    }
  }

  // Build the editable-fields PATCH payload. Only fields explicitly
  // present in body are included; missing fields are left alone.
  const patch: Record<string, unknown> = {};

  for (const field of LOCATION_EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    // Trim text fields. Empty after trim coerces to null (clears the field).
    let val: string | null;
    if (raw === null) {
      val = null;
    } else if (typeof raw === "string") {
      const t = raw.trim();
      val = t.length > 0 ? t : null;
    } else {
      return jsonError(400, `${field} must be a string or null`);
    }
    if (val !== null && LOCATION_EMAIL_FIELDS.has(field) && !EMAIL_RE.test(val)) {
      return jsonError(400, `${field} is not a valid email address`);
    }
    patch[field] = val;
  }

  if (Object.keys(patch).length === 0) {
    return jsonError(400, "No editable fields supplied");
  }

  // Pre-check existence + capture the before snapshot for the audit log.
  const selectorParam = `${selectorKind}=eq.${encodeURIComponent(selectorValue)}`;
  const existsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/locations?${selectorParam}&select=*&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!existsResp.ok) {
    const errText = await existsResp.text().catch(() => "");
    return jsonError(500, `Pre-check failed: ${existsResp.status} ${errText}`);
  }
  const existingRows = (await existsResp.json().catch(() => [])) as LocationsRow[];
  if (!Array.isArray(existingRows) || existingRows.length === 0) {
    return jsonError(404, "Location not found");
  }
  const beforeRow = existingRows[0]!;

  // Issue the PATCH.
  const patchResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/locations?${selectorParam}`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(patch)
    }
  );
  if (!patchResp.ok) {
    const errText = await patchResp.text().catch(() => "");
    return jsonError(500, `Supabase update failed: ${patchResp.status} ${errText}`);
  }
  const updatedRows = (await patchResp.json().catch(() => [])) as LocationsRow[];
  const afterRow =
    Array.isArray(updatedRows) && updatedRows.length > 0 ? updatedRows[0]! : null;

  // Audit log — capture before + after snapshots. target_id favours the id
  // column (the actual PK) when available, falling back to site_number.
  const sb = createServiceClient(env);
  const auditId =
    beforeRow.id !== undefined && beforeRow.id !== null
      ? String(beforeRow.id)
      : selectorValue;
  await logSysadminAudit(sb, {
    actor,
    action: "update_location",
    target_type: "locations",
    target_id: auditId,
    before: beforeRow,
    after: afterRow
  });

  // TODO (cross-worker cache invalidation): see comments on
  // handleCreateLocation / handleUpdatePackage. signup-worker caches
  // pricing_simple_resolved for 5 minutes; a locations-side email or
  // manager edit cascades into pricing_simple via trg_sync_pricing_simple
  // but the cache won't bust for up to 5 minutes. Cross-worker
  // invalidation is still not wired — flagged in BRIEFS/INDEX.md as a
  // future brief. (Third confirmation that this gap needs its own brief.)

  const updatedAt =
    afterRow && typeof afterRow.updated_at === "string"
      ? (afterRow.updated_at as string)
      : null;

  return json({
    ok: true,
    id: beforeRow.id ?? null,
    site_number: beforeRow.site_number ?? null,
    updated_at: updatedAt,
    cascade_note:
      "pricing_simple + user_permissions updated by triggers"
  });
}

/* ============================================================
 * GET /sysadmin/api/audit-log  (Brief 30)
 *
 * Filtered read of sysadmin_audit_log. All filters AND-combined; missing
 * filters apply no constraint. Ordered occurred_at.desc. Default limit 50,
 * max 200. Offset pagination (no smart cursor; this is observation
 * tooling, not a feed).
 *
 * Filter sanitization:
 *   - actor (ilike substring): drop `,`, `(`, `)`, `*`, `%`, `_` per the
 *     existing search pattern (same posture as handleSearchUsers).
 *   - action / target_type: exact-match; validated against an allow-list
 *     so the URL space stays tight (unknown values 400).
 *   - user_id: UUID-shape regex; rejects on shape mismatch.
 *   - location_code: lowercase letters/numbers/underscore only.
 *   - since / until: Date.parse must yield a finite number; rejects on
 *     shape mismatch.
 *
 * Counting strategy: send `Prefer: count=estimated` so PostgREST returns
 * a Content-Range header like `0-49/12345`. The trailing number is the
 * estimate; we surface it as `total_estimate` (nullable on miss). Exact
 * counts would require count=exact which is more expensive at scale —
 * the audit log can grow indefinitely so estimated is the right default.
 *
 * No audit-log entry for the audit-log read itself — reading the log is
 * a read-only super_admin observation; logging reads would create a
 * feedback loop and add noise.
 * ============================================================ */

const ALLOWED_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "create_user",
  "set_role_super_admin",
  "set_role_location_admin",
  "clear_role",
  "set_dc_role",
  "grant_tool",
  "grant_tool_noop",
  "revoke_tool",
  "revoke_tool_noop",
  "reset_password",
  "create_location",
  "update_package",
  "update_packages_bulk",
  "update_location"
]);

const ALLOWED_AUDIT_TARGET_TYPES: ReadonlySet<string> = new Set([
  "user_permissions",
  "user_tool_access",
  "auth.users",
  "damage_claim_user_roles",
  "pricing_simple",
  "locations"
]);

const USER_TARGET_TYPES_CSV =
  "user_permissions,user_tool_access,auth.users,damage_claim_user_roles";
const LOCATION_TARGET_TYPES_CSV = "pricing_simple,locations";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface AuditLogResponse {
  rows: unknown[];
  total_estimate: number | null;
  next_offset: number | null;
}

async function handleSearchAuditLog(env: Env, url: URL): Promise<Response> {
  // limit / offset
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      return jsonError(400, "limit must be a positive integer");
    }
    limit = Math.min(n, 200);
  }
  const offsetRaw = url.searchParams.get("offset");
  let offset = 0;
  if (offsetRaw !== null) {
    const n = Number(offsetRaw);
    if (!Number.isInteger(n) || n < 0) {
      return jsonError(400, "offset must be a non-negative integer");
    }
    offset = n;
  }

  const params: string[] = [];

  // actor — substring ilike on actor_email
  const actorRaw = (url.searchParams.get("actor") ?? "").trim();
  if (actorRaw.length > 0) {
    const actorEsc = actorRaw.replace(/[%_,()*]/g, "");
    if (actorEsc.length > 0) {
      params.push(`actor_email=ilike.${encodeURIComponent(`%${actorEsc}%`)}`);
    }
  }

  // action — exact match against allow-list
  const actionRaw = (url.searchParams.get("action") ?? "").trim();
  if (actionRaw.length > 0) {
    if (!ALLOWED_AUDIT_ACTIONS.has(actionRaw)) {
      return jsonError(400, `Unknown action: ${actionRaw}`);
    }
    params.push(`action=eq.${encodeURIComponent(actionRaw)}`);
  }

  // table — exact match against allow-list of target_type values
  const tableRaw = (url.searchParams.get("table") ?? "").trim();
  if (tableRaw.length > 0) {
    if (!ALLOWED_AUDIT_TARGET_TYPES.has(tableRaw)) {
      return jsonError(400, `Unknown table: ${tableRaw}`);
    }
    params.push(`target_type=eq.${encodeURIComponent(tableRaw)}`);
  }

  // user_id — UUID, pins target_type to user-related rows
  const userIdRaw = (url.searchParams.get("user_id") ?? "").trim();
  if (userIdRaw.length > 0) {
    if (!UUID_RE.test(userIdRaw)) {
      return jsonError(400, "user_id must be a UUID");
    }
    // AND of two constraints; PostgREST AND's repeated top-level params.
    params.push(`target_type=in.(${USER_TARGET_TYPES_CSV})`);
    params.push(`target_id=eq.${encodeURIComponent(userIdRaw)}`);
  }

  // location_code — pins target_type to pricing_simple/locations,
  // matches target_id eq or `code/%`
  const locRaw = (url.searchParams.get("location_code") ?? "").trim();
  if (locRaw.length > 0) {
    if (!LOCATION_CODE_RE.test(locRaw)) {
      return jsonError(
        400,
        "location_code must contain only lowercase letters, numbers, and underscores"
      );
    }
    params.push(`target_type=in.(${LOCATION_TARGET_TYPES_CSV})`);
    const eqArm = `target_id.eq.${locRaw}`;
    const ilikeArm = `target_id.ilike.${encodeURIComponent(`${locRaw}/%`)}`;
    params.push(`or=(${eqArm},${ilikeArm})`);
  }

  // since / until — ISO-8601, Date.parse-validated
  const sinceRaw = (url.searchParams.get("since") ?? "").trim();
  if (sinceRaw.length > 0) {
    if (!Number.isFinite(Date.parse(sinceRaw))) {
      return jsonError(400, "since must be a valid ISO-8601 timestamp");
    }
    params.push(`occurred_at=gte.${encodeURIComponent(sinceRaw)}`);
  }
  const untilRaw = (url.searchParams.get("until") ?? "").trim();
  if (untilRaw.length > 0) {
    if (!Number.isFinite(Date.parse(untilRaw))) {
      return jsonError(400, "until must be a valid ISO-8601 timestamp");
    }
    params.push(`occurred_at=lte.${encodeURIComponent(untilRaw)}`);
  }

  params.push("order=occurred_at.desc");
  params.push(`limit=${limit}`);
  if (offset > 0) {
    params.push(`offset=${offset}`);
  }
  params.push("select=*");

  const restUrl = `${env.SUPABASE_URL}/rest/v1/sysadmin_audit_log?${params.join("&")}`;
  const resp = await fetch(restUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: "count=estimated"
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return jsonError(500, `Audit-log fetch failed: ${resp.status} ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as unknown[];
  const safeRows = Array.isArray(rows) ? rows : [];

  // Parse Content-Range: "0-49/12345" or "*/12345" — trailing number is total.
  let totalEstimate: number | null = null;
  const cr = resp.headers.get("Content-Range");
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) totalEstimate = n;
    }
  }

  const nextOffset = safeRows.length < limit ? null : offset + safeRows.length;

  const body: AuditLogResponse = {
    rows: safeRows,
    total_estimate: totalEstimate,
    next_offset: nextOffset
  };
  return json(body);
}

/* ============================================================
 * Worker-local helpers
 * ============================================================ */

function stringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Brief 24 — coerce a JSON-body value to a non-negative finite number.
 * Accepts numbers and numeric strings; returns null for null/undefined,
 * non-finite (NaN/Infinity), or negative values. Caller uses null as
 * "validation failed; reject with a 400".
 */
function nonNegativeNumber(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string" && v.trim().length > 0) {
    n = Number(v);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
