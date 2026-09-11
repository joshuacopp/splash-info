// Parts Directory write gate — the one place apps/web decides "may this
// caller mutate the directory".
//
// WHY A ROUTE-LEVEL CHECK AT ALL. middleware.ts gates /admin/* on the mere
// PRESENCE of the `sb-access-token` cookie (see the "Validation is
// presence-only" note in its header) — it does not validate the JWT and knows
// nothing about roles. So a stale cookie reaches these handlers, and any
// authenticated non-admin reaches them too. The route handlers own the real
// check.
//
// ROLE FIELD. `session.role === "super_admin"` — the platform role, NOT
// `session.dcRole` (damage-claims workflow). This must stay byte-for-byte the
// same predicate as `isPartsAdmin` in apps/workorders-worker/src/parts.ts: the
// worker is the enforcing side, and if the two disagree the UI either hides
// buttons an admin should have or hands out buttons that 403.
//
// DEFENCE IN DEPTH, NOT THE ONLY DEFENCE. The worker re-checks every write on
// its own side from the forwarded cookie. This gate exists so a non-admin gets
// a clean JSON 403 from their own origin instead of a proxied one, and so the
// photo upload — which the worker never sees, because PARTS_FILES is bound to
// apps/web — has an equivalent gate of its own.
//
// ALWAYS JSON, NEVER HTML. Every caller is a `fetch()` from PartEditor that
// does `resp.json()` on the failure path. Returning Next's HTML error page
// here would surface as an unhelpful "Unexpected token '<'".

import type { Session } from "@splash/types/session";
import { getMe } from "../../../../_lib/me";

/** Uniform `{ error }` body — same shape the worker returns, so the client
 *  has exactly one error contract to parse regardless of who answered. */
export function partsJsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export type PartsAdminGate =
  | { ok: true; session: Session }
  | { ok: false; response: Response };

/**
 * Resolve the caller and require platform super_admin.
 *
 * `getMe()` returns null on 401 and throws on any other non-2xx; a throw means
 * the dashboard-worker is unreachable, which is a 503 (transient) rather than
 * a 401 (your session is bad) — telling someone to sign in again when the
 * auth service is simply down sends them into a loop.
 */
export async function requirePartsAdmin(): Promise<PartsAdminGate> {
  let session: Session | null;
  try {
    session = await getMe();
  } catch (err) {
    console.error("[parts.admin] session lookup failed", err);
    return {
      ok: false,
      response: partsJsonError(
        503,
        "Couldn't verify your session right now. Try again in a moment."
      )
    };
  }

  if (!session) {
    return {
      ok: false,
      response: partsJsonError(401, "Sign in to edit the parts directory.")
    };
  }
  if (session.role !== "super_admin") {
    return {
      ok: false,
      response: partsJsonError(
        403,
        "Editing the parts directory requires super_admin."
      )
    };
  }

  return { ok: true, session };
}
