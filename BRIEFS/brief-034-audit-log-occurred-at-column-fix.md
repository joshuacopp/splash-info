# Brief 34: Audit log column rename - `created_at` → `occurred_at`

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Brief 30's audit log panel returns 500 on load. Root
cause: the `sysadmin_audit_log` table uses column `occurred_at`,
not `created_at`. Brief 30 was drafted with the assumption that
`created_at` was the timestamp column (Postgres-default convention)
- it isn't. Diagnostic confirmed via Supabase error
`column sysadmin_audit_log.created_at does not exist` and a sample
INSERT showing `occurred_at` in the actual schema.
**Dependencies:** Brief 30 (the audit-log endpoint + panel that
this brief patches).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-030-sysadmin-mode-hub-and-audit-log.md (the brief
  this fixes - the column-name assumption is the only inaccuracy)
- apps/sysadmin-worker/src/index.ts (lines ~1444-1640 -
  handleSearchAuditLog and surrounding docblock)
- apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx (lines
  ~25 + ~433 - row interface + render of the When column)
- packages/db-supabase/src/audit.ts (write-side - uses Postgres
  default, so the table's actual column dictates what gets stored)

## Context

End-to-end testing surfaced the audit log loading 500 on the
sysadmin page. The wrapped error from sysadmin-worker:

```
{"error":"Audit-log fetch failed: 400 {\"code\":\"42703\",\"details\":null,\"hint\":null,\"message\":\"column sysadmin_audit_log.created_at does not exist\"}"}
```

A sample INSERT statement from the live table confirms the actual
shape:

```sql
INSERT INTO "public"."sysadmin_audit_log" (
  "id", "occurred_at", "actor_id", "actor_email", "action",
  "target_type", "target_id", "before", "after", "notes"
) VALUES (...);
```

So the timestamp column is `occurred_at`. Brief 30's spec referred
to `created_at` everywhere; this brief corrects it.

Why writes worked: `audit.ts:34-43` does
`client.from("sysadmin_audit_log").insert({...})` without supplying
the timestamp - Postgres `DEFAULT now()` (or whatever the table's
column default is) populates `occurred_at` automatically. The
write-side never had to know the column name.

## Scope

### Phase 1 - Fix sysadmin-worker

In `apps/sysadmin-worker/src/index.ts`:

1.1 **Line ~1444** (docblock): change references to `created_at`
in the comment block describing handleSearchAuditLog ordering.
Replace with `occurred_at`.

1.2 **Lines ~140-142** (`AuditLogRow` interface): change
`created_at: string;` to `occurred_at: string;`.

1.3 **Line ~1589** (since filter): change
`params.push(\`created_at=gte.${encodeURIComponent(sinceRaw)}\`)`
to `occurred_at=gte`.

1.4 **Line ~1596** (until filter): change
`params.push(\`created_at=lte.${encodeURIComponent(untilRaw)}\`)`
to `occurred_at=lte`.

1.5 **Line ~1599** (order): change
`params.push("order=created_at.desc")` to
`occurred_at.desc`.

1.6 Comments referencing the column elsewhere in the file
(handleSearchAuditLog docblock at ~1444 + any inline comments)
should be updated for consistency.

### Phase 2 - Fix apps/web

In `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx`:

2.1 **Line ~25** (row interface field): change
`created_at: string;` to `occurred_at: string;`.

2.2 **Line ~433** (render): change
`<span title={row.created_at}>{relativeTime(row.created_at)}</span>`
to `row.occurred_at` for both.

2.3 Re-grep `apps/web/app/admin/sysadmin/` for any other
`created_at` references in audit-log code (worker-fetch.ts type
defs, server actions if any, etc.) and update them. The grep
should return zero hits for audit-log specific code after this
brief.

### Phase 3 - Updates

3.1 BRIEFS/INDEX.md: Brief 34 row added.

3.2 BUILD_STATE.md: brief Findings entry noting the column-rename
fix.

3.3 The Brief 30 spec itself does not need editing - it's already
in DONE state with the inaccuracy documented in this brief's
Context. Future-us reading 30 should follow back to 34 for the
correction.

## Out of scope

- Renaming the `occurred_at` column to `created_at` in Supabase.
  The table is preexisting and other consumers (legacy code,
  reports, etc.) likely depend on the column name. Conform the
  worker to the table, not the other way around.
- Adding the `created_at` alias as a virtual column or view. Not
  needed; one renamed reference is sufficient.
- Refactoring the audit-log error path to surface Supabase errors
  more directly in apps/web's UI. The wrapped error swallowing in
  `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts:93` is a
  separate concern; if you want to fix it (e.g., include response
  body in the thrown error), it's a Brief 35 item.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/sysadmin-worker build succeeds
- All `created_at` references in audit-log code paths replaced
  with `occurred_at`
- Manual smoke test (after deploy): /admin/sysadmin loads with
  the audit log populated, newest first
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Confirmed grep result showing zero remaining `created_at`
  references in audit-log code paths
- Bundle-size delta (likely zero)
- Validation results

## Outcome

**Files modified (2):**

1. `apps/sysadmin-worker/src/index.ts` — 4 changes inside `handleSearchAuditLog` and its docblock:
   - **Line 1447** (docblock): "Ordered created_at.desc" → "Ordered occurred_at.desc"
   - **Line 1589** (`since` filter): `created_at=gte.${...}` → `occurred_at=gte.${...}`
   - **Line 1596** (`until` filter): `created_at=lte.${...}` → `occurred_at=lte.${...}`
   - **Line 1599** (order clause): `params.push("order=created_at.desc")` → `order=occurred_at.desc`

2. `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx` — 2 changes:
   - **Line 25** (`AuditLogRow` interface field): `created_at: string` → `occurred_at: string`
   - **Line 433** (When-column render, both refs in one line): `<span title={row.created_at}>{relativeTime(row.created_at)}</span>` → `row.occurred_at` for both

**Files created:** none.
**Files deleted:** none.

**Decisions made on operator's behalf:**

1. **No `AuditLogRow` interface in sysadmin-worker.** The brief said to update an `AuditLogRow` interface at lines ~140-142 of `apps/sysadmin-worker/src/index.ts`, but that location holds the `OWNED_GET_PATHS` constant — sysadmin-worker types the audit-log REST response as `unknown[]` (`AuditLogResponse.rows: unknown[]`) and never declares a shaped `AuditLogRow`. The only typed `AuditLogRow` lives in apps/web's `AuditLogPanel.tsx`, which is where the field-rename actually applies. Phase 1.2 of the brief is therefore a no-op on the worker side; the field-rename happens once in the panel.

2. **`LOCATION_REJECTED_FIELDS` constant (line 1281) + Update Location docblock (line 1258) left untouched.** Both reference `created_at` for the `locations` table (Brief 27 territory), not for `sysadmin_audit_log`. The `locations` table is a separate Postgres table and presumably DOES have a `created_at` column (the docblock asserts it as a rejected audit field). Phase 1.6 ("comments referencing the column elsewhere in the file") was scoped to refs inside the audit-log handler; out-of-scope refs to `locations.created_at` are intentionally preserved.

3. **`apps/web/app/admin/sysadmin/actions.ts:568` reference left untouched.** That `created_at` mention is in a docblock about the `locations` row's audit-field rejection list — not about `sysadmin_audit_log`. Same rationale as (2).

4. **`apps/web/app/admin/sysadmin/_components/LocationsSearchPicker.tsx:40` field + `UpdateLocationCard.tsx:317-321` label left untouched.** Both are the `locations` table's `created_at` audit field surfacing in the locations-search picker UI and the Update Location editor's read-only metadata. Locations-table territory; out of scope.

5. **`pnpm --filter @splash/sysadmin-worker build` not invoked.** sysadmin-worker has no `build` script (its `package.json` declares only `dev` / `deploy` / `typecheck` / `lint` / `clean`; bundling happens via `wrangler deploy` at deploy time). `pnpm typecheck` at the workspace root passing (13/13) is the equivalent validation gate the worker exposes; the brief's DoD line "pnpm --filter @splash/sysadmin-worker build succeeds" was satisfied by the typecheck pass.

**Latent issues / forward flags:**

- **(a)** The wrapped error in `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts:93` swallows Supabase error bodies behind a generic `Audit-log fetch failed: <status> <body>` string. This brief's diagnostic was legible only because the Supabase 400 body literally contained `{"code":"42703",...,"message":"column ... does not exist"}`. Future schema drift between the worker's expected columns and the live table won't always be this readable. The brief explicitly listed worker-fetch error-path refactoring as a Brief 35 candidate; not actioned here.
- **(b)** `packages/db-supabase/src/audit.ts` write-side is name-agnostic (the insert object never sets the timestamp column; Postgres `DEFAULT now()` handles it). The READ side is the only place that hardcodes the column name; this brief patches the only such surface.
- **(c)** Bundle-size delta is effectively zero: 5 short string replacements (`created_at` → `occurred_at`) on the read side. apps/web `/admin/sysadmin` post-build still measures **7.06 kB / 112 kB First Load JS** — unchanged from the post-Brief-30 baseline. sysadmin-worker has no build artifact at this layer (deploy-time bundling), so no comparable bundle metric to report.
- **(d)** Manual smoke test deferred. The brief's DoD includes "Manual smoke test (after deploy): /admin/sysadmin loads with the audit log populated, newest first." Per CLAUDE.md headless-mode constraints, this session does not deploy; the operator runs the smoke test on the next deploy.

**Validation:**

- `pnpm typecheck` — **13/13 successful**, 4.762s (11 cached, 2 cache-miss). Cache-misses are the two packages with source changes: `@splash/sysadmin-worker` + `@splash/web`. Every other package replayed cached results.
- `pnpm --filter @splash/web build` — **succeeded.** `next build` compiled in 5.3s, generated all 12 static pages, no warnings. Final route table:
  - `/admin/sysadmin` — 7.06 kB / 112 kB First Load JS (unchanged vs. post-Brief-30 baseline).
- Final `created_at` grep result across audit-log code paths:
  - `apps/sysadmin-worker/src/index.ts` inside `handleSearchAuditLog`: **0 hits.** Two remaining file-wide `created_at` matches (lines 1258 + 1281) are both for the `locations` table, intentionally out of scope.
  - `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx`: **0 hits** (replaced by 2 `occurred_at` matches at lines 25 + 433).
  - All other `created_at` matches under `apps/web/app/admin/sysadmin/` (`actions.ts:568`, `LocationsSearchPicker.tsx:37,40`, `UpdateLocationCard.tsx:27,317,320,321`) are locations-table refs, intentionally out of scope.

**Bundle-size delta:** none (5 string-equal-length replacements on apps/web; sysadmin-worker has no build artifact at this layer).
