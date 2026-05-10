// Brief 95 — Create new form page (/admin/forms/new).
//
// Server component with a small <ActionForm> wrapping the create-form
// server action. On success the action redirects to the builder; on
// failure the inline ActionForm error renders.

import Link from "next/link";

import { getMe } from "../../../_lib/me";
import { ActionForm } from "../../_components/ActionForm";
import FormsAdminTabs from "../_components/FormsAdminTabs";
import NoAccessCard from "../_components/NoAccessCard";
import { createFormAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function NewFormPage() {
  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/forms/new" />;
  }
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  return (
    <section className="mx-auto w-full max-w-[640px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/forms" className="text-splash-blue hover:underline">
          ← All forms
        </Link>
      </div>

      <FormsAdminTabs />

      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Create form</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Pick a slug, title, and audience. You&rsquo;ll add fields next.
        </p>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        <ActionForm
          action={createFormAction}
          resetOnSuccess={false}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-sm font-semibold text-splash-navy">
              Slug
              <span aria-hidden className="ml-0.5 text-racecar-red">*</span>
            </label>
            <input
              type="text"
              name="slug"
              required
              pattern="^[a-z][a-z0-9-]{1,63}$"
              placeholder="e.g. customer-feedback-2026"
              className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy"
            />
            <p className="mt-1 text-xs text-splash-navy/60">
              Public URL is <code>/forms/&lt;slug&gt;</code>. Lowercase letters,
              digits, hyphens; must start with a letter; 2–64 chars.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-splash-navy">
              Title
              <span aria-hidden className="ml-0.5 text-racecar-red">*</span>
            </label>
            <input
              type="text"
              name="title"
              required
              placeholder="Customer Feedback — Q1 2026"
              className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-splash-navy">
              Description
            </label>
            <textarea
              name="description"
              rows={3}
              placeholder="Optional. Shown above the form to respondents."
              className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-splash-navy">
              Audience
              <span aria-hidden className="ml-0.5 text-racecar-red">*</span>
            </label>
            <select
              name="audience"
              required
              defaultValue="internal"
              className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy"
            >
              <option value="public">Public — anyone with the link</option>
              <option value="internal">Internal — signed-in operators only</option>
              <option value="link-only">Link-only — slug acts as the gate</option>
            </select>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Create form
            </button>
            <Link
              href="/admin/forms"
              className="text-sm text-splash-navy/70 hover:underline"
            >
              Cancel
            </Link>
          </div>
        </ActionForm>
      </div>
    </section>
  );
}
