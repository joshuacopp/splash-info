// Attendance sheets at submit (2026-11-18). Runs after parseSubmitFormData
// (which dropped fully blank rows) and BEFORE resolveEmployees (which checks
// the names).
//
// Per row: a name without a signature, or a signature without a name, is
// refused with the row number. Each signature must sit under this
// submission's own `${key}__sig_${n}` prefix and exist in R2; it is then
// enriched to {r2_key, format} and recorded in form_submission_files like any
// other signature.
//
// Row signatures do NOT count toward PER_SUBMISSION_MAX_FILES (20): a
// 30-person meeting is 30 signatures, and that cap exists for photo uploads.
// They do count toward the byte ceiling, and each is capped at 1 MB on upload.

import {
  parseAttendanceSignatureKey,
  type FormSchema
} from "@splash/forms-schema";
import type { SubmissionFileRowInsert } from "../db/forms.js";

interface R2Env {
  FORMS_FILES: R2Bucket;
}

type Result =
  | { ok: true; fileRows: SubmissionFileRowInsert[]; bytes: number }
  | { ok: false; status: number; fields?: Record<string, string>; error?: string };

export async function checkAttendance(
  env: R2Env,
  formId: string,
  pendingSubmissionId: string,
  schema: FormSchema,
  payload: Record<string, unknown>
): Promise<Result> {
  const fileRows: SubmissionFileRowInsert[] = [];
  const fields: Record<string, string> = {};
  let bytes = 0;

  for (const field of schema.fields) {
    if (field.type !== "attendance") continue;
    const rows = Array.isArray(payload[field.key])
      ? (payload[field.key] as Array<{ employee: unknown; signature: { r2_key?: unknown } | null }>)
      : [];
    const usedKeys = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row.employee) {
        fields[field.key] = `Row ${i + 1} has a signature but no name`;
        break;
      }
      const r2_key = row.signature && typeof row.signature.r2_key === "string" ? row.signature.r2_key : "";
      if (!r2_key) {
        const n = (row.employee as { name?: unknown }).name;
        fields[field.key] = `${typeof n === "string" ? n : `Row ${i + 1}`} still needs to sign`;
        break;
      }

      // form-submission-files/{form}/{pending}/{key}__sig_{n}/signature.png
      const prefix = `form-submission-files/${formId}/${pendingSubmissionId}/`;
      const sub = r2_key.startsWith(prefix) ? r2_key.slice(prefix.length).split("/")[0] ?? "" : "";
      const ref = parseAttendanceSignatureKey(sub);
      if (!ref || ref.fieldKey !== field.key || usedKeys.has(r2_key)) {
        return {
          ok: false,
          status: 400,
          error: `bad_r2_key: signature for ${field.key} doesn't match this submission`
        };
      }
      usedKeys.add(r2_key);

      let head: R2Object | null;
      try {
        head = await env.FORMS_FILES.head(r2_key);
      } catch (err) {
        console.error("[forms.attendance] R2 head threw", err);
        return { ok: false, status: 500, error: "r2_head_failed: please try again" };
      }
      if (!head) {
        fields[field.key] = `Row ${i + 1}: the signature didn't save. Clear it and sign again.`;
        break;
      }
      bytes += head.size;
      const format = r2_key.endsWith(".svg") ? "svg" : "png";
      row.signature = { r2_key, format } as { r2_key: string };
      fileRows.push({
        submissionId: pendingSubmissionId,
        fieldKey: sub,
        r2Key: r2_key,
        mime: head.httpMetadata?.contentType ?? "image/png",
        sizeBytes: head.size,
        originalFilename: head.customMetadata?.originalFilename ?? null
      });
    }
  }

  if (Object.keys(fields).length) return { ok: false, status: 422, fields };
  return { ok: true, fileRows, bytes };
}
