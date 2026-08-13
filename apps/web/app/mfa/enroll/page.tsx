// TOTP MFA enrollment page.
//
// Voluntary during the opt-in phase (Brief: auth-hardening MFA, layer 1):
// any authenticated user can enroll their own authenticator here. No
// enforcement reads the resulting factor yet, so reaching this page or
// completing enrollment does NOT change how login or any gated page behaves
// — it just registers a verified factor on the user's Supabase account,
// priming them for when layer-2 (challenge-if-enrolled) lands.
//
// Server component only reads the ?next= redirect target and hands it to the
// client form. The form drives the two worker calls (enroll → verify) that
// actually talk to GoTrue.

import { EnrollMfaForm } from "./form";

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function EnrollMfaPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const next = params.next ?? "/admin/dashboard";
  return <EnrollMfaForm next={next} />;
}
