# PRE_DEPLOY — sysadmin-worker

User-management JSON API. Super_admin only — every endpoint gates on `auth.session.role === "super_admin"` after `authenticate()`. CSRF retrofit (Chunk 5) at the top of `fetch()` covers all 5 mutation endpoints with one `isOriginAllowed` check.

Worker name: `splash-sysadmin`. Currently deployed only to its `*.workers.dev` URL.

---

## Required secrets (`wrangler secret put`)

```bash
pnpm --filter @splash/sysadmin-worker exec wrangler secret put SUPABASE_URL
pnpm --filter @splash/sysadmin-worker exec wrangler secret put SUPABASE_ANON_KEY
pnpm --filter @splash/sysadmin-worker exec wrangler secret put SUPABASE_SERVICE_KEY
```

| Name | Type | Purpose |
|---|---|---|
| `SUPABASE_URL` | string | base URL of the Supabase project |
| `SUPABASE_ANON_KEY` | secret | session validation via `/auth/v1/user` |
| `SUPABASE_SERVICE_KEY` | secret | Supabase Admin API + writes to `user_permissions`, `user_tool_access`, `sysadmin_audit_log` |

## Required bindings

None beyond the secrets above. No D1, no R2, no Images.

## Smoke-test checklist

After `pnpm --filter @splash/sysadmin-worker deploy`:

```bash
WORKER=https://splash-sysadmin.<ACCOUNT>.workers.dev

# 1. Unauthenticated → 401 on every endpoint.
curl -i -X POST "$WORKER/sysadmin/api/grant-tool" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" --data '{}'

# 2. Cross-origin POST → 403 bad origin.
curl -i -X POST "$WORKER/sysadmin/api/grant-tool" \
  -H "Origin: https://malicious.example.com" \
  -H "Content-Type: application/json" \
  --data '{}'

# 3. Authenticated non-super_admin → 403 forbidden.
#    (Use a location_admin's session cookie — the gate rejects without
#    even parsing the body.)
curl -i -X POST "$WORKER/sysadmin/api/grant-tool" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" \
  -H "Cookie: sb-access-token=<location_admin token>" \
  --data '{"user_id":"abc","tool":"pricing"}'

# 4. super_admin grant-tool happy path → 200 { ok, was_new }.
#    Audit row should land in sysadmin_audit_log with action="grant_tool".
curl -i -X POST "$WORKER/sysadmin/api/grant-tool" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" \
  -H "Cookie: sb-access-token=<super_admin token>" \
  --data '{"user_id":"<test user_id>","tool":"pricing"}'

# 5. Idempotent re-grant → 200 { ok, was_new: false }, no second audit row.
#    (Repeat step 4 immediately.)

# 6. apiCreateUser writes user_permissions with must_change_password=TRUE
#    (Chunk 5 policy fix).
curl -i -X POST "$WORKER/sysadmin/api/create-user" \
  -H "Origin: $WORKER" -H "Content-Type: application/json" \
  -H "Cookie: sb-access-token=<super_admin token>" \
  --data '{"email":"newuser+test@splashcarwashes.com","password":"NewPassword123","role":"location_admin","tools":["pricing"]}'
```

**Manual checks:**

- [ ] After `apiCreateUser`, query `user_permissions` for the new user — `must_change_password` must be `true` (Chunk 5 policy; legacy default was `false`).
- [ ] After `apiResetPassword`, the user's `must_change_password` flips back to `true` (Chunk 5: admin-side password sets always force forced-reset).
- [ ] After `apiSetRole`, the user's existing `must_change_password` value is **preserved** (read-modify-write, NOT clobbered to `false` like legacy did).
- [ ] Audit rows in `sysadmin_audit_log` carry the actor's email + action + target_id correctly.

## Production route binding (cutover-time)

In `apps/sysadmin-worker/wrangler.toml`, uncomment:

```toml
routes = [
  { pattern = "splashcarwashes.info/sysadmin/api/*", zone_name = "splashcarwashes.info" }
]
```

Then redeploy. apps/web's `/sysadmin/*` UI pages route separately to apps/web; the worker only owns `/sysadmin/api/*` post-cutover. sysadmin-worker has no production traffic today; cutover is low-risk.
