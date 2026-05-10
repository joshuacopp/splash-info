# Brief 91: Forms — public submit (`POST /forms/api/submit/{slug}`)

**Status:** Completed (2026-05-09)
**Started:** 2026-05-09
**Completed:** 2026-05-09
**Blocks:** Brief 92 (file/signature uploads — uploads need a submission to attach to, and the submit handler is what creates the submission row). Brief 93 (lookup re-resolve happens inside the submit handler). Brief 96 (submissions admin UI — needs real submissions to render).
**Dependencies:** Brief 89 (foundation), Brief 90 (render path — the form HTML this submit handler receives data from).

## Read first

- BUILD_STATE.md.
- CLAUDE.md.
- BRIEFS/brief-089-forms-foundation-schema-worker-package.md (schema, especially `form_submissions` columns).
- BRIEFS/brief-090-forms-public-render.md (the form HTML this brief receives — `pending_submission_id` hidden input, field name = `field.key`, `enctype="multipart/form-data"`).
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (Turnstile verification pattern — fleet's `siteverify` POST is the reference).
- BRIEFS/brief-019-action-result-refresh.md (NOT applicable here — form posts are NOT Next 15 server actions; they're plain HTML form posts handled by the worker, per Brief 37/38 rationale).
- packages/auth/src/index.ts (session validation for internal forms).
- packages/http/src/index.ts (`isOriginAllowed`, `jsonError` helpers).
- apps/forms-worker/src/render/index.ts (the form's `<form action>` already points at `/forms/api/submit/{slug}` — Brief 90 set this up).

## Architecture context

Per planning Decision 6, this brief wires the public submission endpoint with all the substrate from Decisions 4 (pending_submission_id idempotency) and 8 (audience-conditional auth):

- **Turnstile** verifies on `audience === 'public'`. POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `cf-turnstile-response` from the form body + `TURNSTILE_SECRET_KEY` from env. Same shape as fleet (Brief 81). Fail-soft when secret unbound (local-dev convenience; CLAUDE.md posture).
- **Session validation** on `audience === 'internal'`. Real validation here (not just cookie presence per Brief 90's render-time check). `@splash/auth` validates the `sb-access-token` cookie against Supabase; rejects with 401 + structured `{error:"session_expired"}` JSON if invalid. Brief 90's renderer warns the user about this via the "session expired" modal pattern (Decision 8b — preserves form state in client memory).
- **link-only**: no Turnstile, no auth. Slug acts as the gate.
- **CSRF**: `isOriginAllowed()` from `@splash/http`. Same posture as every other write surface in the monorepo (damage, signup, sysadmin, fleet). Apps/web service-binding calls set `Origin: https://internal`; plain HTML form POSTs from the public form set Origin to whatever splashcarwashes.info hostname they're on.
- **Idempotency** via `pending_submission_id`. Brief 90's renderer generates a UUID per form load and embeds it as `<input type="hidden" name="pending_submission_id">`. The submit handler `INSERT ... ON CONFLICT (id) DO NOTHING` so a network retry just lands at the same row instead of double-inserting. The DB returns the row whether the INSERT was new or a no-op; submit handler reads back to confirm.
- **Submitter capture**: `submitter_kind` is `'authenticated'` for internal/link-only-with-cookie, `'anonymous'` for public/link-only-without-cookie. `submitter_user_id` + `submitter_email` from the validated session (NULL when anonymous). `submitter_ip` from `CF-Connecting-IP` header for both audiences.

Per Decision 4, the **payload shape** in `form_submissions.payload` is a JSONB object keyed by `field.key`. Brief 91 handles text-only fields — file/signature payloads (which are `{r2_key, mime, size_bytes, ...}` shaped) get wired in Brief 92. For Brief 91, file/signature fields in the schema are accepted as form-data but not validated (their absence is allowed; their presence is ignored at the payload-write step). Lookup fields (which need server-side re-resolve per Decision 5a.ii) are similarly skipped here — Brief 93 wires the resolve. Brief 91 ships a working submit for the routine field types.

Per Decision 8, the **success UX** is a server-rendered thank-you page (full HTML render, not a modal). Operator-customizable `success_message` from the form metadata. The "Fill Again" button at the bottom uses Brief 85's relative-URL pattern (`<a href="/forms/{slug}">Fill out another</a>`) — works identically on workers.dev, staging, and post-cutover production with zero per-environment hardcoding.

Per Decision 8c, **link-only spam mitigation** (CF rate limit on the submit route) is deferred to Brief 98 (polish). Brief 91 ships without rate limiting; if abuse appears between 91 landing and 98 landing, operator can wire CF's native rate-limit rules manually.

## Context

Third of 10 briefs. After Brief 91 the system has end-to-end working submissions for text-only forms — operator can fill out a form via Brief 90's render path, hit Submit, see the thank-you page, and verify the row landed in `form_submissions`. File/signature/lookup field types still don't function but the rest of the form-builder feature has a working backbone.

This brief introduces no new bindings or new packages. All scope lives in `apps/forms-worker/src/`.

## Scope

### Phase 1 — Submit-time payload validators

**File:** `packages/forms-schema/src/validators/payload.ts` (NEW). Per-field-type Zod validators for the *value* (not the config) — used by the submit handler to validate what the user sent against the schema's expectations.

```ts
import { z } from "zod";
import type { Field } from "../types";

// Per-field-type value validators. Return `null` to skip validation for
// types Brief 91 doesn't handle (file, signature, lookup) — those are
// wired in Briefs 92 + 93.
export function payloadValidatorFor(field: Field): z.ZodTypeAny | null {
  switch (field.type) {
    case "heading":
    case "image":
      return null;     // display-only; no payload entry expected

    case "name":
      return field.required
        ? z.string().min(1).max(field.maxLength ?? 120)
        : z.string().max(field.maxLength ?? 120).optional();

    case "email":
      return field.required
        ? z.string().email().max(field.maxLength ?? 254)
        : z.string().email().max(field.maxLength ?? 254).optional().or(z.literal(""));

    case "phone":
      return field.required
        ? z.string().regex(/^\d{10}$/, "10 digits, no formatting")
        : z.string().regex(/^\d{10}$/).optional().or(z.literal(""));

    case "short_text":
      return field.required
        ? z.string().min(1).max(field.maxLength ?? 500)
        : z.string().max(field.maxLength ?? 500).optional();

    case "long_text":
      return field.required
        ? z.string().min(1).max(field.maxLength ?? 10000)
        : z.string().max(field.maxLength ?? 10000).optional();

    case "hidden":
      return z.string().max(2000).optional();

    case "dropdown": {
      const allowedValues = field.options.map((o) => o.value);
      const enumSchema = z.enum(allowedValues as [string, ...string[]]);
      return field.required ? enumSchema : enumSchema.optional().or(z.literal(""));
    }

    case "multi": {
      const allowedValues = field.options.map((o) => o.value);
      let arr = z.array(z.enum(allowedValues as [string, ...string[]]));
      if (field.minSelected) arr = arr.min(field.minSelected);
      if (field.maxSelected) arr = arr.max(field.maxSelected);
      return arr;
    }

    case "date":
      return field.required
        ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal(""));

    case "time":
      return field.required
        ? z.string().regex(/^\d{2}:\d{2}$/)
        : z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal(""));

    case "location":
      return field.required
        ? z.string().min(1).max(80)              // location_code slug
        : z.string().max(80).optional();

    case "file":
    case "signature":
      return null;     // Brief 92 wires these

    case "lookup":
      return null;     // Brief 93 wires the re-resolve
  }
}
```

Add to validators index:

```ts
// packages/forms-schema/src/validators/index.ts
export * from "./field-config";
export * from "./payload";
```

### Phase 2 — Worker DB helpers (extend Brief 90's set)

**File:** `apps/forms-worker/src/db/forms.ts` (MODIFY — append).

```ts
export interface SubmissionRow {
  id: string;
  formId: string;
  formVersionId: string;
  payload: Record<string, unknown>;
  submitterKind: "authenticated" | "anonymous";
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterIp: string | null;
  submittedAt: string;
  status: "new" | "in_progress" | "closed";
}

export async function insertSubmissionIdempotent(
  env: Env,
  args: {
    pendingSubmissionId: string;
    formId: string;
    formVersionId: string;
    payload: Record<string, unknown>;
    submitterKind: "authenticated" | "anonymous";
    submitterUserId: string | null;
    submitterEmail: string | null;
    submitterIp: string | null;
  }
): Promise<{ row: SubmissionRow; wasNew: boolean }> {
  const client = createServiceClient(env);
  // Try INSERT ... ON CONFLICT (id) DO NOTHING via PostgREST.
  // PostgREST: POST with `Prefer: resolution=ignore-duplicates`.
  // If duplicate, returns 200 with empty body; we then SELECT the existing row.
  const insertRes = await client
    .from("form_submissions")
    .insert({
      id: args.pendingSubmissionId,
      form_id: args.formId,
      form_version_id: args.formVersionId,
      payload: args.payload,
      submitter_kind: args.submitterKind,
      submitter_user_id: args.submitterUserId,
      submitter_email: args.submitterEmail,
      submitter_ip: args.submitterIp,
      // submitted_at, status default server-side
    }, { onConflict: "id", ignoreDuplicates: true })
    .select()
    .maybeSingle();

  if (insertRes.error) throw insertRes.error;

  if (insertRes.data) {
    return { row: rowToSubmission(insertRes.data), wasNew: true };
  }
  // Conflict happened — read the existing row.
  const selectRes = await client
    .from("form_submissions")
    .select("*")
    .eq("id", args.pendingSubmissionId)
    .single();
  if (selectRes.error) throw selectRes.error;
  return { row: rowToSubmission(selectRes.data), wasNew: false };
}

function rowToSubmission(r: Record<string, unknown>): SubmissionRow {
  return {
    id: r.id as string,
    formId: r.form_id as string,
    formVersionId: r.form_version_id as string,
    payload: r.payload as Record<string, unknown>,
    submitterKind: r.submitter_kind as "authenticated" | "anonymous",
    submitterUserId: (r.submitter_user_id as string | null) ?? null,
    submitterEmail: (r.submitter_email as string | null) ?? null,
    submitterIp: (r.submitter_ip as string | null) ?? null,
    submittedAt: r.submitted_at as string,
    status: r.status as "new" | "in_progress" | "closed"
  };
}
```

### Phase 3 — Form-data → payload conversion

**File:** `apps/forms-worker/src/submit/parse.ts` (NEW).

```ts
import type { FormVersion } from "@splash/forms-schema";

// Parse multipart form data into a typed payload keyed by field.key.
// Skips file/signature fields (Brief 92 wires those). Skips lookup fields
// (Brief 93 wires those). Multi-checkbox: collect all values for the same key.
export async function parseSubmitFormData(
  formData: FormData,
  schema: FormVersion["schema"]
): Promise<{
  payload: Record<string, unknown>;
  pendingSubmissionId: string;
  turnstileResponse: string | null;
}> {
  const pendingSubmissionId = String(formData.get("pending_submission_id") ?? "");
  const turnstileResponse = formData.get("cf-turnstile-response");
  const trStr = typeof turnstileResponse === "string" ? turnstileResponse : null;

  const payload: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.type === "heading" || field.type === "image") continue;
    if (field.type === "file" || field.type === "signature") continue;   // Brief 92
    if (field.type === "lookup") continue;                                // Brief 93

    const raw = formData.getAll(field.key);
    if (field.type === "multi") {
      payload[field.key] = raw.map((v) => String(v)).filter((v) => v !== "");
    } else {
      const single = raw[0];
      if (single === undefined) continue;     // omitted entirely
      const value = typeof single === "string" ? single : "";   // ignore File entries here
      if (value === "" && !field.required) continue;             // skip empty optional
      payload[field.key] = value;
    }
  }

  return { payload, pendingSubmissionId, turnstileResponse: trStr };
}
```

### Phase 4 — Turnstile verification

**File:** `apps/forms-worker/src/submit/turnstile.ts` (NEW).

```ts
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | null,
  remoteIp: string | null
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!secret) {
    // Fail-soft: secret unbound (local dev / not configured). Skip verification.
    console.warn("[forms] Turnstile secret unbound; skipping verification.");
    return { ok: true };
  }
  if (!token) return { ok: false, reason: "missing_token" };

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return { ok: false, reason: `siteverify_${res.status}` };
  const data = await res.json() as { success: boolean; "error-codes"?: string[] };
  if (data.success) return { ok: true };
  return { ok: false, reason: (data["error-codes"] ?? ["unknown"]).join(",") };
}
```

### Phase 5 — Submit handler

**File:** `apps/forms-worker/src/submit/index.ts` (NEW).

```ts
import { ACCESS_TOKEN_COOKIE, validateSession } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import { payloadValidatorFor } from "@splash/forms-schema";
import type { Env } from "../index";
import { getFormBySlug, getCurrentVersion, insertSubmissionIdempotent } from "../db/forms";
import { parseSubmitFormData } from "./parse";
import { verifyTurnstile } from "./turnstile";
import { renderSuccessPage } from "./success";

export async function handleSubmit(env: Env, req: Request, slug: string): Promise<Response> {
  // CSRF: same posture as every other write surface in the monorepo.
  if (!isOriginAllowed(req)) {
    return new Response("Bad origin", { status: 403 });
  }

  const form = await getFormBySlug(env, slug);
  if (!form) return new Response("Not Found", { status: 404 });
  if (form.status !== "published") return new Response("Form not accepting submissions", { status: 410 });
  if (!form.currentVersionId) return new Response("Form has no published version", { status: 410 });

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return new Response("Form version missing", { status: 500 });

  // Audience gate
  let submitterKind: "authenticated" | "anonymous" = "anonymous";
  let submitterUserId: string | null = null;
  let submitterEmail: string | null = null;

  if (form.audience === "internal") {
    const cookieHeader = req.headers.get("Cookie") ?? "";
    const session = await validateSession(env, cookieHeader);
    if (!session) {
      return jsonError(401, "session_expired", "Your session has expired. Please log in again in a new tab and click Retry on the form.");
    }
    submitterKind = "authenticated";
    submitterUserId = session.userId;
    submitterEmail = session.email;
  } else if (form.audience === "link-only") {
    // No auth required; capture session if present (operator submitting from inside admin)
    const cookieHeader = req.headers.get("Cookie") ?? "";
    if (cookieHeader.includes(`${ACCESS_TOKEN_COOKIE}=`)) {
      const session = await validateSession(env, cookieHeader);
      if (session) {
        submitterKind = "authenticated";
        submitterUserId = session.userId;
        submitterEmail = session.email;
      }
    }
  }
  // public: stays anonymous

  // Parse form data
  const formData = await req.formData();
  const { payload, pendingSubmissionId, turnstileResponse } = await parseSubmitFormData(formData, version.schema);

  if (!pendingSubmissionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingSubmissionId)) {
    return jsonError(400, "invalid_pending_id", "Form submission identifier missing or malformed.");
  }

  // Turnstile (public audience only)
  if (form.audience === "public" && form.turnstileRequired) {
    const remoteIp = req.headers.get("CF-Connecting-IP");
    const tr = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileResponse, remoteIp);
    if (!tr.ok) {
      return jsonError(400, "turnstile_failed", `Turnstile verification failed: ${tr.reason}. Please reload and try again.`);
    }
  }

  // Validate payload against schema
  const validationErrors: Record<string, string> = {};
  for (const field of version.schema.fields) {
    const validator = payloadValidatorFor(field);
    if (!validator) continue;
    const value = payload[field.key];
    const result = validator.safeParse(value);
    if (!result.success) {
      validationErrors[field.key] = result.error.errors[0]?.message ?? "Invalid value";
    }
  }
  if (Object.keys(validationErrors).length > 0) {
    return new Response(JSON.stringify({ error: "validation_failed", fields: validationErrors }), {
      status: 422,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Idempotent insert
  const submitterIp = req.headers.get("CF-Connecting-IP");
  let inserted;
  try {
    inserted = await insertSubmissionIdempotent(env, {
      pendingSubmissionId,
      formId: form.id,
      formVersionId: form.currentVersionId,
      payload,
      submitterKind,
      submitterUserId,
      submitterEmail,
      submitterIp
    });
  } catch (err) {
    console.error("[forms] insert failed", err);
    return jsonError(500, "insert_failed", "Could not save your submission. Please try again.");
  }

  // (Brief 97 wires the FORMS_SUBMISSION_WEBHOOK_URL fire here, fail-soft.)

  return renderSuccessPage(form, inserted.row);
}
```

### Phase 6 — Success page render

**File:** `apps/forms-worker/src/submit/success.ts` (NEW).

```ts
import { ASSETS } from "@splash/storage-r2";
import type { FormMeta } from "@splash/forms-schema";
import type { SubmissionRow } from "../db/forms";

export function renderSuccessPage(form: FormMeta, _submission: SubmissionRow): Response {
  const successMessage = form.successMessage ?? "Thank you for your submission.";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(form.title)} — Submitted</title>
  <style>
    :root { --splash-navy:#0a2240; --splash-blue:#1e5fa8; --splash-cyan:#4cc4ec; --splash-gray-light:#f4f6f9; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--splash-gray-light); color:#1a1a1a; line-height:1.5; }
    .splash-header { background: var(--splash-navy); padding: 16px 24px; }
    .splash-logo { height: 36px; display: block; }
    .success-main { max-width: 560px; margin: 0 auto; padding: 64px 16px; text-align: center; }
    .success-icon { font-size: 64px; color: #2ecc71; margin-bottom: 16px; }
    .success-title { color: var(--splash-navy); margin: 0 0 12px; }
    .success-msg { color: #555; margin: 0 0 32px; }
    .fill-again-btn { background: var(--splash-blue); color: white; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-weight: 600; display: inline-block; }
    .fill-again-btn:hover { background: var(--splash-navy); }
  </style>
</head>
<body>
  <header class="splash-header">
    <img src="${ASSETS.logoWhite}" alt="Splash Car Wash" class="splash-logo" />
  </header>
  <main class="success-main">
    <div class="success-icon" aria-hidden="true">&#x2713;</div>
    <h1 class="success-title">${escapeHtml(form.title)}</h1>
    <p class="success-msg">${escapeHtml(successMessage)}</p>
    <a href="/forms/${escapeHtml(form.slug)}" class="fill-again-btn">Fill out another</a>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
```

The "Fill out another" button uses Brief 85's relative-URL pattern — works on workers.dev / staging / production with no per-environment hardcoding.

### Phase 7 — Wire into router

**File:** `apps/forms-worker/src/index.ts` (MODIFY — extend Brief 90's router).

Add the submit route handler:

```ts
import { handleSubmit } from "./submit";

// ...inside fetch:
const submitMatch = url.pathname.match(/^\/forms\/api\/submit\/([^\/]+)$/);
if (submitMatch && req.method === "POST") {
  return handleSubmit(env, req, submitMatch[1]);
}
```

### Phase 8 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 ("Smoke tests") gets the Brief 91 entries:

> ### Brief 91 — public submit
>
> 1. Open `/forms/test-public` (Brief 90 test form). Fill in name/email/phone/location, complete Turnstile, submit. Expect: thank-you page renders with "Fill out another" button. Click button → returns to blank form.
> 2. Verify `form_submissions` row exists in Supabase: `SELECT * FROM form_submissions WHERE form_id = (SELECT id FROM forms WHERE slug = 'test-public') ORDER BY submitted_at DESC LIMIT 1;`. `submitter_kind = 'anonymous'`, `submitter_user_id IS NULL`, `submitter_ip IS NOT NULL`, `payload` contains the four fields.
> 3. Submit again with the SAME `pending_submission_id` (curl test): payload accepted, no duplicate row. Confirms idempotency.
> 4. Open `/forms/test-internal` while logged in as super_admin. Fill in site_number ("147") + issue, submit. Expect: thank-you page. Verify row has `submitter_kind = 'authenticated'`, `submitter_user_id` matches your auth.users.id, `submitter_email` matches.
> 5. Open `/forms/test-internal` in a fresh incognito window. Submit attempt → 401 with `session_expired` error JSON.
> 6. Open `/forms/test-link-only-x4kp9q2m7nf3`. Submit dropdown → success page; row inserted with `submitter_kind = 'anonymous'`.
> 7. Submit `/forms/test-public` with deliberately wrong email format (curl bypassing client validation). Expect: 422 with `error: "validation_failed"`, `fields: { email: "..." }`.

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 9 — Validation

```sh
pnpm --filter @splash/forms-schema typecheck
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
pnpm typecheck
```

## Configuration

No new env vars — Brief 89 already declared `TURNSTILE_SECRET_KEY` (optional). Operator binds before first public-form submit:

```sh
pnpm --filter @splash/forms-worker exec wrangler secret put TURNSTILE_SECRET_KEY
# Same value as on splash-fleet-inquiry.
```

Without the secret, public-form submits succeed (Turnstile fail-soft per fleet posture) — fine for development, NOT acceptable for production.

## Out of scope

- File / signature payload handling — Brief 92 (schema's file/signature fields are accepted as form-data but not validated/persisted in Brief 91).
- Lookup re-resolve — Brief 93 (lookup fields skipped at parse + validate + insert).
- Webhook fire on success — Brief 97.
- CF native rate limit on the submit route — Brief 98.
- Submitter-can-see-own-submissions UI — deferred per Decision 7 (v2).
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides to start execution.
- Don't commit to git or push.

## Definition of done

- `packages/forms-schema/src/validators/payload.ts` exports `payloadValidatorFor(field)` returning a Zod schema (or null for not-yet-handled types).
- `apps/forms-worker/src/submit/parse.ts`, `turnstile.ts`, `index.ts`, `success.ts` exist.
- `apps/forms-worker/src/db/forms.ts` extends with `insertSubmissionIdempotent` + `SubmissionRow` type.
- `apps/forms-worker/src/index.ts` routes `POST /forms/api/submit/{slug}` to the submit handler.
- Smoke tests in PRE_DEPLOY_FORMS.md pass at the operator level.
- `pnpm typecheck` green.
- `wrangler deploy --dry-run` green.
- Brief Status flips to Completed.

## Report

Surface in the Outcome section:

- **Decisions made on the operator's behalf.** Particularly: how `validateSession` from `@splash/auth` is called (signature might differ from this brief's assumption); whether `jsonError` from `@splash/http` exists with the expected signature (3-arg `status, code, message` per the brief's call sites — verify against the actual export); how Supabase PostgREST's `ignoreDuplicates: true` actually behaves in the supabase-js client (the brief assumes it returns `null` data on conflict; verify or adjust to `Prefer: resolution=ignore-duplicates` raw HTTP if the JS client doesn't support it cleanly).
- **Anything in the form-data parse logic that needed special handling.** Multi-value form fields, empty optional handling, etc.
- **Audience-gate edge cases.** What happens if `link-only` user has a stale session cookie that fails validation — should it be rejected or treated as anonymous? (Brief 91's logic above treats it as anonymous; flag if you took a different read.)
- **Validation results.**
- **Smoke tests run, if any.**

## Outcome

### Files created

- `packages/forms-schema/src/validators/payload.ts` — exports `payloadValidatorFor(field)` returning the per-field-type Zod value validator (or `null` for the not-yet-handled types `file` / `signature` / `lookup` per Briefs 92 / 93 deferral). Display-only types (`heading`, `image`) also return `null` — the submit handler skips them. Handles `required` vs optional via `.optional().or(z.literal(""))` so an empty form-data entry doesn't false-positive as a validation error for an optional field. `multi` derives its `min` from `field.minSelected ?? (field.required ? 1 : 0)` — when required + no explicit min, requires at least one selected. Regexes inlined as module-level consts (`EMAIL_RE`, `PHONE_RE`, `DATE_RE`, `TIME_RE`, `LOCATION_CODE_RE`).
- `apps/forms-worker/src/submit/parse.ts` — exports `parseSubmitFormData(formData, schema)` returning `{ payload, pendingSubmissionId, turnstileResponse }`. Walks `schema.fields`, skips display-only / file / signature / lookup, collects multi-checkbox values via `formData.getAll(key)`, drops empty optional entries, ignores File entries (Brief 92 wires those).
- `apps/forms-worker/src/submit/turnstile.ts` — exports `verifyTurnstile(secret, token, remoteIp)` mirroring the fleet-inquiry-worker pattern (Brief 81). Returns `{ ok: true }` when `secret` is unbound (fail-soft per CLAUDE.md fleet posture). 8s `AbortSignal.timeout` on the siteverify POST so a Turnstile outage doesn't block the request thread.
- `apps/forms-worker/src/submit/index.ts` — exports `handleSubmit(env, req, slug)`. CSRF gate via `isOriginAllowed`; audience-conditional auth (`internal` requires `authenticate()` success → 401 `session_expired` on miss; `link-only` opportunistically captures session if cookie valid; `public` stays anonymous); pending_submission_id format-validated against UUID regex; Turnstile only runs when `audience === "public" && form.turnstileRequired`; payload validated field-by-field with errors aggregated into `{ error: "validation_failed", fields: { key: msg } }` 422 response; insert via `insertSubmissionIdempotent`; success page rendered. `submitter_ip` captured from `CF-Connecting-IP` for both anonymous and authenticated submitters.
- `apps/forms-worker/src/submit/success.ts` — exports `renderSuccessPage(form)` returning a self-contained Splash-branded thank-you HTML page (navy header bar with white-script logo from `@splash/storage-r2 ASSETS`, success-card with checkmark + form title + `success_message`, "Fill out another" button using Brief 85's relative-URL pattern `/forms/{slug}` so it works on workers.dev / staging / production with zero per-environment hardcoding). Inline `SUCCESS_CSS` (~40 LOC). Reuses `escapeHtml` from `render/util.ts`.

### Files modified

- `packages/forms-schema/src/validators/index.ts` — added `export * from "./payload.js";` alongside the existing `field-config` re-export. The header docblock now distinguishes the two validator surfaces (config-shape vs. payload-value).
- `apps/forms-worker/src/db/forms.ts` — appended `SubmissionRow` interface, `InsertSubmissionArgs` interface, `insertSubmissionIdempotent(env, args)` helper. Implementation uses direct PostgREST `fetch()` (matches the file's existing Brief 90 pattern) with `Prefer: return=representation,resolution=ignore-duplicates` and `?on_conflict=id`. On the conflict path (empty `[]` body or 409 status) the helper falls back to a SELECT-by-id read so the caller always gets the canonical `SubmissionRow`. Returns `{ row, wasNew }` for observability — Brief 97's webhook fire can use `wasNew` to avoid double-firing on idempotent retries.
- `apps/forms-worker/src/index.ts` — added `SUPABASE_ANON_KEY: string` to the `Env` interface (required by `authenticate()` for its `/auth/v1/user` round-trip; Brief 90 didn't need it because the render-time gate only inspected cookie presence). Imported `handleSubmit` from `./submit/index.js`. Added the `POST /forms/api/submit/{slug}` route to the router. Header comment block updated to document Brief 91's submit path + auth model alongside Brief 90's render path.
- `apps/forms-worker/wrangler.toml` — added a comment-block entry for `SUPABASE_ANON_KEY` documenting the secret-put step the operator must run before the internal-audience submit path works. No `[vars]` change required (it's a secret, not a non-secret var).
- `PRE_DEPLOY_FORMS.md` — Section 2 ("Bindings") gained a Brief 91 paragraph spelling out the `SUPABASE_ANON_KEY` operator step. Section 5 ("Smoke tests") gained 8 entries for Brief 91 covering (1) public submit with Turnstile + Fill Again, (2) DB row sanity check, (3) idempotency via curl re-POST, (4) internal submit with valid session, (5) internal submit without session → 401 `session_expired`, (6) link-only submit, (7) validation_failed on bad email, (8) bad-origin 403 defense.
- `BUILD_STATE.md` — bumped Last-updated to Brief 91 narrative; added a new prioritized work list row 91; appended a Findings entry summarizing the work.
- `BRIEFS/INDEX.md` — appended a Brief 91 row.
- `BRIEFS/brief-091-forms-public-submit.md` — Status flipped to `Completed (2026-05-09)`; this Outcome section filled in.

### Decisions made on the operator's behalf

1. **`@splash/auth` API mismatch with the brief sample.** The brief's pseudo-code calls `validateSession(env, cookieHeader)` with a 2-arg signature returning `{userId, email} | null`. The actual export in `@splash/auth` is `authenticate(request, env)` returning `{ status: "authenticated", session } | { status: "unauthenticated" }` (where `session.userId` / `session.email` come from `auth_unified` via `getAuthContext`). Used the actual API verbatim — no monkey-patched wrapper — and wired the call sites accordingly. The brief's call-site pattern still works conceptually (one-line check; reject on `unauthenticated`).
2. **`jsonError` is 2-arg, not 3-arg.** The brief sample calls `jsonError(401, "session_expired", "Your session has expired. Please log in again...")` (status, code, message). The actual `@splash/http` export is `jsonError(status, message)` (the `message` is what's wrapped as `{ error: msg }`). Encoded the structured-error semantics by prefixing the message with the error code (`session_expired: log in again in a new tab and click Retry on the form`) so callers can string-match on the prefix. Same approach for the other error responses (`bad_origin`, `form_not_found`, `invalid_pending_id`, `turnstile_failed`, `insert_failed`). Validation errors use a custom `new Response(JSON.stringify({...}))` shape because `{error, fields}` is two-key, not the helper's single-key shape.
3. **PostgREST `Prefer: resolution=ignore-duplicates` over `@supabase/supabase-js`.** The brief sample uses the supabase-js client's `.insert(..., { onConflict: "id", ignoreDuplicates: true })` shape and assumes the SDK returns `null` data on conflict. Since the file already uses direct `fetch()` (Brief 90 / 71 pattern) and `@supabase/supabase-js` isn't a direct dep on forms-worker, I implemented the idempotency via the raw HTTP equivalent: POST with `Prefer: return=representation,resolution=ignore-duplicates` + `?on_conflict=id`. On a conflict the response body is `[]`; the helper falls back to a SELECT-by-id read. Same end-to-end semantics, no SDK dependency, smaller bundle.
4. **`SUPABASE_ANON_KEY` added as a required Env field, not optional.** Brief 89's wrangler.toml didn't list `SUPABASE_ANON_KEY` because Brief 90's render-time gate only inspected cookie presence. Brief 91's internal-audience submit calls `authenticate()` which calls `getAuthUser()` which uses `env.SUPABASE_ANON_KEY` for the apikey header on `/auth/v1/user`. Made it required on the `Env` type (extends the `SupabaseEnv` shape that workorders/damage/sysadmin all use) — this is a typecheck-enforceable invariant. Operator must `wrangler secret put SUPABASE_ANON_KEY` before internal-audience submits work; flagged in the wrangler.toml comment block + PRE_DEPLOY_FORMS.md Section 2. Public + link-only audiences are unaffected (the link-only opportunistic auth path silently degrades to anonymous when the anon key is unbound — `authenticate()` returns `unauthenticated` and we just skip the session capture).
5. **Stale link-only session cookie → anonymous, NOT 401.** The brief's logic (and this implementation) treats a stale `sb-access-token` on a link-only submit as anonymous: `link-only` audience means "the slug IS the gate; auth is icing". Brief 91's report request explicitly asked about this edge case — confirming the brief's stated logic.
6. **Validation errors aggregated rather than fail-fast.** All field validators run regardless of earlier failures so the user sees every problem in one round-trip (`fields: {field_key: msg, ...}`). Cost is negligible (Zod parses are cheap for primitives) and UX is materially better.
7. **`payload[field.key]` for empty optional fields is omitted, not stored as `""` or `null`.** Cleaner JSONB shape downstream — Brief 96's submissions admin UI can render "—" for missing fields without distinguishing between three falsy states.
8. **`multi`'s required handling.** When `field.required === true` and `field.minSelected` is unset, treat as min=1 so an empty submission of a required multi-checkbox fails with "Select at least 1". When `minSelected` is explicitly set, that value wins.
9. **Form `audience !== "published"` returns 410 (Gone), not 404.** Distinguishes between "this form was never published" / "this form was archived" and "this slug doesn't exist" for client-side UX. The 410 also signals to caching layers (none configured today) that the resource was intentionally retired.
10. **Success page does NOT reuse `render/shell.ts`.** The shell helper is shaped around the form-body case (`<form>` element + Turnstile + submit button + URL params for hidden defaults). The success page has none of those; refactoring `renderShell` to make the form bits optional would add a parameter purely to support one alternative caller. Two distinct files is cleaner.
11. **`form.successMessage` defaults to "Thank you for your submission."** when null/empty, matching the operator-facing description on the forms editor (Brief 95 will surface this as a placeholder on the success_message field).

### Form-data parse special handling

- **Multi-checkbox**: `formData.getAll(field.key)` returns every value submitted under the same name (browsers serialize each checked box as a separate entry). Filter out empty strings so an unchecked-then-rechecked box doesn't show up as `["", "value"]`.
- **Empty-optional skip**: `payload[field.key]` is unset (not present in the JSONB) when the field is optional and the user submitted nothing. Combined with the validator's `.or(z.literal(""))` handling on the path where the user explicitly POSTs an empty string, both shapes are accepted but only one (the meaningful one) lands in the payload.
- **File entries ignored**: a multipart form-data POST with a file input gives FormData entries that are `File` objects. Brief 91 explicitly out-of-scopes file/signature; the parse coerces `typeof first !== "string"` to `""` so a stray file-typed entry doesn't poison the payload. Brief 92 wires the real upload path.
- **`pending_submission_id`**: read out as a regular form field; the format-validation (UUID regex) happens in the submit handler, not the parser, so the parser stays a pure transformation.

### Audience-gate edge cases

- **Stale internal cookie**: 401 with structured `session_expired` JSON. Brief 90's render-time gate only checks cookie presence; the cookie can be present but expired by the time the user clicks Submit. The 401 lets the Brief 90 form's user-facing JS surface a "session expired" CTA without losing in-memory form state (Decision 8b — "preserves form state in client memory" — depends on the response shape staying parseable, which is why the error is a real JSON body and not just a 401 with no body).
- **Stale link-only cookie**: silently treated as anonymous per the brief's flag. Submission still lands as anonymous; no error. The slug is the gate.
- **Public + Turnstile secret unbound**: submit succeeds (fail-soft per CLAUDE.md fleet posture). Console.warn logged so the operator can spot it during smoke testing. Production should never have this state — PRE_DEPLOY_FORMS.md Section 2 lists the secret as a pre-deploy step.
- **Public + `forms.turnstile_required = false`**: skip Turnstile entirely (operator-controlled per-form opt-out via the `turnstile_required` column from Brief 89's schema).

### Latent issues found

- **`SUPABASE_ANON_KEY` not bound on `splash-forms` today.** Brief 89 didn't include it in the wrangler.toml comment block because Brief 90 didn't need it. Brief 91 DOES need it for internal-audience submit. PRE_DEPLOY_FORMS.md Section 2 now flags this; operator must `wrangler secret put SUPABASE_ANON_KEY` before queueing the operator-side smoke test for `/forms/test-internal`.
- **Bundle size grew significantly.** Brief 90 was 152.42 KiB / 27.04 KiB gzip. Brief 91 is 872.94 KiB / 163.14 KiB gzip — ~5.7× growth. Cause: pulling in `@splash/auth`'s `authenticate()` brings in the transitive `@supabase/supabase-js` SDK (used by `getAuthContext` in `@splash/db-supabase`). This was unavoidable for internal-audience auth. Still well inside CF's 3 MiB compressed free-tier limit. If we ever want to claw it back, the fix would be to inline a minimal version of `getAuthContext` in forms-worker (skipping the SDK), but that's a forms-wide refactor not a Brief 91 scope item.

### Validation results

| Step | Result |
|---|---|
| `pnpm --filter @splash/forms-schema typecheck` | green |
| `pnpm --filter @splash/forms-worker typecheck` | green |
| `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` | green — Total Upload: **872.94 KiB / 163.14 KiB gzipped**. Bindings resolved: FORMS_FILES R2 bucket, SUPABASE_URL var, TURNSTILE_SITE_KEY var |
| `pnpm typecheck` (root) | green — **17/17 packages successful**, 0 cached, 7.9s |

### Smoke tests run

None executed by Claude Code — operator runs the smoke test list in PRE_DEPLOY_FORMS.md Section 5 ("Brief 91 — public submit") post-deploy. Per CLAUDE.md, no automatic deploy; operator pushes when ready.
