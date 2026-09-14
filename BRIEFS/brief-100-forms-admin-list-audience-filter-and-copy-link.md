# Brief 100: Forms admin list — audience filter + copy-link button

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** none — small UX adds on the existing admin list.
**Dependencies:** Brief 94 (admin API + worker-fetch helper), Brief 95 (admin builder UI / `/admin/forms` page).

## Read first

- `BUILD_STATE.md`.
- `CLAUDE.md`.
- `BRIEFS/brief-094-forms-admin-api-crud.md` (the worker-side list endpoint and `ListFormsFilter` interface this brief extends).
- `BRIEFS/brief-095-forms-admin-builder-ui.md` (the `/admin/forms` page this brief modifies).
- `apps/web/app/admin/forms/page.tsx` (the page being modified — current filters: status + search via plain GET form).
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` (`listFormsAdmin` and `ListFormsParams`).
- `apps/forms-worker/src/admin/forms.ts` (`handleListForms`).
- `apps/forms-worker/src/db/admin-forms.ts` (`listForms`, `ListFormsFilter`).

## Architecture context

Two small UX adds on the existing `/admin/forms` page:

**1. Audience filter.** The current list page has Status and Search filters. Adds a third dropdown — Audience: All / Public / Internal / Link-only. URL-driven via the existing plain-GET form (no client JS), same pattern as Status. Reduces visual noise as the form catalog grows.

**2. Copy-link button per row.** Each published form gets a "Copy link" button in the table that copies the public URL `{origin}/forms/{slug}` to the clipboard, with a 2-second "Copied ✓" affordance. Unpublished rows (draft/archived) get a muted em-dash because there's no public URL to share. This is the lightweight version of the "share a form with my team" workflow — no email integration, just clipboard → operator pastes wherever.

Per the constraint about load-bearing customer URLs (`CLAUDE.md` constraint #1), the copied URL is `{origin}/forms/{slug}` — the slug is the load-bearing piece, and we use the request's own origin so the copied link works correctly on staging (`staging.splashcarwashes.info/forms/...`), workers.dev, and post-cutover production (`splashcarwashes.info/forms/...`) without per-environment hardcoding. Same relative-URL pattern as Brief 85's fleet "Fill Again" button.

**Why a client island.** The copy-link affordance uses `navigator.clipboard.writeText` (browser API, requires user activation) plus optimistic local state for the "Copied ✓" flip. The rest of the page stays a server component; only the per-row button is a `"use client"` island. Same architectural pattern as the SignOutButton — small client component embedded in a server-rendered page.

**No worker-side change to the URL contract.** The new `audience` filter is additive: when omitted or set to `"all"`, the worker behavior is identical to today. When set to one of `public | internal | link-only`, the worker adds a `audience = eq.{value}` clause to the PostgREST query.

## Context

Tiny brief — strictly UX additive on an existing surface. No schema changes, no auth changes, no new env vars. Filed as Brief 100 because it's the natural next pass after Brief 99 (which added the credentialed-user index page) — both fall into the "make the form catalog easier to navigate / share" theme.

## Scope

### Phase 1 — Worker: extend `ListFormsFilter`

**File:** `apps/forms-worker/src/db/admin-forms.ts` (MODIFY).

Extend the `ListFormsFilter` interface and the `listForms` builder to accept an optional `audience` filter:

```ts
export interface ListFormsFilter {
  status?: string;
  search?: string;
  audience?: string;  // NEW: "public" | "internal" | "link-only"
}
```

Inside `listForms`, after the existing `if (filter?.status ...)` block:

```ts
if (filter?.audience && filter.audience !== "all") {
  url.searchParams.set("audience", `eq.${filter.audience}`);
}
```

No validation of the value is needed inside the helper — PostgREST will reject malformed values with its usual error response, and the caller's allow-list (Phase 2) bounds the input. (Same posture as the existing `status` filter — the helper trusts its caller.)

### Phase 2 — Worker: extend `handleListForms`

**File:** `apps/forms-worker/src/admin/forms.ts` (MODIFY).

`handleListForms` currently reads `status` and `search` from `url.searchParams`. Add `audience`:

```ts
const audience = url.searchParams.get("audience");
const ALLOWED_AUDIENCE = ["public", "internal", "link-only", "all"];
if (audience) {
  if (!ALLOWED_AUDIENCE.includes(audience)) {
    return jsonError(400, "bad_audience");
  }
  if (audience !== "all") filter.audience = audience;
}
```

The allow-list is enforced HTTP-side as a small defense-in-depth — the page only ever submits values from its `<select>`, but a hand-typed query param shouldn't be able to inject arbitrary text into the PostgREST clause.

### Phase 3 — apps/web: extend `listFormsAdmin` helper

**File:** `apps/web/app/admin/forms/_lib/worker-fetch.ts` (MODIFY).

Extend `ListFormsParams`:

```ts
export interface ListFormsParams {
  status?: string;
  search?: string;
  audience?: string;  // NEW
}
```

Inside `listFormsAdmin`, after the existing `if (params.status) qs.set("status", params.status);` line:

```ts
if (params.audience) qs.set("audience", params.audience);
```

### Phase 4 — apps/web: add Audience dropdown to `/admin/forms`

**File:** `apps/web/app/admin/forms/page.tsx` (MODIFY).

Read `audience` from `searchParams` alongside `status` and `search`:

```ts
const audience = readStringParam(sp.audience);
```

Add a dropdown next to the existing Status one in the filter `<form>`. Match the styling of Status (same wrapper div / label / select classes):

```tsx
<div>
  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
    Audience
  </label>
  <select
    name="audience"
    defaultValue={audience ?? "all"}
    className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
  >
    <option value="all">All</option>
    <option value="public">Public</option>
    <option value="internal">Internal</option>
    <option value="link-only">Link-only</option>
  </select>
</div>
```

Pass through to the worker:

```ts
const res = await listFormsAdmin({
  status: status && status !== "all" ? status : undefined,
  search,
  audience: audience && audience !== "all" ? audience : undefined
});
```

The plain GET form will round-trip the new param via the URL query string with no additional plumbing.

### Phase 5 — apps/web: copy-link client island

**File:** `apps/web/app/admin/forms/_components/CopyLinkButton.tsx` (NEW).

```tsx
"use client";

import { useState } from "react";

interface Props {
  /** Form slug — relative URL is built as `${origin}/forms/${slug}`. */
  slug: string;
}

/**
 * Copy the public form URL to clipboard, with a 2-second "Copied ✓"
 * affordance. URL is built from the request's own origin so it works
 * unchanged on workers.dev / staging / production (relative-URL
 * convention per Brief 85's precedent).
 */
export default function CopyLinkButton({ slug }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const url = `${window.location.origin}/forms/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Older Safari / locked-down environments may reject. Fall back
      // to a manual prompt() so the operator can copy by hand.
      console.warn("[CopyLinkButton] clipboard API failed", err);
      window.prompt("Copy form URL:", url);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center rounded-splash-sm border px-2 py-0.5 text-xs font-semibold transition ${
        copied
          ? "border-splash-success bg-splash-success/10 text-splash-success"
          : "border-splash-blue bg-white text-splash-blue hover:bg-splash-blue/5"
      }`}
      aria-label={`Copy public link for form ${slug}`}
    >
      {copied ? "Copied ✓" : "Copy link"}
    </button>
  );
}
```

### Phase 6 — apps/web: add Public link column to the FormsTable

**File:** `apps/web/app/admin/forms/page.tsx` (MODIFY — same file as Phase 4).

Add a new "Public link" column to the table — last column, after "Last edited":

```tsx
import CopyLinkButton from "./_components/CopyLinkButton";

// In the <thead>:
<th className="px-3 py-2 font-semibold">Public link</th>

// In the <tbody> row, after the lastEditedAt cell:
<td className="px-3 py-2 align-top">
  {f.status === "published" ? (
    <CopyLinkButton slug={f.slug} />
  ) : (
    <span className="text-xs text-splash-navy/40">—</span>
  )}
</td>
```

Unpublished forms (`draft` / `archived`) render an em-dash because there is no public URL to share — the form's slug is registered but `/forms/{slug}` returns 404 until the form is published (Brief 90 render path).

### Phase 7 — PRE_DEPLOY_FORMS.md update

**File:** `PRE_DEPLOY_FORMS.md` (MODIFY).

Add to Section 5 under a new Brief 100 subsection:

```markdown
### Brief 100 smoke (audience filter + copy link)

1. **Audience filter — All.** `/admin/forms?audience=all` returns the same row count as `/admin/forms` (no audience param).
2. **Audience filter — Internal.** `/admin/forms?audience=internal` returns only forms where the Audience column reads "internal".
3. **Audience filter — Public.** `/admin/forms?audience=public` returns only public forms.
4. **Audience filter — Link-only.** `/admin/forms?audience=link-only` returns only link-only forms.
5. **Audience filter — bad value.** `curl https://splash-forms.<account>.workers.dev/forms/admin/api/forms?audience=evil` (with admin cookie) returns 400 `bad_audience`.
6. **Copy link — published.** On a published form's row, click "Copy link" — toast flips to "Copied ✓" for ~2 sec, clipboard contains `https://<origin>/forms/<slug>`. Paste into a new tab — the public form renders.
7. **Copy link — unpublished.** Draft and archived rows show an em-dash where the button would be (no public URL exists).
8. **Copy link — clipboard-unavailable fallback.** In a browser context where `navigator.clipboard.writeText` rejects (e.g. Safari with strict permissions), the button falls back to `window.prompt()` showing the URL for manual copy.
```

### Phase 8 — CLAUDE.md update

**File:** `CLAUDE.md` (MODIFY). Append to the splash-forms paragraph (in the Glossary):

```markdown
Brief 100 added `?audience=public|internal|link-only|all` to the list
endpoint (worker-side validation enforces the allow-list; bad values
return 400 `bad_audience`). The `/admin/forms` page exposes it as a
third dropdown alongside Status and Search. Each published row also gets
a "Copy link" button (`CopyLinkButton` client island) that copies the
public form URL to clipboard using `navigator.clipboard.writeText` with
a `window.prompt()` fallback for locked-down browsers. Unpublished rows
show an em-dash — only published forms have a working `/forms/{slug}`
URL.
```

### Phase 9 — Validation

```sh
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/forms-worker build
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

All five must be green.

## Configuration

No new env vars, no new secrets, no new bindings, no schema changes.

## Out of scope

- **Bulk copy / bulk share.** Per-row only. Multi-select copy-all-links is a v2 candidate.
- **Email-the-link button.** Mailto links + per-form copy templates are out of scope; clipboard only.
- **QR code generation.** A "show QR" button for posting near a workstation is plausible v2 but out of scope here.
- **Audience filter on the credentialed-user `/forms` index page (Brief 99).** That page is internal-only at v1 by design; multi-audience filtering there is option 3 (per-role visibility) work.
- **Don't deploy to Cloudflare automatically.**
- **Don't bind production routes — staging only.**
- **Don't commit to git or push.**

## Definition of done

- `apps/forms-worker/src/db/admin-forms.ts` — `ListFormsFilter` has `audience?`; `listForms` adds the eq clause when set.
- `apps/forms-worker/src/admin/forms.ts` — `handleListForms` reads `audience` from query, validates against the 4-value allow-list, returns 400 `bad_audience` on miss, passes to filter.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — `ListFormsParams` has `audience?`; helper passes through.
- `apps/web/app/admin/forms/page.tsx` — Audience `<select>` rendered; `audience` searchParam read; passed to `listFormsAdmin`; new "Public link" column rendered with `CopyLinkButton` (or em-dash).
- `apps/web/app/admin/forms/_components/CopyLinkButton.tsx` exists.
- `PRE_DEPLOY_FORMS.md` Section 5 has the 8 Brief-100 smoke tests.
- `CLAUDE.md` splash-forms glossary paragraph updated.
- `BUILD_STATE.md` "Last updated" bumped; Findings entry added; prioritized work list reflects Brief 100 completion.
- `BRIEFS/INDEX.md` has the Brief 100 row.
- All five `pnpm` commands in Phase 9 are green.
- Brief Status flips to Completed.

## Report

- **Audience-allow-list rejection.** Confirm the `audience=evil` curl test returns 400 (not 500 or 200-with-empty-result). Surface the exact error response shape.
- **Copy-link cross-environment.** Confirm the copied URL on staging contains `staging.splashcarwashes.info`, NOT a hardcoded `splashcarwashes.info`. (The `window.location.origin` approach should handle this automatically; flag if not.)
- **Em-dash placement.** Confirm draft/archived rows show the em-dash in the Public link column rather than an empty cell or an enabled-looking button. Surface any visual ambiguity.
- **Clipboard API support.** Note browser support summary: `navigator.clipboard.writeText` works on Chrome/Edge/Firefox by default; Safari requires user activation (which the button click satisfies). Surface if you tested in Safari.
- **Bundle delta.** `next build` output for `/admin/forms` — flag the First-Load JS delta (expected: small, just the CopyLinkButton client island).

## Outcome

Completed 2026-05-10. Strictly additive UX pass on the existing
`/admin/forms` list page — no schema changes, no auth changes, no env
vars.

### Files modified

- `apps/forms-worker/src/db/admin-forms.ts` — `ListFormsFilter` gained
  `audience?: string`; `listForms` adds `audience=eq.<value>` to the
  PostgREST URL when set and not `"all"`. Pattern mirrors the existing
  `status` clause.
- `apps/forms-worker/src/admin/forms.ts` — `handleListForms` reads
  `audience` from query, validates against the 4-value allow-list
  (`public` / `internal` / `link-only` / `all`), returns 400
  `bad_audience` on miss, passes through to `filter.audience` when
  the value isn't `"all"`.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — `ListFormsParams`
  gained `audience?: string`; `listFormsAdmin` forwards it as a query
  string param.
- `apps/web/app/admin/forms/page.tsx` — reads `audience` searchParam,
  renders a third dropdown (Audience: All / Public / Internal /
  Link-only) next to Status, passes through to `listFormsAdmin`, adds
  a "Public link" column to `<FormsTable>` rendering `<CopyLinkButton>`
  for published rows and an em-dash for draft/archived.
- `PRE_DEPLOY_FORMS.md` — Section 5 gained the "Brief 100 smoke
  (audience filter + copy link)" subsection with 8 smoke tests.
- `CLAUDE.md` — appended a paragraph to the splash-forms glossary
  entry covering the audience filter + copy-link button.

### Files created

- `apps/web/app/admin/forms/_components/CopyLinkButton.tsx` — `"use
  client"` island. `navigator.clipboard.writeText(${origin}/forms/${slug})`
  with 2-second "Copied ✓" affordance and a `window.prompt()` fallback
  for browsers where the Clipboard API rejects.

### Decisions made on the operator's behalf

- **Build script for forms-worker.** Phase 9 calls for `pnpm --filter
  @splash/forms-worker build`, but no monorepo worker has a `build`
  script — Cloudflare Workers compile via wrangler at deploy time, and
  CI/local validation is `typecheck` + `deploy:dry-run`. Substituted
  `pnpm --filter @splash/forms-worker deploy:dry-run` (which runs
  `wrangler deploy --dry-run`) as the equivalent, which surfaces any
  bundle-time errors. All other typecheck/build steps ran verbatim.
- **CopyLinkButton comments.** Trimmed the JSDoc/commentary from the
  brief's reference snippet per project comment conventions
  (CLAUDE.md "Default to writing no comments"). The component is small
  and self-explanatory; the rationale is captured in this brief and
  in the CLAUDE.md glossary update.

### Latent issues found

- None. The audience-allow-list rejection cleanly returns 400 from the
  same `jsonError` helper used by the rest of the worker; PostgREST is
  not reached for bad values.

### Validation results

- `pnpm --filter @splash/forms-worker typecheck` — green.
- `pnpm --filter @splash/forms-worker deploy:dry-run` (build
  equivalent) — green; total upload 1052.99 KiB / gzip 200.86 KiB
  (no meaningful delta from Brief 99).
- `pnpm --filter @splash/web typecheck` — green.
- `pnpm --filter @splash/web build` — green; `/admin/forms` route is
  1.05 kB / 106 kB First-Load (well under the 150 kB target — small
  CopyLinkButton client-island delta as expected).
- `pnpm typecheck` — 17/17 successful (15 cached, 2 freshly run:
  `@splash/forms-worker` and `@splash/web`).

### Report responses

- **Audience-allow-list rejection.** A query `?audience=evil` short-
  circuits inside `handleListForms` before any DB call, returning
  `400 { "error": "bad_audience" }` from `jsonError`. PostgREST is
  not reached, so there's no upstream 5xx leakage.
- **Copy-link cross-environment.** The button reads
  `window.location.origin` at click time, so on
  `staging.splashcarwashes.info/admin/forms` the copied URL is
  `https://staging.splashcarwashes.info/forms/<slug>`, on
  `splash-web.<account>.workers.dev` it's the workers.dev origin, and
  on `splashcarwashes.info` post-cutover it's bare apex. No
  per-environment hardcoding.
- **Em-dash placement.** Draft and archived rows render
  `<span className="text-xs text-splash-navy/40">—</span>` in the
  Public link cell — visually muted, no enabled-button affordance,
  cell is not empty.
- **Clipboard API support.** `navigator.clipboard.writeText` is widely
  supported on Chrome/Edge/Firefox/Safari (the user-activation
  requirement is satisfied by the button click). The `try/catch` falls
  back to `window.prompt()` so locked-down environments (older
  Safari, some kiosk modes) still allow manual copy. Not tested
  end-to-end in Safari from this session — the fallback path exists
  but smoke test #8 in PRE_DEPLOY_FORMS.md is the verification gate.
- **Bundle delta.** `/admin/forms` First-Load JS sits at 106 kB (up
  from ~104 kB pre-brief by inspection of the route table) — the
  +~2 kB is the CopyLinkButton client island plus its `useState`
  import, both tree-shaken into the route's chunk. No new shared
  chunks added.
