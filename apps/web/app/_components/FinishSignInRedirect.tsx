"use client";

// Rescues a caller stranded on a "Sign in required" card by a half-finished MFA
// login.
//
// THE DEAD END THIS EXISTS FOR. /api/login sets the aal1 cookies BEFORE the
// authenticator prompt is rendered, so leaving that prompt keeps a perfectly
// valid session that no gated page will accept. authenticate() reports that as
// plain "unauthenticated", indistinguishable from logged out, so the page shows
// a sign-in card -- and the user, who believes they are already signed in, reads
// it as the app being broken and tries the same route again. Observed exactly
// that: dashboard -> Pending Approvals -> "Sign in required" -> back -> repeat,
// never once reaching /login, which is where the recovery lives.
//
// So do not wait to be clicked. Ask, and if this is that state, go straight to
// the code step.
//
// WHY THE BROWSER ASKS. /login also checks this server-side, via the
// DASHBOARD_WORKER service binding. That check shipped and did not fire, and the
// binding is the one link in the chain not observable from outside. The browser
// reaches the same endpoint over the ordinary path-carved route with the same
// cookie, and that path is known to work -- it is how the aal1 state was
// confirmed in the first place.
//
// Renders nothing. It cannot render a "hold on" message, because the honest
// version of that message is the card it is already sitting behind.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function FinishSignInRedirect({ returnPath }: { returnPath: string }) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/mfa/status", {
          credentials: "include",
          cache: "no-store"
        });
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { needsStepUp?: boolean } | null;
        // needsStepUp requires a VALID token AND a verified factor, so this can
        // never fire for someone genuinely logged out -- they would only be
        // bounced back here, which is the loop rather than a fix for it.
        if (!cancelled && data?.needsStepUp === true) {
          router.replace(`/login?return=${encodeURIComponent(returnPath)}`);
        }
      } catch {
        // Leave the card exactly as it is. The Sign In button still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, returnPath]);
  return null;
}
