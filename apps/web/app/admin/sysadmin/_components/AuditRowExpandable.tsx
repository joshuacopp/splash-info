"use client";

// Brief 53. Replaces the prior <details>/<summary> diff toggle inside the
// 30-40px DIFF cell with a stateful pair of <tr>s: the primary row carries
// only the toggle button; expanded rows render as a sibling <tr
// colSpan=5> below, giving the JSON pre block the full table width.
//
// Cell contents are pre-rendered server-side by AuditLogPanel and passed
// in as React nodes — relativeTime, TargetCell, etc. stay on the server
// to avoid a hydration-mismatch on Date.now()-derived strings. Only the
// expansion toggle lives client-side. Per-row local state (useState<boolean>)
// keeps multiple rows independently expandable without a parent-managed
// Set.

import { useState } from "react";

interface AuditRowExpandableProps {
  whenCell: React.ReactNode;
  actorCell: React.ReactNode;
  actionCell: React.ReactNode;
  targetCell: React.ReactNode;
  diffContent: React.ReactNode;
}

export function AuditRowExpandable({
  whenCell,
  actorCell,
  actionCell,
  targetCell,
  diffContent
}: AuditRowExpandableProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <>
      <tr
        className={
          isExpanded
            ? "align-top"
            : "border-b border-gray-light/60 align-top"
        }
      >
        <td className="py-2 pr-3 text-xs text-splash-navy/80">{whenCell}</td>
        <td className="py-2 pr-3 text-xs">{actorCell}</td>
        <td className="py-2 pr-3 text-xs">{actionCell}</td>
        <td className="py-2 pr-3 text-xs">{targetCell}</td>
        <td className="py-2 pr-1">
          <button
            type="button"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((prev) => !prev)}
            className="cursor-pointer text-xs font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            {isExpanded ? "▼ Hide" : "▶ View"}
          </button>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="border-b border-gray-light/60 bg-sudsy-blue-soft/40">
          <td colSpan={5} className="px-3 py-3">
            {diffContent}
          </td>
        </tr>
      ) : null}
    </>
  );
}
