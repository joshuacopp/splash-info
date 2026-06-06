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
 *
 * Brief 149 — when `claims` is among the tool grants AND the operator
 * picked a dc_role on the inline CreateUserToolsAndDcRole island, chase
 * the create-user response with a second POST to
 * /sysadmin/api/users/{newUserId}/dc-role so the new user lands on
 * /admin/damage without a separate Set-DC-Role pass.
 *
 * The two writes target different table domains (Create User owns
 * auth.users + user_permissions + user_tool_access; Set DC Role owns
 * damage_claim_user_roles + damage_claim_user_locations), so chaining
 * apps/web-side keeps both worker handlers scoped and the audit log
 * records both `create_user` and `set_dc_role` rows naturally (no
 * worker change required).
 *
 * If the second POST fails after Create succeeded, the form surfaces a
 * partial-success message rather than reporting a fresh failure — the
 * user IS created and the half-state is recoverable via the standalone
 * Set DC Role card. An orphaned half-created auth.users row would not
 * be recoverable through the UI.
 * ============================================================ */

// DcRoleValue is declared once at module scope in the Set DC Role section
// below; reused here via TS's whole-file type resolution.

const VALID_DC_ROLES_CLIENT: ReadonlySet<DcRoleValue> = new Set([
  "gm",
  "rm",
  "admin",
  "super_admin"
]);

interface CreateUserBody {
  email: string;
  password: string;
  role?: UserRole;
  /** Brief 18 — forwarded only when role === "location_admin". */
  location_code?: string;
  tools?: string[];
}

interface SetDcRoleBodyForChain {
  role: DcRoleValue;
  location_codes: string[];
}

function readUserIdFromBody(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "user_id" in body &&
    typeof (body as { user_id?: unknown }).user_id === "string"
  ) {
    return (body as { user_id: string }).user_id;
  }
  return null;
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
  const dcRoleRaw = fieldString(formData, "dc_role");

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
  const newUserId = readUserIdFromBody(result.body);

  // Brief 149 — chase with the dc-role write when claims is granted AND
  // the operator picked a dc_role. The island enforces dc_role-required
  // when claims is checked via HTML5 `required`; this branch is a no-op
  // for non-claims users.
  const includesClaims = tools.includes("claims");
  if (
    includesClaims &&
    dcRoleRaw.length > 0 &&
    VALID_DC_ROLES_CLIENT.has(dcRoleRaw as DcRoleValue) &&
    newUserId
  ) {
    const dcRole = dcRoleRaw as DcRoleValue;
    // dc_locations mirrors the existing Location field for gm/rm; admin
    // and super_admin bypass scoping per Brief 61's worker contract.
    const locationCodes: string[] =
      (dcRole === "gm" || dcRole === "rm") && locationCode !== undefined
        ? [locationCode]
        : [];

    const dcBody: SetDcRoleBodyForChain = {
      role: dcRole,
      location_codes: locationCodes
    };

    const dcResult = await sysadminPostJson(
      `/sysadmin/api/users/${encodeURIComponent(newUserId)}/dc-role`,
      dcBody
    );

    if (!dcResult.ok) {
      // Partial-success: user exists, DC role write failed. Don't roll
      // back — a missing dc_role is recoverable via the standalone Set
      // DC Role card; an orphaned auth.users row is not.
      revalidatePath(PAGE_PATH);
      return {
        ok: true,
        message: `User created: ${respEmail} — but DC role write failed (${dcResult.error}). Set it manually via the Set DC Role card.`
      };
    }
  }

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
 * Set DC Role (Brief 61)
 *
 * Writes the dc_role + dc_locations pair via
 * POST /sysadmin/api/users/{userId}/dc-role. Distinct from setRoleAction:
 * dc_role lives on damage_claim_user_roles + damage_claim_user_locations,
 * not user_permissions.
 *
 * Body shape:
 *   { role: "gm" | "rm" | "admin" | "super_admin" | null,
 *     location_codes: string[] }
 * For role super_admin/admin/null, location_codes is included as an empty
 * array — the worker ignores it for those roles. For gm/rm the worker
 * requires a non-empty array.
 * ============================================================ */

type DcRoleValue = "gm" | "rm" | "admin" | "super_admin";

interface SetDcRoleBody {
  role: DcRoleValue | null;
  location_codes: string[];
}

export async function setDcRoleAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const userId = fieldString(formData, "user_id");
  if (userId.length === 0) {
    return { ok: false, error: "Pick a user first." };
  }

  const roleRaw = fieldString(formData, "role");
  const role: DcRoleValue | null =
    roleRaw.length === 0 ? null : (roleRaw as DcRoleValue);

  // formData.getAll returns FormDataEntryValue[]; coerce to string[].
  const locationCodes = formData
    .getAll("location_codes")
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);

  const body: SetDcRoleBody = {
    role,
    location_codes: locationCodes
  };

  const result = await sysadminPostJson(
    `/sysadmin/api/users/${encodeURIComponent(userId)}/dc-role`,
    body
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(PAGE_PATH);
  if (role === null) {
    return { ok: true, message: "Cleared DC role + locations" };
  }
  if (role === "gm" || role === "rm") {
    const count = locationCodes.length;
    return {
      ok: true,
      message: `Set DC role ${role} on ${count} location${count === 1 ? "" : "s"}`
    };
  }
  return { ok: true, message: `Set DC role ${role}` };
}

/* ============================================================
 * Set Promo Role (Brief 159)
 *
 * Writes promo_role via POST /sysadmin/api/users/{userId}/promo-role.
 * promo_user_roles is a single-scalar table — no companion locations
 * table, so unlike setDcRoleAction this action takes only the role.
 *
 * Body shape:
 *   { role: "super_admin" | "it" | "marketing" | "ops" | null }
 * role=null clears the row (revokes all /admin/promotions access).
 *
 * Cookie-refresh constraint: the new promo_role doesn't surface on
 * Session.promoRole until the affected user signs out and back in.
 * Same as Set DC Role / Set Role — the session is sourced from the
 * access-token cookie set at login. The success-message copy makes
 * this explicit so the operator doesn't wonder why the affected
 * user's tile visibility hasn't updated yet.
 * ============================================================ */

type PromoRoleValue = "super_admin" | "it" | "marketing" | "ops";

interface SetPromoRoleBody {
  role: PromoRoleValue | null;
}

export async function setPromoRoleAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const userId = fieldString(formData, "user_id");
  if (userId.length === 0) {
    return { ok: false, error: "Pick a user first." };
  }

  const roleRaw = fieldString(formData, "role");
  const role: PromoRoleValue | null =
    roleRaw.length === 0 ? null : (roleRaw as PromoRoleValue);

  const body: SetPromoRoleBody = { role };

  const result = await sysadminPostJson(
    `/sysadmin/api/users/${encodeURIComponent(userId)}/promo-role`,
    body
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(PAGE_PATH);
  if (role === null) {
    return {
      ok: true,
      message:
        "Cleared promo role. The user must sign out and back in to see the change take effect."
    };
  }
  return {
    ok: true,
    message: `Set promo role ${role}. The user must sign out and back in to see the change take effect.`
  };
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
 * Update packages bulk (Brief 36)
 *
 * Multi-select pricing-only edit at one location. Reads form fields
 * shaped as bulk_pkg_<index>_(pkg|selected|pkg_dollar|single|sort)
 * plus a single hidden `location_code`. Builds the worker's
 * UpdatePackagesBulkBody and PATCHes
 * /sysadmin/api/pricing-simple/packages-bulk.
 *
 * Encoding rules:
 *   - bulk_pkg_<i>_selected presence indicates the row is in scope.
 *   - For selected rows, pkg_dollar is REQUIRED in the payload because
 *     the column is NOT NULL on pricing_simple. Empty -> validation
 *     error returned to the operator.
 *   - single / sort: empty -> null in the payload (clears the column).
 *   - Cap of 20 selected rows enforced before round-tripping (matches
 *     worker's BULK_MAX_UPDATES). Friendlier UX than letting the worker
 *     bounce a 21-row request.
 * ============================================================ */

interface UpdatePackagesBulkEntry {
  pkg: string;
  "pkg$"?: number;
  single?: number | null;
  sort?: number | null;
}

interface UpdatePackagesBulkBody {
  location_code: string;
  updates: UpdatePackagesBulkEntry[];
}

const BULK_PACKAGES_MAX_SELECTED = 20;

export async function updatePackagesBulkAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const locationCode = fieldString(formData, "location_code");
  if (locationCode.length === 0) {
    return { ok: false, error: "Pick a location first." };
  }

  // The card encodes one "row" per package at the location, indexed by
  // its position in the fetched list. We don't know the count up front
  // server-side; iterate every selected key and parse its index.
  const selectedIndices: number[] = [];
  for (const [key] of formData.entries()) {
    const m = /^bulk_pkg_(\d+)_selected$/.exec(key);
    if (m && m[1]) {
      const idx = Number(m[1]);
      if (Number.isInteger(idx) && idx >= 0) {
        selectedIndices.push(idx);
      }
    }
  }

  if (selectedIndices.length === 0) {
    return { ok: false, error: "Select at least one package to update." };
  }
  if (selectedIndices.length > BULK_PACKAGES_MAX_SELECTED) {
    return {
      ok: false,
      error: `Select at most ${BULK_PACKAGES_MAX_SELECTED} packages per save.`
    };
  }
  selectedIndices.sort((a, b) => a - b);

  const updates: UpdatePackagesBulkEntry[] = [];
  for (const idx of selectedIndices) {
    const pkg = fieldString(formData, `bulk_pkg_${idx}_pkg`);
    if (pkg.length === 0) {
      return {
        ok: false,
        error: `Row ${idx} is missing its package name (form encoding bug).`
      };
    }

    const pkgDollarRaw = String(formData.get(`bulk_pkg_${idx}_pkg_dollar`) ?? "").trim();
    if (pkgDollarRaw.length === 0) {
      return {
        ok: false,
        error: `pkg$ is required for ${pkg}.`
      };
    }
    const pkgDollar = Number(pkgDollarRaw);
    if (!Number.isFinite(pkgDollar) || pkgDollar < 0) {
      return {
        ok: false,
        error: `pkg$ for ${pkg} must be a non-negative number.`
      };
    }

    const entry: UpdatePackagesBulkEntry = {
      pkg,
      "pkg$": pkgDollar
    };

    const singleRaw = String(formData.get(`bulk_pkg_${idx}_single`) ?? "").trim();
    if (singleRaw.length === 0) {
      entry.single = null;
    } else {
      const n = Number(singleRaw);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ok: false,
          error: `single for ${pkg} must be a non-negative number or blank.`
        };
      }
      entry.single = n;
    }

    const sortRaw = String(formData.get(`bulk_pkg_${idx}_sort`) ?? "").trim();
    if (sortRaw.length === 0) {
      entry.sort = null;
    } else {
      const n = Number(sortRaw);
      if (!Number.isInteger(n) || n < 1) {
        return {
          ok: false,
          error: `sort for ${pkg} must be a positive integer or blank.`
        };
      }
      entry.sort = n;
    }

    updates.push(entry);
  }

  const body: UpdatePackagesBulkBody = {
    location_code: locationCode,
    updates
  };

  const result = await sysadminPatchJson(
    "/sysadmin/api/pricing-simple/packages-bulk",
    body
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Worker shape: { ok, location_code, results: [{pkg, ok, error?}], updated, failed }
  let updated = updates.length;
  let failed = 0;
  const failedPkgs: string[] = [];
  if (result.body && typeof result.body === "object") {
    const r = result.body as {
      updated?: unknown;
      failed?: unknown;
      results?: unknown;
    };
    if (typeof r.updated === "number") updated = r.updated;
    if (typeof r.failed === "number") failed = r.failed;
    if (Array.isArray(r.results)) {
      for (const row of r.results) {
        if (
          row &&
          typeof row === "object" &&
          "ok" in row &&
          (row as { ok?: unknown }).ok === false
        ) {
          const pkg = (row as { pkg?: unknown }).pkg;
          if (typeof pkg === "string") failedPkgs.push(pkg);
        }
      }
    }
  }

  revalidatePath(PAGE_PATH);

  if (failed > 0) {
    const list = failedPkgs.length > 0 ? `: ${failedPkgs.join(", ")}` : "";
    return {
      ok: true,
      message: `${updated} package${updated === 1 ? "" : "s"} updated, ${failed} failed${list}.`
    };
  }
  return {
    ok: true,
    message: `${updated} package${updated === 1 ? "" : "s"} updated at ${locationCode}.`
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
