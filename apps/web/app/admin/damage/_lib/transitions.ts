// UI-side mirror of the damage-worker's claim-state transition table.
//
// CANONICAL SOURCE: apps/damage-worker/src/transitions.ts (CLAIM_TRANSITIONS).
//   The worker's table is the authoritative state machine — every transition
//   here MUST exist there with identical (from, to, allowedRoles,
//   requiresNote, requiresAmount, requiresQuoteSelection, requiresInputs,
//   optionalInputs) fields. The worker re-validates on POST, so any drift
//   here surfaces as a 400/403 from the worker rather than a security gap,
//   but it still results in dead UI buttons.
//
// PATH-(b) RATIONALE (per Brief 5c §scope.2):
//   apps/web does not depend on @splash/damage-worker, and the worker's
//   transition table is in apps/damage-worker/src/transitions.ts (not in a
//   shared package). Importing across app workspaces would require either
//   a new shared package or a cross-app path alias — both out of scope for
//   5c. We mirror locally and add UI-only fields (label) here.
//
// SYNC CHECKLIST (when adding/changing a transition in the worker):
//   1. Update apps/damage-worker/src/transitions.ts (canonical).
//   2. Update this file's CLAIM_TRANSITIONS_UI to match (from, to,
//      allowedRoles, requires*, *Inputs).
//   3. Pick a button label here.
//   4. Re-run pnpm typecheck — ClaimStatus / DamageRole are typed.
//
// FUTURE CLEANUP: hoist the table into @splash/types or a new
// @splash/damage-shared package so both sides import from one source. Out
// of scope for 5c (would require touching damage-worker, which the brief
// forbids). Tracked informally; no item number yet.
//
// Em-dashes are U+2014 — matches the DB CHECK constraint exactly. Do not
// substitute hyphens.

import type { ClaimStatus, DamageRole } from "@splash/types/claims";

/**
 * UI shape: server-side transition spec + a button label. UI-irrelevant
 * server-only fields (ceoEligible, stamps) are intentionally omitted.
 */
export interface UITransition {
  from: ClaimStatus;
  to: ClaimStatus;
  /** Button text shown to the user. */
  label: string;
  /**
   * Roles allowed to perform this transition. Brief 11a wired the gating:
   * the damage detail page filters buttons by
   * `allowedRoles.includes(session.dcRole)` so users only see actions they
   * can actually take. The worker re-validates on POST as defense-in-depth.
   */
  allowedRoles: readonly DamageRole[];
  requiresNote: boolean;
  requiresAmount: boolean;
  requiresQuoteSelection: boolean;
  /**
   * Worker also gates on this and rejects with 400 if no Receipt photo is
   * on the claim. Not currently surfaced in UI (no button disable / tooltip);
   * the user gets the error message inline via the action_error banner.
   */
  requiresReceiptOnFile: boolean;
  /** Required text-input form field names (worker rejects empty). */
  requiresInputs: readonly string[];
  /** Optional text-input form field names. */
  optionalInputs: readonly string[];
  /**
   * Brief 20 — when true, the worker will NULL approved_amount /
   * approved_quote_id / parts_ordered / vendor_name and reset audit stamps
   * as part of the transition's UPDATE. Mirrored from the worker table to
   * keep the shapes in sync. UI doesn't currently render anything based on
   * this flag, but having it on the UITransition shape makes it visible
   * during reviews and lets the UI surface a "this will reset approval
   * details" hint in a future polish pass.
   */
  clearApprovalDetails: boolean;
}

/** Damage role hierarchy — must match transitions.ts in the worker. */
const DAMAGE_ROLE_HIERARCHY: readonly DamageRole[] = [
  "gm",
  "rm",
  "admin",
  "super_admin"
] as const;

function rolesAtLeast(minimum: DamageRole): readonly DamageRole[] {
  const idx = DAMAGE_ROLE_HIERARCHY.indexOf(minimum);
  return DAMAGE_ROLE_HIERARCHY.slice(idx);
}

/** Builder shorthand mirroring the worker's `tx()`. */
interface UITransitionShorthand {
  from: ClaimStatus;
  to: ClaimStatus;
  label: string;
  role: DamageRole;
  requiresNote?: boolean;
  requiresAmount?: boolean;
  requiresQuoteSelection?: boolean;
  requiresReceiptOnFile?: boolean;
  requiresInputs?: readonly string[];
  optionalInputs?: readonly string[];
  /** Brief 20 — see UITransition.clearApprovalDetails. */
  clearApprovalDetails?: boolean;
}

function tx(t: UITransitionShorthand): UITransition {
  return {
    from: t.from,
    to: t.to,
    label: t.label,
    allowedRoles: rolesAtLeast(t.role),
    requiresNote: !!t.requiresNote,
    requiresAmount: !!t.requiresAmount,
    requiresQuoteSelection: !!t.requiresQuoteSelection,
    requiresReceiptOnFile: !!t.requiresReceiptOnFile,
    requiresInputs: t.requiresInputs ?? [],
    optionalInputs: t.optionalInputs ?? [],
    clearApprovalDetails: !!t.clearApprovalDetails
  };
}

/**
 * UI mirror of CLAIM_TRANSITIONS. Order matches the worker table for
 * diff-friendly review.
 */
export const CLAIM_TRANSITIONS_UI: readonly UITransition[] = [
  // ===== From "New — Pending Review" =====
  tx({
    from: "New — Pending Review",
    to: "Pending GM Review",
    label: "Send to GM Review",
    role: "gm"
  }),
  tx({
    from: "New — Pending Review",
    to: "No Responsibility — Pending Review",
    label: "Mark No Responsibility",
    role: "gm"
  }),
  tx({
    from: "New — Pending Review",
    to: "Closed — Denied",
    label: "Deny",
    role: "gm"
  }),

  // ===== From "No Responsibility — Pending Review" =====
  tx({
    from: "No Responsibility — Pending Review",
    to: "Closed — Denied",
    label: "Deny",
    role: "gm"
  }),
  tx({
    from: "No Responsibility — Pending Review",
    to: "Pending GM Review",
    label: "Reopen for GM Review",
    role: "rm",
    requiresNote: true,
    clearApprovalDetails: true
  }),

  // ===== From "Pending GM Review" =====
  tx({
    from: "Pending GM Review",
    to: "Approved — Pending Quotes",
    label: "Approve — Pending Quotes",
    role: "gm"
  }),
  tx({
    from: "Pending GM Review",
    to: "Approved — In House — Parts Ordered",
    label: "Approve — In House (Parts Ordered)",
    role: "gm",
    optionalInputs: ["parts", "vendor"]
  }),
  tx({
    from: "Pending GM Review",
    to: "Pending RM Review",
    label: "Send to RM Review",
    role: "gm"
  }),
  tx({
    from: "Pending GM Review",
    to: "Closed — Denied",
    label: "Deny",
    role: "gm"
  }),

  // ===== From "Pending RM Review" =====
  tx({
    from: "Pending RM Review",
    to: "Approved — Pending Quotes",
    label: "Approve — Pending Quotes",
    role: "rm"
  }),
  tx({
    from: "Pending RM Review",
    to: "Approved — In House — Parts Ordered",
    label: "Approve — In House (Parts Ordered)",
    role: "rm",
    optionalInputs: ["parts", "vendor"]
  }),
  tx({
    from: "Pending RM Review",
    to: "Closed — Denied",
    label: "Deny",
    role: "rm"
  }),
  tx({
    from: "Pending RM Review",
    to: "Pending GM Review",
    label: "Send back to GM",
    role: "rm",
    requiresNote: true,
    clearApprovalDetails: true
  }),

  // ===== From "Approved — Pending Quotes" =====
  tx({
    from: "Approved — Pending Quotes",
    to: "Pending RM Quote Approval",
    label: "Submit Quotes for RM Approval",
    role: "gm"
  }),
  tx({
    from: "Approved — Pending Quotes",
    to: "Closed — Approved/No Response",
    label: "Close — Approved / No Response",
    role: "gm"
  }),

  // ===== From "Pending RM Quote Approval" =====
  tx({
    from: "Pending RM Quote Approval",
    to: "Approved — Check Request Submitted",
    label: "Approve Quote (submit Check Request)",
    role: "rm",
    requiresQuoteSelection: true
  }),
  tx({
    from: "Pending RM Quote Approval",
    to: "Closed — Denied",
    label: "Deny",
    role: "rm"
  }),

  // ===== From "Approved — In House — Parts Ordered" =====
  tx({
    from: "Approved — In House — Parts Ordered",
    to: "Closed — Paid",
    label: "Mark Paid (receipt on file)",
    role: "gm",
    requiresReceiptOnFile: true
  }),

  // ===== From "Approved — In House — Repaired" =====
  tx({
    from: "Approved — In House — Repaired",
    to: "Closed — Paid",
    label: "Mark Paid",
    role: "gm"
  }),

  // ===== From "Approved — Check Request Submitted" =====
  tx({
    from: "Approved — Check Request Submitted",
    to: "Approved — Submitted for Payment",
    label: "Submit for Payment",
    role: "admin"
  }),

  // ===== From "Approved — Submitted for Payment" =====
  tx({
    from: "Approved — Submitted for Payment",
    to: "Closed — Paid",
    label: "Mark Paid",
    role: "admin"
  }),

  // ===== From "Approved — Pending CEO Approval" (vestigial) =====
  tx({
    from: "Approved — Pending CEO Approval",
    to: "Approved — Check Request Submitted",
    label: "CEO Approve (submit Check Request)",
    role: "admin"
  }),
  tx({
    from: "Approved — Pending CEO Approval",
    to: "Closed — Denied",
    label: "CEO Deny",
    role: "admin"
  }),

  // ===== From "Approved — Check Issued" =====
  tx({
    from: "Approved — Check Issued",
    to: "Closed — Paid",
    label: "Mark Paid",
    role: "rm"
  }),

  // ===== Admin escape hatches =====
  // Brief 20 — clearApprovalDetails parity with worker table.
  tx({
    from: "Approved — Pending Quotes",
    to: "Pending GM Review",
    label: "Send back to GM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Approved — Pending Quotes",
    to: "Pending RM Review",
    label: "Send back to RM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Pending RM Quote Approval",
    to: "Pending GM Review",
    label: "Send back to GM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Pending RM Quote Approval",
    to: "Approved — Pending Quotes",
    label: "Send back to Pending Quotes (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Approved — In House — Parts Ordered",
    to: "Pending GM Review",
    label: "Send back to GM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  // Intra-in-house — approval still valid.
  tx({
    from: "Approved — In House — Repaired",
    to: "Approved — In House — Parts Ordered",
    label: "Revert to Parts Ordered (admin)",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Check Request Submitted",
    to: "Pending RM Quote Approval",
    label: "Revert to RM Quote Approval (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  // One-step backward in payment chain — approval still valid.
  tx({
    from: "Approved — Submitted for Payment",
    to: "Approved — Check Request Submitted",
    label: "Revert to Check Request Submitted (admin)",
    role: "admin",
    requiresNote: true
  }),
  tx({
    from: "Approved — Submitted for Payment",
    to: "Pending RM Quote Approval",
    label: "Revert to RM Quote Approval (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  // One-step backward — approval still valid.
  tx({
    from: "Approved — Check Issued",
    to: "Approved — Check Request Submitted",
    label: "Revert to Check Request Submitted (admin)",
    role: "admin",
    requiresNote: true
  }),

  // ===== Reopen transitions (admin/super_admin only) =====
  // Brief 20 — every reopen is a multi-step revert; clear approval columns.
  tx({
    from: "Closed — Paid",
    to: "Pending GM Review",
    label: "Reopen to GM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Closed — Paid",
    to: "Pending RM Review",
    label: "Reopen to RM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Closed — Denied",
    to: "Pending GM Review",
    label: "Reopen to GM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Closed — Denied",
    to: "Pending RM Review",
    label: "Reopen to RM Review (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  tx({
    from: "Closed — Approved/No Response",
    to: "Pending RM Quote Approval",
    label: "Reopen to RM Quote Approval (admin)",
    role: "admin",
    requiresNote: true,
    clearApprovalDetails: true
  }),
  // Reopen back into the post-approval chain — approval intact.
  tx({
    from: "Closed — Approved/No Response",
    to: "Approved — Check Request Submitted",
    label: "Reopen to Check Request Submitted (admin)",
    role: "admin",
    requiresNote: true
  })
];

/** Filter transitions whose `from` matches the claim's current status. */
export function transitionsFrom(status: ClaimStatus): UITransition[] {
  return CLAIM_TRANSITIONS_UI.filter((t) => t.from === status);
}
