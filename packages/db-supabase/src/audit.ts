// sysadmin_audit_log writes. Source: legacy/sysadmin.js:602 logAudit.
//
// Best-effort: errors are logged and swallowed. Audit failures must NOT
// break the admin operation that triggered them — partial audit coverage
// is preferable to a successful mutation surfaced as a failed request.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthUser } from "@splash/types/auth";

export interface SysadminAuditEntry {
  /** Authenticated super-admin who performed the action. Null for
   *  system-initiated entries (rare). */
  actor: AuthUser | null;
  /** Conventional values: "grant_tool", "revoke_tool", "set_role_super_admin",
   *  "set_role_location_admin", "clear_role", "reset_password", "create_user".
   *  String-typed (not a union) so new actions don't require a type bump. */
  action: string;
  /** "user_permissions" | "user_tool_access" | "auth.users" | etc. */
  target_type: string;
  /** UUID, composite key, or null when not applicable. */
  target_id: string | null;
  /** Pre-mutation row(s); jsonb in Postgres. Null for inserts. */
  before?: unknown;
  /** Post-mutation row(s). Null for deletes. */
  after?: unknown;
  notes?: string;
}

export async function logSysadminAudit(
  client: SupabaseClient,
  entry: SysadminAuditEntry
): Promise<void> {
  try {
    const { error } = await client.from("sysadmin_audit_log").insert({
      actor_id: entry.actor?.id ?? null,
      actor_email: entry.actor?.email ?? "system",
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id != null ? String(entry.target_id) : null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      notes: entry.notes ?? null
    });
    if (error) {
      console.error("Audit log insert failed:", error);
      // Match legacy: log + swallow.
    }
  } catch (err) {
    console.error("Audit log unexpected error:", err);
  }
}
