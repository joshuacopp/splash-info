// /admin/site-status — which sites are closed right now, and why.
//
// Anyone signed in can see the board. The site's RD or RM (or admin tier) can
// close it, mark it open, change the estimate and log equipment down; the
// worker enforces that (apps/forms-worker/src/site-status/). Sites mark
// themselves open through the company-wide link shown below to the people
// who run sites.
//
// Data: supabase/site-status-01.sql. Reports: ./reports.

import Link from "next/link";
import { ActionForm } from "../_components/ActionForm";
import { SubmitButton } from "../_components/SubmitButton";
import { BoardClient } from "./_components/BoardClient";
import { SiteStatusTabs } from "./_components/SiteStatusTabs";
import { settingsAction } from "./actions";
import { getBoard } from "./_lib/worker-fetch";

export const dynamic = "force-dynamic";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";
const INPUT =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none";

export default async function SiteStatusPage() {
  const res = await getBoard();
  if (!("data" in res)) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className={CARD}>
          {res.status === 401 ? (
            <p>
              Please <Link href="/login?next=/admin/site-status" className="text-splash-blue underline">sign in</Link> to see site status.
            </p>
          ) : (
            <p>Couldn&apos;t load site status ({res.status}). Try again in a minute.</p>
          )}
        </div>
      </main>
    );
  }
  const board = res.data;

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-splash-navy">Site Status</h1>
        <p className="text-sm text-splash-navy/70">Closed sites first. Updates every minute.</p>
      </div>
      <SiteStatusTabs active="board" />

      {board.test_email_to ? (
        <div className="rounded-splash-sm border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Test mode:</strong> every site status email goes only to {board.test_email_to}.
          {board.is_admin ? " Clear the address below to go live." : ""}
        </div>
      ) : null}

      <BoardClient board={board} />

      {board.open_link ? (
        <details className={CARD}>
          <summary className="cursor-pointer text-sm font-bold text-splash-navy">Link for sites to mark themselves open</summary>
          <div className="mt-3 space-y-3 text-sm text-splash-navy">
            <p>
              One link for every site. Staff enter their site number, then can mark the site open or log / clear equipment that is down. They
              can&apos;t close a site with it. It is also in every closure email the site receives.
            </p>
            <input readOnly value={board.open_link} className={`${INPUT} font-mono text-xs`} />
            {board.is_admin ? (
              <ActionForm action={settingsAction}>
                <input type="hidden" name="rotate_link" value="1" />
                <SubmitButton
                  className="rounded-splash-sm border border-splash-deny/40 px-3 py-1.5 text-xs font-bold text-splash-deny hover:bg-splash-deny/10"
                  pendingText="Making new link…"
                >
                  Make a new link (the old one stops working)
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        </details>
      ) : null}

      {board.is_admin ? (
        <details className={CARD}>
          <summary className="cursor-pointer text-sm font-bold text-splash-navy">Test mode</summary>
          <ActionForm action={settingsAction} resetOnSuccess={false} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block min-w-[260px] flex-1">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                Send every email only to (leave blank to go live)
              </span>
              <input name="test_email_to" type="email" defaultValue={board.test_email_to ?? ""} className={INPUT} />
            </label>
            <SubmitButton
              className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
              pendingText="Saving…"
            >
              Save
            </SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </main>
  );
}
