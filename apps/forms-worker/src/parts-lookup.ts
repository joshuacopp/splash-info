// Parts Directory lookup — "the question was answered No, what do they order?"
//
// Reads `parts_directory.form_field_keys` (see
// supabase/parts-directory-03-form-field-keys.sql). Two consumers:
//   - the {parts.needed} email token in workflow-email-step.ts
//   - the action-items list handler, which attaches matches per row
//
// Direct PostgREST fetch rather than @supabase/supabase-js, matching every
// other read in this worker. `packages/db-supabase/src/parts-directory.ts`
// exists but takes a SupabaseClient, which worker code deliberately does not
// carry.
//
// FAIL-SOFT EVERYWHERE. A parts lookup that throws must never cost somebody
// their submission email or blank their action items page: the parts are a
// convenience on top of information that is already complete without them.
// Every failure path returns an empty map and logs.

import type { Env } from "./index.js";

/** Only what a link needs. Deliberately not the whole row — this shape is
 *  serialized into an email and onto the action-items wire. */
export interface PartLink {
  id: string;
  part_name: string;
  part_number: string | null;
  vendor: string | null;
  vendor_url: string | null;
  form_field_keys: string[];
}

const PARTS_SELECT = "id,part_name,part_number,vendor,vendor_url,form_field_keys";

/** 10s is generous for one indexed overlap query and still well inside the
 *  cascade's own budget. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** The parts directory card for a part. The page filters client-side from a
 *  `q` seeded off the URL, so searching the exact name lands on the row. */
export function partsDirectoryUrl(partName: string): string {
  return `https://splashcarwashes.info/admin/parts/directory?q=${encodeURIComponent(partName)}`;
}

/**
 * Parts answering any of `fieldKeys`, grouped by the key they answer.
 *
 * A part may carry several keys and therefore appear under several of them;
 * that is intended (one glove order answers two questions) and the caller
 * renders per question, not per part.
 *
 * Returns an empty map for an empty input without touching the network.
 */
export async function lookupPartsForFieldKeys(
  env: Env,
  fieldKeys: string[]
): Promise<Map<string, PartLink[]>> {
  const out = new Map<string, PartLink[]>();
  const keys = [...new Set(fieldKeys.filter((k) => typeof k === "string" && k !== ""))];
  if (keys.length === 0) return out;
  if (!env.SUPABASE_SERVICE_KEY || !env.SUPABASE_URL) {
    console.error("[forms.parts-lookup] service key or url unbound — skipping");
    return out;
  }

  const url = new URL("/rest/v1/parts_directory", env.SUPABASE_URL);
  url.searchParams.set("select", PARTS_SELECT);
  // `ov` is PostgREST's array-overlap (&&). The braces-and-quotes literal is
  // built by hand because searchParams will not encode a Postgres array for us.
  url.searchParams.set("form_field_keys", `ov.{${keys.map(quoteArrayElement).join(",")}}`);
  url.searchParams.set("order", "part_name.asc");

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    });
    if (!resp.ok) {
      console.error(`[forms.parts-lookup] ${resp.status} — returning no parts`);
      return out;
    }
    const rows = (await resp.json().catch(() => [])) as PartLink[];
    const wanted = new Set(keys);
    for (const row of rows) {
      for (const key of row.form_field_keys ?? []) {
        // A part can carry keys for questions this submission did not flag.
        // Only index it under the ones actually asked about.
        if (!wanted.has(key)) continue;
        const list = out.get(key);
        if (list) list.push(row);
        else out.set(key, [row]);
      }
    }
    return out;
  } catch (err) {
    console.error("[forms.parts-lookup] threw — returning no parts", err);
    return out;
  }
}

/** Postgres array literal element quoting. Keys are `^[a-z][a-z0-9_]*$` by the
 *  form-schema validator, so this never fires today — it is here so a future
 *  key shape cannot turn into an injected array literal. */
function quoteArrayElement(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
