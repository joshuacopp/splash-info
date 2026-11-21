// Display helpers shared by the giveaways pages.

import type { GiveawayState, GiveawaySummary } from "./worker-fetch";

export const STATE_PILL: Record<GiveawayState, { label: string; cls: string }> = {
  open: { label: "Taking entries", cls: "bg-splash-success/15 text-splash-success" },
  not_started: { label: "Not started", cls: "bg-splash-warn/20 text-splash-navy" },
  ended: { label: "Ended", cls: "bg-splash-navy/10 text-splash-navy/70" },
  archived: { label: "Ended", cls: "bg-splash-navy/10 text-splash-navy/70" }
};

function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

export function datesText(g: Pick<GiveawaySummary, "starts_on" | "ends_on">): string {
  if (g.starts_on && g.ends_on) return `${fmtDay(g.starts_on)} – ${fmtDay(g.ends_on)}`;
  if (g.starts_on) return `From ${fmtDay(g.starts_on)}`;
  if (g.ends_on) return `Until ${fmtDay(g.ends_on)}`;
  return "No end date";
}

