// Submit-time payload validators (Brief 91 + Brief 92). Brief 90's
// `field-config.ts` validates the SHAPE of a stored field config; this
// file validates the VALUE a user submitted against the config's
// expectations.
//
// The dispatcher returns `null` for field types not yet wired:
//   - `heading` / `image` are display-only (no payload entry expected)
//   - `file` / `signature` (Brief 92) — payload is an object reference
//      to an R2 object: { r2_key, mime, size_bytes, original_filename }
//      for files, { r2_key, format } for signatures.
//   - `lookup` gets wired in Brief 93 (server-side re-resolve)
//
// Submit handler (apps/forms-worker/src/submit/index.ts) iterates the
// schema's fields and skips any field whose validator is null.

import { z } from "zod";
import type { Field } from "../types.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\d{10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const LOCATION_CODE_RE = /^[a-z0-9_-]{1,80}$/;

export function payloadValidatorFor(field: Field): z.ZodTypeAny | null {
  switch (field.type) {
    case "heading":
    case "image":
      return null; // display-only — no payload entry expected

    case "name": {
      const max = field.maxLength ?? 120;
      return field.required
        ? z.string().min(1, "Required").max(max)
        : z.string().max(max).optional().or(z.literal(""));
    }

    case "email": {
      const max = field.maxLength ?? 254;
      return field.required
        ? z.string().min(1, "Required").max(max).regex(EMAIL_RE, "Invalid email address")
        : z.string().max(max).regex(EMAIL_RE, "Invalid email address").optional().or(z.literal(""));
    }

    case "phone":
      return field.required
        ? z.string().regex(PHONE_RE, "10 digits, no formatting")
        : z.string().regex(PHONE_RE, "10 digits, no formatting").optional().or(z.literal(""));

    case "short_text": {
      const max = field.maxLength ?? 500;
      return field.required
        ? z.string().min(1, "Required").max(max)
        : z.string().max(max).optional().or(z.literal(""));
    }

    case "long_text": {
      const max = field.maxLength ?? 10000;
      return field.required
        ? z.string().min(1, "Required").max(max)
        : z.string().max(max).optional().or(z.literal(""));
    }

    case "hidden":
      // Hidden fields are operator-controlled; bound the size but otherwise
      // accept anything. Always optional from the user's perspective.
      return z.string().max(2000).optional().or(z.literal(""));

    case "dropdown": {
      if (field.options.length === 0) {
        // Defensive — a published dropdown with zero options should never
        // reach submit, but if it does, accept empty/missing.
        return z.string().max(0).optional().or(z.literal(""));
      }
      const allowed = field.options.map((o) => o.value) as [string, ...string[]];
      const enumSchema = z.enum(allowed);
      return field.required ? enumSchema : enumSchema.optional().or(z.literal(""));
    }

    case "multi": {
      if (field.options.length === 0) {
        return z.array(z.string()).max(0);
      }
      const allowed = field.options.map((o) => o.value) as [string, ...string[]];
      let arr: z.ZodTypeAny = z.array(z.enum(allowed));
      const min = field.minSelected ?? (field.required ? 1 : 0);
      if (min > 0) arr = (arr as z.ZodArray<z.ZodEnum<typeof allowed>>).min(min, `Select at least ${min}`);
      if (field.maxSelected) {
        arr = (arr as z.ZodArray<z.ZodEnum<typeof allowed>>).max(
          field.maxSelected,
          `Select at most ${field.maxSelected}`
        );
      }
      return arr;
    }

    case "date":
      return field.required
        ? z.string().regex(DATE_RE, "Use YYYY-MM-DD")
        : z.string().regex(DATE_RE, "Use YYYY-MM-DD").optional().or(z.literal(""));

    case "time":
      return field.required
        ? z.string().regex(TIME_RE, "Use HH:MM")
        : z.string().regex(TIME_RE, "Use HH:MM").optional().or(z.literal(""));

    case "location":
      return field.required
        ? z.string().min(1, "Pick a location").regex(LOCATION_CODE_RE, "Invalid location")
        : z.string().regex(LOCATION_CODE_RE, "Invalid location").optional().or(z.literal(""));

    case "file": {
      // Brief 92 — value is the enriched payload object the submit
      // handler builds after R2 HEAD. Required when the field is
      // required; nullable/optional otherwise.
      const fileSchema = z.object({
        r2_key: z.string().regex(/^form-submission-files\//, "Invalid file reference"),
        mime: z.string().min(1),
        size_bytes: z.number().int().positive(),
        original_filename: z.string().nullable()
      });
      return field.required ? fileSchema : fileSchema.nullable().optional();
    }

    case "signature": {
      const sigSchema = z.object({
        r2_key: z.string().regex(/^form-submission-files\//, "Invalid signature reference"),
        format: z.enum(["png", "svg"])
      });
      return field.required ? sigSchema : sigSchema.nullable().optional();
    }

    case "lookup": {
      // Brief 93 — payload value comes from the submit handler's
      // server-side re-resolve, NOT the client. display_only mode
      // doesn't store anything; the submit handler deletes the key.
      if (field.resolutionMode === "display_only") return null;
      return field.required && field.nullBehavior === "block_submit"
        ? z.string().min(1)
        : z.string();
    }
  }
}
