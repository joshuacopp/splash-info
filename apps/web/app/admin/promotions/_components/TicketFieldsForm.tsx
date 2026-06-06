// Brief 158b — IT ticket fields editor.
//
// Single-Save form with date input + two textareas. Hidden inputs carry
// the initial values so the server action can diff and only PATCH
// changed fields. Auto-flip from Submitted → Scoped surfaces via the
// ActionForm success banner ("Status auto-advanced to Scoped").

"use client";

import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { patchTicketAction } from "../_actions/ticketActions";

interface Props {
  promoId: string;
  readyByDate: string | null;
  roadblocks: string | null;
  internalNote: string | null | undefined;
}

export default function TicketFieldsForm({
  promoId,
  readyByDate,
  roadblocks,
  internalNote
}: Props) {
  const initialReady = readyByDate ?? "";
  const initialRoad = roadblocks ?? "";
  const initialNote = internalNote ?? "";

  return (
    <ActionForm
      action={patchTicketAction}
      resetOnSuccess={false}
      className="space-y-4"
    >
      <input type="hidden" name="promoId" value={promoId} />
      <input type="hidden" name="initialReadyByDate" value={initialReady} />
      <input type="hidden" name="initialRoadblocks" value={initialRoad} />
      <input type="hidden" name="initialInternalNote" value={initialNote} />

      <div>
        <label className="mb-1 block text-sm font-semibold text-splash-navy">
          Ready by date
        </label>
        <input
          type="date"
          name="readyByDate"
          defaultValue={initialReady}
          className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none sm:max-w-[260px]"
        />
        <p className="mt-1 text-xs text-splash-navy/55">
          Setting a value with an assignee in place advances Submitted → Scoped automatically.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-semibold text-splash-navy">
          Roadblocks
        </label>
        <textarea
          name="roadblocks"
          rows={3}
          maxLength={10000}
          defaultValue={initialRoad}
          className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
          placeholder="(optional) Visible on the live view to non-IT operators."
        />
      </div>

      <div>
        <label className="mb-1 flex items-center gap-2 text-sm font-semibold text-splash-navy">
          Internal note
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.625rem] font-bold text-amber-800">
            IT only
          </span>
        </label>
        <textarea
          name="internalNote"
          rows={3}
          maxLength={10000}
          defaultValue={initialNote}
          className="w-full rounded-splash-sm border border-amber-200 bg-amber-50/40 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none"
          placeholder="(optional) Stripped from the live view for non-IT viewers."
        />
      </div>

      <div className="flex items-center justify-end pt-2">
        <SubmitButton
          pendingText="Saving ticket…"
          className="rounded-splash-sm bg-splash-navy px-4 py-2 text-sm font-bold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-70"
        >
          Save ticket
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
