// D1 claims queries. Source: legacy/damagemanager.js.
//
// The damage worker writes claims as a parallel record alongside SharePoint
// (Power Automate is the source of truth for finance/audit; D1 is the
// fast-read store for the manager UI). Photos and submission JSON go to R2
// unconditionally — D1 writes are best-effort (gotcha: damage worker still
// returns success even if D1 fails, since R2 has the canonical record).

import type { ClaimRow, ClaimStatus, LifecycleState } from "@splash/types/claims";

/**
 * Map form determination → initial claim_status.
 * Source: legacy/damagemanager.js:335 determinationToClaimStatus.
 *
 * IMPORTANT: em-dashes are U+2014. The DB has a CHECK constraint that
 * rejects mismatches (see legacy comment at line 334).
 */
export function determinationToClaimStatus(
  determination: string | null | undefined
): ClaimStatus {
  switch (determination) {
    case "no_responsibility":
      return "No Responsibility — Pending Review";
    case "requires_gm_review":
      return "Pending GM Review";
    case "customer_get_quotes":
      return "Approved — Pending Quotes";
    default:
      return "New — Pending Review";
  }
}

/**
 * Compute lifecycle_state from a claim_status. Source: legacy/damagemanager.js:1788.
 */
export function lifecycleForStatus(status: ClaimStatus): LifecycleState {
  return status.startsWith("Closed") ? "Closed" : "Open";
}

/**
 * Photo metadata to attach to a new claim's batch.
 */
export interface ClaimPhotoInsert {
  photoType: string;
  fileName: string;
  r2Key: string;
  contentType: string | null;
  fileSize: number | null;
}

/**
 * Payload for writeClaim (the full insert batch). Mirrors the shape the
 * damage worker hands to legacy writeClaimToD1, but pre-resolved
 * (location_pretty already looked up, photo r2_keys already known).
 */
export interface ClaimInsert {
  claim_id: string;
  location_code: string;
  location_pretty: string;

  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  customer_mailing_address: string | null;

  vehicle_year: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  license_plate: string | null;

  damage_description: string | null;
  preexisting_damage: string | null;
  staff_notes: string | null;

  determination: string | null;
  submitted_by: string;
  equipment_related: 0 | 1;
  equipment_piece: string | null;
  damage_type: string | null;
  damage_other: string | null;

  initial_status: ClaimStatus;
  submitted_at: string;

  photos: ReadonlyArray<ClaimPhotoInsert>;
}

/**
 * Atomic-per-statement batch: claims insert + N claim_photos inserts +
 * 'status_change' activity row for the initial submission.
 *
 * Mirrors legacy/damagemanager.js:345 writeClaimToD1.
 *
 * lifecycle_state is hardcoded to 'Open' in the legacy SQL — preserved here.
 * (The 'Open' literal is in the VALUES clause, not a parameter.)
 *
 * Per gotcha #254: D1 batches are atomic per-statement, not per-batch.
 * Partial writes are recoverable from the R2 submission JSON.
 */
export async function writeClaimBatch(db: D1Database, c: ClaimInsert): Promise<void> {
  const claimInsert = db
    .prepare(
      `INSERT INTO claims (
        claim_id,
        location_code,
        location_pretty,
        customer_name,
        customer_phone,
        customer_email,
        customer_mailing_address,
        vehicle_year,
        vehicle_make,
        vehicle_model,
        vehicle_color,
        license_plate,
        damage_description,
        preexisting_damage,
        staff_notes,
        determination,
        submitted_by,
        equipment_related,
        equipment_piece,
        damage_type,
        damage_other,
        lifecycle_state,
        claim_status,
        status_updated_by,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?)`
    )
    .bind(
      c.claim_id,
      c.location_code,
      c.location_pretty,
      c.customer_name,
      c.customer_phone,
      c.customer_email,
      c.customer_mailing_address,
      c.vehicle_year,
      c.vehicle_make,
      c.vehicle_model,
      c.vehicle_color,
      c.license_plate,
      c.damage_description,
      c.preexisting_damage,
      c.staff_notes,
      c.determination,
      c.submitted_by,
      c.equipment_related,
      c.equipment_piece,
      c.damage_type,
      c.damage_other,
      c.initial_status,
      c.submitted_by,
      c.submitted_at
    );

  const photoStmt = db.prepare(
    `INSERT INTO claim_photos (
      claim_id, photo_type, filename, r2_key, content_type, size_bytes, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const photoInserts = c.photos.map((p) =>
    photoStmt.bind(c.claim_id, p.photoType, p.fileName, p.r2Key, p.contentType, p.fileSize, c.submitted_by)
  );

  const activityInsert = db
    .prepare(
      `INSERT INTO claim_activity (
        claim_id, activity_type, status_from, status_to, notes, actor_name
      ) VALUES (?, 'status_change', NULL, ?, 'Initial submission', ?)`
    )
    .bind(c.claim_id, c.initial_status, c.submitted_by);

  await db.batch([claimInsert, ...photoInserts, activityInsert]);
}

/* ============================================================
 * Reads
 * ============================================================ */

export interface ClaimsListFilters {
  /** Restrict to a list of location codes; empty array → no rows. */
  locationCodes?: ReadonlyArray<string>;
  lifecycle?: LifecycleState | "All";
  claimStatus?: ClaimStatus;
  /** Substring match on customer_name. */
  search?: string;
  /** Brief 59 — inclusive ISO timestamp lower bound on submitted_at. */
  submittedFrom?: string;
  /** Brief 59 — inclusive ISO timestamp upper bound on submitted_at. */
  submittedTo?: string;
  limit?: number;
}

const CLAIMS_LIST_COLS =
  "claim_id, location_code, location_pretty, customer_name, vehicle_year, vehicle_make, vehicle_model, submitted_at, claim_status, lifecycle_state, contact_status";

/**
 * List claims for the manager grid with optional filters.
 * Source: legacy/damagemanager.js:1520 (fetchClaimsForUser, partial — the
 * full SQL is built dynamically there based on auth scope).
 */
export async function listClaims(
  db: D1Database,
  filters: ClaimsListFilters = {}
): Promise<Array<Pick<ClaimRow,
  | "claim_id" | "location_code" | "location_pretty" | "customer_name"
  | "vehicle_year" | "vehicle_make" | "vehicle_model" | "submitted_at"
  | "claim_status" | "lifecycle_state" | "contact_status">>> {
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];

  if (filters.locationCodes && filters.locationCodes.length > 0) {
    const placeholders = filters.locationCodes.map(() => "?").join(",");
    where.push(`location_code IN (${placeholders})`);
    params.push(...filters.locationCodes);
  } else if (filters.locationCodes && filters.locationCodes.length === 0) {
    // Caller asked us to scope to no locations — return nothing.
    return [];
  }

  if (filters.lifecycle && filters.lifecycle !== "All") {
    where.push("lifecycle_state = ?");
    params.push(filters.lifecycle);
  }
  if (filters.claimStatus) {
    where.push("claim_status = ?");
    params.push(filters.claimStatus);
  }
  if (filters.search && filters.search.trim()) {
    where.push("customer_name LIKE ?");
    params.push(`%${filters.search.trim()}%`);
  }
  if (filters.submittedFrom) {
    where.push("submitted_at >= ?");
    params.push(filters.submittedFrom);
  }
  if (filters.submittedTo) {
    where.push("submitted_at <= ?");
    params.push(filters.submittedTo);
  }

  const sql = `
    SELECT ${CLAIMS_LIST_COLS}
    FROM claims
    WHERE ${where.join(" AND ")}
    ORDER BY submitted_at DESC
    LIMIT ${filters.limit ?? 100}
  `;

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();
  return (result.results ?? []) as Array<Pick<ClaimRow,
    | "claim_id" | "location_code" | "location_pretty" | "customer_name"
    | "vehicle_year" | "vehicle_make" | "vehicle_model" | "submitted_at"
    | "claim_status" | "lifecycle_state" | "contact_status">>;
}

/**
 * Full claim row by id (excludes soft-deleted).
 * Source: legacy/damagemanager.js:2841.
 */
export async function getClaimById(db: D1Database, claimId: string): Promise<ClaimRow | null> {
  const row = await db
    .prepare("SELECT * FROM claims WHERE claim_id = ? AND deleted_at IS NULL")
    .bind(claimId)
    .first<ClaimRow>();
  return row ?? null;
}

/**
 * Brief 42 — set `claims.maintainx_workorder_id` on an existing claim row.
 *
 * Called immediately after a successful POST to MaintainX. Used as the
 * dedupe key when Brief 43's GM-side modal re-triggers WO creation: the
 * UPDATE only sets the column when it's currently NULL, so a second
 * concurrent attempt (e.g. legitimate retry vs. modal click) lands at
 * most one WO per claim. The first writer wins; later writers no-op.
 */
export async function updateMaintainXWorkOrderId(
  db: D1Database,
  claimId: string,
  workOrderId: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE claims SET maintainx_workorder_id = ? WHERE claim_id = ? AND maintainx_workorder_id IS NULL"
    )
    .bind(workOrderId, claimId)
    .run();
}
