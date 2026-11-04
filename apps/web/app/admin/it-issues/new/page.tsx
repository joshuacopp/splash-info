import Link from "next/link";
import { getMe } from "../../../_lib/me";
import NoAccessCard from "../../forms/_components/NoAccessCard";
import { listIssues } from "../_lib/worker-fetch";
import NewIssueForm from "./NewIssueForm";

export const dynamic = "force-dynamic";

export default async function NewItIssuePage() {
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/it-issues/new" />;

  // The caller's open issues, so the form can say "this is already open --
  // log another occurrence instead" before a duplicate is created.
  const data = await listIssues(new URLSearchParams({ status: "open" }));

  return (
    <section className="mx-auto w-full max-w-[760px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/it-issues" className="text-splash-blue hover:underline">
          ← IT Issues
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold text-splash-navy">Report an IT issue</h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        Critical problems (can&apos;t take payments, wash down) still need a call or email to IT right away - after
        saving, use <strong>Send to IT support now</strong> on the issue.
      </p>
      {!data ? (
        <p className="rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Could not load your sites. Try again in a moment.
        </p>
      ) : data.sites.length === 0 ? (
        <p className="rounded-splash-md border border-gray-light bg-white px-3 py-6 text-center text-splash-navy/70">
          Your login isn&apos;t linked to any site. Ask a super admin to add your email to your site.
        </p>
      ) : (
        <NewIssueForm sites={data.sites} devices={data.devices} openIssues={data.issues} />
      )}
    </section>
  );
}
