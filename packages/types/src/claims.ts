// Damage-claims types (D1). Column names extracted directly from
// legacy/damagemanager.js — DO NOT rename without verifying the D1 schema.

/**
 * Lifecycle bucket. Computed by lifecycleForStatus() in legacy:
 *   "Closed — *" → "Closed", everything else → "Open".
 * Source: legacy/damagemanager.js:1790.
 *
 * Brief 172: the stored `claims.lifecycle_state` column stays binary
 * (CHECK constraint allows only 'Open' | 'Closed' — SQLite can't ALTER a
 * CHECK in place). The 3-way DisplayLifecycleState below is DERIVED at
 * read time from claim_status for UI / filter purposes; never stored.
 */
export type LifecycleState = "Open" | "Closed";

/**
 * Brief 172 — 3-way display bucket derived from claim_status. The third
 * value "Awaiting Payment" carves out the three post-approval finance-
 * stage claim_statuses (see AWAITING_PAYMENT_STATUSES) so the ops queue
 * (default lifecycle=Open) doesn't show claims that are sitting with
 * finance/AP. NOT stored — every renderer + filter that needs the 3-way
 * derives via displayLifecycleForStatus(status).
 */
export type DisplayLifecycleState = "Open" | "Awaiting Payment" | "Closed";

/**
 * Brief 172 — claim_status values that belong in the "Awaiting Payment"
 * derived bucket. Em-dashes are U+2014 — must match ClaimStatus enum
 * verbatim or the IN-clause in db-d1's listClaims won't match anything.
 *
 * Membership rationale (operator-locked decision): all three post-quote-
 * approval payment statuses count as Awaiting Payment because the ops
 * team (GM/RM) has no remaining action — the claim is sitting with
 * finance/AP. Trimming the set (e.g. "Check Issued" only counts as
 * Closed-ish) is a one-line change to this array.
 */
export const AWAITING_PAYMENT_STATUSES: readonly ClaimStatus[] = [
  "Approved — Check Request Submitted",
  "Approved — Submitted for Payment",
  "Approved — Check Issued"
];

/**
 * Brief 172 — derive the 3-way display bucket from a claim_status.
 *
 *   Closed (claim_status startsWith "Closed —") → "Closed"
 *   In AWAITING_PAYMENT_STATUSES                → "Awaiting Payment"
 *   Everything else                              → "Open"
 *
 * `lifecycleForStatus` (in @splash/db-d1) stays unchanged and returns the
 * binary stored value; this helper produces the derived 3-way value used
 * by every UI badge / KPI / filter.
 */
export function displayLifecycleForStatus(
  status: ClaimStatus
): DisplayLifecycleState {
  if (status.startsWith("Closed")) return "Closed";
  if ((AWAITING_PAYMENT_STATUSES as readonly string[]).includes(status)) {
    return "Awaiting Payment";
  }
  return "Open";
}

/**
 * Brief 172 — cause / fault-attribution allow-list. NULL on existing +
 * new rows means "Undetermined" — the default; the operator runs a
 * `ALTER TABLE claims ADD COLUMN fault_category TEXT CHECK (...)` to
 * land the column (see brief Report section for exact SQL). Worker
 * tolerates the column being absent during the brief window between
 * code push and the operator-applied D1 migration via the Brief 138/140
 * `/no such column.*fault_category/i` try/catch pattern.
 */
export type FaultCategory =
  | "Employee Error"
  | "Equipment Malfunction"
  | "Not Employee/Equipment"
  | "No Fault";

export const FAULT_CATEGORIES: readonly FaultCategory[] = [
  "Employee Error",
  "Equipment Malfunction",
  "Not Employee/Equipment",
  "No Fault"
];

/**
 * Form determination — picked by the employee on the public claim form.
 * Source: legacy/damagemanager.js:23-27 DETERMINATION_CHOICES.
 */
export type ClaimDetermination =
  | "no_responsibility"
  | "requires_gm_review"
  | "customer_get_quotes";

/**
 * Full claim_status enum. Em-dashes are U+2014 — gotcha #254.
 *
 * CORRECTION (2026-08-17): the long-standing comment here (and at line 334 of
 * the legacy file, and in several other places) claimed the DB has a CHECK
 * constraint on claim_status that rejects hyphen variants. It does not — the
 * live DDL was dumped and `claim_status` is plain `TEXT NOT NULL DEFAULT
 * 'New — Pending Review'` with no CHECK. The only CHECKs on `claims` are on
 * lifecycle_state, site_approval_status, contact_owner, contact_status,
 * maintainx_priority and fault_category. So em-dash discipline is enforced by
 * this union and nothing else: a hyphen variant would insert silently and then
 * fall out of every status filter. Upside — adding a status needs no migration.
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
  | "Approved — Check Request Submitted"
  | "Approved — Submitted for Payment"
  | "Approved — Pending CEO Approval"
  | "Approved — Check Issued"
  | "Closed — Paid"
  | "Closed — Denied"
  | "Closed — Approved/No Response"
  /**
   * Added 2026-08-17, replacing "Approved — In House — Repaired".
   *
   * The claim was resolved by the location at no cost to the company —
   * buffed out on the spot, comped washes, a courtesy detail. The customer
   * was made whole; no money left the claims budget.
   *
   * Why it exists: the in-house branch used to dead-end at
   * "Approved — In House — Parts Ordered → Closed — Paid", which requires a
   * receipt on file. A GM who fixed something for free had nothing to
   * upload and no way to close, so these claims were being marked
   * "Closed — Denied" — which reads as "we told the customer no" and is the
   * opposite of what happened. That mis-labelling is visible in the 2026
   * backfill: every hand-worked in-kind settlement landed on Denied.
   *
   * "Approved — In House — Repaired" was the natural home for this, but it
   * had no inbound transition in the table and never had — it was a dead
   * enum value referenced only by the two transition tables, the pill map,
   * the waiting-on map and the filter dropdown. Rather than resurrect a
   * status whose name implies an approval step that doesn't happen here,
   * it was replaced outright.
   *
   * Counts as an APPROVED outcome in the KPIs (alongside Closed — Paid and
   * Closed — Approved/No Response), because responsibility was accepted —
   * it simply cost $0. The transitions into it require a note, which is the
   * record of what was actually done.
   */
  | "Closed — Settled";

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
  /**
   * Feature 4 — required at submission from a fixed dropdown on the claim
   * form: one of "Poor" | "Fair" | "Good" | "Excellent". Nullable on the row
   * type for pre-migration claims (column added after existing rows).
   */
  vehicle_condition: string | null;
  staff_notes: string | null;

  // Initial assessment
  determination: ClaimDetermination | null;
  submitted_by: string;
  /** 0 if equipmentInvolved is empty or "N/A", else 1. */
  equipment_related: 0 | 1;
  equipment_piece: string | null;
  /** Brief 41 — damage_type allow-list (11 values; "Other" pairs with damage_other). */
  damage_type: string | null;
  /** Brief 41 — free-text description when damage_type === "Other"; ≤200 chars. */
  damage_other: string | null;

  // State
  lifecycle_state: LifecycleState;
  claim_status: ClaimStatus;
  /** Free-form contact-status string. Only "Not Started" observed. */
  contact_status: string | null;

  // Timestamps
  submitted_at: string;
  /**
   * Date + time the customer says the damage actually occurred, stored as
   * 'YYYY-MM-DD HH:MM[:SS]'. Required on the claim form (validated in the
   * worker), but nullable on the row type: backfill/legacy rows may hold a
   * date-only value or none, and reads collapse to null when the column is
   * briefly absent during the deploy window.
   */
  incident_date: string | null;
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

  /** Brief 42 — MaintainX work-order ID. NULL means: not yet attempted,
   *  MaintainX call failed, or not applicable (equipment_related=0).
   *  NOT NULL means: WO created — used as the dedupe key when Brief 43's
   *  GM-side modal re-triggers WO creation. */
  maintainx_workorder_id: number | null;

  /** Brief 172 — cause / fault attribution. One of
   *  `Employee Error` | `Equipment Malfunction` | `Not Employee/Equipment`,
   *  or NULL for unset (the default — surfaces as "Undetermined" in UI).
   *  Settable by any damage role (gm/rm/admin/super_admin) via
   *  POST /manage/api/claim/{id}/fault-category. Pre-migration windows
   *  (column absent in D1) are tolerated by the worker via the
   *  Brief 138/140 `/no such column.*fault_category/i` try/catch pattern;
   *  reads collapse to null when the column is missing. */
  fault_category: FaultCategory | null;

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
