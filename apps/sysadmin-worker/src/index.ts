// Splash Sysadmin Worker.
//
// Super_admin-only mutations for user management. Read-paths (admin shell,
// user list, drawer detail) move to apps/web in Step 7 (server-fetched via
// @splash/db-supabase). This worker keeps the 5 mutation endpoints, plus a
// thin email-search read added in Brief 18 to back the apps/web UserPicker
// and a pricing_simple bulk-insert added in Brief 24 (Add Location).
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
//   POST /sysadmin/api/pricing-simple/create-location
//                                       — Brief 24. Insert N pricing_simple
//                                         rows (one per package) for a brand-
//                                         new location. Atomic via Supabase
//                                         REST array POST (all rows or none).
//                                         Hardcodes pricing = 'full'.
//   GET  /sysadmin/api/users?q=...      — email-substring search backing
//                                         the UserPicker typeahead (Brief 18).
//                                         Empty q -> []. Limit 20.
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
  setRole,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import type { ToolName, UserRole } from "@splash/types/auth";

type Env = SupabaseEnv;

const VALID_TOOLS: ReadonlySet<ToolName> = new Set(["pricing", "claims", "pertrack"]);
const VALID_ROLES: ReadonlySet<UserRole> = new Set(["super_admin", "location_admin"]);

const OWNED_POST_PATHS = new Set([
  "/sysadmin/api/grant-tool",
  "/sysadmin/api/revoke-tool",
  "/sysadmin/api/set-role",
  "/sysadmin/api/reset-password",
  "/sysadmin/api/create-user",
  "/sysadmin/api/pricing-simple/create-location"
]);

const OWNED_GET_PATHS = new Set(["/sysadmin/api/users"]);

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    const isOwnedPost = OWNED_POST_PATHS.has(path);
    const isOwnedGet = OWNED_GET_PATHS.has(path);
    if (!isOwnedPost && !isOwnedGet) {
      return new Response("Not found", { status: 404 });
    }

    if (isOwnedPost && method !== "POST") {
      return jsonError(405, "POST required");
    }
    if (isOwnedGet && method !== "GET") {
      return jsonError(405, "GET required");
    }

    // CSRF defense-in-depth — POST endpoints only. Per Brief 11b's sweep,
    // GET endpoints don't carry the gate (browsers omit Origin on
    // same-origin GETs and the read is not state-changing).
    if (method === "POST" && !isOriginAllowed(request)) {
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
      }

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonError(400, "Invalid JSON");
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

  // Build the row array and POST atomically.
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
    rm_email: rmEmail
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
    return jsonError(
      500,
      `Supabase insert failed: ${insertResp.status} ${errText}`
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
      package_count: packages.length
    }
  });

  return json({
    ok: true,
    location_code: locationCode,
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
