# SB-sec — Supabase security review

**Project:** `Splash-info` (`rewokyofschtvqgxrxwl`, us-east-2, Postgres 17.6)
**Date:** 2026-10-05
**Scope:** Live database: Supabase security advisor, table/view/function grants, RLS policies, exposed schemas, storage, auth users, extensions. Cross-checked against `supabase/*.sql` and worker code.
**Mode:** Read-only. Nothing was changed. Every query was a catalog read or a row count.

---

## How to read this

The project's security model is **"workers hold the service key; nobody else reads PostgREST."** Almost every table has RLS enabled with **zero policies**, so `anon` and `authenticated` get nothing *from tables*. The real exposure comes from four things that get around that wall:

1. **SECURITY DEFINER views.** They run as `postgres`, which bypasses RLS.
2. **The few tables that do have permissive policies.**
3. **Who can obtain an `authenticated` JWT.** Every one of the 103 staff users can, and possibly anyone if open signup is on (see H2).
4. **The anon key.** It is effectively public, because the JotForm prefill widget reads `jotform_site_lookup` with it.

Session cookies are `HttpOnly; Secure; SameSite=Lax` (`packages/auth/src/cookies.ts:39`), so XSS cannot steal a token. A signed-in user can still copy their own token from devtools and call `/rest/v1/*` directly with it. **The threat actor is a curious or disgruntled insider, or anyone who can self-register.**

Severity: **HIGH** = exploitable today against sensitive data. **MED** = real but narrower, or one mistake away. **LOW** = hygiene and defence-in-depth.

---

## HIGH

### H1. `anon-view-revoke-03.sql` says "APPLIED" — it was not applied — RESOLVED 2026-10-05
**Applied 2026-10-05 as migration `anon_view_revoke_03`.** Verified afterwards:
- All 25 views are now `security_invoker`.
- `authenticated` can read only 2 public views: `pricing_simple_resolved` and `jotform_site_lookup`.
- Anon can still read `jotform_site_lookup` (84 rows), so the JotForm widget is unaffected.
- The 7 functions are `service_role` only.
- Both `_dev` views have been dropped.

M1's column-narrowing of `jotform_site_lookup` is still open. Original finding below.

`supabase/anon-view-revoke-03.sql` line 3 reads `APPLIED 2026-10-02 against production`. The live database contradicts that on every point:

| What the file does | Live state 2026-10-05 |
|---|---|
| `security_invoker = on` for 25 views | **All 25 have `reloptions = null`** (still definer). The advisor flags 29 definer views. |
| Revoke `SELECT` from `authenticated` on those 25 | **`authenticated` still has SELECT on all 25** |
| Revoke EXECUTE on 7 greeter/location functions | **anon + authenticated can still EXECUTE all 7**, including `greeter_restamp_goals` and `site_restamp_monthly_targets` (both write) |
| Drop `fraud_stats_dev`, `recent_warnings_dev` | **Both still exist.** `recent_warnings_dev` returns 20 rows of customer phone numbers. |

The file is also untracked in git (`?? supabase/anon-view-revoke-03.sql`). Revokes 01 and 02 *did* land: `anon` has no SELECT on these views.

**Impact:** any signed-in user can take their access token and read the following straight off PostgREST, skipping every worker permission gate:
- `mt_punch_out_of_footprint`: employee **GPS lat/lon** at punch in/out (111 rows)
- `mt_punch_detail`, `mt_mechanic_day/week/workload`, `mt_device_health`, `mt_field_crew`, `mt_offsite_time`: named employee time and location tracking
- `location_daily_live`, `greeter_daily_live`, `daily_signups_by_location`, `mt_cost_*`: per-site daily P&L, labour budget, revenue, and per-greeter sales
- `unsynced_signups`: customer phone, IP, and city (0 rows right now, but fills whenever sync lags)
- `recent_warnings_dev`, `fraud_stats_dev`: customer phone numbers flagged by fraud detection

**Fix:** re-check that nothing changed since the file was written, apply it, and correct its header. The file's own "why nothing breaks" analysis (no code queries PostgREST as `authenticated`) still holds: no hardcoded keys or `createAnonClient` callers were found in the repo.

### H2. ~~Unverified: is Supabase Auth open signup enabled?~~ — RESOLVED 2026-10-05
**Operator confirmed 2026-10-05: "Allow new users to sign up" is DISABLED.** H1 and H3 are therefore insider-only (the 103 existing accounts), not internet-wide. Still worth confirming anonymous sign-ins are also off. Original note kept below for context.

This can't be read from SQL. If **Authentication → Sign In / Providers → "Allow new users to sign up"** is ON, anyone with the anon key can `POST /auth/v1/signup`. That key is public via the JotForm widget. Signing up gets them an `authenticated` JWT, and with it everything in H1 and H3. That turns an insider problem into an internet-wide one.

Context: all 103 users are confirmed, 0 are anonymous, and 3 were created in the last 30 days (presumably via sysadmin). Accounts are only ever created through `sysadmin-worker` with the service key, so open signup serves no purpose here.

**Fix:** confirm it is OFF. Also confirm anonymous sign-ins are OFF.

### H3. `shortbreak`: any signed-in user can read, edit, and delete every row — RESOLVED 2026-10-05
**Archived and locked down 2026-10-05** (migration `shortbreak_archive_01`, file `supabase/shortbreak-archive-01.sql`). What changed:
- The four open policies are dropped and all anon/authenticated grants are revoked.
- The table now lives at `archive.shortbreak`. That schema isn't served by the API, and anon/authenticated have no access to it.
- All 1,154 rows are kept, with RLS still on.

The table had no callers in the repo. It was filled by an external nightly job, now retired, whose last load was 2025-10-27. Original finding below.

There are four policies for `authenticated`: SELECT, INSERT, UPDATE, and DELETE, all `USING (true)` / `WITH CHECK (true)`. The table holds 1,154 rows of named-employee clock-in/out, hours worked, break minutes, and `worked_6h_short_break`. That is labour-law compliance evidence, which anyone can quietly rewrite or wipe.

**Fix:** drop the four policies (workers use the service key). If a UI needs it, scope the policies by role or location.

---

## MEDIUM

### M1. The management email directory is readable with the anon key — PARTLY RESOLVED 2026-10-05
**The `pricing_simple` half is done** (migration `pricing_fleet_lockdown_01`, file `supabase/pricing-fleet-lockdown-01.sql`):
- The anon policy is dropped and all anon/authenticated grants are revoked.
- Signup's anon read of `pricing_simple_resolved` was verified afterwards (353 rows as `anon`).
- Before applying, the API logs showed no anonymous reads of the base table. The only anonymous caller in the code was fleet, which the operator confirmed is not in production use.

**Still open: `jotform_site_lookup`.** The widget calls `?site_number=eq.N&select=*` (~150–175/day per API logs), so the logs can't show which columns it uses. It needs the operator to list the fields the widget prefills.

- **`jotform_site_lookup`** (definer view, `anon` SELECT, 84 rows) exposes `general_manager`, `general_manager_email`, `area_manager`, `am_email`, `regional_manager`, `rm_email`, `hrt_email`, `site_email`, and `rm_group`. The revoke-03 header already notes "Still exposes the whole management email directory; narrowing it to the columns the widget uses is the next step." That step is still open.
- **`pricing_simple`** has policy `"Public can read pricing_simple"`: `anon` SELECT `USING (true)`. It exposes `am_email`, `rm_email`, `site_email`, manager names, and site addresses. The customer-facing readers use `pricing_simple_resolved`, which has no emails. Every worker that reads the base table found in the repo uses the service key.

This is a ready-made phishing list of every manager plus HR, reachable by anyone who views a JotForm source.
**Fix:** replace `jotform_site_lookup` with a view of only the columns the widget reads. Drop the anon policy on `pricing_simple` after confirming nothing reads the base table anonymously. Workers bypass RLS anyway.

### M2. `fleet_submissions`: anyone can insert directly, bypassing Turnstile — RESOLVED 2026-10-05
**The anon insert policy is dropped and anon/authenticated grants are revoked** (`pricing_fleet_lockdown_01`). Fleet is not in production use (operator, 2026-10-05). Both fleet workers still serve the form, but it now shows no locations and can't submit. The steps to revive it are in the SQL file header; the preferred route is moving the public form to `SUPABASE_SERVICE_KEY`. Note that CLAUDE.md constraint #9 still describes `broad-shape-38b8` as serving real fleet traffic.

Policy `"Allow anonymous inserts"` is role `public`, INSERT, `WITH CHECK (true)`. The fleet worker inserts with the anon key (`apps/fleet-inquiry-worker/src/index.js:387`), so the worker's Turnstile check only guards the worker. Anyone can POST rows straight to `/rest/v1/fleet_submissions`, with any `status`, `splash_notes`, or `ip_address`, and those rows feed the Power Automate → SharePoint sync.
**Fix:** switch the fleet insert to `SUPABASE_SERVICE_KEY` (already bound for admin reads) and drop the policy. Short of that, add a `WITH CHECK` that pins `status = 'new'` and nulls the staff-only columns.

### M3. Blanket write grants on every table — RLS is the only wall — RESOLVED 2026-10-05
**Applied 2026-10-05** (migration `grant_lockdown_01`, file `supabase/grant-lockdown-01.sql`). What changed:
- anon/authenticated lost all access to every table, view and sequence in `public`.
- Project functions are now service_role-only.
- Only `pricing_simple_resolved` and `jotform_site_lookup` stay anon-readable.
- `postgres` default privileges no longer auto-grant anon/authenticated, so public access is opt-in from now on.

Operator smoke test passed 2026-10-05: a customer signup page and a JotForm form with the site widget both work.

Remaining gap: `supabase_admin`'s default ACL still grants anon/authenticated. It can't be changed from `postgres`; the objects it creates are platform-internal. Original finding below.

`anon` and `authenticated` hold `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES` on essentially every `public` table (Supabase's default privileges). Today RLS with zero policies blocks it. But:
- One mistaken `CREATE POLICY ... USING (true)` or `DISABLE ROW LEVEL SECURITY` immediately exposes that table for write as well as read. `shortbreak` (H3) shows how this happens.
- **`TRUNCATE` is not subject to RLS.** PostgREST can't issue it, but any SECURITY INVOKER function reachable over RPC that truncates would be.

Highest-value tables currently protected *only* by RLS: `maxpass_signups` (~49k customer rows), `jotform_submissions` (~64k), `user_permissions`, `damage_claim_user_roles`, `promo_user_roles`, `sysadmin_audit_log`, `outbound_emails`, `beekeeper_users`, `phone_usage_log`, and all `mx_*` and `mt_*` tables.
**Fix:** `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;`, then re-grant only what is deliberately public (`pricing_simple_resolved`, the narrowed jotform view, and fleet insert if kept). Also `ALTER DEFAULT PRIVILEGES ... REVOKE` so new tables don't inherit the grants.

### M4. `pricing_simple` write policies for `authenticated` — RESOLVED 2026-10-05
**Both policies are dropped** (`pricing_fleet_lockdown_01`). Only `"Service role full access"` remains on `pricing_simple`.

- `"Super admins full access"` lets any `user_permissions.role = 'super_admin'` user INSERT, UPDATE, or DELETE pricing directly over PostgREST, **bypassing `sysadmin_audit_log`** and the trigger-column guard sysadmin-worker enforces.
- `"Email-based location access"` (ALL) calls `user_has_location_access()`, which `authenticated` has **no EXECUTE** on, so for non-super-admins the policy throws instead of filtering. It is broken, which is safe but fragile: one future `GRANT EXECUTE` turns it into location-admin direct writes.
**Fix:** drop both. All pricing writes go through workers with the service key.

### M5. Auth hygiene
- **Leaked password protection is disabled** (advisor WARN). Turn on the HaveIBeenPwned check.
- **MFA:** 40 factors across 103 users. Consider requiring it for anyone with `super_admin`, `admin`, or `it` roles.
- **Dormant accounts:** 33 users have never signed in, and 18 haven't signed in for over 180 days. Each is a valid credential that nobody is watching. Review them and ban or delete.

---

## LOW

| # | Finding | Fix |
|---|---|---|
| L1 | anon/authenticated can EXECUTE `insert_expense_entry`, `update_expense_entry`, `copy_expense_budget_month`, `next_expense_po`, `expense_month_rollup`, `expense_labor_rate_for`, `expense_po_text`, `greeter_goal_for`, `site_monthly_target_for`, plus the H1 seven. They are SECURITY INVOKER, so RLS blocks the writes, but each is a public RPC endpoint (load bounded by the 3s anon / 8s authenticated `statement_timeout`). | `REVOKE EXECUTE ... FROM public, anon, authenticated`; grant to `service_role`. |
| L2 | 26 functions have a mutable `search_path`. The notable one is `user_has_location_access`, which is **SECURITY DEFINER without `search_path`**, the classic hijack shape. Exploitation needs CREATE on a schema in the path, which anon/authenticated don't have, so the risk is low. | `ALTER FUNCTION ... SET search_path = ''` (or `public, pg_temp`), starting with the definer one. |
| L3 | `extensions.http` (outbound HTTP from Postgres) is EXECUTE-able by `anon`. `extensions` isn't a PostgREST schema, so it isn't reachable today, but it is an SSRF primitive for any future function. | Revoke from anon/authenticated. Drop the extension if unused. |
| L4 | `pg_trgm` and `btree_gist` are installed in `public`, which exposes ~200 helper functions as RPCs (`set_limit` etc.). These are harmless but noisy. | Move them to the `extensions` schema. |
| L5 | Storage bucket `JFWidget` is **public**, with no size or MIME limits. It contains only `.emptyFolderPlaceholder`. There are no `storage.objects` policies, so nobody can upload. | Delete it if unused; otherwise set limits. |
| L6 | Dev tables are in production: `phone_usage_log_dev` has an **anon INSERT policy** (anyone can write rows), and `suspicious_phones_dev` has full `authenticated` grants. | Drop them, together with the two `_dev` views in H1. |
| L7 | `maxpass_signups` and `user_tool_access` policies target role `public` rather than a specific role. Both are logically correct (service_role only, and own rows only). | Cosmetic. Retarget for clarity. |

---

## What's in good shape

- **RLS is enabled on every table in every schema** (`public`, `inventory`, `storage`). No table is missing RLS.
- The `inventory` schema has no `anon`/`authenticated` USAGE, so it is not reachable over the API.
- `auth_unified` (reads `auth.users`) is not granted to anon/authenticated.
- `vault.secrets` is empty, and no tables are in a realtime publication.
- `safeupdate` is preloaded on `authenticator` (blocks UPDATE/DELETE without WHERE), and per-role statement timeouts are set.
- No Supabase JWTs or `sb_secret_` / `sb_publishable_` keys are hardcoded anywhere in the repo.
- Self-scoped policies on `user_permissions`, `damage_claim_user_roles/locations`, and `user_tool_access` are correct (`user_id = auth.uid()`, SELECT only).
- `anon-view-revoke-01/02` did land: `anon` can no longer read the 24 analytics views.

---

## Suggested order of work

1. ~~**Check the open-signup setting (H2).**~~ Done 2026-10-05: signup is disabled.
2. ~~**Apply `anon-view-revoke-03.sql` (H1)**~~ Done 2026-10-05; header corrected. Still to commit the file.
3. ~~**Drop the `shortbreak` policies (H3)**~~ Done 2026-10-05 (archived). ~~`pricing_simple` policies (M1, M4)~~ Done 2026-10-05.
4. **Narrow `jotform_site_lookup` (M1)**. This needs the list of widget fields. ~~Fleet insert (M2)~~ Done 2026-10-05 (fleet dormant; policy dropped).
5. ~~**Blanket `REVOKE` plus default-privilege change (M3).**~~ Done 2026-10-05.
6. Enable leaked-password protection, review dormant users (M5), and clear the LOW list.

## Re-running this check

- Advisor: Supabase dashboard → Advisors → Security, or MCP `get_advisors(type: security)`.
- Exposure query, all relations with anon/authenticated grants plus RLS/policy counts:
  ```sql
  select c.relname, c.relkind, c.relrowsecurity rls, c.reloptions,
    (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) policies,
    has_table_privilege('anon', c.oid, 'SELECT') anon_sel,
    has_table_privilege('authenticated', c.oid, 'SELECT') auth_sel
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','v','m') order by 2,1;
  ```
- Permissive policies: `select * from pg_policies where schemaname='public' and (qual='true' or with_check='true');`
