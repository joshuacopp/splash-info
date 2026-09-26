// Maps this feature's own prop shape and copy onto the shared AccessCard.
// The markup, the Sign In button and the half-finished-MFA rescue all live
// there now; what stays here is the wording, which is per-feature on purpose.
//
// The exported signature is UNCHANGED, so its call sites did not move. That was
// the point: rewriting 43 call sites across every admin failure path is a lot of
// edits on the screens hardest to notice getting wrong.

import AccessCard from "../../../_components/AccessCard";

interface Props {
  reason: "signin" | "no-promo-role" | "it-only";
  returnPath?: string;
}

export default function NoAccessCard({ reason, returnPath }: Props) {
  if (reason === "signin") {
    return (
      <AccessCard
        title="Promotions"
        heading="Sign in required."
        message="Promotions access is restricted. Sign in to continue."
        action={{ kind: "signin", returnPath: returnPath ?? "/admin/promotions" }}
      />
    );
  }
  if (reason === "no-promo-role") {
    return (
      <AccessCard
        title="Promotions"
        heading="No promotions access."
        message="The Promotions tool requires a promo role (super_admin, it, marketing, or ops). Contact a super_admin to request access."
        action={{ kind: "dashboard" }}
      />
    );
  }
  return (
    <AccessCard
      title="Promotions"
      heading="IT only."
      message="This view is restricted to IT and super_admin. Try the promotions dashboard instead."
      action={{ kind: "link", href: "/admin/promotions", label: "Back to Promotions" }}
    />
  );
}
