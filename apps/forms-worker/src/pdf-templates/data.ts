// form_pdf_templates reads/writes (PostgREST, service key) and the R2 home of
// the uploaded PDFs. See supabase/form-pdf-templates-01.sql.

import type { PdfBox, PdfTemplate, PdfTemplatePage } from "@splash/forms-schema";
import type { Env } from "../index.js";

const SELECT = "id,form_id,name,pages,boxes,created_at,updated_at,r2_key";

export interface PdfTemplateRow extends PdfTemplate {
  r2_key: string;
}

function headers(env: Env, extra: Record<string, string> = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function rest(env: Env): URL {
  return new URL("/rest/v1/form_pdf_templates", env.SUPABASE_URL);
}

export function templateR2Key(formId: string, templateId: string): string {
  return `form-pdf-templates/${formId}/${templateId}.pdf`;
}

async function check(r: Response, what: string): Promise<void> {
  if (!r.ok) throw new Error(`${what} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

export async function listTemplates(env: Env, formId: string): Promise<PdfTemplateRow[]> {
  const u = rest(env);
  u.searchParams.set("form_id", `eq.${formId}`);
  u.searchParams.set("select", SELECT);
  u.searchParams.set("order", "created_at.asc");
  const r = await fetch(u.toString(), { headers: headers(env) });
  await check(r, "form_pdf_templates list");
  return (await r.json()) as PdfTemplateRow[];
}

/** By id, scoped to the form so a template can't be reached through another form's URL. */
export async function getTemplate(env: Env, formId: string, id: string): Promise<PdfTemplateRow | null> {
  const u = rest(env);
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("form_id", `eq.${formId}`);
  u.searchParams.set("select", SELECT);
  const r = await fetch(u.toString(), { headers: headers(env) });
  await check(r, "form_pdf_templates get");
  return ((await r.json()) as PdfTemplateRow[])[0] ?? null;
}

export async function insertTemplate(
  env: Env,
  row: { id: string; form_id: string; name: string; r2_key: string; pages: PdfTemplatePage[]; created_by: string | null }
): Promise<PdfTemplateRow> {
  const u = rest(env);
  u.searchParams.set("select", SELECT);
  const r = await fetch(u.toString(), {
    method: "POST",
    headers: headers(env, { Prefer: "return=representation" }),
    body: JSON.stringify({ ...row, boxes: [] })
  });
  await check(r, "form_pdf_templates insert");
  return ((await r.json()) as PdfTemplateRow[])[0]!;
}

export async function updateTemplate(
  env: Env,
  formId: string,
  id: string,
  patch: { name?: string; boxes?: PdfBox[] }
): Promise<PdfTemplateRow | null> {
  const u = rest(env);
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("form_id", `eq.${formId}`);
  u.searchParams.set("select", SELECT);
  const r = await fetch(u.toString(), {
    method: "PATCH",
    headers: headers(env, { Prefer: "return=representation" }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  await check(r, "form_pdf_templates update");
  return ((await r.json()) as PdfTemplateRow[])[0] ?? null;
}

export async function deleteTemplate(env: Env, formId: string, id: string): Promise<PdfTemplateRow | null> {
  const u = rest(env);
  u.searchParams.set("id", `eq.${id}`);
  u.searchParams.set("form_id", `eq.${formId}`);
  u.searchParams.set("select", SELECT);
  const r = await fetch(u.toString(), { method: "DELETE", headers: headers(env, { Prefer: "return=representation" }) });
  await check(r, "form_pdf_templates delete");
  return ((await r.json()) as PdfTemplateRow[])[0] ?? null;
}

/** Templates by id regardless of form, for the email step (ids come from the form's own schema). */
export async function getTemplatesByIds(env: Env, ids: string[]): Promise<PdfTemplateRow[]> {
  if (ids.length === 0) return [];
  const u = rest(env);
  u.searchParams.set("id", `in.(${ids.join(",")})`);
  u.searchParams.set("select", SELECT);
  const r = await fetch(u.toString(), { headers: headers(env) });
  await check(r, "form_pdf_templates by ids");
  return (await r.json()) as PdfTemplateRow[];
}

/** The most recent submission of a form with its history, for previews. */
export async function latestSubmission(
  env: Env,
  formId: string
): Promise<{ id: string; submitted_at: string; payload: Record<string, unknown>; workflow_history: unknown } | null> {
  const u = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  u.searchParams.set("form_id", `eq.${formId}`);
  u.searchParams.set("select", "id,submitted_at,payload,workflow_history");
  u.searchParams.set("order", "submitted_at.desc");
  u.searchParams.set("limit", "1");
  const r = await fetch(u.toString(), { headers: headers(env) });
  await check(r, "form_submissions latest");
  return ((await r.json()) as never[])[0] ?? null;
}
