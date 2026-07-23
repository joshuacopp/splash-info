// Brief 178 — "waiting on" label for each claim status, used to populate
// the `waiting_on` column in the claims export. Derived purely from
// claim_status, so it works retroactively on every existing claim with
// no new data entry.
//
// This is the worker-side twin of web's StatusActionPill.tsx. The labels
// are kept word-for-word identical by hand: the worker can't import UI
// copy from the web app, and @splash/types is types-only. If you edit a
// label here, mirror it in StatusActionPill.tsx (and vice-versa) so the
// export column and the on-screen pill never drift.
//
// Closed statuses map to "" (empty) — the claim is done, nothing is
// pending. Orphaned statuses (In House — Repaired, Pending CEO Approval,
// Check Issued) are kept here for the same reason they're kept in the
// pill map: they can't be reached today, but the entry is a ready
// reference if the flow is ever rewired.

import type { ClaimStatus } from "@splash/types/claims";

const WAITING_FOR: Record<ClaimStatus, string> = {
  // Action sits with the GM/RM.
  "New — Pending Review": "GM to review",
  "No Responsibility — Pending Review": "Review no-fault call",
  "Pending GM Review": "GM to review",
  "Pending RM Review": "RM to review",
  "Approved — Pending Quotes": "Needs quotes",
  "Pending RM Quote Approval": "RM to approve quote",
  "Approved — In House — Parts Ordered": "Parts / in-house repair",
  "Approved — In House — Repaired": "GM to close out",
  // In the finance / CEO pipeline.
  "Approved — Check Request Submitted": "Accounting to submit",
  "Approved — Submitted for Payment": "Accounting to issue check",
  "Approved — Pending CEO Approval": "CEO approval",
  "Approved — Check Issued": "Payment to clear",
  // Closed — nothing pending.
  "Closed — Paid": "",
  "Closed — Denied": "",
  "Closed — Approved/No Response": ""
};

/**
 * The "waiting on" label for a claim status. Returns "" for closed
 * statuses and for any status not in the map (defensive — an unmapped
 * status shouldn't silently show stale text).
 */
export function waitingForStatus(status: ClaimStatus): string {
  return WAITING_FOR[status] ?? "";
}
