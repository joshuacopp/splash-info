// Splash Forms Worker — Brief 89 scaffolding + Brief 90 public render path
// + Brief 91 public submit + Brief 92 file/signature uploads + Brief 93
// lookup resolve + Brief 94 admin API (CRUD + draft/publish lifecycle +
// assets + lookup-sources).
//
// Routes:
//   GET    /forms/{slug}                              — Brief 90: public form render
//   POST   /forms/api/submit/{slug}                   — Brief 91: public form submit
//   POST   /forms/api/upload/{slug}                   — Brief 92: file upload
//   POST   /forms/api/signature/{slug}                — Brief 92: signature upload
//   POST   /forms/api/lookup/{slug}                   — Brief 93: on-demand lookup resolve
//   GET    /forms/api/static/*                        — Brief 92: vendored client JS
//   GET    /forms/admin/api/files/*                   — Brief 92: admin-gated R2 serve
//   GET    /forms/admin/api/lookup-sources            — Brief 94: lookup registry
//   GET    /forms/admin/api/forms                     — Brief 94: list forms
//   POST   /forms/admin/api/forms                     — Brief 94: create form
//   GET    /forms/admin/api/forms/{id}                — Brief 94: get form detail
//   PATCH  /forms/admin/api/forms/{id}/draft          — Brief 94: save draft
//   POST   /forms/admin/api/forms/{id}/publish        — Brief 94: publish draft
//   POST   /forms/admin/api/forms/{id}/unpublish      — Brief 94: archive
//   POST   /forms/admin/api/forms/{id}/republish      — Brief 94: re-publish from archived
//   POST   /forms/admin/api/forms/{id}/assets         — Brief 94: upload in-form image
//   DELETE /forms/admin/api/forms/{id}/assets/{assetId} — Brief 94: delete in-form image
//   GET    /forms/admin/api/forms/{id}/submissions    — Brief 96: list submissions
//   GET    /forms/admin/api/forms/{id}/submissions.csv — Brief 96: CSV export
//   GET    /forms/admin/api/forms/{id}/submissions/{subId}   — Brief 96: detail
//   PATCH  /forms/admin/api/forms/{id}/submissions/{subId}   — Brief 96: notes/status
//   GET    /forms/admin/api/forms/{id}/versions       — Brief 96: version history
//
// Audience gating (Brief 90 render path / Brief 91 submit path):
//   public      → no auth; Turnstile widget rendered when site key bound;
//                 Turnstile verification happens at submit time
//   internal    → render-time check for `sb-access-token` cookie presence
//                  (full session validation deferred to submit time per
//                  planning Decision 8b); 302 to /login?next=... on miss;
//                  submit time runs full session validation via @splash/auth
//                  authenticate() — stale cookie returns 401 with structured
//                  `session_expired` JSON.
//   link-only   → slug acts as gate; no further check; submit captures
//                 session if present, anonymous otherwise.

import { ACCESS_TOKEN_COOKIE } from "@splash/auth";
import {
  getFormBySlug,
  getCurrentVersion,
  getLocationOptionsFromPricingSimple
} from "./db/forms.js";
import { renderShell } from "./render/shell.js";
import { renderFormBody } from "./render/index.js";
import { handleSubmit } from "./submit/index.js";
import { handleFileUpload } from "./uploads/file.js";
import { handleSignatureUpload } from "./uploads/signature.js";
import { handleFileServe } from "./uploads/serve.js";
import { handleStaticAsset } from "./uploads/static.js";
import { handleLookupResolve } from "./lookup/resolve.js";
import {
  handleListForms,
  handleCreateForm,
  handleGetForm,
  handleUpdateDraft,
  handlePublish,
  handleStatusChange
} from "./admin/forms.js";
import { handleAssetUpload, handleAssetDelete } from "./admin/assets.js";
import { handleLookupSources } from "./admin/lookup-sources.js";
import {
  handleListSubmissions,
  handleGetSubmission,
  handlePatchSubmission,
  handleSubmissionsCsv
} from "./admin/submissions.js";
import { handleListVersions } from "./admin/versions.js";
import { runDailyCleanup } from "./cron/cleanup.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /** Required for `authenticate()` from @splash/auth — the /auth/v1/user
   *  round-trip uses the anon key. Brief 91 (internal-audience submit) is
   *  the first consumer; Brief 90's render-time check only inspected the
   *  cookie's presence, so the anon key wasn't needed yet. */
  SUPABASE_ANON_KEY: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  FORMS_SUBMISSION_WEBHOOK_URL?: string;
  FORMS_FILES: R2Bucket;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // GET /forms/{slug} — public form render (Brief 90).
    const renderMatch = url.pathname.match(/^\/forms\/([^/]+)$/);
    if (renderMatch && renderMatch[1] && req.method === "GET") {
      return handleFormRender(env, req, url, renderMatch[1]);
    }

    // POST /forms/api/submit/{slug} — public form submit (Brief 91).
    // ctx is plumbed through so the Brief 97 webhook fire can use
    // ctx.waitUntil after the success response is returned.
    const submitMatch = url.pathname.match(/^\/forms\/api\/submit\/([^/]+)$/);
    if (submitMatch && submitMatch[1] && req.method === "POST") {
      return handleSubmit(env, req, ctx, submitMatch[1]);
    }

    // POST /forms/api/upload/{slug} — file upload (Brief 92).
    const uploadMatch = url.pathname.match(/^\/forms\/api\/upload\/([^/]+)$/);
    if (uploadMatch && uploadMatch[1] && req.method === "POST") {
      return handleFileUpload(env, req, uploadMatch[1]);
    }

    // POST /forms/api/signature/{slug} — signature upload (Brief 92).
    const signatureMatch = url.pathname.match(/^\/forms\/api\/signature\/([^/]+)$/);
    if (signatureMatch && signatureMatch[1] && req.method === "POST") {
      return handleSignatureUpload(env, req, signatureMatch[1]);
    }

    // POST /forms/api/lookup/{slug} — on-demand lookup resolve (Brief 93).
    const lookupMatch = url.pathname.match(/^\/forms\/api\/lookup\/([^/]+)$/);
    if (lookupMatch && lookupMatch[1] && req.method === "POST") {
      return handleLookupResolve(env, req, lookupMatch[1]);
    }

    // GET /forms/api/static/* — vendored client JS (Brief 92).
    if (url.pathname.startsWith("/forms/api/static/") && req.method === "GET") {
      const asset = handleStaticAsset(env, req, url.pathname);
      if (asset) return asset;
      return notFoundPage();
    }

    // GET /forms/admin/api/files/{r2_key} — admin-gated R2 serve (Brief 92).
    const serveMatch = url.pathname.match(/^\/forms\/admin\/api\/files\/(.+)$/);
    if (serveMatch && serveMatch[1] && req.method === "GET") {
      return handleFileServe(env, req, decodeURIComponent(serveMatch[1]));
    }

    // ---- Brief 94 admin API ---------------------------------------------

    // GET /forms/admin/api/lookup-sources
    if (url.pathname === "/forms/admin/api/lookup-sources" && req.method === "GET") {
      return handleLookupSources(env, req);
    }

    // /forms/admin/api/forms (list / create)
    if (url.pathname === "/forms/admin/api/forms") {
      if (req.method === "GET") return handleListForms(env, req);
      if (req.method === "POST") return handleCreateForm(env, req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // /forms/admin/api/forms/{id}
    const detailMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)$/
    );
    if (detailMatch && detailMatch[1]) {
      if (req.method === "GET") return handleGetForm(env, req, detailMatch[1]);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // /forms/admin/api/forms/{id}/draft
    const draftMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/draft$/
    );
    if (draftMatch && draftMatch[1] && req.method === "PATCH") {
      return handleUpdateDraft(env, req, draftMatch[1]);
    }

    // /forms/admin/api/forms/{id}/publish
    const publishMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/publish$/
    );
    if (publishMatch && publishMatch[1] && req.method === "POST") {
      return handlePublish(env, req, publishMatch[1]);
    }

    // /forms/admin/api/forms/{id}/unpublish
    const unpublishMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/unpublish$/
    );
    if (unpublishMatch && unpublishMatch[1] && req.method === "POST") {
      return handleStatusChange(env, req, unpublishMatch[1], "archived");
    }

    // /forms/admin/api/forms/{id}/republish
    const republishMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/republish$/
    );
    if (republishMatch && republishMatch[1] && req.method === "POST") {
      return handleStatusChange(env, req, republishMatch[1], "published");
    }

    // /forms/admin/api/forms/{id}/assets
    const assetUploadMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/assets$/
    );
    if (assetUploadMatch && assetUploadMatch[1] && req.method === "POST") {
      return handleAssetUpload(env, req, assetUploadMatch[1]);
    }

    // /forms/admin/api/forms/{id}/assets/{assetId}
    const assetDeleteMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/assets\/([^/]+)$/
    );
    if (
      assetDeleteMatch &&
      assetDeleteMatch[1] &&
      assetDeleteMatch[2] &&
      req.method === "DELETE"
    ) {
      return handleAssetDelete(env, req, assetDeleteMatch[1], assetDeleteMatch[2]);
    }

    // ---- Brief 96 admin submissions / versions --------------------------
    // The `submissions.csv` literal must be matched BEFORE the generic
    // `submissions/{subId}` pattern so the `.csv` suffix doesn't get
    // interpreted as a UUID. Order matters within this block too.

    // GET /forms/admin/api/forms/{id}/submissions.csv
    const subCsvMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/submissions\.csv$/
    );
    if (subCsvMatch && subCsvMatch[1] && req.method === "GET") {
      return handleSubmissionsCsv(env, req, subCsvMatch[1]);
    }

    // GET /forms/admin/api/forms/{id}/submissions
    const subListMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/submissions$/
    );
    if (subListMatch && subListMatch[1] && req.method === "GET") {
      return handleListSubmissions(env, req, subListMatch[1]);
    }

    // /forms/admin/api/forms/{id}/submissions/{subId}
    const subDetailMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/submissions\/([^/]+)$/
    );
    if (subDetailMatch && subDetailMatch[1] && subDetailMatch[2]) {
      if (req.method === "GET") {
        return handleGetSubmission(env, req, subDetailMatch[1], subDetailMatch[2]);
      }
      if (req.method === "PATCH") {
        return handlePatchSubmission(env, req, subDetailMatch[1], subDetailMatch[2]);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // GET /forms/admin/api/forms/{id}/versions
    const versionsMatch = url.pathname.match(
      /^\/forms\/admin\/api\/forms\/([^/]+)\/versions$/
    );
    if (versionsMatch && versionsMatch[1] && req.method === "GET") {
      return handleListVersions(env, req, versionsMatch[1]);
    }

    return notFoundPage();
  },

  // Brief 97 — daily R2 orphan cleanup. Trigger configured in
  // wrangler.toml's `[triggers] crons = ["0 11 * * *"]` block. The
  // [observability.logs] block from Brief 89 covers scheduled
  // invocations automatically (eventType: scheduled in CF dashboard).
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      runDailyCleanup(env).then((result) => {
        console.log("[forms.cleanup.cron] result", result);
      })
    );
  }
};

async function handleFormRender(
  env: Env,
  req: Request,
  url: URL,
  slug: string
): Promise<Response> {
  const form = await getFormBySlug(env, slug);
  if (!form) return notFoundPage();
  if (form.status !== "published") return notFoundPage();   // draft / archived 404 publicly
  if (!form.currentVersionId) return notFoundPage();         // never published

  // Audience gate.
  if (form.audience === "internal") {
    const cookies = req.headers.get("Cookie") ?? "";
    if (!cookies.includes(`${ACCESS_TOKEN_COOKIE}=`)) {
      const next = encodeURIComponent(url.pathname + url.search);
      return Response.redirect(`${url.origin}/login?next=${next}`, 302);
    }
  }
  // public: Turnstile widget rendered (verification at submit time, Brief 91).
  // link-only: slug acts as gate.

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return notFoundPage();

  const hasLocationField = version.schema.fields.some((f) => f.type === "location");
  const locationOptions = hasLocationField
    ? await getLocationOptionsFromPricingSimple(env)
    : [];

  const pendingSubmissionId = crypto.randomUUID();
  const includeTurnstile = form.audience === "public" && !!env.TURNSTILE_SITE_KEY;

  const bodyHtml = renderFormBody({
    form,
    version,
    locationOptions,
    pendingSubmissionId,
    turnstileSiteKey: includeTurnstile ? env.TURNSTILE_SITE_KEY : undefined,
    urlParams: url.searchParams
  });

  const html = renderShell({
    form,
    bodyHtml,
    turnstileSiteKey: includeTurnstile ? env.TURNSTILE_SITE_KEY : undefined
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin"
    }
  });
}

function notFoundPage(): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Form not found — Splash</title></head><body style="font-family:sans-serif;padding:48px;text-align:center;"><h1>Form not found</h1><p>This form is unavailable.</p></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
