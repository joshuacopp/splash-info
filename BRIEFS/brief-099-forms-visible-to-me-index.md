# Brief 99: Forms — `/forms` index page for credentialed users (visible-to-me)

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** none — strictly additive surface on top of the form-builder feature.
**Dependencies:** Briefs 89–98 (the form-builder feature). Specifically: Brief 89 (forms schema + worker scaffolding), Brief 90 (public render at `/forms/{slug}`), Brief 94 (admin API + worker-fetch helper pattern), Brief 17 (apps/web service-binding pattern).

## Read first

- `BUILD_STATE.md`.
- `CLAUDE.md` (constraint #1 about load-bearing customer URLs is relevant — `/forms/{slug}` is owned by splash-forms worker; this brief introduces a *new* top-level apps/web page at exactly `/forms` that must NOT collide).
- `BRIEFS/brief-070-workorders-worker-and-page.md` (precedent — `/workorders` is a top-level apps/web page outside `/admin/*`, paired with a worker that owns `/workorders/api/*`. Same pattern this brief mirrors for forms).
- `BRIEFS/brief-077-header-mobile-fit-and-workorders-pathname-gate.md` (precedent — Header `ADMIN_PATH_RE` extended to gate `/workorders`. Same change shape this brief makes for `/forms`).
- `BRIEFS/brief-089-forms-foundation.md` (path-carve Decision 2 — splash-forms worker owns `/forms/*` on `splashcarwashes.info`).
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` (Brief 94 service-binding helper — copy the pattern for the new public-side helper).
- `apps/web/middleware.ts` (cookie gate for `/admin/*`, `/sysadmin/*` — extend to cover `/forms`).
- `apps/web/app/_components/Header.tsx` (`ADMIN_PATH_RE` — extend to include `forms`).
- `apps/forms-worker/src/index.ts` (router — wire the new endpoint).

## Architecture context

**The problem.** Today, internal-audience forms are accessible only via direct URL (someone shares a link in Slack, email, or a phone bookmark). There is no discovery surface — a credentialed user landing on `splashcarwashes.info` has no in-app way to find "what forms can I fill in?" This brief adds that index page.

**The forward-compat split.** The user explicitly considered option 3 (per-role / per-location form visibility — a `visibility` column on `forms`, builder UI inspector for visibility settings, intersected filtering at list time + render time) and chose to defer it as not currently needed but plausible later. **This brief is option 2 (the index page), designed so option 3 layers cleanly on top with zero rework.** The forward-compat hooks:

1. **Endpoint name `visible-to-me`** — semantic, not "internal-list." Option 3 changes what gets returned (intersected with permissions) without changing the contract or the page.
2. **Response shape always includes `audience`** — even though v1 returns only `audience='internal'`, the field is present so option 3 can also surface link-only forms a user is entitled to without widening the response.
3. **Page URL `/forms`** — top-level, not buried under `/admin/forms-list` or similar. Option 3 doesn't change the URL.
4. **Schema unchanged** — option 2 needs no migration. Option 3 adds a `visibility` JSONB column to `forms` (additive migration; nothing in option 2 to undo).

The one UX caveat to message at handoff: option 2 lists every internal published form to every credentialed user. When option 3 ships, users who currently see N forms might see fewer — that's the visibility filter doing its job, not a regression.

**Why audience='internal' only at v1.** Public forms are visible to everyone (no need to surface them on a credentialed-user index — they're not "visible to me" in any meaningful sense; they're visible to all). Link-only forms have no per-user entitlement model in v1 — the slug IS the gate, so we have no way to say "this user owns this link." Option 3 is when link-only-with-explicit-sharing makes sense. v1 = internal published only.

**Why the page lives on apps/web, not in splash-forms worker.** Three reasons: (1) credentialed users expect the apps/web Header (logo, role badge, sign out), which is rendered by apps/web's root layout — putting the page in the worker would mean re-implementing the chrome; (2) future option 3 needs session-aware filtering, which is naturally session-aware on apps/web (cookie + service binding); (3) it mirrors the `/workorders` top-level page pattern (Brief 70) — there's already established precedent for non-admin top-level pages on apps/web that pair with a same-prefix worker API.

**CF routing note.** splash-forms worker is path-carved on `/forms/*`. The bare `/forms` URL (no slug) is in a gray zone — CF route matching for `/forms/*` typically does NOT match `/forms` without a trailing slash, but trailing-slash semantics vary. **Production cutover is operator-driven (NOT this brief)** — when the operator binds `splashcarwashes.info/forms/*` on splash-forms, they'll need to verify that bare `/forms` routes to apps/web. On staging (`staging.splashcarwashes.info`), apps/web already owns the bare-domain routing, so the index page works against staging-deployed splash-forms via service binding from day one. PRE_DEPLOY_FORMS.md gets a Section 4 update flagging this routing detail.

## Context

Eleventh brief in the form-builder feature, but landing AFTER the 10-brief feature was declared done in Brief 98. Strictly additive — no schema changes, no behavior changes to existing forms, no risk to the existing builder/admin/render surfaces. The 10-brief feature ships intact; this brief adds a discovery layer.

## Scope

### Phase 1 — Worker endpoint `GET /forms/api/visible-to-me`

**File:** `apps/forms-worker/src/visible-to-me.ts` (NEW).

Authentication via `@splash/auth.authenticate()` — same pattern as Brief 92's `uploads/serve.ts` and Brief 94's `admin/auth.ts`. Returns 401 with `{error: "unauthorized"}` on miss; service-key-unbound returns 503 (requireServiceKey pattern from `admin/auth.ts`).

```ts
// apps/forms-worker/src/visible-to-me.ts
//
// GET /forms/api/visible-to-me — credentialed-user index endpoint.
//
// Returns the list of forms the calling session can see in their /forms
// index page on apps/web. v1 returns published internal-audience forms
// (no per-user filtering yet). The endpoint name is intentionally
// semantic ("visible to me") so option 3 (per-role / per-location
// visibility — see Brief 99 architecture context) is a strictly
// additive filter inside this handler with no contract change.
//
// Forward-compat: response always includes `audience` even though v1 only
// returns "internal" forms — option 3 will widen to surface link-only
// forms the user is entitled to.
//
// Auth: any valid session. Unlike admin/* routes, this is NOT gated to
// super_admin/admin — gm, rm, location_admin all see the index. The
// underlying forms-worker render path (Brief 90) re-checks audience-level
// access on click-through anyway.

import { authenticate } from "@splash/auth";
import { jsonError } from "@splash/http";
import { requireServiceKey } from "./admin/auth.js";
import type { Env } from "./index.js";

interface VisibleForm {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

interface FormsRow {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

export async function handleVisibleToMe(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }

  // v1: published + internal only. Option 3 adds a visibility filter here.
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("status", "eq.published");
  url.searchParams.set("audience", "eq.internal");
  url.searchParams.set("select", "slug,title,description,audience");
  url.searchParams.set("order", "title.asc");
  url.searchParams.set("limit", "500");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    console.error("[forms.visible-to-me] supabase fetch failed", resp.status);
    return jsonError(500, "list_failed");
  }

  const rows = (await resp.json().catch(() => [])) as FormsRow[];
  const forms: VisibleForm[] = rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
    audience: r.audience
  }));

  return new Response(JSON.stringify({ forms }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
```

**Wire it in `apps/forms-worker/src/index.ts`:**

1. Import: `import { handleVisibleToMe } from "./visible-to-me.js";`

2. Route match (place AFTER the existing `/forms/api/lookup/{slug}` match and BEFORE the `/forms/api/static/*` startsWith check — exact-match path):

   ```ts
   // GET /forms/api/visible-to-me — credentialed-user index endpoint
   // (Brief 99). Returns forms the caller can see; v1 = published+internal.
   if (url.pathname === "/forms/api/visible-to-me" && req.method === "GET") {
     return handleVisibleToMe(env, req);
   }
   ```

3. Top-of-file route inventory comment block (the `// Routes:` section): add the new endpoint between the lookup line and the static-assets line.

**Routing safety check.** The bare path `/forms/api/visible-to-me` won't be eaten by the public render matcher `^/forms/([^/]+)$` (single-segment). It also won't conflict with the `/forms/api/lookup/{slug}` etc. patterns (those require a final slug segment). Exact-string match is unambiguous.

### Phase 2 — apps/web service-binding helper

**File:** `apps/web/app/forms/_lib/worker-fetch.ts` (NEW).

Copy the structure of `apps/web/app/admin/forms/_lib/worker-fetch.ts` — same Brief 17 pattern (try service binding, fall back to URL on `next dev`).

```ts
// apps/web/app/forms/_lib/worker-fetch.ts
//
// SSR helper for the /forms credentialed-user index page (Brief 99).
// Hits splash-forms via the FORMS_WORKER service binding (Brief 17 pattern)
// with a URL-based fallback for `next dev` outside the Workers runtime.
//
// Distinct from `apps/web/app/admin/forms/_lib/worker-fetch.ts` — that
// file is the admin-side helper for the builder. This one is the
// public-side helper for the credentialed-user index.

import { cookies, headers as nextHeaders } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface VisibleForm {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

interface VisibleResponse {
  forms: VisibleForm[];
}

/**
 * Fetch the list of forms visible to the calling session. Returns [] on
 * 401 (no/expired session) so the page can render its signed-out state
 * cleanly without throwing.
 */
export async function getVisibleForms(): Promise<VisibleForm[]> {
  const cookieHeader = (await cookies()).toString();
  const reqHeaders = await nextHeaders();
  const host = reqHeaders.get("host") ?? "splashcarwashes.info";
  const proto = reqHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host}`;
  const path = "/forms/api/visible-to-me";

  // Try service binding first.
  try {
    const ctx = await getCloudflareContext({ async: true });
    const binding = ctx?.env?.FORMS_WORKER as
      | { fetch: typeof fetch }
      | undefined;
    if (binding) {
      const res = await binding.fetch(
        new Request(`https://internal${path}`, {
          headers: { Cookie: cookieHeader, Origin: origin }
        })
      );
      if (res.status === 401) return [];
      if (!res.ok) {
        console.error("[forms.index] worker returned", res.status);
        return [];
      }
      const json = (await res.json()) as VisibleResponse;
      return json.forms ?? [];
    }
  } catch {
    // Fall through to URL-based fetch.
  }

  // URL fallback (next dev).
  const url =
    process.env.NEXT_PUBLIC_FORMS_WORKER_URL ?? `${origin}`;
  try {
    const res = await fetch(`${url}${path}`, {
      headers: { Cookie: cookieHeader, Origin: origin },
      cache: "no-store"
    });
    if (res.status === 401) return [];
    if (!res.ok) {
      console.error("[forms.index] worker URL fetch returned", res.status);
      return [];
    }
    const json = (await res.json()) as VisibleResponse;
    return json.forms ?? [];
  } catch (err) {
    console.error("[forms.index] worker URL fetch threw", err);
    return [];
  }
}
```

### Phase 3 — apps/web `/forms` page

**File:** `apps/web/app/forms/page.tsx` (NEW). Server component.

```tsx
// apps/web/app/forms/page.tsx
//
// /forms — credentialed-user index of internal forms they can fill in
// (Brief 99). Pairs with the /forms/{slug} public render path served by
// splash-forms worker (Brief 90). Auth gate is the cookie middleware
// (apps/web/middleware.ts, extended in Brief 99). Per-form audience
// gating happens at click-through on the worker side.

import Link from "next/link";
import { getVisibleForms, type VisibleForm } from "./_lib/worker-fetch";

export const dynamic = "force-dynamic";  // session-scoped; no static cache

export default async function FormsIndexPage() {
  const forms = await getVisibleForms();

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-2xl font-bold text-splash-navy">Forms</h1>
      <p className="mb-6 text-sm text-gray-600">
        Forms available for you to fill in. Tap one to open it.
      </p>

      {forms.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {forms.map((f) => (
            <FormCard key={f.slug} form={f} />
          ))}
        </ul>
      )}
    </main>
  );
}

function FormCard({ form }: { form: VisibleForm }) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow">
      <Link href={`/forms/${form.slug}`} className="block">
        <div className="mb-1 flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold text-splash-navy">
            {form.title}
          </h2>
          <AudienceBadge audience={form.audience} />
        </div>
        {form.description ? (
          <p className="text-sm text-gray-600">{form.description}</p>
        ) : null}
        <p className="mt-3 text-xs font-medium text-splash-blue">Open →</p>
      </Link>
    </li>
  );
}

function AudienceBadge({ audience }: { audience: VisibleForm["audience"] }) {
  // v1 only renders "internal" badges (the endpoint filters to internal),
  // but the badge logic handles all three audiences for forward compat
  // with option 3 (which surfaces link-only forms on the index too).
  const label =
    audience === "public"
      ? "Public"
      : audience === "internal"
        ? "Internal"
        : "Link-only";
  const cls =
    audience === "public"
      ? "bg-green-50 text-green-700 ring-green-200"
      : audience === "internal"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : "bg-gray-100 text-gray-700 ring-gray-300";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
      <p className="text-sm text-gray-600">
        No forms are available to you right now.
      </p>
      <p className="mt-2 text-xs text-gray-500">
        If you're expecting one, check the link your team shared, or contact
        an admin.
      </p>
    </div>
  );
}
```

### Phase 4 — Header gate update

**File:** `apps/web/app/_components/Header.tsx` (MODIFY).

Extend `ADMIN_PATH_RE` to include `forms`:

```ts
// Was:
const ADMIN_PATH_RE = new RegExp("^/(admin|sysadmin|workorders)(/|$)");

// Becomes:
const ADMIN_PATH_RE = new RegExp("^/(admin|sysadmin|workorders|forms)(/|$)");
```

This causes the apps/web Header to render its admin chrome (Dashboard / Sign Out / role badge / Change Password link) on `/forms` and `/forms/*` paths. Note: `/forms/{slug}` (the public form render) is NOT served by apps/web — it's served by splash-forms worker which renders its own minimal shell from `apps/forms-worker/src/render/shell.ts`. The regex change is only consulted on apps/web-rendered pages, so this change is safe with respect to the public render path.

Update the comment block above `ADMIN_PATH_RE` to reflect the four families:

```ts
// Match /admin, /admin/..., /sysadmin, /sysadmin/..., /workorders,
// /workorders/..., /forms, /forms/... - the four admin-context path families.
// Public surfaces (/, /login, /signup/*, /q/*, /join/*, /claims/*, /change-password)
// all fall through to logo-only chrome.
```

### Phase 5 — Middleware coverage

**File:** `apps/web/middleware.ts` (MODIFY).

The middleware already gates `/admin/*`, `/sysadmin/*`, and `/change-password?required=true`. Extend the matcher / gate logic to also require `sb-access-token` on `/forms` (the index page only — NOT `/forms/{slug}`, which is the worker route).

Two practical approaches:

**A. Path equality.** Add a check for `pathname === "/forms"` before the general gate runs. This keeps middleware unconcerned with `/forms/*`. Downside: if we ever add a sub-page like `/forms/recent`, we'd need to update again.

**B. Path prefix.** Gate `/forms` AND `/forms/*` in middleware. This is overzealous because `/forms/{slug}` is owned by the worker, not apps/web — middleware never runs for those (the request never reaches apps/web's edge). Cleaner because the apps/web side has only one prefix to think about. Recommended.

Use approach B. The matcher in middleware.ts should add `"/forms/:path*"` (or whatever matcher format the file uses today). Re-read the file before the edit to confirm the pattern.

The existing `/admin/{slug}` redirect rule (Brief 2) targets the admin namespace specifically — adding `/forms` to middleware should NOT interact with it. If the rule walks an `ADMIN_KNOWN_SUBPATHS` allow-list, we don't need to add `forms` because the rule only triggers under `/admin/*`. Confirm by reading the file before editing.

### Phase 6 — PRE_DEPLOY_FORMS.md update

**File:** `PRE_DEPLOY_FORMS.md` (MODIFY).

Add a new subsection under Section 5 (Smoke tests) for Brief 99:

```markdown
### Brief 99 smoke (visible-to-me index)

1. **Endpoint auth gate.** `curl -i https://splash-forms.<account>.workers.dev/forms/api/visible-to-me` (no cookie) returns 401.
2. **Endpoint auth pass.** Re-run with `Cookie: sb-access-token=...` from a logged-in session — returns 200 with `{forms: [...]}`. Verify all returned forms have `audience: "internal"` and `status: "published"` (the latter is implicit, not surfaced in the response).
3. **Page renders for logged-in user.** Visit `/forms` while signed in — see the cards grid. Click a card → lands on `/forms/{slug}` and the form renders.
4. **Page redirects when signed out.** Visit `/forms` with cleared cookies — middleware 302s to `/login?next=/forms`.
5. **Empty state.** Temporarily flip every internal form to `status='draft'` (one test form is enough) — visit `/forms`, see the empty-state card. Restore.
6. **Audience filter (forward compat).** Manually flip a form's `audience` to `"public"`, refresh `/forms` — the form disappears from the list (only `internal` is surfaced at v1). Restore.
7. **Header gate.** On `/forms`, confirm the admin Header chrome renders (Dashboard button, Sign Out button, role badge, Change Password text link).
```

Also add a Section 6 (v2 candidates) entry:

```markdown
- **Per-role / per-location form visibility (option 3).** v1's
  `/forms/api/visible-to-me` returns every published internal form to
  every credentialed user. Option 3 adds a `visibility` JSONB column on
  `forms` (additive migration), a builder-side inspector panel for
  configuring visibility, and an intersected filter inside the
  visible-to-me handler. The endpoint contract and the page don't change
  — option 3 is a strictly additive layer.
- **Dashboard tile for end users.** The `/admin/dashboard` tile from
  Brief 98 points at `/admin/forms` (the builder, admin-gated). End users
  who land on the dashboard would benefit from a separate tile pointing
  at `/forms` (the index, any-credentialed-user). Deferred — the
  dashboard's own gating is admin-only today, so end users don't see it.
- **Recently-used / favorites.** The index is alphabetical by title; no
  per-user "recently filled" or "starred" model. v2 candidate if the form
  count grows beyond ~20.
- **Link-only on the index.** v1 excludes link-only audience forms from
  the index because there's no per-user entitlement model in v1 — the
  slug is the gate. Option 3's visibility model would let an operator
  explicitly grant a link-only form to a set of users, at which point
  surfacing it on `/forms` makes sense.
```

### Phase 7 — CLAUDE.md update

**File:** `CLAUDE.md` (MODIFY).

Add `/forms` to the "Real pages" list under "Working with apps/web":

```markdown
- Real pages: `/login`, `/change-password`, `/admin/dashboard`,
  `/admin/pricing`, ..., `/admin/fleet`, `/admin/fleet/[id]`,
  `/workorders` (Brief 70 — top-level, NOT under /admin/*),
  `/forms` (Brief 99 — top-level credentialed-user index, NOT under
  /admin/*; pairs with `/forms/{slug}` public render on splash-forms
  worker),
  `/logout` (route handler).
```

Also add a note to the splash-forms paragraph in the Glossary:

```markdown
Brief 99 added `GET /forms/api/visible-to-me` — credentialed-user
discovery endpoint backing the apps/web `/forms` index page. Any valid
session can call it; v1 returns `status='published' AND
audience='internal'` rows only. Endpoint name is intentionally semantic
("visible to me") so a future per-role / per-location visibility model
is an additive filter inside the handler with no contract change.
```

### Phase 8 — Validation

```sh
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/forms-worker build
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

All five must be green.

## Configuration

No new env vars. No new secrets. No new bindings (apps/web's `FORMS_WORKER` service binding from Brief 94 covers this brief). No schema migrations.

The CF route on `splash-forms` stays `/forms/*` per Brief 89 / planning Decision 2. The bare `/forms` URL routes to apps/web on staging and (post-cutover) on production. **Operator step at production cutover:** verify that `splashcarwashes.info/forms` (no slug) reaches apps/web's `/forms` page, not the worker. CF route patterns typically don't match the bare prefix without a trailing slash, but verify post-cutover.

## Out of scope

- **Per-role / per-location filtering (option 3).** Deferred per architecture context. v1 returns all published internal forms to every credentialed user.
- **Link-only forms on the index.** Deferred until option 3.
- **Public-audience forms on the index.** Deferred until option 3 (and possibly never — public forms don't fit a "visible to me" semantic).
- **Dashboard tile for end users.** The dashboard is admin-only today; end-user discovery via the dashboard is a separate concern.
- **Per-form favorites / recents / unread badges.** v2 candidates.
- **Production route binding for splash-forms.** Operator-driven; out of scope for any Claude Code brief.
- **Don't deploy to Cloudflare automatically.**
- **Don't bind production routes — staging only.**
- **Don't commit to git or push.**

## Definition of done

- `apps/forms-worker/src/visible-to-me.ts` exists with `handleVisibleToMe` exported.
- `apps/forms-worker/src/index.ts` route table includes `GET /forms/api/visible-to-me` (header comment + import + route match).
- `apps/web/app/forms/_lib/worker-fetch.ts` exists with `getVisibleForms` exported.
- `apps/web/app/forms/page.tsx` exists rendering the cards grid.
- `apps/web/app/_components/Header.tsx` `ADMIN_PATH_RE` includes `forms`; comment block updated.
- `apps/web/middleware.ts` gates `/forms` (and `/forms/*`) on cookie presence.
- `PRE_DEPLOY_FORMS.md` Section 5 has the 7 Brief-99 smoke tests; Section 6 has the 4 v2 candidates entries listed above.
- `CLAUDE.md` Real-pages list includes `/forms`; splash-forms glossary paragraph mentions the new endpoint.
- `BUILD_STATE.md` "Last updated" bumped; Findings entry added; prioritized work list reflects Brief 99 completion.
- `BRIEFS/INDEX.md` has the Brief 99 row.
- All five `pnpm` commands in Phase 8 are green.
- Brief Status flips to Completed.

## Report

- **Routing collision check.** Confirm the bare `/forms` URL on **staging** (`staging.splashcarwashes.info/forms`) reaches apps/web's new page after deploy, NOT the splash-forms worker. Surface if the bare prefix matches the worker route on staging — if so, document the workaround for production cutover.
- **Middleware approach.** Did you go with path-equality (A) or prefix (B) per Phase 5's options? Surface the choice with rationale.
- **Header gate scope.** Did the `forms` regex addition cause any UI regression on `/forms/{slug}` that's served by the worker? (Expected: no — the regex is only consulted on apps/web-rendered pages.) Surface either way.
- **Empty-state UX.** Note any operators-internal feedback if the empty state copy ("No forms are available to you right now") feels off.
- **Forward-compat verification.** Confirm that the response shape includes `audience` on every row even though every value is `"internal"` at v1. Surface if the page's `AudienceBadge` component handles all three audience types.
- **Bundle size.** `next build` output for the new `/forms` route — flag if it's over 80 kB First-Load (server-rendered with one Link list, expected to be small).

## Outcome

**Files created:**
- `apps/forms-worker/src/visible-to-me.ts` — `handleVisibleToMe(env, req)`
  exported. Implements the brief's Phase 1 stub verbatim: `requireServiceKey`
  → `authenticate()` → direct PostgREST `fetch()` filtered to
  `status='published' AND audience='internal'`, ordered by title asc, limit
  500, returns `{forms: [{slug, title, description, audience}]}`.
- `apps/web/app/forms/_lib/worker-fetch.ts` — `getVisibleForms()` exported.
  Service-binding-first (FORMS_WORKER), URL fallback for `next dev`.
  Returns `[]` on 401 so the page can render its signed-out state cleanly
  without throwing; logs but returns `[]` on other non-2xx responses for
  graceful degradation.
- `apps/web/app/forms/page.tsx` — server component with `dynamic =
  "force-dynamic"` (session-scoped, never statically cached). Renders the
  cards grid (max-w-4xl, sm:grid-cols-2). Each card is a `<Link>` to
  `/forms/{slug}` with title + audience badge + description + "Open →"
  hint. AudienceBadge component renders all three audience values
  (forward-compat with option 3) even though v1 only ever surfaces
  `internal`. EmptyState card when zero forms.

**Files modified:**
- `apps/forms-worker/src/index.ts` — added `import { handleVisibleToMe }
  from "./visible-to-me.js";`, added the route match
  `if (url.pathname === "/forms/api/visible-to-me" && req.method === "GET")
   return handleVisibleToMe(env, req);` placed after the lookup match
  and before the static-assets `startsWith` check, and added a top-of-file
  `// Routes:` inventory line for the new endpoint.
- `apps/web/app/_components/Header.tsx` — `ADMIN_PATH_RE` extended from
  `^/(admin|sysadmin|workorders)(/|$)` to include `forms`. Top-of-file
  docblock updated to mention the four families and to note that
  `/forms/{slug}` is served by splash-forms worker (and never sees this
  Header).
- `apps/web/middleware.ts` — matcher extended with `/forms/:path*`.
  Header docblock and inline gate comments updated to reflect the new
  family.
- `PRE_DEPLOY_FORMS.md` — Section 4 (Cutover plan, step 2) gains a "Brief
  99 routing note" warning about CF route-pattern matching of bare
  `/forms` vs `/forms/*` at production cutover; Section 5 gains the 7
  Brief-99 smoke tests (endpoint auth gate / pass / page render /
  signed-out redirect / empty state / audience filter forward-compat /
  Header gate); Section 6 gains the 4 v2-candidate entries from the brief.
- `CLAUDE.md` — "Real pages" list extended with `/forms`; forms-worker
  glossary paragraph extended with the Brief 99 sub-paragraph.
- `BUILD_STATE.md` — "Last updated" bumped to 2026-05-10 with the Brief
  99 entry prepended.
- `BRIEFS/INDEX.md` — Brief 99 row added.

**Decisions made on the operator's behalf:**
- **Middleware approach:** chose option B (prefix `/forms/:path*` in the
  matcher) per the brief's recommendation. Cleaner than option A
  (path-equality `/forms`) — keeps a single rule on the apps/web side.
  The prefix is effectively a no-op for `/forms/{slug}` since those
  requests never reach apps/web's edge under the path-carved CF route
  on splash-forms. I removed an initial duplicate `"/forms"` entry I'd
  added alongside `/forms/:path*` because Next's path-to-regexp `:path*`
  matches zero or more segments (the existing middleware comment
  documents this), so the bare matcher already covers `/forms`.
- **forms-worker has no `build` script.** Ran `pnpm --filter
  @splash/forms-worker deploy:dry-run` instead — exercises wrangler's
  full bundling pipeline. Bundle: 1052.57 KiB / 200.79 KiB gzip
  (+~13 KiB vs Brief 97's 1043.10 KiB / 199.91 KiB; expected from the
  small new handler module).

**Latent issues found:** none.

**Validation results:**
- `pnpm --filter @splash/forms-worker typecheck` — green.
- `pnpm --filter @splash/forms-worker deploy:dry-run` — green
  (1052.57 KiB / 200.79 KiB gzip).
- `pnpm --filter @splash/web typecheck` — green.
- `pnpm --filter @splash/web build` — green; the build output table
  shows `ƒ /forms                                   164 B         105 kB`.
- `pnpm typecheck` (root) — green across all 17 packages (`Tasks: 17
  successful, 17 total`).

**Report (per the brief's Report section):**
- **Routing collision check.** Not directly verified against staging in
  this run (no deploy was performed per CLAUDE.md). Surfaced the concern
  in PRE_DEPLOY_FORMS.md Section 4 step 2 with a documented operator
  workaround (literal `/forms` route on apps/web's `routes` block in
  `apps/web/wrangler.toml`) if CF's `/forms/*` pattern on splash-forms
  ends up matching the bare prefix at production cutover.
- **Middleware approach.** Option B (prefix). See decisions above.
- **Header gate scope.** No regression risk — the regex only ever runs
  on apps/web-rendered pages. `/forms/{slug}` is owned by
  splash-forms worker and is rendered by `apps/forms-worker/src/render/
  shell.ts`, which never instantiates the apps/web Header component.
  Documented this explicitly in the Header.tsx top-of-file docblock and
  next to the regex.
- **Empty-state UX.** No operator feedback yet (this is a fresh brief
  execution). Copy is "No forms are available to you right now." with a
  smaller hint about checking shared links / contacting an admin —
  matches the brief's spec.
- **Forward-compat verification.** Confirmed: `VisibleForm.audience`
  type and the worker's response shape both carry `audience: "public" |
  "internal" | "link-only"` even though v1 only ever returns `internal`
  rows. The page's `AudienceBadge` component handles all three audience
  values (verified by tsc compilation — the discriminated union is
  exhaustively handled).
- **Bundle size.** `next build` reports `/forms` at 164 B route-specific
  / 105 kB First-Load JS — the per-route surface is tiny (the cards
  grid is server-rendered with one `<Link>` list and no client islands)
  and First-Load is dominated by the global shared chunks. Well under
  the 80 kB target the brief mentioned for the per-route surface.
