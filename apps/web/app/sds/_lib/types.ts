// Wire shape of apps/forms-worker/src/sds/handlers.ts.

/** What a chemical IS -- shared by every site holding it. Editing any of this
 *  changes it everywhere, which is the point: one sheet per product, not one
 *  per site. */
export interface SdsCatalog {
  id: string;
  /** MUST match the identity on the safety data sheet and the container label.
   *  That matching IS the OSHA requirement (1910.1200(e)(1)(i)), so nothing in
   *  this app rewrites it to look tidier. */
  product_identifier: string;
  manufacturer: string | null;
  /** Null means no sheet on file anywhere -- a gap worth showing. */
  sds_r2_key: string | null;
  sds_filename: string | null;
  sds_size_bytes: number | null;
  sds_uploaded_at: string | null;
  sds_uploaded_by: string | null;
  /** Provenance only: never served or printed. */
  source_url: string | null;
  /** The date printed on the sheet, not the upload date. */
  sds_revision_date: string | null;
  source_product_id: string | null;
  /** Set when somebody accountable confirmed the name matches a real
   *  sheet and the attached file is that chemical's. CLEARED by any later
   *  edit to identity or sheet -- a stale assurance is worse than none. */
  verified_at: string | null;
  verified_by: string | null;
}

/** A chemical PRESENT AT A SITE. Only the placement lives here. */
export interface SdsItem {
  id: string;
  location_code: string;
  binder_tab: string | null;
  work_area: string | null;
  sort_order: number;
  notes: string | null;
  is_active: boolean;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  catalog_id: string;
  catalog: SdsCatalog | null;
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
  /** catalog_id -> how many sites hold it. Lets the page say what an edit
   *  affects before it is made. */
  catalog_usage?: Record<string, number>;
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
  return (a.catalog?.product_identifier ?? "").localeCompare(
    b.catalog?.product_identifier ?? "",
    undefined,
    {
      sensitivity: "base"
    }
  );
}

/** A catalogue entry as the search returns it. */
export interface SdsCatalogSearchRow extends SdsCatalog {
  /** Sites already holding it. Not authority, but the cheapest signal of
   *  "this is the entry everyone uses" when two look alike. */
  site_count: number;
}

/**
 * A product the chemical inventory knows about, offered as a catalogue
 * candidate.
 *
 * `site_count` is how many sites stock it and is the ONLY sensible ordering
 * here: 469 products exist, ~106 are in use anywhere, and the one at 40 sites
 * earns a safety data sheet long before the one at none.
 */
export interface SdsInventoryProduct {
  product_id: string;
  product_name: string;
  description: string | null;
  site_count: number;
  /** Non-null when this product is already in the catalogue, by provenance or
   *  by name -- so the list can say "already added" instead of quietly
   *  creating a second entry for one chemical. */
  catalog_id: string | null;
  has_sheet: boolean;
}
