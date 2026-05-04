// Forced-reset / voluntary password change page.
//
// SECURITY: this is the user-facing surface for the must_change_password
// gate. Server component reads the query params (?required=true&next=/admin)
// and hands them to the client form. Form posts to dashboard-worker's
// POST /api/forced-reset on the same origin (post-Step-7 cutover).
//
// During Step 6 dev, apps/web and the worker are on different workers.dev
// origins; cookies don't cross, so end-to-end testing requires same-origin
// setup. The page itself renders correctly in isolation.

import { ChangePasswordForm } from "./form";

interface PageProps {
  searchParams: Promise<{ required?: string; next?: string }>;
}

export default async function ChangePasswordPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const required = params.required === "true";
  const next = params.next ?? "/admin";
  return <ChangePasswordForm required={required} next={next} />;
}
