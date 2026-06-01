// Brief 148 — SCORM Package Builder admin page.
//
// Thin server-component wrapper around the client island. Same admin-tier
// gate as /admin/forms (super_admin OR dcRole admin / super_admin); same
// NoAccessCard for signin / forbidden.

import { getMe } from "../../_lib/me";
import NoAccessCard from "./_components/NoAccessCard";
import ScormBuilderClient from "./_components/ScormBuilderClient";

export const dynamic = "force-dynamic";

export default async function ScormBuilderPage() {
  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/scorm-builder" />;
  }

  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";

  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  return <ScormBuilderClient />;
}
