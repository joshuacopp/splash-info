// Admin API for PDF templates (builder Documents tab). Admin tier only
// (operator, 2026-11-14), the same gate as the form builder.
//
//   GET    /forms/admin/api/forms/{id}/pdf-templates                  list
//   POST   /forms/admin/api/forms/{id}/pdf-templates                  upload (multipart: name, file)
//   GET    /forms/admin/api/forms/{id}/pdf-templates/{tid}            one
//   PATCH  /forms/admin/api/forms/{id}/pdf-templates/{tid}            {name?, boxes?}
//   DELETE /forms/admin/api/forms/{id}/pdf-templates/{tid}
//   GET    /forms/admin/api/forms/{id}/pdf-templates/{tid}/file       the blank PDF (pdf.js in the builder)
//   POST   /forms/admin/api/forms/{id}/pdf-templates/{tid}/preview    {boxes?} -> filled PDF
//
// The preview fills from the form's most recent submission (with its approval
// history, so signatures show) or, when there is none, shows each box's
// source name in brackets so the admin can still check placement.

import { isOriginAllowed, jsonError } from "@splash/http";
import {
  PDF_TEMPLATE_LIMITS,
  pdfBoxesSchema,
  type Field,
  type PdfBox,
  type WorkflowHistoryEntry
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { adminGate, adminGateResponse, requireServiceKey } from "../admin/auth.js";
import { getDraftSchema } from "../db/admin-forms.js";
import {
  deleteTemplate,
  getTemplate,
  insertTemplate,
  latestSubmission,
  listTemplates,
  templateR2Key,
  updateTemplate
} from "./data.js";
import { fillPdfTemplate, readPageSizes } from "./fill.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/** Strip the r2_key: the builder fetches the PDF through /file, never R2 directly. */
function publicRow<T extends { r2_key?: string }>(row: T): Omit<T, "r2_key"> {
  const { r2_key: _k, ...rest } = row;
  return rest;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

async function draftFields(env: Env, formId: string): Promise<Field[]> {
  const s = (await getDraftSchema(env, formId)) as { fields?: Field[] } | null;
  return Array.isArray(s?.fields) ? s.fields : [];
}

/** Placeholder text per box for a form with no submissions yet. */
function placeholderBoxes(boxes: PdfBox[], fields: Field[]): PdfBox[] {
  return boxes.map((b) => {
    const s = b.source;
    if (s.type === "check" || (s.type === "stage" && s.part === "signature")) return b;
    if (s.type === "field") {
      const f = fields.find((x) => x.key === s.key);
      if (f?.type === "signature" || f?.type === "file") return b;
      return { ...b, source: { type: "text", text: `[${f?.label ?? s.key}]` } };
    }
    if (s.type === "stage") return { ...b, source: { type: "text", text: `[${s.stage}: ${s.part}]` } };
    if (s.type === "submitted_date") return { ...b, source: { type: "text", text: "[date submitted]" } };
    if (s.type === "submission_id") return { ...b, source: { type: "text", text: "[submission #]" } };
    return b;
  });
}

export async function handlePdfTemplatesRoute(env: Env, req: Request, formId: string, rest: string): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  if (req.method !== "GET" && !isOriginAllowed(req)) return jsonError(403, "bad_origin");
  if (!/^[0-9a-f-]{36}$/i.test(formId)) return jsonError(400, "bad_id");

  try {
    if (rest === "" && req.method === "GET") {
      return json(200, { templates: (await listTemplates(env, formId)).map(publicRow) });
    }

    if (rest === "" && req.method === "POST") {
      const fd = await req.formData().catch(() => null);
      const file = fd?.get("file");
      const name = String(fd?.get("name") ?? "").trim();
      if (!name || name.length > 120) return json(400, { error: "invalid_name", message: "Give the document a name." });
      if (!file || typeof file === "string") return json(400, { error: "no_file", message: "Choose a PDF to upload." });
      if (file.size > PDF_TEMPLATE_LIMITS.bytes) return json(413, { error: "too_large", message: "The PDF is over 10 MB." });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isPdf(bytes)) {
        return json(415, {
          error: "not_pdf",
          message: "That isn't a PDF. In Word, use File > Save As > PDF, then upload the PDF."
        });
      }
      let pages: { w: number; h: number }[];
      try {
        pages = await readPageSizes(bytes);
      } catch {
        return json(422, { error: "unreadable_pdf", message: "That PDF couldn't be read. Try saving it again as PDF." });
      }
      if (pages.length > PDF_TEMPLATE_LIMITS.pages) {
        return json(422, { error: "too_many_pages", message: `Up to ${PDF_TEMPLATE_LIMITS.pages} pages.` });
      }
      const id = crypto.randomUUID();
      const r2_key = templateR2Key(formId, id);
      await env.FORMS_FILES.put(r2_key, bytes, { httpMetadata: { contentType: "application/pdf" } });
      const row = await insertTemplate(env, { id, form_id: formId, name, r2_key, pages, created_by: gate.session.email ?? null });
      return json(201, { template: publicRow(row) });
    }

    const m = /^\/([0-9a-f-]{36})(\/file|\/preview)?$/i.exec(rest);
    if (!m) return json(404, { error: "not_found" });
    const tpl = await getTemplate(env, formId, m[1]!);
    if (!tpl) return json(404, { error: "template_not_found" });
    const sub = m[2] ?? "";

    if (sub === "" && req.method === "GET") return json(200, { template: publicRow(tpl) });

    if (sub === "" && req.method === "DELETE") {
      await deleteTemplate(env, formId, tpl.id);
      await env.FORMS_FILES.delete(tpl.r2_key).catch(() => undefined);
      return json(200, { ok: true });
    }

    if (sub === "" && req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { name?: unknown; boxes?: unknown } | null;
      if (!body) return jsonError(400, "bad_json");
      const patch: { name?: string; boxes?: PdfBox[] } = {};
      if ("name" in body) {
        const n = typeof body.name === "string" ? body.name.trim() : "";
        if (!n || n.length > 120) return json(400, { error: "invalid_name", message: "Give the document a name." });
        patch.name = n;
      }
      if ("boxes" in body) {
        const r = pdfBoxesSchema.safeParse(body.boxes);
        if (!r.success) return json(400, { error: "invalid_boxes", message: r.error.issues[0]?.message ?? "Invalid boxes" });
        const bad = r.data.find((b) => b.page >= tpl.pages.length);
        if (bad) return json(400, { error: "invalid_boxes", message: "A box is on a page the PDF doesn't have." });
        patch.boxes = r.data as PdfBox[];
      }
      return json(200, { template: publicRow((await updateTemplate(env, formId, tpl.id, patch))!) });
    }

    if (sub === "/file" && req.method === "GET") {
      const obj = await env.FORMS_FILES.get(tpl.r2_key);
      if (!obj) return json(404, { error: "file_missing" });
      return new Response(obj.body, {
        headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }
      });
    }

    if (sub === "/preview" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { boxes?: unknown };
      let boxes = tpl.boxes;
      if (body.boxes !== undefined) {
        const r = pdfBoxesSchema.safeParse(body.boxes);
        if (!r.success) return json(400, { error: "invalid_boxes", message: r.error.issues[0]?.message ?? "Invalid boxes" });
        boxes = r.data as PdfBox[];
      }
      const obj = await env.FORMS_FILES.get(tpl.r2_key);
      if (!obj) return json(404, { error: "file_missing" });
      const fields = await draftFields(env, formId);
      const latest = await latestSubmission(env, formId);
      const filled = await fillPdfTemplate(
        new Uint8Array(await obj.arrayBuffer()),
        latest ? boxes : placeholderBoxes(boxes, fields),
        {
          fields,
          payload: latest?.payload ?? {},
          history: Array.isArray(latest?.workflow_history) ? (latest!.workflow_history as WorkflowHistoryEntry[]) : [],
          submissionId: latest?.id ?? "00000000",
          submittedAt: latest?.submitted_at ?? new Date().toISOString()
        },
        env.FORMS_FILES
      );
      return new Response(filled as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="preview.pdf"`,
          "Cache-Control": "no-store",
          "X-Preview-Source": latest ? `submission:${latest.id}` : "placeholders"
        }
      });
    }

    return json(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("[forms.pdf-template.admin] failed", err);
    return json(500, { error: "pdf_template_failed" });
  }
}
