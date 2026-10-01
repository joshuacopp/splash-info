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
  /** SDS on file, but the sheet classifies it as not hazardous -- so it is kept
   *  off the printed HazCom list and out of the binder. Optional because
   *  apps/web and the worker deploy separately. */
  not_hazardous?: boolean;
  not_hazardous_at?: string | null;
  not_hazardous_by?: string | null;
  not_hazardous_note?: string | null;
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
  /** What this will be CALLED on the list, when that differs from the inventory
   *  name -- a purchasing code resolves to the chemical's real identity, so
   *  ticking "L-UF222-CS" produces a row reading "UF222 - Ultra Presoak".
   *  Null when the name does not change. OPTIONAL because apps/web and the
   *  worker deploy separately. */
  catalog_name?: string | null;
}

/**
 * Index order: BY TAB NUMBER, then by name.
 *
 * Operator decision 2026-09-28: a Tab column running 32, 37, 33, 34 is wrong on
 * its face to somebody holding the printed page, so the column has to count.
 * The cost is that a chemical added after the binder was numbered prints LAST
 * until a Renumber A-Z -- see sortForBinder in the worker for the full
 * reasoning. Mirrors it exactly; the screen and the printed index must agree.
 *
 * Numeric tabs sort NUMERICALLY ("10" after "9", not after "1"); lettered tabs
 * sort after every numbered one; untabbed rows sort last, being the ones still
 * to be filed.
 */
export function compareItems(a: SdsItem, b: SdsItem): number {
  const at = (a.binder_tab ?? "").trim();
  const bt = (b.binder_tab ?? "").trim();
  if (at !== bt) {
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

/** One purchasing code that resolves to a catalogue entry. */
export interface SdsAlias {
  source_product_id: string;
  inventory_name: string;
  added_by: string;
}

/** A catalogue entry as the search returns it. */
export interface SdsCatalogSearchRow extends SdsCatalog {
  /** Sites already holding it. Not authority, but the cheapest signal of
   *  "this is the entry everyone uses" when two look alike. */
  site_count: number;
  /** Purchasing codes pointing here. OPTIONAL because apps/web and the worker
   *  deploy separately, so for a window the page can see a response from a
   *  worker that predates the field. */
  aliases?: SdsAlias[];
  /** False when a site holds it, so the delete button can be disabled with a
   *  reason rather than failing on click. Optional for the same deploy-skew
   *  reason; treated as not-deletable when absent, which errs safe. */
  deletable?: boolean;
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
  /** Non-null when this product resolves to a catalogue entry, by recorded
   *  alias or by an exact name match -- so the list can say what it resolved
   *  to instead of quietly creating a second entry for one chemical. */
  catalog_id: string | null;
  /** The chemical's name, which for a purchasing code is a DIFFERENT string:
   *  DS-FWW-CS resolves to "Flash Wax White". Showing it is the whole point --
   *  "already added" hides whether the link is the right one. */
  catalog_name: string | null;
  has_sheet: boolean;
  verified: boolean;
  /** "alias" = a person recorded this link. "name" = the strings happened to
   *  match. Worth distinguishing: only the first is somebody's judgement. */
  matched_by: "alias" | "name" | null;
}

/** A company safety programme offered for download.
 *
 *  `r2_key` null means NAMED BUT NOT UPLOADED -- a real state, and the reason
 *  these are rows rather than a bucket listing. A bucket can only show what is
 *  already there; the gap is the half worth seeing. */
export interface SafetyDocument {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  r2_key: string | null;
  file_name: string | null;
  size_bytes: number | null;
  uploaded_at: string | null;
  uploaded_by: string | null;
  form_field_keys: string[];
}
