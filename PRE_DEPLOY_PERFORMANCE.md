# PRE_DEPLOY — performance-worker

Owns `/pertrack/*` (the prefix is stripped internally). Endpoints: `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET /api/locations`, `POST /api/submissions`, `GET /api/submissions`. 8-hour access cookie, no refresh token (the worker that's "the odd one out" cookie-wise — `buildAuthCookies` supports this via the `null` refresh-token signature).

Worker name: `splash-performance`. Currently deployed only to its `*.workers.dev` URL.

---

## Required secrets (`wrangler secret put`)

```bash
pnpm --filter @splash/performance-worker exec wrangler secret put SUPABASE_URL
pnpm --filter @splash/performance-worker exec wrangler secret put SUPABASE_ANON_KEY
pnpm --filter @splash/performance-worker exec wrangler secret put SUPABASE_SERVICE_KEY
```

| Name | Type | Purpose |
|---|---|---|
| `SUPABASE_URL` | string | base URL of the Supabase project |
| `SUPABASE_ANON_KEY` | secret | used for `/auth/v1/token` + `/auth/v1/user` |
| `SUPABASE_SERVICE_KEY` | secret | reads/writes against `locations` and `performance_tracking` |

**RENAME NOTE:** the legacy `legacy/performancetracker.js` referenced `SUPABASE_SERVICE_ROLE_KEY`. The migration plan standardized on `SUPABASE_SERVICE_KEY` across all 5 workers; this worker now matches. **Update the env var name in the Cloudflare dashboard before deploying** — if you set `SUPABASE_SERVICE_ROLE_KEY` instead, every authenticated read/write 401s.

## Required bindings

None beyond the secrets above. No D1, no R2, no Images.

## Smoke-test checklist

After `pnpm --filter @splash/performance-worker deploy`:

```bash
WORKER=https://splash-performance.<ACCOUNT>.workers.dev

# 1. Public health: /api/me without cookie → 401.
curl -i "$WORKER/api/me"

# 2. Cross-origin POST → 403 bad origin (CSRF retrofit).
curl -i -X POST "$WORKER/api/login" \
  -H "Origin: https://malicious.example.com" \
  -H "Content-Type: application/json" \
  --data '{"email":"x@y.z","password":"anything"}'

# 3. Login (real account with "pertrack" tool grant or super_admin):
curl -i -X POST "$WORKER/api/login" \
  -H "Origin: $WORKER" \
  -H "Content-Type: application/json" \
  --data '{"email":"<real>","password":"<real>"}'
# → 200 { email }, Set-Cookie sb-access-token; Max-Age=28800 (8h)
# → NO sb-refresh-token (this worker's distinguishing pattern)

# 4. Locations search with the cookie from step 3:
curl -i "$WORKER/api/locations?q=bing" -H "Cookie: sb-access-token=<token>"
# → 200 array of locations matching site_number / site / mla_location / location

# 5. List submissions:
curl -i "$WORKER/api/submissions?limit=5" -H "Cookie: sb-access-token=<token>"

# 6. Logout:
curl -i -X POST "$WORKER/api/logout" -H "Origin: $WORKER"
# → 200 { ok: true }, Set-Cookie clearing both tokens
```

**Manual checks:**

- [ ] User WITHOUT the `pertrack` tool grant gets 403 on `/api/locations` even with a valid login cookie.
- [ ] super_admin bypasses the tool grant (no `pertrack` row needed in `user_tool_access`).
- [ ] `POST /api/submissions` writes a row with `submitted_by = session.userId` and `submitted_by_email = session.email`.

## Production route binding (cutover-time)

In `apps/performance-worker/wrangler.toml`, uncomment:

```toml
routes = [
  { pattern = "splashcarwashes.info/pertrack/*", zone_name = "splashcarwashes.info" }
]
```

Then redeploy. performance-worker has no production traffic today; cutover is low-risk.
