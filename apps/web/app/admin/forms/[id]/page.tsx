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

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FormBuilderPage({ params }: PageProps) {
  const { id } = await params;

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

      <BuilderClient
        initial={detail}
        lookupSources={lookupSources}
        formId={id}
      />
    </section>
  );
}
