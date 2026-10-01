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

/** Serve the file. Any authenticated user: a safety programme is a thing
 *  everybody is meant to be able to read, which is the entire point of it. */
export async function serveSafetyDoc(
  env: Env,
  doc: SafetyDocRow
): Promise<Response> {
  if (!doc.r2_key) return jsonError(404, "not_uploaded_yet");
  const obj = await env.FORMS_FILES.get(doc.r2_key);
  if (!obj) {
    // The row claims a file and R2 disagrees. Drift, and it looks identical to
    // "never uploaded" from the outside, so say which it is in the log.
    console.error(`[forms.safety-docs] row points at missing object ${doc.r2_key}`);
    return jsonError(404, "file_missing");
  }
  const safe = (doc.file_name || `${doc.slug}.pdf`).replace(/[^A-Za-z0-9._-]+/g, "-");
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // Inline: these get read on a phone in a back room more often than they
      // get filed, and a download step between "tap" and "read" is friction on
      // the only thing this route is for.
      "Content-Disposition": `inline; filename="${safe}"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}
