// Brief 158a — horizontal six-step status pipeline.
//
// Visual stepper of the six promo statuses (Submitted → Scoped → Building →
// Tested → Live → Ended). The `current` step is rendered as primary; past
// steps are muted; future steps are ghosted. Read-only at 158a; 158b will
// wire status PATCH via the same six step cells (click-to-advance for
// allowed roles).

import type { PromoStatus } from "../_lib/types";
import { PROMO_STATUSES } from "../_lib/types";

interface Props {
  current: PromoStatus;
}

export function PromoStatusPipeline({ current }: Props) {
  const currentIdx = PROMO_STATUSES.indexOf(current);

  return (
    <ol
      className="flex flex-wrap items-center gap-1 text-xs"
      aria-label="Status pipeline"
    >
      {PROMO_STATUSES.map((status, idx) => {
        const past = idx < currentIdx;
        const here = idx === currentIdx;
        const future = idx > currentIdx;

        const cellClass = here
          ? "bg-splash-blue text-white shadow-splash-btn"
          : past
            ? "bg-splash-navy/15 text-splash-navy/80"
            : "bg-gray-100 text-splash-navy/40";

        return (
          <li key={status} className="flex items-center gap-1">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 font-bold uppercase tracking-wide ${cellClass}`}
              aria-current={here ? "step" : undefined}
            >
              {status}
            </span>
            {idx < PROMO_STATUSES.length - 1 && (
              <span
                aria-hidden="true"
                className={
                  past || here
                    ? "text-splash-navy/40"
                    : "text-splash-navy/15"
                }
              >
                {/* simple chevron — no library dep */}
                ›
              </span>
            )}
            {/* Cleanup the "future" flag warning */}
            {future ? null : null}
          </li>
        );
      })}
    </ol>
  );
}

export default PromoStatusPipeline;
