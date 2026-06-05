// Brief 158b — confirm-then-delete button for the materials grid.
//
// Mirrors Brief 128's ConfirmSubmitButton — a tiny "use client" wrapper
// so the parent <ActionForm> can stay a server component.

"use client";

import { useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import type { ActionResult } from "../../_components/ActionForm";
import { deleteMaterialAction } from "../_actions/materialActions";

interface Props {
  promoId: string;
  materialId: string;
  materialName: string;
}

export default function MaterialDeleteButton({
  promoId,
  materialId,
  materialName
}: Props) {
  const [armed, setArmed] = useState(false);

  function handleResult(result: ActionResult) {
    if (result.ok) setArmed(false);
  }

  return (
    <ActionForm
      action={deleteMaterialAction}
      onResult={handleResult}
      resetOnSuccess={false}
      className="inline-block"
    >
      <input type="hidden" name="promoId" value={promoId} />
      <input type="hidden" name="materialId" value={materialId} />
      <button
        type="submit"
        onClick={(e) => {
          if (
            !window.confirm(
              `Delete "${materialName}"? This removes the file too.`
            )
          ) {
            e.preventDefault();
            return;
          }
          setArmed(true);
        }}
        className="rounded-splash-sm border border-splash-deny/40 bg-white px-2 py-1 text-xs font-bold text-splash-deny hover:bg-splash-deny/5"
      >
        {armed ? "…" : "Delete"}
      </button>
    </ActionForm>
  );
}
