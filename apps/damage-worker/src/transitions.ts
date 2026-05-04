// Damage-claim state machine — pre-computed transition table.
//
// AUDIT-FRIENDLY DESIGN per Josh's directive: each transition entry is
// explicit about which roles can perform it, what fields it requires, and
// which audit columns it stamps. The hierarchy expansion (`role: "gm"` →
// `allowedRoles: ["gm", "rm", "admin", "super_admin"]`) happens at module
// load via `tx(...)` so the runtime check is a single
// `transition.allowedRoles.includes(session.dcRole)` array lookup — no
// per-request hierarchy comparison.
//
// Source-of-truth: legacy/damagemanager.js:1640-1749. Field-by-field port.
//
// Drift here is an authorization bug. Do not modify any entry without
// verifying against the legacy table (and the tests/manual cases that
// exercise it). Adding a NEW transition is OK; changing an existing
// entry's role / requirements is not — that's a security change.

import type { ClaimStatus, DamageRole } from "@splash/types/claims";

/**
 * CEO threshold from legacy/damagemanager.js:1654.
 *
 * VESTIGIAL: no transition in this table sets `ceoEligible: true`, and the
 * quote-selection path explicitly opted out of CEO auto-routing per
 * legacy/damagemanager.js:1950 ("// CEO auto-routing dropped per 6d.
 * Incidents handles CEO conversation offline."). The "Approved — Pending
 * CEO Approval" status is therefore unreachable for new claims; only the
 * admin escape-hatch transitions FROM it remain (lines 1721-1723).
 *
 * Preserved as-is per Josh's directive — do not refactor or remove.
 * TODO: verify with Josh whether to keep this constant + ceoEligible field
 * or drop them in a later cleanup pass.
 */
export const CEO_APPROVAL_THRESHOLD = 1000;

/** Damage workflow role hierarchy: lowest to highest privilege. */
const DAMAGE_ROLE_HIERARCHY: readonly DamageRole[] = [
  "gm",
  "rm",
  "admin",
  "super_admin"
] as const;

/** Expand a minimum role to the explicit list of allowed roles. */
function rolesAtLeast(minimum: DamageRole): readonly DamageRole[] {
  const idx = DAMAGE_ROLE_HIERARCHY.indexOf(minimum);
  return DAMAGE_ROLE_HIERARCHY.slice(idx);
}

/** Audit-stamp column families on the claims row. */
export type AuditStamp = "gm" | "rm" | "ceo";

/**
 * Server-side transition definition. UI-only fields from legacy (label,
 * prominent, notePlaceholder, reopen) are NOT included — those live in
 * the apps/web table.
 */
export interface ClaimTransitionDef {
  from: ClaimStatus;
  to: ClaimStatus;
  /** Pre-computed list of allowed roles. Audit by reading this field. */
  allowedRoles: readonly DamageRole[];
  requiresNote: boolean;
  requiresAmount: boolean;
  requiresQuoteSelection: boolean;
  requiresReceiptOnFile: boolean;
  /** Field names the form must include and that must be non-empty. */
  requiresInputs: readonly string[];
  /** Field names the form may include; captured if non-empty. */
  optionalInputs: readonly string[];
  /**
   * If true AND requiresAmount AND amount > CEO_APPROVAL_THRESHOLD →
   * destination rerouted to "Approved — Pending CEO Approval". Currently
   * dormant — see CEO_APPROVAL_THRESHOLD doc above.
   */
  ceoEligible: boolean;
  /** Audit-stamp column families to bump on the claim row. */
  stamps: readonly AuditStamp[];
}

interface TransitionShorthand {
  from: ClaimStatus;
  to: ClaimStatus;
  /** Minimum role; expanded to allowedRoles via DAMAGE_ROLE_HIERARCHY. */
  role: DamageRole;
  requiresNote?: boolean;
  requiresAmount?: boolean;
  requiresQuoteSelection?: boolean;
  requiresReceiptOnFile?: boolean;
  requiresInputs?: readonly string[];
  optionalInputs?: readonly string[];
  ceoEligible?: boolean;
  stamps?: readonly AuditStamp[];
}

function tx(t: TransitionShorthand): ClaimTransitionDef {
  return {
    from: t.from,
    to: t.to,
    allowedRoles: rolesAtLeast(t.role),
    requiresNote: !!t.requiresNote,
    requiresAmount: !!t.requiresAmount,
    requiresQuoteSelection: !!t.requiresQuoteSelection,
    requiresReceiptOnFile: !!t.requiresReceiptOnFile,
    requiresInputs: t.requiresInputs ?? [],
    optionalInputs: t.optionalInputs ?? [],
    ceoEligible: !!t.ceoEligible,
    stamps: t.stamps ?? []
  };
}

/**
 * The full transition table. Audit-friendly: each row is a pure-data spec.
 * Order matches legacy/damagemanager.js:1673-1749 for diff-friendly review.
 */
export const CLAIM_TRANSITIONS: readonly ClaimTransitionDef[] = [
  // ===== From "New — Pending Review" (currently unused — schema default) =====
  tx({ from: "New — Pending Review", to: "Pending GM Review", role: "gm" }),
  tx({ from: "New — Pending Review", to: "No Responsibility — Pending Review", role: "gm" }),
  tx({ from: "New — Pending Review", to: "Closed — Denied", role: "gm" }),

  // ===== From "No Responsibility — Pending Review" =====
  tx({ from: "No Responsibility — Pending Review", to: "Closed — Denied", role: "gm" }),
  tx({
    from: "No Responsibility — Pending Review",
    to: "Pending GM Review",
    role: "rm",
    requiresNote: true
  }),

  // ===== From "Pending GM Review" =====
  tx({ from: "Pending GM Review", to: "Approved — Pending Quotes", role: "gm" }),
  tx({
    from: "Pending GM Review",
    to: "Approved — In House — Parts Ordered",
    role: "gm",
    optionalInputs: ["parts", "vendor"]
  }),
  tx({ from: "Pending GM Review", to: "Pending RM Review", role: "gm" }),
  tx({ from: "Pending GM Review", to: "Closed — Denied", role: "gm" }),

  // ===== From "Pending RM Review" =====
  tx({ from: "Pending RM Review", to: "Approved — Pending Quotes", role: "rm" }),
  tx({
    from: "Pending RM Review",
    to: "Approved — In House — Parts Ordered",
    role: "rm",
    optionalInputs: ["parts", "vendor"]
  }),
  tx({ from: "Pending RM Review", to: "Closed — Denied", role: "rm" }),
  tx({ from: "Pending RM Review", to: "Pending GM Review", role: "rm", requiresNote: true }),

  // ===== From "Approved — Pending Quotes" =====
  tx({ from: "Approved — Pending Quotes", to: "Pending RM Quote Approval", role: "gm" }),
  tx({ from: "Approved — Pending Quotes", to: "Closed — Approved/No Response", role: "gm" }),

  // ===== From "Pending RM Quote Approval" =====
  // Approve quote: requiresQuoteSelection — selected quote's amount becomes
  // claim.approved_amount. CEO routing intentionally NOT applied here per
  // legacy/damagemanager.js:1950.
  tx({
    from: "Pending RM Quote Approval",
    to: "Approved — Check Request Submitted",
    role: "rm",
    requiresQuoteSelection: true
  }),
  tx({ from: "Pending RM Quote Approval", to: "Closed — Denied", role: "rm" }),

  // ===== From "Approved — In House — Parts Ordered" =====
  tx({
    from: "Approved — In House — Parts Ordered",
    to: "Closed — Paid",
    role: "gm",
    requiresReceiptOnFile: true
  }),

  // ===== From "Approved — In House — Repaired" =====
  tx({ from: "Approved — In House — Repaired", to: "Closed — Paid", role: "gm" }),

  // ===== From "Approved — Check Request Submitted" =====
  tx({
    from: "Approved — Check Request Submitted",
    to: "Approved — Submitted for Payment",
    role: "admin"
  }),

  // ===== From "Approved — Submitted for Payment" =====
  tx({ from: "Approved — Submitted for Payment", to: "Closed — Paid", role: "admin" }),

  // ===== From "Approved — Pending CEO Approval" (vestigial — admin dropdown only) =====
  tx({
    from: "Approved — Pending CEO Approval",
    to: "Approved — Check Request Submitted",
    role: "admin",
    stamps: ["ceo"]
  }),
  tx({
    from: "Approved — Pending CEO Approval",
    to: "Closed — Denied",
    role: "admin",
    stamps: ["ceo"]
  }),

  // ===== From "Approved — Check Issued" =====
  tx({ from: "Approved — Check Issued", to: "Closed — Paid", role: "rm" }),

  // ===== Admin escape hatches: kick mid-workflow states back =====
  tx({
    from: "Approved — Pending Quotes",
    to: "Pending GM Review",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Pending Quotes",
    to: "Pending RM Review",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Pending RM Quote Approval",
    to: "Pending GM Review",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Pending RM Quote Approval",
    to: "Approved — Pending Quotes",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — In House — Parts Ordered",
    to: "Pending GM Review",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — In House — Repaired",
    to: "Approved — In House — Parts Ordered",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Check Request Submitted",
    to: "Pending RM Quote Approval",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Submitted for Payment",
    to: "Approved — Check Request Submitted",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Submitted for Payment",
    to: "Pending RM Quote Approval",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Check Issued",
    to: "Approved — Check Request Submitted",
    role: "admin",
    requiresNote: true
  }),

  // ===== Reopen transitions (admin/super_admin only — closed → open) =====
  tx({ from: "Closed — Paid", to: "Pending GM Review", role: "admin", requiresNote: true }),
  tx({ from: "Closed — Paid", to: "Pending RM Review", role: "admin", requiresNote: true }),
  tx({ from: "Closed — Denied", to: "Pending GM Review", role: "admin", requiresNote: true }),
  tx({ from: "Closed — Denied", to: "Pending RM Review", role: "admin", requiresNote: true }),
  tx({
    from: "Closed — Approved/No Response",
    to: "Pending RM Quote Approval",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Closed — Approved/No Response",
    to: "Approved — Check Request Submitted",
    role: "admin",
    requiresNote: true
  })
];

/**
 * Find a transition by (from, to). Returns undefined when the transition
 * isn't defined. The caller checks role separately against `allowedRoles`
 * for a clean 400 (transition not defined) vs 403 (role not allowed)
 * distinction — matches the auth-check order Josh specified for Chunk 3.
 */
export function findTransition(
  from: ClaimStatus,
  to: ClaimStatus
): ClaimTransitionDef | undefined {
  return CLAIM_TRANSITIONS.find((t) => t.from === from && t.to === to);
}
