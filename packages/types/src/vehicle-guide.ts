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
