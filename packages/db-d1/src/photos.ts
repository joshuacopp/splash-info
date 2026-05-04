// claim_photos queries. Source: legacy/damagemanager.js.

import type { ClaimPhotoRow, PayToType } from "@splash/types/claims";

/**
 * List active photos / docs for a claim. Source: legacy/damagemanager.js:2860.
 */
export async function listPhotosForClaim(
  db: D1Database,
  claimId: string
): Promise<ClaimPhotoRow[]> {
  const result = await db
    .prepare("SELECT * FROM claim_photos WHERE claim_id = ? AND deleted_at IS NULL ORDER BY id ASC")
    .bind(claimId)
    .all<ClaimPhotoRow>();
  return result.results ?? [];
}

/**
 * Insert a single photo row (used by the claim-submission batch as a
 * standalone helper when we need to attach a photo after the initial batch
 * — e.g., a Quote uploaded later).
 *
 * Source: legacy/damagemanager.js:448-451 base photo insert.
 */
export async function insertPhoto(
  db: D1Database,
  args: {
    claimId: string;
    photoType: string;
    filename: string;
    r2Key: string;
    contentType: string | null;
    sizeBytes: number | null;
    uploadedBy: string;
  }
): Promise<{ id: number | null }> {
  const result = await db
    .prepare(
      `INSERT INTO claim_photos (
        claim_id, photo_type, filename, r2_key, content_type, size_bytes, uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      args.claimId,
      args.photoType,
      args.filename,
      args.r2Key,
      args.contentType,
      args.sizeBytes,
      args.uploadedBy
    )
    .run();
  return { id: result.meta?.last_row_id ?? null };
}

/**
 * Insert a doc row (Quote / Receipt / Check Request) — same table as
 * photos but with extra columns populated.
 *
 * Source: legacy/damagemanager.js:2583 doc insert.
 */
export async function insertDocPhoto(
  db: D1Database,
  args: {
    claimId: string;
    docType: string; // ClaimPhotoType but kept as string here to allow Check Request etc.
    filename: string;
    r2Key: string;
    contentType: string | null;
    vendor: string | null;
    amount: number | null;
    notes: string | null;
    payToType: PayToType | null;
    vendorAddress: string | null;
    uploadedBy: string;
  }
): Promise<{ id: number | null }> {
  const result = await db
    .prepare(
      `INSERT INTO claim_photos (
        claim_id, photo_type, r2_key, filename, content_type,
        vendor, amount, notes, uploaded_by, pay_to_type, vendor_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      args.claimId,
      args.docType,
      args.r2Key,
      args.filename,
      args.contentType,
      args.vendor,
      args.amount,
      args.notes,
      args.uploadedBy,
      args.payToType,
      args.vendorAddress
    )
    .run();
  return { id: result.meta?.last_row_id ?? null };
}

/**
 * Update doc-specific columns on a Quote/Receipt row.
 * Source: legacy/damagemanager.js:2807.
 */
export async function updateDocMetadata(
  db: D1Database,
  args: {
    id: number;
    vendor: string | null;
    amount: number | null;
    notes: string | null;
    payToType: PayToType | null;
    vendorAddress: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      "UPDATE claim_photos SET vendor = ?, amount = ?, notes = ?, pay_to_type = ?, vendor_address = ? WHERE id = ?"
    )
    .bind(args.vendor, args.amount, args.notes, args.payToType, args.vendorAddress, args.id)
    .run();
}

/**
 * Soft-delete a photo / doc row.
 * Source: legacy/damagemanager.js:2678.
 */
export async function softDeletePhoto(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE claim_photos SET deleted_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

/**
 * Count of active photos of a given type on a claim — used to stop duplicate
 * Check Request inserts. Source: legacy/damagemanager.js:2333, :2440.
 */
export async function countPhotosOfType(
  db: D1Database,
  claimId: string,
  photoType: string
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM claim_photos WHERE claim_id = ? AND photo_type = ? AND deleted_at IS NULL")
    .bind(claimId, photoType)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
