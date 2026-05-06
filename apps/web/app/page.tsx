// Brief 50: root path redirects unauthenticated users to /login
// and authenticated users to /admin/dashboard. The middleware on
// /admin/* (Brief 1) is the source of truth for auth correctness;
// this file is only a UX shortcut to skip a placeholder.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const cookieStore = await cookies();
  // Cookie name is "sb-access-token" per @splash/auth's
  // ACCESS_TOKEN_COOKIE constant. Don't import from @splash/auth
  // here — that package is server-only Node and breaks Edge
  // runtime; the constant is duplicated as a literal string in
  // apps/web's middleware.ts as well. Same posture here.
  const hasAccessToken = cookieStore.has("sb-access-token");
  redirect(hasAccessToken ? "/admin/dashboard" : "/login");
}
