#!/usr/bin/env node
/**
 * Apply the generated mt_punch SQL to Supabase.
 *
 *   node apps/maintenance-tracker/apply_punches.mjs mt_punch.sql [--dry-run]
 *
 * Needs SUPABASE_DB_URL in the environment -- the Postgres connection string
 * from Supabase → Project Settings → Database → Connection string. Take the
 * SESSION POOLER one (aws-N-<region>.pooler.supabase.com:5432), NOT the one
 * labelled "Direct connection": db.<ref>.supabase.co resolves over IPv6 only,
 * so on an IPv4 network it fails with "could not translate host name ... to
 * address" -- a message that looks like a typo rather than a network-family
 * mismatch. Port 5432 (session) not 6543 (transaction): the generated file is
 * a single BEGIN/COMMIT.
 *
 * It is NOT the service-role key: this runs real SQL, not PostgREST calls,
 * because a 2,700-row upsert through the REST API would be thousands of round
 * trips.
 *
 * Why psql rather than a node pg client: no new dependency, and psql is
 * already a prerequisite for the export half of this pipeline.
 *
 * IDEMPOTENT. The generated SQL upserts on shift_id and the whole thing is
 * wrapped in one transaction, so a re-run is free and a failure leaves nothing
 * half-applied.
 *
 * Exit codes:
 *   0  applied (or dry run)
 *   1  usage / setup error
 *   2  psql reported a failure -- nothing was committed
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));

if (!file) {
  console.error("usage: node apply_punches.mjs <mt_punch.sql> [--dry-run]");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(1);
}
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is not set.");
  console.error("Supabase → Project Settings → Database → Connection string (URI).");
  process.exit(1);
}

const kb = Math.round(statSync(file).size / 1024);
console.log(`${dryRun ? "[dry run] " : ""}applying ${file} (${kb} KB)`);

if (dryRun) {
  console.log("dry run: not executed. Drop --dry-run to apply.");
  process.exit(0);
}

try {
  // ON_ERROR_STOP with the file's own BEGIN/COMMIT means any failure rolls the
  // whole load back rather than leaving a partial day in the table.
  const out = execFileSync(
    "psql",
    [url, "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "--no-psqlrc", "-f", file],
    { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } }
  );
  process.stdout.write(out);
  console.log("applied.");
} catch (err) {
  console.error("psql failed - nothing was committed.");
  if (err.stdout) process.stdout.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(2);
}
