// One-off: bulk-resolve historical over-target flags.
//
// Context: the denominator correction in calc.js surfaced over-target flags on
// old visits that were never actionable. This script reuses the REAL calc.js so
// the flag set matches the Attention page exactly, then emits a single
// INSERT ... ON CONFLICT DO NOTHING you paste into the sysadmin SQL runner.
//
// It does NOT write to the database. It only reads and produces a .sql file.
//
// Run from apps/inventory:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... pnpm exec vite-node scripts/resolve-historical-overtarget.mjs
// (PowerShell:)
//   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_KEY="..."; pnpm exec vite-node scripts/resolve-historical-overtarget.mjs
//
// Optional: override the cutoff (inclusive) with CUTOFF=YYYY-MM-DD (default 2026-08-17).

import { createServiceClient } from "@splash/db-supabase";
import { buildIndex, computeVisit } from "../src/lib/calc.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const CUTOFF = process.env.CUTOFF || "2026-08-17"; // inclusive
const RESOLVED_BY = "historical-sweep@splashcarwashes.info";
const NOTE = `historical sweep - denominator correction (visits <= ${CUTOFF})`;
const OUT = `resolve-historical-overtarget-${CUTOFF}.sql`;

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
};
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.");
  process.exit(1);
}

const sb = createServiceClient(env);
const inv = () => sb.schema("inventory");

// Paginate every table (PostgREST caps at 1000 rows/request).
async function selectAll(table) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await inv()
      .from(table)
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`load ${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// calc.js keys everything on location_id, but the DB column is location_code.
const codeToId = (rows) =>
  rows.map((r) => ({ ...r, location_id: r.location_code }));

console.error(`Loading inventory tables from ${env.SUPABASE_URL} ...`);
const [
  locations,
  products,
  location_products,
  packages,
  package_products,
  site_visits,
  inventory_entries,
  wash_counts,
  flag_resolutions,
] = await Promise.all([
  selectAll("locations"),
  selectAll("products"),
  selectAll("location_products"),
  selectAll("packages"),
  selectAll("package_products"),
  selectAll("site_visits"),
  selectAll("inventory_entries"),
  selectAll("wash_counts"),
  selectAll("flag_resolutions"),
]);

// Keep the ORIGINAL visit rows so we can recover the real location_code + date
// for the resolution row (calc renames location_code away).
const visitMeta = new Map(
  site_visits.map((v) => [
    v.id,
    { location_code: v.location_code, visit_date: v.visit_date },
  ])
);

const ds = {
  locations,
  products,
  location_products: codeToId(location_products),
  packages: codeToId(packages),
  package_products,
  site_visits: codeToId(site_visits),
  inventory_entries,
  wash_counts,
};

const idx = buildIndex(ds);

// Flags that already have a resolution row are skipped (count stays honest;
// the SQL also has ON CONFLICT DO NOTHING as a second guard).
const alreadyResolved = new Set((flag_resolutions || []).map((r) => r.flag_key));

const cutoffDay = CUTOFF; // 'YYYY-MM-DD'
const day = (d) => String(d ?? "").slice(0, 10);

const toResolve = []; // { flag_key, location_code }
const skippedResolved = [];
const perLocation = new Map();

for (const v of site_visits) {
  const meta = visitMeta.get(v.id);
  if (!meta) continue;
  if (day(meta.visit_date) > cutoffDay) continue; // keep current visits live

  const result = computeVisit(ds, idx, v.id);
  const flags = result?.overTargetFlags || [];
  for (const f of flags) {
    const key = f.flagKeyOverTarget;
    if (!key) continue;
    if (alreadyResolved.has(key)) {
      skippedResolved.push(key);
      continue;
    }
    if (toResolve.some((t) => t.flag_key === key)) continue; // dedup
    toResolve.push({ flag_key: key, location_code: meta.location_code });
    perLocation.set(
      meta.location_code,
      (perLocation.get(meta.location_code) || 0) + 1
    );
  }
}

const esc = (s) => String(s).replace(/'/g, "''");
const nowIso = new Date().toISOString();

let sql = "";
sql += `-- Historical over-target sweep: visits with visit_date <= ${CUTOFF}\n`;
sql += `-- Generated ${nowIso}\n`;
sql += `-- New resolutions: ${toResolve.length}  (already-resolved skipped: ${skippedResolved.length})\n\n`;

if (toResolve.length === 0) {
  sql += "-- Nothing to resolve.\n";
} else {
  sql +=
    "INSERT INTO inventory.flag_resolutions " +
    "(id, flag_key, location_code, resolved_by, note, resolved_at) VALUES\n";
  sql += toResolve
    .map(
      (t) =>
        `  ('${randomUUID()}', '${esc(t.flag_key)}', '${esc(
          t.location_code
        )}', '${esc(RESOLVED_BY)}', '${esc(NOTE)}', '${nowIso}')`
    )
    .join(",\n");
  sql += "\nON CONFLICT (flag_key) DO NOTHING;\n";
}

writeFileSync(OUT, sql);

// Summary to stderr so it doesn't pollute the .sql file.
console.error(`\nCutoff (inclusive): ${cutoffDay}`);
console.error(`New over-target flags to resolve: ${toResolve.length}`);
console.error(`Already resolved (skipped): ${skippedResolved.length}`);
console.error(`\nBy location:`);
for (const [code, n] of [...perLocation.entries()].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${code}: ${n}`);
}
console.error(`\nWrote ${OUT} - review it, then paste into the sysadmin SQL runner.`);
