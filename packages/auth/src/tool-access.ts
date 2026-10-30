// Session-based tool access check. Pure function, no I/O.
//
// Replaces the legacy async checkToolAccess(request, env, tool) which made
// a per-request DB read against user_tool_access. The auth_unified view now
// surfaces the granted tools on Session.tools, so this is an in-memory check.
//
// Caller pattern in workers (the canonical 2-step gate):
//
//     const auth = await authenticate(request, env);
//     if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
//     if (!checkToolAccess(auth.session, "claims")) return jsonError(403, "forbidden");
//     const { session } = auth;

import type { ToolName } from "@splash/types/auth";
import type { Session } from "@splash/types/session";

/**
 * True iff the session may use `tool`.
 *
 *   - super_admin role bypasses per-tool grants (matches the legacy gate
 *     across signup-worker, performance-worker, etc.)
 *   - otherwise: explicit grant via session.tools (sourced from
 *     user_tool_access via the auth_unified view).
 */
export function checkToolAccess(session: Session, tool: ToolName): boolean {
  if (session.role === "super_admin") return true;
  return session.tools.includes(tool);
}

/**
 * The caller's location scope for site-stamped data. Pure, no I/O.
 *
 *   undefined  -> unscoped: full admin tier (super_admin, or dc_role admin /
 *                 super_admin) reads every site.
 *   string[]   -> only these lowercased location codes. AN EMPTY ARRAY MEANS
 *                 "NO SITES", never "all" -- a caller with a tool grant and no
 *                 assigned locations must read nothing. Callers must not
 *                 collapse [] into undefined.
 *
 * Promoted here (2026-10-30) when a fourth copy was about to be written for
 * performance submissions. Earlier module-private copies remain in
 * performance-worker greeter.ts / expense.ts; they agree with this one and can
 * switch to it when next touched.
 */
export function sessionLocationScope(session: Session): string[] | undefined {
  if (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  ) {
    return undefined;
  }
  return session.locations.map((l) => l.toLowerCase());
}
