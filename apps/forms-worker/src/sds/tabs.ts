// Binder tab numbers: which pre-numbered divider a sheet sits behind.
//
// Sites order 1-50 dividers, so a tab number is a PHYSICAL ADDRESS. That is the
// constraint everything here follows from.
//
// NUMBERING IS A DELIBERATE ACT. A site builds its list out first with no tabs
// at all, then presses the button once and gets 1..N alphabetically. Numbering
// as you go would mean the order recorded is the order somebody happened to type
// things in, and the first print would need re-tabbing immediately.
//
// AFTER THAT, ADDITIONS APPEND. A new chemical takes the next free number and
// goes behind that divider; nothing already filed moves. This is why the printed
// index sorts ALPHABETICALLY with the tab as a column rather than sorting by tab
// -- the index is the lookup, the number is just where to go, exactly like a
// parts catalogue. Sorting the index by tab would bury a newly added chemical at
// the end where nobody looks for it.
//
// RENUMBERING STAYS AVAILABLE and is not an escape hatch -- it is the normal
// move after removals leave gaps, or at a review when the book is rebuilt from
// scratch. It renumbers 1..N alphabetically and closes every gap, at the cost of
// re-filing the binder, which is the operator's call to make and not ours.

import type { Env } from "../index.js";

/** Pre-numbered divider packs run to 50. Past that a site needs a second pack or
 *  a rethink, and it should hear about it before the print, not after. */
export const TAB_LIMIT = 50;

function sbHeaders(env: Env, extra?: Record<string, string>) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(extra ?? {})
  };
}

interface TabRow {
  id: string;
  binder_tab: string | null;
  catalog: { product_identifier: string } | null;
}

async function readActiveItems(env: Env, locationCode: string): Promise<TabRow[]> {
  const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
  url.searchParams.set("select", "id,binder_tab,catalog:sds_catalog(product_identifier)");
  url.searchParams.set("location_code", `eq.${locationCode}`);
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("limit", "2000");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error(`tab read failed: ${resp.status}`);
  return (await resp.json().catch(() => [])) as TabRow[];
}

/** Only digits count as a numbered tab. A site that wrote "A" or "Flammables"
 *  in the field is not using numbered dividers, and this must not silently
 *  reinterpret what they meant. */
function numericTab(v: string | null): number | null {
  const t = (v ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function byName(a: TabRow, b: TabRow): number {
  return (a.catalog?.product_identifier ?? "").localeCompare(
    b.catalog?.product_identifier ?? "",
    undefined,
    { sensitivity: "base" }
  );
}

/**
 * The number a chemical added right now should take, or null when this site has
 * not been numbered yet.
 *
 * Null is the important case: during build-out nothing is numbered, and handing
 * the first chemical a "1" would start a numbering nobody asked for and quietly
 * commit the site to whatever order things were typed in.
 *
 * Deliberately max+1 rather than the lowest free number. A gap is usually a
 * chemical that was removed, and its divider may still hold the old sheet --
 * reusing the number silently files a new chemical behind the wrong one. Closing
 * gaps is what Renumber is for, where somebody is re-filing anyway.
 */
export async function nextTabFor(
  env: Env,
  locationCode: string
): Promise<string | null> {
  let items: TabRow[];
  try {
    items = await readActiveItems(env, locationCode);
  } catch (err) {
    // Fail soft: an unnumbered new row is a visible, fixable state, whereas
    // refusing the add loses work the site just did.
    console.warn("[forms.sds] next tab lookup failed", err);
    return null;
  }
  const used = items.map((i) => numericTab(i.binder_tab)).filter((n): n is number => n !== null);
  if (used.length === 0) return null;
  return String(Math.max(...used) + 1);
}

export interface AssignResult {
  mode: "fill" | "renumber";
  /** Rows whose tab actually changed. */
  changed: number;
  /** Active chemicals at the site, i.e. how many dividers the binder needs. */
  total: number;
  /** Highest number assigned -- past TAB_LIMIT the divider pack runs out. */
  highest: number;
  over_limit: boolean;
}

/**
 * Assign tab numbers across a site's list.
 *
 * `fill` gives a number to anything lacking one, continuing from the highest in
 * use, and never disturbs a tab that already exists -- safe to press at any time
 * because it cannot move a sheet that is already filed.
 *
 * `renumber` rewrites every tab 1..N alphabetically and closes gaps. It WILL
 * invalidate the physical binder, which is why it is a separate mode and not a
 * cleanup that `fill` does opportunistically.
 */
export async function assignTabs(
  env: Env,
  locationCode: string,
  mode: "fill" | "renumber",
  email: string
): Promise<AssignResult> {
  const items = await readActiveItems(env, locationCode);
  const sorted = [...items].sort(byName);

  const updates: { id: string; tab: string }[] = [];

  if (mode === "renumber") {
    sorted.forEach((item, idx) => {
      const tab = String(idx + 1);
      if ((item.binder_tab ?? "").trim() !== tab) updates.push({ id: item.id, tab });
    });
  } else {
    const used = new Set(
      items.map((i) => numericTab(i.binder_tab)).filter((n): n is number => n !== null)
    );
    let next = used.size === 0 ? 1 : Math.max(...used) + 1;
    for (const item of sorted) {
      if (numericTab(item.binder_tab) !== null) continue;
      updates.push({ id: item.id, tab: String(next) });
      next++;
    }
  }

  // One PATCH per row. PostgREST has no multi-row update-by-id, and the
  // alternative -- an upsert of full rows -- risks writing stale copies of every
  // other column. A binder is tens of rows, not thousands.
  let changed = 0;
  for (const u of updates) {
    const url = new URL("/rest/v1/sds_items", env.SUPABASE_URL);
    url.searchParams.set("id", `eq.${u.id}`);
    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: sbHeaders(env, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        binder_tab: u.tab,
        updated_by: email,
        updated_at: new Date().toISOString()
      })
    });
    if (resp.ok) changed++;
    else console.error("[forms.sds] tab patch failed", u.id, resp.status);
  }

  const finalTabs =
    mode === "renumber"
      ? sorted.map((_, i) => i + 1)
      : [
          ...items.map((i) => numericTab(i.binder_tab)).filter((n): n is number => n !== null),
          ...updates.map((u) => Number(u.tab))
        ];
  const highest = finalTabs.length ? Math.max(...finalTabs) : 0;

  return {
    mode,
    changed,
    total: items.length,
    highest,
    over_limit: highest > TAB_LIMIT
  };
}
