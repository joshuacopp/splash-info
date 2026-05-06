// Brief 42 — MaintainX work-order creation helper.
//
// Single responsibility: format and POST a Work Order to the MaintainX
// REST API. Returns a structured result object — never throws (fetch
// errors are caught and surfaced as ok:false). Caller decides what to do
// with failures: handleClaimSubmission swallows them and writes an
// activity-log entry; Brief 43's GM-side modal will surface the error
// inline.
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

/** Production assignees — paged on real customer-claim submissions. */
const ASSIGNEES_PRODUCTION = [{ id: 409112 }, { id: 426577 }] as const;

/** Test assignee — Josh only. Used for dev/staging probes. */
const ASSIGNEES_TEST = [{ id: 443948 }] as const;

function assigneesByMode(mode: "production" | "test"): ReadonlyArray<{ id: number }> {
  return mode === "production" ? ASSIGNEES_PRODUCTION : ASSIGNEES_TEST;
}

/** Cap on the body text echoed back in the error string when MaintainX
 *  returns a non-2xx — keeps activity-log entries from bloating. */
const ERROR_BODY_MAX_BYTES = 2 * 1024;

export interface MaintainXResult {
  ok: boolean;
  workOrderId: number | null;
  error: string | null;
  /** HTTP status (or 0 if request never sent / network error). */
  status: number;
  /** Compact payload echoed back for audit/log purposes. */
  request: Record<string, unknown>;
}

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

function buildPayload(input: CreateInput): Record<string, unknown> {
  const title = buildTitle(input.locationPretty, input.claim);
  const description = buildDescription(input.claim, input.appsWebBaseUrl);
  const assignees = assigneesByMode(input.mode);
  const body: Record<string, unknown> = {
    title,
    description,
    priority: "HIGH",
    categories: ["Vehicle Damage"],
    assignees
  };
  if (input.maintainxLocationId != null) {
    body.locationId = input.maintainxLocationId;
  }
  return body;
}

/**
 * Extract the created Work Order ID from a MaintainX response body. The
 * API response shape isn't formally locked in this repo yet — try the
 * top-level `id` first (MaintainX docs example), then `workOrder.id`,
 * then `data.id`. Returns null if none parse.
 */
function extractWorkOrderId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const candidates: unknown[] = [
    obj.id,
    (obj.workOrder as { id?: unknown } | undefined)?.id,
    (obj.data as { id?: unknown } | undefined)?.id
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && /^\d+$/.test(c)) return Number.parseInt(c, 10);
  }
  return null;
}

export async function createMaintainXWorkOrder(
  input: CreateInput
): Promise<MaintainXResult> {
  const body = buildPayload(input);
  const url = `${input.baseUrl.replace(/\/$/, "")}/workorders`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(body),
      signal: input.signal
    });
  } catch (e) {
    return {
      ok: false,
      workOrderId: null,
      error: e instanceof Error ? e.message : String(e),
      status: 0,
      request: body
    };
  }

  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      // ignore — we'll surface the bare status
    }
    const truncated = errText.slice(0, ERROR_BODY_MAX_BYTES);
    return {
      ok: false,
      workOrderId: null,
      error: `MX ${res.status}: ${truncated}`,
      status: res.status,
      request: body
    };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Non-JSON body on a 2xx — surface as a parse failure but keep status.
    return {
      ok: false,
      workOrderId: null,
      error: `MX ${res.status}: response was not valid JSON`,
      status: res.status,
      request: body
    };
  }

  const workOrderId = extractWorkOrderId(parsed);
  if (workOrderId == null) {
    return {
      ok: false,
      workOrderId: null,
      error: `MX ${res.status}: response missing recognizable work order id (tried id, workOrder.id, data.id)`,
      status: res.status,
      request: body
    };
  }

  return {
    ok: true,
    workOrderId,
    error: null,
    status: res.status,
    request: body
  };
}
