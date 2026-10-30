// Who may FILL OUT an internal form -- `forms.fill_audience` (2026-10-30).
//
// One rule, enforced at three doors: the /forms list (visible-to-me), the
// render, and the submit. All three MUST go through `canFillForm`. Hiding a
// form from the list alone would leave it open by URL, which is the hole this
// closes: before it, any signed-in user -- including a shared site login --
// could open and submit any internal form.
//
// NO NEW PERMISSION MODEL. Groups come from data already kept:
//   site / rm / rd -- the caller's email on `locations` (site_email / rm_email /
//                     am_email), the same read /workorders has used since
//                     Brief 71. am_email is the Regional DIRECTOR.
//   tag            -- a `form_access_grants` row for the form's `access_tag`.
// Both are read live, so a change in sysadmin applies without a sign-out.
//
// EMPTY fill_audience = every signed-in user (the pre-existing behaviour).
// Full admin tier may always fill every form -- they build them.
//
// Only audience "internal" is gated. Public and link-only forms ignore the
// setting: the link is their permission, and they are not on the /forms list.

import { getLocationsByContactEmail } from "@splash/db-supabase";
import type { Session } from "@splash/auth";
import type { Env } from "./index.js";

export const FILL_GROUPS = ["site", "rm", "rd", "tag"] as const;
export type FillGroup = (typeof FILL_GROUPS)[number];

export interface FillRule {
  fillAudience: FillGroup[];
  accessTag: string | null;
}

export interface FillCaller {
  isAdmin: boolean;
  /** Location-derived groups the caller belongs to. */
  groups: Set<"site" | "rm" | "rd">;
  /** form_access_grants tags the caller holds. */
  tags: Set<string>;
}

/** Keep only known values, so a hand-edited row can't widen anything. */
export function normalizeFillAudience(raw: unknown): FillGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: FillGroup[] = [];
  for (const v of raw) {
    if ((FILL_GROUPS as readonly string[]).includes(v) && !out.includes(v)) {
      out.push(v as FillGroup);
    }
  }
  return out;
}

/** The decision. Pure, so every door answers identically and it is testable. */
export function canFillForm(rule: FillRule, caller: FillCaller): boolean {
  if (caller.isAdmin) return true;
  if (rule.fillAudience.length === 0) return true;
  for (const g of rule.fillAudience) {
    if (g === "tag") {
      // A "tag" audience on a form with no tag admits nobody but admins. The
      // builder warns about that; it must not fall open.
      if (rule.accessTag && caller.tags.has(rule.accessTag)) return true;
    } else if (caller.groups.has(g)) {
      return true;
    }
  }
  return false;
}

/** Any form in the list restricted? Lets callers skip the caller lookup. */
export function anyRestricted(rules: FillRule[]): boolean {
  return rules.some((r) => r.fillAudience.length > 0);
}

function isFullAdminTier(session: Session): boolean {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

/**
 * Resolve the caller's groups. FAILS CLOSED: an unreadable source yields no
 * groups, which can only narrow access -- the caller sees fewer forms, never
 * more. Logged, because the symptom is "my form disappeared".
 */
export async function resolveFillCaller(env: Env, session: Session): Promise<FillCaller> {
  const groups = new Set<"site" | "rm" | "rd">();
  const tags = new Set<string>();
  if (isFullAdminTier(session)) return { isAdmin: true, groups, tags };

  const [locs, tagRows] = await Promise.all([
    getLocationsByContactEmail(env, session.email ?? "").catch((err) => {
      console.error("[forms.fill] location lookup threw", err);
      return [];
    }),
    readTags(env, session.userId)
  ]);
  for (const l of locs) {
    if (l.matched_via === "site_email") groups.add("site");
    else if (l.matched_via === "rm_email") groups.add("rm");
    else if (l.matched_via === "am_email") groups.add("rd");
  }
  for (const t of tagRows) tags.add(t);
  return { isAdmin: false, groups, tags };
}

async function readTags(env: Env, userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  try {
    const url = new URL("/rest/v1/form_access_grants", env.SUPABASE_URL);
    url.searchParams.set("user_id", `eq.${userId}`);
    url.searchParams.set("select", "tag");
    const r = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!r.ok) {
      console.error("[forms.fill] form_access_grants read failed", r.status);
      return [];
    }
    return ((await r.json().catch(() => [])) as { tag: string }[])
      .map((x) => x.tag)
      .filter((t) => typeof t === "string" && t.length > 0);
  } catch (err) {
    console.error("[forms.fill] form_access_grants read threw", err);
    return [];
  }
}

/**
 * Read one form's rule. Returns null when it can't be read; callers treat
 * null as "refuse" -- an unknown rule must not fall open.
 */
export async function getFillRule(env: Env, formId: string): Promise<FillRule | null> {
  try {
    const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${formId}`);
    url.searchParams.set("select", "fill_audience,access_tag");
    url.searchParams.set("limit", "1");
    const r = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!r.ok) {
      console.error("[forms.fill] rule read failed", r.status);
      return null;
    }
    const row = ((await r.json().catch(() => [])) as {
      fill_audience: unknown;
      access_tag: string | null;
    }[])[0];
    if (!row) return null;
    return {
      fillAudience: normalizeFillAudience(row.fill_audience),
      accessTag: row.access_tag ?? null
    };
  } catch (err) {
    console.error("[forms.fill] rule read threw", err);
    return null;
  }
}
