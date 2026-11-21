// /admin/giveaways/{id} -- one giveaway: its tablet link, settings, entries
// and CSV. Same access as the list (admin tier or the `giveaways` grant);
// the worker decides.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { archiveGiveawayAction, newLinkAction, saveGiveawayAction } from "../actions";
import { ConfirmButton, EntriesTable, GiveawayLink } from "../_components/ClientBits";
import { SettingsForm } from "../_components/SettingsForm";
import { STATE_PILL, datesText } from "../_lib/format";
import { getGiveaway } from "../_lib/worker-fetch";

export const dynamic = "force-dynamic";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";
const BTN =
  "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60";
const GHOST =
  "rounded-splash-sm border border-splash-blue px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5 disabled:opacity-60";

export default async function GiveawayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await getGiveaway(id);
  if (!("data" in res)) {
    if (res.status === 404) notFound();
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className={CARD}>
          <h1 className="text-xl font-bold text-splash-navy">Giveaway</h1>
          <p className="mt-2 text-sm text-splash-navy/70">
            {res.status === 403 ? res.error ?? "You don't have access to giveaways." : "This page couldn't be loaded. Try again in a minute."}
          </p>
        </div>
      </main>
    );
  }
  const { giveaway: g, entries, entries_capped } = res.data;
  const pill = STATE_PILL[g.state];
  const archived = !!g.archived_at;

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <div>
        <Link href="/admin/giveaways" className="text-sm font-semibold text-splash-blue hover:underline">
          ← All giveaways
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-bold text-splash-navy">{g.title}</h1>
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${pill.cls}`}>{pill.label}</span>
        </div>
        <p className="mt-1 text-sm text-splash-navy/70">
          {datesText(g)} · {g.entry_count.toLocaleString("en-US")} {g.entry_count === 1 ? "entry" : "entries"} ·{" "}
          {g.sms_count.toLocaleString("en-US")} OK to text
        </p>
      </div>

      <section className={CARD}>
        <h2 className="mb-3 text-lg font-bold text-splash-navy">Tablet link</h2>
        <GiveawayLink path={g.link_path} />
        <p className="mt-3 text-xs text-splash-navy/60">
          Anyone with the link can enter, so keep it on the tablets. If it gets out, make a new link: the old one stops working.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionForm action={newLinkAction} resetOnSuccess={false}>
            <input type="hidden" name="id" value={g.id} />
            <ConfirmButton
              label="Make a new link"
              pendingLabel="Making…"
              confirmText="Make a new link? The current link stops working at once, on every tablet."
              className={GHOST}
            />
          </ActionForm>
          <ActionForm action={archiveGiveawayAction} resetOnSuccess={false}>
            <input type="hidden" name="id" value={g.id} />
            <input type="hidden" name="archived" value={archived ? "0" : "1"} />
            {archived ? (
              <SubmitButton className={GHOST} pendingText="Reopening…">
                Reopen giveaway
              </SubmitButton>
            ) : (
              <ConfirmButton
                label="End giveaway now"
                pendingLabel="Ending…"
                confirmText="End this giveaway now? The tablet page will say it has ended. Entries are kept."
                className={GHOST}
              />
            )}
          </ActionForm>
        </div>
      </section>

      <section className={CARD}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-splash-navy">Entries</h2>
          {entries.length > 0 && (
            <a href={`/admin/giveaways/${g.id}/export.csv`} download className={GHOST}>
              Download CSV
            </a>
          )}
        </div>
        {entries_capped && (
          <p className="mb-3 rounded-splash-sm bg-splash-warn/15 p-3 text-sm text-splash-navy">
            Showing the newest {entries.length.toLocaleString("en-US")} entries only.
          </p>
        )}
        <EntriesTable giveawayId={g.id} rows={entries} />
      </section>

      <details className={CARD}>
        <summary className="cursor-pointer text-lg font-bold text-splash-navy">Settings</summary>
        <p className="mt-2 text-xs text-splash-navy/60">
          Changes show on the tablets at once. Entries already taken keep what they had.
          {g.updated_by_email && ` Last changed by ${g.updated_by_email}.`}
        </p>
        <ActionForm action={saveGiveawayAction} resetOnSuccess={false} className="mt-4 space-y-5">
          <input type="hidden" name="id" value={g.id} />
          <SettingsForm v={g} />
          <SubmitButton className={BTN} pendingText="Saving…">
            Save settings
          </SubmitButton>
        </ActionForm>
      </details>
    </main>
  );
}
