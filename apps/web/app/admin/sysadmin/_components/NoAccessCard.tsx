// Maps this feature's own prop shape and copy onto the shared AccessCard.
// The markup, the Sign In button and the half-finished-MFA rescue all live
// there now; what stays here is the wording, which is per-feature on purpose.
//
// The exported signature is UNCHANGED, so its call sites did not move. That was
// the point: rewriting 43 call sites across every admin failure path is a lot of
// edits on the screens hardest to notice getting wrong.

import AccessCard from "../../../_components/AccessCard";

interface NoAccessCardProps {
  reason: "signin" | "forbidden";
  /** Required for reason="signin"; ignored for "forbidden". */
  returnPath?: string;
}

/** Named export, not default -- its call sites import it that way. */
export function NoAccessCard({ reason, returnPath }: NoAccessCardProps) {
  if (reason === "signin") {
    return (
      <AccessCard
        title="System Admin"
        heading="Sign in required."
        message="Sysadmin operations are restricted to super-admins. Sign in to continue."
        action={{ kind: "signin", returnPath: returnPath ?? "/admin/sysadmin" }}
      />
    );
  }
  // No Sign In button: the caller IS authenticated and signing in again cannot
  // change their role.
  return (
    <AccessCard
      title="System Admin"
      heading="Access denied."
      message="Sysadmin operations are super-admin only. Contact a super-admin if you need access."
      action={{ kind: "dashboard" }}
    />
  );
}
