// Sysadmin UI (/admin/sysadmin). Briefs 7 + 18 + 19 + 24 + 26 + 27 + 30.
//
// Server component. Top-of-page super_admin gate via getMe(); the page never
// renders the operation cards for non-super_admins (worker re-validates on
// POST as defense in depth).
//
// Brief 30 — two-mode hub:
//   The flat 8-card list was reorganized into two modes (Manage Users /
//   Manage Tables). Mode is URL-driven (?mode=users default | ?mode=tables);
//   no client state, no JS. Card sections live in _sections/UserOperations
//   and _sections/TableOperations. Both modes also render the AuditLogPanel
//   below the operations — filterable view of sysadmin_audit_log
//   (actor/action/table/user/location_code) backed by the new GET
//   /sysadmin/api/audit-log endpoint.
//
// Layout (top → bottom):
//   1. PageBanner (eyebrow + title + helper text — Brief 30 dropped the
//      previous meta-commentary about sysadmin_audit_log).
//   2. ModePicker — two large buttons; URL-driven active mode.
//   3. Operation cards for the active mode (5 user mgmt OR 3 table mgmt).
//   4. AuditLogPanel — filterable activity log.
//
// Brief 19 — pattern flip: each card wraps its form in <ActionForm>; see
// _sections/UserOperations and _sections/TableOperations.

import { AuditLogPanel } from "./_sections/AuditLogPanel";
import { ModePicker, type SysadminMode } from "./_components/ModePicker";
import { NoAccessCard } from "./_components/NoAccessCard";
import { TableOperations } from "./_sections/TableOperations";
import { UserOperations } from "./_sections/UserOperations";
import { getMe } from "../../_lib/me";

interface SysadminPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SysadminPage({ searchParams }: SysadminPageProps) {
  const session = await getMe().catch(() => null);

  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/sysadmin" />;
  }
  if (session.role !== "super_admin") {
    return <NoAccessCard reason="forbidden" />;
  }

  const sp = await searchParams;
  const modeRaw = typeof sp.mode === "string" ? sp.mode : "";
  const mode: SysadminMode = modeRaw === "tables" ? "tables" : "users";

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <PageBanner />
      <ModePicker activeMode={mode} searchParams={sp} />

      <div className="flex flex-col gap-4">
        {mode === "tables" ? <TableOperations /> : <UserOperations />}
      </div>

      <AuditLogPanel searchParams={sp} />
    </section>
  );
}

/* ============================================================
 * Page chrome
 * ============================================================ */

function PageBanner() {
  return (
    <div className="mb-5">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">System Admin</h1>
      <p className="mt-1 text-sm text-splash-navy/70">
        Manage users and tables, with full activity history below.
      </p>
    </div>
  );
}

