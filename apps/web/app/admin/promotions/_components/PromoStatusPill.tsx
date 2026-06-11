// Brief 158a — seven-state status pill for promotions (Removing added at
// Brief 167).
//
// Color palette:
//   Submitted  neutral gray   (waiting to be picked up)
//   Scoped     sudsy blue     (IT has shape; pre-build)
//   Building   amber          (in progress, construction phase)
//   Tested     teal           (QA pass)
//   Live       green          (running)
//   Removing   orange         (teardown in progress — Brief 167; distinct
//                              from Building's amber and Ended's gray to
//                              read as "active but winding down")
//   Ended      muted gray     (concluded)

import type { PromoStatus } from "../_lib/types";

interface Props {
  status: PromoStatus;
  size?: "sm" | "md";
}

const PALETTE: Record<PromoStatus, string> = {
  Submitted: "bg-gray-light text-splash-navy/80",
  Scoped: "bg-sudsy-blue-soft text-splash-navy",
  Building: "bg-amber-100 text-amber-800",
  Tested: "bg-teal-100 text-teal-800",
  Live: "bg-emerald-100 text-emerald-800",
  Removing: "bg-orange-100 text-orange-800",
  Ended: "bg-gray-200 text-gray-600"
};

export function PromoStatusPill({ status, size = "md" }: Props) {
  const px = size === "sm" ? "px-2 py-0.5 text-[0.6875rem]" : "px-2.5 py-0.5 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full font-bold ${px} ${PALETTE[status]}`}
    >
      {status}
    </span>
  );
}

export default PromoStatusPill;
