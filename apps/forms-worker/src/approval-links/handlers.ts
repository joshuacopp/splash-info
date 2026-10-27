// Emailed no-sign-in approval page.
//
//   GET  /forms/approve/{token}  — the request, plus the stage's actions
//   POST /forms/approve/{token}  — record the decision
//
// The token IS the credential. Everything else a signed-in approval checks
// still runs, through the same applyTransition the dashboard uses: the
// recipient must be on the stage's approver list, the transition must exist
// from the current stage, and its `requires` (signature / note / typed name)
// must be met. The link adds three checks of its own -- expiry, already used,
// and stage-moved -- in validateLink, run on BOTH requests so a page left open
// for a day cannot submit against a submission that moved on underneath it.
//
// See tokens.ts for why opening the page does not use the link up.

import { isOriginAllowed } from "@splash/http";
import {
  isPackagePriceRows,
  isPackagePriceSites,
  packageLabel,
  priceDiff,
  serviceCategoryLabel,
  siteLabel,
  type Field,
  type FormMeta,
  type FormSchema,
  type PackagePriceRow,
  type PackagePriceSite,
  type WorkflowStage,
  type WorkflowTransition
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getSubmission } from "../db/admin-submissions.js";
import { applyTransition } from "../admin/submissions.js";
import { resolveDisplayValue } from "../workflow-email-step.js";
import { renderShell } from "../render/shell.js";
import { escapeHtml } from "../render/util.js";
import {
  MAX_LINK_OPENS,
  claimApprovalLink,
  findApprovalLink,
  recordApprovalLinkOpen,
  releaseApprovalLink,
  type ApprovalLinkRow
} from "./tokens.js";

const SIGNATURE_MAX_BYTES = 1 * 1024 * 1024;

type Submission = NonNullable<Awaited<ReturnType<typeof getSubmission>>>;

type LinkCheck =
  | { ok: true; link: ApprovalLinkRow; submission: Submission; stage: WorkflowStage }
  | { ok: false; status: number; title: string; message: string; signInUrl?: string };

function signInUrl(formId: string, subId: string): string {
  return `/admin/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(subId)}`;
}

async function validateLink(env: Env, token: string): Promise<LinkCheck> {
  let link: ApprovalLinkRow | null;
  try {
    link = await findApprovalLink(env, token);
  } catch (err) {
    console.error("[forms.approval-link] lookup failed", err);
    return {
      ok: false,
      status: 503,
      title: "Something went wrong",
      message: "We couldn't check this link just now. Please try again in a minute."
    };
  }
  // Unknown and malformed tokens get the same answer: nothing to tell apart.
  if (!link) {
    return {
      ok: false,
      status: 404,
      title: "This link isn't valid",
      message: "It may have been copied incompletely. Open the link from the original email."
    };
  }
  const fallback = signInUrl(link.form_id, link.submission_id);
  if (link.used_at) {
    return {
      ok: false,
      status: 410,
      title: "Already decided",
      message: "A decision has already been recorded through this link. Sign in to see where the request stands.",
      signInUrl: fallback
    };
  }
  if (Date.parse(link.expires_at) <= Date.now()) {
    return {
      ok: false,
      status: 410,
      title: "This link has expired",
      message: "Approval links last 7 days. You can still act on the request by signing in.",
      signInUrl: fallback
    };
  }
  if (MAX_LINK_OPENS !== null && link.open_count >= MAX_LINK_OPENS) {
    return {
      ok: false,
      status: 410,
      title: "This link has been opened too many times",
      message: "Sign in to act on the request instead.",
      signInUrl: fallback
    };
  }

  let submission: Submission | null;
  try {
    submission = await getSubmission(env, link.form_id, link.submission_id);
  } catch (err) {
    console.error("[forms.approval-link] submission load failed", err);
    return {
      ok: false,
      status: 503,
      title: "Something went wrong",
      message: "We couldn't load the request just now. Please try again in a minute."
    };
  }
  if (!submission) {
    return {
      ok: false,
      status: 404,
      title: "Request not found",
      message: "The request this link points to no longer exists."
    };
  }

  const workflow = submission.version.schema.workflow;
  const stage = workflow?.stages.find((s) => s.id === link!.stage_id);
  if (!workflow || !stage || submission.workflow_stage !== link.stage_id) {
    const now = workflow?.stages.find((s) => s.id === submission!.workflow_stage);
    return {
      ok: false,
      status: 409,
      title: "This request has moved on",
      message: now
        ? `It is now at "${now.label}", so this link no longer applies.`
        : "It is no longer waiting at the step this link was sent for.",
      signInUrl: fallback
    };
  }

  // The stamped approver list is what the queue and applyTransition use. If
  // it is populated and the recipient is not on it, they were taken off the
  // stage after the email went out.
  const stamped = (submission.current_approver_emails ?? []).map((e) => e.toLowerCase());
  if (stamped.length > 0 && !stamped.includes(link.recipient_email.toLowerCase())) {
    return {
      ok: false,
      status: 403,
      title: "You're no longer the approver",
      message: "This request has been reassigned since the email was sent."
    };
  }

  return { ok: true, link, submission, stage };
}

// =============================================================================
// Attachments
// =============================================================================

/** One uploaded file on the submission, numbered in schema order. */
interface LinkFile {
  index: number;
  fieldKey: string;
  r2Key: string;
  name: string;
  mime: string;
}

/**
 * Every file the submitter uploaded, read from the submission's OWN payload.
 * The link route serves only these, addressed by position -- so a link can
 * never be turned into a way to fetch an arbitrary R2 key, and a file from
 * another submission cannot be reached through this one's link.
 *
 * Signatures are deliberately excluded: the approver needs the graphics he is
 * approving, not the submitter's signature image.
 */
function linkFiles(submission: Submission): LinkFile[] {
  const out: LinkFile[] = [];
  const prefix = `form-submission-files/${submission.form_id}/${submission.id}/`;
  for (const f of submission.version.schema.fields) {
    if (f.type !== "file") continue;
    const v = submission.payload[f.key];
    const entries = Array.isArray(v) ? v : v ? [v] : [];
    for (const e of entries) {
      const o = (e ?? {}) as Record<string, unknown>;
      const key = typeof o.r2_key === "string" ? o.r2_key : "";
      if (!key.startsWith(prefix)) continue;
      out.push({
        index: out.length,
        fieldKey: f.key,
        r2Key: key,
        name: typeof o.original_filename === "string" && o.original_filename
          ? o.original_filename
          : key.split("/").pop() ?? "file",
        mime: typeof o.mime === "string" ? o.mime : "application/octet-stream"
      });
    }
  }
  return out;
}

/**
 * GET /forms/approve/{token}/file/{n} -- one of the request's uploads, for
 * the approver. Same link checks as the page: an expired, used or moved-on
 * link stops serving files too.
 */
export async function handleApprovalLinkFile(
  env: Env,
  token: string,
  index: number
): Promise<Response> {
  const check = await validateLink(env, token);
  if (!check.ok) return new Response("Not found", { status: 404 });
  const file = linkFiles(check.submission)[index];
  if (!file) return new Response("Not found", { status: 404 });
  const obj = await env.FORMS_FILES.get(file.r2Key);
  if (!obj) return new Response("Not found", { status: 404 });
  // Images and PDFs open in the browser; anything else downloads.
  const inline = file.mime.startsWith("image/") || file.mime === "application/pdf";
  const safeName = file.name.replace(/["\\\r\n]/g, "_");
  return new Response(obj.body, {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Robots-Tag": "noindex"
    }
  });
}

// =============================================================================
// GET
// =============================================================================

export async function handleApprovalLinkPage(
  env: Env,
  _req: Request,
  token: string
): Promise<Response> {
  const check = await validateLink(env, token);
  if (!check.ok) return messagePage(check.status, check.title, check.message, check.signInUrl);
  await recordApprovalLinkOpen(env, check.link);
  return htmlResponse(200, renderDecisionPage(check, token, null));
}

// =============================================================================
// POST
// =============================================================================

export async function handleApprovalLinkSubmit(
  env: Env,
  req: Request,
  token: string,
  _ctx: ExecutionContext
): Promise<Response> {
  if (!isOriginAllowed(req)) {
    return messagePage(403, "Couldn't verify the page", "Reload the link from your email and try again.");
  }
  const check = await validateLink(env, token);
  if (!check.ok) return messagePage(check.status, check.title, check.message, check.signInUrl);
  const { link, submission, stage } = check;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return htmlResponse(400, renderDecisionPage(check, token, "Your answer couldn't be read. Please try again."));
  }
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const to = text("to");
  const transition = stage.transitions.find((t) => t.to === to);
  if (!transition) {
    return htmlResponse(400, renderDecisionPage(check, token, "Choose Approve or Deny."));
  }
  const note = text("note") || null;
  const typedName = text("typed_name") || null;
  const sigDataUrl = text("signature_png");

  // Check requirements BEFORE claiming the link, so a forgotten signature is
  // a "fix and resubmit", not a spent link.
  const requires = transition.requires ?? {};
  const missing: string[] = [];
  if (requires.signature && !sigDataUrl) missing.push("a signature");
  if (requires.note && !note) missing.push("a note");
  if (requires.typed_name && !typedName) missing.push("your typed name");
  if (missing.length > 0) {
    return htmlResponse(
      400,
      renderDecisionPage(check, token, `"${transition.label}" needs ${missing.join(" and ")}.`)
    );
  }

  let signatureR2Key: string | null = null;
  if (sigDataUrl) {
    const bytes = decodePngDataUrl(sigDataUrl);
    if (!bytes || bytes.byteLength > SIGNATURE_MAX_BYTES) {
      return htmlResponse(400, renderDecisionPage(check, token, "The signature couldn't be read. Clear it and sign again."));
    }
    // Same R2 namespace as the dashboard's transition signatures, so the PDF
    // and detail page find it the same way.
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    signatureR2Key = `transition-signatures/${submission.id}/${suffix}.png`;
    try {
      await env.FORMS_FILES.put(signatureR2Key, bytes, {
        httpMetadata: { contentType: "image/png" },
        customMetadata: {
          submissionId: submission.id,
          actor: link.recipient_email,
          via: "email_link",
          originalFilename: `${suffix}.png`
        }
      });
    } catch (err) {
      console.error("[forms.approval-link] signature R2 put failed", err);
      return htmlResponse(500, renderDecisionPage(check, token, "We couldn't save your signature. Please try again."));
    }
  }

  // Compare-and-set: a double-click or a second tab loses here.
  let claimed: boolean;
  try {
    claimed = await claimApprovalLink(env, link.id, to);
  } catch (err) {
    console.error("[forms.approval-link] claim failed", err);
    return htmlResponse(503, renderDecisionPage(check, token, "We couldn't record that just now. Please try again."));
  }
  if (!claimed) {
    return messagePage(410, "Already decided", "A decision was just recorded through this link.", signInUrl(link.form_id, link.submission_id));
  }

  const result = await applyTransition(env, {
    formId: link.form_id,
    subId: link.submission_id,
    submission,
    actor: {
      email: link.recipient_email,
      role: null,
      isAdminTier: false,
      via: "email_link",
      ip: req.headers.get("CF-Connecting-IP"),
      userAgent: (req.headers.get("User-Agent") ?? "").slice(0, 300) || null
    },
    toStageId: to,
    note,
    typedName,
    signatureR2Key,
    expectedStage: link.stage_id
  });

  if (!result.ok) {
    // The decision did not land, so the link must still work for a retry.
    await releaseApprovalLink(env, link.id);
    const body = (await result.json().catch(() => ({}))) as { error?: string };
    console.error("[forms.approval-link] transition failed", result.status, body.error);
    if (body.error === "stage_moved") {
      return messagePage(409, "This request has moved on", "Someone acted on it while this page was open.", signInUrl(link.form_id, link.submission_id));
    }
    if (body.error === "not_approver") {
      return messagePage(403, "You're no longer the approver", "This request has been reassigned since the email was sent.");
    }
    return htmlResponse(500, renderDecisionPage(check, token, "We couldn't record your decision. Please try again."));
  }

  // Say what HAPPENED ("Request denied"), not which button was pressed
  // ("Recorded: Deny"). The outcome's own label is the operator's word for it.
  const outcome = outcomeLabelAfter(submission.version.schema, to);
  return messagePage(
    200,
    outcome ? `Request ${outcome.toLowerCase()}` : "Decision recorded",
    "Thanks. The person who submitted the request will be emailed the result. You can close this page."
  );
}

/**
 * The outcome a transition ends at: follow its destination through any email
 * steps (which auto-advance) to the first stage nobody acts on. Null when the
 * path ends somewhere else -- e.g. another approval step -- so the caller
 * falls back to neutral wording rather than announcing a result that isn't
 * final yet.
 */
function outcomeLabelAfter(schema: FormSchema, stageId: string): string | null {
  const stages = schema.workflow?.stages ?? [];
  let id: string | undefined = stageId;
  for (let hop = 0; hop < 10 && id; hop++) {
    const stage = stages.find((s) => s.id === id);
    if (!stage) return null;
    if (stage.kind === "email") {
      id = stage.transitions[0]?.to;
      continue;
    }
    const terminal = !stage.approver_source && stage.transitions.length === 0;
    return terminal ? stage.label || stage.id : null;
  }
  return null;
}

// =============================================================================
// Rendering
// =============================================================================

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The URL is the credential; don't leak it to anything this page links
      // to. SAME-ORIGIN, NOT no-referrer: under no-referrer the browser sends
      // `Origin: null` on this page's own form POST, isOriginAllowed refuses
      // it, and every approve/deny fails with "Couldn't verify the page".
      // same-origin still sends nothing to other sites.
      "Referrer-Policy": "same-origin",
      "X-Robots-Tag": "noindex"
    }
  });
}

function shell(title: string, bodyHtml: string): string {
  // renderShell only reads title + description from the form.
  return renderShell({ form: { title, description: null } as FormMeta, bodyHtml });
}

function messagePage(status: number, title: string, message: string, signIn?: string): Response {
  const action = signIn
    ? `<p style="margin-top:20px"><a class="submit-btn" style="text-decoration:none;display:inline-block" href="${escapeHtml(signIn)}">Sign in to view the request</a></p>`
    : "";
  return htmlResponse(status, shell(title, `<p>${escapeHtml(message)}</p>${action}`));
}

function renderDecisionPage(
  check: Extract<LinkCheck, { ok: true }>,
  token: string,
  error: string | null
): string {
  const { submission, stage } = check;
  const schema: FormSchema = submission.version.schema;
  const submittedAt = new Date(submission.submitted_at).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  });

  const files = linkFiles(submission);
  const answers = schema.fields
    .filter((f) => f.type !== "heading" && f.type !== "image")
    .map((f) => answerRow(f, submission.payload[f.key], token, files))
    .filter(Boolean)
    .join("");

  const actions = stage.transitions.map((t, i) => actionOption(t, i)).join("");

  return shell(
    "Approval needed",
    `
<style>${PAGE_CSS}</style>
<p class="forms-description">
  <strong>${escapeHtml(stage.label)}</strong> &middot;
  submitted by ${escapeHtml(submission.submitter_email ?? "an anonymous submitter")} on ${escapeHtml(submittedAt)} ET
</p>
<dl class="ap-answers">${answers}</dl>
${error ? `<div class="ap-error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="POST" action="/forms/approve/${escapeHtml(token)}" class="ap-form" id="ap-form">
  <fieldset class="field">
    <legend class="field-label">Your decision</legend>
    ${actions}
  </fieldset>
  <div class="field ap-req" data-req="note" hidden>
    <label class="field-label" for="ap-note">Note</label>
    <textarea id="ap-note" name="note" class="field-textarea" rows="3" maxlength="5000"></textarea>
  </div>
  <div class="field ap-req" data-req="typed_name" hidden>
    <label class="field-label" for="ap-name">Type your full name</label>
    <input id="ap-name" name="typed_name" class="field-input" maxlength="200" autocomplete="name" />
  </div>
  <div class="field ap-req" data-req="signature" hidden>
    <span class="field-label">Signature</span>
    <canvas class="ap-sig" width="600" height="180"></canvas>
    <button type="button" class="ap-clear">Clear</button>
    <input type="hidden" name="signature_png" value="" />
  </div>
  <button type="submit" class="submit-btn" disabled>Choose a decision</button>
</form>
<script>${PAGE_JS}</script>`
  );
}

function actionOption(t: WorkflowTransition, i: number): string {
  const req = t.requires ?? {};
  const needs = [req.signature ? "signature" : "", req.note ? "note" : "", req.typed_name ? "typed_name" : ""]
    .filter(Boolean)
    .join(" ");
  const hint = [
    req.signature ? "signature" : "",
    req.note ? "note" : "",
    req.typed_name ? "typed name" : ""
  ].filter(Boolean);
  return `<label class="field-radio-option">
    <input type="radio" name="to" value="${escapeHtml(t.to)}" data-needs="${escapeHtml(needs)}" data-label="${escapeHtml(t.label)}" id="ap-to-${i}" />
    <span>${escapeHtml(t.label)}${hint.length ? ` <span class="ap-hint">(requires ${escapeHtml(hint.join(" and "))})</span>` : ""}</span>
  </label>`;
}

function answerRow(
  field: Field,
  value: unknown,
  token: string,
  files: LinkFile[]
): string {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return "";
  let html: string;
  if (isPackagePriceSites(value)) {
    html = value
      .map((s) => `<p class="ap-site">${escapeHtml(siteLabel(s))}</p>${siteChanges(s)}`)
      .join("");
  } else if (isPackagePriceRows(value)) {
    html = priceTable(value);
  } else if (field.type === "file") {
    // Served through the link (handleApprovalLinkFile), so the approver sees
    // the graphics he is approving without signing in.
    const mine = files.filter((f) => f.fieldKey === field.key);
    html = mine.length ? fileGallery(token, mine) : "";
    if (!html) return "";
  } else if (field.type === "signature") {
    html = `<em>Signed &mdash; sign in to view</em>`;
  } else {
    html = escapeHtml(resolveDisplayValue(field, value)).replace(/\n/g, "<br>");
  }
  return `<div class="ap-row"><dt>${escapeHtml(field.label)}</dt><dd>${html}</dd></div>`;
}

// Same difference text as the PDF (priceDiff), so what the approver sees on
// screen is exactly what the signed PDF says.
function priceCell(cur: string, next: string): string {
  if (cur === next) return `<span class="ap-muted">$${escapeHtml(cur)} (no change)</span>`;
  const d = priceDiff(cur, next);
  return (
    `<span class="ap-muted">$${escapeHtml(cur)}</span> &rarr; <strong>$${escapeHtml(next)}</strong>` +
    `<br><span class="ap-diff ap-diff-${d.direction}">${escapeHtml(d.text)}</span>`
  );
}

function packageCell(r: PackagePriceRow): string {
  const name = escapeHtml(packageLabel(r.pkg));
  if (r.discontinue) return `<strong class="ap-struck">${name}</strong>`;
  if (r.rename_to) {
    return `<strong>${name}</strong> &rarr; <strong>${escapeHtml(r.rename_to)}</strong><br><span class="ap-tag">renamed</span>`;
  }
  return `<strong>${name}</strong>`;
}

function priceTable(rows: PackagePriceRow[]): string {
  if (rows.length === 0) return "";
  return `<table class="ap-prices">
    <thead><tr><th>Package</th><th>Single</th><th>Monthly</th></tr></thead>
    <tbody>${rows
      .map((r) =>
        r.discontinue
          ? `<tr><td>${packageCell(r)}</td><td colspan="2"><span class="ap-discontinued">Discontinued</span></td></tr>`
          : `<tr><td>${packageCell(r)}</td><td>${priceCell(r.current_single, r.new_single)}</td><td>${priceCell(r.current_monthly, r.new_monthly)}</td></tr>`
      )
      .join("")}</tbody>
  </table>`;
}

/** Every change at one site: existing packages, new packages, services. */
function siteChanges(s: PackagePriceSite): string {
  const newPkgs = (s.new_packages ?? [])
    .map(
      (p) =>
        `<tr><td><strong>${escapeHtml(p.name)}</strong><br><span class="ap-tag ap-tag-new">new</span></td><td><strong>$${escapeHtml(p.single)}</strong></td><td><strong>$${escapeHtml(p.monthly)}</strong></td></tr>`
    )
    .join("");
  const services = s.services ?? [];
  const pkgTable =
    s.rows.length || newPkgs
      ? `<table class="ap-prices">
    <thead><tr><th>Package</th><th>Single</th><th>Monthly</th></tr></thead>
    <tbody>${s.rows
      .map((r) =>
        r.discontinue
          ? `<tr><td>${packageCell(r)}</td><td colspan="2"><span class="ap-discontinued">Discontinued</span></td></tr>`
          : `<tr><td>${packageCell(r)}</td><td>${priceCell(r.current_single, r.new_single)}</td><td>${priceCell(r.current_monthly, r.new_monthly)}</td></tr>`
      )
      .join("")}${newPkgs}</tbody>
  </table>`
      : "";
  const serviceTable = services.length
    ? `<table class="ap-prices ap-services">
    <thead><tr><th>Lube &amp; detail</th><th colspan="2">Price</th></tr></thead>
    <tbody>${services
      .map(
        (v) =>
          `<tr><td><strong>${escapeHtml(v.name)}</strong><br><span class="ap-tag">${escapeHtml(serviceCategoryLabel(v.category))}</span></td><td colspan="2">${priceCell(v.current, v.new)}</td></tr>`
      )
      .join("")}</tbody>
  </table>`
    : "";
  return pkgTable + serviceTable;
}

function fileGallery(token: string, files: LinkFile[]): string {
  return `<div class="ap-files">${files
    .map((f) => {
      const href = `/forms/approve/${escapeHtml(token)}/file/${f.index}`;
      const name = escapeHtml(f.name);
      return f.mime.startsWith("image/")
        ? `<a class="ap-thumb" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${name}" loading="lazy"><span>${name}</span></a>`
        : `<a class="ap-filelink" href="${href}" target="_blank" rel="noopener">${name}</a>`;
    })
    .join("")}</div>`;
}

function decodePngDataUrl(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m || !m[1]) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    // PNG magic number -- reject anything that only claims to be one.
    if (out[0] !== 0x89 || out[1] !== 0x50 || out[2] !== 0x4e || out[3] !== 0x47) return null;
    return out;
  } catch {
    return null;
  }
}

const PAGE_CSS = `
  .ap-answers { margin: 0 0 24px; border-top: 1px solid #e5e9ef; }
  .ap-row { display: grid; grid-template-columns: 180px 1fr; gap: 12px; padding: 10px 0; border-bottom: 1px solid #e5e9ef; }
  .ap-row dt { font-weight: 600; color: var(--splash-navy); font-size: 14px; }
  .ap-row dd { margin: 0; }
  @media (max-width: 560px) { .ap-row { grid-template-columns: 1fr; gap: 2px; } }
  .ap-prices { border-collapse: collapse; font-size: 14px; width: 100%; }
  .ap-prices th { text-align: left; font-size: 12px; text-transform: uppercase; color: #666; padding: 0 12px 4px 0; }
  .ap-prices td { padding: 6px 12px 6px 0; border-top: 1px solid #eef1f5; vertical-align: top; }
  .ap-muted { color: #666; }
  .ap-diff { font-size: 12px; font-weight: 700; }
  .ap-struck { text-decoration: line-through; color: #8a1c1c; }
  .ap-discontinued { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #fee2e2; color: #b91c1c; font-weight: 700; font-size: 13px; }
  .ap-tag { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: #666; }
  .ap-tag-new { color: #047857; }
  .ap-services { margin-top: 10px; }
  .ap-files { display: flex; flex-wrap: wrap; gap: 10px; }
  .ap-thumb { display: flex; flex-direction: column; width: 150px; text-decoration: none; color: var(--splash-navy); font-size: 12px; }
  .ap-thumb img { width: 150px; height: 110px; object-fit: contain; background: #f4f6f9; border: 1px solid #dfe5ee; border-radius: 4px; }
  .ap-thumb span { overflow-wrap: anywhere; margin-top: 3px; }
  .ap-filelink { display: inline-block; padding: 8px 12px; border: 1px solid #dfe5ee; border-radius: 4px; color: var(--splash-blue); font-size: 14px; }
  .ap-diff-up { color: #047857; }
  .ap-diff-down { color: #b91c1c; }
  .ap-site { margin: 14px 0 4px; font-weight: 700; color: var(--splash-navy); }
  .ap-site:first-child { margin-top: 0; }
  .ap-hint { color: #666; font-size: 13px; }
  .ap-error { background: #fdecea; border: 1px solid #f5c6cb; color: #8a1c1c; border-radius: 6px; padding: 12px 14px; margin-bottom: 20px; }
  .ap-sig { display: block; width: 100%; max-width: 600px; height: 180px; border: 1px solid #ccc; border-radius: 4px; background: #fff; touch-action: none; }
  .ap-clear { margin-top: 6px; background: none; border: 1px solid #ccc; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
  .submit-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
`;

// Runs on DOMContentLoaded, after the shell's deferred signature-pad script.
const PAGE_JS = `
document.addEventListener("DOMContentLoaded", function () {
  var form = document.getElementById("ap-form");
  if (!form) return;
  var btn = form.querySelector(".submit-btn");
  var canvas = form.querySelector(".ap-sig");
  var sigInput = form.querySelector('input[name="signature_png"]');
  var pad = null;

  function sizeCanvas() {
    if (!canvas) return;
    var ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext("2d").scale(ratio, ratio);
    if (pad) pad.clear();
  }

  function needs() {
    var picked = form.querySelector('input[name="to"]:checked');
    return { picked: picked, list: picked ? (picked.getAttribute("data-needs") || "").split(" ") : [] };
  }

  function apply() {
    var n = needs();
    var reqs = form.querySelectorAll(".ap-req");
    Array.prototype.forEach.call(reqs, function (el) {
      var on = n.list.indexOf(el.getAttribute("data-req")) !== -1;
      el.hidden = !on;
      var input = el.querySelector("textarea, input:not([type=hidden])");
      if (input) input.required = on;
      if (on && el.getAttribute("data-req") === "signature" && !pad && window.SignaturePad) {
        sizeCanvas();
        pad = new window.SignaturePad(canvas);
      }
    });
    btn.disabled = !n.picked;
    btn.textContent = n.picked ? n.picked.getAttribute("data-label") : "Choose a decision";
  }

  form.addEventListener("change", apply);
  var clear = form.querySelector(".ap-clear");
  if (clear) clear.addEventListener("click", function () { if (pad) pad.clear(); });

  form.addEventListener("submit", function (e) {
    var n = needs();
    sigInput.value = "";
    if (n.list.indexOf("signature") !== -1) {
      if (!pad || pad.isEmpty()) {
        e.preventDefault();
        alert("Please sign before submitting.");
        return;
      }
      sigInput.value = pad.toDataURL("image/png");
    }
    btn.disabled = true;
    btn.textContent = "Saving…";
  });
  apply();
});
`;
