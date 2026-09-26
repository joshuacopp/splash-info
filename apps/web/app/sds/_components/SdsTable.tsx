"use client";

// The list itself: one row per chemical, edited in place.
//
// Edited in place rather than behind a modal because the common job is a small
// correction -- a tab number, a manufacturer somebody left blank -- and a modal
// per field turns a five-minute tidy-up into an afternoon.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { compareItems, type SdsItem } from "../_lib/types";
import { setChemicalActiveAction, updateChemicalAction } from "../actions";

function Field({
  name,
  defaultValue,
  placeholder,
  width
}: {
  name: string;
  defaultValue: string;
  placeholder?: string;
  width?: string;
}) {
  return (
    <input
      name={name}
      defaultValue={defaultValue}
      placeholder={placeholder}
      className={`${width ?? "w-full"} rounded-splash-sm border border-gray-light px-2 py-1 text-sm`}
    />
  );
}

function Row({ item, canEdit }: { item: SdsItem; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(formData: FormData) {
    setError(null);
    const str = (k: string) => String(formData.get(k) ?? "").trim();
    startTransition(async () => {
      const res = await updateChemicalAction(item.id, {
        product_identifier: str("product_identifier"),
        manufacturer: str("manufacturer") || null,
        work_area: str("work_area") || null,
        binder_tab: str("binder_tab") || null
      });
      if (res.ok) setEditing(false);
      else setError(res.error);
      router.refresh();
    });
  }

  function setActive(active: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setChemicalActiveAction(item.id, active);
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <tr className="border-t border-gray-light bg-splash-navy/[0.02]">
        <td colSpan={5} className="p-3">
          <form action={save} className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-splash-navy/70">
              Tab
              <Field name="binder_tab" defaultValue={item.binder_tab ?? ""} width="w-16" />
            </label>
            <label className="min-w-[16rem] flex-1 text-xs text-splash-navy/70">
              Product identifier (as shown on the SDS)
              <Field name="product_identifier" defaultValue={item.product_identifier} />
            </label>
            <label className="min-w-[10rem] flex-1 text-xs text-splash-navy/70">
              Manufacturer
              <Field name="manufacturer" defaultValue={item.manufacturer ?? ""} />
            </label>
            <label className="min-w-[10rem] flex-1 text-xs text-splash-navy/70">
              Where used / stored
              <Field name="work_area" defaultValue={item.work_area ?? ""} />
            </label>
            <button
              type="submit"
              disabled={pending}
              className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-splash-navy/60 underline"
            >
              Cancel
            </button>
            {error ? (
              <p role="alert" className="w-full text-xs text-racecar-red">
                {error}
              </p>
            ) : null}
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`border-t border-gray-light ${item.is_active ? "" : "opacity-50"}`}>
      <td className="px-3 py-2 text-sm tabular-nums text-splash-navy/70">
        {item.binder_tab || "—"}
      </td>
      <td className="px-3 py-2 text-sm font-semibold text-splash-navy">
        {item.product_identifier}
        {!item.is_active ? (
          <span className="ml-2 rounded-full bg-gray-light px-2 py-0.5 text-[0.6875rem] font-bold text-splash-navy/60">
            removed
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-sm text-splash-navy/80">{item.manufacturer || "—"}</td>
      <td className="px-3 py-2 text-sm text-splash-navy/80">{item.work_area || "—"}</td>
      <td className="px-3 py-2 text-right text-xs">
        {canEdit ? (
          <div className="flex justify-end gap-3">
            {item.is_active ? (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-splash-blue underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove "${item.product_identifier}" from this site's list?\n\nIt stays in the record with today's date, and won't appear on the printed index.`
                      )
                    ) {
                      setActive(false);
                    }
                  }}
                  className="text-splash-navy/60 underline disabled:opacity-50"
                >
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setActive(true)}
                className="text-splash-blue underline disabled:opacity-50"
              >
                Restore
              </button>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-racecar-red">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

export default function SdsTable({
  items,
  canEdit
}: {
  items: SdsItem[];
  canEdit: boolean;
}) {
  const sorted = [...items].sort(compareItems);
  if (sorted.length === 0) {
    return (
      <p className="rounded-splash-md border border-gray-light bg-white p-6 text-sm text-splash-navy/70">
        No chemicals listed for this site yet. Add them below — every hazardous
        chemical on site needs a safety data sheet in the binder and a line here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light bg-white">
      <table className="w-full min-w-[46rem] border-collapse">
        <thead>
          <tr className="bg-splash-navy/[0.04] text-left">
            <th className="w-16 px-3 py-2 text-xs font-bold uppercase tracking-wider text-splash-navy/60">
              Tab
            </th>
            <th className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-splash-navy/60">
              Product identifier
            </th>
            <th className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-splash-navy/60">
              Manufacturer
            </th>
            <th className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-splash-navy/60">
              Where used / stored
            </th>
            <th className="w-32 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((i) => (
            <Row key={i.id} item={i} canEdit={canEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
