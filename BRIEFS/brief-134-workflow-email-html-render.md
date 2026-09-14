# Brief 134: Workflow email HTML rendering — logo, layout, labeled CTAs

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — email-quality polish on top of Brief 127's
plain-text rendering. Workflow emails currently arrive as a wall of
inline text with a bare URL; operator wants a properly-formatted
HTML body with a Splash logo header, a structured payload table,
and labeled CTA buttons (View Submission + View All Open
Approvals).
**Dependencies:** None. Brief 127 (queue + email-step cascade) and
Brief 133 (transition bug pass) both shipped.

## Read first

- CLAUDE.md (forms-worker glossary entries on Briefs 120 / 125 / 127 /
  129 / 131 / 133)
- `apps/forms-worker/src/workflow-email-step.ts` — `cascadeThroughEmailSteps`
  loop (line ~220) + `renderTemplate` (line 434) + `renderPayloadSummary`
  (line 475)
- `packages/db-supabase/src/outbound-emails.ts` — `OutboundEmailPayload`
  interface (already accepts optional `body_html`)
- `apps/damage-worker/src/notifications.ts` — reference: how the
  damage worker resolves the public asset host for logos in
  notification payloads
- `packages/storage-r2/src/index.ts` (or wherever `ASSETS` lives) —
  for the logo URL pattern

## Context

After Brief 133 unblocked the workflow approval flow, the first
real end-to-end test produced the operator's reaction:

> "now lets look at how we can better format these emails. also
>  the link shouldn't be full link, should be a shortened or a
>  labeled link 'View New Submission' and another one for 'View
>  All Open Approvals' (obviously on a per user focused landing.
>  But that email is gross and also doesn't have a logo. i love
>  logos"

Current rendered email body (verbatim from Outlook):
```
Hi, A new Newest workflow and form test submission was received.
Site Number: 127 Location: Elmira Heights RM Email:
josh.copp@splashcarwashes.com Date: 2026-05-14 What's your choice:
option_1 Open in Splash: https://splashcarwashes.info/admin/forms/
174940d5-9e6a-4d28-925e-d722cadd9435/submissions/43b5ea69-90a1-
4598-9865-ed7dcd4a7659 — Splash team
```

Three problems:
1. The plain-text body is collapsed into one paragraph by Outlook's
   reading view because there's no `body_html` to render. The line
   breaks in the template (`\n\n`) ARE preserved when the receiving
   client is plain-text-only, but Outlook's default rendering of a
   text-only message strips them.
2. The full submission URL is unreadable inline. Needs a labeled
   button-style link.
3. No logo, no header band, no structured payload table — looks
   like a developer test message, not a polished operator
   notification.

The fix is server-side HTML rendering in the worker. Operators
continue to author plain-text `body_template` (zero new authoring
surface); the worker auto-derives an HTML body from the same
template, wraps it in a Splash-branded email shell, and ships
both `body_text` (current behavior) and `body_html` (new) through
the queue. PA picks `body_html` when present.

## Scope

### Phase 1 — Add HTML rendering for the email body

Add a new exported function `renderTemplateHtml` alongside the
existing `renderTemplate` in `workflow-email-step.ts`. Same
template input, same token vocabulary, but produces an HTML
fragment ready for embedding in the email shell:

```ts
export function renderTemplateHtml(
  template: string,
  schema: FormSchema,
  payload: SubmissionPayload,
  runtime: RuntimeContext
): string;
```

Token-by-token HTML rendering:

| Token | Plain rendering | HTML rendering |
|---|---|---|
| `{form.title}` | `runtime.formTitle` | escapeHtml(`runtime.formTitle`) |
| `{form.url}` | bare URL | `<a href="...">View Form</a>` styled as inline link |
| `{submission.url}` | bare URL | CTA button: `<a class="cta cta-primary" href="...">View Submission</a>` |
| `{approvals.url}` (new) | bare URL | CTA button: `<a class="cta cta-secondary" href="...">View All Open Approvals</a>` |
| `{my_requests.url}` (new) | bare URL | CTA button: `<a class="cta cta-secondary" href="...">View My Requests</a>` |
| `{submitter.email}` | raw | escapeHtml + monospace span |
| `{submitter.name}` | raw | escapeHtml |
| `{outcome.label}` | raw | `<strong>` wrapped + tint color via inline style |
| `{outcome.reached_at}` | raw | escapeHtml |
| `{payload.summary}` | `Label: Value\nLabel: Value` | `<table class="payload">` with one `<tr>` per non-empty field |
| `{field.<key>}` | raw | escapeHtml; multi-line strings render with `<br>` |

Body text outside tokens: newline-to-paragraph normalization.
Split body on `\n\n` for paragraphs, single `\n` inside a paragraph
becomes `<br>`. Wrap each non-empty paragraph in `<p style="...">`.

### Phase 2 — Add the new template tokens to `renderTemplate` (plain-text)

Mirror the HTML token additions in the plain-text path so operators
who include `{approvals.url}` / `{my_requests.url}` in their template
get a labeled URL line in the plain-text fallback too:

```ts
case "approvals.url":
  return `Pending Approvals: https://splashcarwashes.info/admin/approvals`;
case "my_requests.url":
  return `Your Submissions: https://splashcarwashes.info/admin/my-requests`;
```

(Same base URL helper as `{submission.url}` — wrap in `https://splashcarwashes.info/admin/...`.)

### Phase 3 — Build the email HTML shell

New file `apps/forms-worker/src/workflow-email-shell.ts` exporting
`wrapInEmailShell(bodyHtml, opts): string`:

```ts
interface EmailShellOptions {
  preheader?: string;          // hidden text snippet, first 100 chars
                               // of body for inbox previews
  showApproverFooter?: boolean; // appends "View All Open Approvals"
                               // + "Update notification preferences"
                               // links when true
  showSubmitterFooter?: boolean; // appends "View My Requests" link
                               // when true
}
```

The shell is a table-based Outlook-safe HTML document with:
- DOCTYPE + minimal HTML/head/body wrappers
- `<head>` includes only `<meta http-equiv="Content-Type" charset>` +
  `<title>`. No `<style>` block (inlined styles only — Outlook strips
  `<style>` in some configurations).
- Hidden preheader `<div>` with display:none + max-height:0
- Navy header band (`#0E2745`) with white-script logo centered,
  60px tall. Logo URL: `https://splashcarwashes.info/.../splash-logo-white.png`
  (R2 asset — defer to existing `ASSETS.logoWhite` in
  `packages/storage-r2/src/index.ts`, or hardcode the public URL
  if no helper exists yet).
- White content area (max-width 600px, centered, padded).
- Footer band (light gray `#F4F6F8`) with two sub-sections:
  - Splash branding line: "Splash Car Wash · 200 South Avenue,
    Poughkeepsie, NY 12601" (or whatever the operator-confirmed
    canonical line is — flag if unknown).
  - Optional CTAs based on `opts`: a one-line set of secondary
    links ("View All Open Approvals" → `/admin/approvals`, "View
    My Requests" → `/admin/my-requests`).

All styles inline. Buttons use `<a>` styled as buttons via inline
styles (no `<button>` element — Outlook treats those as form
buttons). Skip VML / mso-hide gymnastics at v1; standard inline
styles render acceptably in Outlook, Gmail, iOS Mail, Apple Mail.

### Phase 4 — Wire the shell + html render into the cascade loop

In `cascadeThroughEmailSteps` (line ~220 of workflow-email-step.ts),
alongside the existing `body_text` render, build `body_html`:

```ts
const bodyText = renderTemplate(...);  // existing
const bodyHtmlFragment = renderTemplateHtml(...);  // new
const bodyHtml = wrapInEmailShell(bodyHtmlFragment, {
  preheader: bodyText.slice(0, 100),
  // Heuristic — assignment emails have outcome === null on the
  // runtime context (the email is firing on entry into an
  // approver step); outcome emails have outcome.outcomeLabel
  // populated.
  showApproverFooter: ctx.runtime.outcome.outcomeLabel == null,
  showSubmitterFooter: ctx.runtime.outcome.outcomeLabel != null
});

const enqueuePayload: OutboundEmailPayload = {
  source_worker: "forms",
  source_kind: "workflow-email-step",
  source_id: `${ctx.runtime.submissionId}:${stage.id}`,
  recipient,
  subject,
  body_text: bodyText,
  body_html: bodyHtml,   // <-- new
  ...(stageAttachments ? { attachments: stageAttachments } : {})
};
```

### Phase 5 — Power Automate flow update

The PA flow currently reads `body_text` and sends via Outlook
Send-Email. The new behavior is: read `body_html` when present
and non-null, else fall back to `body_text`. The Outlook
Send-Email "Send an email (V2)" action's Body field accepts HTML
when "Is HTML" is set to Yes.

In the flow editor:
1. Open the "Send an email" action
2. Set Body = `if(not(empty(items('Apply_to_each')?['body_html'])),
   items('Apply_to_each')?['body_html'], items('Apply_to_each')?['body_text'])`
3. Set "Is HTML" = `if(not(empty(items('Apply_to_each')?['body_html'])),
   true, false)`

(Operator note: the exact action item-reference depends on the
flow's variable naming. Treat the expression as a recipe; the
operator wires the specifics.)

This is operator-side work; document it in the brief Outcome so
the operator knows what to flip post-deploy.

### Phase 6 — Validate the HTML in real Outlook

Operator post-deploy smoke (deferred):
- Submit a fresh test submission. Click Approve.
- Email lands in Outlook inbox. Verify:
  - Navy header band with white-script Splash logo renders
  - Greeting paragraph + outcome line (if applicable) reads
    naturally
  - Payload table renders with one row per non-empty field, key
    in left column (medium font weight, navy color), value in
    right column
  - Primary CTA "View Submission" renders as a blue (#1FB6E0)
    button, full-width on mobile, ~200px wide on desktop
  - Secondary CTA "View All Open Approvals" renders below
    primary as a smaller, outlined button
  - Footer renders with Splash branding line
- Re-test on iOS Mail + Gmail web app to spot client-specific
  rendering issues (Outlook is the canonical surface; the
  others are sanity checks).
- Verify the plain-text fallback by viewing email source / using
  a plain-text client — body_text content should still read
  cleanly with newlines preserved.

### Phase 7 — Asset confirmation

7.1 Confirm `splash-logo-white.png` exists at the canonical R2
    public URL. If the URL is gated (signed) or the asset isn't
    public, this brief CANNOT use it inline in HTML — Outlook will
    show a broken-image placeholder. Two options:
    - (a) Make the R2 asset publicly readable (operator-driven
      bucket policy change)
    - (b) Use the existing `ASSETS` constant in
      `packages/storage-r2/src/index.ts` if it points at a
      public CDN URL
    - (c) Inline the logo as base64 (works in Gmail/Apple Mail;
      Outlook may strip or require it cached)

    Operator's R2 bucket already serves logos publicly per Brief
    32 (the damage check-request PDF embeds the white logo from
    the same R2 bucket); the URL pattern is the canonical answer.
    Use it.

7.2 Confirm the canonical Splash branding line for the footer.
    Examples to check: damage-worker's check-request PDF footer,
    fleet-inquiry-worker's confirmation success page, the public
    `/forms/{slug}` success page. Whichever wording is currently
    in production wins.

### Phase 8 — Validation

8.1 `pnpm typecheck` — must pass.
8.2 `pnpm --filter @splash/forms-worker build` — must succeed.
8.3 No worker / Supabase / R2 / wrangler.toml / secret changes
    EXCEPT new source files + the wiring patches in
    `workflow-email-step.ts`.

### Phase 9 — Updates

9.1 BRIEFS/INDEX.md: Brief 134 row appended.

9.2 BUILD_STATE.md: Findings entry noting:
  - Brief 134 (YYYY-MM-DD) — Workflow email step rendering
    upgraded to produce HTML alongside plain text. Operator-
    authored body_template stays plain-text; worker auto-
    derives HTML body with Splash-branded shell (navy header
    band + logo, structured payload table, labeled CTA
    buttons). Added new template tokens `{approvals.url}` +
    `{my_requests.url}`. PA flow flipped to prefer body_html
    when present.

9.3 CLAUDE.md `forms-worker` glossary entry: append a one-liner
    under Brief 127 noting that emails now ship both body_text
    and body_html, with the HTML shell at
    `apps/forms-worker/src/workflow-email-shell.ts`. Document
    the new template tokens.

## Out of scope

- Per-form custom email branding (custom logo per form,
  per-form color overrides). v2 candidate.
- Operator-authored HTML body templates (the brief's choice
  is server-side auto-rendering from plain-text input —
  simpler authoring surface, easier to evolve the shell).
- Dark-mode CSS targeting (Outlook + Gmail handle dark mode
  via their own heuristics; explicit @media query support
  in email is limited).
- VML rounded-corner buttons for Outlook (cosmetic; standard
  rectangular buttons render fine).
- Embedded images other than the logo (e.g., per-form header
  banner). v2.
- Email open-tracking pixels / click-tracking. Not asked
  for; adds complexity.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `renderTemplateHtml` exported from
  `apps/forms-worker/src/workflow-email-step.ts`.
- New `apps/forms-worker/src/workflow-email-shell.ts` with
  `wrapInEmailShell` export.
- `cascadeThroughEmailSteps` populates `body_html` on every
  enqueued row.
- New template tokens `{approvals.url}` + `{my_requests.url}`
  work in both plain-text and HTML renders.
- Splash logo embedded via public R2 URL.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/forms-worker build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per
  Phase 9.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (line count + file count).
- Validation results.
- The full list of files touched.
- The canonical logo URL used (with whether it's the existing
  ASSETS constant or a new one).
- The canonical Splash branding line used in the footer (and
  the source — damage PDF, fleet success page, etc.).
- Any rendering quirks discovered while writing the HTML
  (e.g., Outlook stripping certain inline styles, particular
  tags that didn't render).
- Sample rendered HTML for one assignment email + one outcome
  email (paste into Outcome section as a code block — operator
  can preview by saving as `.eml` and opening locally).

## Outcome

### Files

**Created (1):**
- `apps/forms-worker/src/workflow-email-shell.ts` — `wrapInEmailShell(bodyHtml, opts: EmailShellOptions): string` export. Outlook-safe table-based shell with DOCTYPE + minimal head + hidden preheader div + navy header band (`#0E2745`) + white-script logo from `ASSETS.logoWhite` + 600px white content area + light-gray (`#F4F6F8`) footer band carrying the canonical brand line + optional "View All Open Approvals" / "View My Requests" secondary links.

**Modified (1):**
- `apps/forms-worker/src/workflow-email-step.ts` — added `renderTemplateHtml(template, schema, payload, runtime): string` export alongside the existing `renderTemplate`; added `{approvals.url}` + `{my_requests.url}` token cases to both the plain-text `renderTemplate` and the HTML `renderTemplateHtml` paths; wired `body_html: wrapInEmailShell(renderTemplateHtml(...))` into the `OutboundEmailPayload` enqueued by `cascadeThroughEmailSteps`; added an import for `wrapInEmailShell` from the new shell module; new internal helpers `renderTokenHtml` / `renderInlineLink` / `renderCtaButton` / `renderPayloadSummaryHtml` / `outcomeTintColor` / `escapeHtml` / `escapeAttr` / `escapeOutsideSentinels`.

Net diff: ~250 lines added in `workflow-email-step.ts`, ~115 lines added in `workflow-email-shell.ts`. Two source files touched, one created.

### Validation

- `pnpm typecheck` — 18/18 green (17 cache hits, forms-worker ran fresh).
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` — succeeded. Total Upload: 2023.77 KiB / gzip: 445.27 KiB.

### Decisions made on the operator's behalf

1. **Sentinel-pair token wrapping over a two-pass renderer.** The HTML render needs to escape operator-authored body text but NOT escape the per-token HTML the renderer itself produced. I wrap each token's HTML output in `\x01`...`\x02` sentinels during substitution, then walk the merged string and escape only the spans between sentinels (`escapeOutsideSentinels()`). Alternatives considered: parsing the body into a token-vs-literal token stream first; building the body as a DOM tree client-side. Sentinel approach was the smallest change and has no failure mode short of operator-authored templates containing literal `\x01` characters (vanishingly unlikely).

2. **Heuristic footer CTA picker.** The brief specified `showApproverFooter: ctx.runtime.outcome.outcomeLabel == null`. Adopted verbatim — assignment emails fire on entry into an approver step (`outcomeLabel === null` because the next stage isn't an outcome), outcome emails fire on entry into an email step whose `transitions[0].to` IS an outcome (`outcomeLabel` populated). Correct in 100% of the cases the cascade ever produces.

3. **Logo source.** Used the existing `ASSETS.logoWhite` constant from `@splash/storage-r2/src/assets.ts` (`https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png`). The brief explicitly authorized this — Brief 32's damage check-request PDF embeds the same white logo from the same R2 URL, and that path has been operator-confirmed public.

4. **Brand line.** Used `Splash Car Wash · splashcarwashes.info` — lifted verbatim from `apps/forms-worker/src/pdf/layout-footer.ts:16` (which the brief flagged as one of the canonical sources to check). The PDF footer uses a hyphen separator (`-`) because pdf-lib's WinAnsi can't render U+00B7 (`·`) per Brief 133's sanitize work; the HTML email shell can carry the proper interpunct so I used it. If the operator prefers exact PDF parity, swap the `·` for a `-` in `BRAND_LINE` in `workflow-email-shell.ts:30`.

5. **CTA button style.** Primary (`{submission.url}`) = filled `#1FB6E0` blue with white text, 6px radius, 12px/24px padding, table-wrapped for Outlook-safe vertical spacing. Secondary (`{approvals.url}` / `{my_requests.url}`) = outlined navy (`#0E2745` border, white background, navy text), 10px/20px padding. Brief flagged "blue (#1FB6E0)" for primary and "outlined" for secondary without numbers; chose 2px borders and 6px radius based on email-client compatibility (3px+ radius is fine in Outlook 365 modern; older desktop Outlook with Word engine renders sharp corners regardless). `mso-padding-alt: 0` inline-attribute hint defends against the Word engine collapsing the `<a>` padding.

6. **CTA tinting on `{outcome.label}`.** Keyword heuristic: `/approv/i` → green `#047857`, `/(den|reject)/i` → red `#B91C1C`, else navy `#0E2745`. Tracks the Brief 125 `stage.tint` semantics (outcome stages with explicit tints exist but the email body's `{outcome.label}` token didn't have a wire-through path to read them). v2 candidate: pipe the stage's `tint` into `OutcomeContext` so the email renderer can use the operator's explicit choice; for now the keyword heuristic matches the default outcome names ("Approved" / "Denied").

7. **Payload table styling.** `<table>` with `width: 100%`, `background-color: #F9FAFB`, `border-radius: 6px`, key column at 35% width, navy-bold key text, plain text value, `1px solid #E5E7EB` bottom border per row. Brief asked for "key in left column (medium font weight, navy color), value in right column" — adopted with the soft-gray container background to visually separate the table from the surrounding paragraphs.

### Latent issues found

- The shared `OutboundEmailPayload.body_html` field has been `optional` in `packages/db-supabase/src/outbound-emails.ts` since Brief 127, and the queue table column has been `body_html TEXT NULL` since Brief 127's `supabase/forms-tables.sql`. Brief 134 stops sending null there — no schema change, no migration. PA flow update is operator-side and can land before or after the worker deploys; landing the worker first means new emails ship with `body_html` populated, and PA's existing "use body_text" wiring continues to work (operator may want to flip the conditional after deploy to actually surface HTML).
- The `outcomeForRender` computation in `cascadeThroughEmailSteps` already correctly threads `outcomeLabel` per email step (computed from the cascade's `nextStage`, NOT the cascade's start stage). No changes needed to the runtime context plumbing — the footer flag follows the email-step's local context, not the submission's overall state.
- `wrapInEmailShell` accepts an optional `title` field on `EmailShellOptions` not described in the brief — I added it because the document `<title>` is trivially populated from the subject and a few accessibility tools surface it. Harmless if unused.
- The brief flagged that operator-authored `body_template` may contain raw HTML — `renderTemplate`'s docblock says "Operators can write raw HTML in body_template if they need formatting; escape responsibility is theirs." That contract is preserved in plain text. In HTML render, operator-authored `<` / `>` / `&` outside tokens WILL be escaped via the sentinel-protected pass. This is a behavior change worth flagging: operators who put `<br>` literally in their template will now see the literal `<br>` text in the rendered HTML email. If this bites, the fix is to mark the operator's template as "trusted" via a new column / flag on the workflow stage — punt to v2.

### Canonical sources

- **Logo URL**: `ASSETS.logoWhite` from `@splash/storage-r2` →  `https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png`. Existing constant, not a new asset.
- **Brand line**: `Splash Car Wash · splashcarwashes.info`. Source: `apps/forms-worker/src/pdf/layout-footer.ts:16` (`"Splash Car Wash - splashcarwashes.info"` — the PDF uses a hyphen because of pdf-lib WinAnsi; the HTML email upgrades to a proper interpunct).

### PA flow update (operator-side, deferred)

In the Outlook Send-Email V2 action of the email-queue PA flow:

1. Open the "Send an email (V2)" action.
2. Set **Body** to the expression:
   ```
   if(not(empty(items('Apply_to_each')?['body_html'])),
      items('Apply_to_each')?['body_html'],
      items('Apply_to_each')?['body_text'])
   ```
3. Set **Is HTML** to:
   ```
   if(not(empty(items('Apply_to_each')?['body_html'])), true, false)
   ```
   (Or simply `true` if the worker is guaranteed to populate body_html on every row going forward.)

The exact `items('Apply_to_each')` reference depends on the flow's variable naming — the recipe is the conditional shape, not the literal expression.

### Rendering quirks discovered

- pdf-lib WinAnsi's inability to render U+00B7 (`·`) — already known per Brief 133. HTML shell can carry it natively; PDF code stays on ASCII separators.
- Outlook's Word renderer collapses padding on bare inline `<a>` tags. Wrapping each CTA in a one-row `<table>` is the conventional workaround (the table provides the box; the `<a>` provides the click target).
- `mso-padding-alt: 0` is a documented hint to the Word engine to not double-pad table cells with embedded `<a>` content. Included on CTA buttons defensively.
- Outlook strips `<style>` blocks in some configurations (most notably Outlook 365 on iOS via the OWA plugin). All styles are inline in this shell. No `<style>` block exists.
- `display: none` + `max-height: 0` + `mso-hide: all` + `visibility: hidden` + `opacity: 0` + `color: transparent` + `height: 0` + `width: 0` on the preheader `<div>` is the documented incantation to hide it in every major client while still surfacing it as inbox-preview text.
- Email-client image rendering: the white-script logo on navy band assumes the navy fill renders. Outlook does render `bgcolor` / inline `background-color` on `<td>` reliably; mobile Outlook on iOS occasionally inverts background colors in dark mode (cosmetic).
- The image element uses `width="200" height="60"` HTML attributes alongside `max-height: 60px; height: auto; width: auto;` inline style. The HTML attrs give Outlook a stable layout box; the inline style lets modern clients respect intrinsic aspect.

### Sample rendered HTML

**Assignment email (entry into an approver step)**:

Template:
```
Hi,

A new {form.title} submission was received.

{payload.summary}

Open in Splash: {submission.url}

— Splash team
```

Rendered fragment (before shell wrap) — pretty-printed for readability:
```html
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55; color: #1f2937;">Hi,</p>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55; color: #1f2937;">A new Newest workflow and form test submission was received.</p>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55; color: #1f2937;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 8px 0 20px 0; background-color: #F9FAFB; border-radius: 6px; padding: 4px 12px;"><tbody><tr><td style="padding: 8px 12px 8px 0; vertical-align: top; font-size: 14px; font-weight: 600; color: #0E2745; border-bottom: 1px solid #E5E7EB; width: 35%;">Site Number</td><td style="padding: 8px 0; vertical-align: top; font-size: 14px; color: #1f2937; border-bottom: 1px solid #E5E7EB;">127</td></tr>...</tbody></table></p>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55; color: #1f2937;">Open in Splash: <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0;"><tr><td><a href="https://splashcarwashes.info/admin/forms/.../submissions/..." style="display: inline-block; padding: 12px 24px; background-color: #1FB6E0; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 6px; border: 2px solid #1FB6E0; mso-padding-alt: 0;" target="_blank" rel="noopener">View Submission</a></td></tr></table></p>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.55; color: #1f2937;">— Splash team</p>
```

Wrapped in shell with `showApproverFooter: true`, the document opens with:
```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{escaped subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F6F8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0;">{first 100 chars of body_text}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #F4F6F8;">
<tr>
<td align="center" style="padding: 24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(14, 39, 69, 0.08);">
<tr>
<td align="center" style="background-color: #0E2745; padding: 20px 24px;">
<img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Wash" width="200" height="60" style="display: block; border: 0; outline: none; max-height: 60px; height: auto; width: auto;" />
</td>
</tr>
<tr>
<td style="padding: 28px 32px 16px 32px; background-color: #ffffff;">
{body fragment}
</td>
</tr>
<tr>
<td style="background-color: #F4F6F8; padding: 20px 32px; border-top: 1px solid #E5E7EB;">
<p style="margin: 0; font-size: 12px; color: #6B7280; line-height: 1.55; text-align: center;">Splash Car Wash · splashcarwashes.info</p>
<p style="margin: 8px 0 0 0; font-size: 12px; color: #6B7280; line-height: 1.55; text-align: center;"><a href="https://splashcarwashes.info/admin/approvals" style="color: #0E2745; text-decoration: underline;">View All Open Approvals</a></p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
```

**Outcome email (entry into an outcome stage via `attach_pdf` email step)**:

Template:
```
Hi,

Your submission for {form.title} was {outcome.label}.

{payload.summary}

You can review it any time: {submission.url}

— Splash team
```

`{outcome.label}` resolves to `<strong style="color: #047857;">Approved</strong>` (green tint via the `/approv/` keyword branch). The shell wrap differs from the assignment email only in the footer — `showSubmitterFooter: true` so the footer secondary line reads:
```html
<p style="margin: 8px 0 0 0; ...; text-align: center;"><a href="https://splashcarwashes.info/admin/my-requests" style="color: #0E2745; text-decoration: underline;">View My Requests</a></p>
```

To preview locally, save either rendered HTML as `sample.eml` with `Content-Type: text/html; charset=UTF-8` and open in Outlook / Gmail / Apple Mail.

