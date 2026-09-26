// Maps this feature's own prop shape and copy onto the shared AccessCard.
// The markup, the Sign In button and the half-finished-MFA rescue all live
// there now; what stays here is the wording, which is per-feature on purpose.
//
// The exported signature is UNCHANGED, so its call sites did not move. That was
// the point: rewriting 43 call sites across every admin failure path is a lot of
// edits on the screens hardest to notice getting wrong.

import AccessCard from "../../../_components/AccessCard";

interface Props {
  returnPath?: string;
}

/** Only ever a sign-in state: Brief 151 widened the JotForm index to any
 *  authenticated session, so there is no "forbidden" to render. */
export default function NoAccessCard({ returnPath }: Props) {
  return (
    <AccessCard
      title="JotForm"
      heading="Sign in required."
      message="JotForm submissions are restricted. Sign in to continue."
      action={{ kind: "signin", returnPath: returnPath ?? "/admin/jotform" }}
    />
  );
}
