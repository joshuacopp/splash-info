// Root of apps/web. Server-side redirect to /admin/dashboard. The middleware
// in turn bounces unauthenticated users from /admin/dashboard to /login with
// the appropriate ?return path, so the unauth flow becomes:
//
//   /  ->  /admin/dashboard  ->  /login?return=%2Fadmin%2Fdashboard
//
// And the authed flow is just:
//
//   /  ->  /admin/dashboard  (renders)
//
// Replaces the Step-4 placeholder. Closes Brief 12 (root route fill-in).

import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/admin/dashboard");
}
