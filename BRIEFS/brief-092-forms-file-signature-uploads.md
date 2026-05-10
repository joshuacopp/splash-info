# Brief 92: Forms — file + signature uploads (R2-backed)

**Status:** Completed (2026-05-09)
**Started:** 2026-05-09
**Completed:** 2026-05-09
**Blocks:** Brief 95 (admin builder UI — operator can't usefully build forms with file/signature fields if uploads don't work). Brief 96 (submissions admin UI — file detail rendering needs the R2 serve route this brief creates). Brief 97 (cron cleanup — depends on this brief's R2 path conventions).
**Dependencies:** Brief 89 (foundation — R2 binding, schema), Brief 90 (render path — file/signature inputs are rendered but non-functional), Brief 91 (submit handler — needs to be extended here to consume file payloads).

## Read first

- BUILD_STATE.md.
- CLAUDE.md.
- BRIEFS/brief-089-forms-foundation-schema-worker-package.md (R2 bucket binding `FORMS_FILES`, `form_submission_files` table schema).
- BRIEFS/brief-090-forms-public-render.md (the file/signature input render — `data-field-max-size-mb` attribute, signature canvas markup, hidden input pattern).
- BRIEFS/brief-091-forms-public-submit.md (the submit handler this brief extends — `parseSubmitFormData` currently skips file/signature; this brief un-skips).
- BRIEFS/brief-037-mobile-upload-legacy-port-plus-add-doc-anchor.md (precedent for mobile-friendly file upload UX in damage-worker — multipart, no Next 15 server actions, plain HTML form posts).
- packages/storage-r2/src/index.ts (existing R2 helpers — extend or mirror the patterns).
- apps/damage-worker/src/index.ts (the existing R2 upload precedent for damage claim photos — bytes-streaming pattern, MIME validation).

## Architecture context

Per planning Decisions 1 (X-shape) and 4 (pending_submission_id pattern) and 6 (file size limits, MIME sniffing):

**R2 path convention:**
```
form-submission-files/{form_id}/{pending_submission_id}/{field_key}/{original_filename}
```

For signatures (no original filename), the convention is:
```
form-submission-files/{form_id}/{pending_submission_id}/{field_key}/signature.{png|svg}
```

The `pending_submission_id` is the same UUID Brief 90's renderer embeds in the form's hidden input. Files upload BEFORE the submission row exists; the submission row is created on form submit (Brief 91) using the same UUID as `form_submissions.id`. After submit, R2 paths line up with the canonical submission_id automatically.

**Orphan tolerance:** if user abandons the form mid-fill, R2 has files at paths whose `pending_submission_id` never becomes a real submission row. Brief 97's daily cron cleans these up (delete R2 objects under `form-submission-files/` >24h with no matching `form_submissions.id`).

**MIME sniffing:** can't trust client `Content-Type` — trivially forgeable. Worker reads the first 12 bytes of every upload and derives the actual MIME via `file-type` library (~12KB, MIT, well-maintained, supports all the common image/document formats). If sniffed MIME doesn't match the field's `allowedMimeTypes`, reject with 400. This is the same posture that stops `.exe` renamed to `.jpg` from landing in R2.

**Size limits (per Decision 6):**

| Limit                          | Default              | Hard ceiling  | Where enforced                 |
|--------------------------------|----------------------|---------------|--------------------------------|
| Per-file size                  | 10 MB                | 25 MB         | upload handler (worker)        |
| Per-submission total size      | 50 MB                | 100 MB        | submit handler (worker, sums)  |
| Files per submission           | unlimited            | 20            | submit handler (worker, count) |

Per-field caps (`max_size_mb`, `allowed_mime_types`) live on the field's inspector config from Brief 90's `FileField` type. Hard ceilings are non-overridable — they're constants in `apps/forms-worker/src/limits.ts`. R2 free plan supports objects up to 5 GB but workers themselves have request body limits (~100 MB free tier / 500 MB paid). 25 MB per file keeps us well inside both.

**Signature library:** `signature_pad` v4 (~10KB, MIT). Vendored as a checked-in static asset (`apps/forms-worker/static/signature-pad.min.js`) — NOT loaded from CDN per CLAUDE.md supply-chain posture. Worker serves the file via `GET /forms/api/static/signature-pad.min.js` with long-cache headers. Same pattern would be used for any future bundled lib.

**Client-side JS** (signature canvas wiring + file upload preview + error display) lives in `apps/forms-worker/static/forms-public.js`. The render output's `<script src="/forms/api/static/forms-public.js" defer></script>` pulls it. Vanilla JS, no framework, ~150 LOC. Wires:
- Signature: instantiate `SignaturePad` per canvas, listen for `endStroke`, debounce 800ms, POST to `/forms/api/signature/{slug}`, store r2_key in the canvas's hidden input.
- File: on `change` event, immediate POST to `/forms/api/upload/{slug}`, show progress + preview thumbnail, store r2_key in a hidden input alongside the file input.
- Error display: per-field inline error div populated by `data-field-error` attribute or JS-set text node.

**Submit handler extension** (Brief 91's handler): `parseSubmitFormData` currently skips file/signature fields. This brief un-skips them — they appear in the payload as `{r2_key, mime, size_bytes, original_filename}` (file) or `{r2_key, format}` (signature). The values come from the hidden inputs the client-side JS populates after each upload, NOT from the multipart `<input type="file">` (which never gets sent because client-side JS uploads on change and submits the form with just the r2_key reference).

That last bit is important: by the time the form is SUBMITTED, the file/signature inputs are empty (their value was already uploaded out-of-band). What gets POSTed in the submit body is the `r2_key` hidden inputs the client wrote. The submit handler validates: each r2_key references an actual R2 object under the right path, sums sizes, then writes `form_submission_files` rows.

## Context

Fourth of 10 briefs. After this brief, all field types except Lookup (Brief 93) are functional. Operator can build a form with Name + Email + File + Signature, submit it, and verify both R2 storage and the `form_submission_files` audit table.

The biggest mechanical item is wiring the per-page client JS — the brief vendors `signature_pad` and adds a small `forms-public.js`. Both are served by the worker as static assets to keep the dependency surface tight.

## Scope

### Phase 1 — Worker constants

**File:** `apps/forms-worker/src/limits.ts` (NEW).

```ts
// Hard ceilings — non-overridable from field config. Operator-set per-field
// caps are bounded by these; if config exceeds, the worker clamps.
export const HARD_LIMITS = {
  PER_FILE_MAX_BYTES: 25 * 1024 * 1024,         // 25 MB
  PER_SUBMISSION_MAX_BYTES: 100 * 1024 * 1024,  // 100 MB
  PER_SUBMISSION_MAX_FILES: 20,
  SIGNATURE_MAX_BYTES: 1 * 1024 * 1024,         // 1 MB — signatures are small
  PENDING_FILE_TTL_HOURS: 24                    // for Brief 97's cron
} as const;

// Defaults for per-field config (operator can override down to these,
// but not above the hard ceilings).
export const DEFAULT_LIMITS = {
  PER_FILE_MAX_MB: 10,
  ALLOWED_MIME_TYPES: ["image/*", "application/pdf"]
} as const;
```

### Phase 2 — File upload handler

**File:** `apps/forms-worker/src/uploads/file.ts` (NEW).

```ts
import { fileTypeFromBuffer } from "file-type";
import { isOriginAllowed, jsonError } from "@splash/http";
import type { Env } from "../index";
import { HARD_LIMITS, DEFAULT_LIMITS } from "../limits";
import { getFormBySlug, getCurrentVersion } from "../db/forms";
import type { FileField } from "@splash/forms-schema";

interface UploadResult {
  r2_key: string;
  mime: string;
  size_bytes: number;
  original_filename: string;
}

export async function handleFileUpload(env: Env, req: Request, slug: string): Promise<Response> {
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });

  const form = await getFormBySlug(env, slug);
  if (!form) return new Response("Not Found", { status: 404 });
  if (form.status !== "published") return new Response("Form not accepting", { status: 410 });

  const version = await getCurrentVersion(env, form.id, form.currentVersionId!);
  if (!version) return new Response("Form version missing", { status: 500 });

  const formData = await req.formData();
  const pendingSubmissionId = String(formData.get("pending_submission_id") ?? "");
  const fieldKey = String(formData.get("field_key") ?? "");
  const fileEntry = formData.get("file");

  if (!pendingSubmissionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingSubmissionId)) {
    return jsonError(400, "invalid_pending_id", "Submission identifier missing or malformed.");
  }
  if (!fieldKey) return jsonError(400, "missing_field_key", "Field key required.");
  if (!(fileEntry instanceof File)) return jsonError(400, "no_file", "No file in upload body.");

  // Locate the field config in the schema
  const field = version.schema.fields.find((f) => f.key === fieldKey && f.type === "file") as FileField | undefined;
  if (!field) return jsonError(400, "unknown_field", `Field "${fieldKey}" is not a file field on this form.`);

  const file = fileEntry as File;
  const fieldMaxBytes = Math.min(
    (field.maxSizeMb ?? DEFAULT_LIMITS.PER_FILE_MAX_MB) * 1024 * 1024,
    HARD_LIMITS.PER_FILE_MAX_BYTES
  );

  if (file.size > fieldMaxBytes) {
    return jsonError(413, "file_too_large", `File exceeds ${Math.floor(fieldMaxBytes / 1024 / 1024)} MB limit.`);
  }
  if (file.size === 0) {
    return jsonError(400, "empty_file", "File is empty.");
  }

  // Read first 4100 bytes for MIME sniff (file-type max read length)
  const headerBuf = await file.slice(0, 4100).arrayBuffer();
  const sniffed = await fileTypeFromBuffer(new Uint8Array(headerBuf));
  if (!sniffed) {
    return jsonError(400, "unknown_file_type", "Could not determine file type from contents.");
  }

  // MIME-vs-allowlist check
  const allowedMimes = field.allowedMimeTypes ?? DEFAULT_LIMITS.ALLOWED_MIME_TYPES;
  if (!isMimeAllowed(sniffed.mime, allowedMimes)) {
    return jsonError(415, "mime_not_allowed", `File type ${sniffed.mime} not permitted for this field.`);
  }

  // R2 path
  const safeFilename = sanitizeFilename(file.name) || `upload.${sniffed.ext}`;
  const r2_key = `form-submission-files/${form.id}/${pendingSubmissionId}/${fieldKey}/${safeFilename}`;

  // Stream to R2
  try {
    await env.FORMS_FILES.put(r2_key, file.stream(), {
      httpMetadata: { contentType: sniffed.mime },
      customMetadata: {
        formId: form.id,
        pendingSubmissionId,
        fieldKey,
        originalFilename: file.name
      }
    });
  } catch (err) {
    console.error("[forms] R2 put failed", err);
    return jsonError(500, "r2_write_failed", "Could not save file. Please try again.");
  }

  const result: UploadResult = {
    r2_key,
    mime: sniffed.mime,
    size_bytes: file.size,
    original_filename: file.name
  };
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function isMimeAllowed(mime: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return mime.startsWith(prefix + "/");
    }
    return mime === pattern;
  });
}

function sanitizeFilename(name: string): string {
  // Strip path separators, control chars, leading dots. Keep extension.
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);
}
```

### Phase 3 — Signature upload handler

**File:** `apps/forms-worker/src/uploads/signature.ts` (NEW).

```ts
import { isOriginAllowed, jsonError } from "@splash/http";
import type { Env } from "../index";
import { HARD_LIMITS } from "../limits";
import { getFormBySlug, getCurrentVersion } from "../db/forms";
import type { SignatureField } from "@splash/forms-schema";

interface SignatureResult {
  r2_key: string;
  format: "png" | "svg";
  size_bytes: number;
}

export async function handleSignatureUpload(env: Env, req: Request, slug: string): Promise<Response> {
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });

  const form = await getFormBySlug(env, slug);
  if (!form) return new Response("Not Found", { status: 404 });
  if (form.status !== "published") return new Response("Form not accepting", { status: 410 });

  const version = await getCurrentVersion(env, form.id, form.currentVersionId!);
  if (!version) return new Response("Form version missing", { status: 500 });

  // Body shape: multipart with pending_submission_id + field_key + signature (Blob).
  const formData = await req.formData();
  const pendingSubmissionId = String(formData.get("pending_submission_id") ?? "");
  const fieldKey = String(formData.get("field_key") ?? "");
  const sigEntry = formData.get("signature");

  if (!pendingSubmissionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingSubmissionId)) {
    return jsonError(400, "invalid_pending_id", "Submission identifier missing or malformed.");
  }
  if (!fieldKey) return jsonError(400, "missing_field_key", "Field key required.");
  if (!(sigEntry instanceof Blob)) return jsonError(400, "no_signature", "No signature in upload body.");

  const field = version.schema.fields.find((f) => f.key === fieldKey && f.type === "signature") as SignatureField | undefined;
  if (!field) return jsonError(400, "unknown_field", `Field "${fieldKey}" is not a signature field on this form.`);

  const blob = sigEntry as Blob;
  if (blob.size === 0) return jsonError(400, "empty_signature", "Signature is empty.");
  if (blob.size > HARD_LIMITS.SIGNATURE_MAX_BYTES) {
    return jsonError(413, "signature_too_large", "Signature exceeds 1 MB.");
  }

  // Format determined by client; we trust it (signature_pad outputs PNG/SVG
  // by explicit method call, not user input). Brief 95's inspector lets
  // operator pick PNG vs SVG; brief 92 honors whatever the field config says.
  const format = field.format;
  const filename = `signature.${format}`;
  const mime = format === "png" ? "image/png" : "image/svg+xml";
  const r2_key = `form-submission-files/${form.id}/${pendingSubmissionId}/${fieldKey}/${filename}`;

  try {
    await env.FORMS_FILES.put(r2_key, blob.stream(), {
      httpMetadata: { contentType: mime },
      customMetadata: {
        formId: form.id,
        pendingSubmissionId,
        fieldKey,
        originalFilename: filename
      }
    });
  } catch (err) {
    console.error("[forms] signature R2 put failed", err);
    return jsonError(500, "r2_write_failed", "Could not save signature. Please try again.");
  }

  const result: SignatureResult = { r2_key, format, size_bytes: blob.size };
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
```

### Phase 4 — File serve route (admin-only)

**File:** `apps/forms-worker/src/uploads/serve.ts` (NEW). Returns R2 file content for admin viewing (e.g., `/admin/forms/[id]/submissions/[subId]` linking to a download). Cookie-gated (super_admin/admin only).

```ts
import { ACCESS_TOKEN_COOKIE, validateSession } from "@splash/auth";
import type { Env } from "../index";

export async function handleFileServe(env: Env, req: Request, r2_key: string): Promise<Response> {
  // Auth gate — admin-only access to submission files.
  const cookieHeader = req.headers.get("Cookie") ?? "";
  if (!cookieHeader.includes(`${ACCESS_TOKEN_COOKIE}=`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const session = await validateSession(env, cookieHeader);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (session.role !== "super_admin" && session.dcRole !== "admin" && session.dcRole !== "super_admin") {
    return new Response("Forbidden", { status: 403 });
  }

  // R2 key arrives as a path segment after /forms/admin/api/files/.
  // Validate it begins with form-submission-files/ or form-assets/ (no traversal).
  if (!r2_key.startsWith("form-submission-files/") && !r2_key.startsWith("form-assets/")) {
    return new Response("Bad key", { status: 400 });
  }
  if (r2_key.includes("..")) return new Response("Bad key", { status: 400 });

  const obj = await env.FORMS_FILES.get(r2_key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=300");
  // Inline display for images; attachment for everything else
  const ct = headers.get("Content-Type") ?? "";
  if (!ct.startsWith("image/")) {
    const filename = obj.customMetadata?.originalFilename ?? "download";
    headers.set("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  }
  return new Response(obj.body, { status: 200, headers });
}
```

### Phase 5 — Vendored static assets

**Directory:** `apps/forms-worker/static/` (NEW).

**File:** `apps/forms-worker/static/signature-pad.min.js` (NEW). Vendored from `signature_pad@4.x` minified bundle (~10KB). Executor pulls from `https://unpkg.com/signature_pad@4/dist/signature_pad.umd.min.js` once at brief execution time, saves to disk, never fetches at runtime.

(Per CLAUDE.md supply-chain posture, this is the ONE allowed CDN-fetch — and it's at brief-execution time, not at runtime. The file gets committed and the worker serves it directly. Operator can verify the SHA-256 against unpkg's published hash.)

**File:** `apps/forms-worker/static/forms-public.js` (NEW). Client-side wiring for file/signature inputs. ~150 LOC vanilla JS.

```js
// forms-public.js — client-side wiring for file + signature fields.
// Loaded via <script src="/forms/api/static/forms-public.js" defer></script>
// on every public-form render (Brief 90's renderShell will be extended in
// this brief to include the script tag).
//
// For each form on the page:
//   1. Wire signature canvases via SignaturePad (loaded separately).
//   2. Wire file inputs to upload-on-change with progress display.
//
// Pending submission ID is read from the form's <input name="pending_submission_id"> hidden input.

(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", initForms);

  function initForms() {
    var forms = document.querySelectorAll("form.forms-body");
    forms.forEach(function (formEl) {
      var pending = formEl.querySelector('input[name="pending_submission_id"]');
      if (!pending) return;
      var pendingId = pending.value;
      var slug = formEl.action.split("/").pop();   // /forms/api/submit/{slug}

      formEl.querySelectorAll('[data-field-type="signature"]').forEach(function (wrap) {
        wireSignature(wrap, slug, pendingId);
      });
      formEl.querySelectorAll('[data-field-type="file"]').forEach(function (wrap) {
        wireFile(wrap, slug, pendingId);
      });
    });
  }

  function wireSignature(wrap, slug, pendingId) {
    var canvas = wrap.querySelector("canvas.field-signature-canvas");
    var hidden = wrap.querySelector('input[type="hidden"]');
    var clearBtn = wrap.querySelector(".signature-clear-btn");
    var fieldKey = wrap.dataset.fieldKey;
    var format = wrap.dataset.format || "png";
    var penColor = wrap.dataset.penColor || "#000000";
    if (!canvas || !window.SignaturePad) return;

    var pad = new window.SignaturePad(canvas, { penColor: penColor });
    var debounce;

    pad.addEventListener("endStroke", function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { uploadSignature(pad, format, slug, pendingId, fieldKey, hidden, wrap); }, 800);
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        pad.clear();
        hidden.value = "";
        clearError(wrap);
      });
    }
  }

  function uploadSignature(pad, format, slug, pendingId, fieldKey, hiddenInput, wrap) {
    if (pad.isEmpty()) return;
    var blob;
    if (format === "svg") {
      var svg = pad.toSVG();
      blob = new Blob([svg], { type: "image/svg+xml" });
    } else {
      // toDataURL("image/png") → strip prefix, base64 decode → Uint8Array → Blob
      var dataUrl = pad.toDataURL("image/png");
      var b64 = dataUrl.split(",")[1];
      var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      blob = new Blob([bytes], { type: "image/png" });
    }
    var fd = new FormData();
    fd.append("pending_submission_id", pendingId);
    fd.append("field_key", fieldKey);
    fd.append("signature", blob);
    fetch("/forms/api/signature/" + encodeURIComponent(slug), { method: "POST", body: fd })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { showError(wrap, data.message || data.error); return; }
        hiddenInput.value = data.r2_key;
        clearError(wrap);
      })
      .catch(function () { showError(wrap, "Failed to save signature. Please try again."); });
  }

  function wireFile(wrap, slug, pendingId) {
    var input = wrap.querySelector('input[type="file"]');
    var fieldKey = wrap.dataset.fieldKey;
    if (!input) return;
    // We need a hidden input to carry the r2_key reference; create if absent.
    var hidden = wrap.querySelector('input[type="hidden"][data-r2-key="1"]');
    if (!hidden) {
      hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = fieldKey + "_r2";
      hidden.dataset.r2Key = "1";
      wrap.appendChild(hidden);
    }

    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) { hidden.value = ""; return; }
      uploadFile(file, slug, pendingId, fieldKey, hidden, wrap);
    });
  }

  function uploadFile(file, slug, pendingId, fieldKey, hiddenInput, wrap) {
    showUploading(wrap, file.name);
    var fd = new FormData();
    fd.append("pending_submission_id", pendingId);
    fd.append("field_key", fieldKey);
    fd.append("file", file);
    fetch("/forms/api/upload/" + encodeURIComponent(slug), { method: "POST", body: fd })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { showError(wrap, data.message || data.error); hiddenInput.value = ""; return; }
        hiddenInput.value = data.r2_key;
        showUploaded(wrap, file.name, data.size_bytes);
      })
      .catch(function () { showError(wrap, "Upload failed. Please try again."); });
  }

  function showError(wrap, msg) {
    clearError(wrap);
    var div = document.createElement("div");
    div.className = "field-error";
    div.style.color = "var(--splash-error)";
    div.style.fontSize = "13px";
    div.style.marginTop = "4px";
    div.textContent = msg;
    div.dataset.fieldError = "1";
    wrap.appendChild(div);
  }
  function clearError(wrap) {
    var existing = wrap.querySelector('[data-field-error="1"]');
    if (existing) existing.remove();
  }
  function showUploading(wrap, name) {
    clearError(wrap);
    showStatus(wrap, "Uploading " + name + "…");
  }
  function showUploaded(wrap, name, bytes) {
    var kb = Math.round(bytes / 1024);
    showStatus(wrap, "Uploaded " + name + " (" + kb + " KB)");
  }
  function showStatus(wrap, msg) {
    var existing = wrap.querySelector('[data-field-status="1"]');
    if (existing) existing.remove();
    var div = document.createElement("div");
    div.dataset.fieldStatus = "1";
    div.style.fontSize = "13px";
    div.style.color = "#666";
    div.style.marginTop = "4px";
    div.textContent = msg;
    wrap.appendChild(div);
  }
})();
```

**File:** `apps/forms-worker/src/uploads/static.ts` (NEW). Static-asset serve route.

```ts
import type { Env } from "../index";

// Vendored static assets — embedded as imported strings via TS resolveJsonModule
// won't work for JS. Two options:
//   (a) Read from R2 (executor uploads to R2 on first deploy)
//   (b) Bundle via wrangler's [build] step using wrangler-asset rules
// Brief 92 picks the simplest: bundle as imported text via wrangler's
// `rules` config below. The static/ directory contents get inlined into
// the worker bundle. ~25 KB combined; well within bundle headroom.

import signaturePadJs from "../../static/signature-pad.min.js";   // raw text via wrangler rule
import formsPublicJs  from "../../static/forms-public.js";

const ASSETS: Record<string, { body: string; contentType: string }> = {
  "/forms/api/static/signature-pad.min.js": { body: signaturePadJs, contentType: "application/javascript" },
  "/forms/api/static/forms-public.js":      { body: formsPublicJs,  contentType: "application/javascript" }
};

export function handleStaticAsset(_env: Env, _req: Request, path: string): Response | null {
  const asset = ASSETS[path];
  if (!asset) return null;
  return new Response(asset.body, {
    status: 200,
    headers: {
      "Content-Type": asset.contentType + "; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
```

**File:** `apps/forms-worker/wrangler.toml` (MODIFY). Add a `[[rules]]` block to bundle the static files as text imports:

```toml
[[rules]]
type = "Text"
globs = ["static/*.js"]
fallthrough = false
```

(This is the standard wrangler-bundling pattern for inlining text assets.)

### Phase 6 — Extend submit handler payload validators

**File:** `packages/forms-schema/src/validators/payload.ts` (MODIFY — replace the `null` returns for file/signature).

```ts
case "file": {
  // Payload shape: { r2_key, mime, size_bytes, original_filename } OR null/undefined when optional + omitted
  const fileSchema = z.object({
    r2_key: z.string().regex(/^form-submission-files\//),
    mime: z.string(),
    size_bytes: z.number().int().positive(),
    original_filename: z.string()
  });
  return field.required ? fileSchema : fileSchema.optional().nullable();
}

case "signature": {
  const sigSchema = z.object({
    r2_key: z.string().regex(/^form-submission-files\//),
    format: z.enum(["png", "svg"])
  });
  return field.required ? sigSchema : sigSchema.optional().nullable();
}
```

### Phase 7 — Extend submit-handler form-data parsing

**File:** `apps/forms-worker/src/submit/parse.ts` (MODIFY — un-skip file/signature).

```ts
// In the field-iteration loop, replace the file/signature skip with:

if (field.type === "file") {
  // Client wrote the r2_key into a hidden input named `${field.key}_r2`.
  // The corresponding visible <input type="file"> isn't sent at submit time
  // because the file was already uploaded via /forms/api/upload.
  const r2_key = String(formData.get(`${field.key}_r2`) ?? "");
  if (!r2_key) {
    if (field.required) {
      // Required but missing — let validator catch it
      payload[field.key] = null;
    }
    continue;
  }
  // Look up file metadata from form_submission_files? At parse-time we
  // don't have it yet — submit handler does the resolve via R2 head + DB.
  // For Brief 92 we synthesize the payload object from r2_key + a R2 head call.
  payload[field.key] = { r2_key };   // submit handler enriches with mime/size/filename
  continue;
}

if (field.type === "signature") {
  const r2_key = String(formData.get(field.key) ?? "");
  if (!r2_key) {
    if (field.required) payload[field.key] = null;
    continue;
  }
  payload[field.key] = { r2_key, format: (field as { format?: string }).format ?? "png" };
  continue;
}
```

### Phase 8 — Submit handler: R2 head + form_submission_files insert

**File:** `apps/forms-worker/src/submit/index.ts` (MODIFY — extend `handleSubmit` after the validation step, before the `insertSubmissionIdempotent` call).

```ts
// For each file/signature field with a present r2_key, HEAD the R2 object
// to confirm it exists + get authoritative size/mime, then enrich payload
// and queue the form_submission_files insert.

const fileRowsToInsert: Array<{
  field_key: string;
  r2_key: string;
  mime: string;
  size_bytes: number;
  original_filename: string | null;
}> = [];
let totalBytes = 0;
let totalFiles = 0;

for (const field of version.schema.fields) {
  if (field.type !== "file" && field.type !== "signature") continue;
  const entry = payload[field.key];
  if (!entry || typeof entry !== "object") continue;
  const r2_key = (entry as { r2_key?: string }).r2_key;
  if (!r2_key) continue;

  // R2 head — confirm the path matches this submission's prefix
  const expectedPrefix = `form-submission-files/${form.id}/${pendingSubmissionId}/${field.key}/`;
  if (!r2_key.startsWith(expectedPrefix)) {
    return jsonError(400, "bad_r2_key", `File reference for ${field.key} doesn't match this submission.`);
  }

  const head = await env.FORMS_FILES.head(r2_key);
  if (!head) {
    return jsonError(400, "missing_file", `File for ${field.key} not found in storage. Re-upload and try again.`);
  }

  totalFiles++;
  totalBytes += head.size;
  if (totalFiles > HARD_LIMITS.PER_SUBMISSION_MAX_FILES) {
    return jsonError(413, "too_many_files", "Too many files in this submission.");
  }
  if (totalBytes > HARD_LIMITS.PER_SUBMISSION_MAX_BYTES) {
    return jsonError(413, "submission_too_large", "Total submission size exceeds limit.");
  }

  const mime = head.httpMetadata?.contentType ?? "application/octet-stream";
  const original = head.customMetadata?.originalFilename ?? null;

  // Enrich payload with authoritative values
  payload[field.key] = field.type === "signature"
    ? { r2_key, format: (field as { format: "png" | "svg" }).format }
    : { r2_key, mime, size_bytes: head.size, original_filename: original };

  fileRowsToInsert.push({
    field_key: field.key,
    r2_key,
    mime,
    size_bytes: head.size,
    original_filename: original
  });
}

// (...existing validation pass on payload runs here, with enriched values)
// (...existing insertSubmissionIdempotent runs here)
// After successful submission insert:
if (fileRowsToInsert.length > 0) {
  const client = createServiceClient(env);
  const { error: filesErr } = await client
    .from("form_submission_files")
    .insert(fileRowsToInsert.map((row) => ({
      submission_id: pendingSubmissionId,
      field_key: row.field_key,
      r2_key: row.r2_key,
      mime: row.mime,
      size_bytes: row.size_bytes,
      original_filename: row.original_filename
    })));
  if (filesErr) {
    // Submission row already exists; log and continue. The orphan-cleanup
    // cron (Brief 97) will catch any R2 objects without a form_submission_files row.
    console.error("[forms] form_submission_files insert failed (submission already created)", filesErr);
  }
}
```

### Phase 9 — Render shell extension

**File:** `apps/forms-worker/src/render/shell.ts` (MODIFY).

Add the script tags to the `<head>`:

```ts
const scripts = `
  <script src="/forms/api/static/signature-pad.min.js" defer></script>
  <script src="/forms/api/static/forms-public.js" defer></script>
`;
// Inject before </head> in the existing template
```

### Phase 10 — Wire routes

**File:** `apps/forms-worker/src/index.ts` (MODIFY).

```ts
import { handleFileUpload } from "./uploads/file";
import { handleSignatureUpload } from "./uploads/signature";
import { handleFileServe } from "./uploads/serve";
import { handleStaticAsset } from "./uploads/static";

// In fetch():
const uploadMatch = url.pathname.match(/^\/forms\/api\/upload\/([^\/]+)$/);
if (uploadMatch && req.method === "POST") {
  return handleFileUpload(env, req, uploadMatch[1]);
}

const sigMatch = url.pathname.match(/^\/forms\/api\/signature\/([^\/]+)$/);
if (sigMatch && req.method === "POST") {
  return handleSignatureUpload(env, req, sigMatch[1]);
}

const serveMatch = url.pathname.match(/^\/forms\/admin\/api\/files\/(.+)$/);
if (serveMatch && req.method === "GET") {
  return handleFileServe(env, req, decodeURIComponent(serveMatch[1]));
}

const staticAsset = handleStaticAsset(env, req, url.pathname);
if (staticAsset) return staticAsset;
```

### Phase 11 — Add `file-type` dep

**File:** `apps/forms-worker/package.json` (MODIFY).

```json
"dependencies": {
  "@splash/auth": "workspace:*",
  "@splash/db-supabase": "workspace:*",
  "@splash/forms-schema": "workspace:*",
  "@splash/http": "workspace:*",
  "@splash/storage-r2": "workspace:*",
  "@splash/types": "workspace:*",
  "file-type": "^19.0.0"
}
```

`pnpm install` from repo root after the edit.

### Phase 12 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 ("Smoke tests") gets the Brief 92 entries:

> ### Brief 92 — file + signature uploads
>
> 1. Add a file field + signature field to a test form (operator updates `form_versions.schema` for `test-public` via SQL — append two new fields to the JSONB array; document the SQL in this section).
> 2. Open `/forms/test-public`. File input visible; signature canvas renders. Sign on the canvas; "Uploaded signature.png (XX KB)" status appears below.
> 3. Choose a small JPEG; "Uploaded photo.jpg (XX KB)" status appears.
> 4. Submit. Thank-you page renders. Verify `form_submissions.payload` contains both `{r2_key, ...}` entries; verify `form_submission_files` has matching rows.
> 5. Open R2 dashboard for `splash-forms-files`; confirm objects under `form-submission-files/{form_id}/{submission_id}/...` exist.
> 6. Try uploading a `.exe` renamed `.jpg` — expect 415 with `mime_not_allowed`.
> 7. Try uploading a 30 MB file — expect 413 with `file_too_large`.
> 8. Visit `/forms/admin/api/files/{r2_key}` while logged in as super_admin → file downloads / inline-displays. Visit while logged out → 401.

**File:** `CLAUDE.md`. Append to forms-worker glossary:

> Brief 92 wired file + signature uploads. R2 path convention: `form-submission-files/{form_id}/{pending_submission_id}/{field_key}/{filename}`. The `pending_submission_id` (from Brief 90's renderer hidden input) becomes `form_submissions.id` on submit, lining up R2 paths with the submission row's id automatically. MIME sniffing via `file-type` lib (~12KB, MIT) — first 12 bytes of every upload are read; client `Content-Type` is ignored. Hard ceilings (in `apps/forms-worker/src/limits.ts`): 25 MB per file, 100 MB per submission, 20 files per submission, 1 MB per signature. `signature_pad` is vendored as a checked-in static asset (NOT loaded from CDN — supply chain). Daily cron in Brief 97 cleans orphaned R2 objects (>24h, no matching `form_submissions.id`).

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 13 — Validation

```sh
pnpm install                                        # picks up file-type
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
pnpm typecheck
```

## Configuration

No new env vars. Operator must:

- Have R2 bucket `splash-forms-files` created (Brief 89's prerequisite).
- After this brief deploys, vendored static files (`signature-pad.min.js`, `forms-public.js`) are bundled into the worker — no separate operator step.

## Out of scope

- Lookup re-resolve at submit — Brief 93.
- Webhook fire on success — Brief 97.
- Daily R2 cleanup cron — Brief 97.
- Admin builder UI inspector for file/signature config — Brief 95.
- Multi-file (`allowMultiple: true`) support — wired in this brief at the schema level but UI/handler treats as single-file v1; multi handling is a v2 add.
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- `apps/forms-worker/src/limits.ts` exists with the hard ceilings.
- `apps/forms-worker/src/uploads/{file,signature,serve,static}.ts` exist.
- `apps/forms-worker/static/{signature-pad.min.js,forms-public.js}` exist as checked-in files.
- `apps/forms-worker/wrangler.toml` has the `[[rules]]` block for static text bundling.
- `apps/forms-worker/package.json` has `file-type` dep.
- `packages/forms-schema/src/validators/payload.ts` has Zod schemas for file + signature.
- `apps/forms-worker/src/submit/{parse,index}.ts` extended to handle file/signature payloads + R2 HEAD + `form_submission_files` insert.
- `apps/forms-worker/src/render/shell.ts` includes the new `<script>` tags.
- `apps/forms-worker/src/index.ts` routes upload/signature/serve/static paths.
- Smoke tests pass at operator level.
- `pnpm typecheck` green.
- `wrangler deploy --dry-run` green.
- Brief Status flips to Completed.

## Report

- **`signature_pad` vendoring.** Confirm SHA-256 of the vendored file matches unpkg's published hash for `signature_pad@4.x`.
- **`file-type` lib version.** What major version was actually installed; flag if 19.x has changed the import API.
- **Wrangler `[[rules]]` Text type.** Did this work as expected for inlining static assets, or did the executor need to use a different approach (e.g., reading from R2 at runtime)?
- **R2 HEAD performance.** Submission with N files makes N HEAD calls before insert. If this is slow, surface it; alternative is trusting the client-supplied `size_bytes` (less safe).
- **Validation results.**

## Outcome

### Files created

- `apps/forms-worker/src/limits.ts` — `HARD_LIMITS` (25 MB per file, 100 MB per
  submission, 20 files per submission, 1 MB per signature, 24h pending TTL) +
  `DEFAULT_LIMITS` (10 MB per-field default, image/* + application/pdf default
  MIME allow-list).
- `apps/forms-worker/src/uploads/file.ts` — `handleFileUpload(env, req, slug)`.
  Multipart parse → MIME sniff via `file-type@^19.6.0` first 4100 bytes → field
  config lookup + per-field cap clamp to HARD_LIMITS → R2 put under
  `form-submission-files/{form_id}/{pending_submission_id}/{field_key}/{filename}`
  with `formId` / `pendingSubmissionId` / `fieldKey` / `originalFilename`
  customMetadata for Brief 97's cron.
- `apps/forms-worker/src/uploads/signature.ts` — `handleSignatureUpload(...)`.
  Same shape but signature-specific; MIME derived from `field.format` not
  request body; format-aware filename (`signature.png` / `signature.svg`).
- `apps/forms-worker/src/uploads/serve.ts` — `handleFileServe(env, req,
  r2_key)`. `@splash/auth authenticate()` gate matching Brief 83's fleet
  posture (super_admin role OR admin/super_admin dcRole). Inline-display for
  images, force-download with `Content-Disposition: attachment;
  filename="..."` derived from R2 customMetadata for everything else. Path
  traversal defense + `form-submission-files/` / `form-assets/` prefix
  whitelist.
- `apps/forms-worker/src/uploads/static.ts` — `handleStaticAsset(env, req,
  path)`. Two assets bundled via wrangler `[[rules]] type = "Text"`: the
  vendored `signature-pad.min.js` and the new `forms-public.js`. Returns
  `Cache-Control: public, max-age=86400` + `X-Content-Type-Options: nosniff`.
  Returns null when path isn't recognized so the router can fall through.
- `apps/forms-worker/src/static-assets.d.ts` — TypeScript text-import shim
  declaring `*/static/signature-pad.min.js` and `*/static/forms-public.js`
  modules with default-string exports. Without this, `import x from
  "../../static/foo.js"` fails type-resolution.
- `apps/forms-worker/static/signature-pad.min.js` — vendored from
  `unpkg.com/signature_pad@4/dist/signature_pad.umd.min.js` (v4.2.0, MIT).
  11479 bytes; SHA-256 `49050fd4c2a4c66eff11a54f2552af743bb0681cde745760667c61e9c690b3e0`.
  Operator can verify against unpkg's published hash.
- `apps/forms-worker/static/forms-public.js` — ~190 LOC vanilla JS, no
  framework. Wires every form on the page: signature canvases via
  `SignaturePad` with 800ms debounced `endStroke` upload; file inputs with
  `change`-event upload + dynamically-created hidden `${key}_r2` companion
  input; per-field error/status divs.

### Files modified

- `apps/forms-worker/package.json` — added `file-type ^19.6.0` runtime dep.
- `apps/forms-worker/wrangler.toml` — added `[[rules]] type = "Text" globs =
  ["**/static/*.js"] fallthrough = false` block. The `**/` prefix matters —
  see Decision (c) below.
- `apps/forms-worker/src/index.ts` — 4 new path matchers (file upload,
  signature upload, static asset, admin file serve) + 4 new module imports +
  header docblock extended.
- `apps/forms-worker/src/db/forms.ts` — new `insertSubmissionFiles(env,
  rows)` + `SubmissionFileRowInsert` interface. Direct PostgREST `fetch()`
  with `Prefer: return=minimal`; failure logged but non-fatal.
- `apps/forms-worker/src/submit/index.ts` — R2 resolution pass between parse
  and validate (HEAD each r2_key, validate prefix matches the submission,
  accumulate per-submission size/count, enrich payload with authoritative
  size/mime/originalFilename); post-insert call to `insertSubmissionFiles`
  gated on `inserted.wasNew` so idempotent retries don't double-insert.
- `apps/forms-worker/src/submit/parse.ts` — un-skip file (reads
  `${field.key}_r2` hidden) + signature (reads `field.key` hidden); both
  produce `{r2_key, ...}` objects (or `null` when required+missing for the
  validator to flag).
- `apps/forms-worker/src/render/shell.ts` — `<script src="/forms/api/static/
  signature-pad.min.js" defer>` + `<script src="/forms/api/static/forms-
  public.js" defer>` injected in `<head>` (signature-pad must load first
  per defer ordering).
- `packages/forms-schema/src/validators/payload.ts` — file + signature
  branches now return Zod object schemas instead of `null`. Both
  `nullable().optional()` when `required === false`.
- `PRE_DEPLOY_FORMS.md` — new Section 5 "Brief 92" subsection with 8 smoke
  tests including the SQL fixture extension to add file+signature fields to
  the `test-public` form.
- `CLAUDE.md` — forms-worker glossary extended with the Brief 92 paragraph
  (path convention, MIME sniff, hard ceilings, vendored signature_pad, the
  `**/` glob gotcha, admin serve gate).
- `BUILD_STATE.md` — Last-updated bumped, prioritized work list row 92
  added, Findings entry added.
- `BRIEFS/INDEX.md` — Brief 92 row added.

### Decisions made on operator's behalf

(a) **`@splash/auth` API mismatch.** The brief draft referenced
`validateSession(env, cookieHeader)` but the actual exported entry point in
`packages/auth/src/session.ts` is `authenticate(req, env)` returning
`{status, session?}`. Used the canonical surface in `serve.ts`. Same
outcome.

(b) **`form_submission_files` insert path.** The brief draft suggested
`createServiceClient` from `@supabase/supabase-js`, but `@splash/db-supabase`
is the only dep that pulls supabase-js (transitively); forms-worker doesn't
import it directly. Used direct PostgREST `fetch()` matching the existing
forms-worker pattern (Brief 90/91), which keeps the bundle smaller and the
auth posture identical.

(c) **Wrangler glob mismatch.** First dry-run with `[[rules]] globs =
["static/*.js"]` (the brief's sample) failed with "module variable in ESM"
parser warning + "no matching export 'default'" error because the implicit
ESM rule for `.js` files matched first. Switched to `**/static/*.js` and
the rule matched correctly. CLAUDE.md updated with this gotcha so the next
executor doesn't trip on it.

(d) **`signature_pad@4.2.0` SHA-256.** Vendored file is 11479 bytes,
SHA-256 `49050fd4c2a4c66eff11a54f2552af743bb0681cde745760667c61e9c690b3e0`.
Operator can verify against unpkg's published hash for v4.2.0.

(e) **Hidden input naming.** File fields write the r2_key into a hidden
input named `${field.key}_r2` (so the visible `<input type="file">` and the
hidden carrier coexist with distinct names). Signature fields write the
r2_key into the existing hidden input the Brief 90 renderer already named
`${field.key}` (the canvas itself isn't a form field, so there's no name
collision).

(f) **Per-submission size/count enforcement.** Happens at submit time, not
upload time. Operator can keep uploading individual files within per-field
caps; the cap kicks in when they try to commit the whole submission. This
matches the brief's design and avoids the UX of "you uploaded 21 files,
delete one to commit" (which would require a delete-r2-object endpoint we
don't have yet).

(g) **`form_submission_files` insert is best-effort.** Failure logged but
doesn't reverse the canonical submission insert. Brief 97's orphan cleanup
sweeps R2 objects without DB rows. Submitter sees the success page either
way.

(h) **Signature format trust.** Format (PNG/SVG) is read from the field
config, not the request — `signature_pad` outputs format based on explicit
method call (`toDataURL("image/png")` vs `toSVG()`), so a misbehaving
client can't trick the worker into writing the wrong MIME.

(i) **`forms-public.js` keeps inline styles** (e.g.,
`div.style.color = "var(--splash-error)"`) rather than referencing a CSS
class. Vanilla JS can reach SHELL_CSS variables, and inline styles keep
the file dependency-free.

(j) **`handleStaticAsset` returns null on miss.** The router decides
whether to fall through or 404 — gives more flexibility for future asset
additions.

(k) **`r2_key` cross-submission defense.** Submit handler validates each
r2_key starts with `form-submission-files/{form_id}/{pending_submission_id}/{field_key}/`
before HEADing — prevents a malicious client from referencing another
submission's file at submit time.

### Latent issues found

1. **Wrangler glob sensitivity.** `static/*.js` doesn't match against the
   worker's source resolution; `**/static/*.js` does. Documented in
   CLAUDE.md.

2. **`signature_pad.min.js` is a UMD bundle.** Wrangler emits a "CommonJS
   module variable in ESM" warning on dry-run even with the Text rule
   applied, because wrangler reads the file's first line BEFORE deciding
   whether to apply the rule. Cosmetic only — the file is treated as text
   and never executed in the worker.

3. **`file-type@^19.6.0` works with `nodejs_compat`.** Already enabled in
   wrangler.toml since Brief 89. Bundle grew +102 KiB from `file-type` +
   its `strtok3` / `token-types` deps.

4. **`forms-public.js` style inconsistency.** Status messages use inline
   `style.color="#666"` rather than brand tokens — minor inconsistency
   kept for vanilla-JS simplicity.

5. **`signature_pad@4.x` API.** `addEventListener` was added in v4.0.0;
   pinning to v4 ensures the `endStroke` event registration works.

### Validation

- `pnpm install` ran successfully — `file-type@19.6.0` + 4 transitive deps
  resolved.
- `pnpm --filter @splash/forms-worker typecheck` — green.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` — green
  at **975.33 KiB / 187.11 KiB gzipped** (bindings: FORMS_FILES R2,
  SUPABASE_URL var, TURNSTILE_SITE_KEY var). Up from Brief 91's 872.94 KiB /
  163.14 KiB (+12% from `file-type` + 2 vendored static assets). Well inside
  CF's 3 MiB compressed limit.
- Root `pnpm typecheck` — 17/17 packages green.

### Report (per brief's `## Report` section)

- **`signature_pad` vendoring.** v4.2.0 from unpkg, 11479 bytes, SHA-256
  `49050fd4c2a4c66eff11a54f2552af743bb0681cde745760667c61e9c690b3e0`.
  Verifiable against unpkg's published hash for v4.2.0.

- **`file-type` lib version.** Installed `^19.6.0` (resolved per pnpm to the
  latest 19.x at install time). Import API used:
  `fileTypeFromBuffer(uint8array)` — works as expected; no API change
  warnings on install.

- **Wrangler `[[rules]]` Text type.** Worked once we used the right glob.
  First attempt (`static/*.js` per the brief sample) failed because the
  implicit ESM rule matched first. The `**/static/*.js` form (with `**/`
  prefix and `fallthrough = false`) matches correctly.

- **R2 HEAD performance.** N HEAD calls per submission (one per
  file/signature). For typical forms (1–2 attachments + 1 signature) this is
  3 round-trips — well under a second on CF's edge. The alternative
  (trusting client-supplied `size_bytes`) would let a malicious client
  inflate the per-submission cap. Going to leave as-is until a real form
  with 10+ uploads surfaces a perf problem.

- **Validation results.** Above.

### Smoke tests

Deferred to operator post-deploy per CLAUDE.md "don't deploy automatically"
line. PRE_DEPLOY_FORMS.md Section 5 has the full test list including the SQL
fixture extension to add file + signature fields to the `test-public` form.
