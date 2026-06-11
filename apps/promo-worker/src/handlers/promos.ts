// Brief 154 — promo CRUD handlers (list, create, detail).
//
// Routes (mounted in src/index.ts):
//
//   GET  /promo/api/promos       → handleListPromos     (any non-null promoRole)
//   POST /promo/api/promos       → handleCreatePromo    (super_admin | it | marketing)
//   GET  /promo/api/promos/{id}  → handleGetPromo       (any non-null promoRole)
//
// Auth posture: every handler reads `session.promoRole` via @splash/auth's
// `authenticate()`; `gatePromoRole(session.promoRole, [...])` from
// @splash/db-supabase short-circuits when the caller's role isn't sufficient.
// POST is also gated by `isOriginAllowed` (CSRF defense-in-depth, Brief 17
// convention). GET skips the CSRF gate per the same convention (same-origin
// GETs from apps/web don't carry Origin per spec).
//
// PostgREST direct fetch() with the service-role key is the same pattern as
// `apps/forms-worker/src/db/admin-forms.ts`. We do NOT use the
// @supabase/supabase-js client here — direct fetch is what the rest of the
// monorepo's worker DB code uses and keeps the bundle small.
//
// Atomicity for create: PostgREST doesn't expose multi-table transactions
// directly. The create flow is sequential (promotions → promo_tickets →
// promo_locations → promo_activity_log) with a best-effort rollback (DELETE
// of the promotion row, which CASCADEs the children) on intermediate failure.
// If rollback itself fails, we log loud + return the orphan id so the
// operator can SQL-delete it later.

import { authenticate } from "@splash/auth";
import { gatePromoRole } from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";
import { fireCreateNotify } from "./_notify.js";

// =============================================================================
// Shared helpers
// =============================================================================

const PROMO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROMO_TYPES = ["Same", "BOGO", "Add-ons", "Discount", "Other"] as const;
type PromoType = (typeof PROMO_TYPES)[number];

// `Same` is the only self-explanatory promo type — today's pricing, no kiosk
// behavior change. Every other type (including `Other`) needs operator copy
// explaining what the kiosk / POS should actually do; without it, reviewers
// can't tell what the promo is supposed to be.
// Keep in sync with REQUIRES_POS_BEHAVIOR in
// apps/web/app/admin/promotions/_actions/createActions.ts and
// CreatePromoForm.tsx.
const PROMO_TYPES_REQUIRING_POS_BEHAVIOR = new Set<PromoType>([
  "BOGO",
  "Add-ons",
  "Discount",
  "Other"
]);

const PRIORITIES = ["High", "Medium", "Low"] as const;
type Priority = (typeof PRIORITIES)[number];

// Brief 167 — `Removing` inserted between `Live` and `Ended` (teardown phase).
const STATUSES = [
  "Submitted",
  "Scoped",
  "Building",
  "Tested",
  "Live",
  "Removing",
  "Ended"
] as const;
type Status = (typeof STATUSES)[number];

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TITLE_MAX_LEN = 500;
const LOCATION_CODE_MAX_LEN = 64;

function pgHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function requireServiceKey(env: Env): Response | null {
  if (!env.SUPABASE_SERVICE_KEY) {
    return jsonError(503, "service_key_unbound");
  }
  return null;
}

/**
 * Resolve the calling session + run the promo-role gate. Returns a discriminated
 * union so each handler can `if (!gate.ok) return gate.response;` cleanly.
 */
async function gateCaller(
  env: Env,
  req: Request,
  requiredRoles: PromoRole[]
): Promise<
  | { ok: true; session: { userId: string; email: string; promoRole: PromoRole } }
  | { ok: false; response: Response }
> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const { session } = auth;
  const gate = gatePromoRole(session.promoRole, requiredRoles);
  if (!gate.isAuthorized || !gate.promoRole) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return {
    ok: true,
    session: {
      userId: session.userId,
      email: session.email,
      promoRole: gate.promoRole
    }
  };
}

// =============================================================================
// GET /promo/api/promos — list
// =============================================================================

interface ListPromoRow {
  id: string;
  title: string;
  promo_type: PromoType;
  priority: Priority;
  status: Status;
  proposed_start_date: string;
  proposed_end_date: string;
  requested_go_live_date: string;
  created_at: string;
  updated_at: string;
  ticket: {
    ready_by_date: string | null;
    assignees: Array<{ user_id: string }> | null;
  } | null;
  locations: Array<{ location_code: string; is_complete: boolean }> | null;
}

interface ListPromoItem {
  id: string;
  title: string;
  promoType: PromoType;
  priority: Priority;
  status: Status;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  createdAt: string;
  updatedAt: string;
  readyByDate: string | null;
  locationCount: number;
  locationCodes: string[];
  assigneeCount: number;
  completedLocationCount: number;
}

export async function handleListPromos(req: Request, env: Env): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  const gate = await gateCaller(env, req, []);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const params = url.searchParams;

  // Pagination
  let limit = LIST_LIMIT_DEFAULT;
  let offset = 0;
  const limitRaw = params.get("limit");
  if (limitRaw !== null) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return jsonError(400, "bad_request");
    }
    limit = Math.min(n, LIST_LIMIT_MAX);
  }
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null) {
    const n = Number.parseInt(offsetRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      return jsonError(400, "bad_request");
    }
    offset = n;
  }

  // Filters
  const statusRaw = params.get("status");
  const priorityRaw = params.get("priority");
  const assignedToMeRaw = params.get("assigned_to_me");
  const searchRaw = params.get("search");

  let statusFilter: Status[] | null = null;
  if (statusRaw) {
    const wanted = statusRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of wanted) {
      if (!(STATUSES as readonly string[]).includes(s)) {
        return jsonError(400, "bad_request");
      }
    }
    statusFilter = wanted as Status[];
  }

  let priorityFilter: Priority | null = null;
  if (priorityRaw) {
    if (!(PRIORITIES as readonly string[]).includes(priorityRaw)) {
      return jsonError(400, "bad_request");
    }
    priorityFilter = priorityRaw as Priority;
  }

  // assigned_to_me — pre-resolve the caller's promo_ids from
  // promo_ticket_assignees, then intersect via id=in.(...) on the main query.
  let assignedPromoIds: string[] | null = null;
  if (assignedToMeRaw === "1") {
    const assigneeUrl = new URL(
      "/rest/v1/promo_ticket_assignees",
      env.SUPABASE_URL
    );
    assigneeUrl.searchParams.set("user_id", `eq.${gate.session.userId}`);
    assigneeUrl.searchParams.set("select", "promo_id");
    const assigneeResp = await fetch(assigneeUrl.toString(), {
      headers: pgHeaders(env)
    });
    if (!assigneeResp.ok) {
      console.error(
        "[promo.list] assignee pre-resolve failed",
        assigneeResp.status,
        await assigneeResp.text().catch(() => "")
      );
      return jsonError(500, "list_failed");
    }
    const rows = (await assigneeResp.json().catch(() => [])) as Array<{
      promo_id: string;
    }>;
    assignedPromoIds = rows.map((r) => r.promo_id);
    // Short-circuit empty set — no matching rows, return empty list with the
    // total count = 0.
    if (assignedPromoIds.length === 0) {
      return jsonResponse({
        promos: [],
        total: 0,
        limit,
        offset
      });
    }
  }

  // Main query
  const queryUrl = new URL("/rest/v1/promotions", env.SUPABASE_URL);
  queryUrl.searchParams.set(
    "select",
    [
      "id",
      "title",
      "promo_type",
      "priority",
      "status",
      "proposed_start_date",
      "proposed_end_date",
      "requested_go_live_date",
      "created_at",
      "updated_at",
      // 1:1 with promo_tickets — embed yields a single object (not array).
      "ticket:promo_tickets!inner(ready_by_date,assignees:promo_ticket_assignees(user_id))",
      "locations:promo_locations(location_code,is_complete)"
    ].join(",")
  );
  queryUrl.searchParams.set("order", "created_at.desc");
  queryUrl.searchParams.set("limit", String(limit));
  queryUrl.searchParams.set("offset", String(offset));

  if (statusFilter && statusFilter.length > 0) {
    queryUrl.searchParams.set(
      "status",
      `in.(${statusFilter.map((s) => `"${s}"`).join(",")})`
    );
  }
  if (priorityFilter) {
    queryUrl.searchParams.set("priority", `eq.${priorityFilter}`);
  }
  if (assignedPromoIds) {
    queryUrl.searchParams.set("id", `in.(${assignedPromoIds.join(",")})`);
  }
  if (searchRaw) {
    // PostgREST ilike — escape % and _ so they're treated as literals.
    const escaped = searchRaw.replace(/[%_\\]/g, (m) => `\\${m}`);
    queryUrl.searchParams.set("title", `ilike.*${escaped}*`);
  }

  const listResp = await fetch(queryUrl.toString(), {
    headers: {
      ...pgHeaders(env),
      // `count=estimated` is cheap on large tables and exact-enough for the
      // dashboard's total badge.
      Prefer: "count=estimated"
    }
  });
  if (!listResp.ok) {
    console.error(
      "[promo.list] PostgREST returned",
      listResp.status,
      await listResp.text().catch(() => "")
    );
    return jsonError(500, "list_failed");
  }
  const rows = (await listResp.json().catch(() => [])) as ListPromoRow[];

  // Content-Range: "0-99/12345" or "*/12345" on count=estimated
  const contentRange = listResp.headers.get("Content-Range") ?? "";
  const total = parseContentRangeTotal(contentRange);

  const items: ListPromoItem[] = rows.map((r) => {
    const locations = Array.isArray(r.locations) ? r.locations : [];
    const assignees = Array.isArray(r.ticket?.assignees)
      ? r.ticket?.assignees ?? []
      : [];
    return {
      id: r.id,
      title: r.title,
      promoType: r.promo_type,
      priority: r.priority,
      status: r.status,
      proposedStartDate: r.proposed_start_date,
      proposedEndDate: r.proposed_end_date,
      requestedGoLiveDate: r.requested_go_live_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      readyByDate: r.ticket?.ready_by_date ?? null,
      locationCount: locations.length,
      locationCodes: locations.map((l) => l.location_code),
      assigneeCount: assignees.length,
      completedLocationCount: locations.filter((l) => l.is_complete).length
    };
  });

  return jsonResponse({ promos: items, total, limit, offset });
}

function parseContentRangeTotal(header: string): number {
  // Shapes: "0-99/12345" (count=exact / count=estimated when known),
  // "*/12345" (count=estimated, range unknown), "0-99/*" (count=planned,
  // unknown — fall back to row count). PostgREST puts the total after `/`.
  const slash = header.lastIndexOf("/");
  if (slash === -1) return 0;
  const tail = header.slice(slash + 1);
  if (tail === "*") return 0;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) ? n : 0;
}

// =============================================================================
// POST /promo/api/promos — create
// =============================================================================

interface CreatePromoBody {
  title?: unknown;
  promoType?: unknown;
  posBehavior?: unknown;
  proposedStartDate?: unknown;
  proposedEndDate?: unknown;
  requestedGoLiveDate?: unknown;
  priority?: unknown;
  locationCodes?: unknown;
}

interface CreateValidationError {
  field: string;
  code: string;
}

interface ValidatedCreatePayload {
  title: string;
  promoType: PromoType;
  posBehavior: string | null;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  priority: Priority;
  locationCodes: string[];
}

function validateCreateBody(
  body: CreatePromoBody
): { ok: true; value: ValidatedCreatePayload } | { ok: false; errors: CreateValidationError[] } {
  const errors: CreateValidationError[] = [];

  // title
  let title = "";
  if (typeof body.title === "string") title = body.title.trim();
  if (!title) {
    errors.push({ field: "title", code: "required" });
  } else if (title.length > TITLE_MAX_LEN) {
    errors.push({ field: "title", code: "too_long" });
  }

  // promoType
  let promoType: PromoType | null = null;
  if (
    typeof body.promoType === "string" &&
    (PROMO_TYPES as readonly string[]).includes(body.promoType)
  ) {
    promoType = body.promoType as PromoType;
  } else {
    errors.push({ field: "promoType", code: "invalid" });
  }

  // posBehavior — required when promoType ∈ {BOGO, Add-ons, Discount},
  // optional otherwise. Trim + treat empty as missing.
  let posBehavior: string | null = null;
  if (typeof body.posBehavior === "string") {
    const trimmed = body.posBehavior.trim();
    if (trimmed) posBehavior = trimmed;
  }
  if (promoType && PROMO_TYPES_REQUIRING_POS_BEHAVIOR.has(promoType) && !posBehavior) {
    errors.push({ field: "posBehavior", code: "required" });
  }

  // priority
  let priority: Priority | null = null;
  if (
    typeof body.priority === "string" &&
    (PRIORITIES as readonly string[]).includes(body.priority)
  ) {
    priority = body.priority as Priority;
  } else {
    errors.push({ field: "priority", code: "invalid" });
  }

  // Dates — ISO YYYY-MM-DD shape + valid calendar date
  const proposedStartDate = validateIsoDate(body.proposedStartDate);
  if (!proposedStartDate) errors.push({ field: "proposedStartDate", code: "invalid" });
  const proposedEndDate = validateIsoDate(body.proposedEndDate);
  if (!proposedEndDate) errors.push({ field: "proposedEndDate", code: "invalid" });
  const requestedGoLiveDate = validateIsoDate(body.requestedGoLiveDate);
  if (!requestedGoLiveDate)
    errors.push({ field: "requestedGoLiveDate", code: "invalid" });

  if (proposedStartDate && proposedEndDate && proposedStartDate > proposedEndDate) {
    errors.push({ field: "proposedEndDate", code: "before_start" });
  }
  // requestedGoLiveDate <= proposedStartDate is a soft preference per the
  // brief ("warning, not blocking — the operator may intentionally request
  // go-live after start"). We don't surface an error for it.

  // locationCodes — non-empty array of trimmed strings ≤64 chars, deduped
  let locationCodes: string[] = [];
  if (!Array.isArray(body.locationCodes) || body.locationCodes.length === 0) {
    errors.push({ field: "locationCodes", code: "required" });
  } else {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    let hadInvalid = false;
    for (const raw of body.locationCodes) {
      if (typeof raw !== "string") {
        hadInvalid = true;
        continue;
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.length > LOCATION_CODE_MAX_LEN) {
        hadInvalid = true;
        continue;
      }
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    if (hadInvalid) {
      errors.push({ field: "locationCodes", code: "invalid" });
    } else if (cleaned.length === 0) {
      errors.push({ field: "locationCodes", code: "required" });
    } else {
      locationCodes = cleaned;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Safe: every error path pushed above and was caught.
  return {
    ok: true,
    value: {
      title,
      promoType: promoType as PromoType,
      posBehavior,
      proposedStartDate: proposedStartDate as string,
      proposedEndDate: proposedEndDate as string,
      requestedGoLiveDate: requestedGoLiveDate as string,
      priority: priority as Priority,
      locationCodes
    }
  };
}

function validateIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (!ISO_DATE_RE.test(v)) return null;
  // Validate that JS parses it AND round-trips back to the same string.
  // Date.parse("2026-02-31") returns a number for an invalid civil date
  // (it wraps to March), so we re-stringify and compare.
  const parsed = new Date(v + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getUTCFullYear().toString().padStart(4, "0");
  const mm = (parsed.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = parsed.getUTCDate().toString().padStart(2, "0");
  if (`${yyyy}-${mm}-${dd}` !== v) return null;
  return v;
}

export async function handleCreatePromo(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it", "marketing"]);
  if (!gate.ok) return gate.response;

  let body: CreatePromoBody;
  try {
    body = (await req.json()) as CreatePromoBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  const validation = validateCreateBody(body);
  if (!validation.ok) {
    const fields: Record<string, string> = {};
    for (const e of validation.errors) {
      // Keep first error per field — collapsing makes the response shape
      // predictable for apps/web form handlers.
      if (!(e.field in fields)) fields[e.field] = e.code;
    }
    return new Response(
      JSON.stringify({ error: "bad_request", fields }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  const payload = validation.value;
  const callerId = gate.session.userId;

  let promoId: string | null = null;

  // ---- Step 1: INSERT promotions --------------------------------------------
  try {
    const promosUrl = new URL("/rest/v1/promotions", env.SUPABASE_URL);
    const insertResp = await fetch(promosUrl.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        title: payload.title,
        promo_type: payload.promoType,
        pos_behavior: payload.posBehavior,
        proposed_start_date: payload.proposedStartDate,
        proposed_end_date: payload.proposedEndDate,
        requested_go_live_date: payload.requestedGoLiveDate,
        priority: payload.priority,
        status: "Submitted",
        created_by: callerId
      })
    });
    if (!insertResp.ok) {
      const errText = await insertResp.text().catch(() => "");
      console.error(
        "[promo.create] promotions insert failed",
        insertResp.status,
        errText
      );
      return jsonError(500, "promo_create_failed");
    }
    const inserted = (await insertResp.json().catch(() => [])) as Array<{ id: string }>;
    promoId = inserted[0]?.id ?? null;
    if (!promoId) {
      console.error("[promo.create] promotions insert returned no row");
      return jsonError(500, "promo_create_failed");
    }
  } catch (err) {
    console.error("[promo.create] promotions insert threw", err);
    return jsonError(500, "promo_create_failed");
  }

  // ---- Step 2: INSERT promo_tickets (1:1) ------------------------------------
  // Mistakes here trigger best-effort rollback of the promotions row.
  try {
    const ticketsUrl = new URL("/rest/v1/promo_tickets", env.SUPABASE_URL);
    const ticketResp = await fetch(ticketsUrl.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ promo_id: promoId })
    });
    if (!ticketResp.ok) {
      const errText = await ticketResp.text().catch(() => "");
      console.error(
        "[promo.create] promo_tickets insert failed",
        ticketResp.status,
        errText
      );
      return rollbackAndError(env, promoId);
    }
  } catch (err) {
    console.error("[promo.create] promo_tickets insert threw", err);
    return rollbackAndError(env, promoId);
  }

  // ---- Step 3: bulk INSERT promo_locations -----------------------------------
  try {
    const locationsUrl = new URL("/rest/v1/promo_locations", env.SUPABASE_URL);
    const locationRows = payload.locationCodes.map((code) => ({
      promo_id: promoId,
      location_code: code,
      is_complete: false
    }));
    const locationsResp = await fetch(locationsUrl.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(locationRows)
    });
    if (!locationsResp.ok) {
      const errText = await locationsResp.text().catch(() => "");
      console.error(
        "[promo.create] promo_locations bulk insert failed",
        locationsResp.status,
        errText
      );
      return rollbackAndError(env, promoId);
    }
  } catch (err) {
    console.error("[promo.create] promo_locations insert threw", err);
    return rollbackAndError(env, promoId);
  }

  // ---- Step 4: INSERT promo_activity_log -------------------------------------
  try {
    const activityUrl = new URL("/rest/v1/promo_activity_log", env.SUPABASE_URL);
    const activityResp = await fetch(activityUrl.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        promo_id: promoId,
        actor_user_id: callerId,
        activity_type: "created",
        details: {
          title: payload.title,
          locationCount: payload.locationCodes.length,
          promoType: payload.promoType,
          priority: payload.priority
        }
      })
    });
    if (!activityResp.ok) {
      const errText = await activityResp.text().catch(() => "");
      console.error(
        "[promo.create] promo_activity_log insert failed",
        activityResp.status,
        errText
      );
      return rollbackAndError(env, promoId);
    }
  } catch (err) {
    console.error("[promo.create] promo_activity_log insert threw", err);
    return rollbackAndError(env, promoId);
  }

  // Success — refetch the row in the detail shape so the response mirrors
  // what `GET /promo/api/promos/{id}` would return. Internal note is never
  // stripped because the caller is one of {super_admin, it, marketing} — and
  // a freshly-created promo has no internal_note set anyway.
  const detail = await fetchPromoDetail(env, promoId, gate.session.promoRole);
  if (!detail) {
    // Defensive: row exists per the success path; this is a logic bug if reached.
    console.error("[promo.create] detail refetch returned null for", promoId);
    return jsonError(500, "promo_create_failed");
  }

  // Brief 162 — fire-and-forget IT notification email. Runs inside
  // ctx.waitUntil so a slow Supabase recipient query or queue insert
  // doesn't delay the operator's redirect. All errors caught + logged
  // inside fireCreateNotify itself; the .catch here is the belt-and-
  // suspenders guard for anything that escapes (it shouldn't).
  ctx.waitUntil(
    fireCreateNotify(env, req, {
      promoId,
      title: payload.title,
      promoType: payload.promoType,
      posBehavior: payload.posBehavior,
      priority: payload.priority,
      proposedStartDate: payload.proposedStartDate,
      proposedEndDate: payload.proposedEndDate,
      requestedGoLiveDate: payload.requestedGoLiveDate,
      locationCodes: payload.locationCodes,
      submitterEmail: gate.session.email
    }).catch((err) => {
      console.error("[promo.create] IT notify failed (fail-soft):", err);
    })
  );

  return jsonResponse({ ok: true, promo: detail }, 201);
}

async function rollbackAndError(env: Env, promoId: string): Promise<Response> {
  try {
    const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${promoId}`);
    const resp = await fetch(url.toString(), {
      method: "DELETE",
      headers: { ...pgHeaders(env), Prefer: "return=minimal" }
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.create] partial — ROLLBACK FAILED — manual SQL cleanup required for promo",
        promoId,
        resp.status,
        errText
      );
      return new Response(
        JSON.stringify({
          error: "promo_create_failed",
          message: "Partial state could not be rolled back automatically.",
          orphan_id: promoId
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    console.error("[promo.create] partial — rolled back", promoId);
  } catch (err) {
    console.error(
      "[promo.create] partial — ROLLBACK FAILED — manual SQL cleanup required for promo",
      promoId,
      err
    );
    return new Response(
      JSON.stringify({
        error: "promo_create_failed",
        message: "Partial state could not be rolled back automatically.",
        orphan_id: promoId
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
  return new Response(
    JSON.stringify({
      error: "promo_create_failed",
      message: "Partial state rolled back."
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/json" }
    }
  );
}

// =============================================================================
// GET /promo/api/promos/{id} — detail
// =============================================================================

interface PromoDetailRow {
  id: string;
  title: string;
  promo_type: PromoType;
  pos_behavior: string | null;
  proposed_start_date: string;
  proposed_end_date: string;
  requested_go_live_date: string;
  priority: Priority;
  status: Status;
  created_at: string;
  created_by: string;
  updated_at: string;
  status_updated_at: string | null;
  status_updated_by: string | null;
  ticket: {
    ready_by_date: string | null;
    roadblocks: string | null;
    internal_note: string | null;
    created_at: string;
    updated_at: string;
    ready_by_updated_at: string | null;
    ready_by_updated_by: string | null;
    assignees: Array<{
      user_id: string;
      assigned_at: string;
      assigned_by: string | null;
    }> | null;
  } | null;
  locations: Array<{
    location_code: string;
    is_complete: boolean;
    completed_at: string | null;
    completed_by: string | null;
    notified_at: string | null;
    notified_by: string | null;
    // Brief 167 — removal phase mirror columns.
    is_removed: boolean;
    removed_at: string | null;
    removed_by: string | null;
    removal_notified_at: string | null;
    removal_notified_by: string | null;
  }> | null;
  materials: Array<{
    id: string;
    name: string;
    kind: string;
    r2_key: string;
    file_mime: string | null;
    file_size_bytes: number | null;
    uploaded_at: string;
    uploaded_by: string;
  }> | null;
  ptp: {
    purpose: string;
    tools: string;
    process: string;
    updated_at: string;
    updated_by: string | null;
  } | Array<{
    purpose: string;
    tools: string;
    process: string;
    updated_at: string;
    updated_by: string | null;
  }> | null;
  activity: Array<{
    id: string;
    actor_user_id: string | null;
    activity_type: string;
    details: unknown;
    created_at: string;
  }> | null;
  announcements: Array<{
    id: string;
    sent_at: string;
    sent_by: string;
    subject: string;
    body_text: string;
    recipient_emails: string[] | null;
    included_material_ids: string[] | null;
    included_ptp: boolean;
  }> | null;
}

interface PromoDetailResponse {
  id: string;
  title: string;
  promoType: PromoType;
  posBehavior: string | null;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  priority: Priority;
  status: Status;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  statusUpdatedAt: string | null;
  statusUpdatedBy: string | null;
  ticket: {
    readyByDate: string | null;
    roadblocks: string | null;
    internalNote?: string | null;
    createdAt: string;
    updatedAt: string;
    readyByUpdatedAt: string | null;
    readyByUpdatedBy: string | null;
    assignees: Array<{
      userId: string;
      assignedAt: string;
      assignedBy: string | null;
    }>;
  } | null;
  locations: Array<{
    locationCode: string;
    isComplete: boolean;
    completedAt: string | null;
    completedBy: string | null;
    notifiedAt: string | null;
    notifiedBy: string | null;
    // Brief 167 — removal phase mirror.
    isRemoved: boolean;
    removedAt: string | null;
    removedBy: string | null;
    removalNotifiedAt: string | null;
    removalNotifiedBy: string | null;
  }>;
  materials: Array<{
    id: string;
    name: string;
    kind: string;
    r2Key: string;
    fileMime: string | null;
    fileSizeBytes: number | null;
    uploadedAt: string;
    uploadedBy: string;
  }>;
  ptp: {
    purpose: string;
    tools: string;
    process: string;
    updatedAt: string;
    updatedBy: string | null;
  } | null;
  activity: Array<{
    id: string;
    actorUserId: string | null;
    activityType: string;
    details: unknown;
    createdAt: string;
  }>;
  announcements: Array<{
    id: string;
    sentAt: string;
    sentBy: string;
    subject: string;
    bodyText: string;
    recipientEmails: string[];
    includedMaterialIds: string[];
    includedPtp: boolean;
  }>;
}

/**
 * Fetch a promo detail and map to the camelCase response shape. Returns
 * null when the row doesn't exist. The `internal_note` field is stripped
 * for non-IT callers at the seam (defense in depth — apps/web side will
 * also gate the UI).
 */
async function fetchPromoDetail(
  env: Env,
  promoId: string,
  callerRole: PromoRole
): Promise<PromoDetailResponse | null> {
  const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${promoId}`);
  url.searchParams.set(
    "select",
    [
      "*",
      // 1:1 with promo_tickets — use !left so a missing ticket (shouldn't
      // happen post-create but worth being defensive on) doesn't 404 the
      // promo itself.
      "ticket:promo_tickets!left(ready_by_date,roadblocks,internal_note,created_at,updated_at,ready_by_updated_at,ready_by_updated_by,assignees:promo_ticket_assignees(user_id,assigned_at,assigned_by))",
      // Brief 167 — embed widened with the removal-phase mirror columns.
      "locations:promo_locations(location_code,is_complete,completed_at,completed_by,notified_at,notified_by,is_removed,removed_at,removed_by,removal_notified_at,removal_notified_by)",
      "materials:promo_materials(id,name,kind,r2_key,file_mime,file_size_bytes,uploaded_at,uploaded_by)",
      "ptp:promo_ptp(purpose,tools,process,updated_at,updated_by)",
      // Activity is bounded to the latest 20 entries; details column is
      // free-form JSONB, passed through to the response verbatim.
      "activity:promo_activity_log(id,actor_user_id,activity_type,details,created_at)",
      // Brief 157 — announcements snapshot, most-recent-first, capped at
      // 20 to keep response payload light. `body_html` intentionally
      // omitted (always null at v1 and would inflate the payload).
      "announcements:promo_announcements(id,sent_at,sent_by,subject,body_text,recipient_emails,included_material_ids,included_ptp)"
    ].join(",")
  );
  url.searchParams.set("activity.order", "created_at.desc");
  url.searchParams.set("activity.limit", "20");
  url.searchParams.set("announcements.order", "sent_at.desc");
  url.searchParams.set("announcements.limit", "20");
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`detail fetch ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as PromoDetailRow[];
  const row = rows[0];
  if (!row) return null;

  const exposeInternalNote = callerRole === "super_admin" || callerRole === "it";

  // promo_tickets is a single row per promo_id (PK); PostgREST returns
  // a single object on a !left to-one embed. But !inner to-one returns
  // an object too; the variance is in older PostgREST versions and on
  // some embed shapes. Tolerate either.
  type TicketShape = NonNullable<PromoDetailRow["ticket"]>;
  const rawTicket: TicketShape | null =
    Array.isArray(row.ticket)
      ? (row.ticket as TicketShape[])[0] ?? null
      : (row.ticket as TicketShape | null);

  const ticket = rawTicket
    ? {
        readyByDate: rawTicket.ready_by_date,
        roadblocks: rawTicket.roadblocks,
        ...(exposeInternalNote ? { internalNote: rawTicket.internal_note } : {}),
        createdAt: rawTicket.created_at,
        updatedAt: rawTicket.updated_at,
        readyByUpdatedAt: rawTicket.ready_by_updated_at,
        readyByUpdatedBy: rawTicket.ready_by_updated_by,
        assignees: (rawTicket.assignees ?? []).map((a) => ({
          userId: a.user_id,
          assignedAt: a.assigned_at,
          assignedBy: a.assigned_by
        }))
      }
    : null;

  // ptp is 1:1 (PK on promo_id) → PostgREST returns either {...} or [{...}]
  // depending on version. Tolerate both shapes. Null = no ptp row yet.
  type PtpShape = {
    purpose: string;
    tools: string;
    process: string;
    updated_at: string;
    updated_by: string | null;
  };
  let ptpRow: PtpShape | null = null;
  if (row.ptp) {
    if (Array.isArray(row.ptp)) {
      ptpRow = row.ptp[0] ?? null;
    } else {
      ptpRow = row.ptp as PtpShape;
    }
  }
  const ptp = ptpRow
    ? {
        purpose: ptpRow.purpose,
        tools: ptpRow.tools,
        process: ptpRow.process,
        updatedAt: ptpRow.updated_at,
        updatedBy: ptpRow.updated_by
      }
    : null;

  return {
    id: row.id,
    title: row.title,
    promoType: row.promo_type,
    posBehavior: row.pos_behavior,
    proposedStartDate: row.proposed_start_date,
    proposedEndDate: row.proposed_end_date,
    requestedGoLiveDate: row.requested_go_live_date,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    statusUpdatedAt: row.status_updated_at,
    statusUpdatedBy: row.status_updated_by,
    ticket,
    locations: (row.locations ?? []).map((l) => ({
      locationCode: l.location_code,
      isComplete: l.is_complete,
      completedAt: l.completed_at,
      completedBy: l.completed_by,
      notifiedAt: l.notified_at,
      notifiedBy: l.notified_by,
      // Brief 167 — removal phase mirror.
      isRemoved: l.is_removed,
      removedAt: l.removed_at,
      removedBy: l.removed_by,
      removalNotifiedAt: l.removal_notified_at,
      removalNotifiedBy: l.removal_notified_by
    })),
    materials: (row.materials ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      r2Key: m.r2_key,
      fileMime: m.file_mime,
      fileSizeBytes: m.file_size_bytes,
      uploadedAt: m.uploaded_at,
      uploadedBy: m.uploaded_by
    })),
    ptp,
    activity: (row.activity ?? []).map((a) => ({
      id: a.id,
      actorUserId: a.actor_user_id,
      activityType: a.activity_type,
      details: a.details,
      createdAt: a.created_at
    })),
    announcements: (row.announcements ?? []).map((a) => ({
      id: a.id,
      sentAt: a.sent_at,
      sentBy: a.sent_by,
      subject: a.subject,
      bodyText: a.body_text,
      recipientEmails: a.recipient_emails ?? [],
      includedMaterialIds: a.included_material_ids ?? [],
      includedPtp: a.included_ptp
    }))
  };
}

export async function handleGetPromo(
  req: Request,
  env: Env,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  const gate = await gateCaller(env, req, []);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) {
    return jsonError(404, "promo_not_found");
  }

  let detail: PromoDetailResponse | null;
  try {
    detail = await fetchPromoDetail(env, promoId, gate.session.promoRole);
  } catch (err) {
    console.error("[promo.get] detail fetch threw", err);
    return jsonError(500, "get_failed");
  }
  if (!detail) return jsonError(404, "promo_not_found");

  return jsonResponse({ promo: detail });
}
