// IT Issue Tracker (2026-11-04) -- replaces the per-site "IT Issues Tracker"
// spreadsheets with one shared log.
//
// ROUTES (all under /workorders/api/, dispatched from index.ts):
//   GET  it-issues                     list (site-scoped)          session
//   POST it-issues                     report a new issue          session
//   GET  it-issues/{id}                detail + timeline           session
//   POST it-issues/{id}/occurrence     "happened again"            session
//   POST it-issues/{id}/update         status / priority / ticket # / note / resolve
//   POST it-issues/{id}/escalate       email it to IT now          session
//   POST it-issues/{id}/mx-request     open a MaintainX work request
//   GET  it-issue-link/{token}         public timeline (no sign-in)
//   POST it-issue-link/{token}         IT acts from the email link (no sign-in)
//
// WHO SEES WHAT. Admin tier sees every site. Everyone else sees the sites whose
// am_email / rm_email / site_email / gm_email is their login -- so a site sees
// only its own issues, and a Regional Manager or Director sees their region.
// Sites never see each other's issues (operator decision); the cross-site
// "same device failing at several sites" view lives in the IT report instead.
//
// NAMES ARE TYPED, NOT LOOKED UP. Users are not mapped to people (many sites
// sign in with a shared account), so every action carries a typed actor name
// alongside the login email. That is what replaced "JMS" in the spreadsheet.
//
// ONE RULE PATH. The in-app update and the email-link actions both go through
// applyChange(); never fork it, or the two ways of closing a ticket will drift
// on what closing requires.

import type { Session } from "@splash/auth";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import { createMaintainXWorkRequest, uploadMaintainXWorkRequestFile } from "@splash/maintainx";
import { sendEscalationEmail, sendSiteUpdateEmail } from "./it-issues-email.js";
import { MAX_PHOTOS_PER_ACTION, photoKey, servePhoto, storePhotos, type IssuePhoto } from "./it-issues-photos.js";

export interface ItIssuesEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  MAINTAINX_API_KEY?: string;
  MAINTAINX_BASE_URL: string;
  APPS_WEB_BASE_URL: string;
  /** Comma-separated. Daily report recipients. Testing: the operator only. */
  IT_ISSUES_REPORT_TO?: string;
  /** Comma-separated. "Send to IT support now" recipients. */
  IT_ISSUES_ESCALATE_TO?: string;
  /** Photos live here under it-issues/ (it-issues-photos.ts). */
  WORKORDER_FILES?: R2Bucket;
}

/* ============================================================
 * Vocabulary
 * ============================================================ */

/** Devices a site can pick. The spreadsheet hard-coded Kiosk1-3 / Gate1-3 for
 *  every site; here the device is a type and the unit is a separate optional
 *  field, so a site with two kiosks is not offered a third. */
export const DEVICES = [
  "POS",
  "POS printer",
  "Cash drawer",
  "Tablet",
  "Kiosk",
  "Kiosk printer",
  "Kiosk scanner",
  "LPR camera",
  "RFID reader",
  "Gate",
  "Exit gate",
  "Manager computer",
  "Menu board",
  "Tunnel entrance board",
  "Tunnel exit board",
  "Tunnel controller / VQ",
  "Network / internet",
  "Wi-Fi",
  "JotForm tablet",
  "Phone",
  "Software / customer accounts",
  "Other"
] as const;

export const IMPACTS = ["none", "single_customer", "multiple_customers", "site_wide"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const STATUSES = ["open", "waiting_on_it", "in_progress", "resolved"] as const;

type Impact = (typeof IMPACTS)[number];
type Priority = (typeof PRIORITIES)[number];
type Status = (typeof STATUSES)[number];

const LIMITS = {
  name: 80,
  phone: 30,
  unit: 20,
  problem: 300,
  error: 1000,
  text: 4000,
  ticket: 60
};

/** A link minted today keeps working this long. Long, because an issue can
 *  sit open for weeks; every later email carries a fresh one anyway. */
const LINK_TTL_DAYS = 90;

export interface IssueRow {
  id: string;
  ref_no: number;
  location_id: number;
  site_number: number | null;
  site_name: string;
  device: string;
  device_unit: string | null;
  problem: string;
  error_text: string | null;
  customer_impact: Impact;
  priority: Priority;
  troubleshooting: string | null;
  status: Status;
  reporter_name: string;
  reporter_phone: string;
  created_by_email: string;
  it_ticket_no: string | null;
  mx_request_id: number | null;
  first_reported_at: string;
  last_occurred_at: string;
  occurrence_count: number;
  last_escalated_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  issue_id: string;
  kind: string;
  at: string;
  actor_name: string | null;
  actor_email: string | null;
  via: "app" | "email_link" | "system";
  note: string | null;
  details: Record<string, unknown>;
}

interface SiteRow {
  id: number;
  site: string | null;
  site_number: number | null;
  maintainx_id: number | null;
}

/* ============================================================
 * PostgREST
 * ============================================================ */

export async function pg<T>(
  env: ItIssuesEnv,
  method: "GET" | "POST" | "PATCH",
  pathAndQuery: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ ok: boolean; status: number; data: T | null; headers: Headers }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    console.error(`[it-issues] ${method} ${pathAndQuery.split("?")[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return { ok: false, status: res.status, data: null, headers: res.headers };
  }
  const text = await res.text();
  return { ok: true, status: res.status, data: text ? (JSON.parse(text) as T) : null, headers: res.headers };
}

async function getIssue(env: ItIssuesEnv, id: string): Promise<IssueRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pg<IssueRow[]>(env, "GET", `it_issues?id=eq.${id}&select=*`);
  return r.data?.[0] ?? null;
}

export async function getEvents(env: ItIssuesEnv, issueId: string): Promise<EventRow[]> {
  const r = await pg<EventRow[]>(env, "GET", `it_issue_events?issue_id=eq.${issueId}&select=*&order=at.asc,id.asc`);
  return r.data ?? [];
}

async function addEvent(
  env: ItIssuesEnv,
  ev: Omit<EventRow, "id" | "at" | "details"> & { details?: Record<string, unknown> }
): Promise<EventRow | null> {
  const r = await pg<EventRow[]>(env, "POST", "it_issue_events", { ...ev, details: ev.details ?? {} }, {
    Prefer: "return=representation"
  });
  return r.data?.[0] ?? null;
}

async function patchIssue(env: ItIssuesEnv, id: string, patch: Partial<IssueRow>): Promise<IssueRow | null> {
  const r = await pg<IssueRow[]>(env, "PATCH", `it_issues?id=eq.${id}`, { ...patch, updated_at: new Date().toISOString() }, {
    Prefer: "return=representation"
  });
  return r.data?.[0] ?? null;
}

/* ============================================================
 * Access
 * ============================================================ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BETA GATE (operator, 2026-11-04): the tracker is opened per person with the
 * `it_issues` tool grant, so nobody stumbles into it and starts using it
 * without direction. Super admins have it implicitly. Admin tier deliberately
 * does NOT -- that is the population most likely to wander in. The emailed
 * no-sign-in links are unaffected: they are minted by the tool itself.
 *
 * Mirrored in apps/web (tile + pages); this is the one that counts.
 */
export function canUseItIssues(session: Session): boolean {
  return session.role === "super_admin" || (session.tools as readonly string[]).includes("it_issues");
}

function isAdminTier(session: Session): boolean {
  return session.role === "super_admin" || session.dcRole === "admin" || session.dcRole === "super_admin";
}

async function accessibleSites(env: ItIssuesEnv, session: Session): Promise<{ all: boolean; sites: SiteRow[] }> {
  const select = "select=id,site,site_number,maintainx_id&order=site_number.asc,site.asc&limit=500";
  if (isAdminTier(session)) {
    const r = await pg<SiteRow[]>(env, "GET", `locations?${select}`);
    return { all: true, sites: r.data ?? [] };
  }
  const email = (session.email ?? "").trim().toLowerCase();
  if (!email) return { all: false, sites: [] };
  const e = encodeURIComponent(email);
  const r = await pg<SiteRow[]>(
    env,
    "GET",
    `locations?or=(am_email.eq.${e},rm_email.eq.${e},site_email.eq.${e},gm_email.eq.${e})&${select}`
  );
  return { all: false, sites: r.data ?? [] };
}

function siteLabel(s: SiteRow): string {
  const num = s.site_number != null ? String(s.site_number).padStart(3, "0") : "";
  return [num, s.site ?? ""].filter(Boolean).join(" ");
}

/* ============================================================
 * Input helpers
 * ============================================================ */

type Body = Record<string, unknown>;

async function readJson(request: Request): Promise<Body | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : null;
  } catch {
    return null;
  }
}

/**
 * JSON, or multipart when photos ride along. Multipart text fields become the
 * same Body the JSON path produces, and every non-empty `photo` part is a file.
 */
async function readBody(request: Request): Promise<{ body: Body; files: File[] } | null> {
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const body = await readJson(request);
    return body ? { body, files: [] } : null;
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  const body: Body = {};
  form.forEach((v, k) => {
    if (typeof v === "string") body[k] = v;
  });
  const files = form.getAll("photo").filter((v): v is File => typeof v !== "string" && v.size > 0);
  if (files.length > MAX_PHOTOS_PER_ACTION) throw new InputError(`Up to ${MAX_PHOTOS_PER_ACTION} photos at a time.`);
  return { body, files };
}

function photoWarning(rejected: string[]): string | null {
  return rejected.length ? `Not saved (not an image, or too large): ${rejected.join(", ")}` : null;
}

/** Trimmed string, null when blank. Throws a user-facing message past `max`. */
function str(body: Body, key: string, max: number, label: string): string | null {
  const v = body[key];
  if (v == null) return null;
  if (typeof v !== "string") throw new InputError(`${label} must be text.`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new InputError(`${label} is too long (max ${max} characters).`);
  return t;
}

function required(body: Body, key: string, max: number, label: string): string {
  const v = str(body, key, max, label);
  if (!v) throw new InputError(`${label} is required.`);
  return v;
}

function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[], label: string): T | null {
  const v = body[key];
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new InputError(`${label} is not a valid choice.`);
  }
  return v as T;
}

class InputError extends Error {}

/* ============================================================
 * Shared change path (in-app + email link)
 * ============================================================ */

export interface Actor {
  name: string;
  email: string | null;
  via: "app" | "email_link";
}

export interface Change {
  status?: Status | null;
  priority?: Priority | null;
  it_ticket_no?: string | null;
  note?: string | null;
  resolution?: string | null;
  /** Already stored; recorded on the note event. */
  photos?: IssuePhoto[];
}

/**
 * Apply a change to an issue and record it on the timeline. Returns the
 * updated issue, or an error message for the user.
 *
 * Resolving REQUIRES a resolution note -- an issue closed without one is the
 * thing nobody can explain when it comes back. Moving a resolved issue to any
 * other status is a reopen and clears the resolution fields.
 */
export async function applyChange(
  env: ItIssuesEnv,
  issue: IssueRow,
  change: Change,
  actor: Actor
): Promise<{ ok: true; issue: IssueRow; events: EventRow[] } | { ok: false; error: string }> {
  const patch: Partial<IssueRow> = {};
  const events: Array<Parameters<typeof addEvent>[1]> = [];
  const base = { issue_id: issue.id, actor_name: actor.name, actor_email: actor.email, via: actor.via };

  if (change.it_ticket_no !== undefined && change.it_ticket_no !== issue.it_ticket_no && change.it_ticket_no) {
    patch.it_ticket_no = change.it_ticket_no;
    events.push({ ...base, kind: "ticket", note: null, details: { from: issue.it_ticket_no, to: change.it_ticket_no } });
  }

  if (change.priority && change.priority !== issue.priority) {
    patch.priority = change.priority;
    events.push({ ...base, kind: "priority", note: null, details: { from: issue.priority, to: change.priority } });
  }

  const nextStatus = change.status ?? null;
  if (nextStatus === "resolved" && issue.status !== "resolved") {
    if (!change.resolution) return { ok: false, error: "Say how it was resolved before closing it." };
    const now = new Date().toISOString();
    Object.assign(patch, { status: "resolved", resolved_at: now, resolution: change.resolution, resolved_by: actor.name });
    events.push({ ...base, kind: "resolved", note: change.resolution, details: { from: issue.status } });
  } else if (nextStatus && nextStatus !== issue.status) {
    if (issue.status === "resolved") {
      Object.assign(patch, { status: nextStatus, resolved_at: null, resolution: null, resolved_by: null });
      events.push({ ...base, kind: "reopened", note: null, details: { to: nextStatus } });
    } else {
      patch.status = nextStatus;
      events.push({ ...base, kind: "status", note: null, details: { from: issue.status, to: nextStatus } });
    }
  }

  // Photos sent with an update hang off the note -- a photo with no words is
  // still a note on the timeline.
  if (change.note || change.photos?.length) {
    events.push({
      ...base,
      kind: "note",
      note: change.note ?? null,
      details: change.photos?.length ? { photos: change.photos } : {}
    });
  }

  if (events.length === 0) return { ok: false, error: "Nothing to save -- nothing was changed." };

  let updated = issue;
  if (Object.keys(patch).length > 0) {
    const p = await patchIssue(env, issue.id, patch);
    if (!p) return { ok: false, error: "Could not save the change. Try again." };
    updated = p;
  } else {
    // A note alone still counts as activity for the "no activity in N days"
    // flag in the IT report.
    updated = (await patchIssue(env, issue.id, {})) ?? issue;
  }
  const written: EventRow[] = [];
  for (const ev of events) {
    const row = await addEvent(env, ev);
    if (row) written.push(row);
  }
  return { ok: true, issue: updated, events: written };
}

/**
 * Record another occurrence. On a resolved issue this reopens it: the fix did
 * not hold, and keeping it on one timeline is what shows IT that.
 *
 * The count is recomputed from the events rather than incremented, so two
 * people logging at the same moment cannot lose one.
 */
async function recordOccurrence(
  env: ItIssuesEnv,
  issue: IssueRow,
  actor: Actor,
  note: string | null,
  errorText: string | null,
  photos: IssuePhoto[] = []
): Promise<IssueRow | null> {
  const base = { issue_id: issue.id, actor_name: actor.name, actor_email: actor.email, via: actor.via };
  const reopening = issue.status === "resolved";
  if (reopening) {
    await addEvent(env, { ...base, kind: "reopened", note: null, details: { to: "open", previous_resolution: issue.resolution } });
  }
  const details: Record<string, unknown> = {};
  if (errorText) details.error_text = errorText;
  if (photos.length) details.photos = photos;
  await addEvent(env, { ...base, kind: "occurrence", note, details });

  const counted = await pg<unknown[]>(env, "GET", `it_issue_events?issue_id=eq.${issue.id}&kind=eq.occurrence&select=id`, undefined, {
    Prefer: "count=exact",
    Range: "0-0"
  });
  const total = Number(counted.headers.get("content-range")?.split("/")[1] ?? NaN);
  const patch: Partial<IssueRow> = {
    last_occurred_at: new Date().toISOString(),
    occurrence_count: Number.isFinite(total) ? total + 1 : issue.occurrence_count + 1
  };
  if (reopening) Object.assign(patch, { status: "open", resolved_at: null, resolution: null, resolved_by: null });
  return patchIssue(env, issue.id, patch);
}

/* ============================================================
 * Links
 * ============================================================ */

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a no-sign-in link for one recipient. Returns the full URL, or null if
 *  the row could not be stored (the email then goes without a link). */
export async function mintIssueLink(env: ItIssuesEnv, issueId: string, recipient: string): Promise<string | null> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const r = await pg(env, "POST", "it_issue_links", {
    issue_id: issueId,
    token_hash: await sha256Hex(token),
    recipient,
    expires_at: new Date(Date.now() + LINK_TTL_DAYS * 86_400_000).toISOString()
  });
  if (!r.ok) return null;
  return `${appsWebBase(env)}/it-issue/${token}`;
}

export function appsWebBase(env: ItIssuesEnv): string {
  return (env.APPS_WEB_BASE_URL || "https://splashcarwashes.info").replace(/\/+$/, "");
}

export function recipientsOf(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

async function resolveLink(
  env: ItIssuesEnv,
  token: string
): Promise<{ id: string; openCount: number; issue: IssueRow } | null> {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const r = await pg<Array<{ id: string; issue_id: string; expires_at: string; open_count: number }>>(
    env,
    "GET",
    `it_issue_links?token_hash=eq.${hash}&select=id,issue_id,expires_at,open_count`
  );
  const link = r.data?.[0];
  if (!link || Date.parse(link.expires_at) < Date.now()) return null;
  const issue = await getIssue(env, link.issue_id);
  return issue ? { id: link.id, openCount: link.open_count, issue } : null;
}

/* ============================================================
 * Handlers
 * ============================================================ */

function siteFor(sites: SiteRow[], locationId: number): SiteRow | undefined {
  return sites.find((s) => s.id === locationId);
}

async function loadAccessibleIssue(
  env: ItIssuesEnv,
  session: Session,
  id: string
): Promise<{ issue: IssueRow; site: SiteRow | undefined } | Response> {
  const [{ sites }, issue] = await Promise.all([accessibleSites(env, session), getIssue(env, id)]);
  const site = issue ? siteFor(sites, issue.location_id) : undefined;
  // Not yours and not found are the same answer.
  if (!issue || !site) return jsonError(404, "not found");
  return { issue, site };
}

function actorFromBody(body: Body, session: Session): Actor {
  return {
    name: required(body, "actor_name", LIMITS.name, "Your name"),
    email: session.email?.toLowerCase() ?? null,
    via: "app"
  };
}

export async function handleItIssuesRequest(
  request: Request,
  env: ItIssuesEnv,
  path: string,
  session: Session
): Promise<Response> {
  try {
    const rest = path.replace(/^workorders\/api\/it-issues\/?/, "");
    const [id, action, file] = rest.split("/");

    if (!canUseItIssues(session)) {
      return jsonError(403, "The IT Issue Tracker is in beta. Ask a super admin for access.");
    }

    if (request.method !== "GET" && !isOriginAllowed(request)) return jsonError(403, "bad origin");

    if (!id) {
      if (request.method === "GET") return listIssues(env, session, new URL(request.url));
      if (request.method === "POST") return createIssue(request, env, session);
      return jsonError(405, "method not allowed");
    }

    const loaded = await loadAccessibleIssue(env, session, id);
    if (loaded instanceof Response) return loaded;
    const { issue, site } = loaded;

    if (action === "photo" && file && request.method === "GET") return servePhoto(env, issue.id, file);

    if (!action && request.method === "GET") {
      const events = await getEvents(env, issue.id);
      return json({
        issue,
        events,
        escalate_to: recipientsOf(env.IT_ISSUES_ESCALATE_TO),
        mx_available:
          !issue.mx_request_id && !!site?.maintainx_id && !!env.MAINTAINX_API_KEY && mxBlockedReason(issue) === null,
        // Shown on the page so "where is the MaintainX button?" has an answer.
        mx_blocked_reason:
          !issue.mx_request_id && site?.maintainx_id && env.MAINTAINX_API_KEY ? mxBlockedReason(issue) : null,
        devices: DEVICES
      });
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed");

    const parsed = await readBody(request);
    if (!parsed) return jsonError(400, "Could not read the form.");
    const { body, files } = parsed;
    const actor = actorFromBody(body, session);
    // Validate the text before storing anything, so a rejected form leaves no
    // orphan photos behind.
    const note = str(body, "note", LIMITS.text, "Note");
    const stored =
      (action === "occurrence" || action === "update") && files.length
        ? await storePhotos(env, issue.id, files)
        : { photos: [], rejected: [] as string[] };

    if (action === "occurrence") {
      const updated = await recordOccurrence(
        env,
        issue,
        actor,
        note,
        str(body, "error_text", LIMITS.error, "Error message"),
        stored.photos
      );
      if (!updated) return jsonError(500, "Could not record it. Try again.");
      return json({
        ok: true,
        issue: updated,
        reopened: issue.status === "resolved",
        photo_warning: photoWarning(stored.rejected)
      });
    }

    if (action === "update") {
      const result = await applyChange(
        env,
        issue,
        {
          status: oneOf(body, "status", STATUSES, "Status"),
          priority: oneOf(body, "priority", PRIORITIES, "Priority"),
          it_ticket_no: str(body, "it_ticket_no", LIMITS.ticket, "IT ticket #"),
          note,
          resolution: str(body, "resolution", LIMITS.text, "Resolution"),
          photos: stored.photos
        },
        actor
      );
      return result.ok
        ? json({ ok: true, issue: result.issue, photo_warning: photoWarning(stored.rejected) })
        : jsonError(400, result.error);
    }

    if (action === "escalate") {
      const to = recipientsOf(env.IT_ISSUES_ESCALATE_TO);
      if (to.length === 0) return jsonError(503, "No IT support address is configured.");
      const note = str(body, "note", LIMITS.text, "Note");
      const ev = await addEvent(env, {
        issue_id: issue.id,
        kind: "escalated",
        actor_name: actor.name,
        actor_email: actor.email,
        via: "app",
        note,
        details: { to }
      });
      if (!ev) return jsonError(500, "Could not record the escalation. Try again.");
      const patch: Partial<IssueRow> = { last_escalated_at: ev.at };
      // Sent to IT and nobody there has picked it up yet.
      if (issue.status === "open") patch.status = "waiting_on_it";
      const updated = (await patchIssue(env, issue.id, patch)) ?? issue;
      const sent = await sendEscalationEmail(env, updated, await getEvents(env, issue.id), ev, to);
      if (sent.failed.length === to.length) {
        return jsonError(502, "Recorded, but the email could not be queued. Try again or email IT directly.");
      }
      return json({ ok: true, sent_to: sent.sent });
    }

    if (action === "mx-request") {
      if (issue.mx_request_id) return jsonError(409, `Already linked to MaintainX request #${issue.mx_request_id}.`);
      const blocked = mxBlockedReason(issue);
      if (blocked) return jsonError(400, blocked);
      const made = await createMxRequest(env, issue, site!, session, actor);
      return made.ok
        ? json({ ok: true, mx_request_id: made.id, photos_failed: made.photosFailed })
        : jsonError(502, made.error);
    }

    return jsonError(404, "not found");
  } catch (err) {
    if (err instanceof InputError) return jsonError(400, err.message);
    throw err;
  }
}

async function listIssues(env: ItIssuesEnv, session: Session, url: URL): Promise<Response> {
  const { all, sites } = await accessibleSites(env, session);
  const sitesOut = sites.map((s) => ({ id: s.id, label: siteLabel(s), site_number: s.site_number, name: s.site ?? "" }));
  if (sites.length === 0) return json({ issues: [], sites: [], all_sites: all, devices: DEVICES });

  const filters: string[] = [];
  const status = url.searchParams.get("status") ?? "open";
  if (status === "open") filters.push("status=neq.resolved");
  else if (status === "resolved") filters.push("status=eq.resolved");

  const loc = Number(url.searchParams.get("location_id"));
  if (Number.isInteger(loc) && loc > 0) {
    if (!siteFor(sites, loc)) return json({ issues: [], sites: sitesOut, all_sites: all, devices: DEVICES });
    filters.push(`location_id=eq.${loc}`);
  } else if (!all) {
    filters.push(`location_id=in.(${sites.map((s) => s.id).join(",")})`);
  }
  const device = url.searchParams.get("device");
  if (device && (DEVICES as readonly string[]).includes(device)) filters.push(`device=eq.${encodeURIComponent(device)}`);

  const order = status === "resolved" ? "resolved_at.desc" : "first_reported_at.asc";
  const r = await pg<IssueRow[]>(env, "GET", `it_issues?select=*&${filters.join("&")}&order=${order}&limit=500`);
  if (!r.ok) return jsonError(500, "Could not load issues.");
  return json({ issues: r.data ?? [], sites: sitesOut, all_sites: all, devices: DEVICES });
}

async function createIssue(request: Request, env: ItIssuesEnv, session: Session): Promise<Response> {
  const parsed = await readBody(request);
  if (!parsed) return jsonError(400, "Could not read the form.");
  const { body, files } = parsed;

  const { sites } = await accessibleSites(env, session);
  const site = siteFor(sites, Number(body.location_id));
  if (!site) return jsonError(400, "Pick one of your sites.");

  const device = oneOf(body, "device", DEVICES, "Device");
  if (!device) throw new InputError("Pick the device or system.");
  const impact = oneOf(body, "customer_impact", IMPACTS, "Customer impact");
  if (!impact) throw new InputError("Pick the customer impact.");
  const priority = oneOf(body, "priority", PRIORITIES, "Priority");
  if (!priority) throw new InputError("Pick a priority.");

  const row = {
    location_id: site.id,
    site_number: site.site_number,
    site_name: siteLabel(site),
    device,
    device_unit: str(body, "device_unit", LIMITS.unit, "Unit"),
    problem: required(body, "problem", LIMITS.problem, "What is happening"),
    error_text: str(body, "error_text", LIMITS.error, "Error message"),
    customer_impact: impact,
    priority,
    troubleshooting: str(body, "troubleshooting", LIMITS.text, "Troubleshooting"),
    reporter_name: required(body, "reporter_name", LIMITS.name, "Your name"),
    reporter_phone: required(body, "reporter_phone", LIMITS.phone, "Your phone"),
    created_by_email: (session.email ?? "").toLowerCase(),
    it_ticket_no: str(body, "it_ticket_no", LIMITS.ticket, "IT ticket #")
  };

  const ins = await pg<IssueRow[]>(env, "POST", "it_issues", row, { Prefer: "return=representation" });
  const issue = ins.data?.[0];
  if (!issue) return jsonError(500, "Could not save the issue. Try again.");

  // Photos need the issue id for their key, so they are stored after the
  // issue row and recorded on the "created" event.
  const stored = await storePhotos(env, issue.id, files);
  const actor: Actor = { name: row.reporter_name, email: row.created_by_email || null, via: "app" };
  await addEvent(env, {
    issue_id: issue.id,
    kind: "created",
    actor_name: actor.name,
    actor_email: actor.email,
    via: "app",
    note: null,
    details: stored.photos.length ? { phone: row.reporter_phone, photos: stored.photos } : { phone: row.reporter_phone }
  });

  return json({ ok: true, id: issue.id, ref_no: issue.ref_no, photo_warning: photoWarning(stored.rejected) }, 201);
}

/**
 * Why this issue may NOT be sent to MaintainX, or null when it may.
 *
 * WHERE, not WHEN, is the control (operator, 2026-11-04). A MaintainX request
 * is never offered on the report form -- an "add to MaintainX" box right
 * before submit would send nearly every report there. It IS offered on any
 * open issue's page, with no priority / repeat / escalation qualifier: a kiosk
 * that is completely dead should not have to be reported twice to qualify.
 * The deliberate second visit to the issue is the filter.
 */
export function mxBlockedReason(issue: Pick<IssueRow, "status">): string | null {
  if (issue.status === "resolved") return "The issue is resolved.";
  return null;
}

const MX_PRIORITY: Record<Priority, "HIGH" | "MEDIUM" | "LOW"> = {
  critical: "HIGH",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW"
};

export const IMPACT_LABEL: Record<Impact, string> = {
  none: "No customer impact",
  single_customer: "One customer",
  multiple_customers: "Multiple customers",
  site_wide: "Site-wide"
};

export function deviceLabel(issue: Pick<IssueRow, "device" | "device_unit">): string {
  return issue.device_unit ? `${issue.device} ${issue.device_unit}` : issue.device;
}

function easternDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(iso));
}

/** The MaintainX request description. No link back to the issue, by operator
 *  decision: the IT-{ref} line is the cross-reference. */
export function buildMxDescription(
  issue: Pick<
    IssueRow,
    | "problem"
    | "error_text"
    | "customer_impact"
    | "troubleshooting"
    | "occurrence_count"
    | "first_reported_at"
    | "last_occurred_at"
    | "it_ticket_no"
    | "reporter_name"
    | "reporter_phone"
    | "ref_no"
  >
): string {
  const history =
    issue.occurrence_count > 1
      ? `Happened ${issue.occurrence_count} times (first ${easternDay(issue.first_reported_at)}, last ${easternDay(issue.last_occurred_at)})`
      : `First reported: ${easternDay(issue.first_reported_at)}`;
  return [
    issue.problem,
    issue.error_text ? `Error: ${issue.error_text}` : "",
    `Customer impact: ${IMPACT_LABEL[issue.customer_impact]}`,
    history,
    issue.troubleshooting ? `Already tried: ${issue.troubleshooting}` : "",
    "",
    "---",
    `Reported by: ${issue.reporter_name}`,
    `Phone: ${issue.reporter_phone}`,
    `IT issue: IT-${issue.ref_no}`,
    issue.it_ticket_no ? `IT ticket #: ${issue.it_ticket_no}` : "",
    `Submitted via: Splash IT Issues`
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n");
}

/**
 * The photos to send with a MaintainX request: every photo on the timeline in
 * the order they were added, capped at MaintainX's 5 (the /workorders form
 * cap). The first becomes the request's thumbnail, so the original report's
 * picture leads.
 */
export function photosForMx(events: Pick<EventRow, "details">[]): IssuePhoto[] {
  const out: IssuePhoto[] = [];
  for (const ev of events) {
    const photos = (ev.details as { photos?: IssuePhoto[] } | null)?.photos;
    if (Array.isArray(photos)) out.push(...photos);
  }
  return out.slice(0, MAX_PHOTOS_PER_ACTION);
}

async function createMxRequest(
  env: ItIssuesEnv,
  issue: IssueRow,
  site: SiteRow,
  session: Session,
  actor: Actor
): Promise<{ ok: true; id: number; photosFailed: number } | { ok: false; error: string }> {
  if (!env.MAINTAINX_API_KEY) return { ok: false, error: "MaintainX is not configured." };
  if (!site.maintainx_id) return { ok: false, error: "This site is not linked to a MaintainX location." };

  const description = buildMxDescription(issue);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  let result;
  try {
    result = await createMaintainXWorkRequest({
      title: `IT: ${deviceLabel(issue)} - ${issue.problem}`.slice(0, 120),
      description,
      priority: MX_PRIORITY[issue.priority],
      locationId: site.maintainx_id,
      creatorContactInfo: session.email ?? "",
      apiKey: env.MAINTAINX_API_KEY,
      baseUrl: env.MAINTAINX_BASE_URL,
      signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!result.ok || result.requestId == null) {
    console.error(`[it-issues] MaintainX request for IT-${issue.ref_no} failed: ${result.status} ${result.error}`);
    return { ok: false, error: `MaintainX request could not be created (${result.error ?? "upstream error"}).` };
  }
  const requestId = result.requestId;
  // Link the request before uploading, so a slow or failed upload can never
  // let a second click create a duplicate request.
  await patchIssue(env, issue.id, { mx_request_id: requestId });

  // Photos are best-effort: the request exists either way (same posture as
  // the /workorders New Request form).
  const photos = photosForMx(await getEvents(env, issue.id));
  let photosFailed = 0;
  for (const [i, p] of photos.entries()) {
    const obj = env.WORKORDER_FILES ? await env.WORKORDER_FILES.get(photoKey(issue.id, p.file)) : null;
    if (!obj) {
      photosFailed += 1;
      continue;
    }
    const upCtl = new AbortController();
    const upTimer = setTimeout(() => upCtl.abort(), 15_000);
    try {
      const up = await uploadMaintainXWorkRequestFile({
        requestId,
        filename: `IT-${issue.ref_no}-${i + 1}.${p.file.split(".").pop()}`,
        body: await obj.arrayBuffer(),
        apiKey: env.MAINTAINX_API_KEY,
        baseUrl: env.MAINTAINX_BASE_URL,
        endpoint: i === 0 ? "thumbnail" : "attachment",
        signal: upCtl.signal
      });
      if (!up.ok) {
        photosFailed += 1;
        console.error(`[it-issues] MaintainX request ${requestId} photo ${i} failed: ${up.status} ${up.error}`);
      }
    } catch (err) {
      photosFailed += 1;
      console.error(`[it-issues] MaintainX request ${requestId} photo ${i} threw`, err);
    } finally {
      clearTimeout(upTimer);
    }
  }

  await addEvent(env, {
    issue_id: issue.id,
    kind: "mx_request",
    actor_name: actor.name,
    actor_email: actor.email,
    via: "app",
    note: null,
    details: {
      mx_request_id: requestId,
      photos_sent: photos.length - photosFailed,
      ...(photosFailed ? { photos_failed: photosFailed } : {})
    }
  });
  return { ok: true, id: requestId, photosFailed };
}

/* ============================================================
 * Public link (no sign-in)
 * ============================================================ */

/** Fields an email-link holder may see. The reporter's phone is included on
 *  purpose: calling the site is the most common thing IT does next. */
function publicView(issue: IssueRow, events: EventRow[]) {
  return {
    issue,
    events: events.map(({ actor_email: _e, ...rest }) => rest),
    read_only: issue.status === "resolved"
  };
}

export async function handleItIssueLink(
  request: Request,
  env: ItIssuesEnv,
  token: string,
  photoFile?: string
): Promise<Response> {
  try {
    const found = await resolveLink(env, token);
    // Bad token, expired and unknown all look the same.
    if (!found) return jsonError(404, "This link has expired or is not valid.");
    const { issue } = found;

    // A photo on this link's issue. Not counted as an open.
    if (photoFile) {
      return request.method === "GET" ? servePhoto(env, issue.id, photoFile) : jsonError(405, "method not allowed");
    }

    if (request.method === "GET") {
      // Opening never spends the link; the count is just an audit trail.
      await pg(env, "PATCH", `it_issue_links?id=eq.${found.id}`, {
        open_count: found.openCount + 1,
        last_opened_at: new Date().toISOString()
      });
      return json(publicView(issue, await getEvents(env, issue.id)));
    }

    if (request.method !== "POST") return jsonError(405, "method not allowed");
    if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
    if (issue.status === "resolved") return jsonError(409, "This issue is already resolved.");

    const body = await readJson(request);
    if (!body) return jsonError(400, "Send the form as JSON.");
    const actor: Actor = {
      // A shared inbox can't identify a person, so the name is required.
      name: required(body, "actor_name", LIMITS.name, "Your name"),
      email: null,
      via: "email_link"
    };
    const result = await applyChange(
      env,
      issue,
      {
        status: oneOf(body, "status", STATUSES, "Status"),
        it_ticket_no: str(body, "it_ticket_no", LIMITS.ticket, "Ticket #"),
        note: str(body, "note", LIMITS.text, "Note"),
        resolution: str(body, "resolution", LIMITS.text, "Resolution")
      },
      actor
    );
    if (!result.ok) return jsonError(400, result.error);
    // Tell the site what IT just did. The site's own actions (in the app)
    // never trigger this -- only IT, acting from an emailed link.
    if (result.events.length) await sendSiteUpdateEmail(env, result.issue, result.events);
    return json({ ok: true, ...publicView(result.issue, await getEvents(env, issue.id)) });
  } catch (err) {
    if (err instanceof InputError) return jsonError(400, err.message);
    throw err;
  }
}
