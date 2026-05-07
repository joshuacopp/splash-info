# Brief 63: Add `[observability.logs]` to all 6 wrangler.toml files so the dashboard toggle stops resetting on each deploy

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator has been manually flipping the
"Workers Logs → Enabled" toggle on every CF dashboard after each
push-triggered deploy. Without observability declared in
wrangler.toml, CF Workers Builds re-provisions the worker config
from the file and the dashboard toggle reverts. This brief makes
the config declarative so logs stay on permanently.
**Dependencies:** None.

## Read first

- CLAUDE.md (the 5 workers + apps/web — six wrangler.toml files
  total)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- apps/dashboard-worker/wrangler.toml
- apps/signup-worker/wrangler.toml
- apps/performance-worker/wrangler.toml
- apps/sysadmin-worker/wrangler.toml
- apps/damage-worker/wrangler.toml
- apps/web/wrangler.toml
- (CF docs reference for executor's awareness:
  https://developers.cloudflare.com/workers/observability/logs/workers-logs/
  — the canonical TOML block this brief adds)

## Context

CF dashboard's "Logs → Enabled + Persist logs to Workers
dashboard" toggle is per-worker. On a fresh `wrangler deploy`
(triggered by GitHub push via CF Workers Builds), the worker
config is re-provisioned from `wrangler.toml`. Anything not in
the file gets reset to defaults — and observability defaults to
OFF for new workers, so each deploy reverts the operator's
manual enable.

Operator screenshot 2026-05-07 confirms CF's UI suggests the
fix: add `[observability.logs] enabled = true / invocation_logs
= true` to wrangler config. The TOML form (used by all our
wrangler files):

```toml
[observability.logs]
enabled = true
invocation_logs = true
```

This is a mechanical edit applied identically to all six files.
No worker-code change. Logs become permanently sticky across
deploys.

## Scope

### Phase 1 — Add the block to every wrangler.toml

1.1 In each of these files, append a new section at the bottom
(after any existing `[[services]]`, `[vars]`, or `[[d1_databases]]`
blocks):

```toml
# Brief 63 (2026-05-07): keeps Workers Logs sticky across
# deploys. Without this, CF Builds re-provisions the worker on
# every push and the dashboard toggle reverts to off.
[observability.logs]
enabled = true
invocation_logs = true
```

Files:
  - `apps/dashboard-worker/wrangler.toml`
  - `apps/signup-worker/wrangler.toml`
  - `apps/performance-worker/wrangler.toml`
  - `apps/sysadmin-worker/wrangler.toml`
  - `apps/damage-worker/wrangler.toml`
  - `apps/web/wrangler.toml`

1.2 Position the block at the bottom of each file. Don't insert
it between `[[services]]` array entries or `[vars]` blocks —
TOML is order-sensitive about array-of-tables (`[[…]]` blocks)
sharing a name, and putting `[observability.logs]` mid-file
risks breaking the existing parse if the trailing `[[services]]`
block gets orphaned.

1.3 Confirm the comment marker on each file references Brief 63
and the date so a future reader can find the rationale via
`grep "Brief 63"`.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages. (TOML
config changes don't affect typecheck, but run it as part of
the standard validation pass.)
2.2 For each worker:
   `pnpm --filter @splash/<worker-name> exec wrangler deploy
   --dry-run --outdir=.tmp-build`
   Each must succeed; clean up `.tmp-build` after each.
   Worker package names per CLAUDE.md:
     - @splash/dashboard-worker
     - @splash/signup-worker
     - @splash/performance-worker
     - @splash/sysadmin-worker
     - @splash/damage-worker
2.3 For apps/web: `pnpm --filter @splash/web build` — must
succeed. (apps/web bundles via OpenNext rather than wrangler
deploy --dry-run; the build step is the equivalent validation.)
2.4 No schema changes. No new env vars. No new secrets. No
worker-code change.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 63 row appended.

3.2 BUILD_STATE.md: Findings entry noting:
  - All 6 wrangler.toml files now declare
    `[observability.logs] enabled = true / invocation_logs = true`
  - Operator no longer needs to manually flip the dashboard
    toggle after each push-triggered redeploy
  - The block is identical across all 6 files; future workers
    should include it from the start
  - Operator follow-up: after the next push hits each worker's
    CF Builds pipeline, confirm the dashboard's "Logs → Enabled"
    toggle stays on without manual intervention

3.3 CLAUDE.md updates:
  - "Working with workers" section: add a one-line note that
    every worker's wrangler.toml MUST include
    `[observability.logs]` so logs stay sticky across deploys.
    New workers should copy the block from any existing one.

## Out of scope

- Configuring tail/streaming log destinations (Logpush to S3,
  Datadog, etc.). This brief is about the dashboard "Workers
  Logs" toggle only.
- Changing log levels, sampling, or retention windows.
  Defaults are fine for now.
- Touching the `[[d1_databases]]`, `[[services]]`, or any
  binding/secret config. Observability is independent.
- Adding observability to the `staging.splashcarwashes.info`
  routes if/when those are bound. Same block; future routes
  inherit.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- All 6 wrangler.toml files (5 workers + apps/web) have an
  `[observability.logs]` block with `enabled = true` and
  `invocation_logs = true`
- Each block carries a Brief 63 + 2026-05-07 marker comment for
  grep-ability
- pnpm typecheck passes (all 13 packages)
- All 5 worker dry-run deploys succeed
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (~30-42 lines net: 5-7 lines added to each of 6
  files, including the comment marker)
- Confirmation that wrangler dry-run deploys succeed for all 5
  workers without warnings about the new block
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified (6):**
- `apps/dashboard-worker/wrangler.toml` — appended 7-line block at EOF, after the `# Bindings` comment block.
- `apps/signup-worker/wrangler.toml` — appended at EOF, after the `# Bindings` comment block.
- `apps/performance-worker/wrangler.toml` — appended at EOF, after the SUPABASE_SERVICE_KEY rename note.
- `apps/sysadmin-worker/wrangler.toml` — appended at EOF, after the `# Bindings` comment block.
- `apps/damage-worker/wrangler.toml` — appended at EOF, after the `[images]` binding (last existing TOML table).
- `apps/web/wrangler.toml` — appended at EOF, after the `# Bindings (Supabase env)` comment block.

**Files modified (docs):**
- `CLAUDE.md` — "Working with workers" section gains a one-line rule (Brief 63 Workers Logs callout) immediately after the smoke-tests bullet.
- `BRIEFS/INDEX.md` — Brief 63 row appended.
- `BUILD_STATE.md` — `Last updated` parenthetical extended with the Brief 63 recap (existing Brief 62 recap reframed as "Earlier on 2026-05-07"); new Findings & decisions log row inserted at the top of the table.

**Files created:** none.

**Block applied to all 6 files:**

```toml
# Brief 63 (2026-05-07): keeps Workers Logs sticky across deploys. Without
# this, CF Builds re-provisions the worker on every push and the dashboard
# "Logs → Enabled" toggle reverts to off. New workers should copy this block.
[observability.logs]
enabled = true
invocation_logs = true
```

**Decisions made on the operator's behalf:** none. The brief was fully prescriptive (block content, file list, position-at-EOF, comment marker shape).

**Latent issues found:** none. The 6 wrangler.toml files are structurally simple — appending a new top-level table at EOF doesn't risk orphaning any of the existing array-of-tables blocks (`[[services]]`, `[[d1_databases]]`, `[[r2_buckets]]`) or single-table blocks (`[vars]`, `[assets]`, `[images]`). Verified each file's existing structure visually before edit.

**Validation results:**
- `pnpm typecheck` — passed (13/13 packages, 7.7s, all cache-hit except 3 workers).
- `pnpm --filter @splash/dashboard-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — passed (713.73 KiB / gzip 135.30 KiB; "No bindings found" — expected, dashboard-worker uses CF dashboard env vars).
- `pnpm --filter @splash/signup-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — passed (771.08 KiB / gzip 148.83 KiB; SIGNATURE_MODE binding listed).
- `pnpm --filter @splash/performance-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — passed (718.00 KiB / gzip 136.26 KiB).
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — passed (760.70 KiB / gzip 143.35 KiB).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — passed (1705.76 KiB / gzip 385.99 KiB; D1 + R2 + Images + 3 [vars] bindings listed).
- All 5 worker dry-runs succeeded **without warnings about the `[observability.logs]` block** — wrangler 4.87.0 silently accepts the schema.
- `.tmp-build` directories cleaned up after each dry-run via PowerShell `Remove-Item -Recurse -Force`.
- `pnpm --filter @splash/web build` — passed (Next.js 15.5.15, compiled in 4.3s, 13/13 static pages generated, route table unchanged from pre-Brief-63 baseline).

**Diff size:** ~42 lines net (7-line block × 6 files), within the brief's 30–42-line target.

**Operator follow-up (per brief Phase 3):** after the next push hits each worker's CF Workers Builds pipeline, confirm the dashboard's "Workers Logs → Enabled" toggle stays on without manual intervention. If a worker's toggle still reverts, check that CF Workers Builds is actually deploying the updated `wrangler.toml` (not a cached config) and that the `[observability.logs]` block landed at the top level (not accidentally scoped under a `[table]` header from a previous edit).
