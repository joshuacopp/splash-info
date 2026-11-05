// IT Issue Tracker beta gate, apps/web side: hides the tile and puts a "beta"
// message on the pages. The worker's canUseItIssues is the real check; keep
// the two the same.

import type { Session } from "@splash/types/session";

export function canUseItIssues(session: Session | null): boolean {
  if (!session) return false;
  const tools = session.tools as readonly string[];
  return session.role === "super_admin" || tools.includes("it_issues") || tools.includes("it_issues_it");
}
