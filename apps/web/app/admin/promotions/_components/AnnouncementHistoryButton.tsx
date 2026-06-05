"use client";

// Brief 158a — inline announcement history viewer.
//
// Click-to-expand `<details>` listing the latest 20 announcement
// snapshots from `promo.announcements`. Each row shows subject + sent_at
// + recipient count + selected-material count + an inline body
// preview. Read-only at v1 — 158b's "Compose announcement" modal lives
// on a separate button.

import { useState } from "react";
import type { PromoAnnouncement } from "../_lib/types";
import { formatEst } from "../../jotform/_lib/format-est";

interface Props {
  announcements: PromoAnnouncement[];
}

export function AnnouncementHistoryButton({ announcements }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (announcements.length === 0) {
    return (
      <p className="text-sm italic text-splash-navy/60">
        No announcements sent yet.
      </p>
    );
  }

  return (
    <details className="rounded-splash-md border border-gray-light bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-bold text-splash-navy">
        {announcements.length} announcement
        {announcements.length === 1 ? "" : "s"} sent
      </summary>
      <ol className="divide-y divide-gray-light">
        {announcements.map((a) => {
          const ts = formatEst(a.sentAt);
          const isOpen = expanded === a.id;
          return (
            <li key={a.id} className="px-3 py-2.5">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : a.id)}
                className="flex w-full flex-col items-start gap-1 text-left"
              >
                <span className="text-sm font-semibold text-splash-navy">
                  {a.subject || (
                    <span className="italic text-splash-navy/50">
                      (no subject)
                    </span>
                  )}
                </span>
                <span className="text-xs text-splash-navy/60">
                  <span title={a.sentAt}>{ts.absolute || a.sentAt}</span> ·{" "}
                  {a.recipientEmails.length} recipient
                  {a.recipientEmails.length === 1 ? "" : "s"}
                  {a.includedMaterialIds.length > 0 &&
                    ` · ${a.includedMaterialIds.length} material${a.includedMaterialIds.length === 1 ? "" : "s"}`}
                  {a.includedPtp && " · PTP included"}
                </span>
              </button>
              {isOpen && (
                <div className="mt-2 rounded-splash-sm border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-splash-navy/80">
                  <p className="mb-1 font-semibold uppercase tracking-wide text-splash-navy/55">
                    Body
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-sans text-xs">
                    {a.bodyText || (
                      <span className="italic text-splash-navy/50">
                        (empty)
                      </span>
                    )}
                  </pre>
                  <p className="mb-1 mt-2 font-semibold uppercase tracking-wide text-splash-navy/55">
                    Recipients
                  </p>
                  <p className="break-words font-mono text-[0.6875rem]">
                    {a.recipientEmails.join(", ")}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export default AnnouncementHistoryButton;
