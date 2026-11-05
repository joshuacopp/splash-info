// Vehicle Guide — known problem vehicles and what to do about them.
//
// Two audiences, two surfaces:
//
//   PUBLIC (no login) — GET /claims/vehicles/{token}
//                       GET /claims/vehicles/{token}/media/{mediaId}
//     Site staff on a phone at the entrance. Rides the damage-worker's
//     existing /claims/* production route, so no new Cloudflare route was
//     needed. The token is the ONLY gate: it lives in the VEHICLE_GUIDE_TOKEN
//     secret, and changing that secret kills every copy of the old link. A
//     wrong or missing token answers exactly like any other unknown path (a
//     bare 404), so the page cannot be found by probing for it.
//
//   ADMIN — /manage/api/vehicle-issues*  (behind the "claims" tool gate)
//     Read by anyone with a damage role; written only by damage RM and above.
//
//   CLAIM FORM — GET /claims-api/vehicle-issues/match?make=&model=&year=
//     The public claim form's staff section asks this for known VEHICLE
//     issues (category 'vehicle') on the car being claimed. Public like the
//     rest of /claims-api: it answers only for the exact vehicle asked about,
//     only vehicle-category entries, and no media -- the browsable guide stays
//     behind its token.
//
// DATA: D1 tables vehicle_issues + vehicle_issue_media
// (migrations/0002, 0003, 0004). Bytes in R2 under vehicle-guide/.

import type { Session } from "@splash/auth";
import { isOriginAllowed, json, jsonError, readForm } from "@splash/http";
import { type ImagesBinding, isHeicContentType } from "@splash/storage-r2";
import {
  canonicalYouTubeUrl,
  formatVehicleYears,
  isVehicleIssueCategory,
  isVehicleIssueType,
  matchVehicleIssues,
  MAX_YOUTUBE_LINKS,
  parseYouTubeUrl,
  vehicleIssueTypeCategory,
  vehicleIssueTypeLabel,
  vehicleModelsLabel,
  type VehicleIssue,
  type VehicleIssueMedia,
  type VehicleIssuesResponse
} from "@splash/types/vehicle-guide";
import { fileTypeFromBuffer } from "file-type";
import { renderVehicleGuidePage } from "./render/vehicle-guide-page.js";

export interface VehicleGuideEnv {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
  /** Secret path segment for the public page. Unbound (or shorter than 16
   *  characters) means the public page does not exist. */
  VEHICLE_GUIDE_TOKEN?: string;
}

/** Damage roles allowed to add, edit and delete entries. GMs can read. */
const EDIT_ROLES: ReadonlySet<string> = new Set(["rm", "admin", "super_admin"]);

const MIN_TOKEN_LENGTH = 16;

const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** Per entry. Enough to show the problem; a cap keeps one entry from turning
 *  the phone page into a 500 MB download. */
const MAX_MEDIA_PER_ISSUE = 8;

const MEDIA_TYPES: Record<string, { kind: "photo" | "video"; ext: string }> = {
  "image/jpeg": { kind: "photo", ext: "jpg" },
  "image/png": { kind: "photo", ext: "png" },
  "image/webp": { kind: "photo", ext: "webp" },
  "image/heic": { kind: "photo", ext: "heic" },
  "image/heif": { kind: "photo", ext: "heif" },
  "image/heic-sequence": { kind: "photo", ext: "heic" },
  "image/heif-sequence": { kind: "photo", ext: "heif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/x-m4v": { kind: "video", ext: "m4v" },
  "video/quicktime": { kind: "video", ext: "mov" },
  "video/webm": { kind: "video", ext: "webm" }
};

export function canEditVehicleGuide(session: Session): boolean {
  return session.dcRole !== null && EDIT_ROLES.has(session.dcRole);
}

function configuredToken(env: VehicleGuideEnv): string | null {
  const t = (env.VEHICLE_GUIDE_TOKEN ?? "").trim();
  return t.length >= MIN_TOKEN_LENGTH ? t : null;
}

/** Constant-time compare, so response timing says nothing about how much of a
 *  guessed token was right. (A length mismatch returns early; that leaks the
 *  length, which is not a secret worth protecting.) */
function tokenMatches(env: VehicleGuideEnv, candidate: string): boolean {
  const expected = configuredToken(env);
  if (!expected) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(candidate);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function vehicleGuidePublicPath(env: VehicleGuideEnv): string | null {
  const t = configuredToken(env);
  return t ? `/claims/vehicles/${encodeURIComponent(t)}` : null;
}

/* ============================================================
 * Reads
 * ============================================================ */

/** vehicle_issues.youtube_links -> string[]. A bad value reads as no links
 *  rather than taking the whole page down. */
function readYouTubeLinks(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** vehicle_issues.models -> string[]. NULL (rows from before migration 0004)
 *  is the single `model`; '[]' is every model. A bad value falls back to
 *  `model` rather than silently widening the entry to all models. */
function readModels(raw: string | null, model: string): string[] {
  if (raw === null) return [model];
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  } catch {
    /* fall through */
  }
  return [model];
}

type IssueRow = Omit<VehicleIssue, "media" | "youtube_links" | "models" | "category"> & {
  category: string | null;
  models: string | null;
  youtube_links: string | null;
};

async function listIssues(db: D1Database): Promise<VehicleIssue[]> {
  const [issuesRes, mediaRes] = await Promise.all([
    db
      .prepare(
        `SELECT id, category, make, model, models, year_from, year_to, issue_type, issue, solution,
                bulletin, bulletin_url, youtube_links, created_by, created_at, updated_by, updated_at
           FROM vehicle_issues
          ORDER BY make COLLATE NOCASE, model COLLATE NOCASE, year_from DESC, id`
      )
      .all<IssueRow>(),
    db
      .prepare(
        `SELECT id, issue_id, kind, mime, size_bytes, original_filename, created_by, created_at
           FROM vehicle_issue_media
          ORDER BY issue_id, id`
      )
      .all<VehicleIssueMedia>()
  ]);
  const byIssue = new Map<number, VehicleIssueMedia[]>();
  for (const m of mediaRes.results ?? []) {
    const list = byIssue.get(m.issue_id) ?? [];
    list.push(m);
    byIssue.set(m.issue_id, list);
  }
  return (issuesRes.results ?? []).map((r) => ({
    ...r,
    category: r.category === "vehicle" ? "vehicle" : "loading",
    models: readModels(r.models, r.model),
    youtube_links: readYouTubeLinks(r.youtube_links),
    media: byIssue.get(r.id) ?? []
  }));
}

/** GET /manage/api/vehicle-issues */
export async function handleListVehicleIssues(
  env: VehicleGuideEnv,
  session: Session
): Promise<Response> {
  if (session.dcRole === null) return jsonError(403, "No damage role assigned.");
  const canEdit = canEditVehicleGuide(session);
  const body: VehicleIssuesResponse = {
    issues: await listIssues(env.DB),
    can_edit: canEdit,
    public_path: canEdit ? vehicleGuidePublicPath(env) : null
  };
  return json(body);
}

/* ============================================================
 * Writes (RM and above)
 * ============================================================ */

function gateWrite(request: Request, session: Session): Response | null {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
  if (!canEditVehicleGuide(session)) {
    return jsonError(403, "Only damage regional managers and above can change the vehicle guide.");
  }
  return null;
}

/** Collapse internal whitespace; trim. */
function clean(s: string | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Reuse the spelling already on file when a make (or a model within a make)
 * matches case-insensitively. The public page groups by make then model, so
 * "chevrolet" and "Chevrolet" must land in one bucket -- fixing it at write
 * time keeps every reader simple. Models are compared against every model of
 * every entry for the make, not just single-model entries.
 */
async function canonicalMakeModels(
  db: D1Database,
  make: string,
  models: string[]
): Promise<{ make: string; models: string[] }> {
  const rows = await db
    .prepare(`SELECT make, model, models FROM vehicle_issues WHERE make = ? COLLATE NOCASE`)
    .bind(make)
    .all<{ make: string; model: string; models: string | null }>();
  const list = rows.results ?? [];
  const canonMake = list[0]?.make ?? make;
  const known = new Map<string, string>();
  for (const r of list) {
    for (const m of readModels(r.models, r.model)) {
      if (!known.has(m.toLowerCase())) known.set(m.toLowerCase(), m);
    }
  }
  return { make: canonMake, models: models.map((m) => known.get(m.toLowerCase()) ?? m) };
}

/** Bulletin link: blank (null), an http(s) URL, or undefined when it is
 *  neither. The staff page links to it, so javascript: / data: are refused
 *  rather than rendered. */
function parseBulletinUrl(raw: string): string | null | undefined {
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * POST /manage/api/vehicle-issues — create (no id) or update (id given).
 * Fields: category, make, models (comma or newline separated; ignored when
 * all_models=1), year_from, year_to (blank = "and newer"), issue_type (must
 * belong to the category), issue, solution, bulletin, bulletin_url,
 * youtube_links (optional; one link per line).
 */
export async function handleUpsertVehicleIssue(
  request: Request,
  env: VehicleGuideEnv,
  session: Session
): Promise<Response> {
  const denied = gateWrite(request, session);
  if (denied) return denied;

  const form = await readForm(request);

  let id: number | null = null;
  const idRaw = clean(form.get("id"));
  if (idRaw) {
    const n = Number(idRaw);
    if (!Number.isInteger(n) || n <= 0) return jsonError(400, "That entry could not be identified. Reload the page.");
    id = n;
  }

  const category = clean(form.get("category")) || "loading";
  if (!isVehicleIssueCategory(category)) return jsonError(400, "Pick loading issue or vehicle issue.");

  const make = clean(form.get("make"));
  if (!make || make.length > 60) return jsonError(400, "Enter a make (up to 60 characters).");

  // Models: comma or line separated, de-duplicated case-insensitively.
  // `model` (singular) is still accepted from older callers.
  const allModels = clean(form.get("all_models")) === "1";
  const models: string[] = [];
  if (!allModels) {
    const raw = form.get("models") ?? form.get("model") ?? "";
    for (const piece of raw.split(/[,\n]+/)) {
      const m = clean(piece);
      if (!m) continue;
      if (m.length > 80) return jsonError(400, `"${m.slice(0, 40)}…" is too long for a model (up to 80 characters).`);
      if (!models.some((x) => x.toLowerCase() === m.toLowerCase())) models.push(m);
    }
    if (models.length === 0) return jsonError(400, "Enter at least one model, or tick All models.");
    if (models.length > 30) return jsonError(400, "An entry can list at most 30 models.");
  }

  const maxYear = new Date().getUTCFullYear() + 2;
  const yearFrom = Number(clean(form.get("year_from")));
  if (!Number.isInteger(yearFrom) || yearFrom < 1950 || yearFrom > maxYear) {
    return jsonError(400, `Enter a 'from' year between 1950 and ${maxYear}.`);
  }
  const yearToRaw = clean(form.get("year_to"));
  let yearTo: number | null = null;
  if (yearToRaw) {
    const n = Number(yearToRaw);
    if (!Number.isInteger(n) || n < yearFrom || n > maxYear) {
      return jsonError(400, `The 'to' year must be between ${yearFrom} and ${maxYear}, or blank for "and newer".`);
    }
    yearTo = n;
  }

  const issueType = clean(form.get("issue_type"));
  if (!isVehicleIssueType(issueType) || vehicleIssueTypeCategory(issueType) !== category) {
    return jsonError(400, "Pick an issue type.");
  }

  // Issue + solution keep their line breaks: they are read as instructions,
  // and a numbered list typed on separate lines should stay one.
  const issue = (form.get("issue") ?? "").trim();
  const solution = (form.get("solution") ?? "").trim();
  if (!issue || issue.length > 2000) return jsonError(400, "Describe the issue (up to 2,000 characters).");
  if (!solution || solution.length > 4000) return jsonError(400, "Describe the solution (up to 4,000 characters).");

  // YouTube links: one per line (commas and spaces tolerated too). Each must
  // be a YouTube video -- the public page embeds them, so an arbitrary URL is
  // refused rather than framed. Stored canonical and de-duplicated.
  const links: string[] = [];
  for (const piece of (form.get("youtube_links") ?? "").split(/[\s,]+/)) {
    if (!piece) continue;
    const ref = parseYouTubeUrl(piece);
    if (!ref) {
      return jsonError(400, `"${piece.slice(0, 80)}" is not a YouTube video link. Paste the link from the video's Share button.`);
    }
    const url = canonicalYouTubeUrl(ref);
    if (!links.includes(url)) links.push(url);
  }
  if (links.length > MAX_YOUTUBE_LINKS) {
    return jsonError(400, `An entry can have at most ${MAX_YOUTUBE_LINKS} YouTube links.`);
  }
  const linksJson = links.length ? JSON.stringify(links) : null;

  const bulletin = clean(form.get("bulletin")) || null;
  if (bulletin && bulletin.length > 200) return jsonError(400, "Keep the bulletin reference under 200 characters.");
  const bulletinUrl = parseBulletinUrl(form.get("bulletin_url") ?? "");
  if (bulletinUrl === undefined) return jsonError(400, "The bulletin link must be a web address (https://…).");
  if (bulletinUrl && bulletinUrl.length > 1000) return jsonError(400, "That bulletin link is too long.");

  const canon = await canonicalMakeModels(env.DB, make, models);
  const modelLabel = vehicleModelsLabel(canon.models);
  const modelsJson = JSON.stringify(canon.models);
  const actor = session.email || null;

  if (id === null) {
    const row = await env.DB.prepare(
      `INSERT INTO vehicle_issues
         (category, make, model, models, year_from, year_to, issue_type, issue, solution,
          bulletin, bulletin_url, youtube_links, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
      .bind(
        category, canon.make, modelLabel, modelsJson, yearFrom, yearTo, issueType, issue, solution,
        bulletin, bulletinUrl, linksJson, actor, actor
      )
      .first<{ id: number }>();
    return json({ ok: true, id: row?.id ?? null }, 201);
  }

  const res = await env.DB.prepare(
    `UPDATE vehicle_issues
        SET category = ?, make = ?, model = ?, models = ?, year_from = ?, year_to = ?, issue_type = ?,
            issue = ?, solution = ?, bulletin = ?, bulletin_url = ?, youtube_links = ?,
            updated_by = ?, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(
      category, canon.make, modelLabel, modelsJson, yearFrom, yearTo, issueType, issue, solution,
      bulletin, bulletinUrl, linksJson, actor, id
    )
    .run();
  if ((res.meta?.changes ?? 0) === 0) return jsonError(404, "That entry no longer exists. Reload the page.");
  return json({ ok: true, id });
}

/** Delete R2 objects best-effort: a leftover object costs storage, a thrown
 *  error here would cost the user their delete. */
async function deleteObjects(env: VehicleGuideEnv, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await env.R2_BUCKET.delete(keys);
  } catch (err) {
    console.error("[vehicle-guide] R2 delete failed (orphans left)", keys, err);
  }
}

/** POST /manage/api/vehicle-issues/delete — form field `id`. */
export async function handleDeleteVehicleIssue(
  request: Request,
  env: VehicleGuideEnv,
  session: Session
): Promise<Response> {
  const denied = gateWrite(request, session);
  if (denied) return denied;
  const form = await readForm(request);
  const id = Number(clean(form.get("id")));
  if (!Number.isInteger(id) || id <= 0) return jsonError(400, "That entry could not be identified. Reload the page.");

  const media = await env.DB.prepare(`SELECT r2_key FROM vehicle_issue_media WHERE issue_id = ?`)
    .bind(id)
    .all<{ r2_key: string }>();
  // Children first rather than trusting ON DELETE CASCADE to be enforced.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM vehicle_issue_media WHERE issue_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM vehicle_issues WHERE id = ?`).bind(id)
  ]);
  await deleteObjects(env, (media.results ?? []).map((m) => m.r2_key));
  return json({ ok: true });
}

function randomId(len: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/**
 * POST /manage/api/vehicle-issues/{id}/media — multipart, one `file` per call.
 * Called straight from the browser (not through a server action), so a 50 MB
 * video never passes through the apps/web Worker.
 */
export async function handleUploadVehicleMedia(
  request: Request,
  env: VehicleGuideEnv,
  session: Session,
  issueId: number
): Promise<Response> {
  const denied = gateWrite(request, session);
  if (denied) return denied;

  const issue = await env.DB.prepare(
    `SELECT id, (SELECT COUNT(*) FROM vehicle_issue_media WHERE issue_id = vehicle_issues.id) AS n
       FROM vehicle_issues WHERE id = ?`
  )
    .bind(issueId)
    .first<{ id: number; n: number }>();
  if (!issue) return jsonError(404, "That entry no longer exists. Reload the page.");
  if (issue.n >= MAX_MEDIA_PER_ISSUE) {
    return jsonError(409, `An entry can hold at most ${MAX_MEDIA_PER_ISSUE} photos and videos. Remove one first.`);
  }

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return jsonError(400, "The upload could not be read. Try again.");
  }
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return jsonError(400, "Choose a photo or video to upload.");

  const head = new Uint8Array(await file.slice(0, 4100).arrayBuffer());
  const sniffed = await fileTypeFromBuffer(head);
  const type = sniffed ? MEDIA_TYPES[sniffed.mime] : undefined;
  if (!sniffed || !type) {
    return jsonError(415, "Only photos (JPEG, PNG, WebP, HEIC) and videos (MP4, MOV, WebM) can be uploaded.");
  }
  const limit = type.kind === "video" ? VIDEO_MAX_BYTES : PHOTO_MAX_BYTES;
  if (file.size > limit) {
    return jsonError(413, `That ${type.kind} is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${limit / 1048576} MB.`);
  }

  let mime = sniffed.mime;
  let ext = type.ext;
  let body: ReadableStream | ArrayBuffer = file.stream();
  // HEIC photos become JPEG at ingest so every phone, not only iPhones, can
  // show them. Fall back to the original bytes if conversion fails.
  if (env.IMAGES && isHeicContentType(mime, file.name)) {
    try {
      const converted = await env.IMAGES.input(file.stream()).output({ format: "image/jpeg" });
      body = await converted.response().arrayBuffer();
      mime = "image/jpeg";
      ext = "jpg";
    } catch (err) {
      console.error("[vehicle-guide] HEIC->JPEG failed; storing original", err);
      body = file.stream();
    }
  }

  const key = `vehicle-guide/${issueId}/${randomId(12)}.${ext}`;
  const size = body instanceof ArrayBuffer ? body.byteLength : file.size;
  const originalFilename = file.name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 200) || null;
  try {
    await env.R2_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  } catch (err) {
    console.error("[vehicle-guide] R2 put failed", err);
    return jsonError(503, "Storage is unavailable right now. Try again in a minute.");
  }

  try {
    const row = await env.DB.prepare(
      `INSERT INTO vehicle_issue_media (issue_id, r2_key, kind, mime, size_bytes, original_filename, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
      .bind(issueId, key, type.kind, mime, size, originalFilename, session.email || null)
      .first<{ id: number }>();
    await env.DB.prepare(`UPDATE vehicle_issues SET updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(session.email || null, issueId)
      .run();
    return json({ ok: true, id: row?.id ?? null, kind: type.kind }, 201);
  } catch (err) {
    console.error("[vehicle-guide] media row insert failed; removing object", err);
    await deleteObjects(env, [key]);
    return jsonError(500, "The file uploaded but could not be saved. Try again.");
  }
}

/** POST /manage/api/vehicle-issues/media/{mediaId}/delete */
export async function handleDeleteVehicleMedia(
  request: Request,
  env: VehicleGuideEnv,
  session: Session,
  mediaId: number
): Promise<Response> {
  const denied = gateWrite(request, session);
  if (denied) return denied;
  const row = await env.DB.prepare(`DELETE FROM vehicle_issue_media WHERE id = ? RETURNING r2_key`)
    .bind(mediaId)
    .first<{ r2_key: string }>();
  if (!row) return jsonError(404, "That file is already gone. Reload the page.");
  await deleteObjects(env, [row.r2_key]);
  return json({ ok: true });
}

/* ============================================================
 * Media serving (shared by public + admin)
 * ============================================================ */

/**
 * Parse a single `bytes=` range. iOS Safari will not play a <video> at all
 * unless the server answers range requests with 206, so this is not an
 * optimisation -- without it videos simply never start on an iPhone.
 */
function parseRange(header: string, size: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return null;
  let start: number;
  let end: number;
  if (s === "") {
    const suffix = Number(e);
    if (suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

export async function serveVehicleMedia(
  request: Request,
  env: VehicleGuideEnv,
  mediaId: number,
  cacheControl: string
): Promise<Response> {
  const row = await env.DB.prepare(`SELECT r2_key, mime FROM vehicle_issue_media WHERE id = ?`)
    .bind(mediaId)
    .first<{ r2_key: string; mime: string }>();
  if (!row) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": row.mime,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff"
  });

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const meta = await env.R2_BUCKET.head(row.r2_key);
    if (!meta) return new Response("Not found", { status: 404 });
    const range = parseRange(rangeHeader, meta.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers });
    }
    const obj = await env.R2_BUCKET.get(row.r2_key, { range });
    if (!obj) return new Response("Not found", { status: 404 });
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
  }

  const obj = await env.R2_BUCKET.get(row.r2_key);
  if (!obj) return new Response("Not found", { status: 404 });
  headers.set("Content-Length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

/* ============================================================
 * Claim form lookup
 * ============================================================ */

/** One known vehicle issue, as the claim form shows it. No ids, no media. */
export interface VehicleIssueMatch {
  type_label: string;
  vehicle: string;
  years: string;
  issue: string;
  solution: string;
  bulletin: string | null;
  bulletin_url: string | null;
}

/** GET /claims-api/vehicle-issues/match?make=&model=&year= */
export async function handleMatchVehicleIssues(url: URL, env: VehicleGuideEnv): Promise<Response> {
  const make = clean(url.searchParams.get("make")).slice(0, 60);
  const model = clean(url.searchParams.get("model")).slice(0, 80);
  const yearRaw = Number(clean(url.searchParams.get("year")));
  const year = Number.isInteger(yearRaw) && yearRaw >= 1900 && yearRaw <= 2100 ? yearRaw : null;
  let matches: VehicleIssueMatch[] = [];
  if (make && model) {
    const vehicleIssues = (await listIssues(env.DB)).filter((i) => i.category === "vehicle");
    matches = matchVehicleIssues(vehicleIssues, { make, model, year }).map((i) => ({
      type_label: vehicleIssueTypeLabel(i.issue_type),
      vehicle: `${i.make} ${i.model}`,
      years: formatVehicleYears(i.year_from, i.year_to),
      issue: i.issue,
      solution: i.solution,
      bulletin: i.bulletin,
      bulletin_url: i.bulletin_url
    }));
  }
  return new Response(JSON.stringify({ matches }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex"
    }
  });
}

/* ============================================================
 * Public page
 * ============================================================ */

/**
 * Dispatch /claims/vehicles/{token}[/media/{id}]. `rest` is the path parts
 * after "claims/vehicles". Returns null when the path is not ours, so the
 * caller falls through to its normal 404.
 */
export async function handleVehicleGuidePublic(
  request: Request,
  env: VehicleGuideEnv,
  rest: string[]
): Promise<Response | null> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return null;
  const token = rest[0] ? decodeURIComponent(rest[0]) : "";
  if (!token || !tokenMatches(env, token)) return null;

  // The token is in the URL, so keep it out of Referer headers sent to
  // anything the page links to, and out of search indexes if it ever leaks.
  const privacy = {
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  };

  if (rest.length === 1) {
    const issues = await listIssues(env.DB);
    const html = renderVehicleGuidePage({
      issues,
      basePath: `/claims/vehicles/${encodeURIComponent(token)}`
    });
    return new Response(method === "HEAD" ? null : html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Fresh on every load: an entry added this morning should be on the
        // phone at the entrance this afternoon.
        "Cache-Control": "no-store",
        ...privacy
      }
    });
  }

  if (rest.length === 3 && rest[1] === "media") {
    const id = Number(rest[2]);
    if (!Number.isInteger(id) || id <= 0) return null;
    const resp = await serveVehicleMedia(request, env, id, "private, max-age=3600");
    for (const [k, v] of Object.entries(privacy)) resp.headers.set(k, v);
    return resp;
  }

  return null;
}
