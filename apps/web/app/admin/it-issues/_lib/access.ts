// IT Issue Tracker beta gate, apps/web side: hides the tile and puts a "beta"
// message on the pages. The worker's canUseItIssues is the real check; keep
// the two the same.

import type { Session } from "@splash/types/session";

export function canUseItIssues(session: Session | null): boolean {
  if (!session) return false;
  return session.role === "super_admin" || (session.tools as readonly string[]).includes("it_issues");
}
