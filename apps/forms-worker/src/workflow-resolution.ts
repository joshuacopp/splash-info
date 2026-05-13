// Brief 120 — approver email resolution helper.
//
// Workflows configure each stage with an `approver_source` (one of
// `static_emails` / `payload_field` / `site_role`). This module resolves
// that source against the submission's payload, returning the email list
// the worker compares against `session.email` at transition time AND
// stamps onto `form_submissions.current_approver_emails` after the stage
// flips.
//
// `site_role` reuses Brief 101's `getLocationContactInfo` helper —
// `pricing_simple` is the single source of truth for `am_email` /
// `rm_email` / `site_email` per the project's location data flow
// (`trg_sync_pricing_simple` denormalizes from `locations` into
// `pricing_simple` so the read is eventually consistent with the
// authoritative locations row).
//
// The brief mentioned a `extractSiteNumber(payload)` helper that walks the
// payload looking for a 3-digit value, but `getLocationContactInfo` is
// keyed by `location_code` (the slug), NOT by site_number. The Location
// field type writes its payload value as the `location_code` slug
// (apps/forms-worker/src/render/fields/location.ts), so the natural
// payload key is the value of any `location` field, OR any lookup field
// resolving against `pricing_simple.location_code`. The implementation
// below scans the version's schema for that field shape and reads its
// value from the payload — we keep the brief's "convention" intent (the
// form builder enforces a location-shape field on workflows using
// site_role at the strict-validator level) but resolve the slug directly
// rather than going through a site_number → slug back-translation step.

import type {
  ApproverSource,
  Field,
  FormSchema,
  SubmissionPayload
} from "@splash/forms-schema";
import { getLocationContactInfo } from "@splash/db-supabase";

import type { Env } from "./index.js";

export interface ResolveContext {
  schema: FormSchema;
  payload: SubmissionPayload;
}

/**
 * Resolve an `ApproverSource` against a submission's payload. Returns the
 * (deduped, lower-cased, trimmed) email list the worker:
 *   1. checks `session.email` membership against at transition time, and
 *   2. writes to `form_submissions.current_approver_emails` after a
 *      successful stage flip.
 *
 * Returns `[]` when the source can't resolve (missing payload value,
 * missing `location_code` field, pricing_simple miss, etc.) — the worker
 * surfaces this to the caller as "no approver assigned" and only
 * super_admin / admin can advance the stage.
 */
export async function resolveApproverEmails(
  env: Env,
  source: ApproverSource,
  ctx: ResolveContext
): Promise<string[]> {
  switch (source.type) {
    case "static_emails":
      return normaliseEmails(source.emails);

    case "payload_field": {
      const value = ctx.payload[source.field_key];
      if (typeof value !== "string") return [];
      const trimmed = value.trim();
      if (!trimmed || !trimmed.includes("@")) return [];
      return normaliseEmails([trimmed]);
    }

    case "site_role": {
      const locationCode = extractLocationCode(ctx);
      if (!locationCode) return [];
      const contact = await getLocationContactInfo(env, locationCode);
      const email = contact[source.role];
      return email ? normaliseEmails([email]) : [];
    }
  }
}

/**
 * Walk the version's schema for a `location` field; if found, return its
 * payload value (the slug). Falls back to any `lookup` field whose
 * `keyColumn === "pricing_simple.location_code"` — that field's value is
 * the same `location_code` slug. Returns null when no candidate field is
 * present or its payload entry is missing / non-string.
 */
function extractLocationCode(ctx: ResolveContext): string | null {
  const candidates: Field[] = ctx.schema.fields.filter(
    (f): f is Field =>
      f.type === "location" ||
      (f.type === "lookup" && f.keyColumn === "pricing_simple.location_code")
  );
  for (const f of candidates) {
    const v = ctx.payload[f.key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normaliseEmails(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string") continue;
    const trimmed = e.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
