// Supabase PostgREST helpers for jotform-worker (Brief 107).
//
// Direct `fetch()` against /rest/v1/* with SUPABASE_SERVICE_KEY — matches
// the fleet-inquiry-worker / forms-worker pattern. No `@supabase/supabase-js`
// client is used here (the JS-worker convention).

/**
 * Load one row from `jotform_forms` by `form_id`. Returns null on miss.
 */
export async function loadFormById(env, formId) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  if (typeof formId !== "string" || !formId) return null;
  const url = new URL("/rest/v1/jotform_forms", env.SUPABASE_URL);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("select", "form_id,slug,display_name,enabled");
  url.searchParams.set("limit", "1");

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.db] loadFormById fetch threw:", err);
    return null;
  }
  if (!resp.ok) {
    console.error("[jotform.db] loadFormById non-2xx:", resp.status);
    return null;
  }
  const rows = (await resp.json().catch(() => [])) || [];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * List all `jotform_forms` rows. Returns [] on failure.
 */
export async function listForms(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return [];
  const url = new URL("/rest/v1/jotform_forms", env.SUPABASE_URL);
  url.searchParams.set("select", "form_id,slug,display_name,enabled");
  url.searchParams.set("order", "display_name.asc");
  url.searchParams.set("limit", "100");

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.db] listForms fetch threw:", err);
    return [];
  }
  if (!resp.ok) {
    console.error("[jotform.db] listForms non-2xx:", resp.status);
    return [];
  }
  return (await resp.json().catch(() => [])) || [];
}

/**
 * COUNT(*) for jotform_submissions WHERE form_id = ?. Reads
 * `Content-Range` from a `Prefer: count=exact, limit=0` response so no
 * rows transfer over the wire — only the header.
 */
export async function countSubmissionsForForm(env, formId) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return 0;
  const url = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("select", "id");
  url.searchParams.set("limit", "0");

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: "count=exact"
      }
    });
  } catch (err) {
    console.error("[jotform.db] countSubmissionsForForm fetch threw:", err);
    return 0;
  }
  if (!resp.ok) {
    console.error("[jotform.db] countSubmissionsForForm non-2xx:", resp.status);
    return 0;
  }
  const range = resp.headers.get("Content-Range") || "";
  const m = range.match(/\/(\d+|\*)$/);
  if (m && m[1] !== "*") return Number.parseInt(m[1], 10) || 0;
  return 0;
}

/**
 * Bulk upsert into `jotform_submissions` with `on_conflict=id` so backfill
 * is idempotent. Returns the number of rows accepted (Supabase doesn't
 * distinguish insert vs update in the response; this is rows-in-payload).
 *
 * Caller is responsible for chunking pages of >1000 — we send everything
 * in one POST per page.
 */
export async function upsertSubmissions(env, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error("supabase env missing");
  }
  const url = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  url.searchParams.set("on_conflict", "id");

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `supabase upsert returned ${resp.status}: ${body.slice(0, 300)}`
    );
  }
  return rows.length;
}

/**
 * Fetch a single `jotform_submissions` row by id (no form scoping —
 * caller does that with form_id eq filter in the URL when needed for
 * cross-form safety). Returns the row or null.
 */
export async function loadSubmissionById(env, formId, id) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const url = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1");

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.db] loadSubmissionById fetch threw:", err);
    return null;
  }
  if (!resp.ok) {
    console.error("[jotform.db] loadSubmissionById non-2xx:", resp.status);
    return null;
  }
  const rows = (await resp.json().catch(() => [])) || [];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Paginated list reader for `jotform_submissions`. Returns
 * `{ rows, total }`.
 *
 * `filters`:
 *   - formId          (required, exact match on form_id)
 *   - fromIso, toIso  (jotform_created_at range, inclusive)
 *   - siteNumbers     (Set<string> | "all", site_number IN filter when
 *                      not "all"; empty Set → returns []/0 short-circuit)
 *   - siteNumber      (optional explicit override, exact match)
 *   - limit, offset
 *
 * When the caller passes a Set with zero entries, returns {rows: [],
 * total: 0} without hitting Supabase.
 */
export async function listSubmissions(env, filters) {
  const {
    formId,
    fromIso,
    toIso,
    siteNumbers,
    siteNumber,
    limit = 200,
    offset = 0,
    exactCount = false
  } = filters;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return { rows: [], total: 0 };
  }

  if (siteNumbers instanceof Set && siteNumbers.size === 0) {
    return { rows: [], total: 0 };
  }

  const url = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.append("jotform_created_at", `gte.${fromIso}`);
  url.searchParams.append("jotform_created_at", `lte.${toIso}`);
  if (siteNumber) {
    url.searchParams.append("site_number", `eq.${siteNumber}`);
  }
  if (siteNumbers instanceof Set) {
    url.searchParams.append(
      "site_number",
      `in.(${[...siteNumbers].map(quoteForIn).join(",")})`
    );
  }
  url.searchParams.set("order", "jotform_created_at.desc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: exactCount ? "count=exact" : "count=estimated"
      }
    });
  } catch (err) {
    console.error("[jotform.db] listSubmissions fetch threw:", err);
    return { rows: [], total: 0 };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `[jotform.db] listSubmissions non-2xx (${resp.status}): ${body.slice(0, 200)}`
    );
    return { rows: [], total: 0 };
  }
  const rows = (await resp.json().catch(() => [])) || [];
  let total = 0;
  const range = resp.headers.get("Content-Range") || "";
  const m = range.match(/\/(\d+|\*)$/);
  if (m && m[1] !== "*") total = Number.parseInt(m[1], 10) || 0;
  return { rows: Array.isArray(rows) ? rows : [], total };
}

/**
 * Variant of listSubmissions for CSV export. No offset; limit is the
 * safety cap + 1 so the caller can detect overflow.
 */
export async function listSubmissionsForCsv(env, filters, capPlusOne) {
  const { formId, fromIso, toIso, siteNumbers, siteNumber } = filters;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return [];
  if (siteNumbers instanceof Set && siteNumbers.size === 0) return [];

  const url = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.append("jotform_created_at", `gte.${fromIso}`);
  url.searchParams.append("jotform_created_at", `lte.${toIso}`);
  if (siteNumber) {
    url.searchParams.append("site_number", `eq.${siteNumber}`);
  }
  if (siteNumbers instanceof Set) {
    url.searchParams.append(
      "site_number",
      `in.(${[...siteNumbers].map(quoteForIn).join(",")})`
    );
  }
  url.searchParams.set("order", "jotform_created_at.desc");
  url.searchParams.set("limit", String(capPlusOne));

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[jotform.db] listSubmissionsForCsv fetch threw:", err);
    return [];
  }
  if (!resp.ok) {
    console.error("[jotform.db] listSubmissionsForCsv non-2xx:", resp.status);
    return [];
  }
  const rows = (await resp.json().catch(() => [])) || [];
  return Array.isArray(rows) ? rows : [];
}

/**
 * PostgREST `in.(...)` list quoting. Values may carry commas / quotes in
 * pathological cases (a site_number string won't, but the helper is
 * shared). PostgREST wants double-quoted string members with embedded
 * `"` escaped as `\"`. We wrap each value in double quotes for safety.
 */
function quoteForIn(value) {
  const s = String(value);
  if (/[",\\]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${s}"`;
}
