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
