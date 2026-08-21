// Maintenance labor rate (/admin/expenses/labor-rate).
//
// The one number behind every hourly expense entry: what an hour of a
// mechanic's time costs the site it was billed to. Josh, 2026-08-21 — "the rate
// per hour should be settable by admin", and when asked per-site or global,
// "as a whole. not on a per site basis".
//
// SUPER ADMIN ONLY. This is a stricter test than the rest of /admin/expenses,
// which admits anyone with the "pertrack" grant and scopes their rows to their
// sites. There is no scoping to do here — one rate applies to all forty-odd
// locations, so the person changing it is changing every site's numbers at
// once. The gate that ENFORCES this is the worker's (apiCreateLaborRate 403s);
// the check below decides whether to render the form at all.
//
//
// A HISTORY, NOT A SETTING. The obvious shape for this screen is a text box
// with the current rate in it and a Save button. That shape is wrong here, and
// the reason is in the entries table on the previous page: every hourly entry
// stores the rate it was priced at, and the point of storing it is that a raise
// in November must not restate August. A settings box has nowhere to put "was
// $65 until March 1st", so the rate is a ROW PER EFFECTIVE DATE and this page
// shows all of them.
//
// Which one applies to a given entry is decided by that entry's PURCHASE DATE,
// not by which row is newest and not by when the rate was entered. That is why
// the table below labels three states rather than bolding one:
//
//   In force     the row a purchase dated TODAY would be priced at.
//   Scheduled    effective_from is in the future. Real, saved, not yet applying.
//   Superseded   a later row has taken over. Still explains old entries.
//
// NOTHING ON THIS PAGE EDITS OR DELETES A ROW, and nothing should be added that
// does. See actions.ts.
//
//
// BACKDATING IS SUPPORTED AND DOES NOT MOVE ANY EXISTING TOTAL. Setting a rate
// effective from a past date changes what a NEW entry dated in that window
// costs; entries already logged keep the amount they were priced at. The copy
// on the form says this out loud because the natural expectation — "I corrected
// the rate, so the month should re-total" — is the wrong one, and finding out
// by watching the numbers not move is a bad way to learn it.

import Link from "next/link";
import type { ExpenseLaborRateRow } from "@splash/types/expense";
import { performanceGetJson } from "../../performance/_lib/worker-fetch";
import { RedirectForm } from "../../_components/RedirectForm";
import { SavingButton } from "../../greeters/_components/SavingButton";
import { firstParam, localDay } from "../_lib/format";
import {
  BTN_CLS,
  Card,
  EmptyNote,
  HINT_CLS,
  INPUT_CLS,
  LABEL_CLS,
  TBODY_CLS,
  THEAD_CLS,
  TableWrap
} from "../_lib/ui";
import { getMe } from "../../../_lib/me";
import { setLaborRateAction } from "./actions";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** "$72.50". Always positive — the rate is CHECKed strictly positive — so none
 *  of the sign conventions in ../_lib/format apply and neither is imported. */
function perHour(value: number): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/**
 * "2026-08-21" -> "Aug 21, 2026".
 *
 * WITH THE YEAR, unlike entryDayLabel in ../_lib/format, which drops it because
 * the entry table always sits under a month heading. This list spans years by
 * design — a two-year-old rate is exactly what explains a two-year-old entry —
 * and a bare "Mar 1" in that context is ambiguous in the worst possible way.
 *
 * Parsed at UTC noon so the label can't slip a day in either direction.
 */
function dayLabel(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(d);
}

/**
 * The id of the row in force TODAY, per mechanic track.
 *
 * PER TRACK, keyed on `mechanic_key ?? ""`, even though v1 only ever writes the
 * company-wide row. The database resolves a mechanic-specific rate ahead of the
 * company-wide one for the same date, so if a per-mechanic row ever lands, a
 * single global "newest wins" answer here would label the wrong row as current
 * and this page's whole job is being right about which row applies.
 *
 * Compared as STRINGS. ISO dates sort lexicographically and building a Date per
 * row to compare them would drag the timezone back into a question that has
 * nothing to do with time of day.
 */
function inForceIds(rows: ExpenseLaborRateRow[], today: string): Set<string> {
  const best = new Map<string, ExpenseLaborRateRow>();
  for (const r of rows) {
    if (r.effective_from > today) continue;
    const track = r.mechanic_key ?? "";
    const current = best.get(track);
    if (!current || r.effective_from > current.effective_from) {
      best.set(track, r);
    }
  }
  return new Set([...best.values()].map((r) => r.id));
}

export default async function LaborRatePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const actionError = firstParam(sp.action_error).trim() || null;
  const saved = firstParam(sp.success).trim() === "rate";

  // Read BEFORE the fetch: a non-super-admin gets the no-access card without a
  // worker round trip, and the GET is not gated to super admins anyway (anyone
  // entering hours has to be able to see what they cost), so it would answer
  // and tell us nothing about whether the form should render.
  const me = await getMe().catch(() => null);
  if (me?.role !== "super_admin") {
    return (
      <section className="mx-auto w-full max-w-[840px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-2 text-splash-deny">
            Only a super admin can change the maintenance labor rate.
          </p>
          <p className="mb-4 text-sm text-splash-navy/70">
            One rate applies to every site, so changing it changes every
            location&rsquo;s numbers at once. You can still log labor hours from
            the expense log — the rate is applied for you when the entry saves.
          </p>
          <Link href="/admin/expenses" className={BTN_CLS}>
            Back to the expense log
          </Link>
        </div>
      </section>
    );
  }

  let ratesRes: { rates: ExpenseLaborRateRow[] } | null = null;
  let fetchError: string | null = null;
  try {
    ratesRes = await performanceGetJson<{ rates: ExpenseLaborRateRow[] }>(
      "/pertrack/api/expenses/labor-rates"
    );
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading the rate history.";
  }

  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[840px] px-5 py-9">
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load the rate history
          </h2>
          <p className="text-sm text-splash-navy/80">{fetchError}</p>
          {/* No form below it. Setting a rate without seeing what is already
              there is how a duplicate effective date gets attempted, and worse,
              how somebody sets a rate that a scheduled row already supersedes. */}
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry. The form is hidden until the existing
            rates can be read.
          </p>
        </div>
      </section>
    );
  }

  // Null here would be a 401/403, which the role check above has already ruled
  // out for anything but an expired session mid-render. Empty is the real and
  // expected first-run state: nobody has set a rate yet.
  const rates = ratesRes?.rates ?? [];
  const today = localDay(Date.now());
  const inForce = inForceIds(rates, today);
  // The Mechanic column only appears once something WRITES a mechanic-specific
  // row. Nothing does in v1, so rendering it now would be a column of "Everyone"
  // forty rows deep explaining a distinction that doesn't exist yet — and the
  // day it does exist, the column arrives on its own.
  const anyMechanic = rates.some((r) => r.mechanic_key !== null);

  return (
    <section className="mx-auto w-full max-w-[840px] px-5 py-9">
      {actionError ? (
        <div
          role="alert"
          className="mb-5 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 p-4 text-sm text-splash-deny"
        >
          <span className="font-bold">Could not set the rate: </span>
          {actionError}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          className="mb-5 rounded-splash-md border border-splash-success/40 bg-splash-success/10 p-4 text-sm font-bold text-splash-success"
        >
          Rate saved. Entries already logged keep the rate they were priced at.
        </div>
      ) : null}

      <PageBanner />

      <Card
        title="Set a new rate"
        subtitle="Rates are superseded, never edited. Setting one here leaves every entry already logged exactly as it was priced."
      >
        <RedirectForm
          action={setLaborRateAction}
          className="flex flex-col gap-4 px-5 py-5"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Effective from</span>
              <input
                type="date"
                name="effective_from"
                required
                defaultValue={today}
                className={INPUT_CLS}
              />
              <span className={HINT_CLS}>
                Matched against the entry&rsquo;s purchase date, not the date it
                was typed in. A past date is allowed and prices future entries
                dated into that window.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Rate per hour</span>
              <input
                type="number"
                name="rate_per_hour"
                required
                step="0.01"
                min="0.01"
                inputMode="decimal"
                placeholder="65.00"
                className={INPUT_CLS}
              />
              <span className={HINT_CLS}>
                Dollars per hour, company-wide. Hours entered against a
                maintenance labor category are multiplied by this and filed
                under Repairs · Equipment Repair.
              </span>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className={LABEL_CLS}>Note (optional)</span>
            <input
              type="text"
              name="note"
              placeholder="2026 shop rate, approved 8/18"
              className={INPUT_CLS}
            />
            <span className={HINT_CLS}>
              Why the rate changed. It stays on the row next to who set it — the
              only explanation anyone will have for a rate two years from now.
            </span>
          </label>

          {/* The three things people get wrong about this form, stated before
              they submit rather than after. The duplicate-date rule in
              particular comes back from the worker as a 409, and a rejection is
              a worse place to learn it than a paragraph. */}
          <div className="rounded-splash-sm border border-gray-light bg-splash-navy/5 p-4 text-xs leading-relaxed text-splash-navy/70">
            <p className="mb-1">
              <span className="font-semibold text-splash-navy/80">
                Existing entries do not change.
              </span>{" "}
              Each one stores the rate it was priced at, which is what lets an
              amount from months ago still be explained.
            </p>
            <p className="mb-1">
              <span className="font-semibold text-splash-navy/80">
                One rate per effective date.
              </span>{" "}
              If a rate already starts on the date you pick, the save is
              rejected — set the new one from a later date instead.
            </p>
            <p>
              <span className="font-semibold text-splash-navy/80">
                A future date is a schedule.
              </span>{" "}
              It saves now and starts applying on that date, with the current
              rate carrying on until then.
            </p>
          </div>

          <div>
            <SavingButton>Set rate</SavingButton>
          </div>
        </RedirectForm>
      </Card>

      <Card
        title="Rate history"
        subtitle="Newest first. Every rate ever set, because each one is the explanation for the entries priced under it."
      >
        {rates.length === 0 ? (
          <EmptyNote>
            No rate has been set yet. Maintenance labor cannot be logged until
            one is — the entry is refused rather than priced at zero.
          </EmptyNote>
        ) : (
          <TableWrap>
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-4 py-3">Effective from</th>
                <th className="px-4 py-3 text-right">Rate</th>
                {anyMechanic ? <th className="px-4 py-3">Mechanic</th> : null}
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Note</th>
                <th className="px-4 py-3">Set by</th>
              </tr>
            </thead>
            <tbody className={TBODY_CLS}>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-splash-navy/80">
                    {dayLabel(r.effective_from)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold">
                    {perHour(r.rate_per_hour)}
                    <span className="font-normal text-splash-navy/60">/hr</span>
                  </td>
                  {anyMechanic ? (
                    <td className="whitespace-nowrap px-4 py-3 text-splash-navy/80">
                      {r.mechanic_key ?? (
                        <span
                          className="text-splash-navy/50"
                          title="Applies to every mechanic. A mechanic-specific rate for the same date takes precedence over this one."
                        >
                          Everyone
                        </span>
                      )}
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-4 py-3">
                    <StatusBadge
                      row={r}
                      today={today}
                      current={inForce.has(r.id)}
                    />
                  </td>
                  <td className="px-4 py-3 text-splash-navy/80">
                    {r.note || "—"}
                  </td>
                  {/* Email and not the user id: this is an audit column somebody
                      reads, and a uuid answers "who set this" with a question. */}
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-splash-navy/60">
                    {r.created_by_email}
                    <div className="text-splash-navy/45">
                      {dayLabel(r.created_at.slice(0, 10))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </section>
  );
}

/**
 * In force / Scheduled / Superseded.
 *
 * Three states and not a bolded "current" row, because the two non-current ones
 * mean opposite things and both get read as "old". A scheduled rate has not
 * applied to anything yet; a superseded one is still the correct explanation
 * for every entry dated inside its window.
 *
 * `current` is computed once for the whole table rather than per row — see
 * inForceIds. Passing it in keeps this component from re-deriving an answer
 * that has to match the database's.
 */
function StatusBadge({
  row,
  today,
  current
}: {
  row: ExpenseLaborRateRow;
  today: string;
  current: boolean;
}) {
  if (current) {
    return (
      <span
        className="rounded-full bg-splash-success/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-success"
        title="An entry purchased today would be priced at this rate."
      >
        In force
      </span>
    );
  }
  if (row.effective_from > today) {
    return (
      <span
        className="rounded-full bg-splash-blue/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-blue"
        title={`Starts applying on ${dayLabel(row.effective_from)}. The rate in force carries on until then.`}
      >
        Scheduled
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-splash-navy/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-navy/60"
      title="A later rate has taken over. This one still explains the entries priced under it and is never removed."
    >
      Superseded
    </span>
  );
}

function PageBanner() {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">
          Maintenance Labor Rate
        </h1>
      </div>
      <Link
        href="/admin/expenses"
        className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
      >
        ← Expense log
      </Link>
    </div>
  );
}
