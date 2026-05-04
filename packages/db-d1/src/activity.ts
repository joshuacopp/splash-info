// claim_activity (audit log) queries. Source: legacy/damagemanager.js.

import type { ActivityType, ClaimActivityRow, ClaimStatus } from "@splash/types/claims";

/**
 * List all activity rows for a claim (newest first by created_at, ties broken by id).
 * Source: legacy/damagemanager.js:2862.
 */
export async function listActivityForClaim(
  db: D1Database,
  claimId: string
): Promise<ClaimActivityRow[]> {
  const result = await db
    .prepare("SELECT * FROM claim_activity WHERE claim_id = ? ORDER BY created_at DESC, id DESC")
    .bind(claimId)
    .all<ClaimActivityRow>();
  return result.results ?? [];
}

/**
 * Append a status_change row. Used by the transition handler.
 * Source: legacy/damagemanager.js:2006-2009.
 */
export async function logStatusChange(
  db: D1Database,
  args: {
    claimId: string;
    statusFrom: ClaimStatus | null;
    statusTo: ClaimStatus;
    notes: string | null;
    actorEmail: string | null;
    actorName: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO claim_activity (
        claim_id, activity_type, status_from, status_to, notes, actor_email, actor_name
      ) VALUES (?, 'status_change', ?, ?, ?, ?, ?)`
    )
    .bind(
      args.claimId,
      args.statusFrom,
      args.statusTo,
      args.notes,
      args.actorEmail,
      args.actorName
    )
    .run();
}

/**
 * Append a free-form note row.
 * Source: legacy/damagemanager.js:1617-1620.
 */
export async function logNote(
  db: D1Database,
  args: {
    claimId: string;
    note: string;
    actorEmail: string | null;
    actorName: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO claim_activity (
        claim_id, activity_type, notes, actor_email, actor_name
      ) VALUES (?, 'note', ?, ?, ?)`
    )
    .bind(args.claimId, args.note, args.actorEmail, args.actorName)
    .run();
}

/**
 * Generic activity insert for cases that don't fit the helpers above
 * (e.g., 'document_added' from the doc-upload path).
 * Source: legacy/damagemanager.js:2598.
 */
export async function logActivity(
  db: D1Database,
  args: {
    claimId: string;
    activityType: ActivityType;
    notes: string | null;
    statusFrom?: ClaimStatus | null;
    statusTo?: ClaimStatus | null;
    actorEmail: string | null;
    actorName: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO claim_activity (
        claim_id, activity_type, status_from, status_to, notes, actor_email, actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      args.claimId,
      args.activityType,
      args.statusFrom ?? null,
      args.statusTo ?? null,
      args.notes,
      args.actorEmail,
      args.actorName
    )
    .run();
}

/**
 * Bump claims.updated_at after an activity write so the parent record
 * reflects recency. Source: legacy/damagemanager.js:1624.
 */
export async function touchClaim(db: D1Database, claimId: string): Promise<void> {
  await db
    .prepare("UPDATE claims SET updated_at = datetime('now') WHERE claim_id = ?")
    .bind(claimId)
    .run();
}
