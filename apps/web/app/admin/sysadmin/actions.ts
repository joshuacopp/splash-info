// Server actions for /admin/sysadmin. Briefs 7 + 18 + 19 + 24 + 26 + 27.
//
// Mutation surfaces, one per sysadmin-worker endpoint:
//   - createUserAction      → POST  /sysadmin/api/create-user
//   - setRoleAction         → POST  /sysadmin/api/set-role
//   - grantToolAction       → POST  /sysadmin/api/grant-tool
//   - revokeToolAction      → POST  /sysadmin/api/revoke-tool
//   - resetPasswordAction   → POST  /sysadmin/api/reset-password
//   - createLocationAction  → POST  /sysadmin/api/pricing-simple/create-location
//                             (Brief 24)
//   - updatePackageAction   → PATCH /sysadmin/api/pricing-simple/package
//                             (Brief 26)
//   - updateLocationAction  → PATCH /sysadmin/api/locations
//                             (Brief 27)
//
// Brief 19 — pattern flip:
//   Each action's signature is now (prevState, formData) => Promise<ActionResult>
//   to match React 19's useActionState contract. The actions return a typed
//   result instead of redirecting; the shared <ActionForm> wrapper at
//   apps/web/app/admin/_components/ActionForm.tsx dispatches via
//   useActionState, surfaces the result inline (success toast / error
//   banner), and calls router.refresh() on a fresh ok result so the page's
//   server-component data re-fetches. revalidatePath() invalidates Next's
//   route cache so the refresh sees the post-mutation state.
//
//   Why we don't redirect: see the same comment block in
//   apps/web/app/admin/damage/[id]/actions.ts. Redirects from server
//   actions don't reliably propagate as visible navigations on
//   OpenNext-Cloudflare-Workers, so we surface success/failure inline.
//
// Validation policy: don't pre-validate inputs in the action. The worker
// validates and returns 400 with a useful error message; surfacing that
// error inline is the right UX (single source of validation truth).

"use server";

import { revalidatePath } from "next/cache";
import { sysadminPatchJson, sysadminPostJson } from "./_lib/worker-fetch";
import type { ToolName, UserRole } from "@splash/types/auth";
import type { ActionResult } from "../_components/ActionForm";

const PAGE_PATH = "/admin/sysadmin";

function fieldString(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function fieldStringOrUndefined(
  formData: FormData,
  name: string
): string | undefined {
  const raw = String(formData.get(name) ?? "").trim();
  return raw.length > 0 ? raw : undefined;
}

/**
 * Brief 20 — read the worker's `changed: boolean` discriminator on
 * grant/revoke responses. Returns `false` (treat as no-op) if the worker
 * didn't include it, so callers fall back to the safer "no change" copy.
 */
function readChanged(body: unknown): boolean {
  if (
    body &&
    typeof body === "object" &&
    "changed" in body &&
    typeof (body as { changed?: unknown }).changed === "boolean"
  ) {
    return (body as { changed: boolean }).changed;
  }
  return false;
}

/* ============================================================
 * Create user
 * ============================================================ */

interface CreateUserBody {
  email: string;
  password: string;
  role?: UserRole;
  /** Brief 18 — forwarded only when role === "location_admin". */
  location_code?: string;
  tools?: string[];
}

export async function createUserAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const email = fieldString(formData, "email");
  const password = fieldString(formData, "password");
  const roleRaw = fieldString(formData, "role");
  const locationCode = fieldStringOrUndefined(formData, "location_code");
  // FormData.getAll returns FormDataEntryValue[]; coerce to string[].
  const tools = formData
    .getAll("tools")
    .map((v) => (typeof v === "string" ? v : ""))
    .filter((v) => v.length > 0);

  const body: CreateUserBody = { email, password };
  if (roleRaw.length > 0) {
    body.role = roleRaw as UserRole;
  }
  if (body.role === "location_admin" && locationCode !== undefined) {
    body.location_code = locationCode;
  }
  if (tools.length > 0) {
    body.tools = tools;
  }

  const result = await sysadminPostJson("/sysadmin/api/create-user", body);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Worker returns { ok: true, user_id, email }. Surface the email so the
  // success banner is intelligible.
  const respEmail =
    result.body &&
    typeof result.body === "object" &&
    "email" in result.body &&
    typeof (result.body as { email?: unknown }).email === "string"
      ? (result.body as { email: string }).email
      : email;

  revalidatePath(PAGE_PATH);
  return { ok: true, message: `User created: ${respEmail}` };
}

/* ============================================================
 * Set role
 * ============================================================ */

interface SetRoleBody {
  user_id: string;
  /** null clears the role (worker treats missing/null as clear). */
  role: UserRole | null;
  /** Only included for role === "location_admin". */
  location_code?: string;
}

export async function setRoleAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const userId = fieldString(formData, "user_id");
  const roleRaw = fieldString(formData, "role");
  const locationCode = fieldStringOrUndefined(formData, "location_code");

  const role: UserRole | null = roleRaw.length === 0 ? null : (roleRaw as UserRole);

  const body: SetRoleBody = { user_id: userId, role };
  if (role === "location_admin" && locationCode !== undefined) {
    body.location_code = locationCode;
  }

  const result = await sysadminPostJson("/sysadmin/api/set-role", body);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(PAGE_PATH);
  return { ok: true, message: "Role updated" };
}

/* ============================================================
 * Grant tool
 * ============================================================ */

interface GrantToolBody {
  user_id: string;
  tool: ToolName;
}

export async function grantToolAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const userId = fieldString(formData, "user_id");
  const tool = fieldString(formData, "tool");

  const body: GrantToolBody = {
    user_id: userId,
    tool: tool as ToolName
  };

  const result = await sysadminPostJson("/sysadmin/api/grant-tool", body);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Brief 20 — sysadmin worker now returns { ok, changed }. Surface the
  // distinction in the message so the operator can tell a real grant from
  // a no-op (the user already had the tool). Visual treatment stays green
  // either way per brief — the inline message text carries the nuance.
  const changed = readChanged(result.body);
  revalidatePath(PAGE_PATH);
  return {
    ok: true,
    message: changed
      ? `Granted ${tool}`
      : `${tool} was already granted (no change)`
  };
}

/* ============================================================
 * Revoke tool
 * ============================================================ */

export async function revokeToolAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const userId = fieldString(formData, "user_id");
  const tool = fieldString(formData, "tool");

  const body: GrantToolBody = {
    user_id: userId,
    tool: tool as ToolName
  };

  const result = await sysadminPostJson("/sysadmin/api/revoke-tool", body);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Brief 20 — see comment on grantToolAction.
  const changed = readChanged(result.body);
  revalidatePath(PAGE_PATH);
  return {
    ok: true,
    message: changed
      ? `Revoked ${tool}`
      : `${tool} wasn't granted (no change)`
  };
}

/* ============================================================
 * Reset password
 * ============================================================ */

interface ResetPasswordBody {
  user_id: string;
  new_password: string;
}

export async function resetPasswordAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const userId = fieldString(formData, "user_id");
  const newPassword = fieldString(formData, "new_password");

  const body: ResetPasswordBody = {
    user_id: userId,
    new_password: newPassword
  };

  const result = await sysadminPostJson("/sysadmin/api/reset-password", body);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(PAGE_PATH);
  return { ok: true, message: "Password reset" };
}

/* ============================================================
 * Create location (Brief 24)
 *
 * The form encodes one row per standard package as a flat set of
 * indexed fields:
 *   pkg_<index>_include   ("on" when checkbox is checked)
 *   pkg_<index>_pkg       (string — read-only display name in the form)
 *   pkg_<index>_pkg_dollar
 *   pkg_<index>_single
 *   pkg_<index>_flash2
 *   pkg_<index>_flash5
 *   pkg_<index>_sort      (optional positive integer)
 *
 * v1 supports only the 7 standard package names baked into the UI; any
 * row whose include checkbox is unchecked is silently dropped. The
 * action filters and maps these into the worker's CreateLocationBody
 * shape with a literal "pkg$" key (CLAUDE.md critical constraint #2).
 * ============================================================ */

interface CreateLocationPackage {
  pkg: string;
  /** Literal column name — see CLAUDE.md constraint on `pkg$`. */
  "pkg$": number;
  single: number;
  flash2: number;
  flash5: number;
  sort?: number | null;
}

interface CreateLocationBody {
  location_pretty: string;
  location_code: string;
  site?: string | null;
  address?: string | null;
  area_manager?: string | null;
  regional_manager?: string | null;
  site_email?: string | null;
  am_email?: string | null;
  rm_email?: string | null;
  packages: CreateLocationPackage[];
}

/** Standard package list — must stay in sync with AddLocationCard's defaults. */
const STANDARD_PACKAGES = [
  "bubble_bath",
  "ultra_bath",
  "bath",
  "express",
  "ext_exterior",
  "extreme",
  "works"
] as const;

function fieldNumber(formData: FormData, name: string): number {
  const raw = String(formData.get(name) ?? "").trim();
  if (raw.length === 0) return NaN;
  return Number(raw);
}

function fieldOptionalNullable(
  formData: FormData,
  name: string
): string | null {
  const raw = String(formData.get(name) ?? "").trim();
  return raw.length > 0 ? raw : null;
}

export async function createLocationAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const locationPretty = fieldString(formData, "location_pretty");
  const locationCode = fieldString(formData, "location_code");

  const packages: CreateLocationPackage[] = [];
  for (let i = 0; i < STANDARD_PACKAGES.length; i++) {
    const include = formData.get(`pkg_${i}_include`);
    if (include == null) continue;

    const pkg = fieldString(formData, `pkg_${i}_pkg`);
    if (pkg.length === 0) continue;

    const pkgDollar = fieldNumber(formData, `pkg_${i}_pkg_dollar`);
    const single = fieldNumber(formData, `pkg_${i}_single`);
    const flash2 = fieldNumber(formData, `pkg_${i}_flash2`);
    const flash5 = fieldNumber(formData, `pkg_${i}_flash5`);

    const sortRaw = String(formData.get(`pkg_${i}_sort`) ?? "").trim();
    const sort = sortRaw.length > 0 ? Number(sortRaw) : null;

    packages.push({
      pkg,
      "pkg$": pkgDollar,
      single,
      flash2,
      flash5,
      sort
    });
  }

  const body: CreateLocationBody = {
    location_pretty: locationPretty,
    location_code: locationCode,
    packages
  };

  const site = fieldOptionalNullable(formData, "site");
  const address = fieldOptionalNullable(formData, "address");
  const areaManager = fieldOptionalNullable(formData, "area_manager");
  const regionalManager = fieldOptionalNullable(formData, "regional_manager");
  const siteEmail = fieldOptionalNullable(formData, "site_email");
  const amEmail = fieldOptionalNullable(formData, "am_email");
  const rmEmail = fieldOptionalNullable(formData, "rm_email");

  if (site !== null) body.site = site;
  if (address !== null) body.address = address;
  if (areaManager !== null) body.area_manager = areaManager;
  if (regionalManager !== null) body.regional_manager = regionalManager;
  if (siteEmail !== null) body.site_email = siteEmail;
  if (amEmail !== null) body.am_email = amEmail;
  if (rmEmail !== null) body.rm_email = rmEmail;

  const result = await sysadminPostJson(
    "/sysadmin/api/pricing-simple/create-location",
    body
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Worker returns { ok, location_code, location_id, site_number, package_count }.
  let respLocationCode = locationCode;
  let respPackageCount = packages.length;
  let respSiteNumber: number | null = null;
  if (result.body && typeof result.body === "object") {
    const r = result.body as {
      location_code?: unknown;
      package_count?: unknown;
      site_number?: unknown;
    };
    if (typeof r.location_code === "string" && r.location_code.length > 0) {
      respLocationCode = r.location_code;
    }
    if (typeof r.package_count === "number") {
      respPackageCount = r.package_count;
    }
    if (typeof r.site_number === "number") {
      respSiteNumber = r.site_number;
    }
  }

  revalidatePath(PAGE_PATH);
  const sitePart = respSiteNumber !== null ? `#${respSiteNumber}, ` : "";
  return {
    ok: true,
    message: `Location created: ${respLocationCode} (${sitePart}${respPackageCount} packages)`
  };
}

/* ============================================================
 * Update package (Brief 26)
 *
 * Reads form fields submitted by UpdatePackageCard and posts a partial
 * PATCH body to /sysadmin/api/pricing-simple/package. Composite-PK
 * lookup uses pkg_original (the pkg name at selection time); the form's
 * editable `pkg` input maps to `pkg_new` so the worker can rename the
 * row when the operator changes it.
 *
 * Numeric fields:
 *   - pkg_dollar (required) -> "pkg$" (literal column name, see CLAUDE.md
 *     critical constraint #2). Always included.
 *   - single / flash2 / flash5 / sort -> only included when the form
 *     field is non-empty; an empty string maps to null in the JSON body.
 *
 * Denormalized fields (am_email, etc.) are NEVER included — the worker
 * also rejects them with 400 as defense-in-depth, but the action skips
 * them at the form level too. The UI doesn't render inputs for them.
 * ============================================================ */

interface UpdatePackageBody {
  location_code: string;
  pkg: string;
  pkg_new?: string;
  "pkg$"?: number;
  single?: number | null;
  flash2?: number | null;
  flash5?: number | null;
  sort?: number | null;
  pricing?: string;
  location_pretty?: string;
}

function fieldNumberOrNull(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "").trim();
  if (raw.length === 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function updatePackageAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const locationCode = fieldString(formData, "location_code");
  const pkgOriginal = fieldString(formData, "pkg_original");
  const pkgEditable = fieldString(formData, "pkg");
  const locationPretty = fieldString(formData, "location_pretty");
  const pricing = fieldString(formData, "pricing");
  const pkgDollarRaw = String(formData.get("pkg_dollar") ?? "").trim();

  if (locationCode.length === 0) {
    return { ok: false, error: "Missing location_code (no row selected)." };
  }
  if (pkgOriginal.length === 0) {
    return { ok: false, error: "Missing pkg_original (no row selected)." };
  }
  if (pkgEditable.length === 0) {
    return { ok: false, error: "Package name cannot be empty." };
  }
  if (pkgDollarRaw.length === 0) {
    return { ok: false, error: "pkg$ is required." };
  }

  const pkgDollar = Number(pkgDollarRaw);
  if (!Number.isFinite(pkgDollar)) {
    return { ok: false, error: "pkg$ must be a number." };
  }

  const body: UpdatePackageBody = {
    location_code: locationCode,
    pkg: pkgOriginal,
    "pkg$": pkgDollar
  };

  if (pkgEditable !== pkgOriginal) {
    body.pkg_new = pkgEditable;
  }

  // single / flash2 / flash5 / sort: empty -> null in payload (worker
  // accepts null for nullable columns).
  body.single = fieldNumberOrNull(formData, "single");
  body.flash2 = fieldNumberOrNull(formData, "flash2");
  body.flash5 = fieldNumberOrNull(formData, "flash5");

  const sortRaw = String(formData.get("sort") ?? "").trim();
  if (sortRaw.length === 0) {
    body.sort = null;
  } else {
    const sortNum = Number(sortRaw);
    if (!Number.isInteger(sortNum) || sortNum < 1) {
      return { ok: false, error: "sort must be a positive integer." };
    }
    body.sort = sortNum;
  }

  if (pricing.length > 0) body.pricing = pricing;
  if (locationPretty.length > 0) body.location_pretty = locationPretty;

  const result = await sysadminPatchJson(
    "/sysadmin/api/pricing-simple/package",
    body
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Worker returns { ok, location_code, pkg, updated_at }.
  let respLocationCode = locationCode;
  let respPkg = body.pkg_new ?? pkgOriginal;
  if (result.body && typeof result.body === "object") {
    const r = result.body as { location_code?: unknown; pkg?: unknown };
    if (typeof r.location_code === "string" && r.location_code.length > 0) {
      respLocationCode = r.location_code;
    }
    if (typeof r.pkg === "string" && r.pkg.length > 0) {
      respPkg = r.pkg;
    }
  }

  revalidatePath(PAGE_PATH);
  return {
    ok: true,
    message: `Updated ${respLocationCode}/${respPkg}`
  };
}

/* ============================================================
 * Update location (Brief 27)
 *
 * Reads form fields submitted by UpdateLocationCard and posts a partial
 * PATCH body to /sysadmin/api/locations. The selector arrives in two
 * hidden inputs:
 *   - selector_kind  ("id" or "site_number")
 *   - selector_value (the actual id or site_number from the picker)
 *
 * Editable fields: site, location, area_manager, regional_manager,
 *   am_email, rm_email, site_email, hrt_email, rm_group.
 *
 * Empty form values map to null (clearing the column). The worker
 * email-validates the email fields and rejects auto-managed columns
 * (created_at / updated_at) as defense in depth — the action only
 * forwards the editable set and the chosen selector.
 *
 * Two DB triggers cascade outward from a successful PATCH:
 *   - locations -> pricing_simple (denormalized field sync)
 *   - pricing_simple -> user_permissions (email-driven permissions)
 * The action surfaces this in the success message so the operator
 * doesn't wonder why "just" editing locations granted permissions.
 * ============================================================ */

interface UpdateLocationBody {
  id?: number;
  site_number?: number;
  site?: string | null;
  location?: string | null;
  area_manager?: string | null;
  regional_manager?: string | null;
  am_email?: string | null;
  rm_email?: string | null;
  site_email?: string | null;
  hrt_email?: string | null;
  rm_group?: string | null;
}

const LOCATION_EDITABLE_FORM_FIELDS = [
  "site",
  "location",
  "area_manager",
  "regional_manager",
  "am_email",
  "rm_email",
  "site_email",
  "hrt_email",
  "rm_group"
] as const;

function fieldStringOrNull(formData: FormData, name: string): string | null {
  const raw = String(formData.get(name) ?? "").trim();
  return raw.length > 0 ? raw : null;
}

export async function updateLocationAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const selectorKind = fieldString(formData, "selector_kind");
  const selectorValue = fieldString(formData, "selector_value");

  if (selectorKind !== "id" && selectorKind !== "site_number") {
    return {
      ok: false,
      error: "Missing selector — pick a location above."
    };
  }
  if (selectorValue.length === 0) {
    return { ok: false, error: "Missing selector value (no row selected)." };
  }

  const selectorNum = Number(selectorValue);
  if (!Number.isFinite(selectorNum)) {
    return { ok: false, error: `${selectorKind} must be a number.` };
  }

  const body: UpdateLocationBody = {};
  if (selectorKind === "id") {
    body.id = selectorNum;
  } else {
    if (!Number.isInteger(selectorNum)) {
      return { ok: false, error: "site_number must be an integer." };
    }
    body.site_number = selectorNum;
  }

  // Forward only the editable fields the form rendered. Empty form
  // values map to null (clear the column).
  for (const field of LOCATION_EDITABLE_FORM_FIELDS) {
    const v = fieldStringOrNull(formData, field);
    (body as Record<string, unknown>)[field] = v;
  }

  const result = await sysadminPatchJson("/sysadmin/api/locations", body);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(PAGE_PATH);
  return {
    ok: true,
    message: `Updated location #${selectorValue}. Triggers cascaded to pricing_simple + user_permissions.`
  };
}
