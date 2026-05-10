# Brief 95: Forms — admin builder UI (`/admin/forms`, `/admin/forms/[id]`)

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** Brief 96 (submissions admin UI — depends on the FormsAdminTabs component this brief introduces; reuses the worker-fetch helper from Brief 94 + the per-field-type renderers concept). Brief 98 (polish — error boundary, dashboard tile).
**Dependencies:** Brief 89 (foundation), Brief 90 (the public renderer this builder mirrors), Brief 94 (admin API).

## Read first

- BUILD_STATE.md.
- CLAUDE.md (especially the Brief 19 ActionForm pattern note — but note this brief departs from it for the canvas mutations because they're high-frequency client-side state, not server actions).
- BRIEFS/brief-094-forms-admin-api-crud.md (every endpoint this UI consumes; the worker-fetch helper this brief uses end-to-end).
- BRIEFS/brief-090-forms-public-render.md (the per-field-type render pattern this brief mirrors React-side).
- BRIEFS/brief-007-sysadmin-ui.md (precedent for a complex admin UI page in apps/web).
- BRIEFS/brief-019-action-result-refresh.md (ActionForm pattern — used for Save Draft + Publish buttons; canvas mutations bypass it because they're client-only until Save).
- BRIEFS/brief-031-server-action-id-stability.md (the error boundary pattern this brief extends to `/admin/forms/error.tsx`).
- BRIEFS/brief-056-signup-admin-rename-and-signups-viewer.md (precedent for FormsAdminTabs — mirrors SignupAdminTabs).
- packages/forms-schema/src/types.ts (the discriminated union the builder mutates).
- packages/ui/src/index.ts (shared `<ModalShell>`, etc.).

## Architecture context

Per planning Decision 3, the builder:

- Uses **React (Next.js client component)** — apps/web client island in `/admin/forms/[id]`.
- Uses **`useReducer`** for canvas + inspector state. Actions: `add_field`, `remove_field`, `reorder_field`, `duplicate_field`, `update_field_config`, `update_form_meta`, `select_field`, `clear_selection`, `load_initial`. ~150 LOC reducer.
- Uses **`dnd-kit`** for drag-and-drop reorder + drag-from-palette-to-canvas. ~10KB gzipped, accessibility-built-in.
- Layout: **3-column** — palette (left, ~180px), canvas (center, fluid), inspector (right, ~320px). Top bar with editable title, Save Draft, Publish, status pill.
- **No auto-save v1.** Operator clicks Save Draft when ready. Dirty-state indicator + `beforeunload` warning. Publish is a separate button (Decision 3).
- **Live in-canvas preview** — each field renders its visual appearance (the way it'll look to the public), with admin chrome (drag handle, settings cog, delete X) overlaid (Decision 3).
- **Per-field-type folder structure** under `apps/web/app/admin/forms/[id]/_field-types/{type}/{Renderer.tsx, Inspector.tsx, defaultConfig.ts}` — adding a 17th type is a contained change.

Per Decision 7, **only super_admin + admin** can access `/admin/forms/*`. apps/web `getMe()` gates page-level; worker re-validates on every API call (defense in depth).

Per Decision 4, **field key auto-generation** uses `nanoid(8)` (lowercase hex). Operator can rename in inspector with snake_case validation.

Per Brief 19, **Save Draft + Publish buttons** use the `<ActionForm>` pattern — they're server-action-style writes. The canvas mutations themselves are NOT server actions; they're useReducer dispatches that mutate client-side state until the operator clicks Save Draft (which PATCHes the worker).

## Context

Seventh of 10 briefs. The largest UI brief in the feature — combines 3-column layout, drag-and-drop, 16 per-field-type renderers + 16 inspectors, 9 reducer actions, 6 worker-fetch wirings. The brief gives the executor a complete skeleton + 4 concrete per-field-type examples; the remaining 12 follow the same shape.

This brief introduces 2 new deps to apps/web: `@dnd-kit/core` + `@dnd-kit/sortable` (~10KB combined gzipped) + `nanoid` (~1KB).

## Scope

### Phase 1 — New apps/web deps

**File:** `apps/web/package.json` (MODIFY).

```json
"dependencies": {
  // ...existing
  "@dnd-kit/core": "^6.1.0",
  "@dnd-kit/sortable": "^8.0.0",
  "nanoid": "^5.0.0"
}
```

`pnpm install` from repo root.

### Phase 2 — Shared FormsAdminTabs component

**File:** `apps/web/app/admin/forms/_components/FormsAdminTabs.tsx` (NEW). Mirrors `SignupAdminTabs` shape.

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  formId?: string;   // when on a per-form subpage
}

export default function FormsAdminTabs({ formId }: Props) {
  const pathname = usePathname();
  const tabs = [
    { href: "/admin/forms", label: "All Forms", active: pathname === "/admin/forms" }
  ];
  if (formId) {
    tabs.push(
      { href: `/admin/forms/${formId}`, label: "Builder", active: pathname === `/admin/forms/${formId}` },
      { href: `/admin/forms/${formId}/submissions`, label: "Submissions", active: pathname.startsWith(`/admin/forms/${formId}/submissions`) },
      { href: `/admin/forms/${formId}/versions`, label: "Versions", active: pathname.startsWith(`/admin/forms/${formId}/versions`) }
    );
  }
  return (
    <nav className="border-b border-gray-200 mb-6">
      <ul className="flex gap-1">
        {tabs.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              className={`inline-block px-4 py-2 text-sm font-medium border-b-2 -mb-[1px] ${t.active ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"}`}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

### Phase 3 — Forms list page

**File:** `apps/web/app/admin/forms/page.tsx` (NEW). Server component.

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { getMe } from "../../_lib/me";
import { listFormsAdmin } from "./_lib/worker-fetch";
import FormsAdminTabs from "./_components/FormsAdminTabs";
import PageBanner from "../_components/PageBanner";   // shared banner from sysadmin
import NoAccessCard from "../_components/NoAccessCard";

export const dynamic = "force-dynamic";

interface SearchParams { status?: string; search?: string; }

export default async function FormsListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const me = await getMe();
  if (!me) redirect("/login?next=/admin/forms");

  const allowed = me.role === "super_admin" || me.dcRole === "admin" || me.dcRole === "super_admin";
  if (!allowed) {
    return (
      <main className="max-w-5xl mx-auto p-8">
        <PageBanner title="Forms" subtitle="Build and manage admin-built forms." />
        <NoAccessCard />
      </main>
    );
  }

  let items;
  try {
    const res = await listFormsAdmin({ status: params.status, search: params.search });
    items = res.items;
  } catch (e) {
    return (
      <main className="max-w-5xl mx-auto p-8">
        <FormsAdminTabs />
        <PageBanner title="Forms" />
        <p className="text-red-600">Failed to load forms: {String(e)}</p>
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto p-8">
      <FormsAdminTabs />
      <PageBanner title="Forms" subtitle="Build, publish, and review admin-built forms." />

      {/* Filter row */}
      <form method="get" className="flex gap-2 mb-4 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
          <select name="status" defaultValue={params.status ?? "all"} className="border rounded px-2 py-1 text-sm">
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Search</label>
          <input type="text" name="search" defaultValue={params.search ?? ""} placeholder="Title or slug substring" className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <button type="submit" className="bg-blue-600 text-white px-3 py-1 rounded text-sm">Filter</button>
        <Link href="/admin/forms/new" className="ml-auto bg-green-600 text-white px-3 py-1 rounded text-sm">+ Create form</Link>
      </form>

      {items.length === 0 ? (
        <p className="text-gray-500 italic">No forms yet. Create one to get started.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-600 uppercase">
              <th className="py-2 px-2">Title</th>
              <th className="py-2 px-2">Slug</th>
              <th className="py-2 px-2">Status</th>
              <th className="py-2 px-2">Audience</th>
              <th className="py-2 px-2">Versions</th>
              <th className="py-2 px-2">Submissions</th>
              <th className="py-2 px-2">Last edited</th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 px-2"><Link href={`/admin/forms/${f.id}`} className="text-blue-700 font-medium">{f.title}</Link></td>
                <td className="py-2 px-2 text-gray-600 font-mono text-xs">{f.slug}</td>
                <td className="py-2 px-2"><StatusPill status={f.status} /></td>
                <td className="py-2 px-2 text-sm">{f.audience}</td>
                <td className="py-2 px-2 text-sm">{f.versionCount}</td>
                <td className="py-2 px-2 text-sm">{f.submissionCount}</td>
                <td className="py-2 px-2 text-sm text-gray-600">{new Date(f.lastEditedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "published"
    ? "bg-green-100 text-green-800"
    : status === "draft" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700";
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status}</span>;
}
```

### Phase 4 — Create form page

**File:** `apps/web/app/admin/forms/new/page.tsx` (NEW). Simple server component with a small form.

**File:** `apps/web/app/admin/forms/new/actions.ts` (NEW). Server action that calls `createFormAdmin` and redirects to the builder.

```ts
"use server";
import { redirect } from "next/navigation";
import { createFormAdmin } from "../_lib/worker-fetch";
import type { ActionResult } from "../../_components/ActionForm";

export async function createFormAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const audience = String(formData.get("audience") ?? "") as "public" | "internal" | "link-only";

  try {
    const res = await createFormAdmin({ slug, title, description, audience });
    redirect(`/admin/forms/${res.form_id}`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("slug_taken")) {
      return { ok: false, error: "A form with that slug already exists." };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

(`redirect()` here is fine because the page hasn't started rendering response yet — it's a true navigation. The Brief 19 caveat about `redirect()` from server actions applies to actions that should give in-page feedback; create-and-redirect-to-detail is a different use case.)

The page renders an `<ActionForm>` wrapping slug/title/description/audience inputs.

### Phase 5 — Builder page

**File:** `apps/web/app/admin/forms/[id]/page.tsx` (NEW). Server component that fetches form detail then mounts the client builder.

```tsx
import { redirect, notFound } from "next/navigation";
import { getMe } from "../../../_lib/me";
import { getFormAdmin, getLookupSourcesAdmin } from "../_lib/worker-fetch";
import FormsAdminTabs from "../_components/FormsAdminTabs";
import BuilderClient from "./_builder/BuilderClient";
import NoAccessCard from "../../_components/NoAccessCard";

export const dynamic = "force-dynamic";

export default async function FormBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  if (!me) redirect(`/login?next=/admin/forms/${id}`);
  const allowed = me.role === "super_admin" || me.dcRole === "admin" || me.dcRole === "super_admin";
  if (!allowed) {
    return (
      <main className="max-w-7xl mx-auto p-6">
        <FormsAdminTabs formId={id} />
        <NoAccessCard />
      </main>
    );
  }

  let detail;
  try {
    detail = await getFormAdmin(id);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("404")) notFound();
    throw e;
  }
  const lookupSources = await getLookupSourcesAdmin();

  return (
    <main className="max-w-full mx-auto p-4">
      <FormsAdminTabs formId={id} />
      <BuilderClient initial={detail} lookupSources={lookupSources.sources} formId={id} />
    </main>
  );
}
```

### Phase 6 — Builder client island (the big one)

**Directory:** `apps/web/app/admin/forms/[id]/_builder/` (NEW).

**File:** `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx` (NEW). The 3-column layout + reducer wiring.

```tsx
"use client";
import { useReducer, useState, useEffect } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import type { Field, FormSchema, LookupSource } from "@splash/forms-schema";
import { reducer, initialState, type BuilderState } from "./reducer";
import Palette from "./Palette";
import Canvas from "./Canvas";
import Inspector from "./Inspector";
import TopBar from "./TopBar";
import { updateDraftAdmin, publishFormAdmin } from "../../_lib/worker-fetch";

interface Props {
  initial: {
    form: { id: string; slug: string; title: string; description: string | null; audience: "public" | "internal" | "link-only"; status: "draft" | "published" | "archived"; currentVersionId: string | null; draftVersionId: string | null; notifyWebhook: boolean; successMessage: string | null; turnstileRequired: boolean; };
    draftSchema: FormSchema;
    currentVersionNumber: number | null;
    versions: Array<{ id: string; versionNumber: number; publishedAt: string | null; isDraft: boolean }>;
  };
  lookupSources: readonly LookupSource[];
  formId: string;
}

export default function BuilderClient({ initial, lookupSources, formId }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState(initial));
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [publishing, setPublishing] = useState<"idle" | "publishing" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Dirty-state warning on unload
  useEffect(() => {
    if (!state.dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.dirty]);

  async function handleSaveDraft() {
    setSaving("saving");
    setErrorMsg(null);
    try {
      await updateDraftAdmin(formId, { fields: state.fields });
      setSaving("saved");
      dispatch({ type: "mark_clean" });
      setTimeout(() => setSaving("idle"), 2000);
    } catch (e: unknown) {
      setSaving("error");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePublish() {
    if (state.dirty && !confirm("You have unsaved changes. Save and publish?")) return;
    if (state.dirty) await handleSaveDraft();
    setPublishing("publishing");
    setErrorMsg(null);
    try {
      const res = await publishFormAdmin(formId);
      setPublishing("done");
      alert(`Published as version ${res.published_version_number}.`);
      window.location.reload();   // reload to pick up new draft + version history
    } catch (e: unknown) {
      setPublishing("error");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (typeof active.id === "string" && typeof over.id === "string") {
      const oldIdx = state.fields.findIndex((f) => f.id === active.id);
      const newIdx = state.fields.findIndex((f) => f.id === over.id);
      if (oldIdx >= 0 && newIdx >= 0) {
        dispatch({ type: "reorder_field", fields: arrayMove(state.fields, oldIdx, newIdx) });
      }
    }
  }

  const selectedField = state.selectedFieldId ? state.fields.find((f) => f.id === state.selectedFieldId) : undefined;

  return (
    <div className="flex flex-col h-[calc(100vh-180px)]">
      <TopBar
        formMeta={state.formMeta}
        currentVersionNumber={initial.currentVersionNumber}
        dirty={state.dirty}
        saving={saving}
        publishing={publishing}
        errorMsg={errorMsg}
        onSaveDraft={handleSaveDraft}
        onPublish={handlePublish}
        onTitleChange={(t) => dispatch({ type: "update_form_meta", patch: { title: t } })}
      />
      <div className="flex flex-1 overflow-hidden gap-4 mt-4">
        <Palette onAdd={(type) => dispatch({ type: "add_field", fieldType: type })} />
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={state.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <Canvas
              fields={state.fields}
              selectedFieldId={state.selectedFieldId}
              onSelect={(id) => dispatch({ type: "select_field", fieldId: id })}
              onDelete={(id) => dispatch({ type: "remove_field", fieldId: id })}
              onDuplicate={(id) => dispatch({ type: "duplicate_field", fieldId: id })}
            />
          </SortableContext>
        </DndContext>
        <Inspector
          selectedField={selectedField}
          formMeta={state.formMeta}
          allFields={state.fields}
          lookupSources={lookupSources}
          onFieldUpdate={(patch) => selectedField && dispatch({ type: "update_field_config", fieldId: selectedField.id, patch })}
          onFormMetaUpdate={(patch) => dispatch({ type: "update_form_meta", patch })}
        />
      </div>
    </div>
  );
}
```

**File:** `apps/web/app/admin/forms/[id]/_builder/reducer.ts` (NEW).

```ts
import { nanoid } from "nanoid";
import type { Field, FieldType } from "@splash/forms-schema";
import { defaultConfigFor } from "../_field-types";

export interface BuilderState {
  fields: Field[];
  formMeta: {
    title: string;
    description: string | null;
    audience: "public" | "internal" | "link-only";
    notifyWebhook: boolean;
    successMessage: string | null;
    turnstileRequired: boolean;
    slug: string;
  };
  selectedFieldId: string | null;
  dirty: boolean;
}

export type Action =
  | { type: "add_field"; fieldType: FieldType }
  | { type: "remove_field"; fieldId: string }
  | { type: "duplicate_field"; fieldId: string }
  | { type: "reorder_field"; fields: Field[] }
  | { type: "update_field_config"; fieldId: string; patch: Partial<Field> }
  | { type: "update_form_meta"; patch: Partial<BuilderState["formMeta"]> }
  | { type: "select_field"; fieldId: string }
  | { type: "clear_selection" }
  | { type: "mark_clean" };

export function initialState(initial: { form: any; draftSchema: { fields: Field[] } }): BuilderState {
  return {
    fields: initial.draftSchema.fields,
    formMeta: {
      title: initial.form.title,
      description: initial.form.description,
      audience: initial.form.audience,
      notifyWebhook: initial.form.notifyWebhook,
      successMessage: initial.form.successMessage,
      turnstileRequired: initial.form.turnstileRequired,
      slug: initial.form.slug
    },
    selectedFieldId: null,
    dirty: false
  };
}

export function reducer(state: BuilderState, action: Action): BuilderState {
  switch (action.type) {
    case "add_field": {
      const newField = {
        id: nanoid(8),
        key: `field_${nanoid(6)}`,
        ...defaultConfigFor(action.fieldType)
      } as Field;
      return { ...state, fields: [...state.fields, newField], selectedFieldId: newField.id, dirty: true };
    }
    case "remove_field":
      return {
        ...state,
        fields: state.fields.filter((f) => f.id !== action.fieldId),
        selectedFieldId: state.selectedFieldId === action.fieldId ? null : state.selectedFieldId,
        dirty: true
      };
    case "duplicate_field": {
      const idx = state.fields.findIndex((f) => f.id === action.fieldId);
      if (idx < 0) return state;
      const orig = state.fields[idx];
      const dup = { ...orig, id: nanoid(8), key: `${orig.key}_copy` };
      const copy = [...state.fields];
      copy.splice(idx + 1, 0, dup);
      return { ...state, fields: copy, selectedFieldId: dup.id, dirty: true };
    }
    case "reorder_field":
      return { ...state, fields: action.fields, dirty: true };
    case "update_field_config":
      return {
        ...state,
        fields: state.fields.map((f) => f.id === action.fieldId ? { ...f, ...action.patch } as Field : f),
        dirty: true
      };
    case "update_form_meta":
      return { ...state, formMeta: { ...state.formMeta, ...action.patch }, dirty: true };
    case "select_field":
      return { ...state, selectedFieldId: action.fieldId };
    case "clear_selection":
      return { ...state, selectedFieldId: null };
    case "mark_clean":
      return { ...state, dirty: false };
  }
}
```

**File:** `apps/web/app/admin/forms/[id]/_builder/TopBar.tsx` (NEW). Title input, Save Draft, Publish, status pill, dirty indicator.

**File:** `apps/web/app/admin/forms/[id]/_builder/Palette.tsx` (NEW). Vertical list of field types; clicking adds to canvas.

```tsx
"use client";
import type { FieldType } from "@splash/forms-schema";
import { FIELD_TYPE_REGISTRY } from "../_field-types";

interface Props {
  onAdd: (type: FieldType) => void;
}

export default function Palette({ onAdd }: Props) {
  return (
    <aside className="w-44 flex-shrink-0 border-r border-gray-200 pr-3">
      <h2 className="text-xs font-semibold uppercase text-gray-500 mb-2">Add field</h2>
      <ul className="space-y-1">
        {FIELD_TYPE_REGISTRY.map((t) => (
          <li key={t.type}>
            <button
              type="button"
              onClick={() => onAdd(t.type)}
              className="w-full text-left px-2 py-1 text-sm border border-gray-200 rounded hover:bg-blue-50 hover:border-blue-300"
            >
              {t.label}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

**File:** `apps/web/app/admin/forms/[id]/_builder/Canvas.tsx` (NEW). Sortable list of fields. Each field renders its `Renderer` component with admin chrome (drag handle, settings, delete).

**File:** `apps/web/app/admin/forms/[id]/_builder/Inspector.tsx` (NEW). Right panel — switches on selected field's type to render its Inspector component, OR renders FormMetaInspector when nothing selected.

### Phase 7 — Per-field-type folder

**Directory:** `apps/web/app/admin/forms/[id]/_field-types/` (NEW).

**File:** `apps/web/app/admin/forms/[id]/_field-types/index.ts` (NEW). Registry + dispatcher.

```ts
import type { FieldType, Field } from "@splash/forms-schema";
import * as Heading from "./heading";
import * as Image from "./image";
import * as Name from "./name";
import * as Email from "./email";
import * as Phone from "./phone";
import * as ShortText from "./short-text";
import * as LongText from "./long-text";
import * as Hidden from "./hidden";
import * as Dropdown from "./dropdown";
import * as Multi from "./multi";
import * as Date_ from "./date";
import * as Time_ from "./time";
import * as File_ from "./file";
import * as Signature from "./signature";
import * as Location_ from "./location";
import * as Lookup from "./lookup";

interface FieldTypeModule {
  type: FieldType;
  label: string;
  defaultConfig: Omit<Field, "id" | "key">;
  Renderer: React.ComponentType<{ field: Field }>;
  Inspector: React.ComponentType<{ field: Field; allFields: Field[]; lookupSources: readonly any[]; onUpdate: (patch: Partial<Field>) => void }>;
}

export const FIELD_TYPE_REGISTRY: FieldTypeModule[] = [
  Heading, Image, Name, Email, Phone, ShortText, LongText, Hidden,
  Dropdown, Multi, Date_, Time_, File_, Signature, Location_, Lookup
] as unknown as FieldTypeModule[];

export function defaultConfigFor(type: FieldType): Omit<Field, "id" | "key"> {
  const mod = FIELD_TYPE_REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`Unknown field type: ${type}`);
  return mod.defaultConfig;
}

export function getFieldModule(type: FieldType): FieldTypeModule {
  const mod = FIELD_TYPE_REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`Unknown field type: ${type}`);
  return mod;
}
```

**Per-field-type modules — 16 directories.** Each has 3 files.

**Example: `apps/web/app/admin/forms/[id]/_field-types/email/index.ts`** (NEW).

```ts
import type { EmailField } from "@splash/forms-schema";
export const type = "email" as const;
export const label = "Email";
export const defaultConfig: Omit<EmailField, "id" | "key"> = {
  type: "email",
  label: "Email",
  required: true,
  helpText: undefined,
  maxLength: undefined
};
export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
```

**Example: `apps/web/app/admin/forms/[id]/_field-types/email/Renderer.tsx`** (NEW). Visual rendering on the canvas — looks like the public form's email input.

```tsx
import type { EmailField } from "@splash/forms-schema";
export default function EmailRenderer({ field }: { field: EmailField }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-blue-900 mb-1">
        {field.label}{field.required && <span className="text-red-600 ml-0.5">*</span>}
      </label>
      <input type="email" disabled placeholder="user@example.com" className="w-full border rounded px-3 py-2 text-sm bg-gray-50" />
      {field.helpText && <p className="text-xs text-gray-500 mt-1">{field.helpText}</p>}
    </div>
  );
}
```

**Example: `apps/web/app/admin/forms/[id]/_field-types/email/Inspector.tsx`** (NEW). Right-panel config form.

```tsx
"use client";
import type { EmailField, Field } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import KeyEditor from "../_shared/KeyEditor";

interface Props {
  field: EmailField;
  onUpdate: (patch: Partial<Field>) => void;
}

export default function EmailInspector({ field, onUpdate }: Props) {
  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={field.label} onChange={(v) => onUpdate({ label: v })} />
      <KeyEditor value={field.key} onChange={(v) => onUpdate({ key: v })} />
      <LabeledCheckbox label="Required" checked={field.required} onChange={(v) => onUpdate({ required: v })} />
      <LabeledInput label="Help text" value={field.helpText ?? ""} onChange={(v) => onUpdate({ helpText: v || undefined })} />
      <LabeledInput type="number" label="Max length" value={String(field.maxLength ?? "")} onChange={(v) => onUpdate({ maxLength: v ? Number(v) : undefined })} />
    </div>
  );
}
```

**Example: `apps/web/app/admin/forms/[id]/_field-types/lookup/Inspector.tsx`** (NEW). The most complex inspector.

```tsx
"use client";
import type { LookupField, LookupSource, Field, LookupKeyColumn } from "@splash/forms-schema";
import LabeledInput from "../_shared/LabeledInput";
import LabeledCheckbox from "../_shared/LabeledCheckbox";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";

interface Props {
  field: LookupField;
  allFields: Field[];
  lookupSources: readonly LookupSource[];
  onUpdate: (patch: Partial<Field>) => void;
}

export default function LookupInspector({ field, allFields, lookupSources, onUpdate }: Props) {
  // Eligible key fields = anything in this form whose value can be used as a lookup key.
  // For v1: short_text, location, dropdown.
  const eligibleKeyFields = allFields.filter((f) =>
    (f.type === "short_text" || f.type === "location" || f.type === "dropdown") && f.id !== field.id
  );
  const sourcesForTable = lookupSources.filter((s) => s.table === field.sourceTable);

  return (
    <div className="space-y-3">
      <LabeledInput label="Label" value={field.label} onChange={(v) => onUpdate({ label: v })} />
      <KeyEditor value={field.key} onChange={(v) => onUpdate({ key: v })} />

      <LabeledSelect
        label="Key field (in this form)"
        value={field.keyFieldId}
        onChange={(v) => onUpdate({ keyFieldId: v })}
        options={[{ value: "", label: "— Pick a field —" }, ...eligibleKeyFields.map((f) => ({ value: f.id, label: `${f.label} (${f.key})` }))]}
      />

      <LabeledSelect
        label="Key column"
        value={field.keyColumn}
        onChange={(v) => onUpdate({ keyColumn: v as LookupKeyColumn })}
        options={[
          { value: "pricing_simple.location_code", label: "pricing_simple.location_code (slug)" },
          { value: "pricing_simple.site", label: "pricing_simple.site (3-digit number)" }
        ]}
      />

      <LabeledSelect
        label="Source table"
        value={field.sourceTable}
        onChange={(v) => onUpdate({ sourceTable: v as "pricing_simple" | "locations", sourceColumn: "" })}
        options={[
          { value: "pricing_simple", label: "pricing_simple" },
          { value: "locations", label: "locations" }
        ]}
      />

      <LabeledSelect
        label="Source column"
        value={field.sourceColumn}
        onChange={(v) => onUpdate({ sourceColumn: v })}
        options={[
          { value: "", label: "— Pick a column —" },
          ...sourcesForTable.map((s) => ({ value: s.column, label: s.label }))
        ]}
      />

      <LabeledSelect
        label="Resolution mode"
        value={field.resolutionMode}
        onChange={(v) => onUpdate({ resolutionMode: v as LookupField["resolutionMode"] })}
        options={[
          { value: "prefill_visible", label: "Visible (user sees the resolved value)" },
          { value: "prefill_hidden", label: "Hidden (resolved silently, no display)" },
          { value: "display_only", label: "Display only (shown to user, not stored)" }
        ]}
      />

      <LabeledSelect
        label="If resolution returns nothing"
        value={field.nullBehavior}
        onChange={(v) => onUpdate({ nullBehavior: v as "allow_empty" | "block_submit" })}
        options={[
          { value: "allow_empty", label: "Allow empty (submit OK)" },
          { value: "block_submit", label: "Block submit" }
        ]}
      />
    </div>
  );
}
```

**Shared inspector helpers:**

`apps/web/app/admin/forms/[id]/_field-types/_shared/{LabeledInput, LabeledCheckbox, LabeledSelect, KeyEditor, OptionListEditor}.tsx` — small reusable inputs. KeyEditor enforces the snake_case regex on every keystroke. OptionListEditor (used by dropdown + multi inspectors) lets operator add/remove/reorder option pairs.

**Executor writes the remaining 12 modules** (heading, image, name, phone, short-text, long-text, hidden, dropdown, multi, date, time, file, signature, location) following the email pattern. Each module is ~30 LOC for index.ts + ~20 LOC Renderer + ~30-60 LOC Inspector. Image inspector uses the asset upload helper from Brief 94. Signature inspector exposes format / penColor / minStrokes. File inspector exposes maxSizeMb / allowedMimeTypes / allowMultiple.

### Phase 8 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 ("Smoke tests") gets the Brief 95 entries:

> ### Brief 95 — admin builder UI
>
> 1. As super_admin, visit `/admin/forms`. Expect: list page renders; FormsAdminTabs visible; "Create form" button.
> 2. Click "Create form" → form opens. Fill slug "smoke-builder", title "Builder Smoke Test", audience "internal". Submit → redirects to `/admin/forms/{id}`.
> 3. Builder loads with empty canvas. Drag-drop from palette: add a Short Text, then Email, then Lookup. Inspector populates as you click each.
> 4. Click "Save Draft" → "Saved" indicator briefly appears.
> 5. Reload page → fields persist (proves PATCH landed).
> 6. Click "Publish" → confirmation, then status pill flips to "Published v1".
> 7. Visit `/forms/smoke-builder` → form renders with the three fields.
> 8. Reorder fields via drag-drop. Save Draft. Publish (creates v2). Reload.
> 9. Try entering an invalid slug-like key in inspector — KeyEditor blocks the keystroke.
> 10. Create a Location field + Lookup field keyed off it. Save + Publish. On the public form, picking a location should populate the lookup (Brief 93 wiring).
> 11. As non-admin, visit `/admin/forms` → NoAccessCard.

**File:** `CLAUDE.md`. Append to forms-worker glossary:

> Brief 95 wired the admin builder UI. Lives at `/admin/forms` (list) + `/admin/forms/[id]` (builder). 3-column: palette / canvas / inspector. `useReducer` for state, `dnd-kit` for reorder. Per-field-type folder under `apps/web/app/admin/forms/[id]/_field-types/{type}/{Renderer.tsx, Inspector.tsx, index.ts}` — adding a 17th type means: (1) new folder under _field-types, (2) entry in FIELD_TYPE_REGISTRY, (3) interface in `@splash/forms-schema/src/types.ts`, (4) Zod in `validators/field-config.ts`, (5) Zod in `validators/payload.ts`, (6) public renderer in `apps/forms-worker/src/render/fields/`. Save Draft + Publish via Brief 19's `<ActionForm>` pattern; canvas mutations are useReducer dispatches (NOT server actions — too high-frequency). `nanoid(8)` for field IDs and key suffixes. Beforeunload warning when dirty. The error boundary at `apps/web/app/admin/forms/error.tsx` (Brief 98) is the segment-level catch for any builder-side throws.

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 9 — Validation

```sh
pnpm install                                 # picks up new deps
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

## Configuration

No new env vars. `NEXT_PUBLIC_FORMS_WORKER_URL` should be set in `.env.local` for `next dev` (binding-fetch falls back to URL fetch outside Workers runtime).

## Out of scope

- Submissions admin pages — Brief 96.
- Version diff renderer — Brief 96 (or v2; planning Decision 7 deferred).
- Auto-save — v2 (Decision 3).
- "Preview as customer" iframe view — v2.
- Per-location scoping of submissions visibility — v2.
- Dashboard tile + global error boundary — Brief 98.
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- All apps/web deps installed (`@dnd-kit/core`, `@dnd-kit/sortable`, `nanoid`).
- `apps/web/app/admin/forms/page.tsx`, `new/page.tsx`, `new/actions.ts`, `[id]/page.tsx` exist.
- `_components/FormsAdminTabs.tsx` exists.
- `[id]/_builder/{BuilderClient, reducer, TopBar, Palette, Canvas, Inspector}.tsx` exist.
- `[id]/_field-types/index.ts` + 16 type modules + `_shared/` helpers exist.
- All builder smoke tests pass at the operator level.
- `pnpm --filter @splash/web build` green (route count grows by 4 — `/admin/forms`, `/admin/forms/new`, `/admin/forms/[id]`, plus the existing `/admin/forms/error.tsx` slot if Brief 98 lands first).
- `pnpm typecheck` green.
- Brief Status flips to Completed.

## Report

- **Bundle size impact.** First-Load JS for `/admin/forms/[id]` after this brief — flag if >150 KB (large but acceptable; >200 KB suggests over-import somewhere).
- **dnd-kit accessibility.** Confirm keyboard reorder (Tab to focus a field, Space to lift, arrows to move, Enter to drop) works — operators may use it.
- **`nanoid` import shape.** ESM-only in v5; verify import works in apps/web's bundler.
- **Per-field-type folder count.** Confirm 16 type modules + _shared/ helpers + the registry index.
- **KeyEditor regex.** Final regex used; flag if executor relaxed it from the brief's spec (`^[a-z][a-z0-9_]*$`).
- **Validation results.**

## Outcome

### Files created

- `apps/web/app/admin/forms/_components/FormsAdminTabs.tsx` — pathname-driven tab nav. Per-form sub-tabs (Builder / Submissions / Versions) only render when `formId` is provided; mirrors SignupAdminTabs (Brief 56).
- `apps/web/app/admin/forms/_components/NoAccessCard.tsx` — `reason="signin"|"forbidden"` card. Mirrors the sysadmin pattern; sized for the Forms umbrella (returnPath defaults to `/admin/forms`).
- `apps/web/app/admin/forms/page.tsx` — list page. Status filter (`all`/`draft`/`published`/`archived`) + search substring + "+ Create form" button. Server component with admin gate via `getMe()`.
- `apps/web/app/admin/forms/new/page.tsx` + `actions.ts` — Create form page using `<ActionForm>` from Brief 19. The action validates slug/title/audience inline, calls `createFormAdmin`, redirects to `/admin/forms/{id}` on success.
- `apps/web/app/admin/forms/[id]/page.tsx` — builder server page. Fetches form detail + lookup-source registry, mounts BuilderClient. `notFound()` on 404; NoAccessCard on 401/403.
- `apps/web/app/admin/forms/[id]/actions.ts` — two server actions (`saveDraftAction(formId, fields)` + `publishFormAction(formId)`) that wrap the SSR worker-fetch helpers. Required because BuilderClient is `"use client"` and can't import `next/headers`.
- `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx` — 3-column layout. `useReducer` for state, `dnd-kit` DndContext + SortableContext, beforeunload warning, Save Draft + Publish handlers.
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — 9 actions: add_field, remove_field, duplicate_field, reorder_field, update_field_config, update_form_meta, select_field, clear_selection, mark_clean. nanoid(8) for field IDs and nanoid(6) for key suffixes.
- `apps/web/app/admin/forms/[id]/_builder/TopBar.tsx` — title input, slug pill, status badge (with version number when published), Save Draft + Publish buttons, dirty indicator, error message slot.
- `apps/web/app/admin/forms/[id]/_builder/Palette.tsx` — vertical list of 16 field-type buttons; click to add to canvas.
- `apps/web/app/admin/forms/[id]/_builder/Canvas.tsx` — sortable list. Each card surfaces drag handle (`⋮⋮`), duplicate (`⧉`), delete (`✕`); selecting opens the inspector.
- `apps/web/app/admin/forms/[id]/_builder/Inspector.tsx` — switches on selected field's type to render its Inspector component, OR renders FormMetaInspector when nothing selected.
- `apps/web/app/admin/forms/[id]/_field-types/index.ts` — registry + dispatcher. `FIELD_TYPE_REGISTRY` array, `defaultConfigFor`, `getFieldModule`.
- `apps/web/app/admin/forms/[id]/_field-types/_shared/{LabeledInput,LabeledTextarea,LabeledCheckbox,LabeledSelect,KeyEditor,OptionListEditor}.tsx` — shared inspector inputs. KeyEditor sanitizes on every keystroke against `^[a-z][a-z0-9_]*$`; OptionListEditor manages `{value,label}` pairs with up/down/remove/add controls.
- 16 per-field-type modules, each with `index.ts` + `Renderer.tsx` + `Inspector.tsx`: heading, image, name, email, phone, short-text, long-text, hidden, dropdown, multi, date, time, file, signature, location, lookup. The Image inspector wires a direct browser `fetch()` against `/forms/admin/api/forms/{id}/assets`. The Lookup inspector surfaces Key field / Key column / Source table+column / Resolution mode / Null behavior dropdowns.

Total new files: 56.

### Files modified

- `apps/web/package.json` — added `@dnd-kit/core@^6.1.0`, `@dnd-kit/sortable@^8.0.0`, `nanoid@^5.0.0`.
- `pnpm-lock.yaml` — auto-update from `pnpm install` (resolved 6.3.1 / 8.0.0 / 5.1.11 + transitives).
- `PRE_DEPLOY_FORMS.md` — Section 5 gains the 18-step Brief 95 smoke test sequence + bundle-size note + form-meta latent issue callout.
- `CLAUDE.md` — forms-worker glossary entry extended with the Brief 95 paragraph (apps/web pages, useReducer state shape, dnd-kit usage, per-field-type folder convention with the 6-step recipe for adding a 17th type, action-shim pattern for client-island writes, KeyEditor regex, FormsAdminTabs / NoAccessCard sibling components, latent form-meta persistence gap, bundle size).
- `BUILD_STATE.md` — Last-updated bumped, Brief 95 paragraph appended to the findings log, prioritized work list row 95 added with status `Completed (2026-05-10)`.
- `BRIEFS/INDEX.md` — Brief 95 row appended after Brief 94.
- `BRIEFS/brief-095-forms-admin-builder-ui.md` — Status flipped to `Completed (2026-05-10)`; this Outcome section filled.

### Decisions made on operator's behalf

1. **Save Draft + Publish via server actions instead of `<ActionForm>`.** The payload (full fields array) is structured JS, easier to call `await saveDraftAction(formId, state.fields)` from the client island than to round-trip through a `<form>`. The Brief 19 ActionForm pattern is still used for the Create form flow at `/admin/forms/new` (server-rendered form, simple FormData payload, redirects on success).
2. **`@dnd-kit/utilities` is not a transitive of `@dnd-kit/core` and not pinned by `pnpm install`.** Replaced the brief sample's `CSS.Transform.toString(transform)` with an inline `transformToCss` helper that builds the same `translate3d(...)scaleX(...)scaleY(...)` string. Avoids adding a fourth `@dnd-kit/*` dep.
3. **BuilderClient imports `FormDetail` as a `import type` from worker-fetch.ts.** TypeScript erases type-only imports at compile time, so even though worker-fetch.ts uses `next/headers`, the BuilderClient bundle doesn't carry the runtime module. Save Draft + Publish go through the action-shim path; only types come from worker-fetch.
4. **Form-meta editing is CLIENT-ONLY at v1.** The FormMetaInspector renders editable inputs for title / description / audience / notify_webhook / success_message / turnstile_required, and TopBar title is editable, but `saveDraftAction` only ships `state.fields` because Brief 94's `PATCH /forms/admin/api/forms/{id}/draft` takes a `schema` body, not metadata. The FormMetaInspector flags the limitation inline ("Form-level settings can be edited here, but form metadata persistence is not wired in this brief"). Future brief should widen the admin endpoint or add a sibling `PATCH /meta` route. Surfaced as latent issue in BUILD_STATE.md and PRE_DEPLOY_FORMS.md.
5. **Image inspector uses direct browser `fetch()` not a server action.** The upload payload is a `File` object that doesn't serialize through a server action's RPC boundary cleanly. Auth ride-along via cookie; CSRF cookie protections are scoped to `splash-forms` worker via `isOriginAllowed`.
6. **`Inspector.tsx` threads `formId` through to per-field-type Inspector components.** Only the Image inspector currently uses it (for the asset upload URL) but the uniform `InspectorProps` interface keeps the contract clean; alternative was per-type custom prop shapes.
7. **Lookup inspector "eligible key fields" filter is `short_text | dropdown | location`.** Per the brief; the Lookup field can't reference itself or another lookup field. Operator must add one of those types first before configuring a lookup.
8. **PageBanner-style chrome is duplicated in each page rather than extracted.** Three call sites with slightly different headings (Forms list / Create form / per-form builder doesn't render a page-level title because TopBar replaces it). Extracting later is cheap.
9. **`getFormAdmin` returns `null` on 401/403/404.** Page handles 404 via Next.js `notFound()` and 401/403 via NoAccessCard. Matches fleet's worker-fetch helper convention from Brief 83.
10. **Slug regex on the create form mirrors Brief 94's worker-side validator** (`^[a-z][a-z0-9-]{1,63}$`). Defense in depth at the form layer; HTML5 `pattern` attribute + server-side validation in the action.
11. **`@dnd-kit/sortable` accessibility wiring is on by default.** PointerSensor with 4px activation distance keeps small-mouse-jitter from triggering drags; KeyboardSensor with `sortableKeyboardCoordinates` provides the Tab→Space→arrow→Space keyboard flow without extra code.

### Latent issues found

1. **Form-meta persistence gap** — flagged inline in FormMetaInspector + PRE_DEPLOY_FORMS.md + BUILD_STATE.md. Future brief should either widen `PATCH /forms/admin/api/forms/{id}/draft` to accept `meta?: Partial<FormMeta>` alongside `schema`, OR add a sibling `PATCH /forms/admin/api/forms/{id}/meta` endpoint. The BuilderClient's current `handleSaveDraft` only ships `state.fields`; extending it to ship `state.formMeta` is a one-line change once the worker accepts it.
2. **BuilderClient build error** — initial `pnpm --filter @splash/web build` failed with "next/headers in a client component" because BuilderClient imported `updateDraftAdmin` + `publishFormAdmin` directly from worker-fetch.ts (which uses `cookies()` and `headers()`). Resolved by introducing the `actions.ts` shim. Future client-island briefs that need to call worker-fetch helpers should follow this pattern: SSR helper → thin server action → client island calls the action.
3. **`noUncheckedIndexedAccess: true` flagged three array-element accesses** during typecheck:
   - `reducer.ts duplicate_field` — `state.fields[idx]` could be undefined; added explicit check.
   - `_shared/KeyEditor.sanitize` — `s[0]` indexed access; switched to `s[0] ?? ""`.
   - `_shared/OptionListEditor.move` — swap pattern `[a,b]=[b,a]` indexed elements were possibly undefined; explicit `if (!a || !b) return` guard added.
4. **The brief's example `BuilderClient` `Props.initial` shape** (re-typed inline) had `currentVersionNumber` + `versions` differently shaped vs the worker-fetch.ts `FormDetail` type. Used the actual `FormDetail` type from worker-fetch.ts so there's a single source of truth — Brief 94's helper is the canonical contract.
5. **FormsAdminTabs sub-tabs Submissions / Versions link to routes that don't exist yet.** Brief 96 lands Submissions and Brief 98 lands Versions content. Clicking them today 404s. Flagged in the operator-level smoke test (PRE_DEPLOY_FORMS.md Section 5 step 1 instruction is implicit; explicit smoke test for the sub-tabs deferred to Brief 96).
6. **`@dnd-kit/utilities` is omitted intentionally** — see Decision 2. If a future brief needs additional `dnd-kit` features that come from utilities (rect intersection helpers, etc.), add the dep then; for now the inline transform helper is enough.
7. **Image dimensions (width/height) deferred to v2** per Brief 94. Builder-side Image inspector doesn't capture them either; the asset row stores width/height as null. Browser `<img>` probe-then-upload is a viable v2 add for cleaner asset metadata.

### Validation results

- `pnpm install` — added `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@8.0.0`, `nanoid@5.1.11` plus 2 transitives. Done in 3s.
- `pnpm --filter @splash/web typecheck` — green.
- `pnpm --filter @splash/web build` — green. Next.js 15.5.15, 14 routes generated. Route-specific bundle sizes:
  - `/admin/forms` — 714 B / First-Load 106 kB.
  - `/admin/forms/new` — 1.1 kB / First-Load 106 kB.
  - `/admin/forms/[id]` — 25.8 kB / First-Load 131 kB. **Comfortably under the 150 kB target flagged in the brief Report.** The 25.8 kB chunk includes dnd-kit + reducer + 16 Inspector components + 16 Renderer components + the BuilderClient orchestration; if this grows past 150 kB in future briefs, candidate optimizations are dynamic-import-on-demand for the Inspector components or splitting the registry into per-type dynamic chunks.
- `pnpm typecheck` (root) — 17/17 green (16 cache hits, only `@splash/web` cache-missed and re-ran cleanly).

Smoke tests deferred to operator post-deploy — see PRE_DEPLOY_FORMS.md Section 5 "Brief 95 — admin builder UI" for the 18-step sequence.

### Report bullets (per brief Report section)

- **Bundle size impact.** `/admin/forms/[id]` First-Load JS = **131 kB** (route-specific 25.8 kB). Under the 150 kB caution threshold; over-import-likely flag was 200 kB which we're well below.
- **dnd-kit accessibility.** Confirmed: `KeyboardSensor` with `sortableKeyboardCoordinates` is wired into the `useSensors` array in BuilderClient. Tab to focus a card's drag handle, Space to lift, ↑/↓ to move, Space to drop. PointerSensor `activationConstraint: { distance: 4 }` prevents accidental drag from small mouse movements.
- **`nanoid` import shape.** ESM-only in v5 (`import { nanoid } from "nanoid"`). Verified building cleanly under Next.js 15.5.15 with apps/web's webpack bundler.
- **Per-field-type folder count.** 16 type modules + 6 `_shared/` helpers + 1 `index.ts` registry. Matches the brief's spec (heading, image, name, email, phone, short-text, long-text, hidden, dropdown, multi, date, time, file, signature, location, lookup).
- **KeyEditor regex.** Final regex matches the brief spec verbatim: `^[a-z][a-z0-9_]*$`. Sanitization strips invalid chars on every keystroke; if the resulting key is invalid (empty / wrong first char) the input border turns red and the inline message surfaces the regex.
- **Validation results.** `pnpm install`, `pnpm --filter @splash/web typecheck`, `pnpm --filter @splash/web build`, root `pnpm typecheck` all green. See above for details.
