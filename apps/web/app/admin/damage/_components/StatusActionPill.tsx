// Brief 101 / Brief 178 — small visual indicator beside a claim status
// that makes the "what are we waiting on" state obvious at a glance.
//
// Originally only "Approved — Pending Quotes" surfaced a pill ("needs
// quotes"). Brief 178 extends the map to EVERY open status so the claims
// manager and committee can scan the list/detail page and see, per claim,
// who the ball is with. The same waiting-for language also feeds the
// `waiting_on` export column (worker side: status-waiting-for.ts) — the
// two maps are kept word-for-word identical by hand because @splash/types
// isn't a place we can hang UI copy and the worker can't import from web.
// If you edit a label here, mirror it there (and vice-versa).
//
// Two tones:
//   • amber  — action sits with the GM/RM at the wash/region (they can
//              move it right now). These are the "poke someone" states.
//   • sky    — claim is in the finance/CEO pipeline; nobody at the wash
//              can act, we're just waiting on accounting / a check / a
//              clearing payment. Informational, lower-urgency.
// Closed statuses return null (nothing to wait on — the claim is done).
//
// Orphaned statuses (no inbound transition today — In House — Repaired,
// Pending CEO Approval, Check Issued) are intentionally KEPT in the map.
// They can't currently be reached, so the pill will never render for
// them, but leaving the entries here is a ready-made reference if we ever
// wire those states back into the flow.
//
// Mirrors AgePill.tsx: utility-class pill, server-renderable, no shared
// package dependency. Returns null for any status not in the map so
// callers can drop it inline without branching.

import type { ClaimStatus } from "@splash/types/claims";

interface PillConfig {
  label: string;
  classes: string;
  title?: string;
}

const AMBER = "bg-amber-100 text-amber-900 ring-1 ring-amber-300";
const SKY = "bg-sky-100 text-sky-900 ring-1 ring-sky-300";

const STATUS_ACTION_PILLS: Partial<Record<ClaimStatus, PillConfig>> = {
  // --- Action sits with the GM/RM (amber) ---
  "New — Pending Review": {
    label: "GM to review",
    classes: AMBER,
    title: "Awaiting GM's initial review of a newly submitted claim."
  },
  "No Responsibility — Pending Review": {
    label: "Review no-fault call",
    classes: AMBER,
    title: "GM/RM to review the 'no responsibility' determination."
  },
  "Pending GM Review": {
    label: "GM to review",
    classes: AMBER,
    title: "Awaiting GM review before the claim can move forward."
  },
  "Pending RM Review": {
    label: "RM to review",
    classes: AMBER,
    title: "Awaiting Regional Manager review."
  },
  "Approved — Pending Quotes": {
    label: "Needs quotes",
    classes: AMBER,
    title: "GM should upload one or more quotes from approved vendors."
  },
  "Pending RM Quote Approval": {
    label: "RM to approve quote",
    classes: AMBER,
    title: "Quotes are in; awaiting the Regional Manager to approve one."
  },
  "Approved — In House — Parts Ordered": {
    label: "Parts / in-house repair",
    classes: AMBER,
    title: "In-house repair underway — parts ordered."
  },
  "Approved — In House — Repaired": {
    label: "GM to close out",
    classes: AMBER,
    title: "In-house repair done — GM to close out with a receipt."
  },
  // --- In the finance / CEO pipeline (sky, informational) ---
  "Approved — Check Request Submitted": {
    label: "Accounting to submit",
    classes: SKY,
    title: "Check request submitted — awaiting accounting to submit for payment."
  },
  "Approved — Submitted for Payment": {
    label: "Accounting to issue check",
    classes: SKY,
    title: "Submitted for payment — awaiting accounting to issue the check."
  },
  "Approved — Pending CEO Approval": {
    label: "CEO approval",
    classes: SKY,
    title: "Awaiting CEO approval."
  },
  "Approved — Check Issued": {
    label: "Payment to clear",
    classes: SKY,
    title: "Check issued — awaiting the payment to clear so the claim can close."
  }
  // Closed — Paid / Denied / Approved-No Response: no pill (claim is done).
};

export function StatusActionPill({ status }: { status: ClaimStatus }) {
  const config = STATUS_ACTION_PILLS[status];
  if (!config) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${config.classes}`}
      title={config.title}
    >
      {config.label}
    </span>
  );
}
