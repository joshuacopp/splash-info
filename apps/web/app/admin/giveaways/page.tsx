// /admin/giveaways -- set up giveaway contests that customers enter on the
// site tablet, without the form builder. Each giveaway turns a fixed set of
// fields (name, email, phone, license plate, barcode) Off / Optional /
// Required and gets its own no-sign-in link.
//
// ACCESS: admin tier, or anyone holding the `giveaways` access grant
// (Sysadmin -> the user -> Access). The worker decides; this page renders what
// it is given. Data: supabase/giveaways-01.sql. API:
// apps/forms-worker/src/giveaways/.

import Link from "next/link";
import { ActionForm } from "../_components/ActionForm";
import { SubmitButton } from "../_components/SubmitButton";
import { GIVEAWAY_FIELD_DEFAULT_LABEL, GIVEAWAY_FIELD_KEYS } from "@splash/forms-schema/giveaway";
import { createGiveawayAction } from "./actions";
import { NEW_GIVEAWAY, SettingsForm } from "./_components/SettingsForm";
import { listGiveaways, type GiveawaySummary } from "./_lib/worker-fetch";
import { STATE_PILL, datesText } from "./_lib/format";

export const dynamic = "force-dynamic";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";
const BTN =
  "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60";

function fieldsText(g: GiveawaySummary): string {
  const on = GIVEAWAY_FIELD_KEYS.filter((k) => g.fields[k].mode !== "off").map(
    (k) => `${g.fields[k].label || GIVEAWAY_FIELD_DEFAULT_LABEL[k]}${g.fields[k].mode === "optional" ? " (optional)" : ""}`
  );
  return on.join(", ");
}

export default async function GiveawaysPage() {
  const res = await listGiveaways();
  if (!("data" in res)) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className={CARD}>
          <h1 className="text-xl font-bold text-splash-navy">Giveaways</h1>
          <p className="mt-2 text-sm text-splash-navy/70">
            {res.status === 403
              ? res.error ?? "You don't have access to giveaways."
              : res.status === 401
                ? "Sign in again to manage giveaways."
                : "This page couldn't be loaded. Try again in a minute."}
          </p>
        </div>
      </main>
    );
  }
  const { giveaways } = res.data;
  const current = giveaways.filter((g) => g.state === "open" || g.state === "not_started");
  const past = giveaways.filter((g) => g.state === "ended" || g.state === "archived");

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold text-splash-navy">Giveaways</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Contests customers enter on the site tablet. Each giveaway gets its own link; choose which details to collect.
        </p>
      </div>

      <section className="space-y-3">
        {current.length === 0 && <p className="text-sm text-splash-navy/60">No giveaways running. Create one below.</p>}
        {current.map((g) => (
          <GiveawayCard key={g.id} g={g} />
        ))}
      </section>

      <details className={CARD} open={giveaways.length === 0}>
        <summary className="cursor-pointer text-lg font-bold text-splash-navy">+ New giveaway</summary>
        <ActionForm action={createGiveawayAction} resetOnSuccess={false} className="mt-4 space-y-5">
          <SettingsForm v={NEW_GIVEAWAY} />
          <SubmitButton className={BTN} pendingText="Creating…">
            Create giveaway
          </SubmitButton>
        </ActionForm>
      </details>

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold text-splash-navy">Past giveaways</h2>
          {past.map((g) => (
            <GiveawayCard key={g.id} g={g} />
          ))}
        </section>
      )}
    </main>
  );
}

function GiveawayCard({ g }: { g: GiveawaySummary }) {
  const pill = STATE_PILL[g.state];
  return (
    <Link href={`/admin/giveaways/${g.id}`} className={`${CARD} block transition hover:shadow-splash-card-hover`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold text-splash-navy">{g.title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${pill.cls}`}>{pill.label}</span>
      </div>
      <p className="mt-1 text-sm text-splash-navy/70">
        {datesText(g)} · Collects {fieldsText(g) || "nothing"}
      </p>
      <p className="mt-2 text-sm font-semibold text-splash-navy">
        {g.entry_count.toLocaleString("en-US")} {g.entry_count === 1 ? "entry" : "entries"}
        {g.sms_count > 0 && <span className="font-normal text-splash-navy/70"> · {g.sms_count.toLocaleString("en-US")} OK to text</span>}
      </p>
    </Link>
  );
}
