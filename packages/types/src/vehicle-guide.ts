// Vehicle Guide — known problem vehicles and how to handle them in the tunnel
// (getting into neutral, staying out of park, safety systems that fight the
// conveyor). Stored in the damage D1 database; written by damage RM and above
// from /admin/damage/vehicles; read by site staff on the public token page
// served by damage-worker at /claims/vehicles/{token}.
//
// YEARS ARE A RANGE. Most issues span a model generation, so one entry covers
// year_from..year_to. year_to NULL means "and newer" -- the entry is still
// current and nobody has to remember to bump it every January.

/** The fixed list of issue types. Adding one is a change here only: the worker
 *  validates against this list and both UIs render from it. */
export const VEHICLE_ISSUE_TYPES = [
  { value: "neutral", label: "Getting into neutral" },
  { value: "park", label: "Staying out of park" },
  { value: "safety", label: "Safety system" },
  { value: "other", label: "Other" }
] as const;

export type VehicleIssueType = (typeof VEHICLE_ISSUE_TYPES)[number]["value"];

export function isVehicleIssueType(v: string): v is VehicleIssueType {
  return VEHICLE_ISSUE_TYPES.some((t) => t.value === v);
}

export function vehicleIssueTypeLabel(v: string): string {
  return VEHICLE_ISSUE_TYPES.find((t) => t.value === v)?.label ?? v;
}

export interface VehicleIssueMedia {
  id: number;
  issue_id: number;
  kind: "photo" | "video";
  mime: string;
  size_bytes: number;
  original_filename: string | null;
  created_by: string | null;
  created_at: string;
}

export interface VehicleIssue {
  id: number;
  make: string;
  model: string;
  year_from: number;
  /** NULL = "and newer". */
  year_to: number | null;
  issue_type: VehicleIssueType;
  issue: string;
  solution: string;
  /** Canonical YouTube watch URLs (see parseYouTubeUrl), in display order.
   *  Empty when none. Stored as a JSON array in vehicle_issues.youtube_links. */
  youtube_links: string[];
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  media: VehicleIssueMedia[];
}

/** GET /manage/api/vehicle-issues */
export interface VehicleIssuesResponse {
  issues: VehicleIssue[];
  /** Whether the caller may add / edit / delete (damage RM and above). */
  can_edit: boolean;
  /** Path of the public page, or null when the token secret is unbound. Only
   *  returned to callers who can edit -- they are the ones who hand it out. */
  public_path: string | null;
}

/** "2017–2022", "2019+", or "2015" for a single year. */
export function formatVehicleYears(from: number, to: number | null): string {
  if (to === null) return `${from}+`;
  if (to === from) return String(from);
  return `${from}–${to}`;
}

/* ============================================================
 * YouTube links
 * ============================================================ */

/** Per entry. A few walkthroughs is useful; more turns the card into a feed. */
export const MAX_YOUTUBE_LINKS = 4;

export interface YouTubeRef {
  /** The 11-character video id. */
  id: string;
  /** Start offset in seconds, 0 when none. */
  start: number;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be"
]);

/** "90", "90s", "1m30s", "1h2m3s" -> seconds. Anything else -> 0. */
function parseStart(raw: string | null): number {
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Accepts every link shape people actually paste -- watch?v=, youtu.be/,
 * /shorts/, /embed/, /live/, with or without "https://" -- and returns the
 * video id plus any start time. Null for anything that is not a YouTube
 * video, so the worker can refuse it with a clear message instead of
 * embedding an arbitrary URL.
 */
export function parseYouTubeUrl(input: string): YouTubeRef | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") id = parts[0] ?? null;
  else if (parts[0] === "watch") id = url.searchParams.get("v");
  else if (parts[0] && ["shorts", "embed", "live", "v"].includes(parts[0])) id = parts[1] ?? null;
  if (!id || !YT_ID.test(id)) return null;

  return { id, start: parseStart(url.searchParams.get("t") ?? url.searchParams.get("start")) };
}

/** The one stored form: https://www.youtube.com/watch?v={id}[&t={n}s]. */
export function canonicalYouTubeUrl(ref: YouTubeRef): string {
  return `https://www.youtube.com/watch?v=${ref.id}${ref.start ? `&t=${ref.start}s` : ""}`;
}

/** Privacy-enhanced embed (no YouTube cookies until the video is played). */
export function youTubeEmbedUrl(ref: YouTubeRef): string {
  return `https://www.youtube-nocookie.com/embed/${ref.id}?rel=0&playsinline=1${ref.start ? `&start=${ref.start}` : ""}`;
}
