"use client";

// Client islands for /admin/giveaways.

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { giveawayEntriesReport, type GiveawayEntryRow } from "@splash/report-kit/reports/giveaway-entries";
import { ReportTable } from "../../../_components/report/ReportTable";
import { ActionForm } from "../../_components/ActionForm";
import { deleteEntryAction } from "../actions";

/**
 * The entry-page link, with an optional site number baked in (`?site=122`) so
 * entries from that tablet are stamped with the site. Client-side because the
 * full URL needs this page's origin (staging vs production).
 */
export function GiveawayLink({ path }: { path: string }) {
  const [origin, setOrigin] = useState("");
  const [site, setSite] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const siteOk = /^\d{1,4}$/.test(site);
  const rel = siteOk ? `${path}?site=${site}` : path;
  const url = `${origin}${rel}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy the giveaway link:", url);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="block text-xs font-semibold uppercase tracking-wider text-splash-navy/70">Site number (optional)</span>
          <input
            value={site}
            onChange={(e) => setSite(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="e.g. 122"
            className="w-28 rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
          />
        </label>
        <p className="flex-1 text-xs text-splash-navy/60">
          Put a site number in to make that site&rsquo;s tablet link: its entries then show which site they came from.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-splash-sm border border-gray-light bg-splash-navy/5 px-3 py-2 text-xs text-splash-navy">
          {url}
        </code>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href={rel}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-splash-sm border border-splash-blue px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
          >
            Open
          </a>
        </div>
      </div>
    </div>
  );
}

/** Submit button that asks first. */
export function ConfirmButton({
  label,
  pendingLabel,
  confirmText,
  className
}: {
  label: string;
  pendingLabel: string;
  confirmText: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function EntriesTable({ giveawayId, rows }: { giveawayId: string; rows: GiveawayEntryRow[] }) {
  return (
    <ReportTable
      def={giveawayEntriesReport}
      rows={rows}
      initialSort={{ id: "created_at", desc: true }}
      emptyText="No entries yet."
      cells={{
        site_name: (r) => (r.site_name ? `${r.site_name} (${r.site_number})` : ""),
        sms_consent: (r) =>
          r.sms_consent ? (
            <span className="rounded-full bg-splash-success/15 px-2 py-0.5 text-xs font-bold text-splash-success">Yes</span>
          ) : (
            ""
          )
      }}
      extraColumns={[
        {
          id: "remove",
          header: "",
          cell: (r) => (
            <ActionForm action={deleteEntryAction} resetOnSuccess={false}>
              <input type="hidden" name="id" value={giveawayId} />
              <input type="hidden" name="entry_id" value={r.id} />
              <ConfirmButton
                label="Remove"
                pendingLabel="Removing…"
                confirmText="Remove this entry? This can't be undone."
                className="text-xs font-semibold text-splash-deny hover:underline disabled:opacity-60"
              />
            </ActionForm>
          )
        }
      ]}
    />
  );
}
