// MaintainX API payload -> `mx_*` row mapping.
//
// This module is pure. It does no I/O, takes no env, and never throws, so the
// ingest driver can map a whole page and then decide what to do about writes.
//
// ---------------------------------------------------------------------------
// THE FIXED KEY SET RULE — read this before adding a field.
// ---------------------------------------------------------------------------
//
// PostgREST bulk-inserts an array of objects as ONE statement. The column list
// comes from the first object, and a row missing a key gets NULL, not the
// column default. MaintainX, meanwhile, OMITS null fields from its responses
// rather than sending them as null. Put those together and a naive mapper
// emits ragged rows whose column list depends on whichever work order happened
// to sort first on the page.
//
// So every mapper below emits the SAME keys every time, with explicit nulls.
// Do not make a key conditional. The one exception is the child-row helpers,
// which are written delete-and-replace and are uniform by construction.
//
// Three groups of columns are deliberately ABSENT from the emitted key set,
// and adding them would be a bug:
//
//   - `first_seen_at` — DB default. On an upsert conflict PostgREST sets every
//     payload column from EXCLUDED, so including it would reset the row's
//     original sighting date on every single sync. For expenditures that date
//     IS the business date the expense-posting flow keys on.
//   - `comment_count` / `attachment_count` — owned by the comment and
//     attachment passes. A work-order sweep that emitted them would zero out
//     whatever those passes had just written.
//   - `deleted_at` — owned by reconciliation. MaintainX never sends it (0 of
//     100 rows measured), so a delete is observable only as disappearance from
//     a walk, and only the reconciler knows the difference between "gone" and
//     "not on this page".
//
// `labor_cost_cents` is also absent: MaintainX exposes labor duration but no
// rate, so cost is computed downstream from the Beekeeper rate. `labor_seconds`
// IS written here, and `total_cost_cents` is therefore parts + expenditures
// only — labour is added when the rate join happens, not before.

import type { RawWorkOrder, RawWorkRequest, RawWorkOrderComment } from "@splash/maintainx";
import type {
  MxLocationMapping,
  MxWorkOrderRow,
  MxWorkOrderCommentRow,
  MxWorkRequestRow,
  MxWorkOrderPartRow,
  MxWorkOrderExpenditureRow,
  MxWorkOrderTimeItemRow
} from "@splash/db-supabase";

/* ============================================================
 * Coercion
 *
 * Everything below treats a wrong-typed value the same as an absent one. A
 * surprise shape from MaintainX should cost us one column, not the row — and
 * `raw` holds the original payload either way, so nothing is unrecoverable.
 * ============================================================ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

/** ISO 8601 normaliser. An unparseable timestamp becomes null rather than
 *  poisoning the column — Postgres would reject it outright. */
function iso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** First non-null candidate. Used where MaintainX's field name is not yet
 *  pinned down — see the money note below. */
function first(source: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = source[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * Money coercion.
 *
 * MaintainX's line-item money shape is NOT yet pinned down: across a full six
 * months there are 25 expenditure lines on 23 work orders and 10 part lines on
 * 9, so no probe run has ever seen enough of them to be sure whether a cost
 * arrives as cents or as a decimal. Both spellings are handled: a key whose
 * name ends in `Cents` is trusted as an integer count of cents; anything else
 * is treated as a decimal amount and multiplied.
 *
 * Verify this against the first real page that carries expenditures. The cost
 * of being wrong is low — these tables are written delete-and-replace, so a
 * corrected mapper fixes history on the next sweep — but it is not zero, so it
 * should not stay unverified once real data exists.
 */
function money(source: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = source[k];
    if (v === undefined || v === null) continue;
    const n = num(v);
    if (n === null) continue;
    return k.endsWith("Cents") ? Math.trunc(n) : Math.round(n * 100);
  }
  return 0;
}

/* ============================================================
 * dedupe_key
 * ============================================================ */

/**
 * FNV-1a over a canonical field string, widened to 64 bits by running two
 * lanes with different offset bases. Synchronous on purpose: `crypto.subtle`
 * is async, and a hash in the middle of a per-row map loop would turn a pure
 * function into an await-per-line.
 *
 * This is a de-duplication key, not a security primitive. Its job is to stay
 * stable when ordinals shift, which is the failure mode that actually bites:
 * MaintainX returns expenditures with no id, and deleting an earlier line
 * renumbers every line after it.
 */
function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function expenditureDedupeKey(parts: {
  type: string | null;
  description: string | null;
  userId: number | null;
  quantity: number;
  costPerUnitCents: number;
  rowTotalCents: number;
  occurrence: number;
}): string {
  return fnv1a64(
    [
      parts.type ?? "",
      parts.description ?? "",
      parts.userId ?? "",
      parts.quantity,
      parts.costPerUnitCents,
      parts.rowTotalCents,
      parts.occurrence
    ].join("")
  );
}

/* ============================================================
 * Work orders
 * ============================================================ */

export interface MappedWorkOrder {
  row: MxWorkOrderRow;
  parts: MxWorkOrderPartRow[];
  expenditures: MxWorkOrderExpenditureRow[];
  timeItems: MxWorkOrderTimeItemRow[];
  /** True when this work order is worth a comment fetch. Gating on this turns
   *  ~20,000 requests into ~1,900: `updatedAt` does not move on comments, so
   *  `lastMessageSentAt` is the only evidence any comment exists at all. */
  hasComments: boolean;
}

export type MxLocationMap = ReadonlyMap<number, MxLocationMapping>;

export function mapWorkOrder(
  raw: RawWorkOrder,
  locations: MxLocationMap,
  syncedAt: string
): MappedWorkOrder | null {
  const id = int(raw.id);
  if (id === null) return null;

  // Treat the payload as a bag as well as a typed object: the schema models
  // several columns (parent/child links, vendor and team ids, extra fields)
  // that `RawWorkOrder` does not declare, and MaintainX ships fields we have
  // not enumerated. Reading defensively costs nothing and `raw` is the net.
  const bag = raw as unknown as Record<string, unknown>;

  const mxLocationId = int(first(bag, ["locationId"]) ?? asRecord(raw.location).id);
  const mapping = mxLocationId === null ? undefined : locations.get(mxLocationId);

  const parts = mapParts(id, asArray(raw.parts), syncedAt);
  const expenditures = mapExpenditures(id, asArray(raw.expenditures), syncedAt);
  const timeItems = mapTimeItems(id, asArray(raw.timeItems), syncedAt);

  const partCostCents = parts.reduce(
    (sum, p) => sum + Math.round((p.quantity_used ?? 0) * (p.unit_cost_cents ?? 0)),
    0
  );
  const expenditureCents = expenditures.reduce((sum, e) => sum + (e.row_total_cents ?? 0), 0);
  const laborSeconds = timeItems.reduce((sum, t) => sum + (t.duration_total_seconds ?? 0), 0);

  const procedure = asRecord(bag.procedure);
  const lastMessageSentAt = iso(raw.lastMessageSentAt);

  const row: MxWorkOrderRow = {
    id,
    sequential_id: int(raw.sequentialId),
    organization_id: int(raw.organizationId),

    title: str(raw.title),
    description: str(raw.description),
    work_order_summary: str(raw.workOrderSummary),

    status: str(raw.status),
    part_status: str(raw.partStatus),
    priority: str(raw.priority),
    type: str(raw.type),

    mx_location_id: mxLocationId,
    location_id: mapping?.locationId ?? null,
    site_number: mapping?.siteNumber ?? null,

    asset_id: int(first(bag, ["assetId"]) ?? asRecord(bag.asset).id),
    parent_id: int(bag.parentId),
    next_id: int(bag.nextId),
    previous_id: int(bag.previousId),
    is_parent: bool(bag.isParent) ?? false,

    creator_id: int(raw.creatorId),
    completer_id: int(raw.completerId),
    requester_id: int(raw.requesterId),
    customer_id: int(bag.customerId),

    assignee_ids: idsFrom(raw.assignees),
    team_ids: idsFrom(first(bag, ["teamIds", "teams"])),
    vendor_ids: idsFrom(first(bag, ["vendorIds", "vendors"])),
    categories: normaliseCategories(raw.categories),

    estimated_time_seconds: int(raw.estimatedTimeSeconds),
    due_date: iso(raw.dueDate),
    due_date_is_full_day: bool(raw.dueDateIsFullDay),
    start_date: iso(raw.startDate),
    completed_at: iso(raw.completedAt),

    mx_created_at: iso(raw.createdAt),
    mx_updated_at: iso(raw.updatedAt),
    last_message_sent_at: lastMessageSentAt,

    procedure_id: int(first(bag, ["procedureId"]) ?? procedure.id),
    procedure_title: str(first(bag, ["procedureTitle"]) ?? procedure.title ?? procedure.name),
    thumbnail_attachment_id: int(asRecord(bag.thumbnail).id),

    progress: bag.progress ?? null,
    extra_fields: bag.extraFields ?? {},
    external_data: bag.externalData ?? {},

    part_cost_cents: partCostCents,
    expenditure_cents: expenditureCents,
    labor_seconds: laborSeconds,
    total_cost_cents: partCostCents + expenditureCents,

    raw,
    synced_at: syncedAt
  };

  return { row, parts, expenditures, timeItems, hasComments: lastMessageSentAt !== null };
}

/** Accepts `[123]`, `[{id: 123}]`, or a single object/number, and returns a
 *  de-duplicated, sorted list so the array column is stable across syncs. */
function idsFrom(value: unknown): number[] {
  const out = new Set<number>();
  const push = (candidate: unknown) => {
    const n = int(typeof candidate === "object" && candidate !== null
      ? (candidate as Record<string, unknown>).id
      : candidate);
    if (n !== null) out.add(n);
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (value !== undefined && value !== null) push(value);
  return Array.from(out).sort((a, b) => a - b);
}

/** Categories arrive as either bare strings or `{name}` objects depending on
 *  whether `expand=categories` was sent. Stored as a jsonb array of strings so
 *  the serving layer does not have to care which. */
function normaliseCategories(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      if (entry !== "") out.push(entry);
      continue;
    }
    const name = str(asRecord(entry).name);
    if (name) out.push(name);
  }
  return out;
}

/* ============================================================
 * Work-order children
 * ============================================================ */

function mapParts(
  workOrderId: number,
  rows: unknown[],
  syncedAt: string
): MxWorkOrderPartRow[] {
  const out: MxWorkOrderPartRow[] = [];
  const seen = new Set<number>();

  rows.forEach((entry, index) => {
    const line = asRecord(entry);
    const partId = int(first(line, ["partId", "id"]) ?? asRecord(line.part).id);
    // The primary key is (work_order_id, part_id). A line with no part id has
    // nowhere to go, and a repeated part id would collide inside a single
    // statement, which PostgREST reports as an opaque conflict.
    if (partId === null || seen.has(partId)) return;
    seen.add(partId);

    const partBag = { ...asRecord(line.part), ...line };

    out.push({
      work_order_id: workOrderId,
      part_id: partId,
      ordinal: index,

      name: str(first(partBag, ["name", "title"])),
      description: str(partBag.description),
      area: str(partBag.area),
      barcode: str(partBag.barcode),
      copy_on_recurring: str(partBag.copyOnRecurring),

      quantity_used: num(first(line, ["quantityUsed", "quantity"])) ?? 0,
      unit_cost_cents: money(partBag, ["unitCostCents", "unitCost", "cost", "price"]),

      available_quantity: num(partBag.availableQuantity),
      minimum_quantity: num(partBag.minimumQuantity),
      part_location_id: int(first(partBag, ["locationId"]) ?? asRecord(partBag.location).id),
      part_extra_fields: partBag.extraFields ?? {},

      synced_at: syncedAt
    });
  });

  return out;
}

function mapExpenditures(
  workOrderId: number,
  rows: unknown[],
  syncedAt: string
): MxWorkOrderExpenditureRow[] {
  const out: MxWorkOrderExpenditureRow[] = [];
  // `occurrence` disambiguates genuinely identical lines — two $40 "misc"
  // entries on one work order are legitimate, and without this they would
  // collide on the (work_order_id, dedupe_key) unique index and one would be
  // silently lost.
  const occurrences = new Map<string, number>();

  rows.forEach((entry, index) => {
    const line = asRecord(entry);

    const type = str(line.type);
    const description = str(line.description);
    const userId = int(first(line, ["userId"]) ?? asRecord(line.user).id);
    const quantity = num(line.quantity) ?? 1;
    const costPerUnitCents = money(line, [
      "costPerUnitCents",
      "costPerUnit",
      "unitCost",
      "cost"
    ]);
    const rowTotalCents = (() => {
      const explicit = money(line, ["rowTotalCents", "rowTotal", "total", "amount"]);
      return explicit !== 0 ? explicit : Math.round(quantity * costPerUnitCents);
    })();

    const base = fnv1a64(
      [type ?? "", description ?? "", userId ?? "", quantity, costPerUnitCents, rowTotalCents].join(
        ""
      )
    );
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);

    out.push({
      work_order_id: workOrderId,
      ordinal: index,
      dedupe_key: expenditureDedupeKey({
        type,
        description,
        userId,
        quantity,
        costPerUnitCents,
        rowTotalCents,
        occurrence
      }),
      occurrence,

      type,
      description,
      user_id: userId,
      quantity,
      cost_per_unit_cents: costPerUnitCents,
      row_total_cents: rowTotalCents,

      synced_at: syncedAt
    });
  });

  return out;
}

/**
 * Maps the `time_items` expand — the per-entry view. Deliberately NOT `times`,
 * which is the same data pre-aggregated per user and is derivable by summing
 * these. Confirmed on WO 118160263: two raw entries of 7,705s and 5,221s
 * against a single aggregated 12,926s.
 */
function mapTimeItems(
  workOrderId: number,
  rows: unknown[],
  syncedAt: string
): MxWorkOrderTimeItemRow[] {
  return rows.map((entry, index) => {
    const line = asRecord(entry);
    const seconds =
      int(first(line, ["durationTotalSeconds", "durationSeconds", "duration", "totalSeconds"])) ?? 0;
    const hours = num(first(line, ["quantityHours", "quantity", "hours"]));

    return {
      work_order_id: workOrderId,
      ordinal: index,
      type: str(line.type),
      user_id: int(first(line, ["userId"]) ?? asRecord(line.user).id),
      // Hours and seconds are both present in practice, but if only one is,
      // derive the other rather than storing a zero that reads as "no labour".
      quantity_hours: hours ?? Math.round((seconds / 3600) * 10000) / 10000,
      duration_total_seconds: seconds || Math.round((hours ?? 0) * 3600),
      synced_at: syncedAt
    };
  });
}

/* ============================================================
 * Comments
 * ============================================================ */

export function mapComment(
  raw: RawWorkOrderComment,
  workOrderId: number,
  syncedAt: string
): MxWorkOrderCommentRow | null {
  const id = int(raw.id);
  if (id === null) return null;
  return {
    id,
    work_order_id: workOrderId,
    author_id: int(raw.authorId),
    // Empty string is a real value here, not a missing one: a photo-only
    // comment carries no text, and the attachment is the payload.
    content: str(raw.content),
    mx_created_at: iso(raw.createdAt),
    synced_at: syncedAt
  };
}

/* ============================================================
 * Work requests
 * ============================================================ */

export function mapWorkRequest(
  raw: RawWorkRequest,
  locations: MxLocationMap,
  syncedAt: string
): MxWorkRequestRow | null {
  const id = int(raw.id);
  if (id === null) return null;

  const bag = raw as unknown as Record<string, unknown>;
  const mxLocationId = int(first(bag, ["locationId"]) ?? asRecord(raw.location).id);
  const mapping = mxLocationId === null ? undefined : locations.get(mxLocationId);

  // `creatorContactInfo` is `{type, value}` and exists on the API, but it is
  // populated by our own splash-inventory form rather than by MaintainX — 5 of
  // 10,243 requests carry it. It is stored because it is free and occasionally
  // authoritative; the reliable path to a requester email stays
  // creator_id -> GET /users.
  const contact = asRecord(bag.creatorContactInfo);
  const contactType = str(contact.type);
  const contactValue = str(contact.value);
  const email =
    contactType === "EMAIL" && contactValue ? contactValue.trim().toLowerCase() || null : null;

  return {
    id,
    work_order_id: int(raw.workOrderId),

    request_status: str(raw.requestStatus),
    title: str(raw.title),
    description: str(raw.description),
    priority: str(raw.priority),

    mx_location_id: mxLocationId,
    location_id: mapping?.locationId ?? null,
    site_number: mapping?.siteNumber ?? null,
    asset_id: int(first(bag, ["assetId"]) ?? asRecord(bag.asset).id),

    creator_id: int(raw.creatorId),
    creator_contact_type: contactType,
    creator_contact_value: contactValue,
    requester_email: email,
    approver_team_id: int(first(bag, ["approverTeamId"]) ?? asRecord(bag.approverTeam).id),

    mx_created_at: iso(raw.createdAt),
    mx_updated_at: iso(raw.updatedAt),

    extra_fields: bag.extraFields ?? {},
    raw,
    synced_at: syncedAt
  };
}
