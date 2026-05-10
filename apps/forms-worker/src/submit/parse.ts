// Parse the multipart form-data body of a `POST /forms/api/submit/{slug}`
// request into a typed payload keyed by `field.key`. Brief 91 handles the
// text-only field types; Brief 92 adds file/signature reference handling
// (the actual upload happens out-of-band via /forms/api/upload + signature
// — by submit time the form carries only the r2_key the client wrote into
// a hidden input). `lookup` is intentionally skipped here (Brief 93): the
// submit handler computes the canonical value via a server-side re-resolve
// against pricing_simple/locations and writes it into the payload after
// parse, ignoring any client-supplied value. Display-only types
// (`heading`, `image`) produce no payload entry, matching Decision 4's
// payload matrix.

import type { FormSchema } from "@splash/forms-schema";

export interface ParsedSubmit {
  payload: Record<string, unknown>;
  pendingSubmissionId: string;
  turnstileResponse: string | null;
}

/**
 * Walk the schema's fields and pull each one's value out of the FormData.
 * Multi-checkbox fields collect every entry under the same `name` into an
 * array. Optional empty entries are dropped so they don't show up as empty
 * strings in the JSONB payload.
 *
 * NOTE: this function does NOT validate the values — that's
 * `payloadValidatorFor` (called separately in the submit handler so we can
 * surface field-keyed validation errors).
 */
export function parseSubmitFormData(
  formData: FormData,
  schema: FormSchema
): ParsedSubmit {
  const pendingRaw = formData.get("pending_submission_id");
  const pendingSubmissionId = typeof pendingRaw === "string" ? pendingRaw : "";

  const tsRaw = formData.get("cf-turnstile-response");
  const turnstileResponse = typeof tsRaw === "string" ? tsRaw : null;

  const payload: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.type === "heading" || field.type === "image") continue;
    if (field.type === "lookup") continue; // Brief 93 — server resolves at submit time

    if (field.type === "file") {
      // Client-side JS uploaded the file via /forms/api/upload and wrote
      // the resulting r2_key into a hidden input named `${key}_r2`. The
      // visible <input type="file"> isn't sent at submit time. Submit
      // handler enriches with mime/size/original_filename via R2 HEAD;
      // here we only carry the reference forward so validation can fail
      // fast on a missing required upload.
      const r2Raw = formData.get(`${field.key}_r2`);
      const r2_key = typeof r2Raw === "string" ? r2Raw : "";
      if (!r2_key) {
        if (field.required) payload[field.key] = null;
        continue;
      }
      payload[field.key] = { r2_key };
      continue;
    }

    if (field.type === "signature") {
      // Signature canvas writes the r2_key into the hidden input that
      // the Brief 90 renderer named `${key}` (single hidden, no _r2
      // suffix — the visible canvas isn't a form field).
      const r2Raw = formData.get(field.key);
      const r2_key = typeof r2Raw === "string" ? r2Raw : "";
      if (!r2_key) {
        if (field.required) payload[field.key] = null;
        continue;
      }
      payload[field.key] = { r2_key, format: field.format };
      continue;
    }

    const entries = formData.getAll(field.key);

    if (field.type === "multi") {
      const values: string[] = [];
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        if (entry === "") continue;
        values.push(entry);
      }
      payload[field.key] = values;
      continue;
    }

    if (entries.length === 0) continue; // omitted entirely
    const first = entries[0];
    const value = typeof first === "string" ? first : ""; // ignore File entries
    if (value === "" && !field.required) continue; // skip empty optional
    payload[field.key] = value;
  }

  return { payload, pendingSubmissionId, turnstileResponse };
}
