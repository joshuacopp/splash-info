#!/usr/bin/env node
/**
 * Apply a daily car_counts .sql file to the splash-damage-claims D1 database.
 *
 *   node apps/damage-worker/daily/apply.mjs apps/damage-worker/daily/car_counts_2026-09-04.sql
 *
 * Why this exists instead of `wrangler d1 execute --file`:
 *   --file has been unreliable for this DB (see apps/seed_car_counts.sql header),
 *   so each statement is sent individually with --command. execFileSync is used
 *   so the SQL never passes through a shell and needs no quote escaping.
 *
 * Safety: sumCarsInWindow() apportions every row across its date range, so a
 * monthly row that covers the same day will double-count against these daily
 * rows. This script runs that overlap check FIRST and refuses to continue if it
 * finds anything, unless you pass --force.
 *
 * Exit codes:
 *   0  applied (or dry run completed)
 *   1  usage / setup error
 *   2  overlap abort -- foreign rows already cover the day. Do NOT retry.
 *   3  overlap check result could not be parsed. Fails closed. Do NOT retry.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createRequire } from "node:module";

const DB = "splash-damage-claims";
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));

if (!file) {
  console.error("usage: node apply.mjs <path/to/car_counts_YYYY-MM-DD.sql> [--dry-run] [--force]");
  process.exit(1);
}

// The day is encoded in the filename: car_counts_2026-09-04.sql
const day = basename(file).match(/(\d{4}-\d{2}-\d{2})/)?.[1];
if (!day) {
  console.error(`could not read a YYYY-MM-DD day out of the filename: ${file}`);
  process.exit(1);
}

// Do not go through `npx` at all. On Windows npx is a .cmd shim, and since the
// CVE-2024-27980 fix Node refuses to spawn .bat/.cmd without shell: true
// (spawnSync npx.cmd EINVAL). Turning shell: true back on would break the
// promise in the header comment -- the SQL would pass through cmd.exe and every
// quote would need escaping.
//
// Instead resolve wrangler's own JS entrypoint and run it with this same node
// binary. No shim, no shell, no escaping. wrangler is a repo dependency, so
// require.resolve finds it by walking up to the workspace root node_modules.
const require = createRequire(import.meta.url);
let WRANGLER_JS;
try {
  WRANGLER_JS = require.resolve("wrangler/bin/wrangler.js");
} catch {
  console.error(
    "Could not resolve wrangler from this repo. Run `pnpm install` at the repo root."
  );
  process.exit(1);
}

function d1(sql, { json = false } = {}) {
  const argv = [WRANGLER_JS, "d1", "execute", DB, "--remote", "--command", sql];
  if (json) argv.push("--json");
  return execFileSync(process.execPath, argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// Pulls the result rows out of wrangler's --json output. Throws if the output
// cannot be parsed -- callers must treat that as unsafe, never as "no rows".
function parseRows(raw) {
  const start = raw.indexOf("[");
  if (start === -1) throw new Error(`no JSON in wrangler output:\n${raw}`);
  const parsed = JSON.parse(raw.slice(start));
  return parsed.flatMap((r) => r.results ?? []);
}

// ---- 1. overlap pre-flight -------------------------------------------------
//
// This check used to sniff wrangler's text output for a "|" table separator.
// wrangler now prints JSON, which contains no "|", so the check silently passed
// on EVERY run -- the guard was dead. It parses the rows properly now.
//
// Rows this pipeline itself wrote (note = '<day> daily') are not an overlap:
// the .sql file starts with a DELETE on exactly that note, so they are replaced,
// not added to. Anything else covering the day -- a monthly row, a hand-inserted
// row -- WILL double-count in sumCarsInWindow() and aborts the run.
console.log(`\n== overlap check for ${day} ==`);
const ownNote = `${day} daily`;
const overlapSql =
  `SELECT id, location_code, start_date, end_date, cars, note FROM car_counts ` +
  `WHERE start_date <= '${day}' AND end_date >= '${day}';`;

// Two different failures here, and they must NOT share an exit code. wrangler
// failing to run at all (Cloudflare API flake, expired auth, network) is
// transient and should be retried -- exit 1. Getting output back but being
// unable to parse it is a safety problem and must never be retried blindly --
// exit 3. Lumping both into 3 meant one API hiccup killed a whole backfill day
// that the retry loop would have recovered on its own (seen on 2026-09-01).
let rawOverlap;
try {
  rawOverlap = d1(overlapSql, { json: true });
} catch (err) {
  console.error(
    `\nthe overlap query did not run (wrangler failed). Nothing was written.\n` +
      `This is usually transient - the caller will retry. Underlying error:\n${err.message}`
  );
  process.exit(1);
}

let covering;
try {
  covering = parseRows(rawOverlap);
} catch (err) {
  console.error(
    `\nABORT: could not read the overlap check result, so the day cannot be\n` +
      `confirmed safe. Refusing to write. Underlying error:\n${err.message}`
  );
  process.exit(3);
}

const ours = covering.filter((r) => r.note === ownNote);
const foreign = covering.filter((r) => r.note !== ownNote);

console.log(
  `${covering.length} row(s) cover ${day}: ` +
    `${ours.length} written by this pipeline (will be replaced by the DELETE), ` +
    `${foreign.length} from elsewhere.`
);

if (foreign.length) {
  console.log("\nrows from elsewhere:");
  for (const r of foreign.slice(0, 20)) {
    console.log(
      `  id=${r.id} ${r.location_code} ${r.start_date}..${r.end_date} ` +
        `cars=${r.cars} note=${JSON.stringify(r.note)}`
    );
  }
  if (foreign.length > 20) console.log(`  ... and ${foreign.length - 20} more`);
}

if (foreign.length && !force) {
  console.error(
    `\nABORT: ${foreign.length} row(s) not written by this pipeline already cover\n` +
      `${day}. Applying daily rows on top of them will double-count in\n` +
      `sumCarsInWindow(). Delete or trim those rows first, then re-run.\n` +
      `Pass --force only if you are certain the overlap is harmless.`
  );
  process.exit(2);
}

// ---- 2. split the file into statements --------------------------------------
const statements = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s + ";");

console.log(`\n== ${statements.length} statement(s) from ${file} ==`);
for (const s of statements) {
  const preview = s.length > 90 ? s.slice(0, 90).replace(/\n/g, " ") + " ..." : s;
  console.log(`\n-> ${preview}`);
  if (dryRun) continue;
  console.log(d1(s));
}

if (dryRun) {
  console.log("\ndry run - nothing was sent to D1.");
  process.exit(0);
}

// ---- 3. verify ---------------------------------------------------------------
console.log(`\n== verify ==`);
console.log(
  d1(
    `SELECT COUNT(*) AS rows, SUM(cars) AS cars FROM car_counts WHERE note = '${day} daily';`
  )
);
