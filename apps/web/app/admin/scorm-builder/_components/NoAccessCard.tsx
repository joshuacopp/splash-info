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
}

export default function NoAccessCard({ reason, returnPath }: Props) {
  if (reason === "signin") {
    return (
      <AccessCard
        eyebrow="Training"
        title="SCORM Package Builder"
        heading="Sign in required."
        message="SCORM Package Builder access is restricted. Sign in to continue."
        action={{ kind: "signin", returnPath: returnPath ?? "/admin/scorm-builder" }}
      />
    );
  }
  return (
    <AccessCard
      eyebrow="Training"
      title="SCORM Package Builder"
      heading="Access denied."
      message="SCORM Package Builder access requires super_admin or admin. Contact a super_admin if you need access."
      action={{ kind: "dashboard" }}
    />
  );
}
