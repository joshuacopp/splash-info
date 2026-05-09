"use client";

// Date-range filter (Brief 83). Controlled `<input type="date">` pair plus an
// "Apply" button that pushes the selected `from` / `to` to the page's URL
// search params. Server components re-read those params and re-render the
// data view.
//
// Defaults: when a search param is absent, the matching input shows blank
// (its placeholder shows the implied default — last-30-days for `from`,
// today for `to`). The parent server component is responsible for applying
// those defaults to the data fetch when the URL params are missing.
//
// Reused on /admin/fleet today; Brief 84 will reuse on /admin/signups.

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

interface Props {
  /** Default `from` to render when no search param is set (YYYY-MM-DD UTC). */
  defaultFromYmd: string;
  /** Default `to` to render when no search param is set (YYYY-MM-DD UTC). */
  defaultToYmd: string;
}

export function DateRangePicker({ defaultFromYmd, defaultToYmd }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState<string>(searchParams.get("from") ?? "");
  const [to, setTo] = useState<string>(searchParams.get("to") ?? "");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(searchParams.toString());
    if (from) next.set("from", from);
    else next.delete("from");
    if (to) next.set("to", to);
    else next.delete("to");
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?");
  };

  const reset = () => {
    setFrom("");
    setTo("");
    const next = new URLSearchParams(searchParams.toString());
    next.delete("from");
    next.delete("to");
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?");
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-splash-md border border-gray-light bg-white p-3"
    >
      <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
        From
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder={defaultFromYmd}
          className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
        />
      </label>
      <label className="flex flex-col text-xs font-semibold text-splash-navy/80">
        To
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={defaultToYmd}
          className="mt-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
        />
      </label>
      <button
        type="submit"
        className="inline-flex items-center rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
      >
        Apply
      </button>
      {(from || to) && (
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
        >
          Reset
        </button>
      )}
    </form>
  );
}
