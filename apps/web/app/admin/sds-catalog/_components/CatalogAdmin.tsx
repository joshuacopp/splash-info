"use client";

// Curate the shared chemical catalogue: add, correct, attach a sheet, verify.
//
// Every write here is admin-tier and the worker enforces it; these controls are
// only offered because the page already checked. Editing an entry clears its
// verification even for an admin -- the badge is a claim about a specific name
// and a specific file, and changing either means nobody has checked the new
// pairing yet. Re-verifying is one click, and that click is somebody saying
// they looked.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { SdsCatalogSearchRow } from "../../../sds/_lib/types";
import {
  createCatalogEntryAction,
  patchCatalogEntryAction,
  verifyCatalogAction
} from "../actions";
import InventoryPicker from "./InventoryPicker";

function Row({ row }: { row: SdsCatalogSearchRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function save(fd: FormData) {
    const str = (k: string) => String(fd.get(k) ?? "").trim();
    setError(null);
    startTransition(async () => {
      const res = await patchCatalogEntryAction(row.id, {
        product_identifier: str("product_identifier"),
        manufacturer: str("manufacturer") || null,
        source_url: str("source_url") || null,
        sds_revision_date: str("sds_revision_date") || null
      });
      if (res.ok) setEditing(false);
      else setError(res.error);
      router.refresh();
    });
  }

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const r = await fetch(`/forms/api/sds/catalog/${row.id}/sheet`, {
        method: "POST",
        body,
        credentials: "include"
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        setError(t.includes("not_a_pdf") ? "That isn't a PDF." : `Upload failed (${r.status}).`);
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (editing) {
    return (
      <tr className="border-t border-gray-light bg-splash-navy/[0.02]">
        <td colSpan={5} className="p-3">
          <form action={save} className="flex flex-wrap items-end gap-2">
            <label className="min-w-[16rem] flex-1 text-xs text-splash-navy/70">
              Product identifier (as shown on the SDS)
              <input
                name="product_identifier"
                defaultValue={row.product_identifier}
                required
                className="block w-full rounded-splash-sm border border-gray-light px-2 py-1 text-sm"
              />
            </label>
            <label className="min-w-[10rem] flex-1 text-xs text-splash-navy/70">
              Manufacturer
              <input
                name="manufacturer"
                defaultValue={row.manufacturer ?? ""}
                className="block w-full rounded-splash-sm border border-gray-light px-2 py-1 text-sm"
              />
            </label>
            <label className="min-w-[14rem] flex-1 text-xs text-splash-navy/70">
              Manufacturer SDS page
              <input
                name="source_url"
                defaultValue={row.source_url ?? ""}
                className="block w-full rounded-splash-sm border border-gray-light px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-splash-navy/70">
              Revision date
              <input
                type="date"
                name="sds_revision_date"
                defaultValue={row.sds_revision_date ?? ""}
                className="block rounded-splash-sm border border-gray-light px-2 py-1 text-sm"
              />
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
            {row.verified_at ? (
              <p className="w-full text-xs text-amber-700">
                Saving clears the verified mark — the badge vouches for this
                exact name and file.
              </p>
            ) : null}
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
    <tr className="border-t border-gray-light align-top">
      <td className="px-3 py-2">
        <div className="text-sm font-semibold text-splash-navy">
          {row.product_identifier}
        </div>
        <div className="text-xs text-splash-navy/60">
          {row.manufacturer || "Manufacturer not recorded"}
        </div>
      </td>
      <td className="px-3 py-2 text-xs">
        {row.sds_r2_key ? (
          <span className="font-semibold text-splash-navy/80">On file</span>
        ) : (
          <span className="text-amber-700">Missing</span>
        )}
        {row.sds_revision_date ? (
          <div className="text-[0.6875rem] text-splash-navy/50">
            Revised {row.sds_revision_date}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs">
        {row.verified_at ? (
          <span
            className="rounded-full bg-emerald-100 px-2 py-0.5 text-[0.6875rem] font-bold text-emerald-800"
            title={row.verified_by ? `by ${row.verified_by}` : undefined}
          >
            ✓ Verified
          </span>
        ) : (
          <span className="text-splash-navy/40">Not verified</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-splash-navy/70">
        {row.site_count}
      </td>
      <td className="px-3 py-2 text-right text-xs">
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-splash-blue underline"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={uploading || pending}
            onClick={() => fileRef.current?.click()}
            className="text-splash-navy/60 underline disabled:opacity-50"
          >
            {uploading ? "Uploading…" : row.sds_r2_key ? "Replace sheet" : "Upload sheet"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const res = await verifyCatalogAction(row.id, !row.verified_at);
                if (!res.ok) setError(res.error);
                router.refresh();
              });
            }}
            className="text-splash-navy/60 underline disabled:opacity-50"
          >
            {row.verified_at ? "Withdraw" : "Verify"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-racecar-red">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

export default function CatalogAdmin({
  initialRows,
  initialQuery
}: {
  initialRows: SdsCatalogSearchRow[];
  initialQuery: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [adding, setAdding] = useState(false);
  const [fromInventory, setFromInventory] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Search drives the URL so a result list can be linked and survives a refresh
  // after an edit.
  useEffect(() => {
    if (q === initialQuery) return;
    const t = setTimeout(() => {
      router.replace(q ? `/admin/sds-catalog?q=${encodeURIComponent(q)}` : "/admin/sds-catalog");
    }, 300);
    return () => clearTimeout(t);
  }, [q, initialQuery, router]);

  function add(fd: FormData) {
    const str = (k: string) => String(fd.get(k) ?? "").trim();
    setError(null);
    startTransition(async () => {
      const res = await createCatalogEntryAction({
        product_identifier: str("product_identifier"),
        manufacturer: str("manufacturer") || null
      });
      if (res.ok) {
        setAdding(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by product or manufacturer…"
          className="min-w-[18rem] flex-1 rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
        />
        {/* First, because inventory's names are the ones on the drums -- typing
            from memory is how one chemical becomes two entries. */}
        <button
          type="button"
          onClick={() => {
            setFromInventory((v) => !v);
            setAdding(false);
          }}
          className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5"
        >
          Add from chemical inventory
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setFromInventory(false);
          }}
          className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5"
        >
          + Add a chemical
        </button>
      </div>

      {fromInventory ? <InventoryPicker onDone={() => setFromInventory(false)} /> : null}

      {adding ? (
        <form
          action={add}
          className="mb-3 flex flex-wrap items-end gap-2 rounded-splash-md border border-splash-navy/30 bg-white p-4"
        >
          <label className="min-w-[16rem] flex-1 text-xs text-splash-navy/70">
            Product identifier
            <input
              name="product_identifier"
              required
              autoFocus
              placeholder="Exactly as printed on the SDS and the label"
              className="block w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
            />
          </label>
          <label className="min-w-[10rem] flex-1 text-xs text-splash-navy/70">
            Manufacturer
            <input
              name="manufacturer"
              className="block w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add"}
          </button>
          {error ? (
            <p role="alert" className="w-full text-xs text-racecar-red">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="overflow-x-auto rounded-splash-md border border-gray-light bg-white">
        <table className="w-full min-w-[52rem] border-collapse">
          <thead>
            <tr className="bg-splash-navy/[0.04] text-left">
              {["Chemical", "Sheet", "Verified", "Sites", ""].map((h, i) => (
                <th
                  key={h || i}
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-splash-navy/60"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {initialRows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </tbody>
        </table>
        {initialRows.length === 0 ? (
          <p className="p-6 text-sm text-splash-navy/70">
            Nothing matches. Add it above and every site can then pick it up.
          </p>
        ) : null}
      </div>
    </>
  );
}
