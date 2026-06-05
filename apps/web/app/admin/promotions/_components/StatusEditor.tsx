// Brief 158b — inline status editor.
//
// Wraps a six-option <select> + Save button via <ActionForm>. Used on
// both the live view (status pipeline card) and the IT ticket page
// header. Worker rejects bad statuses defensively.

"use client";

import { ActionForm } from "../../_components/ActionForm";
import { setPromoStatusAction } from "../_actions/statusActions";
import { PROMO_STATUSES } from "../_lib/types";
import type { PromoStatus } from "../_lib/types";

interface Props {
  promoId: string;
  currentStatus: PromoStatus;
}

export default function StatusEditor({ promoId, currentStatus }: Props) {
  return (
    <ActionForm
      action={setPromoStatusAction}
      resetOnSuccess={false}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="promoId" value={promoId} />
      <label className="text-xs font-semibold uppercase tracking-wide text-splash-navy/55">
        Set status
      </label>
      <select
        name="status"
        defaultValue={currentStatus}
        className="rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm focus:border-splash-blue focus:outline-none"
      >
        {PROMO_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-sm font-bold text-white hover:opacity-95"
      >
        Save
      </button>
    </ActionForm>
  );
}
