// JotForm API helper (Brief 107).
//
// Two reads:
//   fetchSubmissionById(env, submissionId) → RawSubmission
//     Used by the webhook handler — JotForm's webhook payload is flat
//     application/x-www-form-urlencoded with stringified JSON for the
//     `rawRequest` blob; the per-submission API endpoint returns a much
//     richer "content" shape (typed answers, prettyFormat values,
//     form_id, status, etc.) so the worker re-fetches by ID on every
//     webhook fire.
//
//   fetchFormSubmissions(env, formId, { afterId? }) → { rows, hasMore, lastId }
//     Used by the backfill handler. JotForm Enterprise's
//     /API/form/{formId}/submissions is filterable by id range; pages of
//     1000 are the largest the API tolerates per the operator's existing
//     experience. The backfill loops once per request — the operator
//     drives the loop externally by re-invoking with the returned
//     `last_id`.
//
// All requests use 15s AbortSignal.timeout — JotForm Enterprise is the
// slowest upstream this worker touches; the timeout matches damage-worker
// / forms-worker webhook posture.

const REQUEST_TIMEOUT_MS = 15_000;
const BACKFILL_PAGE_SIZE = 1000;

/**
 * Fetch a single submission's full payload from JotForm's API. Returns
 * the `content` envelope's payload (form_id, status, created_at, answers
 * map, etc.) on success. Throws on non-2xx or network error so the caller
 * (webhook handler) can return 5xx and let JotForm retry.
 */
export async function fetchSubmissionById(env, submissionId) {
  if (!submissionId) throw new Error("submissionId required");
  if (!env.JOTFORM_API_KEY) {
    throw new Error("JOTFORM_API_KEY unbound");
  }
  const url = new URL(
    `/API/submission/${encodeURIComponent(submissionId)}`,
    env.JOTFORM_BASE_URL
  );
  url.searchParams.set("apikey", env.JOTFORM_API_KEY);

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `JotForm /API/submission returned ${resp.status}: ${body.slice(0, 200)}`
    );
  }
  const env_ = await resp.json().catch(() => null);
  if (!env_ || typeof env_ !== "object" || !env_.content) {
    throw new Error("JotForm /API/submission returned unexpected shape");
  }
  return env_.content;
}

/**
 * Fetch one page of submissions for a form via the JotForm API. Returns
 * `{ rows, hasMore, lastId }`:
 *
 *   - `rows`     — array of full submission payloads (same shape as
 *                  `fetchSubmissionById` content).
 *   - `hasMore`  — `rows.length === BACKFILL_PAGE_SIZE`; conservatively
 *                  signals "another page may exist".
 *   - `lastId`   — string id of the last row; passed as `afterId` on the
 *                  next call to advance through history.
 *
 * Sort order is ascending by `id` so the cursor advances monotonically.
 */
export async function fetchFormSubmissions(env, formId, opts = {}) {
  if (!formId) throw new Error("formId required");
  if (!env.JOTFORM_API_KEY) {
    throw new Error("JOTFORM_API_KEY unbound");
  }
  const url = new URL(
    `/API/form/${encodeURIComponent(formId)}/submissions`,
    env.JOTFORM_BASE_URL
  );
  url.searchParams.set("apikey", env.JOTFORM_API_KEY);
  url.searchParams.set("limit", String(BACKFILL_PAGE_SIZE));
  // JotForm filter param is JSON-stringified; orderby ASC by id so the
  // cursor (afterId) advances toward the most recent.
  url.searchParams.set("orderby", "id");
  if (opts.afterId) {
    url.searchParams.set("filter", JSON.stringify({ "id:gt": String(opts.afterId) }));
  }

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `JotForm /API/form/${formId}/submissions returned ${resp.status}: ${body.slice(0, 200)}`
    );
  }
  const env_ = await resp.json().catch(() => null);
  if (!env_ || typeof env_ !== "object" || !Array.isArray(env_.content)) {
    throw new Error(
      `JotForm /API/form/${formId}/submissions returned unexpected shape`
    );
  }
  const rows = env_.content;
  const lastId =
    rows.length > 0 && rows[rows.length - 1] && typeof rows[rows.length - 1].id === "string"
      ? rows[rows.length - 1].id
      : null;
  return {
    rows,
    hasMore: rows.length === BACKFILL_PAGE_SIZE,
    lastId
  };
}

export const JOTFORM_BACKFILL_PAGE_SIZE = BACKFILL_PAGE_SIZE;
