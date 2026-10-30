// /admin/golden-ticket — CRD work queue for Golden Ticket free-unlimited wins.
//
// A site employee fills out JotForm 262925137546968 when a scratched ticket
// wins free unlimited washing. The jotform-worker ingests it; this page is
// where CRD finishes the member's account in Micrologic and adds the KPI tag
// (GT30 / GT365 / GTLIFE). Each win carries a status, two checkboxes and a
// history of who changed what, with notes.
//
// ACCESS: admin tier, or anyone holding the `golden_ticket` form access tag
// (Sysadmin -> the user -> Tools). The worker decides; this page only renders
// what it is given. Admins also manage promos (date ranges) and the no-login
// site lookup link.
//
// Data: supabase/golden-ticket-01.sql. API: apps/jotform-worker/src/golden-ticket/.

import Link from "next/link";
import { ActionForm } from "../_components/ActionForm";
import { SubmitButton } from "../_components/SubmitButton";
import { assetProxyUrl } from "../jotform/_lib/worker-fetch";
import { formatEst } from "../jotform/_lib/format-est";
import { ConfirmButton, LookupLink } from "./_components/ClientBits";
import {
  deletePromoAction,
  lookupLinkAction,
  savePromoAction,
  updateWinAction
} from "./actions";
import {
  getWins,
  type GoldenTicketPromo,
  type GoldenTicketWin,
  type RosterLocation,
  type WinStatus,
  type WinsResponse
} from "./_lib/worker-fetch";

const PATH = "/admin/golden-ticket";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";
const LABEL = "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const BTN =
  "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60";
const BTN_OUTLINE =
  "rounded-splash-sm border border-splash-blue px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5 disabled:opacity-60";
const BTN_DANGER =
  "rounded-splash-sm border border-splash-deny/40 px-3 py-1.5 text-xs font-bold text-splash-deny hover:bg-splash-deny/10 disabled:opacity-60";

const STATUS_LABEL: Record<WinStatus, string> = {
  new: "New",
  in_progress: "In progress",
  done: "Done",
  void: "Void"
};
const STATUS_PILL: Record<WinStatus, string> = {
  new: "bg-sudsy-blue-soft text-splash-navy",
  in_progress: "bg-amber-100 text-amber-900",
  done: "bg-splash-success/15 text-splash-success",
  void: "bg-splash-navy/10 text-splash-navy/60"
};
const PRIZE_LABEL: Record<string, string> = {
  GT30: "Free month",
  GT365: "Free year",
  GTLIFE: "Free for life"
};

type Tab = { id: string; label: string; count: keyof WinsResponse["counts"] };

// "My open" / "Supervisor open" come from CRD coverage (crd_site_coverage /
// crd_regions) and only show for people who have some; the worker also picks
// the default tab from the same facts.
const MINE_TAB: Tab = { id: "mine", label: "My open", count: "mine" };
const TEAM_TAB: Tab = { id: "team", label: "Supervisor open", count: "team" };
const TABS: Tab[] = [
  { id: "open", label: "All open", count: "open" },
  { id: "duplicates", label: "Duplicates", count: "duplicates" },
  { id: "done", label: "Done", count: "done" },
  { id: "void", label: "Void", count: "void" },
  { id: "all", label: "All", count: "all" }
];

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

function fmtDay(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function href(params: Record<string, string>): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const s = qs.toString();
  return s ? `${PATH}?${s}` : PATH;
}

/** Distinct people for a dropdown, by email, labelled with their name. */
function people(rows: RosterLocation[], email: "am_email" | "rm_email", name: "area_manager" | "regional_manager") {
  const out = new Map<string, string>();
  for (const r of rows) if (r[email] && !out.has(r[email])) out.set(r[email], r[name] || r[email]);
  return [...out].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export default async function GoldenTicketPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const q = first(sp.q);
  const res = await getWins({
    promo: first(sp.promo),
    status: first(sp.status),
    q,
    location: first(sp.location),
    rd: first(sp.rd),
    rm: first(sp.rm),
    from: first(sp.from),
    to: first(sp.to)
  });

  if (!("data" in res)) {
    const message =
      res.status === 401
        ? "Your session has expired. Sign out and back in."
        : res.status === 403
          ? "You don't have access to Golden Ticket. An admin can grant it in Sysadmin (Tools → golden_ticket)."
          : `Could not load Golden Ticket (server returned ${res.status}). Reload to retry.`;
    return (
      <Shell>
        <div className={CARD}>
          <p className="text-splash-deny">{message}</p>
          {res.status === 401 ? (
            <Link href={`/logout?return=${encodeURIComponent(PATH)}`} className={`mt-4 inline-flex ${BTN}`}>
              Sign in again
            </Link>
          ) : null}
        </div>
      </Shell>
    );
  }

  const d = res.data;
  const promoName =
    d.promo === "all"
      ? "All promos"
      : d.promo === "none"
        ? "Outside any promo"
        : (d.promos.find((p) => p.id === d.promo)?.name ?? "Promo");

  // Everything that narrows the view, carried through tab links and export.
  const f = d.filters;
  const view = { promo: d.promo, q, location: f.location, rd: f.rd, rm: f.rm, from: f.from, to: f.to };
  const filtered = Boolean(q || f.location || f.rd || f.rm || f.from || f.to);
  const exportQs = new URLSearchParams(
    Object.entries({ ...view, status: d.status }).filter(([, v]) => v)
  ).toString();

  // Each dropdown only offers choices that fit the others already picked
  // (after Apply), so an RD's list shows only their RMs and sites.
  const underRd = d.roster.filter((r) => !f.rd || r.am_email === f.rd);
  const rdOptions = people(d.roster.filter((r) => !f.rm || r.rm_email === f.rm), "am_email", "area_manager");
  const rmOptions = people(underRd, "rm_email", "regional_manager");
  const locOptions = underRd.filter((r) => !f.rm || r.rm_email === f.rm);

  return (
    <Shell>
      {d.can_admin ? <AdminCards data={d} /> : null}

      {/* Filters: a plain GET form, so the view is a shareable URL. */}
      <form method="get" action={PATH} className={`mb-4 flex flex-col gap-3 ${CARD}`}>
        <input type="hidden" name="status" value={d.status} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 sm:w-64">
            <span className={LABEL}>Promo</span>
            <select name="promo" defaultValue={d.promo} className={INPUT}>
              {d.promos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({fmtDay(p.starts_on)} – {fmtDay(p.ends_on)})
                  {p.id === d.current_promo_id ? " · running" : ""}
                </option>
              ))}
              <option value="all">All promos</option>
              <option value="none">Outside any promo</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className={LABEL}>Search</span>
            <input
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Plate, name, phone, ticket serial, barcode or site"
              className={INPUT}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Regional Director</span>
            <select name="rd" defaultValue={f.rd} className={INPUT}>
              <option value="">All</option>
              {rdOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Regional Manager</span>
            <select name="rm" defaultValue={f.rm} className={INPUT}>
              <option value="">All</option>
              {rmOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Location</span>
            <select name="location" defaultValue={f.location} className={INPUT}>
              <option value="">All</option>
              {locOptions.map((r) => (
                <option key={r.site_number} value={r.site_number}>
                  {r.site} ({r.site_number})
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Won from</span>
            <input name="from" type="date" defaultValue={f.from} className={INPUT} />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Won to</span>
            <input name="to" type="date" defaultValue={f.to} className={INPUT} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={BTN}>
            Apply
          </button>
          {filtered ? (
            <Link href={href({ promo: d.promo, status: d.status })} className={BTN_OUTLINE}>
              Clear filters
            </Link>
          ) : null}
          <a
            href={`${PATH}/export.xlsx${exportQs ? `?${exportQs}` : ""}`}
            download
            className={`${BTN_OUTLINE} sm:ml-auto`}
          >
            Export to Excel ({d.wins.length.toLocaleString("en-US")})
          </a>
        </div>
        <p className="text-xs text-splash-navy/60">
          Dates are the day the ticket was redeemed (Eastern). The export is the list below, with
          every field except the photo, plus CRD&rsquo;s status, checkboxes and notes. Pick filters
          and Apply first.
        </p>
      </form>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Status">
        {[...(d.is_agent ? [MINE_TAB] : []), ...(d.is_supervisor ? [TEAM_TAB] : []), ...TABS].map((t) => {
          const active = d.status === t.id;
          const n = d.counts[t.count] ?? 0;
          return (
            <Link
              key={t.id}
              href={href({ ...view, status: t.id })}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-3.5 py-1.5 text-sm font-bold ${
                active
                  ? "bg-splash-navy text-white"
                  : t.id === "duplicates" && n > 0
                    ? "bg-splash-deny/10 text-splash-deny"
                    : "bg-white text-splash-navy ring-1 ring-gray-light"
              }`}
            >
              {t.label} <span className="opacity-70">{n}</span>
            </Link>
          );
        })}
      </nav>

      {d.promos.length === 0 ? (
        <div className="mb-4 rounded-splash-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          No promo has been set up yet, so no win can be checked for duplicates and the site lookup
          answers &ldquo;no promo&rdquo;.{d.can_admin ? " Add one above." : " Ask an admin to add one."}
        </div>
      ) : null}
      {d.cap_reached ? (
        <div className="mb-4 rounded-splash-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Showing the newest 2,000 wins only. Pick a single promo to see the rest.
        </div>
      ) : null}

      {d.wins.length === 0 ? (
        <div className={CARD}>
          <p className="text-splash-navy/80">
            {filtered ? "No wins match these filters." : `Nothing here for ${promoName}.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {d.wins.map((w) => (
            <WinCard key={w.submission_id} win={w} />
          ))}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------------ */

function WinCard({ win: w }: { win: GoldenTicketWin }) {
  const submitted = formatEst(w.submitted_at);
  const existing = (w.existing_unlimited ?? "").toLowerCase().startsWith("y");
  const prize = w.prize_code ? `${PRIZE_LABEL[w.prize_code] ?? w.prize} · ${w.prize_code}` : (w.prize ?? "Unknown prize");
  const dup = w.dup_count > 1;

  return (
    <article className={`${CARD} ${dup ? "ring-2 ring-splash-deny/50" : ""}`}>
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="md:w-56 md:flex-none">
          {w.photo_url ? (
            <a href={assetProxyUrl(w.photo_url)} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetProxyUrl(w.photo_url)}
                alt="Ticket next to the license plate"
                loading="lazy"
                className="aspect-[4/3] w-full rounded-splash-sm bg-splash-navy/5 object-cover"
              />
            </a>
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center rounded-splash-sm bg-splash-navy/5 text-xs text-splash-navy/50">
              No photo
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-bold tracking-wider text-splash-navy">
              {w.plate || "No plate"}
            </span>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900">{prize}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_PILL[w.status]}`}>
              {STATUS_LABEL[w.status]}
            </span>
            {existing ? (
              <span className="rounded-full bg-splash-navy px-2.5 py-0.5 text-xs font-bold text-white">
                Existing member
              </span>
            ) : null}
            {!w.promo_id ? (
              <span className="rounded-full bg-splash-deny/10 px-2.5 py-0.5 text-xs font-bold text-splash-deny">
                Outside any promo
              </span>
            ) : null}
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Field label="Customer" value={w.customer_name} />
            <Field label="Phone" value={w.phone} />
            <Field label="Site" value={w.site_name ? `${w.site_name} (${w.site_number})` : w.site_number} />
            <Field label="Won" value={submitted.absolute} />
            <Field label="Active Unlimited already?" value={w.existing_unlimited} />
            <Field label="Barcode" value={w.barcode} />
            <Field label="Ticket serial" value={w.ticket_serial} />
            <Field label="Employee" value={w.employee_name} />
          </dl>

          {dup ? (
            <div className="mt-3 rounded-splash-md border border-splash-deny/40 bg-splash-deny/5 p-3">
              <p className="text-sm font-bold text-splash-deny">
                This plate has {w.dup_count} wins in this promo. Each vehicle can win once.
              </p>
              <p className="mb-2 text-xs text-splash-navy/70">
                Compare the photos. If it&rsquo;s the same vehicle, void the extra win; a different
                vehicle with the same plate number (another state) can stay.
              </p>
              <div className="flex flex-wrap gap-3">
                {w.duplicates.map((o) => (
                  <div key={o.submission_id} className="w-40 text-xs text-splash-navy/80">
                    {o.photo_url ? (
                      <a href={assetProxyUrl(o.photo_url)} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={assetProxyUrl(o.photo_url)}
                          alt="Other win's ticket and plate"
                          loading="lazy"
                          className="mb-1 aspect-[4/3] w-full rounded-splash-sm bg-splash-navy/5 object-cover"
                        />
                      </a>
                    ) : null}
                    <div className="font-semibold">
                      {fmtDay(o.won_on)} · {o.site_name ?? o.site_number ?? "?"}
                    </div>
                    <div>
                      {o.customer_name ?? "No name"} · {o.prize_code ?? "?"} · {STATUS_LABEL[o.status]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 border-t border-gray-light pt-4">
        <ActionForm action={updateWinAction} className="flex flex-col gap-3">
          <input type="hidden" name="submission_id" value={w.submission_id} />
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <label className="flex flex-col gap-1 lg:w-40">
              <span className={LABEL}>Status</span>
              <select name="status" defaultValue={w.status} className={INPUT}>
                {(Object.keys(STATUS_LABEL) as WinStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1.5 lg:w-72">
              <legend className={LABEL}>Done in Micrologic</legend>
              <label className="mt-1 flex items-center gap-2 text-sm text-splash-navy">
                <input type="checkbox" name="account_setup" defaultChecked={w.account_setup} />
                Account set up / updated
              </label>
              <label className="flex items-center gap-2 text-sm text-splash-navy">
                <input type="checkbox" name="micrologic_tagged" defaultChecked={w.micrologic_tagged} />
                Tagged <b className="font-mono">{w.prize_code ?? "GT…"}</b>
              </label>
            </fieldset>
            <label className="flex flex-1 flex-col gap-1">
              <span className={LABEL}>Add a note</span>
              <textarea
                name="note"
                rows={2}
                maxLength={2000}
                placeholder="What was done, or what's still needed"
                className={INPUT}
              />
            </label>
          </div>
          <div>
            <SubmitButton className={BTN} pendingText="Saving…">
              Save
            </SubmitButton>
          </div>
        </ActionForm>

        {w.history.length ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold text-splash-blue">
              History ({w.history.length})
            </summary>
            <ol className="mt-2 flex flex-col gap-2 border-l-2 border-gray-light pl-3">
              {[...w.history].reverse().map((h, i) => (
                <li key={i} className="text-xs text-splash-navy/80">
                  <div className="font-semibold text-splash-navy">
                    {formatEst(h.at).absolute} · {h.by ?? "unknown"}
                  </div>
                  {Object.entries(h.changes ?? {}).map(([k, [from, to]]) => (
                    <div key={k}>{describeChange(k, from, to)}</div>
                  ))}
                  {h.note ? <div className="mt-0.5 whitespace-pre-wrap">&ldquo;{h.note}&rdquo;</div> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function describeChange(field: string, from: unknown, to: unknown): string {
  if (field === "status") {
    return `Status: ${STATUS_LABEL[from as WinStatus] ?? from} → ${STATUS_LABEL[to as WinStatus] ?? to}`;
  }
  const label = field === "account_setup" ? "Account set up" : field === "micrologic_tagged" ? "Micrologic tag" : field;
  return `${label}: ${to ? "ticked" : "unticked"}`;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <dt className="w-44 flex-none text-splash-navy/60">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-splash-navy">{value || "—"}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function AdminCards({ data: d }: { data: WinsResponse }) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className={CARD}>
        <h2 className="mb-1 text-base font-bold text-splash-navy">Site lookup link</h2>
        <p className="mb-3 text-sm text-splash-navy/70">
          Sites type a plate to see whether that vehicle has already won in the current promo. No
          sign-in, so share it with sites only. Making a new link or turning it off stops the old
          one immediately.
        </p>
        {d.lookup_path ? (
          <LookupLink path={d.lookup_path} />
        ) : (
          <p className="text-sm font-semibold text-splash-deny">The lookup page is off.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionForm action={lookupLinkAction}>
            <input type="hidden" name="action" value="new" />
            {d.lookup_path ? (
              <ConfirmButton
                label="Make a new link"
                pendingLabel="Working…"
                confirmText="Make a new link? The current link stops working straight away and sites will need the new one."
                className={BTN_OUTLINE}
              />
            ) : (
              <SubmitButton className={BTN} pendingText="Working…">
                Turn on
              </SubmitButton>
            )}
          </ActionForm>
          {d.lookup_path ? (
            <ActionForm action={lookupLinkAction}>
              <input type="hidden" name="action" value="off" />
              <ConfirmButton
                label="Turn off"
                pendingLabel="Working…"
                confirmText="Turn off the lookup page? The link stops working for every site until you turn it back on (which makes a new link)."
                className={BTN_DANGER}
              />
            </ActionForm>
          ) : null}
        </div>
      </section>

      <section className={CARD}>
        <h2 className="mb-1 text-base font-bold text-splash-navy">Promos</h2>
        <p className="mb-3 text-sm text-splash-navy/70">
          A win belongs to the promo whose dates cover the day the ticket was redeemed, so the end
          date is the last day tickets can be redeemed. Each vehicle can win once per promo.
        </p>
        {d.promos.length ? (
          <ul className="mb-3 flex flex-col divide-y divide-gray-light">
            {d.promos.map((p) => (
              <PromoRow key={p.id} promo={p} running={p.id === d.current_promo_id} />
            ))}
          </ul>
        ) : null}
        <details>
          <summary className="cursor-pointer text-sm font-bold text-splash-blue">+ Add a promo</summary>
          <PromoForm />
        </details>
      </section>
    </div>
  );
}

function PromoRow({ promo: p, running }: { promo: GoldenTicketPromo; running: boolean }) {
  return (
    <li className="py-2">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm text-splash-navy">
          <b>{p.name}</b>
          <span className="text-splash-navy/70">
            {fmtDay(p.starts_on)} – {fmtDay(p.ends_on)}
          </span>
          {running ? (
            <span className="rounded-full bg-splash-success/15 px-2 py-0.5 text-[11px] font-bold text-splash-success">
              Running
            </span>
          ) : null}
          <span className="text-xs font-semibold text-splash-blue">Edit</span>
        </summary>
        <PromoForm promo={p} />
        <ActionForm action={deletePromoAction} className="mt-2">
          <input type="hidden" name="id" value={p.id} />
          <ConfirmButton
            label="Delete promo"
            pendingLabel="Deleting…"
            confirmText={`Delete "${p.name}"? Its wins are kept but no longer belong to a promo, so they stop counting for duplicates.`}
            className={BTN_DANGER}
          />
        </ActionForm>
      </details>
    </li>
  );
}

function PromoForm({ promo }: { promo?: GoldenTicketPromo }) {
  return (
    <ActionForm action={savePromoAction} resetOnSuccess={!promo} className="mt-3 flex flex-col gap-3">
      {promo ? <input type="hidden" name="id" value={promo.id} /> : null}
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Name</span>
        <input name="name" required maxLength={120} defaultValue={promo?.name ?? ""} placeholder="Fall 2026 Golden Ticket" className={INPUT} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Starts</span>
          <input name="starts_on" type="date" required defaultValue={promo?.starts_on ?? ""} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Last redemption day</span>
          <input name="ends_on" type="date" required defaultValue={promo?.ends_on ?? ""} className={INPUT} />
        </label>
      </div>
      <div>
        <SubmitButton className={BTN} pendingText="Saving…">
          {promo ? "Save promo" : "Add promo"}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">CRD</p>
        <h1 className="text-2xl font-bold text-splash-navy">Golden Ticket</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Free unlimited winners from the site form. Finish each member&rsquo;s account in
          Micrologic and tag it GT30, GT365 or GTLIFE.
        </p>
      </div>
      {children}
    </section>
  );
}
