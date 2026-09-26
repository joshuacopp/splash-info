// Maps this feature's own prop shape and copy onto the shared AccessCard.
// The markup, the Sign In button and the half-finished-MFA rescue all live
// there now; what stays here is the wording, which is per-feature on purpose.
//
// The exported signature is UNCHANGED, so its call sites did not move. That was
// the point: rewriting 43 call sites across every admin failure path is a lot of
// edits on the screens hardest to notice getting wrong.

import AccessCard from "../../../_components/AccessCard";

interface Props {
  reason: "signin" | "forbidden";
  returnPath?: string;
  /** Heading for the page borrowing this card. Defaults to "Forms" -- which is
   *  what /admin/approvals was showing, along with a line about form-builder
   *  access, on a page that has nothing to do with the form builder. */
  title?: string;
  /** Sign-in copy for the borrowing page. Same reason as `title`. */
  signinMessage?: string;
}

export default function NoAccessCard({
  reason,
  returnPath,
  title = "Forms",
  signinMessage = "Form builder access is restricted. Sign in to continue."
}: Props) {
  if (reason === "signin") {
    return (
      <AccessCard
        title={title}
        heading="Sign in required."
        message={signinMessage}
        action={{ kind: "signin", returnPath: returnPath ?? "/admin/forms" }}
      />
    );
  }
  return (
    <AccessCard
      title={title}
      heading="Access denied."
      message="Form builder access requires super_admin or admin. Contact a super_admin if you need access."
      action={{ kind: "dashboard" }}
    />
  );
}
