// Server actions for /admin/sysadmin. Briefs 7 + 18 + 19.
//
// Five mutation surfaces, one per sysadmin-worker endpoint:
//   - createUserAction    → POST /sysadmin/api/create-user
//   - setRoleAction       → POST /sysadmin/api/set-role
//   - grantToolAction     → POST /sysadmin/api/grant-tool
//   - revokeToolAction    → POST /sysadmin/api/revoke-tool
//   - resetPasswordAction → POST /sysadmin/api/reset-password
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
import { sysadminPostJson } from "./_lib/worker-fetch";
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

  revalidatePath(PAGE_PATH);
  return { ok: true, message: `Granted ${tool}` };
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

  revalidatePath(PAGE_PATH);
  return { ok: true, message: `Revoked ${tool}` };
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
