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

import type {
  SdsCatalogSearchRow,
  SdsInventoryProduct
} from "../../../sds/_lib/types";
import {
  createCatalogEntryAction,
  deleteCatalogEntryAction,
  linkAliasAction,
  mergeCatalogAction,
  patchCatalogEntryAction,
  unlinkAliasAction,
  verifyCatalogAction
} from "../actions";
import InventoryPicker from "./InventoryPicker";

/**
 * The purchasing codes that resolve to this chemical: what is linked, and a way
 * to link or unlink.
 *
 * Shows `added_by` because a link is somebody's judgement, not a derived fact --
 * "backfill:source_product_id" means it came from the old single-value column
 * and nobody has actually eyeballed it.
 */
function AliasEditor({ row }: { row: SdsCatalogSearchRow }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SdsInventoryProduct[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const aliases = row.aliases ?? [];

  useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/forms/api/sds/inventory-products?include_unused=1&q=${encodeURIComponent(q)}`,
          { credentials: "include", cache: "no-store" }
        );
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { products?: SdsInventoryProduct[] };
        // Only offer codes that resolve nowhere yet. One product means one
        // chemical, so anything already linked has to be unlinked there first --
        // offering it here would just produce a 409 the operator has to decode.
        if (!cancelled) setHits((data.products ?? []).filter((p) => !p.catalog_id));
      } catch {
        // Leave the list be; cancelling out is adjacent.
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, adding]);

  return (
    <div className="mt-3 border-t border-gray-light pt-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
        Inventory / purchasing codes
      </p>
      {aliases.length === 0 ? (
        <p className="mt-1 text-xs text-splash-navy/50">
          Nothing linked. Sites stocking this under a purchasing code will show
          it as a new chemical until one is.
        </p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {aliases.map((a) => (
            <li
              key={a.source_product_id}
              className="flex items-center gap-1.5 rounded-full bg-gray-light px-2 py-0.5 text-[0.6875rem] text-splash-navy/80"
              title={`linked by ${a.added_by}`}
            >
              {a.inventory_name}
              <button
                type="button"
                disabled={pending}
                aria-label={`Unlink ${a.inventory_name}`}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const res = await unlinkAliasAction(row.id, a.source_product_id);
                    if (!res.ok) setError(res.error);
                    router.refresh();
                  });
                }}
                className="font-bold text-splash-navy/50 hover:text-racecar-red disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            placeholder="Search inventory for the code…"
            className="w-full rounded-splash-sm border border-gray-light px-2 py-1 text-sm"
          />
          <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {hits.map((p) => (
              <li
                key={p.product_id}
                className="flex items-center justify-between gap-2 rounded-splash-sm border border-gray-light bg-white px-2 py-1"
              >
                <span className="min-w-0 truncate text-xs text-splash-navy">
                  {p.product_name}
                  <span className="text-splash-navy/50">
                    {p.site_count > 0 ? ` · ${p.site_count} sites` : " · no sites"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const res = await linkAliasAction(row.id, p.product_id);
                      if (res.ok) {
                        setAdding(false);
                        setQ("");
                      } else setError(res.error);
                      router.refresh();
                    });
                  }}
                  className="shrink-0 rounded-splash-sm bg-splash-navy px-2 py-0.5 text-[0.6875rem] font-bold text-white disabled:opacity-50"
                >
                  Link
                </button>
              </li>
            ))}
          </ul>
          {hits.length === 0 ? (
            <p className="mt-1 text-xs text-splash-navy/50">
              No unlinked products match.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="mt-1 text-xs text-splash-navy/60 underline"
          >
            Done
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 text-xs text-splash-blue underline"
        >
          + Link a purchasing code
        </button>
      )}

      {error ? (
        <p role="alert" className="mt-1 text-xs text-racecar-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Fold this entry into the one it duplicates.
 *
 * THIS IS THE ANSWER FOR A DUPLICATE, which delete is not: delete is refused
 * the moment a site lists the entry, and editing only renames one of the pair.
 * Bulk-adding from inventory produces exactly this -- "L-UF222-CS" beside
 * "UF222 - Ultra Presoak", one chemical, two rows.
 *
 * The operator picks the survivor. Which of two names is the one on the safety
 * data sheet is the judgement no rule can make -- "UF421" is a real identity
 * and "L-UF421-CS" is a distributor code, and nothing in the strings says so.
 */
function MergeEntry({ row }: { row: SdsCatalogSearchRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SdsCatalogSearchRow[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/forms/api/sds/catalog?q=${encodeURIComponent(q)}`, {
          credentials: "include",
          cache: "no-store"
        });
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { catalog?: SdsCatalogSearchRow[] };
        // Never offer itself as its own survivor.
        if (!cancelled) setHits((data.catalog ?? []).filter((c) => c.id !== row.id));
      } catch {
        // Leave the list; cancelling out is adjacent.
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, row.id]);

  if (done) {
    return <p className="text-xs text-emerald-700">{done}</p>;
  }

  return (
    <div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-splash-blue underline"
        >
          Merge into another entry&hellip;
        </button>
      ) : (
        <div className="rounded-splash-sm border border-splash-navy/40 bg-splash-navy/[0.03] p-3">
          <p className="text-xs text-splash-navy/70">
            <span className="font-semibold">{row.product_identifier}</span> is
            really which chemical? Its purchasing codes and any site listings
            move there, and this entry is deleted.
          </p>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            placeholder="Search for the entry to keep…"
            className="my-2 w-full rounded-splash-sm border border-gray-light px-2 py-1 text-sm"
          />
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {hits.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-splash-sm border border-gray-light bg-white px-2 py-1"
              >
                <span className="min-w-0 truncate text-xs text-splash-navy">
                  {t.product_identifier}
                  {t.verified_at ? (
                    <span className="ml-1 font-bold text-emerald-700">✓</span>
                  ) : null}
                  <span className="text-splash-navy/50">
                    {t.site_count > 0 ? ` · ${t.site_count} sites` : " · no sites"}
                    {t.sds_r2_key ? "" : " · no sheet"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Merge "${row.product_identifier}" into "${t.product_identifier}"?\n\n` +
                          `"${row.product_identifier}" will be deleted. Its purchasing ` +
                          `codes and any site listings move to "${t.product_identifier}".\n\n` +
                          `This cannot be undone.`
                      )
                    ) {
                      return;
                    }
                    setError(null);
                    startTransition(async () => {
                      const res = await mergeCatalogAction(row.id, t.id);
                      if (!res.ok) {
                        setError(res.error);
                        return;
                      }
                      const s = res.summary;
                      const bits = [
                        `${s.aliases_moved} code${s.aliases_moved === 1 ? "" : "s"}`,
                        `${s.items_moved} listing${s.items_moved === 1 ? "" : "s"}`
                      ];
                      if (s.items_deactivated > 0) {
                        bits.push(
                          `${s.items_deactivated} already there, removed`
                        );
                      }
                      if (s.sheet_carried) bits.push("sheet carried over");
                      setDone(`Merged into ${s.into} — ${bits.join(", ")}.`);
                      router.refresh();
                    });
                  }}
                  className="shrink-0 rounded-splash-sm bg-splash-navy px-2 py-0.5 text-[0.6875rem] font-bold text-white disabled:opacity-50"
                >
                  Keep this
                </button>
              </li>
            ))}
          </ul>
          {hits.length === 0 ? (
            <p className="text-xs text-splash-navy/50">Nothing else matches.</p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-1 text-xs text-racecar-red">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 text-xs text-splash-navy/60 underline"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Delete an entry outright, for one added in error.
 *
 * Disabled with a reason rather than failing on click. The database has the
 * final say either way -- sds_items.catalog_id is RESTRICT -- so this is a
 * courtesy, not the guard.
 */
function DeleteEntry({ row }: { row: SdsCatalogSearchRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // site_count is ACTIVE listings; deletable accounts for removed ones too,
  // because the FK is RESTRICT and a removed row still blocks. So "not
  // deletable with zero active sites" is a real state and gets its own
  // sentence -- the alternative read "0 sites still list this", which is
  // nonsense on its face and sends somebody hunting for a site that isn't
  // there.
  const blocked = row.verified_at
    ? "Withdraw the verified mark first."
    : row.deletable === false
      ? row.site_count > 0
        ? `${row.site_count} site${row.site_count === 1 ? "" : "s"} still list this. Remove it there first, or just edit this entry.`
        : "A site listed this and then removed it, which still pins the entry. Edit it instead."
      : row.deletable === undefined
        ? "Not available until the API catches up with this page."
        : null;

  return (
    <div>
      <button
        type="button"
        disabled={pending || blocked !== null}
        title={blocked ?? "Delete this entry permanently"}
        onClick={() => {
          if (
            !window.confirm(
              `Delete "${row.product_identifier}" from the catalogue?\n\n` +
                `This cannot be undone. Its links to inventory go with it. Any ` +
                `safety data sheet file stays in storage but nothing will point ` +
                `at it.`
            )
          ) {
            return;
          }
          setError(null);
          startTransition(async () => {
            const res = await deleteCatalogEntryAction(row.id);
            if (!res.ok) setError(res.error);
            router.refresh();
          });
        }}
        className="text-xs text-racecar-red underline disabled:text-splash-navy/30 disabled:no-underline"
      >
        {pending ? "Deleting…" : "Delete entry"}
      </button>
      {blocked ? (
        <span className="ml-2 text-xs text-splash-navy/50">{blocked}</span>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-racecar-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}

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

          {/* Links live in the edit panel because a wrong link is a correction
              to the entry, the same kind of thing as a misspelled name -- and
              because until now the only way to make one was the inventory
              picker, which cannot show what is ALREADY linked. */}
          <AliasEditor row={row} />

          {/* Merge above delete: for a duplicate it is almost always the right
              action, and delete is refused outright once a site lists it. */}
          <div className="mt-3 space-y-2 border-t border-gray-light pt-3">
            <MergeEntry row={row} />
            <DeleteEntry row={row} />
          </div>
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
