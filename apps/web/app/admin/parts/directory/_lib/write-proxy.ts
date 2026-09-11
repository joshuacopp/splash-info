// Shared plumbing for the two parts write proxies (../api/parts/route.ts and
// ../api/parts/[id]/route.ts).
//
// The proxies exist because the browser cannot reach splash-workorders
// directly: on the apex, /workorders/api/* is not a path the worker is
// route-bound on, and even where it were, a same-origin call is the only way
// the SameSite=Lax session cookie travels. So the write goes
// browser -> apps/web route handler -> WORKORDERS_WORKER service binding, and
// the worker's status and body come straight back out.
//
// ONE ERROR CONTRACT. PartEditor calls `resp.json()` on every failure path and
// reads `.error`. The worker already answers `{ error: string }`, but anything
// in front of it (a CF interstitial, a Next HTML error page) does not — so
// `relayWorkerResponse` normalizes: the status is always the worker's, the
// body is always JSON, and an unparseable upstream body becomes a synthesized
// `{ error }` rather than HTML the client will choke on.
//
// The proxies do NOT re-validate field contents. The worker owns validation
// (readPartsInput in apps/workorders-worker/src/parts.ts) and owns the 409
// duplicate-part-number rule with it; duplicating either here would create two
// specs to keep in sync and a second place for them to disagree.

import { partsJsonError } from "./admin-gate";

/**
 * The raw request body, gated on it actually claiming to be JSON.
 *
 * Enforcing the content type on THIS side too is not ceremony: it is the same
 * barrier the worker relies on, applied at the origin the browser actually
 * posts to. A cross-site form post cannot set `application/json` without a
 * preflight, and apps/web answers no preflight for these paths.
 */
export async function readJsonText(
  req: Request
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.includes("application/json")) {
    return {
      ok: false,
      response: partsJsonError(400, "Request body must be application/json.")
    };
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return {
      ok: false,
      response: partsJsonError(400, "Couldn't read the request body.")
    };
  }

  // Parse to reject garbage before it costs a subrequest. The ORIGINAL text is
  // forwarded, not a re-serialization — the worker is the only thing entitled
  // to reinterpret the payload.
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        response: partsJsonError(400, "Request body must be a JSON object.")
      };
    }
  } catch {
    return {
      ok: false,
      response: partsJsonError(400, "Request body is not valid JSON.")
    };
  }

  return { ok: true, text };
}

export interface RelayedWorkerResponse {
  /** Ready to return from the route handler. Always `application/json`. */
  response: Response;
  status: number;
  /** Parsed upstream body, or null when it wasn't JSON. DELETE reads
   *  `photo_r2_key` off this. */
  body: unknown;
}

/**
 * Turn the worker's answer into this route's answer.
 *
 * `null` means neither the service binding nor the URL fallback was usable —
 * see `partsWorkerFetch` in ./parts.ts, which returns null rather than
 * throwing so this is a 503 ("the backend isn't reachable") instead of an
 * opaque 500.
 */
export async function relayWorkerResponse(
  resp: Response | null
): Promise<RelayedWorkerResponse> {
  if (!resp) {
    const response = partsJsonError(
      503,
      "The parts directory service isn't reachable right now. Try again in a moment."
    );
    return { response, status: 503, body: null };
  }

  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (body === null) {
    // A 2xx with an unparseable body means something answered that isn't the
    // worker (an HTML login page, a CF error card). Don't pass that off as
    // success — the client would treat it as a completed write.
    const response = partsJsonError(
      resp.ok ? 502 : resp.status,
      resp.ok
        ? "The parts directory service returned an unreadable response."
        : `The parts directory service returned an error (${resp.status}).`
    );
    return { response, status: response.status, body: null };
  }

  return {
    response: new Response(text, {
      status: resp.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }),
    status: resp.status,
    body
  };
}
