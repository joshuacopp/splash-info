// Brief 42 — damage claim → MaintainX work order.
//
// What lives here is the DOMAIN half only: how a ClaimRow becomes a title,
// a description and an assignee list. The HTTP half — building the request,
// POSTing it, parsing the id out of whatever envelope MaintainX returns,
// and never throwing — moved to `@splash/maintainx` when that client was
// deduplicated out of this worker and splash-workorders.
//
// This file stays because the shared client must not import `ClaimRow`. A
// MaintainX client that knows what a damage claim is cannot be used by the
// chemical-inventory app, which was the whole point of extracting it.
//
// The exported surface is deliberately unchanged from the pre-extraction
// version — `createMaintainXWorkOrder(input): Promise<MaintainXResult>` with
// the same CreateInput fields — so index.ts's two call sites did not move.
//
// Assignee IDs are encoded as module-level const arrays so they're
// grep-able when an assignee leaves the company:
//   - Brett Sullivan  (409112)  bsullivan@splashcarwashes.com
//   - Scott Butler    (426577)  scott.butler@splashcarwashes.com
//   - Josh Copp       (443948)  josh.copp@splashcarwashes.com
//
// Mode switch:
//   - "production" → Brett + Scott
//   - "test"       → Josh only (so dev/staging traffic doesn't page real
//                    assignees)

import type { ClaimRow } from "@splash/types/claims";
import {
  createMaintainXWorkOrder as createWorkOrder,
  type CreateWorkOrderResult,
  type MaintainXAssignee
} from "@splash/maintainx";

/** Production assignees — paged on real customer-claim submissions.
 *  Every object MUST include `type: "USER"`; MaintainX 400s otherwise
 *  with `assignees.0.type` fieldPath (confirmed 2026-05-06, Brief 46).
 *  The `MaintainXAssignee` annotation is what now makes the compiler
 *  enforce that, rather than MaintainX enforcing it at runtime. */
const ASSIGNEES_PRODUCTION: readonly MaintainXAssignee[] = [
  { type: "USER", id: 409112 }, // Brett Sullivan (bsullivan@splashcarwashes.com)
  { type: "USER", id: 426577 }  // Scott Butler   (scott.butler@splashcarwashes.com)
];

/** Test assignee — Josh only. Used for dev/staging probes. */
const ASSIGNEES_TEST: readonly MaintainXAssignee[] = [
  { type: "USER", id: 443948 }  // Josh Copp (josh.copp@splashcarwashes.com)
];

function assigneesByMode(mode: "production" | "test"): readonly MaintainXAssignee[] {
  return mode === "production" ? ASSIGNEES_PRODUCTION : ASSIGNEES_TEST;
}

/** Unchanged result shape. Aliased rather than redeclared so the two stay
 *  in lockstep; index.ts imports this name at three places. */
export type MaintainXResult = CreateWorkOrderResult;

interface CreateInput {
  claim: ClaimRow;
  locationPretty: string;
  maintainxLocationId: number | null;
  apiKey: string;
  mode: "production" | "test";
  baseUrl: string;
  appsWebBaseUrl: string;
  /** AbortSignal so the caller can enforce a timeout. */
  signal?: AbortSignal;
}

function valueOrDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const s = String(v).trim();
  return s.length > 0 ? s : "—";
}

function buildTitle(locationPretty: string, claim: ClaimRow): string {
  const damageTypeOrFallback = claim.damage_type ?? "Unspecified";
  if (claim.damage_type === "Other") {
    const other = (claim.damage_other ?? "").trim();
    const suffix = other ? `Other (${other})` : "Other";
    return `Damage Claim - ${locationPretty} - ${suffix}`;
  }
  return `Damage Claim - ${locationPretty} - ${damageTypeOrFallback}`;
}

function buildDescription(claim: ClaimRow, appsWebBaseUrl: string): string {
  const damageTypeLine =
    claim.damage_type === "Other" && (claim.damage_other ?? "").trim().length > 0
      ? `${claim.damage_type} (Other: ${claim.damage_other})`
      : valueOrDash(claim.damage_type);

  const vehicleLine = `${valueOrDash(claim.vehicle_year)} ${valueOrDash(
    claim.vehicle_make
  )} ${valueOrDash(claim.vehicle_model)} ${valueOrDash(
    claim.vehicle_color
  )} — Plate: ${valueOrDash(claim.license_plate)}`;

  const adminBase = appsWebBaseUrl.replace(/\/$/, "");
  const adminLink = `${adminBase}/admin/damage/${encodeURIComponent(claim.claim_id)}`;

  return [
    `Claim ID: ${claim.claim_id}`,
    `Submitted: ${claim.submitted_at}`,
    `Submitted by: ${claim.submitted_by}`,
    "",
    "Customer:",
    `  Name: ${valueOrDash(claim.customer_name)}`,
    `  Phone: ${valueOrDash(claim.customer_phone)}`,
    `  Email: ${valueOrDash(claim.customer_email)}`,
    "",
    "Vehicle:",
    `  ${vehicleLine}`,
    "",
    `Damage type: ${damageTypeLine}`,
    `Damage description: ${valueOrDash(claim.damage_description)}`,
    `Equipment involved: ${valueOrDash(claim.equipment_piece)}`,
    `Pre-existing damage: ${valueOrDash(claim.preexisting_damage)}`,
    `Determination: ${valueOrDash(claim.determination)}`,
    "",
    `Admin link: ${adminLink}`
  ].join("\n");
}

/**
 * Format and POST a damage claim to MaintainX as a Work Order.
 *
 * Never throws — the shared client catches fetch errors and surfaces them
 * as `ok: false`. Caller decides what to do with failures:
 * handleClaimSubmission swallows them and writes an activity-log entry;
 * the GM-side modal surfaces the error inline.
 */
export async function createMaintainXWorkOrder(
  input: CreateInput
): Promise<MaintainXResult> {
  return createWorkOrder({
    title: buildTitle(input.locationPretty, input.claim),
    description: buildDescription(input.claim, input.appsWebBaseUrl),
    priority: "HIGH",
    categories: ["Vehicle Damage"],
    assignees: assigneesByMode(input.mode),
    // Passed through as-is: the shared client omits the field entirely when
    // null, so an unmapped site still files a work order, just without a
    // location. That was the pre-extraction behaviour.
    locationId: input.maintainxLocationId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    signal: input.signal
  });
}
