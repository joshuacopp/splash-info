// Shared plumbing for the MaintainX REST client.
//
// Every helper in this package is FAIL-SOFT: none of them throw. Network
// errors, non-2xx responses and unparseable bodies all collapse into the
// helper's own result shape with `ok: false`, and the caller decides what
// to map onto an HTTP status. That posture is load-bearing — MaintainX is a
// third-party dependency of paths (damage-claim submission, chemical visit
// filing) that must not fail because MaintainX is down.

/** Cap on the response body echoed back in an error string when MaintainX
 *  returns a non-2xx. Keeps activity-log entries and toasts from bloating. */
export const ERROR_BODY_MAX_BYTES = 2 * 1024;

/** Hard ceiling on cursor-pagination iterations, independent of any row cap.
 *  Defends against a buggy MaintainX cursor that keeps returning a non-null
 *  `nextCursor` forever. Hitting it emits a console.warn and force-breaks
 *  with `truncated = true`. */
export const MAX_PAGE_ITERATIONS = 10;

/**
 * Build the canonical `MX <status>: <body>` error string.
 *
 * The exact format is depended on downstream — damage-worker writes it into
 * the activity log and the /workorders request handler puts it in a redirect
 * query string — so do not reformat it. Reading the body is itself wrapped in
 * a try/catch: a response whose body has already been consumed or whose
 * stream errors must still produce the bare status rather than throwing out
 * of a fail-soft helper.
 */
export async function mxError(res: Response): Promise<string> {
  let errText = "";
  try {
    errText = await res.text();
  } catch {
    // ignore — we'll surface the bare status
  }
  return `MX ${res.status}: ${errText.slice(0, ERROR_BODY_MAX_BYTES)}`;
}

/** Strip a single trailing slash so `${base}/workorders` never double-slashes.
 *  Applied to every URL built in this package. */
export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/**
 * Coerce a candidate MaintainX id to a number, accepting only an all-digits
 * string.
 *
 * NOTE the deliberate difference from `looseNumericId` below: this one
 * rejects "12abc", that one accepts it as 12. The two extractors in this
 * package were written independently and shipped with that difference; it is
 * preserved rather than unified, because tightening the work-request side
 * could reject an id shape MaintainX actually returns, and loosening the
 * work-order side could accept garbage as a real work-order id. Neither is
 * a change worth making blind inside a pure-extraction commit.
 */
export function strictNumericId(c: unknown): number | null {
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string" && /^\d+$/.test(c)) return Number.parseInt(c, 10);
  return null;
}

/** See the note on `strictNumericId` — this variant accepts any string that
 *  `parseInt` can make a finite number of, e.g. a leading-digits string. */
export function looseNumericId(c: unknown): number | null {
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string") {
    const parsed = Number.parseInt(c, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
