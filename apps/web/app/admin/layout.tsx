// Admin-section layout — enforces the MFA enrollment deadline for the whole
// /admin/* tree.
//
// WHY HERE (not middleware): middleware.ts is presence-only (it can't decode
// the JWT or read session context in the Edge runtime — see the note at the top
// of that file). The overdue block needs `session.mfaEnrollment`, which only
// exists after authenticate() runs on dashboard-worker. This server-component
// layout has the session (via the cached getMe()) so it's the right place.
//
// WHY /admin (not the root layout): the enrollment page lives at /mfa/enroll —
// OUTSIDE /admin — so redirecting from here can never loop back onto itself.
// Putting the guard in the root layout would also fire on /mfa/enroll and trap
// the user. Login already redirects new/overdue users to enrollment; this
// covers the case where an already-logged-in user's grace window elapses
// mid-session and they navigate deeper into the tools.
//
// getMe() is React-cache()'d, so this shares the single /api/me fetch the root
// layout already made — no extra round-trip.

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getMe } from "../_lib/me";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getMe().catch(() => null);

  // Only a positively-overdue session is blocked. Within the grace window the
  // Header banner handles the nudge; unauthenticated users are already bounced
  // to /login by middleware before this renders.
  if (session?.mfaEnrollment?.overdue) {
    redirect("/mfa/enroll?required=true");
  }

  return <>{children}</>;
}
