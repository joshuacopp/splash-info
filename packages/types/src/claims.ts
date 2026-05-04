// Damage-claims types (D1). Column names extracted directly from
// legacy/damagemanager.js — DO NOT rename without verifying the D1 schema.

/**
 * Lifecycle bucket. Computed by lifecycleForStatus() in legacy:
 *   "Closed — *" → "Closed", everything else → "Open".
 * Source: legacy/damagemanager.js:1790.
 */
export type LifecycleState = "Open" | "Closed";

/**
 * Form determination — picked by the employee on the public claim form.
 * Source: legacy/damagemanager.js:23-27 DETERMINATION_CHOICES.
 */
export type ClaimDetermination =
  | "no_responsibility"
  | "requires_gm_review"
  | "customer_get_quotes";

/**
 * Full claim_status enum. Em-dashes are U+2014 — gotcha #254 (and the legacy
 * comment at line 334): the DB has a CHECK constraint that rejects mismatches.
 *
 * 14 statuses are listed in legacy/damagemanager.js:2884 CLAIM_STATUSES.
 * "Approved — Submitted for Payment" appears in the transition table
 * (legacy/damagemanager.js:1715, 1719, 1737, 1738, 2042) and is therefore
 * a real production status — but it is NOT in the CLAIM_STATUSES constant.
 * Including it here brings the count to 15, matching the migration plan
 * §5 step 1 ("~15 states"). See Step 5A findings for the open question.
 */
export type ClaimStatus =
  | "New — Pending Review"
  | "No Responsibility — Pending Review"
  | "Pending GM Review"
  | "Pending RM Review"
  | "Approved — Pending Quotes"
  | "Pending RM Quote Approval"
  | "Approved — In House — Parts Ordered"
  | "Approved — In House — Repaired"
  | "Approved — Check Request Submitted"
  | "Approved — Submitted for Payment"
  | "Approved — Pending CEO Approval"
  | "Approved — Check Issued"
  | "Closed — Paid"
  | "Closed — Denied"
  | "Closed — Approved/No Response";

/**
 * Photo / document categories on claim_photos.
 * Source:
 *   - legacy/damagemanager.js:120-125 photoCategories (Vehicle Overview / VIN /
 *     Damage / License Plate)
 *   - legacy/damagemanager.js:2271 "Quote" rows (with vendor / amount cols)
 *   - legacy/damagemanager.js:2334 "Check Request" PDFs
 *   - "Receipt" — legacy/damagemanager.js:2539 ("Quote vs Receipt" branching)
 */
export type ClaimPhotoType =
  | "Vehicle Overview"
  | "VIN"
  | "Damage"
  | "License Plate"
  | "Quote"
  | "Receipt"
  | "Check Request";

/**
 * Pay-to selection on Quote rows.
 * Source: legacy/damagemanager.js:4074-4075 form values.
 */
export type PayToType = "customer" | "vendor";

/**
 * Activity-log entry types.
 * Source: legacy/damagemanager.js — observed activity_type literals.
 *
 * Legacy overloads "document_added" for uploads, edits, AND deletions,
 * distinguished by the notes prose ("Uploaded ..." / "Edited ..." /
 * "Deleted ..."). An audit-log annoyance but not a bug — preserved here
 * to avoid the cost of a D1 CHECK-constraint rebuild migration.
 */
export type ActivityType = "status_change" | "note" | "document_added";

/**
 * Audit-stamp groups. Used to decide which gm/rm/ceo_approved_* columns
 * the worker bumps on a transition. Source: legacy/damagemanager.js:1803.
 */
export type AuditStampRole = "gm" | "rm" | "ceo";

/**
 * Roles used in the damage worker for transition gating. Distinct from
 * UserRole in auth.ts — these come from auth.dc_role (computed in the auth
 * helper based on user_permissions + locations + admin status).
 *
 * Observed in legacy/damagemanager.js transition entries:
 *   - "gm"          : general manager
 *   - "rm"          : regional manager
 *   - "admin"       : non-super-admin admins (incidents desk)
 *   - "super_admin" : derived; can do anything
 */
export type DamageRole = "gm" | "rm" | "admin" | "super_admin";

/**
 * Row shape of the `claims` D1 table.
 *
 * Sources:
 *   - legacy/damagemanager.js:397-420 INSERT INTO claims columns
 *   - legacy/damagemanager.js:1556-1567 SELECT (claim_id, location_code,
 *     location_pretty, customer_name, vehicle_year, vehicle_make,
 *     vehicle_model, submitted_at, claim_status, lifecycle_state,
 *     contact_status)
 *   - legacy/damagemanager.js:1958-1998 UPDATE setParts (status_updated_at,
 *     gm_approved_at/by, rm_approved_at/by, ceo_approved_at/by, approved_amount,
 *     parts_ordered, vendor_name, approved_quote_id)
 *   - legacy/damagemanager.js:2841 SELECT * FROM claims WHERE claim_id = ?
 *     AND deleted_at IS NULL  (so deleted_at exists on claims too)
 *
 * `contact_status` is read but never written by the legacy code — only one
 * value observed, "Not Started" (legacy/damagemanager.js:2930). Other valid
 * values are unknown. See Step 5A findings.
 */
export interface ClaimRow {
  claim_id: string;
  location_code: string;
  location_pretty: string;

  // Customer
  customer_name: string;
  /** 10-digit phone, no formatting; nulled if no digits supplied. */
  customer_phone: string | null;
  customer_email: string | null;
  customer_mailing_address: string | null;

  // Vehicle
  vehicle_year: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  license_plate: string | null;

  // Damage description
  damage_description: string | null;
  preexisting_damage: string | null;
  staff_notes: string | null;

  // Initial assessment
  determination: ClaimDetermination | null;
  submitted_by: string;
  /** 0 if equipmentInvolved is empty or "N/A", else 1. */
  equipment_related: 0 | 1;
  equipment_piece: string | null;

  // State
  lifecycle_state: LifecycleState;
  claim_status: ClaimStatus;
  /** Free-form contact-status string. Only "Not Started" observed. */
  contact_status: string | null;

  // Timestamps
  submitted_at: string;
  status_updated_at: string | null;
  status_updated_by: string | null;
  updated_at: string | null;

  // Audit stamps (set when a transition's stamps[] includes the role)
  gm_approved_at: string | null;
  gm_approved_by: string | null;
  rm_approved_at: string | null;
  rm_approved_by: string | null;
  ceo_approved_at: string | null;
  ceo_approved_by: string | null;

  // Approval details
  approved_amount: number | null;
  approved_quote_id: number | null;
  /** Free-form notes captured at "Approve — In House Repair" time. */
  parts_ordered: string | null;
  vendor_name: string | null;

  // Soft delete
  deleted_at: string | null;
}

/**
 * Row shape of `claim_photos`. Doc-specific columns (vendor/amount/notes/
 * pay_to_type/vendor_address) are populated only on Quote/Receipt rows;
 * NULL on plain photos.
 *
 * Sources:
 *   - legacy/damagemanager.js:449-451 (initial INSERT — claim_id, photo_type,
 *     filename, r2_key, content_type, size_bytes, uploaded_by)
 *   - legacy/damagemanager.js:2585-2587 (doc INSERT — adds vendor, amount,
 *     notes, pay_to_type, vendor_address)
 *   - legacy/damagemanager.js:2860 SELECT * ... ORDER BY id ASC (id, deleted_at)
 *   - legacy/damagemanager.js:2347 (Check Request PDF inserts as claim_photos)
 */
export interface ClaimPhotoRow {
  id: number;
  claim_id: string;
  photo_type: ClaimPhotoType;
  filename: string;
  r2_key: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;

  // Doc columns (Quote / Receipt only)
  vendor: string | null;
  amount: number | null;
  notes: string | null;
  pay_to_type: PayToType | null;
  vendor_address: string | null;

  deleted_at: string | null;
}

/**
 * Row shape of `claim_activity` (audit / activity log).
 *
 * Sources:
 *   - legacy/damagemanager.js:467-468 initial INSERT (claim_id, activity_type,
 *     status_from, status_to, notes, actor_name)
 *   - legacy/damagemanager.js:1618-1620 note INSERT (+ actor_email)
 *   - legacy/damagemanager.js:2007-2009 status_change INSERT (full set)
 *   - legacy/damagemanager.js:2862 ORDER BY created_at DESC, id DESC
 */
export interface ClaimActivityRow {
  id: number;
  claim_id: string;
  activity_type: ActivityType;
  status_from: ClaimStatus | null;
  status_to: ClaimStatus | null;
  notes: string | null;
  actor_email: string | null;
  /** Free-form actor name; "Unknown" or "system" sentinel allowed. */
  actor_name: string;
  created_at: string;
}
