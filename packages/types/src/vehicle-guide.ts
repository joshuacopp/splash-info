// Vehicle Guide — known problem vehicles. Stored in the damage D1 database;
// written by damage RM and above from /admin/damage/vehicles; read by site
// staff on the public token page served by damage-worker at
// /claims/vehicles/{token}.
//
// TWO CATEGORIES (migrations/0004):
//   loading -- how to handle the car in the tunnel (getting into neutral,
//              staying out of park, safety systems that fight the conveyor).
//   vehicle -- parts known to break on that car regardless of the wash
//              (e.g. Kia/Hyundai shark-fin antennas with a service bulletin
//              about how they are attached). These also surface on damage
//              claims whose vehicle matches -- see matchVehicleIssues.
//
// YEARS ARE A RANGE. Most issues span a model generation, so one entry covers
// year_from..year_to. year_to NULL means "and newer" -- the entry is still
// current and nobody has to remember to bump it every January.
//
// MODELS ARE A LIST. One bulletin often covers several models of a make, so an
// entry holds every model it applies to; an EMPTY list means every model of
// that make.

export const VEHICLE_ISSUE_CATEGORIES = [
  { value: "loading", label: "Loading issue", plural: "Loading issues" },
  { value: "vehicle", label: "Vehicle issue", plural: "Vehicle issues" }
] as const;

export type VehicleIssueCategory = (typeof VEHICLE_ISSUE_CATEGORIES)[number]["value"];

export function isVehicleIssueCategory(v: string): v is VehicleIssueCategory {
  return VEHICLE_ISSUE_CATEGORIES.some((c) => c.value === v);
}

export function vehicleIssueCategoryLabel(v: string): string {
  return VEHICLE_ISSUE_CATEGORIES.find((c) => c.value === v)?.label ?? v;
}

/** The fixed list of issue types, each belonging to one category. Adding one
 *  is a change here only: the worker validates against this list and every UI
 *  renders from it. Values are stored, so never rename one -- change the label. */
export const VEHICLE_ISSUE_TYPES = [
  { value: "neutral", label: "Getting into neutral", category: "loading" },
  { value: "park", label: "Staying out of park", category: "loading" },
  { value: "safety", label: "Safety system", category: "loading" },
  { value: "other", label: "Other", category: "loading" },
  { value: "antenna", label: "Antenna", category: "vehicle" },
  { value: "mirror", label: "Mirror", category: "vehicle" },
  { value: "trim", label: "Trim", category: "vehicle" },
  { value: "glass", label: "Glass", category: "vehicle" },
  { value: "wiper", label: "Wiper", category: "vehicle" },
  { value: "vehicle_other", label: "Other", category: "vehicle" }
] as const;

export function vehicleIssueTypesFor(category: VehicleIssueCategory) {
  return VEHICLE_ISSUE_TYPES.filter((t) => t.category === category);
}

export function vehicleIssueTypeCategory(type: string): VehicleIssueCategory | null {
  return VEHICLE_ISSUE_TYPES.find((t) => t.value === type)?.category ?? null;
}

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
  category: VehicleIssueCategory;
  make: string;
  /** Every model the entry covers, in the order typed. EMPTY = all models of
   *  the make. */
  models: string[];
  /** Display label: the models joined with ", ", or "All models". Stored in
   *  vehicle_issues.model so sorting and older readers keep working. */
  model: string;
  year_from: number;
  /** NULL = "and newer". */
  year_to: number | null;
  issue_type: VehicleIssueType;
  issue: string;
  solution: string;
  /** Service bulletin / recall reference (e.g. "TSB 23-BE-004H"), or null. */
  bulletin: string | null;
  /** Link to the bulletin (https only), or null. */
  bulletin_url: string | null;
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

export const ALL_MODELS_LABEL = "All models";

/** vehicle_issues.model for a list of models. */
export function vehicleModelsLabel(models: readonly string[]): string {
  return models.length ? models.join(", ") : ALL_MODELS_LABEL;
}

/* ============================================================
 * Matching a vehicle (damage claims)
 * ============================================================ */

/** Common short forms, so a claim typed "Chevy" finds a "Chevrolet" entry. */
const MAKE_ALIASES: Record<string, string> = {
  chevy: "chevrolet",
  vw: "volkswagen",
  mercedesbenz: "mercedes",
  benz: "mercedes",
  mb: "mercedes",
  rangerover: "landrover"
};

/** Lower case, letters and digits only: "CR-V" and "crv" are the same car. */
function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function makeKey(s: string): string {
  const c = compact(s);
  return MAKE_ALIASES[c] ?? c;
}

/**
 * Entries that apply to a given vehicle. Make must match (aliases allowed).
 * A model matches when the vehicle's model STARTS WITH the entry's model once
 * both are compacted, so a claim for a "Santa Fe Sport" or "Telluride SX"
 * finds the "Santa Fe" / "Telluride" entry; a repeated make ("Kia Telluride")
 * is ignored. A null year (older claims) skips
 * the year check rather than hiding a known issue. Open-ended entries run
 * through `openYear`.
 */
export function matchVehicleIssues<T extends Pick<VehicleIssue, "make" | "models" | "year_from" | "year_to">>(
  issues: readonly T[],
  vehicle: { make: string | null; model: string | null; year: number | null },
  openYear: number = new Date().getUTCFullYear() + 1
): T[] {
  const mk = makeKey(vehicle.make ?? "");
  if (!mk) return [];
  // "Kia Telluride" typed into the model box: drop the repeated make.
  let mo = compact(vehicle.model ?? "");
  const typedMake = compact(vehicle.make ?? "");
  if (typedMake && mo.startsWith(typedMake) && mo.length > typedMake.length) mo = mo.slice(typedMake.length);
  return issues.filter((i) => {
    if (makeKey(i.make) !== mk) return false;
    if (i.models.length && !(mo && i.models.some((m) => compact(m) && mo.startsWith(compact(m))))) return false;
    if (vehicle.year !== null && (vehicle.year < i.year_from || vehicle.year > (i.year_to ?? openYear))) return false;
    return true;
  });
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
