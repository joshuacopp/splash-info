// Supply Orders -- the Kleen-Rite catalog, read from Kleen-Rite's own site.
//
// THIS IS NOT AN API KLEEN-RITE GAVE US. kleen-ritecorp.com's search box is
// served by Searchspring (site id `mubrxa`); this calls the same public,
// keyless endpoint their pages call from the browser. Their site cannot be
// framed (X-Frame-Options SAMEORIGIN), so this is how a GM "browses
// Kleen-Rite" without leaving our page. If Kleen-Rite changes search vendors
// this stops answering -- the order page then falls back to typing an item #,
// description and quantity by hand, so ordering never stops.
//
// PRICES ARE NOT IN SEARCH RESULTS. Searchspring only exposes price as a
// facet. The product page carries a schema.org Product JSON-LD block with
// offers.price, so prices come from fetching product pages (batched, capped,
// cached). Those are PUBLIC prices -- an estimate shown to the orderer, never
// sent to Kleen-Rite.

const SEARCH_URL = "https://mubrxa.a.searchspring.io/api/search/search.json";
const SITE_ID = "mubrxa";
export const KR_ORIGIN = "https://www.kleen-ritecorp.com";
/** Generic client name -- no user or company details leave this worker. */
const UA = "Mozilla/5.0 (compatible; internal-ordering/1.0)";

const PAGE_SIZE = 24;
const MAX_PRICE_BATCH = 24;
const PRICE_TTL_SECONDS = 6 * 3600;
const SEARCH_TTL_SECONDS = 15 * 60;

/** Top-level departments offered as browse chips (Kleen-Rite's own names). */
export const DEPARTMENTS = [
  "Express Tunnel",
  "Bay Accessories",
  "Detail Supplies",
  "Soaps & Chemicals",
  "Brushes & Brush Accessories",
  "Hose & Fittings",
  "Spray Tips & Nozzles",
  "Valves & Swivels",
  "Pumps",
  "Vacuums",
  "Vending & Retail",
  "Car Wash Signs",
  "Auto Air Fresheners",
  "Automatics",
  "Equipment"
] as const;

export interface CatalogItem {
  sku: string;
  name: string;
  brand: string | null;
  uom: string | null;
  image_url: string | null;
  /** Path on kleen-ritecorp.com, e.g. p-1249-spraying-...-gun.aspx */
  product_path: string;
  min_qty: number;
  call_to_order: boolean;
}

export interface CatalogPage {
  items: CatalogItem[];
  total: number;
  page: number;
  total_pages: number;
  /** Categories present in this result set, biggest first. */
  categories: Array<{ label: string; count: number }>;
}

const PRODUCT_PATH_RE = /^p-\d+-[a-z0-9-]+\.aspx$/i;

export function isProductPath(p: string): boolean {
  return PRODUCT_PATH_RE.test(p);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Searchspring HTML-escapes some text (`&amp;`). Undo the common ones. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function mapResult(r: Record<string, unknown>): CatalogItem | null {
  const sku = str(r.sku);
  const name = decodeEntities(str(r.name));
  let path = str(r.url).replace(/^https?:\/\/[^/]+\//i, "").replace(/^\//, "");
  if (!sku || !name || !isProductPath(path)) return null;
  if (str(r.isactive) === "false" || str(r.isobsolete) === "true") return null;
  const img = str(r.thumbnailImageUrl) || str(r.imageUrl);
  const min = Number.parseInt(str(r.minimumquantity), 10);
  return {
    sku,
    name,
    brand: str(r.brand) ? decodeEntities(str(r.brand)) : null,
    uom: str(r.uom) || null,
    // Space in "product images" -- encode so it is a valid URL in <img>.
    image_url: img ? img.replace(/ /g, "%20") : null,
    product_path: path,
    min_qty: Number.isFinite(min) && min > 0 ? min : 1,
    call_to_order: str(r.call_to_order) === "true"
  };
}

/** The Workers edge cache; undefined outside the Workers runtime (tests). */
function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

async function cachedFetchJson(url: string, ttl: number): Promise<unknown | null> {
  const cache = edgeCache();
  const key = new Request(url, { method: "GET" });
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) return hit.json();
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    console.error(`[supply-orders] catalog search ${res.status}`);
    return null;
  }
  const text = await res.text();
  if (cache) {
    await cache
      .put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }))
      .catch(() => undefined);
  }
  return JSON.parse(text) as unknown;
}

export async function searchCatalog(q: string, category: string, page: number): Promise<CatalogPage | null> {
  const u = new URL(SEARCH_URL);
  u.searchParams.set("siteId", SITE_ID);
  u.searchParams.set("resultsFormat", "native");
  u.searchParams.set("resultsPerPage", String(PAGE_SIZE));
  u.searchParams.set("page", String(Math.max(1, Math.min(page, 200))));
  if (q) u.searchParams.set("q", q.slice(0, 120));
  if (category) u.searchParams.set("filter.ss_category", category.slice(0, 120));

  let data: unknown;
  try {
    data = await cachedFetchJson(u.toString(), SEARCH_TTL_SECONDS);
  } catch (err) {
    console.error("[supply-orders] catalog search failed:", err);
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as {
    results?: unknown[];
    pagination?: { totalResults?: number; currentPage?: number; totalPages?: number };
    facets?: Array<{ field?: string; values?: Array<{ label?: string; value?: string; count?: number }> }>;
  };
  const items = (d.results ?? [])
    .map((r) => (r && typeof r === "object" ? mapResult(r as Record<string, unknown>) : null))
    .filter((x): x is CatalogItem => x !== null);
  const cat = (d.facets ?? []).find((f) => f.field === "ss_category");
  const categories = (cat?.values ?? [])
    .map((v) => ({ label: decodeEntities(str(v.label) || str(v.value)), count: Number(v.count) || 0 }))
    .filter((v) => v.label)
    .slice(0, 30);
  return {
    items,
    total: Number(d.pagination?.totalResults) || 0,
    page: Number(d.pagination?.currentPage) || 1,
    total_pages: Number(d.pagination?.totalPages) || 0,
    categories
  };
}

/**
 * offers.price from the page's schema.org Product JSON-LD, in cents. Null when
 * the page has no Product block or no numeric price ("call to order" items).
 */
export function priceFromProductHtml(html: string): number | null {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!node || typeof node !== "object") continue;
      const n = node as { "@type"?: unknown; offers?: unknown };
      if (n["@type"] !== "Product") continue;
      const offers = Array.isArray(n.offers) ? n.offers[0] : n.offers;
      const raw = offers && typeof offers === "object" ? (offers as { price?: unknown }).price : undefined;
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : NaN;
      if (Number.isFinite(num) && num > 0) return Math.round(num * 100);
    }
  }
  return null;
}

async function priceFor(path: string): Promise<number | null> {
  const url = `${KR_ORIGIN}/${path}`;
  const cache = edgeCache();
  // Cache the extracted price, not the 300 KB page.
  const key = new Request(`https://supply-orders-price.internal/${encodeURIComponent(path)}`);
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) {
    const v = (await hit.json()) as { cents: number | null };
    return v.cents;
  }
  let cents: number | null = null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    cents = priceFromProductHtml(await res.text());
  } catch (err) {
    console.error(`[supply-orders] price fetch failed for ${path}:`, err);
    return null;
  }
  if (cache) {
    await cache
      .put(key, new Response(JSON.stringify({ cents }), { headers: { "Cache-Control": `max-age=${PRICE_TTL_SECONDS}` } }))
      .catch(() => undefined);
  }
  return cents;
}

/** Prices for up to MAX_PRICE_BATCH product paths; missing = unknown. */
export async function pricesFor(paths: string[]): Promise<Record<string, number | null>> {
  const unique = [...new Set(paths.filter(isProductPath))].slice(0, MAX_PRICE_BATCH);
  const out: Record<string, number | null> = {};
  await Promise.all(
    unique.map(async (p) => {
      out[p] = await priceFor(p);
    })
  );
  return out;
}
