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

  /**
   * Brief 138 — client-generated UUID v4 used to dedup retried submissions.
   * Backed by a partial unique index on `claims.idempotency_key`. Null when
   * the client didn't supply one (pre-Brief-138 callers; programmatic JSON
   * callers that skip the key).
   */
  idempotency_key?: string | null;

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
 *
 * Brief 140 — when the first batch fails with `no such column.*idempotency_key`
 * (the brief window between code push and operator-applied D1 migration), the
 * batch is retried with a legacy INSERT shape that drops the column. Any other
 * D1 error rethrows so the outer try/catch in `handleClaimSubmission` can
 * stamp `d1Success: false` and the worker can return a truthful 500.
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
        submitted_at,
        idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?)`
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
      c.submitted_at,
      c.idempotency_key ?? null
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

  try {
    await db.batch([claimInsert, ...photoInserts, activityInsert]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/no such column.*idempotency_key/i.test(errMsg)) {
      console.warn(
        "[claim.d1] idempotency_key column missing — fell back to legacy INSERT shape (apply schema migration)"
      );
      const legacyClaimInsert = db
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
      // Rebuild photo + activity statements — D1 prepared statements
      // can't be rebound after a failed batch.
      const legacyPhotoStmt = db.prepare(
        `INSERT INTO claim_photos (
          claim_id, photo_type, filename, r2_key, content_type, size_bytes, uploaded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const legacyPhotoInserts = c.photos.map((p) =>
        legacyPhotoStmt.bind(c.claim_id, p.photoType, p.fileName, p.r2Key, p.contentType, p.fileSize, c.submitted_by)
      );
      const legacyActivityInsert = db
        .prepare(
          `INSERT INTO claim_activity (
            claim_id, activity_type, status_from, status_to, notes, actor_name
          ) VALUES (?, 'status_change', NULL, ?, 'Initial submission', ?)`
        )
        .bind(c.claim_id, c.initial_status, c.submitted_by);
      try {
        await db.batch([legacyClaimInsert, ...legacyPhotoInserts, legacyActivityInsert]);
        return;
      } catch (retryErr) {
        // Surface the ORIGINAL column-missing error so callers know which
        // failure they're recovering from; the retry error is a downstream
        // symptom.
        throw err;
      }
    }
    throw err;
  }
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

// `age_days` is computed at query time via julianday() arithmetic (Brief 68).
// It is NOT a stored column on `claims` — future readers grep'ing the schema
// won't find it. The expression evaluates per-row inside the SELECT and rides
// on the JSON response without any handler change.
//
// On-the-fly is the right choice because (a) generated columns require
// deterministic expressions and `julianday('now')` is non-deterministic, and
// (b) a stored column would need a daily refresh cron for zero benefit at our
// scale.
const CLAIMS_LIST_COLS =
  "claim_id, location_code, location_pretty, customer_name, vehicle_year, vehicle_make, vehicle_model, submitted_at, claim_status, lifecycle_state, contact_status, CAST((julianday('now') - julianday(submitted_at)) AS INTEGER) AS age_days";

/**
 * Row shape returned by `listClaims`. Subset of `ClaimRow` plus the
 * server-computed `age_days` field (whole-day count since `submitted_at`).
 */
export type ClaimsListRow = Pick<ClaimRow,
  | "claim_id" | "location_code" | "location_pretty" | "customer_name"
  | "vehicle_year" | "vehicle_make" | "vehicle_model" | "submitted_at"
  | "claim_status" | "lifecycle_state" | "contact_status"> & {
  /** Whole days since `submitted_at`, computed at query time. */
  age_days: number;
};

/**
 * List claims for the manager grid with optional filters.
 * Source: legacy/damagemanager.js:1520 (fetchClaimsForUser, partial — the
 * full SQL is built dynamically there based on auth scope).
 */
export async function listClaims(
  db: D1Database,
  filters: ClaimsListFilters = {}
): Promise<ClaimsListRow[]> {
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
  return (result.results ?? []) as ClaimsListRow[];
}

/**
 * Brief 138 — point-read by `claims.idempotency_key`. Returns the matching
 * claim_id when a row exists for the supplied key, null otherwise.
 *
 * Used by the customer claim submit path to dedup retried submissions
 * (network blip, lost-response retry, Phase-4 backoff retry) before any
 * side effects fire. Worker catches "no such column" and falls through to
 * the no-dedup path during the brief window between code push and the
 * operator-applied D1 migration.
 */
export async function getClaimByIdempotencyKey(
  db: D1Database,
  idempotencyKey: string
): Promise<{ claim_id: string } | null> {
  const row = await db
    .prepare("SELECT claim_id FROM claims WHERE idempotency_key = ? LIMIT 1")
    .bind(idempotencyKey)
    .first<{ claim_id: string }>();
  return row ?? null;
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
