"use client";

// The cart. Search Kleen-Rite's catalog (proxied through splash-workorders),
// re-order what the site has bought before, or type an item # by hand when
// the item is not in search or search is down. The cart survives a reload
// (localStorage, per site) so a GM can build an order over a shift.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { createOrderAction } from "../actions";
import {
  money,
  poPreview,
  type CartLine,
  type CatalogItem,
  type CatalogPage,
  type Meta,
  type RecentItem
} from "../_lib/types";

const input = "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm";
const label = "mb-1 block text-sm font-semibold text-splash-navy";
const chip =
  "rounded-full border px-3 py-1 text-xs font-semibold transition-colors";
const CART_KEY = "supply-orders.cart.v1";

type Tab = "search" | "recent" | "manual";

function loadCart(siteId: number): CartLine[] {
  try {
    const raw = window.localStorage.getItem(`${CART_KEY}.${siteId}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

function saveCart(siteId: number, cart: CartLine[]) {
  try {
    if (cart.length) window.localStorage.setItem(`${CART_KEY}.${siteId}`, JSON.stringify(cart));
    else window.localStorage.removeItem(`${CART_KEY}.${siteId}`);
  } catch {
    // Private window / storage blocked: the cart just won't survive a reload.
  }
}

export default function OrderBuilder({ meta }: { meta: Meta }) {
  const [siteId, setSiteId] = useState<number>(meta.sites.length === 1 ? meta.sites[0]!.id : 0);
  const site = meta.sites.find((s) => s.id === siteId) ?? null;
  const [initials, setInitials] = useState(site?.initials ?? "");
  const [initialsTouched, setInitialsTouched] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartLoaded, setCartLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("search");
  const [prices, setPrices] = useState<Record<string, number | null>>({});

  // Site change: suggest that site's initials, and bring back its saved cart.
  useEffect(() => {
    if (!site) return;
    if (!initialsTouched) setInitials(site.initials);
    setCart(loadCart(site.id));
    setCartLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useEffect(() => {
    if (site && cartLoaded) saveCart(site.id, cart);
  }, [cart, site, cartLoaded]);

  const addToCart = useCallback((line: CartLine) => {
    setCart((prev) => {
      const i = prev.findIndex((l) => l.sku.toUpperCase() === line.sku.toUpperCase());
      if (i === -1) return [...prev, line];
      const next = [...prev];
      next[i] = { ...next[i]!, qty: Math.min(9999, next[i]!.qty + line.qty) };
      return next;
    });
  }, []);

  const notePrices = useCallback((p: Record<string, number | null>) => {
    setPrices((prev) => ({ ...prev, ...p }));
  }, []);

  const total = useMemo(() => {
    const priced = cart.filter((l) => l.unit_price_cents != null);
    return priced.length ? priced.reduce((n, l) => n + l.qty * (l.unit_price_cents ?? 0), 0) : null;
  }, [cart]);
  const unpriced = cart.filter((l) => l.unit_price_cents == null).length;

  return (
    <div className="space-y-5">
      {!meta.live && (
        <p className="rounded-splash-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>Test mode.</strong> Approved orders are emailed to the test inbox, not to Kleen-Rite. Nothing is
          actually ordered.
        </p>
      )}

      {/* Site + PO */}
      <div className="grid gap-4 rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-4 shadow-splash-card sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="site">Site</label>
          {meta.sites.length === 1 ? (
            <p className="py-2 text-sm font-semibold text-splash-navy">{site?.label}</p>
          ) : (
            <select
              id="site"
              value={siteId || ""}
              onChange={(e) => setSiteId(Number(e.target.value))}
              className={input}
            >
              <option value="">Pick a site…</option>
              {meta.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={label} htmlFor="initials">Your initials (for the PO)</label>
          <input
            id="initials"
            value={initials}
            maxLength={4}
            onChange={(e) => {
              setInitialsTouched(true);
              setInitials(e.target.value.replace(/[^A-Za-z]/g, ""));
            }}
            className={input}
          />
          <p className="mt-1 text-xs text-splash-navy/60">
            PO will be{" "}
            <span className="font-mono font-semibold text-splash-navy">
              {poPreview(site?.site_number ?? null, meta.today, initials)}
            </span>{" "}
            (2, 3… added if the site already ordered today)
          </p>
        </div>
        <div className="text-sm">
          <p className={label}>Ships to</p>
          {site ? (
            <p className="whitespace-pre-line text-splash-navy/80">
              {meta.vendor?.shipping_method ? `${meta.vendor.shipping_method}\n` : ""}
              {site.ship_to}
            </p>
          ) : (
            <p className="italic text-splash-navy/50">Pick a site</p>
          )}
        </div>
        {site && (
          <p className="text-sm sm:col-span-3">
            {site.needs_approval ? (
              <>
                Goes to <strong>{site.approver_name || site.approver_email}</strong> for approval, then to Kleen-Rite.
              </>
            ) : (
              <>
                You approve orders for this site, so this one <strong>sends to Kleen-Rite as soon as you submit</strong>.
              </>
            )}
          </p>
        )}
      </div>

      {site && (
        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          {/* Catalog */}
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap gap-2" role="tablist">
              {(
                [
                  ["search", "Search Kleen-Rite"],
                  ["recent", "Ordered before"],
                  ["manual", "Add by item #"]
                ] as const
              ).map(([t, text]) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-splash-sm px-3 py-1.5 text-sm font-semibold ${
                    tab === t ? "bg-splash-navy text-white" : "border border-gray-light bg-white text-splash-navy hover:bg-gray-light/40"
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
            {tab === "search" && (
              <CatalogSearch departments={meta.departments} prices={prices} onPrices={notePrices} onAdd={addToCart} />
            )}
            {tab === "recent" && <RecentItems siteId={site.id} onAdd={addToCart} />}
            {tab === "manual" && <ManualAdd onAdd={addToCart} />}
          </div>

          {/* Cart */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <ActionForm
              action={createOrderAction}
              resetOnSuccess={false}
              onResult={(r) => {
                // Placed: the saved cart must not come back on the next order.
                if (r.ok) {
                  saveCart(site.id, []);
                  setCartLoaded(false);
                }
              }}
              className="rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-4 shadow-splash-card">
              <h2 className="mb-3 text-lg font-bold text-splash-navy">
                Order ({cart.length} item{cart.length === 1 ? "" : "s"})
              </h2>
              <input type="hidden" name="location_id" value={site.id} />
              <input type="hidden" name="initials" value={initials} />
              <input
                type="hidden"
                name="lines"
                value={JSON.stringify(
                  cart.map((l) => ({
                    sku: l.sku,
                    name: l.name,
                    uom: l.uom,
                    qty: l.qty,
                    unit_price_cents: l.unit_price_cents,
                    product_path: l.product_path,
                    image_url: l.image_url,
                    source: l.source
                  }))
                )}
              />
              {cart.length === 0 ? (
                <p className="py-6 text-center text-sm italic text-splash-navy/60">
                  Nothing yet. Search Kleen-Rite and press Add.
                </p>
              ) : (
                <ul className="mb-3 divide-y divide-gray-light">
                  {cart.map((l, i) => (
                    <li key={l.sku} className="flex gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs font-semibold text-splash-navy">{l.sku}</p>
                        <p className="text-sm leading-snug text-splash-navy/90">{l.name}</p>
                        <p className="text-xs text-splash-navy/60">
                          {l.unit_price_cents != null ? `${money(l.unit_price_cents)} ea` : "No price"}
                          {l.uom && l.uom.toLowerCase() !== "each" ? ` · ${l.uom}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <input
                          type="number"
                          min={1}
                          max={9999}
                          value={l.qty}
                          aria-label={`Quantity of ${l.sku}`}
                          onChange={(e) => {
                            const q = Math.max(1, Math.min(9999, Number.parseInt(e.target.value, 10) || 1));
                            setCart((prev) => prev.map((x, j) => (j === i ? { ...x, qty: q } : x)));
                          }}
                          className="w-20 rounded-splash-sm border border-gray-light px-2 py-1 text-right text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setCart((prev) => prev.filter((_, j) => j !== i))}
                          className="text-xs font-semibold text-racecar-red hover:underline"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {total != null && (
                <p className="mb-3 text-sm text-splash-navy">
                  Estimated <strong>{money(total)}</strong>
                  <span className="block text-xs text-splash-navy/60">
                    Kleen-Rite&apos;s public prices{unpriced ? `; ${unpriced} item(s) without a price` : ""}. Your account
                    pricing may differ.
                  </span>
                </p>
              )}
              <label className={label} htmlFor="note">
                Note {site.needs_approval ? "for your RM" : ""} (optional)
              </label>
              <textarea id="note" name="note" rows={2} maxLength={1000} className={`${input} mb-3`} />
              <SubmitButton
                pendingText="Placing order…"
                disabled={cart.length === 0 || !initials}
                className="w-full rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:bg-gray-light"
              >
                {site.needs_approval ? "Send to RM for approval" : "Send to Kleen-Rite"}
              </SubmitButton>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm("Empty the cart?")) setCart([]);
                  }}
                  className="mt-2 w-full text-xs font-semibold text-splash-navy/60 hover:underline"
                >
                  Empty cart
                </button>
              )}
            </ActionForm>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ search */

function CatalogSearch({
  departments,
  prices,
  onPrices,
  onAdd
}: {
  departments: string[];
  prices: Record<string, number | null>;
  onPrices: (p: Record<string, number | null>) => void;
  onAdd: (l: CartLine) => void;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CatalogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ q: string; category: string; page: number } | null>(null);
  const reqId = useRef(0);

  const run = useCallback(
    async (next: { q: string; category: string; page: number }) => {
      if (!next.q && !next.category) return;
      const id = ++reqId.current;
      setAsked(next);
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams();
      if (next.q) qs.set("q", next.q);
      if (next.category) qs.set("category", next.category);
      qs.set("page", String(next.page));
      try {
        const res = await fetch(`/admin/supply-orders/api/catalog?${qs.toString()}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (CatalogPage & { error?: string }) | null;
        if (id !== reqId.current) return;
        if (!res.ok || !body) {
          setError(body?.error ?? "Kleen-Rite's search didn't answer. Use \"Add by item #\" instead.");
          setResult(null);
          return;
        }
        setResult(body);
        const missing = body.items.map((i) => i.product_path).filter((p) => !(p in prices));
        if (missing.length) {
          fetch("/admin/supply-orders/api/prices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: missing })
          })
            .then((r) => (r.ok ? (r.json() as Promise<{ prices: Record<string, number | null> }>) : null))
            .then((p) => p && onPrices(p.prices))
            .catch(() => undefined);
        }
      } catch {
        if (id === reqId.current) setError("Kleen-Rite's search didn't answer. Use \"Add by item #\" instead.");
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [prices, onPrices]
  );

  return (
    <div>
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          void run({ q: q.trim(), category, page: 1 });
        }}
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Item # or keywords, e.g. GUSS50 or thumb gun"
          className={input}
          aria-label="Search Kleen-Rite"
        />
        <button type="submit" className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy">
          Search
        </button>
      </form>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {category && (
          <button
            type="button"
            onClick={() => {
              setCategory("");
              setPage(1);
              void run({ q: q.trim(), category: "", page: 1 });
            }}
            className={`${chip} border-splash-navy bg-splash-navy text-white`}
          >
            {category} ✕
          </button>
        )}
        {(result && (asked?.q || asked?.category) ? result.categories.slice(0, 14).map((c) => c.label) : departments)
          .filter((c) => c !== category)
          .map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setCategory(c);
                setPage(1);
                void run({ q: q.trim(), category: c, page: 1 });
              }}
              className={`${chip} border-gray-light bg-white text-splash-navy hover:border-splash-blue`}
            >
              {c}
            </button>
          ))}
      </div>

      {error && <p className="mb-3 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-sm text-racecar-red">{error}</p>}
      {loading && <p className="py-6 text-center text-sm text-splash-navy/60">Searching Kleen-Rite…</p>}
      {!loading && !result && !error && (
        <p className="py-6 text-center text-sm italic text-splash-navy/60">Search by item # or keyword, or pick a department.</p>
      )}

      {!loading && result && (
        <>
          <p className="mb-2 text-xs text-splash-navy/60">
            {result.total.toLocaleString()} result{result.total === 1 ? "" : "s"}
            {result.total_pages > 1 ? ` · page ${result.page} of ${result.total_pages}` : ""}
          </p>
          {result.items.length === 0 ? (
            <p className="py-6 text-center text-sm italic text-splash-navy/60">
              Nothing found. Try fewer words, or add it by item #.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {result.items.map((item) => (
                <ProductCard key={item.sku} item={item} price={prices[item.product_path]} onAdd={onAdd} />
              ))}
            </ul>
          )}
          {result.total_pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => {
                  const p = page - 1;
                  setPage(p);
                  void run({ q: asked?.q ?? "", category: asked?.category ?? "", page: p });
                }}
                className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 font-semibold text-splash-navy disabled:opacity-40"
              >
                ← Previous
              </button>
              <button
                type="button"
                disabled={page >= result.total_pages}
                onClick={() => {
                  const p = page + 1;
                  setPage(p);
                  void run({ q: asked?.q ?? "", category: asked?.category ?? "", page: p });
                }}
                className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 font-semibold text-splash-navy disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProductCard({
  item,
  price,
  onAdd
}: {
  item: CatalogItem;
  price: number | null | undefined;
  onAdd: (l: CartLine) => void;
}) {
  const [qty, setQty] = useState(item.min_qty);
  const [added, setAdded] = useState(false);
  return (
    <li className="flex flex-col rounded-splash-md border border-gray-light bg-white p-3">
      <div className="mb-2 flex h-32 items-center justify-center">
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_url} alt="" loading="lazy" className="max-h-32 max-w-full object-contain" />
        ) : (
          <span className="text-xs text-splash-navy/40">No picture</span>
        )}
      </div>
      <p className="font-mono text-xs font-semibold text-splash-navy">{item.sku}</p>
      <a
        href={`https://www.kleen-ritecorp.com/${item.product_path}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mb-1 text-sm leading-snug text-splash-navy hover:text-splash-blue hover:underline"
      >
        {item.name}
      </a>
      <p className="mb-2 text-xs text-splash-navy/60">
        {price === undefined ? "Price…" : price === null ? (item.call_to_order ? "Call for price" : "No price listed") : money(price)}
        {item.uom ? ` · ${item.uom}` : ""}
      </p>
      <div className="mt-auto flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={9999}
          value={qty}
          aria-label={`Quantity of ${item.sku}`}
          onChange={(e) => setQty(Math.max(1, Math.min(9999, Number.parseInt(e.target.value, 10) || 1)))}
          className="w-16 rounded-splash-sm border border-gray-light px-2 py-1 text-right text-sm"
        />
        <button
          type="button"
          onClick={() => {
            onAdd({
              sku: item.sku,
              name: item.name,
              uom: item.uom,
              qty,
              unit_price_cents: price ?? null,
              product_path: item.product_path,
              image_url: item.image_url,
              source: "catalog"
            });
            setAdded(true);
            window.setTimeout(() => setAdded(false), 1500);
          }}
          className="flex-1 rounded-splash-sm bg-splash-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-splash-navy"
        >
          {added ? "Added ✓" : "Add"}
        </button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ recent */

function RecentItems({ siteId, onAdd }: { siteId: number; onAdd: (l: CartLine) => void }) {
  const [items, setItems] = useState<RecentItem[] | null>(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    fetch(`/admin/supply-orders/api/recent?location_id=${siteId}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ items: RecentItem[] }>) : { items: [] }))
      .then((b) => live && setItems(b.items))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [siteId]);

  if (items === null) return <p className="py-6 text-center text-sm text-splash-navy/60">Loading…</p>;
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm italic text-splash-navy/60">
        This site hasn&apos;t ordered through here yet. Items show up here after its first order is sent.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-gray-light rounded-splash-md border border-gray-light bg-white">
      {items.map((it) => (
        <RecentRow key={it.sku} item={it} onAdd={onAdd} />
      ))}
    </ul>
  );
}

function RecentRow({ item, onAdd }: { item: RecentItem; onAdd: (l: CartLine) => void }) {
  const [qty, setQty] = useState(item.last_qty);
  const [added, setAdded] = useState(false);
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      {item.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.image_url} alt="" loading="lazy" className="h-12 w-12 flex-none object-contain" />
      ) : (
        <span className="h-12 w-12 flex-none" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs font-semibold text-splash-navy">{item.sku}</p>
        <p className="text-sm leading-snug text-splash-navy/90">{item.name}</p>
        <p className="text-xs text-splash-navy/60">
          Ordered {item.times}× · last time {item.last_qty}
          {item.unit_price_cents != null ? ` · ${money(item.unit_price_cents)} ea then` : ""}
        </p>
      </div>
      <input
        type="number"
        min={1}
        max={9999}
        value={qty}
        aria-label={`Quantity of ${item.sku}`}
        onChange={(e) => setQty(Math.max(1, Math.min(9999, Number.parseInt(e.target.value, 10) || 1)))}
        className="w-16 rounded-splash-sm border border-gray-light px-2 py-1 text-right text-sm"
      />
      <button
        type="button"
        onClick={() => {
          onAdd({
            sku: item.sku,
            name: item.name,
            uom: item.uom,
            qty,
            unit_price_cents: item.unit_price_cents,
            product_path: item.product_path,
            image_url: item.image_url,
            source: item.product_path ? "catalog" : "manual"
          });
          setAdded(true);
          window.setTimeout(() => setAdded(false), 1500);
        }}
        className="rounded-splash-sm bg-splash-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-splash-navy"
      >
        {added ? "Added ✓" : "Add"}
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ manual */

function ManualAdd({ onAdd }: { onAdd: (l: CartLine) => void }) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState<string | null>(null);
  const ready = sku.trim().length > 0 && name.trim().length > 0 && qty >= 1;
  return (
    <div className="rounded-splash-md border border-gray-light bg-white p-4">
      <p className="mb-3 text-sm text-splash-navy/70">
        For something search doesn&apos;t find. Copy the item # and description from kleen-ritecorp.com.
      </p>
      <div className="grid gap-3 sm:grid-cols-[160px_1fr_100px]">
        <div>
          <label className={label} htmlFor="m-sku">Item #</label>
          <input id="m-sku" value={sku} maxLength={40} onChange={(e) => setSku(e.target.value)} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="m-name">Description</label>
          <input id="m-name" value={name} maxLength={300} onChange={(e) => setName(e.target.value)} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="m-qty">Qty</label>
          <input
            id="m-qty"
            type="number"
            min={1}
            max={9999}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(9999, Number.parseInt(e.target.value, 10) || 1)))}
            className={input}
          />
        </div>
      </div>
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          onAdd({
            sku: sku.trim().toUpperCase(),
            name: name.trim(),
            uom: null,
            qty,
            unit_price_cents: null,
            product_path: null,
            image_url: null,
            source: "manual"
          });
          setAdded(sku.trim().toUpperCase());
          setSku("");
          setName("");
          setQty(1);
        }}
        className="mt-3 rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:bg-gray-light"
      >
        Add to order
      </button>
      {added && <span className="ml-3 text-sm text-emerald-700">Added {added}.</span>}
    </div>
  );
}
