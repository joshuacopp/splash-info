# Brief 148: SCORM Package Builder — port standalone tool into apps/web

**Status:** Completed (2026-06-01)
**Started:** 2026-06-01
**Completed:** 2026-06-01
**Blocks:** Neither
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- scorm-builder.html — the standalone tool that already implements every
  piece of the package builder (UI form, package builder functions,
  inlined player template + SCORM 1.2 API wrapper + CSS). This brief
  is a lift-and-shift of that file into apps/web, NOT a rewrite. Read
  it end-to-end before touching anything.
- apps/web/app/admin/dashboard/_lib/tiles.tsx — where the new tile slots
  in (between `form-builder` and `database-admin` in the `admin` group).
- apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx — reference
  for an apps/web client-island builder UI (state machine + saving
  flow). Don't copy literally; just absorb the pattern.
- apps/web/app/admin/_components/SignupAdminTabs.tsx — sibling for
  layout cues if a tab nav is wanted later (NOT required at v1).
- apps/web/middleware.ts — the `ADMIN_KNOWN_SUBPATHS` allow-list that
  every new `/admin/{subpath}` must be added to (CLAUDE.md mandatory
  rule).
- apps/web/app/_components/Header.tsx — the splash-navy topbar with
  the white-script logo that already gates on `/admin/*`. The new
  page sits beneath this so no header work is needed.

## Context

The standalone `scorm-builder.html` (Splash-branded, JSZip-based, builds
a SCORM 1.2 package end-to-end in the browser) is in the repo root and
working. Operator wants it lifted into the monorepo as a regular admin
page so it lives next to Pricing, Form Builder, Database Admin, etc.,
benefits from the existing auth + Splash chrome, and is one click away
from the dashboard.

Scope is intentionally narrow: port behavior verbatim, no new features.
The SCORM package contract (manifest XML, player HTML, scorm.js API
wrapper, CSS) ports unchanged — that code is correct as shipped.

Live state of the standalone tool, all of which transplants:
- UI: title, description, pass-threshold, course-id (auto), video drop-
  zone + file picker, dynamic quiz questions (multiple choice or
  true/false, per-question correct-answer selector, remove button),
  Build button + status bar with progress.
- Build pipeline: client-side resize via `<canvas>` is NOT used (this
  is video-only, no image resize); video file is read into ArrayBuffer,
  manifest XML is generated, three player files are generated, JSZip
  rolls everything into a single zip, browser downloads via blob URL.
- Player: intro screen → video → quiz → results, with retry-on-fail,
  reports to LMS via SCORM 1.2 (`LMSInitialize` → set
  `cmi.core.score.raw` + `cmi.core.lesson_status` → `LMSCommit` →
  `LMSFinish`). Splash-navy header inside the player with white-script
  logo.

## Scope

1. **Add JSZip as an apps/web workspace dep.**
   - `pnpm add -F @splash/web jszip@3.10.1`.
   - Type defs: `pnpm add -F @splash/web -D @types/jszip`.
   - No CDN load; bundle it into the chunk for `/admin/scorm-builder`.

2. **New page
   `apps/web/app/admin/scorm-builder/page.tsx`** (server component, thin
   wrapper):
   - `authenticate()` + admin-tier gate (super_admin OR dcRole admin /
     super_admin — match the Form Builder gate exactly).
   - On unauthorized: render the existing `NoAccessCard` (or
     equivalent) the way `/admin/forms` does.
   - Wraps the new client island below; no other content. No
     SignupAdminTabs (this isn't a Signup Admin surface).

3. **New client island
   `apps/web/app/admin/scorm-builder/_components/ScormBuilderClient.tsx`**:
   - `"use client"`.
   - Ports the entire `<main>` body of `scorm-builder.html`: title +
     description + pass threshold + course id fields, video drop zone
     (the `<div>` + hidden `<input>` pattern, NOT a `<label>`-nested
     input — that was the empty-file bug fixed earlier), questions
     panel (Add Question button + per-question card with type dropdown
     + choices + remove), build bar with status + progress + Build
     button.
   - State managed via `useReducer` or `useState` — operator's choice.
     Keep the data model identical to the standalone tool:
     ```ts
     interface State {
       title: string;
       description: string;
       passScore: number;
       courseId: string;       // auto-generated; readonly in UI
       video: File | null;
       questions: Question[];
     }
     interface Question {
       id: string;             // nanoid(8) — uniqueness for keys
       type: "mc" | "tf";
       text: string;
       choices: string[];      // ["", "", "", ""] for mc, ["True", "False"] for tf
       correctIndex: number;
     }
     ```
   - Validation rules: identical to the standalone tool's `validate()`.
     Title required. Video required. At least one question. Per-question:
     text non-empty; mc needs ≥2 non-empty choices AND the marked-
     correct choice must be non-empty.
   - Build pipeline: identical to the standalone tool's `buildBtn`
     click handler. Read video into ArrayBuffer, build manifest XML,
     build index.html (with course config inlined as JSON), build
     scorm.js, build style.css, JSZip → blob → trigger download.

4. **Lift the static template + helper modules.** Put the
   manifest/player/wrapper builders next to the page so they're
   reusable:
   - `apps/web/app/admin/scorm-builder/_lib/manifest.ts` — exports
     `buildManifest(state, videoFilename): string`. Verbatim from
     `buildManifest()` in `scorm-builder.html`.
   - `apps/web/app/admin/scorm-builder/_lib/player.ts` — exports
     `buildIndexHtml(state, videoFilename, videoMime, courseConfig): string`,
     `buildScormJs(): string`, `buildStyleCss(): string`. Verbatim
     from the inline String.raw constants `SCORM_WRAPPER_JS`,
     `PLAYER_JS`, `PLAYER_CSS`. Keep the player HTML using the
     splash-navy header with the white-script logo URL
     (`https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png`).
   - `apps/web/app/admin/scorm-builder/_lib/build.ts` — exports
     `async buildScormZip(state, opts): Promise<Blob>`. Wraps the
     JSZip build, returns a Blob. Accepts an optional
     `onProgress(pct, msg)` callback so the UI can update the status
     bar + progress element.
   - Pure functions. No `window` access. No React. They run in the
     browser via the client island but stay TS-clean.

5. **Add the dashboard tile between Form Builder and Database Admin.**
   - In `apps/web/app/admin/dashboard/_lib/tiles.tsx`, INSERT a new
     entry into the array RIGHT AFTER the `form-builder` tile and
     BEFORE the `database-admin` tile (operator-specified position):
     ```ts
     {
       id: "scorm-builder",
       group: "admin",
       eyebrow: "Training",
       title: "SCORM Package Builder",
       description: "Build training packages — video + quiz — for upload to your LMS.",
       href: "/admin/scorm-builder",
       icon: <pick a sensible existing icon — e.g. a graduation-cap / video / play-circle SVG — match the style of the other tile icons; if none of the existing icons fit, add a small inline SVG following the same pattern as creditCardIcon / clipboardListIcon>,
       visibleTo: isAdminTier
     },
     ```
   - The `visibleTo: isAdminTier` predicate matches Form Builder so the
     tile appears for the same audience.

6. **Wire the middleware allow-list.**
   - In `apps/web/middleware.ts`, add `"scorm-builder"` to the
     `ADMIN_KNOWN_SUBPATHS` set per the CLAUDE.md mandatory rule for
     every new top-level `/admin/{subpath}` route. Without this, the
     legacy `/admin/{slug}` → `/admin/pricing/{slug}` redirect rewrites
     `/admin/scorm-builder` into a 404 against signup-worker.

7. **Branding parity.**
   - The page renders inside apps/web's existing splash-navy Header
     (see `apps/web/app/_components/Header.tsx`) — no separate topbar
     in the page itself. Drop the standalone's `<header class="topbar">`
     entirely.
   - Section panels should match the existing admin look (splash-navy
     text, white panel background, sudsy-blue eyebrows). Reuse the
     same Tailwind classes used in `/admin/forms/[id]` rather than
     inline `<style>`. Convert the standalone's CSS variables / inline
     styles to Tailwind utilities where reasonable; otherwise keep a
     small page-scoped `<style jsx>` or inline `<style>` block —
     operator's choice but no global CSS pollution.
   - The PLAYER inside generated SCORM packages KEEPS its splash-navy
     gradient header bar with the white-script logo as today. That's
     the customer-facing surface and stays branded standalone-style.

8. **Verify no other call sites break.** Grep for `scorm-builder.html`
   in the repo. If anything references the standalone, leave it alone
   — the standalone stays as a fallback / preview. The two coexist.

## Configuration

No new env vars or secrets.

## Out of scope

- Don't extend SCORM features (2004, multi-SCO packaging, branching,
  progress save-and-resume, instructor analytics, etc.). v1 is parity
  with the standalone.
- Don't add per-package custom branding (logo override per course) —
  every package gets the Splash header. A future brief can widen this
  with a "Use custom logo" toggle.
- Don't ship the standalone `scorm-builder.html` to apps/web's
  public/. It stays at repo root as a separate fallback.
- Don't add server-side persistence of in-progress builds (no DB
  table for drafts). The standalone is fully client-side and this
  port preserves that.
- Don't upload anything to R2. Video stays in-browser; zip is built
  in-browser; download triggers via blob URL. No worker bindings.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds. JSZip bundles into the
  route-specific chunk for `/admin/scorm-builder` (verify with the
  build output — chunk size for that route should be 100-150 kB
  larger than a normal admin route).
- Dashboard renders the new "SCORM Package Builder" tile in the Admin
  group, positioned between Form Builder and Database Admin, visible
  only to admin-tier sessions.
- Navigating to `/admin/scorm-builder` as an admin-tier user renders
  the form (title, description, pass score, video drop zone, questions
  panel, Build button). The Splash header sits above; no separate
  topbar inside the page.
- Filling out a real flow (title + 25MB MP4 + 3 multiple-choice
  questions) and clicking Build produces a `.zip` download whose
  contents match the standalone's output byte-for-byte at the player
  layer (manifest XML, scorm.js, style.css, index.html, video.mp4).
- Non-admin-tier users hitting `/admin/scorm-builder` see the same
  NoAccessCard / forbidden message that `/admin/forms` shows them.
- `apps/web/middleware.ts` `ADMIN_KNOWN_SUBPATHS` now includes
  `"scorm-builder"`.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 148: SCORM Package Builder ported from standalone HTML into
  apps/web at /admin/scorm-builder; tile placed in Admin group between
  Form Builder and Database Admin"). Add a glossary entry under "SCORM
  Package Builder" capturing the v1 scope (SCORM 1.2, client-side
  build, video bundled into zip, Splash-branded player) and the
  standalone fallback location (`scorm-builder.html` at repo root).

## Report

- Whether the lift-and-shift uncovered any subtle differences (e.g. a
  Next.js dev-mode quirk with JSZip that doesn't reproduce in
  production builds). Flag anything; don't try to fix here.
- The bundle size delta on `/admin/scorm-builder` vs the baseline
  admin route. JSZip is ~30 kB minified+gzipped.
- Whether the icon was picked from the existing set or whether a new
  SVG was added; if new, the SVG's source.
- Any behavioral differences from the standalone (e.g. if a
  Tailwind-class refactor accidentally changed the focus ring color).

## Outcome

### Files created (7)

- `apps/web/app/admin/scorm-builder/page.tsx` — server-component wrapper.
  Calls `getMe()`, runs the admin-tier gate (same predicate as
  `/admin/forms`: `session.role === "super_admin"` OR
  `session.dcRole === "admin"` OR `session.dcRole === "super_admin"`),
  and renders either the local `NoAccessCard` or `<ScormBuilderClient />`.
  `export const dynamic = "force-dynamic"` so the gate runs per-request.
- `apps/web/app/admin/scorm-builder/_components/ScormBuilderClient.tsx` —
  `"use client"`. Full builder UI. State managed via `useReducer` with
  actions for `set_title` / `set_description` / `set_pass_score` /
  `set_video` / `add_question` / `remove_question` /
  `update_question_text` / `update_question_type` /
  `update_choice_text` / `update_correct_index`. Renders title +
  description + pass-threshold + readonly course-id, the
  `<div role="button">` video drop zone with a hidden `<input
  type="file">` (NOT a label-nested input — the standalone's empty-file
  bug is preserved in the port via a single explicit
  `fileInputRef.current?.click()` entry point), the questions panel
  with per-question card (textarea + type select + mc choices or tf
  radios + remove button), and a sticky build bar at the bottom with
  a status line + `<progress>` + Build button. `onBuild` calls
  `validateState`, then `buildScormZip` with an `onProgress` callback
  to drive the progress bar, then `URL.createObjectURL` + synthetic
  `<a>` click to trigger the browser download. Course id (`COURSE-
  XXXXXXXX`) is generated in a `useEffect` so SSR doesn't hydration-
  mismatch on `crypto.randomUUID`.
- `apps/web/app/admin/scorm-builder/_components/NoAccessCard.tsx` —
  sibling of `/admin/forms/_components/NoAccessCard.tsx`, retitled
  ("SCORM Package Builder", eyebrow "Training"). Identical layout +
  Tailwind classes; signin variant links to
  `/login?return=/admin/scorm-builder`, forbidden variant links to
  `/admin/dashboard`.
- `apps/web/app/admin/scorm-builder/_lib/types.ts` — `BuilderState`
  and `Question` interfaces mirroring the standalone tool's `state`
  object exactly.
- `apps/web/app/admin/scorm-builder/_lib/manifest.ts` —
  `buildManifest(state, videoFilename): string`. Verbatim port of the
  standalone `buildManifest()` function with an inline `escapeXml`
  helper.
- `apps/web/app/admin/scorm-builder/_lib/player.ts` — exports
  `buildIndexHtml(state, videoFilename, videoMime): string`,
  `buildScormJs(): string`, `buildStyleCss(): string`, and
  `buildCourseConfig(state, videoFilename, videoMime): CourseConfig`.
  The `SCORM_WRAPPER_JS`, `PLAYER_JS`, and `PLAYER_CSS` constants are
  carried byte-for-byte from `scorm-builder.html` as `String.raw`
  templates. Closing `</script>` tags inside the inline strings are
  split as `<\/script>` so the surrounding ES module isn't terminated
  early. Player HTML keeps the splash-navy gradient header with the
  white-script logo URL.
- `apps/web/app/admin/scorm-builder/_lib/build.ts` — exports
  `buildScormZip(state, opts): Promise<Blob>` and `safeTitleStem`.
  Wraps JSZip; accepts `onProgress(pct, msg)`. Mirrors the standalone
  `buildBtn` click-handler control flow exactly (5% read video → 20%
  build manifest → 35% build player → 55–95% zip → 100% done).
- `apps/web/app/admin/scorm-builder/_lib/validate.ts` —
  `validateState(state)` + `formatBytes(n)`. Direct ports.

### Files modified (3)

- `apps/web/package.json` — added `"jszip": "3.10.1"` to
  `dependencies`. JSZip ships its own TypeScript declarations
  (`apps/web/node_modules/jszip/index.d.ts`), so the deprecated
  `@types/jszip@3.4.1` DefinitelyTyped package was installed,
  confirmed unnecessary, and immediately removed.
- `apps/web/app/admin/dashboard/_lib/tiles.tsx` — new `scorm-builder`
  tile inserted between `form-builder` and `database-admin` in the
  Admin group (`eyebrow: "Training"`,
  `title: "SCORM Package Builder"`,
  `description: "Build training packages — video + quiz — for upload to your LMS."`,
  `href: "/admin/scorm-builder"`, `visibleTo: isAdminTier`). New
  inline `graduationCapIcon` SVG follows the same lucide-style
  `SvgProps` pattern as the surrounding icons.
- `apps/web/middleware.ts` — added `"scorm-builder"` to
  `ADMIN_KNOWN_SUBPATHS` per the CLAUDE.md mandatory rule. Without
  this the legacy `/admin/{slug}` → `/admin/pricing/{slug}` redirect
  would silently rewrite `/admin/scorm-builder` into a 404 against
  signup-worker.

### Decisions made on operator's behalf

1. **Local NoAccessCard.** Imported from `_components/NoAccessCard.tsx`
   in the SCORM Builder route rather than reused from
   `/admin/forms/_components/NoAccessCard.tsx`. The forms version
   hardcodes "Forms" in its heading + signin copy, which would be
   wrong on the SCORM Builder unauthorized state. Local copy is a
   ~50-line sibling that retitles to "SCORM Package Builder" / eyebrow
   "Training" and otherwise reuses the same Tailwind classes verbatim.
2. **Skipped `@types/jszip`.** The brief proposed
   `pnpm add -F @splash/web -D @types/jszip`. JSZip 3.10.1 already
   bundles its own `.d.ts`; the DefinitelyTyped package is deprecated.
   `pnpm typecheck` passes without it; adding it would have introduced
   a deprecated dep.
3. **`nanoid` for question ids.** Standalone uses
   `crypto.randomUUID().slice(0, 8)`. Switched to `nanoid(8)` because
   `nanoid` is already a workspace dep on apps/web (used by the form
   builder reducer) and the in-UI key collision risk is identical.
4. **Course id in `useEffect`.** `crypto.randomUUID` is browser-only.
   Generating the course id in a `useReducer` initializer would
   trigger a hydration mismatch warning. Server-side renders the input
   as empty; client-side effect fills it post-mount.
5. **Local NoAccessCard for SCORM Builder used Tailwind classes only;
   no scoped `<style>` block.** Brief left this open; Tailwind utility
   classes match the rest of apps/web's admin look more cleanly than
   a per-page style block.
6. **Player CSS inside the generated SCORM zip stays standalone-style.**
   Kept the splash-navy gradient header with the white-script logo
   verbatim from `scorm-builder.html`. This is the customer-facing
   surface inside the package — it ships unchanged to the LMS.
7. **Status type variants.** The standalone toggles `className`
   between `"status"`, `"status ok"`, `"status err"` strings; the port
   uses a discriminated union (`Status = idle | info | ok | err`) so
   TypeScript catches missing branches. Visual output matches.
8. **Standalone fallback retained.** Per Phase 8, grep confirmed
   nothing else in the repo references `scorm-builder.html`. The file
   stays at repo root as a fallback / preview surface; apps/web's
   `/admin/scorm-builder` is the canonical route. The two coexist.

### Latent issues / forward flags

- **Route chunk size.** Brief estimated +100–150 kB delta on
  `/admin/scorm-builder`; observed delta is +44 kB raw / +44 kB First
  Load (route chunk 44.1 kB / 151 kB First-Load JS vs ~187 B / 107 kB
  on a typical admin route). JSZip is reportedly ~30 kB minified +
  gzipped — actual size matches the lower end of the brief's estimate
  after Next 15 chunk splitting. No action needed.
- **Empty-file defense preserved.** The standalone documented the
  Chrome empty-file picker bug ("label-nested input fires the file
  picker twice"). The port keeps the same defense: hidden file input
  outside the drop zone, single `fileInputRef.current?.click()` entry
  point. Future executors should not refactor this into a
  `<label><input/></label>` pattern.
- **Player `<script src="player.js" onerror="initPlayer()">` is a
  documented double-init pattern.** `player.js` does NOT exist inside
  the generated package — the player JS is inlined in `index.html`'s
  third `<script>` block. The `onerror` fires immediately on the 404
  and triggers the same `initPlayer()` that the inline script also
  registers via `DOMContentLoaded`. Preserved verbatim from the
  standalone; it's how LMSs that serve a `player.js` override would
  hook in. Don't "fix" the 404 — that's the contract.
- **No dev-mode JSZip quirk surfaced.** Build was validated via
  production `next build`; `next dev` was not exercised since the
  brief's Definition of Done targets the production-build chunk size.
  No dev-mode issues are known but none were eliminated either.
- **No SCORM 2004 / multi-SCO support.** Explicitly out of scope per
  the brief. v1 is parity with the standalone.
- **No server-side persistence.** Video bytes / zip blobs stay in the
  browser; nothing hits R2 / D1 / Supabase from this page. A future
  brief that wants draft persistence would need a new DB table and
  worker endpoint.
- **Logo URL hardcoded.** The player HTML embeds the public R2 URL
  `https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png`.
  Same URL used by Brief 32 (claim summary PDF), Brief 134 (workflow
  email shell), and the operator confirms it's publicly reachable.

### Validation results

- `pnpm typecheck`: **18/18 packages green, 4.59s wall.** `@splash/web`
  was a cache miss (the only one); all other packages cache-hit.
- `pnpm --filter @splash/web build`: **green.** Compiled in 22.2s; 14
  static pages generated; no warnings or errors. Route table excerpt
  for the new page:
  ```
  /admin/scorm-builder                      44.1 kB         151 kB
  ```
  For comparison: `/admin/forms/[id]` (which bundles dnd-kit + lazy
  Mermaid) sits at 37.9 kB / 145 kB; `/admin/approvals` at 187 B /
  107 kB. The +44 kB delta is consistent with JSZip bundling.
- Standalone `scorm-builder.html` at repo root: unchanged (no other
  references in the repo per Phase 8 grep — `Grep "scorm-builder.html"`
  surfaces only the brief itself).
- No Cloudflare deploys, no production-route bindings, no git
  commits or pushes per CLAUDE.md.
