// Who gets a digest and which sites each recipient sees. Kept apart from the
// sending code so it can be tested (and reused) without the chart renderer.

import type { DigestConfig } from "@splash/forms-schema";
import type { DigestSubmission } from "./aggregate.js";
import type { SiteContacts } from "./data.js";

// --- audiences -------------------------------------------------------------------

/** One email address and the sites it sees ("all" = every site). */
export interface Audience {
  email: string;
  sites: Set<string> | "all";
  /** Why they get it, for the preview: "RM", "Site", "Named". */
  roles: Set<string>;
}

const ROLE_SHORT: Record<string, string> = { site_email: "Site", rm_email: "RM", am_email: "RD", hrt_email: "HRT" };

export function resolveAudiences(config: DigestConfig, sites: Map<string, SiteContacts>): Audience[] {
  const by = new Map<string, Audience>();
  const get = (email: string) => {
    const k = email.trim().toLowerCase();
    let a = by.get(k);
    if (!a) {
      a = { email: k, sites: new Set(), roles: new Set() };
      by.set(k, a);
    }
    return a;
  };
  for (const r of config.recipients) {
    if (r.type === "static") {
      for (const e of r.emails) {
        if (!e.trim()) continue;
        const a = get(e);
        a.sites = "all";
        a.roles.add("Named");
      }
      continue;
    }
    for (const s of sites.values()) {
      const e = s.emails[r.role];
      if (!e) continue;
      const a = get(e);
      if (a.sites !== "all") a.sites.add(s.code);
      a.roles.add(ROLE_SHORT[r.role] ?? r.role);
    }
  }
  return [...by.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export function scopeSubs(subs: DigestSubmission[], sites: Audience["sites"]): DigestSubmission[] {
  return sites === "all" ? subs : subs.filter((s) => s.location_code != null && sites.has(s.location_code));
}

export function scopeLabel(sites: Audience["sites"], all: Map<string, SiteContacts>): string {
  if (sites === "all") return "All sites";
  const names = [...sites].map((c) => all.get(c)?.name ?? c).sort((a, b) => a.localeCompare(b));
  if (names.length <= 4) return names.join(", ");
  return `${names.length} sites`;
}

