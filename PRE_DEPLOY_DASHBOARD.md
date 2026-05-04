# PRE_DEPLOY — dashboard-worker

SSO entry point. Owns `POST /api/login`, `POST /api/logout`, `POST /api/forced-reset`. No D1, no R2, no Images binding. Cookie-based auth via `@splash/auth`; `must_change_password` gate enforced post-login (the bug fix from the dashboard port — see `packages/auth/src/index.ts` security contract).

Worker name: `splash-dashboard`. Currently deployed only to its `*.workers.dev` URL.

---

## Required secrets (`wrangler secret put`)

```bash
pnpm --filter @splash/dashboard-worker exec wrangler secret put SUPABASE_URL
pnpm --filter @splash/dashboard-worker exec wrangler secret put SUPABASE_ANON_KEY
pnpm --filter @splash/dashboard-worker exec wrangler secret put SUPABASE_SERVICE_KEY
```

| Name | Type | Purpose |
|---|---|---|
| `SUPABASE_URL` | string | base URL of the Supabase project |
| `SUPABASE_ANON_KEY` | secret | used for `/auth/v1/token` + `/auth/v1/user` |
| `SUPABASE_SERVICE_KEY` | secret | used for `auth_unified` reads via `@splash/db-supabase` (RLS bypass) |

`SUPABASE_URL` can also be set as a plain `[vars]` entry if you'd rather not treat it as a secret — it's the public project URL.

## Required bindings

None beyond the secrets above. No D1, no R2, no Images.

## Smoke-test checklist

After `pnpm --filter @splash/dashboard-worker deploy`:

```bash
# Replace ACCOUNT with your CF account subdomain.
WORKER=https://splash-dashboard.<ACCOUNT>.workers.dev

# 1. Wrong creds → 401, no Set-Cookie.
curl -i -X POST "$WORKER/api/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "email=nobody@example.com&password=wrong"

# 2. Unauthenticated forced-reset → 401.
curl -i -X POST "$WORKER/api/forced-reset" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "new_password=Whatever123&confirm_password=Whatever123"

# 3. Cross-origin POST → 403 bad origin (CSRF retrofit).
curl -i -X POST "$WORKER/api/login" \
  -H "Origin: https://malicious.example.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "email=nobody@example.com&password=whatever"

# 4. Logout always returns 302 to /, sets clearing cookies.
curl -i -X POST "$WORKER/api/logout"

# 5. Successful login (real test account) → 302 to /admin (or /change-password
#    if must_change_password=true), Set-Cookie sb-access-token + sb-refresh-token.
curl -i -X POST "$WORKER/api/login" \
  -H "Origin: $WORKER" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "email=<real>&password=<real>"
```

**Manual checks:**

- [ ] A user with `must_change_password = true` lands on `/change-password?required=true` after login (not bypassed).
- [ ] After `userCompleteForcedReset` succeeds, the same user logging in goes straight to `/admin` (flag was cleared).
- [ ] Logout clears both `sb-access-token` and `sb-refresh-token`.

## Production route binding (cutover-time)

In `apps/dashboard-worker/wrangler.toml`, uncomment:

```toml
routes = [
  { pattern = "splashcarwashes.info/api/login",        zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/api/logout",       zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/api/forced-reset", zone_name = "splashcarwashes.info" }
]
```

Then redeploy. dashboard-worker has no production traffic today, so cutover is low-risk — bind whenever apps/web is ready to consume the auth flow.
