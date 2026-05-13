"use client";

// Brief 119 — view-mode toggle for the submissions viewer.
//
// Two buttons (Wide / Compact). Click writes the choice to localStorage
// and navigates via `router.push(?view=...)`. On mount, when the URL has
// no `view` param and localStorage carries a saved choice, soft-redirect
// to the saved choice (router.replace, no history entry) so the page
// reflects the operator's last preference on first paint of subsequent
// visits.

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const STORAGE_KEY = "forms.submissions.view";

type View = "wide" | "compact";

function readPersisted(): View | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "wide" || raw === "compact") return raw;
  } catch {
    /* localStorage disabled */
  }
  return null;
}

function writePersisted(view: View): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    /* localStorage disabled */
  }
}

interface Props {
  current: View;
  hasExplicitParam: boolean;
}

export default function ViewToggle({ current, hasExplicitParam }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (hasExplicitParam) {
      writePersisted(current);
      return;
    }
    const persisted = readPersisted();
    if (persisted && persisted !== current) {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.set("view", persisted);
      router.replace(`?${next.toString()}`, { scroll: false });
    }
  }, [hasExplicitParam, current, searchParams, router]);

  function setView(view: View) {
    writePersisted(view);
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.set("view", view);
    router.push(`?${next.toString()}`, { scroll: false });
  }

  const baseCls =
    "inline-flex items-center rounded-splash-sm px-3 py-1.5 text-xs font-bold transition-colors";
  const activeCls = "bg-splash-navy text-white";
  const inactiveCls =
    "border border-gray-light bg-white text-splash-navy hover:bg-sudsy-blue-soft/40";

  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label="View mode">
      <button
        type="button"
        onClick={() => setView("wide")}
        className={`${baseCls} ${current === "wide" ? activeCls : inactiveCls}`}
        aria-pressed={current === "wide"}
      >
        Wide table
      </button>
      <button
        type="button"
        onClick={() => setView("compact")}
        className={`${baseCls} ${current === "compact" ? activeCls : inactiveCls}`}
        aria-pressed={current === "compact"}
      >
        Compact
      </button>
    </div>
  );
}
