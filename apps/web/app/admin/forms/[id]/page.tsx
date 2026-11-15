// Brief 95 — Form builder page (/admin/forms/[id]).
//
// Server component that fetches form detail + lookup-source registry, then
// mounts the client builder island. The client island owns canvas state,
// drag-and-drop, and the Save Draft / Publish actions.

import { notFound } from "next/navigation";
import Link from "next/link";

import { getMe } from "../../../_lib/me";
import { getFormAdmin, getLookupSourcesAdmin } from "../_lib/worker-fetch";
import FormsAdminTabs from "../_components/FormsAdminTabs";
import NoAccessCard from "../_components/NoAccessCard";
import BuilderClient from "./_builder/BuilderClient";
import DigestsPanel from "./_digests/DigestsPanel";
import { listDigestsAction } from "./_digests/actions";
import FormBuilderTabs, {
  type BuilderTab
} from "./_components/FormBuilderTabs";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}

function resolveTab(raw: string | undefined): BuilderTab {
  if (raw === "workflow" || raw === "settings" || raw === "digests") return raw;
  return "fields";
}

export default async function FormBuilderPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const activeTab = resolveTab(sp.tab);

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/forms/${encodeURIComponent(id)}`}
      />
    );
  }
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  const detail = await getFormAdmin(id);
  if (!detail) {
    notFound();
  }
  const lookupSourcesResp = await getLookupSourcesAdmin();
  const lookupSources = lookupSourcesResp?.sources ?? [];

  return (
    <section className="mx-auto w-full max-w-[1400px] px-4 py-5">
      <div className="mb-2 text-sm">
        <Link href="/admin/forms" className="text-splash-blue hover:underline">
          ← All forms
        </Link>
      </div>

      <FormsAdminTabs formId={id} />

      <FormBuilderTabs formId={id} active={activeTab} />

      {activeTab === "digests" ? (
        <DigestsTab formId={id} fields={detail.draftSchema.fields} />
      ) : (
      <BuilderClient
        initial={detail}
        lookupSources={lookupSources}
        formId={id}
        accessTag={detail.accessTag ?? null}
        activeTab={activeTab}
        myEmail={session.email ?? null}
      />
      )}
    </section>
  );
}

// Digests is not part of the builder's draft/publish state, so it renders on
// its own rather than inside BuilderClient.
async function DigestsTab({ formId, fields }: { formId: string; fields: import("@splash/forms-schema").Field[] }) {
  const r = await listDigestsAction(formId);
  if (!r.ok) {
    return <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">Couldn't load digests: {r.error}</p>;
  }
  return <DigestsPanel formId={formId} fields={fields} initialDigests={r.data} />;
}
