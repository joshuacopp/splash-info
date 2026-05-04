// Server actions for /admin/sysadmin. Brief 7.
//
// Five mutation surfaces, one per sysadmin-worker endpoint:
//   - createUserAction    → POST /sysadmin/api/create-user
//   - setRoleAction       → POST /sysadmin/api/set-role
//   - grantToolAction     → POST /sysadmin/api/grant-tool
//   - revokeToolAction    → POST /sysadmin/api/revoke-tool
//   - resetPasswordAction → POST /sysadmin/api/reset-password
//
// Shared shape:
//   1. Read fields off FormData. Build a typed JSON body matching the worker
//      handler's expected shape (apps/sysadmin-worker/src/index.ts).
//   2. Call sysadminPostJson(...).
//   3. On worker error: redirect back with ?action_error=<encoded>.
//   4. On success: revalidatePath + redirect with ?action_success=<encoded>.
//
// Validation policy: don't pre-validate inputs in the action. The worker
// validates and returns 400 with a useful error message; surfacing that
// error inline is the right UX (single source of validation truth).
//
// Server actions in Next 15 surface the redirect via a thrown NEXT_REDIRECT;
// the framework catches and returns a navigation response to the form
// submitter. All five branches end in redirect() so the browser URL is
// always under our control after the action runs.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sysadminPostJson } from "./_lib/worker-fetch";
import type { ToolName, UserRole } from "@splash/types/auth";

const PAGE_PATH = "/admin/sysadmin";

function errorRedirect(message: string): never {
  redirect(`${PAGE_PATH}?action_error=${encodeURIComponent(message)}`);
}

function successRedirect(message: string): never {
  redirect(`${PAGE_PATH}?action_success=${encodeURIComponent(message)}`);
}

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

export async function createUserAction(formData: FormData): Promise<void> {
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
    errorRedirect(result.error);
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
  successRedirect(`User created: ${respEmail}`);
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

export async function setRoleAction(formData: FormData): Promise<void> {
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
    errorRedirect(result.error);
  }

  revalidatePath(PAGE_PATH);
  if (role === null) {
    successRedirect(`Cleared role for ${userId}`);
  }
  successRedirect(`Set role '${role}' on ${userId}`);
}

/* ============================================================
 * Grant tool
 * ============================================================ */

interface GrantToolBody {
  user_id: string;
  tool: ToolName;
}

export async function grantToolAction(formData: FormData): Promise<void> {
  const userId = fieldString(formData, "user_id");
  const tool = fieldString(formData, "tool");

  const body: GrantToolBody = {
    user_id: userId,
    tool: tool as ToolName
  };

  const result = await sysadminPostJson("/sysadmin/api/grant-tool", body);
  if (!result.ok) {
    errorRedirect(result.error);
  }

  revalidatePath(PAGE_PATH);
  successRedirect(`Granted '${tool}' to ${userId}`);
}

/* ============================================================
 * Revoke tool
 * ============================================================ */

export async function revokeToolAction(formData: FormData): Promise<void> {
  const userId = fieldString(formData, "user_id");
  const tool = fieldString(formData, "tool");

  const body: GrantToolBody = {
    user_id: userId,
    tool: tool as ToolName
  };

  const result = await sysadminPostJson("/sysadmin/api/revoke-tool", body);
  if (!result.ok) {
    errorRedirect(result.error);
  }

  revalidatePath(PAGE_PATH);
  successRedirect(`Revoked '${tool}' from ${userId}`);
}

/* ============================================================
 * Reset password
 * ============================================================ */

interface ResetPasswordBody {
  user_id: string;
  new_password: string;
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const userId = fieldString(formData, "user_id");
  const newPassword = fieldString(formData, "new_password");

  const body: ResetPasswordBody = {
    user_id: userId,
    new_password: newPassword
  };

  const result = await sysadminPostJson("/sysadmin/api/reset-password", body);
  if (!result.ok) {
    errorRedirect(result.error);
  }

  revalidatePath(PAGE_PATH);
  successRedirect(
    `Password reset for ${userId} (must_change_password set to true)`
  );
}
