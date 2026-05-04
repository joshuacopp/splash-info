// Splash Sysadmin Worker.
//
// Super_admin-only mutations for user management. Read-paths (admin shell,
// user list, drawer detail) move to apps/web in Step 7 (server-fetched via
// @splash/db-supabase). This worker keeps the 5 mutation endpoints.
//
// Owned routes (Step 7 — production):
//   POST /sysadmin/api/grant-tool       — grant a tool to a user
//   POST /sysadmin/api/revoke-tool      — revoke a tool from a user
//   POST /sysadmin/api/set-role         — set / clear role on user_permissions
//   POST /sysadmin/api/reset-password   — admin-triggered password reset
//                                         (FLIPS must_change_password = true
//                                         per Josh's password-set policy —
//                                         see @splash/auth/index.ts)
//   POST /sysadmin/api/create-user      — invite + initial permissions row
//                                         (must_change_password defaults TRUE
//                                         on the new user_permissions row —
//                                         policy default in
//                                         createUserPermissionsRow)
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
  setRole,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import type { ToolName, UserRole } from "@splash/types/auth";

type Env = SupabaseEnv;

const VALID_TOOLS: ReadonlySet<ToolName> = new Set(["pricing", "claims", "pertrack"]);
const VALID_ROLES: ReadonlySet<UserRole> = new Set(["super_admin", "location_admin"]);

const OWNED_API_PATHS = new Set([
  "/sysadmin/api/grant-tool",
  "/sysadmin/api/revoke-tool",
  "/sysadmin/api/set-role",
  "/sysadmin/api/reset-password",
  "/sysadmin/api/create-user"
]);

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (!OWNED_API_PATHS.has(path)) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return jsonError(405, "POST required");
    }

    // CSRF defense-in-depth — every endpoint here is a state-changing
    // POST. Same-origin SameSite=Lax cookies are the primary mitigation;
    // checkOrigin is the second layer. Chunk 5 retrofit.
    if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

    // Single auth gate before any handler logic.
    const auth = await authenticate(request, env);
    if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
    if (auth.session.role !== "super_admin") return jsonError(403, "forbidden");
    const actor = { id: auth.session.userId, email: auth.session.email };

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, "Invalid JSON");
    }

    try {
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

  if (result.was_new) {
    await logSysadminAudit(sb, {
      actor,
      action: "grant_tool",
      target_type: "user_tool_access",
      target_id: `${userId}|${tool}`,
      before: null,
      after: { user_id: userId, tool, granted_by: actor.id }
    });
  }
  return json({ ok: true, was_new: result.was_new });
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

  if (result.was_present) {
    await logSysadminAudit(sb, {
      actor,
      action: "revoke_tool",
      target_type: "user_tool_access",
      target_id: `${userId}|${tool}`,
      before: result.before,
      after: null
    });
  }
  return json({ ok: true, was_present: result.was_present });
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
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((t): t is ToolName => typeof t === "string" && VALID_TOOLS.has(t as ToolName))
    : [];

  if (!email || !password) return jsonError(400, "email and password required");
  if (password.length < 8) return jsonError(400, "Password must be at least 8 characters");
  if (role && !VALID_ROLES.has(role as UserRole)) {
    return jsonError(400, `Invalid role: ${role}`);
  }

  // 1) Create auth user.
  const created = await adminCreateUser(env, { email, password });
  const newUserId = created.id;

  const sb = createServiceClient(env);

  // 2) Insert user_permissions if a role was specified.
  //    must_change_password defaults to TRUE in createUserPermissionsRow —
  //    closes the legacy bug where admin-known default passwords stayed
  //    valid until the user proactively changed them.
  if (role) {
    await createUserPermissionsRow(sb, {
      userId: newUserId,
      email: created.email,
      role: role as UserRole,
      // Caller may eventually want a location_code on creation; legacy
      // doesn't accept one here. Add when sysadmin UI ships in Step 7.
      locationCode: null
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
 * Worker-local helpers
 * ============================================================ */

function stringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
