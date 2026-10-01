// Company safety programs a site can download: HazCom, spill response, SDS
// training.
//
// SEPARATE FROM THE SDS CATALOGUE on purpose. A safety data sheet describes one
// chemical and belongs to the product; these are company documents that apply
// everywhere and change on their own schedule. Sharing a table would mean every
// query about chemicals having to exclude three rows that are not chemicals.
//
// A ROW WITHOUT A FILE IS A VALID STATE, and the reason this is not just a
// bucket listing. The three rows exist so the page and the checklist can NAME
// the documents before anybody has uploaded them -- so a site sees "not yet
// available" rather than a link that 404s, and an administrator sees what is
// still missing. A listing derived from the bucket can only show what is
// already there, which is exactly the wrong half.

import { jsonError } from "@splash/http";
import type { Env } from "../index.js";
import { fillSafetyDocPdf, type DocFillValues } from "./doc-fill.js";

/** One file per document, keyed by the stable slug rather than the title, so
 *  renaming "OSHA SDS Training" does not orphan the object. */
export function safetyDocKey(slug: string): string {
  return `safety-documents/${slug}.pdf`;
}

export interface SafetyDocRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  r2_key: string | null;
  file_name: string | null;
  size_bytes: number | null;
  uploaded_at: string | null;
  uploaded_by: string | null;
  form_field_keys: string[];
  sort_order: number;
}

function sbHeaders(env: Env, extra?: Record<string, string>) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(extra ?? {})
  };
}

export async function listSafetyDocs(env: Env): Promise<SafetyDocRow[]> {
  const url = new URL("/rest/v1/safety_documents", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "sort_order.asc,title.asc");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    console.error("[forms.safety-docs] list failed", resp.status);
    throw new Error(`safety docs list failed: ${resp.status}`);
  }
  return (await resp.json().catch(() => [])) as SafetyDocRow[];
}

export async function readSafetyDoc(
  env: Env,
  slug: string
): Promise<SafetyDocRow | null> {
  const url = new URL("/rest/v1/safety_documents", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("slug", `eq.${slug}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) return null;
  const rows = (await resp.json().catch(() => [])) as SafetyDocRow[];
  return rows[0] ?? null;
}

/**
 * Documents answering any of these checklist questions.
 *
 * Takes the SAME flagged-key list the parts lookup takes, so a question that
 * carries both a part and a document produces both -- nothing here assumes a
 * question is one kind of problem.
 */
export async function lookupSafetyDocsForFieldKeys(
  env: Env,
  keys: string[]
): Promise<SafetyDocRow[]> {
  if (keys.length === 0) return [];
  const url = new URL("/rest/v1/safety_documents", env.SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("form_field_keys", `ov.{${keys.join(",")}}`);
  url.searchParams.set("order", "sort_order.asc");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    // Fail soft: a missing document block costs a link, and failing the whole
    // cascade would cost the email.
    console.error("[forms.safety-docs] lookup failed", resp.status);
    return [];
  }
  const rows = (await resp.json().catch(() => [])) as SafetyDocRow[];
  // Only ones with a file. A row naming a document nobody has uploaded belongs
  // on the admin page, where somebody can fix it -- not in a site's email as a
  // link that goes nowhere.
  return rows.filter((r) => r.r2_key);
}

/** A site's details to write onto the copy, and the code they came from. */
export interface SafetyDocFill {
  locationCode: string;
  values: DocFillValues;
}

/** Serve the file. Any authenticated user: a safety programme is a thing
 *  everybody is meant to be able to read, which is the entire point of it.
 *
 *  With `fill`, the site's contacts are written into the document's form fields
 *  and flattened; without it the stored bytes are served untouched, blanks and
 *  all. See doc-fill.ts for why those are two different things. */
export async function serveSafetyDoc(
  env: Env,
  doc: SafetyDocRow,
  fill?: SafetyDocFill
): Promise<Response> {
  if (!doc.r2_key) return jsonError(404, "not_uploaded_yet");
  const obj = await env.FORMS_FILES.get(doc.r2_key);
  if (!obj) {
    // The row claims a file and R2 disagrees. Drift, and it looks identical to
    // "never uploaded" from the outside, so say which it is in the log.
    console.error(`[forms.safety-docs] row points at missing object ${doc.r2_key}`);
    return jsonError(404, "file_missing");
  }

  const base = (doc.file_name || `${doc.slug}.pdf`).replace(/[^A-Za-z0-9._-]+/g, "-");
  let body: BodyInit = obj.body;
  let safe = base;

  if (fill) {
    try {
      const filled = await fillSafetyDocPdf(await obj.arrayBuffer(), fill.values);
      if (filled) {
        // Slice to a standalone ArrayBuffer rather than passing the view: the
        // body type will not take a Uint8Array, and reaching for `.buffer`
        // would be wrong the day pdf-lib returns a view into a larger one.
        body = filled.buffer.slice(
          filled.byteOffset,
          filled.byteOffset + filled.byteLength
        ) as ArrayBuffer;
        // The filename carries the site, so a copy saved to a phone is still
        // identifiable a month later -- and so a copy that could NOT be filled
        // is visibly the generic one rather than quietly passing as a site's.
        const codePart = fill.locationCode.replace(/[^A-Za-z0-9._-]+/g, "-");
        safe = base.replace(/\.pdf$/i, "") + `-${codePart}.pdf`;
      } else {
        // Normal for a programme nobody has made fillable. Not an error, but
        // worth a line: it is also what a document uploaded WITHOUT its fields
        // looks like, and that one is a mistake somebody should fix.
        console.warn(
          `[forms.safety-docs] ${doc.slug} has no fillable fields; served unfilled`
        );
      }
    } catch (err) {
      // Degrade to the unfilled document: that is the paper process this
      // replaces, blank lines and all, and it is a far better outcome than
      // failing a safety programme download outright.
      console.error(`[forms.safety-docs] fill failed for ${doc.slug}`, err);
      const again = await env.FORMS_FILES.get(doc.r2_key);
      if (!again) return jsonError(404, "file_missing");
      body = again.body;
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // Inline: these get read on a phone in a back room more often than they
      // get filed, and a download step between "tap" and "read" is friction on
      // the only thing this route is for.
      "Content-Disposition": `inline; filename="${safe}"`,
      // Private AND per-site: a shared cache handing one site's filled copy to
      // another would be a wrong answer, not a slow one.
      "Cache-Control": "private, max-age=300"
    }
  });
}
