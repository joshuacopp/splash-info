// Wire shape of apps/forms-worker/src/sds/handlers.ts.

export interface SdsItem {
  id: string;
  location_code: string;
  binder_tab: string | null;
  /** MUST match the identity on the safety data sheet and the container label.
   *  That matching IS the OSHA requirement (1910.1200(e)(1)(i)), so nothing in
   *  this app rewrites it to look tidier. */
  product_identifier: string;
  manufacturer: string | null;
  work_area: string | null;
  /** Set when the row was seeded from the chemical inventory, null when typed
   *  by hand. Provenance only -- the row is independent once created. */
  source_product_id: string | null;
  sort_order: number;
  notes: string | null;
  is_active: boolean;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface SdsReview {
  location_code: string;
  last_reviewed_at: string | null;
  last_reviewed_by: string | null;
}

export interface SdsResponse {
  items: SdsItem[];
  reviews: SdsReview[];
  locations: string[];
  /** location_code -> location_pretty, for display. OPTIONAL on purpose:
   *  apps/web and forms-worker deploy independently, so for a window the page
   *  can see a response from a worker that predates this field. Callers fall
   *  back to the code rather than rendering blank labels.
   */
  site_names?: Record<string, string>;
  scope: "all" | "scoped";
  limit_hit: boolean;
}

export interface SdsCandidate {
  product_id: string;
  product_name: string;
  description: string | null;
}

/** Binder order: by tab when tabs are numbered, then by name.
 *
 *  Tabs sort NUMERICALLY when they look like numbers -- "10" belongs after "9",
 *  and a plain string sort puts it after "1". Mixed or lettered tabs fall back
 *  to a text compare rather than coercing to NaN and shuffling. */
export function compareItems(a: SdsItem, b: SdsItem): number {
  const at = (a.binder_tab ?? "").trim();
  const bt = (b.binder_tab ?? "").trim();
  if (at !== bt) {
    // Untabbed entries sort last: they are the ones still to be filed.
    if (!at) return 1;
    if (!bt) return -1;
    const an = Number(at);
    const bn = Number(bt);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    if (Number.isFinite(an) !== Number.isFinite(bn)) return Number.isFinite(an) ? -1 : 1;
    const c = at.localeCompare(bt, undefined, { numeric: true });
    if (c !== 0) return c;
  }
  return a.product_identifier.localeCompare(b.product_identifier, undefined, {
    sensitivity: "base"
  });
}
