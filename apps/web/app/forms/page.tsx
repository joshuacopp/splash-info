// /forms — credentialed-user index of internal forms they can fill in
// (Brief 99). Pairs with the /forms/{slug} public render path served by
// splash-forms worker (Brief 90). Auth gate is the cookie middleware
// (apps/web/middleware.ts, extended in Brief 99). Per-form audience
// gating happens at click-through on the worker side.

import Link from "next/link";
import { getVisibleForms, type VisibleForm } from "./_lib/worker-fetch";

export const dynamic = "force-dynamic";

export default async function FormsIndexPage() {
  const forms = await getVisibleForms();

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-2xl font-bold text-splash-navy">Forms</h1>
      <p className="mb-6 text-sm text-gray-600">
        Forms available for you to fill in. Tap one to open it.
      </p>

      {forms.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {forms.map((f) => (
            <FormCard key={f.slug} form={f} />
          ))}
        </ul>
      )}
    </main>
  );
}

function FormCard({ form }: { form: VisibleForm }) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow">
      <Link href={`/forms/${form.slug}`} className="block">
        <div className="mb-1 flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold text-splash-navy">
            {form.title}
          </h2>
          <AudienceBadge audience={form.audience} />
        </div>
        {form.description ? (
          <p className="text-sm text-gray-600">{form.description}</p>
        ) : null}
        <p className="mt-3 text-xs font-medium text-splash-blue">Open →</p>
      </Link>
    </li>
  );
}

function AudienceBadge({ audience }: { audience: VisibleForm["audience"] }) {
  // v1 only renders "internal" badges (the endpoint filters to internal),
  // but the badge logic handles all three audiences for forward compat
  // with option 3 (which surfaces link-only forms on the index too).
  const label =
    audience === "public"
      ? "Public"
      : audience === "internal"
        ? "Internal"
        : "Link-only";
  const cls =
    audience === "public"
      ? "bg-green-50 text-green-700 ring-green-200"
      : audience === "internal"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : "bg-gray-100 text-gray-700 ring-gray-300";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
      <p className="text-sm text-gray-600">
        No forms are available to you right now.
      </p>
      <p className="mt-2 text-xs text-gray-500">
        If you&apos;re expecting one, check the link your team shared, or
        contact an admin.
      </p>
    </div>
  );
}
