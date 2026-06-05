// Brief 158a — three-state priority pill for promotions.
//
//   High    red     (drop everything)
//   Medium  amber   (normal queue)
//   Low     green   (when time permits)

import type { PromoPriority } from "../_lib/types";

interface Props {
  priority: PromoPriority;
  size?: "sm" | "md";
}

const PALETTE: Record<PromoPriority, string> = {
  High: "bg-racecar-red/15 text-racecar-red",
  Medium: "bg-amber-100 text-amber-800",
  Low: "bg-emerald-100 text-emerald-800"
};

export function PromoPriorityPill({ priority, size = "md" }: Props) {
  const px = size === "sm" ? "px-2 py-0.5 text-[0.6875rem]" : "px-2.5 py-0.5 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full font-bold uppercase tracking-wide ${px} ${PALETTE[priority]}`}
    >
      {priority}
    </span>
  );
}

export default PromoPriorityPill;
