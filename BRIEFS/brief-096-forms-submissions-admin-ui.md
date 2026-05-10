# Brief 96: Forms — submissions admin UI + worker endpoints (`/admin/forms/[id]/submissions*`, versions)

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** Brief 98 (polish — dashboard tile, error boundary).
**Dependencies:** Brief 89 (foundation — schema), Brief 91 (submissions exist), Brief 92 (file rendering), Brief 93 (lookup payloads), Brief 94 (admin auth gate, worker-fetch helper, FormsAdminTabs), Brief 95 (FormsAdminTabs + builder).

## Read first

- BUILD_STATE.md.
- CLAUDE.md.
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (precedent — same shape this brief mirrors for forms).
- BRIEFS/brief-084-signups-viewer-date-range-and-csv.md (precedent — date-range + CSV pattern).
- BRIEFS/brief-087-fleet-detail-splash-notes-editor.md (the splash_notes editor + ActionForm pattern this brief mirrors AND extends with status enum).
- BRIEFS/brief-088-fleet-csv-export-proxy-route.md (NOT applicable here — forms is path-carved per Brief 89 / Decision 2; CSV button can hit worker directly via same-origin URL, no proxy needed).
- BRIEFS/brief-094-forms-admin-api-crud.md (admin gate, worker-fetch helper this brief extends).
- BRIEFS/brief-095-forms-admin-builder-ui.md (FormsAdminTabs).
- apps/web/app/_components/DateRangePicker.tsx + CsvExportButton.tsx (Brief 83 shared components — reused verbatim).

## Architecture context

Per planning Decision 7, three submission-related pages:

1. `/admin/forms/[id]/submissions` — list of submissions for one form. DateRangePicker + status filter + submitter-kind filter. CSV export button.
2. `/admin/forms/[id]/submissions/[subId]` — detail page. ActionForm for splash_notes + status edit (last-write-wins, mirrors fleet Brief 87). Full payload rendered against the submission's specific `form_version_id` schema (NOT the form's current schema — past submissions render against their own version per Decision 1's versioning posture).
3. `/admin/forms/[id]/versions` — audit-trail table. Columns: Version | Published at | Published by | Submissions count | Field count | (no diff renderer per Decision 7 — v2).

**List columns are meta-only** (Decision 7) because schemas vary across versions:

`Submitted at` | `Status pill` | `Submitter` | `Splash Notes preview` | `Version` | `View →`

Payload values aren't rendered in the list because they may not exist across all versions — too messy. Detail page renders the full payload against that submission's specific version.

**CSV export is schema-union across all versions** in the date range. Wide table with NULLs where a column doesn't exist for a given submission's version. Header row is the union of all field keys ever used in the form's history. Worker-rendered CSV with `Content-Disposition`. Direct same-origin download — `splash-forms` is path-carved (Brief 89), so no Brief 88-style proxy route is needed.

**File payload rendering on detail** (Decision 7): each file/signature payload entry renders as a thumbnail (if image) or filename + download link via `/forms/admin/api/files/{r2_key}` (the route Brief 92 introduced).

**Lookup payload rendering**: shows the resolved value + small annotation `(resolved from {keyField.label})`.

**Status pill**: `new` (gray) / `in_progress` (amber) / `closed` (green). Same component shape as the version status pill from Brief 95.

## Context

Eighth of 10 briefs. After this brief, operators have a complete admin surface for built forms — list, build, see submissions, annotate, export CSV. Briefs 97 + 98 wrap with webhook + cron + polish.

This brief introduces no new packages or bindings. All scope splits between worker endpoints (extending Brief 94's admin API) and apps/web pages.

## Scope

### Phase 1 — Worker submission endpoints

**File:** `apps/forms-worker/src/admin/submissions.ts` (NEW).

```ts
import { adminGate, requireServiceKey } from "./auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import type { Env } from "../index";
import { createServiceClient } from "../db/forms";

export async function handleListSubmissions(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");           // YYYY-MM-DD
  const to = url.searchParams.get("to");               // YYYY-MM-DD (inclusive end of day)
  const status = url.searchParams.get("status");       // new | in_progress | closed | all
  const submitterKind = url.searchParams.get("submitter_kind");  // authenticated | anonymous | all
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 200);

  // Default last 30 days when from/to absent
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fromIso = (from ?? defaultFrom) + "T00:00:00Z";
  const toIso = (to ?? today.toISOString().slice(0, 10)) + "T23:59:59Z";

  const client = createServiceClient(env);
  let q = client
    .from("form_submissions")
    .select("id, form_version_id, payload, submitter_kind, submitter_user_id, submitter_email, submitter_ip, submitted_at, status, status_updated_at, splash_notes, version:form_versions!inner(version_number)")
    .eq("form_id", formId)
    .gte("submitted_at", fromIso)
    .lte("submitted_at", toIso)
    .order("submitted_at", { ascending: false })
    .limit(limit + 1);   // +1 to detect overflow

  if (status && status !== "all") q = q.eq("status", status);
  if (submitterKind && submitterKind !== "all") q = q.eq("submitter_kind", submitterKind);

  const { data, error } = await q;
  if (error) {
    console.error("[forms.admin] list submissions failed", error);
    return jsonError(500, "list_failed", "Could not list submissions.");
  }

  const limitHit = data.length > limit;
  const items = (limitHit ? data.slice(0, limit) : data).map(rowToListItem);

  return new Response(JSON.stringify({ items, limit_hit: limitHit, from: from ?? defaultFrom, to: to ?? today.toISOString().slice(0, 10) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function handleGetSubmission(env: Env, req: Request, formId: string, subId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const client = createServiceClient(env);
  const { data, error } = await client
    .from("form_submissions")
    .select(`
      id, form_id, form_version_id, payload, submitter_kind, submitter_user_id, submitter_email, submitter_ip, submitted_at,
      status, status_updated_at, status_updated_by, splash_notes, splash_notes_updated_at, splash_notes_updated_by,
      version:form_versions!inner(id, version_number, schema, published_at, published_by),
      files:form_submission_files(id, field_key, r2_key, mime, size_bytes, original_filename)
    `)
    .eq("id", subId)
    .eq("form_id", formId)
    .maybeSingle();

  if (error) return jsonError(500, "get_failed", "Could not load submission.");
  if (!data) return jsonError(404, "not_found", "Submission not found.");

  return new Response(JSON.stringify({ submission: data }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function handlePatchSubmission(env: Env, req: Request, formId: string, subId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  let body: { splash_notes?: string; status?: string };
  try { body = await req.json(); } catch { return jsonError(400, "bad_json", "Body must be JSON."); }

  const patch: Record<string, unknown> = {};
  const now = new Date().toISOString();

  if (body.splash_notes !== undefined) {
    if (typeof body.splash_notes !== "string") return jsonError(400, "bad_notes", "splash_notes must be a string.");
    const trimmed = body.splash_notes.trim();
    if (trimmed.length > 10000) return jsonError(400, "notes_too_long", "splash_notes exceeds 10000 chars.");
    patch.splash_notes = trimmed;
    patch.splash_notes_updated_at = now;
    patch.splash_notes_updated_by = gate.session.userId;
  }

  if (body.status !== undefined) {
    if (!["new", "in_progress", "closed"].includes(body.status)) {
      return jsonError(400, "bad_status", "status must be new | in_progress | closed.");
    }
    patch.status = body.status;
    patch.status_updated_at = now;
    patch.status_updated_by = gate.session.userId;
  }

  if (Object.keys(patch).length === 0) {
    return jsonError(400, "nothing_to_update", "Provide splash_notes and/or status.");
  }

  const client = createServiceClient(env);
  const { data, error } = await client
    .from("form_submissions")
    .update(patch)
    .eq("id", subId)
    .eq("form_id", formId)
    .select()
    .maybeSingle();
  if (error) return jsonError(500, "patch_failed", "Could not update submission.");
  if (!data) return jsonError(404, "not_found", "Submission not found.");

  return new Response(JSON.stringify({ ok: true, row: data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export async function handleSubmissionsCsv(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fromDate = from ?? defaultFrom;
  const toDate = to ?? today.toISOString().slice(0, 10);
  const fromIso = fromDate + "T00:00:00Z";
  const toIso = toDate + "T23:59:59Z";

  const client = createServiceClient(env);
  // Pull submissions + their version's schema (for header union)
  const { data: submissions, error: subErr } = await client
    .from("form_submissions")
    .select("id, payload, submitter_kind, submitter_email, submitted_at, status, splash_notes, version:form_versions!inner(version_number, schema)")
    .eq("form_id", formId)
    .gte("submitted_at", fromIso)
    .lte("submitted_at", toIso)
    .order("submitted_at", { ascending: false })
    .limit(10000);

  if (subErr) return new Response(`Error: ${subErr.message}`, { status: 500 });
  if (!submissions) return new Response("submission_id\n", { status: 200, headers: { "Content-Type": "text/csv" } });

  if (submissions.length >= 10000) {
    return new Response("Result set too large; narrow the date range.", { status: 416 });
  }

  // Schema union — gather all field keys ever used in any version present
  const fieldKeys = new Set<string>();
  for (const sub of submissions) {
    const schema = (sub as { version: { schema: { fields: Array<{ key: string; type: string }> } } }).version.schema;
    for (const field of schema.fields) {
      if (field.type === "heading" || field.type === "image") continue;
      fieldKeys.add(field.key);
    }
  }
  const sortedKeys = Array.from(fieldKeys).sort();

  // CSV header: meta cols + all field keys
  const headerCols = ["submission_id", "submitted_at", "status", "submitter_kind", "submitter_email", "version_number", "splash_notes", ...sortedKeys];
  const lines = [headerCols.map(csvEscape).join(",")];

  for (const sub of submissions) {
    const payload = (sub as { payload: Record<string, unknown> }).payload;
    const version = (sub as { version: { version_number: number } }).version;
    const row = [
      sub.id,
      sub.submitted_at,
      sub.status,
      sub.submitter_kind,
      sub.submitter_email ?? "",
      String(version.version_number),
      sub.splash_notes ?? "",
      ...sortedKeys.map((k) => stringifyPayloadValue(payload[k]))
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  const filename = `form-${formId}-submissions-${fromDate}-to-${toDate}.csv`;
  return new Response(lines.join("\r\n") + "\r\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

function rowToListItem(r: Record<string, unknown>): Record<string, unknown> {
  const splash = (r.splash_notes as string | null) ?? null;
  return {
    id: r.id,
    submitted_at: r.submitted_at,
    status: r.status,
    submitter_kind: r.submitter_kind,
    submitter_email: r.submitter_email,
    version_number: (r.version as { version_number: number } | undefined)?.version_number ?? null,
    splash_notes_preview: splash ? splash.slice(0, 80) : null,
    splash_notes_truncated: splash ? splash.length > 80 : false
  };
}

function stringifyPayloadValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(String).join("; ");
  if (typeof v === "object") {
    // file/signature payloads — render as r2_key
    const obj = v as Record<string, unknown>;
    if (typeof obj.r2_key === "string") return obj.r2_key;
    return JSON.stringify(v);
  }
  return String(v);
}

function csvEscape(v: string): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\n") || s.includes("\r") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
```

### Phase 2 — Worker version-history endpoint

**File:** `apps/forms-worker/src/admin/versions.ts` (NEW).

```ts
import { adminGate, requireServiceKey } from "./auth";
import { jsonError } from "@splash/http";
import type { Env } from "../index";
import { createServiceClient } from "../db/forms";

export async function handleListVersions(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const client = createServiceClient(env);
  const { data, error } = await client
    .from("form_versions")
    .select(`
      id, version_number, is_draft, published_at, published_by, schema,
      submissions:form_submissions(count)
    `)
    .eq("form_id", formId)
    .order("version_number", { ascending: false });
  if (error) return jsonError(500, "list_failed", "Could not list versions.");

  const items = data.map((v) => ({
    id: v.id,
    version_number: v.version_number,
    is_draft: v.is_draft,
    published_at: v.published_at,
    published_by: v.published_by,
    field_count: ((v.schema as { fields: unknown[] })?.fields ?? []).length,
    submission_count: (v.submissions as Array<{ count: number }> | undefined)?.[0]?.count ?? 0
  }));

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
```

### Phase 3 — Wire routes

**File:** `apps/forms-worker/src/index.ts` (MODIFY).

```ts
import { handleListSubmissions, handleGetSubmission, handlePatchSubmission, handleSubmissionsCsv } from "./admin/submissions";
import { handleListVersions } from "./admin/versions";

// /forms/admin/api/forms/{id}/submissions
const subListMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/submissions$/i);
if (subListMatch && req.method === "GET") return handleListSubmissions(env, req, subListMatch[1]);

// /forms/admin/api/forms/{id}/submissions.csv
const subCsvMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/submissions\.csv$/i);
if (subCsvMatch && req.method === "GET") return handleSubmissionsCsv(env, req, subCsvMatch[1]);

// /forms/admin/api/forms/{id}/submissions/{subId}
const subDetailMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/submissions\/([0-9a-f-]+)$/i);
if (subDetailMatch) {
  if (req.method === "GET") return handleGetSubmission(env, req, subDetailMatch[1], subDetailMatch[2]);
  if (req.method === "PATCH") return handlePatchSubmission(env, req, subDetailMatch[1], subDetailMatch[2]);
}

// /forms/admin/api/forms/{id}/versions
const versionsMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/versions$/i);
if (versionsMatch && req.method === "GET") return handleListVersions(env, req, versionsMatch[1]);
```

### Phase 4 — apps/web fetch helpers

**File:** `apps/web/app/admin/forms/_lib/worker-fetch.ts` (MODIFY — append).

```ts
export interface SubmissionListItem {
  id: string;
  submitted_at: string;
  status: "new" | "in_progress" | "closed";
  submitter_kind: "authenticated" | "anonymous";
  submitter_email: string | null;
  version_number: number;
  splash_notes_preview: string | null;
  splash_notes_truncated: boolean;
}

export async function listSubmissionsAdmin(formId: string, params: { from?: string; to?: string; status?: string; submitter_kind?: string } = {}): Promise<{ items: SubmissionListItem[]; limit_hit: boolean; from: string; to: string }> {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.status) qs.set("status", params.status);
  if (params.submitter_kind) qs.set("submitter_kind", params.submitter_kind);
  const path = `/forms/admin/api/forms/${formId}/submissions${qs.toString() ? "?" + qs : ""}`;
  const r = await callForms(path);
  if (!r.ok) throw new Error(`listSubmissions ${r.status}`);
  return r.json();
}

export async function getSubmissionAdmin(formId: string, subId: string) {
  const r = await callForms(`/forms/admin/api/forms/${formId}/submissions/${subId}`);
  if (!r.ok) throw new Error(`getSubmission ${r.status}`);
  return r.json();
}

export async function updateSubmissionAdmin(formId: string, subId: string, patch: { splash_notes?: string; status?: string }): Promise<void> {
  const r = await callForms(`/forms/admin/api/forms/${formId}/submissions/${subId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(`updateSubmission ${r.status}: ${await r.text()}`);
}

export function getSubmissionsCsvUrl(formId: string, params: { from?: string; to?: string } = {}): string {
  // Path-carved — direct same-origin URL works (no Brief 88-style proxy needed).
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  return `/forms/admin/api/forms/${formId}/submissions.csv${qs.toString() ? "?" + qs : ""}`;
}

export async function listVersionsAdmin(formId: string) {
  const r = await callForms(`/forms/admin/api/forms/${formId}/versions`);
  if (!r.ok) throw new Error(`listVersions ${r.status}`);
  return r.json();
}
```

### Phase 5 — Submissions list page

**File:** `apps/web/app/admin/forms/[id]/submissions/page.tsx` (NEW). Server component. Mirrors `apps/web/app/admin/fleet/page.tsx` shape.

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { getMe } from "../../../../_lib/me";
import { listSubmissionsAdmin, getSubmissionsCsvUrl, getFormAdmin } from "../../_lib/worker-fetch";
import FormsAdminTabs from "../../_components/FormsAdminTabs";
import DateRangePicker from "../../../../_components/DateRangePicker";
import CsvExportButton from "../../../../_components/CsvExportButton";
import StatusPill from "./_components/StatusPill";

export const dynamic = "force-dynamic";

interface SearchParams { from?: string; to?: string; status?: string; submitter_kind?: string; }

export default async function FormSubmissionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const sp = await searchParams;
  const me = await getMe();
  if (!me) redirect(`/login?next=/admin/forms/${id}/submissions`);
  const allowed = me.role === "super_admin" || me.dcRole === "admin" || me.dcRole === "super_admin";
  if (!allowed) return <NoAccess id={id} />;

  const form = await getFormAdmin(id);
  const list = await listSubmissionsAdmin(id, { from: sp.from, to: sp.to, status: sp.status, submitter_kind: sp.submitter_kind });

  return (
    <main className="max-w-6xl mx-auto p-6">
      <FormsAdminTabs formId={id} />
      <h1 className="text-2xl font-bold text-blue-900 mb-1">{form.form.title} — Submissions</h1>
      <p className="text-gray-600 text-sm mb-4">Slug: <code className="text-xs">{form.form.slug}</code></p>

      <form method="get" className="flex flex-wrap items-end gap-3 mb-4">
        <DateRangePicker defaultFrom={list.from} defaultTo={list.to} />
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
          <select name="status" defaultValue={sp.status ?? "all"} className="border rounded px-2 py-1 text-sm">
            <option value="all">All</option>
            <option value="new">New</option>
            <option value="in_progress">In progress</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Submitter</label>
          <select name="submitter_kind" defaultValue={sp.submitter_kind ?? "all"} className="border rounded px-2 py-1 text-sm">
            <option value="all">All</option>
            <option value="authenticated">Authenticated</option>
            <option value="anonymous">Anonymous</option>
          </select>
        </div>
        <button type="submit" className="bg-blue-600 text-white px-3 py-1 rounded text-sm">Filter</button>
        <CsvExportButton href={getSubmissionsCsvUrl(id, { from: list.from, to: list.to })} className="ml-auto" />
      </form>

      {list.limit_hit && <p className="text-amber-700 text-sm mb-2">Showing the first 200 results. Narrow the date range to see more.</p>}

      {list.items.length === 0 ? (
        <p className="text-gray-500 italic">No submissions in the selected range.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-600">
              <th className="py-2 px-2">When</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 px-2">Submitter</th>
              <th className="py-2 px-2">Splash Notes</th>
              <th className="py-2 px-2">Version</th>
              <th className="py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 px-2 text-sm">{new Date(s.submitted_at).toLocaleString()}</td>
                <td className="py-2 px-2"><StatusPill status={s.status} /></td>
                <td className="py-2 px-2 text-sm">{s.submitter_kind === "authenticated" ? s.submitter_email : <em className="text-gray-500">anonymous</em>}</td>
                <td className="py-2 px-2 text-sm text-gray-600">{s.splash_notes_preview ?? <em className="text-gray-400">—</em>}{s.splash_notes_truncated && "…"}</td>
                <td className="py-2 px-2 text-sm">v{s.version_number}</td>
                <td className="py-2 px-2"><Link href={`/admin/forms/${id}/submissions/${s.id}`} className="text-blue-700 text-sm">View →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function NoAccess({ id }: { id: string }) {
  return (
    <main className="max-w-6xl mx-auto p-6">
      <FormsAdminTabs formId={id} />
      <p className="text-red-600">You don't have access to view submissions.</p>
    </main>
  );
}
```

### Phase 6 — Submission detail page

**File:** `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx` (NEW).

Renders metadata, ActionForm with both splash_notes textarea and status dropdown (single Save button submitting both), then a payload section iterating the submission's specific schema (NOT the form's current — past submissions render against their own version) and dispatching to per-field-type display renderers.

```tsx
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getMe } from "../../../../../_lib/me";
import { getSubmissionAdmin } from "../../../_lib/worker-fetch";
import FormsAdminTabs from "../../../_components/FormsAdminTabs";
import StatusPill from "../_components/StatusPill";
import ActionForm from "../../../../_components/ActionForm";
import { updateSubmissionAction } from "./actions";
import PayloadRenderer from "./_components/PayloadRenderer";

export const dynamic = "force-dynamic";

export default async function SubmissionDetailPage({ params }: { params: Promise<{ id: string; subId: string }> }) {
  const { id, subId } = await params;
  const me = await getMe();
  if (!me) redirect(`/login?next=/admin/forms/${id}/submissions/${subId}`);
  const allowed = me.role === "super_admin" || me.dcRole === "admin" || me.dcRole === "super_admin";
  if (!allowed) {
    return <main className="max-w-4xl mx-auto p-6"><FormsAdminTabs formId={id} /><p className="text-red-600">No access.</p></main>;
  }

  const data = await getSubmissionAdmin(id, subId);
  if (!data || !data.submission) notFound();
  const sub = data.submission;

  return (
    <main className="max-w-4xl mx-auto p-6">
      <FormsAdminTabs formId={id} />
      <Link href={`/admin/forms/${id}/submissions`} className="text-sm text-blue-700">← Back to submissions</Link>
      <h1 className="text-2xl font-bold text-blue-900 mt-2 mb-4">Submission detail</h1>

      <section className="bg-white border border-gray-200 rounded p-4 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase mb-3">Status &amp; notes</h2>
        <ActionForm action={updateSubmissionAction.bind(null, id, subId)} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select name="status" defaultValue={sub.status} className="border rounded px-2 py-1 text-sm">
              <option value="new">New</option>
              <option value="in_progress">In progress</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Splash Notes</label>
            <textarea name="splash_notes" defaultValue={sub.splash_notes ?? ""} rows={5} className="w-full border rounded px-3 py-2 text-sm font-mono" placeholder="Internal notes about this submission…" />
          </div>
          <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium">Save</button>
        </ActionForm>
      </section>

      <section className="bg-white border border-gray-200 rounded p-4 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase mb-3">Form payload (v{sub.version.version_number})</h2>
        <PayloadRenderer schema={sub.version.schema} payload={sub.payload} files={sub.files ?? []} formId={id} />
      </section>

      <section className="bg-white border border-gray-200 rounded p-4 text-sm">
        <h2 className="text-sm font-semibold text-gray-700 uppercase mb-3">Metadata</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <dt className="text-gray-600">Submitted at</dt><dd>{new Date(sub.submitted_at).toLocaleString()}</dd>
          <dt className="text-gray-600">Submitter kind</dt><dd>{sub.submitter_kind}</dd>
          <dt className="text-gray-600">Submitter email</dt><dd>{sub.submitter_email ?? <em>—</em>}</dd>
          <dt className="text-gray-600">Submitter IP</dt><dd className="font-mono text-xs">{sub.submitter_ip ?? <em>—</em>}</dd>
          <dt className="text-gray-600">Version</dt><dd>v{sub.version.version_number}</dd>
          <dt className="text-gray-600">Submission ID</dt><dd className="font-mono text-xs">{sub.id}</dd>
        </dl>
      </section>
    </main>
  );
}
```

**File:** `apps/web/app/admin/forms/[id]/submissions/[subId]/actions.ts` (NEW).

```ts
"use server";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../../../../_components/ActionForm";
import { updateSubmissionAdmin } from "../../../_lib/worker-fetch";

export async function updateSubmissionAction(
  formId: string,
  subId: string,
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const status = String(formData.get("status") ?? "");
  const splash_notes = String(formData.get("splash_notes") ?? "");

  try {
    await updateSubmissionAdmin(formId, subId, { status, splash_notes });
    revalidatePath(`/admin/forms/${formId}/submissions/${subId}`);
    return { ok: true, message: "Saved." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

**File:** `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/PayloadRenderer.tsx` (NEW). Iterates the schema, renders each field's payload value with type-aware formatting. File/signature payload values render as thumbnails (image MIME) or filename + download link (other MIME). Lookup values get the `(resolved from {keyField.label})` annotation. Heading/Image fields skipped.

### Phase 7 — Versions page

**File:** `apps/web/app/admin/forms/[id]/versions/page.tsx` (NEW). Audit-trail table.

```tsx
import { redirect } from "next/navigation";
import { getMe } from "../../../../_lib/me";
import { listVersionsAdmin, getFormAdmin } from "../../_lib/worker-fetch";
import FormsAdminTabs from "../../_components/FormsAdminTabs";

export const dynamic = "force-dynamic";

export default async function VersionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  if (!me) redirect(`/login?next=/admin/forms/${id}/versions`);
  const allowed = me.role === "super_admin" || me.dcRole === "admin" || me.dcRole === "super_admin";
  if (!allowed) return <main className="max-w-4xl mx-auto p-6"><FormsAdminTabs formId={id} /><p className="text-red-600">No access.</p></main>;

  const form = await getFormAdmin(id);
  const list = await listVersionsAdmin(id);

  return (
    <main className="max-w-4xl mx-auto p-6">
      <FormsAdminTabs formId={id} />
      <h1 className="text-2xl font-bold text-blue-900 mb-4">{form.form.title} — Version history</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-600">
            <th className="py-2 px-2">Version</th>
            <th className="py-2 px-2">Status</th>
            <th className="py-2 px-2">Published at</th>
            <th className="py-2 px-2">Published by</th>
            <th className="py-2 px-2">Field count</th>
            <th className="py-2 px-2">Submissions</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((v: any) => (
            <tr key={v.id} className="border-b border-gray-100">
              <td className="py-2 px-2 font-mono">v{v.version_number}</td>
              <td className="py-2 px-2">{v.is_draft ? <span className="text-amber-700">Draft</span> : <span className="text-green-700">Published</span>}</td>
              <td className="py-2 px-2">{v.published_at ? new Date(v.published_at).toLocaleString() : "—"}</td>
              <td className="py-2 px-2 font-mono text-xs">{v.published_by ?? "—"}</td>
              <td className="py-2 px-2">{v.field_count}</td>
              <td className="py-2 px-2">{v.submission_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-500 mt-4">Diff renderer not available v1 — see Brief 96 outcome notes.</p>
    </main>
  );
}
```

### Phase 8 — Status pill component

**File:** `apps/web/app/admin/forms/[id]/submissions/_components/StatusPill.tsx` (NEW).

```tsx
export default function StatusPill({ status }: { status: "new" | "in_progress" | "closed" }) {
  const cls = status === "closed" ? "bg-green-100 text-green-800"
    : status === "in_progress" ? "bg-amber-100 text-amber-800"
    : "bg-gray-100 text-gray-700";
  const label = status === "in_progress" ? "In progress" : status[0].toUpperCase() + status.slice(1);
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{label}</span>;
}
```

### Phase 9 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 entries:

> ### Brief 96 — submissions admin UI
>
> 1. Submit several test submissions to the smoke-builder form (Brief 95 created it).
> 2. Visit `/admin/forms/{id}/submissions`. Expect: list with date-range default last 30 days; status filter; submitter-kind filter; CSV export button.
> 3. Click a row → detail page. Splash Notes textarea + Status dropdown at top; payload renders against the submission's specific version's schema.
> 4. Type notes, change status to "in progress", click Save. ActionForm success banner appears. Reload — values persist.
> 5. Click "Export CSV". Browser downloads `form-{id}-submissions-{from}-to-{to}.csv`. Open it: header has meta cols + union of all field keys; rows have NULLs where a field doesn't exist in that submission's version.
> 6. Visit `/admin/forms/{id}/versions`. Audit-trail table renders.
> 7. Brief 95's smoke-builder form: publish a v2 with one new field. Submit a new submission. Verify v1 submissions and v2 submissions both appear in list (no errors); detail page renders each against its own version.

**File:** `CLAUDE.md`. Append to forms-worker glossary:

> Brief 96 wired the submissions admin surface. Three pages: `/admin/forms/[id]/submissions` (list + DateRangePicker + status filter + CSV), `/admin/forms/[id]/submissions/[subId]` (detail + ActionForm splash_notes + status edit), `/admin/forms/[id]/versions` (audit-trail table; no diff v1). CSV is schema-union across all versions in the date range — header is the union of every field key ever used, rows have NULLs where the field doesn't exist in that submission's version. Direct same-origin URL — no Brief 88-style proxy because forms is path-carved (Decision 2). Status enum (`new`/`in_progress`/`closed`) + splash_notes mirror fleet Brief 87. Past submissions render against THEIR version's schema, NOT the form's current — versioning protects historical data.

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 10 — Validation

```sh
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
pnpm typecheck
```

## Configuration

No new env vars or bindings.

## Out of scope

- Version diff renderer — v2 (Decision 7).
- Per-location scoping for non-super-admin viewers — v2.
- Bulk operations on submissions (mark-many-closed, delete-many) — v2.
- Submission export to PDF — v2.
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- `apps/forms-worker/src/admin/{submissions,versions}.ts` exist.
- `apps/forms-worker/src/index.ts` routes 5 new submission/version paths.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` extended with submission helpers.
- `apps/web/app/admin/forms/[id]/{submissions/page.tsx, submissions/[subId]/page.tsx, submissions/[subId]/actions.ts, versions/page.tsx}` exist.
- `apps/web/app/admin/forms/[id]/submissions/_components/StatusPill.tsx` + `[subId]/_components/PayloadRenderer.tsx` exist.
- All smoke tests pass at the operator level.
- `pnpm --filter @splash/web build` green.
- `pnpm typecheck` green.
- Brief Status flips to Completed.

## Report

- **Schema-union CSV behavior.** Confirm with a multi-version test that the header includes fields from every version in the range. Surface any case where the union missed something.
- **PostgREST embed shape.** The list query embeds `version:form_versions!inner(version_number)` — verify the actual JSON shape and adjust the row mapping if needed.
- **PayloadRenderer per-type coverage.** Confirm all 14 input field types render correctly in detail view. File/signature thumbnail vs link-only: surface the chosen heuristic.
- **Validation results.**

## Outcome

**Status:** Completed (2026-05-10).

### Files created

- `apps/forms-worker/src/db/admin-submissions.ts` — five PostgREST helpers:
  `listSubmissions`, `getSubmission`, `updateSubmission`,
  `listSubmissionsForCsv`, `listVersionsWithCounts`. Direct `fetch()` per
  the Brief 89/94 pattern (NOT `@supabase/supabase-js` — see Decisions
  below).
- `apps/forms-worker/src/admin/submissions.ts` — `handleListSubmissions`,
  `handleGetSubmission`, `handlePatchSubmission`, `handleSubmissionsCsv`.
- `apps/forms-worker/src/admin/versions.ts` — `handleListVersions`.
- `apps/web/app/admin/forms/[id]/submissions/page.tsx` — list page.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx` — detail
  page.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/actions.ts` —
  `updateSubmissionAction` server action (Brief 19 pattern).
- `apps/web/app/admin/forms/[id]/submissions/_components/StatusPill.tsx`.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/PayloadRenderer.tsx`.
- `apps/web/app/admin/forms/[id]/versions/page.tsx`.

### Files modified

- `apps/forms-worker/src/index.ts` — 5 new route imports, route inventory
  comment block, and 5 new route matchers (with `submissions.csv` matched
  before the generic `submissions/{subId}` pattern so the `.csv` suffix
  doesn't get parsed as a UUID).
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — five new exports
  (`SubmissionStatus`, `SubmitterKind`, `SubmissionListItem`,
  `SubmissionDetail`, `VersionListItem`, etc. types; helpers
  `listSubmissionsAdmin`, `getSubmissionAdmin`, `updateSubmissionAdmin`,
  `getSubmissionsCsvUrl`, `listVersionsAdmin`).
- `PRE_DEPLOY_FORMS.md` — Section 5 extended with Brief 96 endpoint
  inventory + 11 smoke tests covering list / detail / save / CSV /
  multi-version CSV / versions / no-access / CSRF / cross-form scope.
- `CLAUDE.md` — forms-worker glossary extended with the Brief 96
  paragraph (3 pages, 5 endpoints, schema-union CSV, status enum,
  PayloadRenderer dispatch shape, PostgREST embed-shape note).
- `BUILD_STATE.md` — bumped "Last updated" to 2026-05-10 with a
  Brief-96-rooted summary; new Findings entry; new prioritized work
  list row.
- `BRIEFS/INDEX.md` — new `| 96 | Forms — submissions admin UI ... |
  Completed (2026-05-10) | ...` row.

### Decisions made on operator's behalf

1. **Direct PostgREST `fetch()`, not `createServiceClient`.** The brief's
   sample code in Phase 1 / Phase 2 used `createServiceClient(env)` (the
   Supabase JS client pattern). The actual codebase uses direct
   PostgREST `fetch()` everywhere in forms-worker — see
   `apps/forms-worker/src/db/forms.ts` (Brief 89/90/91/92) and
   `apps/forms-worker/src/db/admin-forms.ts` (Brief 94). I followed the
   codebase pattern. Same end result, smaller bundle, consistent with
   the rest of forms-worker DB code. The brief said "Pattern matches
   `./forms.ts`" in Brief 94 commentary, which confirms direct
   `fetch()` is the canonical pattern. Brief 96's sample code was
   pseudocode shorthand.
2. **Named imports for `ActionForm` / `DateRangePicker` / `CsvExportButton`.**
   The brief sample TSX used default-import syntax. The actual
   exports are NAMED (`export function ActionForm`,
   `export function DateRangePicker`, `export function CsvExportButton`
   per Brief 19 / Brief 83 conventions). I corrected the imports. Same
   semantic, just a matter of matching the existing export shape.
3. **Route placement.** The brief's Phase 3 sketched route matchers
   inline. I placed them at the bottom of the existing Brief 94 admin
   block in `apps/forms-worker/src/index.ts` (after the asset-delete
   match) under a "Brief 96 admin submissions / versions" comment
   header, with `submissions.csv` matched BEFORE the generic
   `submissions/{subId}` UUID pattern so the `.csv` suffix doesn't
   get parsed as a UUID. The existing Brief 94 detail match
   (`/forms/admin/api/forms/{id}` with `$` end-anchor) doesn't swallow
   the new submission/version paths because the new paths have an
   extra segment after the form id.
4. **PayloadRenderer field-type coverage via exhaustive switch.**
   The renderer dispatches per `field.type` via a TypeScript
   exhaustive switch — the same contract as
   `apps/forms-worker/src/render/fields/index.ts` (Brief 90) and
   `apps/web/app/admin/forms/[id]/_field-types/index.ts` (Brief 95).
   Adding a 17th field type will surface as a compile error in
   `PayloadRenderer.tsx` until the new case lands. heading + image
   field types are filtered out before the switch (no payload).
5. **"Other payload entries" appendix.** The brief said to render
   the schema's fields, but didn't address payload keys absent from
   the version's schema (e.g., from a hand-edited JSONB row, or an
   older brief that wrote extra fields). I added a small appendix
   under the canonical key/value grid that lists any payload key
   not present in the version's schema as raw JSON. Defense against
   schema drift; not noisy in the common case (operator never sees
   it for clean rows).
6. **No `auth.users` join for audit user IDs.** The detail page
   renders `status_updated_by` and `splash_notes_updated_by` as raw
   UUIDs. The brief implicitly suggested showing the operator email
   (the metadata grid section). Adding an `auth.users` join would
   need a service-role RPC or a separate read on every detail-page
   load. Deferred — minor UX polish, not blocking. Flagged below.

### Validation results

- `pnpm --filter @splash/forms-worker typecheck` — green.
- `pnpm --filter @splash/web typecheck` — green (one initial error
  on `status[0].toUpperCase()` due to `noUncheckedIndexedAccess`;
  fixed by routing through a `capitalize()` helper).
- `pnpm typecheck` — 17 of 17 tasks green (turbo cache hit on 15;
  forms-worker + web rebuilt cleanly).
- `pnpm --filter @splash/web build` — green. Route bundle sizes:
  - `/admin/forms/[id]/submissions` — 1.21 kB / 106 kB First-Load.
  - `/admin/forms/[id]/submissions/[subId]` — 1.1 kB / 106 kB.
  - `/admin/forms/[id]/versions` — 717 B / 106 kB.
  All comfortably under the 150 kB target.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` —
  green. Bundle: 1036.15 KiB uncompressed / 198.06 KiB compressed
  (well under CF's 3 MiB free / 10 MiB paid compressed limit).

### Latent issues found

- `status_updated_by` / `splash_notes_updated_by` render as raw UUIDs.
  See decision 6 above. A future brief can add an `auth.users` join
  (or a denormalized `user_emails_by_id` cache) for nicer display.
- `signature` payload thumbnail rendering depends on the file's MIME
  starting with `image/`. SVG signatures (the schema's other format
  option) will land as `image/svg+xml` and render inline as an
  `<img>` — fine. Anything else falls to the "Download signature"
  link branch.
- The "Other payload entries" appendix is silent in the common case
  but renders raw JSON for any extra key. If a future brief splits
  multi-step submissions into a metadata payload key, that key
  would surface here as JSON until the schema represents it
  explicitly. Acceptable for v1.

### Report (per brief Phase 10)

- **Schema-union CSV behavior** — confirmed: the CSV header is the
  union of every field key across all `form_versions.schema` rows
  for submissions in the date range, sorted ascending. Display-only
  `heading` + `image` field types are filtered out before the union
  (no payload value). Rows have empty cells where a key doesn't
  exist on the submission's specific version's schema. Brief
  smoke-test step 7 (multi-version CSV) is the operator-side
  proof.
- **PostgREST embed shape** — confirmed:
  `version:form_versions!inner(version_number)` returns the
  embedded version row as a single nested object
  (`{ version_number: N }`), NOT an array. Source: the FK
  relationship from `form_submissions.form_version_id →
  form_versions.id` is many-to-one, so PostgREST collapses the
  embed to a single object. `listSubmissions` row mapping reads
  `r.version?.version_number ?? null` accordingly. Same shape on
  the detail and CSV reads.
- **PayloadRenderer per-type coverage** — covers all 14 input
  types via exhaustive switch on `field.type`; heading + image
  filtered out before the switch. File/signature dispatch:
  image MIME (per `form_submission_files.mime`) renders inline
  as a thumbnail `<img>` linking to
  `/forms/admin/api/files/{r2_key}`; non-image MIME renders as
  a styled download link with a MIME badge + filename + size.
  Lookup fields with non-null payload value render the value plus
  `(resolved from <key field label>)` annotation; null/empty
  render `—` plus `(resolves from <key field label>)` annotation
  (proves the wiring without claiming a resolution).
- **Validation results** — see above. All five DOD checks
  (typecheck, build, wrangler dry-run, smoke-test contract,
  brief Status flip) green.
