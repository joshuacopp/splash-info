// Brief 158b — confirm-then-delete button for the materials grid.
//
// Mirrors Brief 128's ConfirmSubmitButton — a tiny "use client" wrapper
// so the parent <ActionForm> can stay a server component.

"use client";

import { useFormStatus } from "react-dom";
import { ActionForm } from "../../_components/ActionForm";
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
  return (
    <ActionForm
      action={deleteMaterialAction}
      resetOnSuccess={false}
      className="inline-block"
    >
      <input type="hidden" name="promoId" value={promoId} />
      <input type="hidden" name="materialId" value={materialId} />
      <DeleteButton materialName={materialName} />
    </ActionForm>
  );
}

// Inline so `useFormStatus` resolves against the parent <ActionForm>'s
// <form> element. SubmitButton can't be used directly because its child
// is a static label — we need the confirm-gate to live on the button's
// own onClick handler.
function DeleteButton({ materialName }: { materialName: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (
          !window.confirm(
            `Delete "${materialName}"? This removes the file too.`
          )
        ) {
          e.preventDefault();
        }
      }}
      className="rounded-splash-sm border border-splash-deny/40 bg-white px-2 py-1 text-xs font-bold text-splash-deny hover:bg-splash-deny/5 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}
