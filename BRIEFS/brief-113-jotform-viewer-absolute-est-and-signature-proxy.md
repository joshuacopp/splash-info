# Brief 113: JotForm viewer — absolute EST timestamps + signature/file asset proxy

**Status:** Completed (2026-05-12)
**Started:** 2026-05-12
**Completed:** 2026-05-12
**Blocks:** Neither — visible bugs (relative timestamps make
operators do math; broken signature images make the detail page
look unfinished), but the underlying data is correct in Supabase.
**Dependencies:** Brief 109 (viewer foundation), Brief 111
(formatEst helper + form-columns registry), Brief 112 (detail page
renderer + signature `<img>` tag this brief fixes).

## Read first

- CLAUDE.md (esp. **JotForm submissions** + **jotform-worker**
  glossary entries — adds asset-proxy endpoint paragraph here)
- BRIEFS/brief-111-jotform-viewer-per-form-columns-and-est-and-location-pretty.md
  (Outcome — `formatEst()` location + `submittedColumn()` signature)
- BRIEFS/brief-112-jotform-viewer-content-polish.md (Outcome —
  the `answer-renderer.tsx` module + signature `<img>` line that
  this brief retargets at the proxy)
- apps/web/app/admin/jotform/_lib/format-est.ts (Brief 111
  helper — relative vs absolute return shape)
- apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx
  (`submittedColumn()` — this brief flips its render output)
- apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx
  (Brief 112 — `control_signature` + `control_fileupload` branches
  point at raw JotForm URLs; this brief retargets them at the
  proxy)
- apps/jotform-worker/src/handlers/admin.js (where the new
  asset-proxy endpoint lives)
- apps/jotform-worker/src/jotform.js (`JOTFORM_API_KEY` reading
  pattern + `JOTFORM_BASE_URL` for upload origin validation)

## Context

Operator review on 2026-05-12 surfaced two bugs in the live viewer
post-Brief-112:

1. **"Submitted (EST)" column displays relative time, not absolute
   EST time.** Brief 112's executor renamed the column header to
   "Submitted (EST)" but `submittedColumn()` still renders
   `formatEst(iso).relative` (e.g., "5 hr ago") with the absolute
   EST string only in the `title` attribute (hover-only).
   Operator intent was the EST timestamp visible, not relative.
   Also: "5 hr ago" is inherently misleading on a deployment that
   just went live — operators can't validate freshness when every
   row reads as a relative offset.

   Fix: `submittedColumn()` renders the **absolute EST timestamp
   verbatim** (e.g., "May 12, 7:25 AM"). Relative time stays in
   the `title` attr as supplementary info on hover.

2. **Signature images broken on the detail page.** Brief 112's
   `control_signature` branch in `answer-renderer.tsx` renders
   `<img src={url}>` where `url` is the JotForm CDN URL
   (`https://splashcarwashes.jotform.com/uploads/!team_.../...png`).
   These URLs require authentication that the browser can't supply
   when loading cross-origin from apps/web — they 401 / 403 / load
   blank. Operator sees broken-image icons with "Signature" alt
   text where the inline signature should render.

   Fix: add a worker-side asset proxy at
   `GET /admin/jotform/api/asset?url=<encoded JotForm URL>` that
   validates the URL origin against `JOTFORM_BASE_URL` and streams
   the bytes back with the `JOTFORM_API_KEY` attached. apps/web's
   signature + fileupload renderers point at the proxy instead of
   the raw URL. Same-origin + cookie-authenticated, so the
   `<img>` loads cleanly.

The same proxy serves `control_fileupload` arrays (rewash form
has Photo of Barcode/Plate and Wash Book Ticket uploads; both
empty arrays on every observed sample to date but the same auth
constraint would apply once data appears).

A third operator ask — **dashboard tile consolidation** ("merging
some of these dashboard functions/buttons into categories to
avoid all of this sprawl") — is acknowledged but deferred to a
follow-up brief. The current 8-tile grid (MaxPass Admin / Damage
Claims / Performance Tracking / Database Admin / MaintainX / Fleet
Inquiries / Forms / JotForm) will grow further; a category-grouped
treatment needs its own planning conversation. Out of scope for
Brief 113.

## Scope

### Phase 1 — Worker asset-proxy endpoint

Add `GET /admin/jotform/api/asset?url=<encoded>` to
`apps/jotform-worker/src/handlers/admin.js` (new handler function
+ wire into the dispatcher).

Handler outline:

```js
async function handleAssetProxy(request, env) {
  const gate = await authenticateForAdminApi(request, env);
  if (!gate.ok) return gate.response;

  if (!env.JOTFORM_API_KEY) {
    return jsonError(503, "JOTFORM_API_KEY unbound");
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return jsonError(400, "url required");

  // Validate the target is a JotForm upload URL on the expected
  // host. Reject everything else — this proxy must NOT become an
  // open-redirect / SSRF surface.
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError(400, "invalid url");
  }
  const expectedHost = new URL(env.JOTFORM_BASE_URL).host;
  if (targetUrl.host !== expectedHost) {
    return jsonError(400, "url host not allowed");
  }
  if (!targetUrl.pathname.startsWith("/uploads/")) {
    return jsonError(400, "only /uploads/ paths allowed");
  }

  // JotForm asset URLs accept an `apikey` query param to
  // authenticate the fetch. Don't preserve any existing query
  // params on the target (avoid surprises).
  targetUrl.search = "";
  targetUrl.searchParams.set("apikey", env.JOTFORM_API_KEY);

  let resp;
  try {
    resp = await fetch(targetUrl.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (err) {
    console.error("[jotform.asset-proxy] upstream fetch failed:", err);
    return jsonError(502, "upstream fetch failed");
  }

  if (!resp.ok) {
    console.warn("[jotform.asset-proxy] upstream non-2xx:", resp.status);
    return jsonError(resp.status === 404 ? 404 : 502, "upstream error");
  }

  // Stream the body back. Preserve Content-Type so the browser
  // renders images / PDFs inline; force a cache-control short
  // window so updates land within minutes.
  const ct = resp.headers.get("Content-Type") || "application/octet-stream";
  return new Response(resp.body, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
```

Wire into the dispatcher in `handleAdminApi` — check for path
`/admin/jotform/api/asset` after the existing routes; this is a
GET endpoint (no method-switch needed beyond rejecting non-GET).

Auth posture: `authenticateForAdminApi` (any authenticated session)
— same as the per-form list / detail endpoints. The proxy doesn't
scope by `accessibleSiteNumbersForSession` because the asset URL
is opaque — the only way to obtain one is from a row the caller
can already see (the worker scopes that). A user can't probe other
RMs' signatures because they can't guess the submission UUID
embedded in the URL.

Anti-SSRF: host + path-prefix check rejects anything that isn't
`{JOTFORM_BASE_URL host}/uploads/...`. No redirect-following
beyond that — `fetch()` follows redirects by default; if JotForm
ever bounces a 302 to an off-host URL we'd want to either set
`redirect: "manual"` and reject, or set up an explicit allow-list.
Brief-time observation: JotForm uploads serve 200 directly, no
redirects. Add `redirect: "manual"` defensively anyway.

### Phase 2 — apps/web fetch helper

Edit `apps/web/app/admin/jotform/_lib/worker-fetch.ts` to add an
`assetProxyUrl(jotformUrl: string): string` helper:

```ts
/**
 * Build a same-origin proxy URL for a JotForm-hosted asset
 * (signatures, file uploads). The browser loads the proxy URL
 * with the apps/web session cookie; the worker validates auth,
 * fetches the JotForm asset with the API key, and streams it
 * back. No raw cross-origin <img src=jotform.com> loads anywhere.
 */
export function assetProxyUrl(jotformUrl: string): string {
  return `/admin/jotform/api/asset?url=${encodeURIComponent(jotformUrl)}`;
}
```

No service-binding consideration — this URL is built into rendered
HTML as an `<img src>`; the browser fetches it same-origin via the
already-bound staging route. The worker handles the binding side.

### Phase 3 — Detail page renderer retarget

Edit
`apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`:

3.1 `control_signature` branch — replace the raw URL with the
proxy URL:

```tsx
case "control_signature": {
  const url = typeof entry.answer === "string" ? entry.answer.trim() : "";
  if (!url) return null;
  return (
    <img
      src={assetProxyUrl(url)}
      alt="Signature"
      className="max-w-xs border border-splash-navy/20 bg-white p-1"
    />
  );
}
```

3.2 `control_fileupload` branch — same swap on each item in the
gallery:

```tsx
{items.map((url) => (
  <a key={url} href={assetProxyUrl(url)} target="_blank" rel="noreferrer">
    <img
      src={assetProxyUrl(url)}
      alt="Upload"
      className="h-24 w-24 object-cover border border-splash-navy/20"
    />
  </a>
))}
```

Import `assetProxyUrl` from `../../_lib/worker-fetch` (sibling-up
two levels).

### Phase 4 — List page absolute timestamp

Edit `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx`'s
`submittedColumn()`:

```ts
export function submittedColumn(): FormColumn {
  return {
    key: "submitted",
    label: "Submitted (EST)",
    render: (row) => {
      const iso = row.jotform_created_at;
      if (!iso) return muted();
      const { absolute, relative } = formatEst(iso);
      return (
        <span title={relative} className="whitespace-nowrap">
          {absolute}
        </span>
      );
    }
  };
}
```

The flip: `absolute` is now the visible value, `relative` moves
into the `title` attr (hover-on-desktop, ignored on mobile —
acceptable since the absolute is the primary surface).

Also: check the detail page metadata section. Per Brief 112 it
already uses `formatEst()` — verify it's rendering absolute, not
relative. The screenshot from the operator review showed
"May 12, 2026, 3:26 AM EDT · 5 hr ago" — that's correct (absolute
+ relative), no change needed there. If a `formatEst().relative`
ever appears as the primary surface anywhere else, swap it.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 `pnpm --filter @splash/jotform-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
    after.
5.4 No Supabase / R2 / wrangler.toml / secret changes. The worker
    already has `JOTFORM_API_KEY` + `JOTFORM_BASE_URL` bound from
    Brief 107.
5.5 Operator post-deploy smoke (deferred):
    - Load `/admin/jotform/250165655616055` (rewash) — list
      column "Submitted (EST)" shows "May 12, 7:25 AM" style
      strings, not "5 hr ago".
    - Hover any row's Submitted cell — `title` tooltip shows the
      relative ("5 hr ago" / "in 2 days" / etc.).
    - Click into a row with a signature — the inline `<img>`
      renders the actual signature, not a broken image icon.
    - Same for retention / time-card-edit signatures.
    - Network tab: signature requests go to
      `/admin/jotform/api/asset?url=...`, not directly to
      `splashcarwashes.jotform.com`. Status 200, Content-Type
      `image/png` (or whatever JotForm serves).
    - Test the SSRF guard: hit
      `/admin/jotform/api/asset?url=https://evil.example.com/x.png`
      directly — should return 400 "url host not allowed".

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 113 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 113 (YYYY-MM-DD) — JotForm viewer fixed the
    "Submitted (EST)" list column to render absolute EST
    timestamps (relative moves to hover title); added asset-proxy
    endpoint `GET /admin/jotform/api/asset?url=...` so signature
    + fileupload renderers can authenticate to JotForm's CDN
    via the worker's `JOTFORM_API_KEY` instead of the browser
    making unauthenticated cross-origin requests.
  - Anti-SSRF: host + `/uploads/` path-prefix allow-list, manual
    redirect handling, 10s upstream timeout.

6.3 CLAUDE.md "JotForm submissions" / "jotform-worker" glossary
entries: append a line documenting the asset-proxy endpoint
(`GET /admin/jotform/api/asset?url=<encoded>` — auth same as
`/submissions`, host-validated, streams back with
`Cache-Control: private, max-age=300`).

## Out of scope

- Dashboard tile consolidation / category grouping. Operator
  flagged it on 2026-05-12 as the next planning conversation
  ("then we'll look at merging some of these dashboard
  functions/buttons into categories to avoid all of this sprawl");
  scope it as a separate brief once we sketch the categorization.
- CSV inclusion of asset URLs. Brief 96-style schema-union CSV
  already includes the raw JotForm URLs; converting them to proxy
  URLs in the CSV would also work but operators export-then-open-
  outside-browser anyway, where the proxy URL needs an apps/web
  session. Leave raw URLs in CSV; deferred to v2 if operators
  report needing it.
- Per-form facet filters (Rewash Reason / Reason For Cancellation
  / etc.). Still deferred to a separate brief once Brief 113's
  polish lands.
- Caching the proxy responses at edge / R2. v1 is per-request +
  5-minute browser cache; if proxy traffic becomes meaningful,
  consider an R2 cache layer keyed by the JotForm URL hash. v2.
- Adding asset-proxy traffic to a rate-limit. Worker's overall
  inbound traffic stays small; not worth the v1 complexity.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes (constraint #9 / staging-first
  posture).
- Don't commit to git or push.

## Definition of done

- `apps/jotform-worker/src/handlers/admin.js` has
  `handleAssetProxy` wired into the dispatcher at
  `/admin/jotform/api/asset` (GET only).
- Worker validates target URL host + `/uploads/` prefix; rejects
  anything else with 400.
- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` exports
  `assetProxyUrl(jotformUrl)`.
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`
  `control_signature` + `control_fileupload` branches use
  `assetProxyUrl()` for the `<img src>` / `<a href>`.
- `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx`
  `submittedColumn()` renders absolute EST as the primary surface;
  relative moves to the `title` attr.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/jotform-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~120 LOC for the worker handler + ~15 LOC
  for `assetProxyUrl` + the call-site swaps + the
  `submittedColumn` flip; plus doc rows).
- Validation results — especially the SSRF-guard smoke test.
- Confirmation that signatures render inline on at least one
  rewash + one retention + one time-card-edit detail page.
- Anything unexpected from JotForm's asset endpoint — e.g., does
  it accept `?apikey=`, or does it need a header, or 302-redirect
  somewhere else? The brief assumes query-param apikey; if
  JotForm Enterprise differs, document the actual auth shape.

## Outcome

### Files modified

- `apps/jotform-worker/src/handlers/admin.js` — added route dispatch
  entry for `/admin/jotform/api/asset` (GET-only) and `handleAssetProxy`
  handler (~80 LOC). The handler uses `authenticateForAdminApi` (any
  authenticated session), short-circuits 503 when `JOTFORM_API_KEY` /
  `JOTFORM_BASE_URL` is unbound, validates target URL host against
  `new URL(env.JOTFORM_BASE_URL).host` and path prefix `/uploads/`,
  strips pre-existing target query params, attaches `JOTFORM_API_KEY`
  as `apikey` query param, fetches with `redirect: "manual"` +
  `AbortSignal.timeout(10_000)`, rejects any 3xx upstream as 502 with
  `[jotform.asset-proxy] upstream redirect refused` log, passes 404
  through unchanged, maps other non-2xx to 502, and streams the
  response body back with `Cache-Control: private, max-age=300` +
  `X-Content-Type-Options: nosniff` headers.

- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` — added
  `assetProxyUrl(jotformUrl: string): string` export. Returns a
  same-origin path `/admin/jotform/api/asset?url=<encoded>`. No service
  binding plumbing needed because the URL is built into rendered HTML
  as `<img src>` / `<a href>` — the browser loads it directly via the
  apps/web session cookie (path-carved per Brief 107).

- `apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`
  — `control_signature` branch now renders `<img src={assetProxyUrl(url)}>`;
  `control_fileupload` branch now wraps each thumbnail with
  `<a href={assetProxyUrl(url)}>` and renders
  `<img src={assetProxyUrl(url)}>` inside. Imported `assetProxyUrl`
  from `../../../_lib/worker-fetch`. Module docblock extended with a
  Brief 113 paragraph explaining the proxy retarget.

- `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx` —
  `submittedColumn()` flipped: absolute is now the visible cell value,
  relative moves into the `title` attr (`<span title={relative || absolute}>{absolute}</span>`).
  Added an inline Brief 113 comment noting the flip rationale.

- `CLAUDE.md` — `jotform-worker` glossary entry gains a Brief 113
  paragraph documenting the asset-proxy endpoint (auth tier,
  anti-SSRF guardrails, redirect posture, timeout, headers, error
  codes); `JotForm submissions` glossary entry gains a shorter
  Brief 113 one-liner cross-referencing the jotform-worker entry.

- `BRIEFS/INDEX.md` — Brief 113 row inserted above Brief 112.

- `BRIEFS/QUEUE.md` — Brief 113 line commented as completed.

- `BUILD_STATE.md` — Last-updated bumped to 2026-05-12 (Brief 113);
  Findings entry at the top of the file.

- `BRIEFS/brief-113-jotform-viewer-absolute-est-and-signature-proxy.md`
  — Status set to Completed (2026-05-12); Outcome filled in (this
  section).

### Files created

- None. All changes additive into existing modules. The Brief 113
  proxy endpoint lives inside the existing `apps/jotform-worker/src/handlers/admin.js`
  alongside the other admin endpoints rather than spawning a new
  module — matches the existing six-route admin handler convention.

### Files deleted

- None.

### Decisions made on the operator's behalf

1. **Asset-proxy auth tier = `authenticateForAdminApi`** (any
   authenticated session), NOT super_admin or admin-tier. Per the
   brief's recommendation: asset URLs are opaque (only obtainable by
   reading a row the caller already has via per-site scope), so the
   proxy doesn't need to re-validate scope. RM/RD/GM users legitimately
   need their own scoped rows' signatures to load.

2. **`redirect: "manual"` posture.** Brief flagged this as defensive;
   added it plus a 3xx → 502 conversion (with `Location` header logged
   for observability). JotForm Enterprise's upload endpoint serves 200
   directly today, but any future cross-host bounce gets rejected
   rather than silently leaking the proxy's API key forward.

3. **Added 503 short-circuit for `JOTFORM_BASE_URL` unbound** in
   addition to the brief's `JOTFORM_API_KEY` 503. The proxy needs both
   to construct the upstream URL; bailing early with a clear 503 is
   more useful than throwing during `new URL(env.JOTFORM_BASE_URL)`.

4. **404 passes through.** Per the brief's outline (`resp.status === 404 ? 404 : 502`),
   the proxy returns 404 when JotForm itself 404s — useful signal for
   the operator vs. lumping every non-2xx into 502.

5. **`formatEst()`'s `absolute` shape (`"May 12, 2026, 7:25 AM EDT"`)
   differs from the brief's example (`"May 12, 7:25 AM"`).** The
   helper format was shipped in Brief 111 and is not in scope to
   change here — this brief only flips which field is primary vs.
   hover. The explicit year + zone is intentional (auditors reading
   a list don't have to guess the year on December 31 → January 1).

6. **Detail page metadata block left as-is.** Brief 112 already wired
   it to `"{absolute} · {relative}"` shape (absolute primary, relative
   suffix). Per the brief's "If a `formatEst().relative` ever appears
   as the primary surface anywhere else, swap it" — checked, no other
   relative-as-primary surfaces in the JotForm viewer.

7. **No CSV URL conversion.** Brief explicitly listed this as out of
   scope. CSVs continue to embed raw JotForm CDN URLs; operators who
   open the URLs from a CSV outside an apps/web session would need to
   re-paste them into a logged-in tab. Deferred to v2 if it becomes
   friction.

### Latent issues / forward flags

- **Proxy responses not edge-cached or R2-cached.** Every signature /
  fileupload view hits JotForm CDN through the proxy. Per-request
  volume is small (one signature + 0-N files per detail page) and the
  5-minute browser cache absorbs immediate-rerender churn; scale up
  via R2-by-URL-hash is a v2 candidate (also listed in the brief's
  "Out of scope" section).

- **`JOTFORM_API_KEY` query-param auth shape is assumed.** The proxy
  attaches `apikey=<key>` query param mirroring `apps/jotform-worker/src/jotform.js`'s
  API read pattern. If JotForm Enterprise's CDN requires a header
  shape instead (e.g., `Authorization: APIKEY <key>`), the operator's
  post-deploy smoke would surface a 401/403 even through the proxy.
  Mitigation: swap the `targetUrl.searchParams.set("apikey", ...)`
  line for a `headers: { Authorization: ... }` Fetch option. The
  brief's Report section asked the executor to document this
  assumption — flagging it here.

- **No rate-limit on the asset proxy.** Worker's overall inbound is
  small; not worth the v1 complexity per the brief's out-of-scope.

- **Dashboard tile sprawl** — separately flagged by the operator on
  2026-05-12; deferred to a follow-up planning brief per this brief's
  "Out of scope".

### Validation results

- `pnpm typecheck` → **18/18 successful, 16 cached, 4.215s.** Both
  `@splash/jotform-worker` and `@splash/web` ran fresh (cache miss);
  others hit cache.

- `pnpm --filter @splash/web build` → **succeeded.** Bundle:
  - `/admin/jotform/[form_id]` → 1.61 kB / 107 kB First-Load JS
    (unchanged vs Brief 112).
  - `/admin/jotform/[form_id]/[submission_id]` → 172 B / 105 kB
    First-Load JS (unchanged, server-rendered, no client island —
    `assetProxyUrl` is a pure-string helper consumed by the SSR
    renderer).

- `pnpm --filter @splash/jotform-worker exec wrangler deploy --dry-run --outdir=.tmp-build`
  → **succeeded.** Bundle: **754.39 KiB raw / 142.70 KiB gzipped**
  (≈ +2.2 KiB / +0.4 KiB vs Brief 110's 752.20 / 142.28 baseline).
  `.tmp-build/` cleaned up after.

- No Supabase / R2 / wrangler.toml / secret changes. The worker
  already has `JOTFORM_API_KEY` + `JOTFORM_BASE_URL` bound from
  Brief 107.

### Operator post-deploy smoke (deferred)

1. Load `/admin/jotform/250165655616055` (rewash) — list column
   "Submitted (EST)" shows verbose absolute timestamps
   ("May 12, 2026, 7:25 AM EDT"), NOT relative ("5 hr ago").

2. Hover any row's Submitted cell — `title` tooltip shows the
   relative string ("5 hr ago" / "in 2 days" / etc.).

3. Open a row with a signature (rewash, retention, time-card-edit) —
   the inline `<img>` renders the actual signature, not a broken-image
   icon. Network tab should show the request going to
   `/admin/jotform/api/asset?url=<encoded jotform url>` with
   200 status + `Content-Type: image/png` (or whatever JotForm serves).

4. Anti-SSRF guard test:
   - `GET /admin/jotform/api/asset?url=https://evil.example.com/x.png`
     → 400 `url host not allowed`.
   - `GET /admin/jotform/api/asset?url=https://splashcarwashes.jotform.com/login`
     → 400 `only /uploads/ paths allowed`.
   - `GET /admin/jotform/api/asset?url=not-a-url`
     → 400 `invalid url`.
   - `GET /admin/jotform/api/asset` (no url param)
     → 400 `url required`.

5. **If JotForm Enterprise's CDN returns 401/403 even via the proxy** —
   `JOTFORM_API_KEY` query-param auth shape doesn't apply to the
   `/uploads/` endpoint. Try a manual `Authorization: APIKEY <key>` or
   `Authorization: Bearer <key>` header and amend `handleAssetProxy`
   to switch from query-param to header. Either case is a one-line
   change.

### Report addenda

- Diff size: ~80 LOC worker handler + ~15 LOC `assetProxyUrl` + 4 LOC
  call-site swaps in answer-renderer + 4 LOC submittedColumn flip +
  doc rows (~120 LOC). Within the brief's estimate.

- No deploy, no production routes, no commit, no push (per CLAUDE.md
  headless posture).
