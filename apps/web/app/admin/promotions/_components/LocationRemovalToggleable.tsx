// Brief 167 — toggleable per-location removal checklist.
//
// Symmetric twin of Brief 158b's `LocationProgressToggleable`. Each row's
// checkbox toggles `is_removed` via the Phase 3 widened endpoint
// (`PATCH /promo/api/promos/{id}/locations/{locationCode}` with body
// `{isRemoved}`). React 19 `useOptimistic` + `useTransition` so the
// checkbox flips immediately; the server action runs in the background
// and reverts on failure.
//
// Per-row indicator:
//   not removed                         → no indicator
//   removed but un-notified             → amber clock ⏱ ("pending notify")
//   removed + notified                  → green envelope ✉ (timestamp tooltip)

"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PromoLocation } from "../_lib/types";
import { toggleLocationRemovalAction } from "../_actions/ticketActions";

interface Props {
  promoId: string;
  locations: PromoLocation[];
}

export default function LocationRemovalToggleable({
  promoId,
  locations
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [optimisticLocations, setOptimisticLocations] = useOptimistic(
    locations,
    (state, update: { locationCode: string; isRemoved: boolean }) =>
      state.map((l) =>
        l.locationCode === update.locationCode
          ? { ...l, isRemoved: update.isRemoved }
          : l
      )
  );

  const total = optimisticLocations.length;
  const done = optimisticLocations.filter((l) => l.isRemoved).length;

  function onToggle(locationCode: string, isRemoved: boolean) {
    setError(null);
    startTransition(async () => {
      setOptimisticLocations({ locationCode, isRemoved });
      const result = await toggleLocationRemovalAction(
        promoId,
        locationCode,
        isRemoved
      );
      if (!result.ok) {
        setError(`${locationCode}: ${result.error}`);
      }
      router.refresh();
    });
  }

  if (total === 0) {
    return (
      <p className="text-sm italic text-splash-navy/60">
        No locations attached to this promo.
      </p>
    );
  }

  // Sort: not-yet-removed first, then alphabetical — mirrors the build-phase
  // grid so operators get the "what's still TODO" view at the top.
  const sorted = [...optimisticLocations].sort((a, b) => {
    if (a.isRemoved !== b.isRemoved) return a.isRemoved ? 1 : -1;
    return a.locationCode.localeCompare(b.locationCode);
  });

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-2 text-sm">
        <span className="font-bold text-splash-navy">
          {done} of {total} removed
        </span>
        <span className="text-splash-navy/60">
          ({Math.round((done / total) * 100)}%)
        </span>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny"
        >
          {error}
        </p>
      )}
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((loc) => (
          <li
            key={loc.locationCode}
            className={`flex items-center gap-2 rounded-splash-sm border px-3 py-1.5 text-sm ${
              loc.isRemoved
                ? "border-orange-200 bg-orange-50/60 text-splash-navy"
                : "border-gray-light bg-white text-splash-navy"
            }`}
          >
            <input
              type="checkbox"
              checked={loc.isRemoved}
              onChange={(e) => onToggle(loc.locationCode, e.target.checked)}
              className="h-4 w-4 cursor-pointer"
              aria-label={`Toggle ${loc.locationCode} removed`}
            />
            <span className="flex-1 truncate font-mono text-[0.8125rem]">
              {loc.locationCode}
            </span>
            {loc.isRemoved && loc.removedAt && (
              <span
                className="text-[0.6875rem] text-orange-700"
                title={loc.removedAt}
              >
                ✓
              </span>
            )}
            <RemovalNotificationIndicator
              isRemoved={loc.isRemoved}
              removalNotifiedAt={loc.removalNotifiedAt}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Per-row notification indicator for the removal phase. Mirrors the build-
 * phase indicator on `LocationProgressToggleable` but reads from the
 * `removalNotifiedAt` column.
 *   - not removed                     → no indicator.
 *   - removed + un-notified           → amber clock (pending notification).
 *   - removed + notified              → green envelope (timestamp tooltip).
 */
function RemovalNotificationIndicator({
  isRemoved,
  removalNotifiedAt
}: {
  isRemoved: boolean;
  removalNotifiedAt: string | null;
}) {
  if (!isRemoved) return null;
  if (removalNotifiedAt === null) {
    return (
      <span
        title="Marked removed; site not yet notified"
        aria-label="Pending removal notification"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-[0.625rem] text-amber-700"
      >
        ⏱
      </span>
    );
  }
  return (
    <span
      title={`Notified of removal ${removalNotifiedAt}`}
      aria-label="Notified of removal"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-[0.625rem] text-emerald-700"
    >
      ✉
    </span>
  );
}
