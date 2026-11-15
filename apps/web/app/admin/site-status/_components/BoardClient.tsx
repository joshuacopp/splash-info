"use client";

// The live site status board. Closed sites first (longest closed on top) as
// cards with a running clock; everything else as a compact list showing any
// equipment that is down and the site's last closure. Refreshes every minute.
//
// Buttons render only where the worker said the viewer may act (can_manage);
// the worker re-checks every write anyway.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import {
  clearDownAction,
  closeSiteAction,
  downItemAction,
  estimateAction,
  reopenAction
} from "../actions";
import type { Board, BoardSite, Closure } from "../_lib/worker-fetch";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card";
const INPUT =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none";
const LABEL = "mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const BTN =
  "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60";
const BTN_GREEN =
  "rounded-splash-sm bg-splash-success px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-60";
const BTN_OUTLINE =
  "rounded-splash-sm border border-splash-blue px-3 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5 disabled:opacity-60";
const BTN_LINK = "text-sm font-semibold text-splash-blue hover:underline";

const ESTIMATES: Array<[string, string]> = [
  ["30", "30 minutes"],
  ["60", "1 hour"],
  ["120", "2 hours"],
  ["180", "3 hours"],
  ["240", "4 hours"],
  ["360", "6 hours"],
  ["480", "8 hours"],
  ["720", "12 hours"],
  ["1440", "24 hours"],
  ["2880", "2 days"],
  ["custom", "Pick a date and time…"]
];

const ET = "America/New_York";
function fmtEt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}
function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "numeric", day: "numeric", year: "2-digit" }).format(new Date(iso));
}
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
const ms = (iso: string) => new Date(iso).getTime();

// ---- estimate picker ---------------------------------------------------------------

/** Preset length, or a custom local date/time sent as ISO (the browser knows its own zone). */
function EstimateFields({ label }: { label: string }) {
  const [choice, setChoice] = useState("60");
  const [local, setLocal] = useState("");
  const iso = local ? new Date(local).toISOString() : "";
  return (
    <div className="space-y-2">
      <label className="block">
        <span className={LABEL}>{label}</span>
        <select name="minutes" value={choice} onChange={(e) => setChoice(e.target.value)} className={INPUT}>
          {ESTIMATES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {choice === "custom" ? (
        <label className="block">
          <span className={LABEL}>Expected to reopen at</span>
          <input type="datetime-local" required value={local} onChange={(e) => setLocal(e.target.value)} className={INPUT} />
          <input type="hidden" name="reopen_at" value={iso} />
        </label>
      ) : null}
    </div>
  );
}

// ---- close-a-site panel ------------------------------------------------------------

function ClosePanel({ board, onDone }: { board: Board; onDone: () => void }) {
  const options = board.sites.filter((s) => s.can_manage && !s.closure).sort((a, b) => a.site_number - b.site_number);
  const [reason, setReason] = useState("");
  return (
    <div className={`${CARD} border-splash-deny/40`}>
      <h2 className="mb-3 text-lg font-bold text-splash-navy">Close a site</h2>
      <ActionForm action={closeSiteAction} onResult={(r) => r.ok && onDone()} className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={LABEL}>Site</span>
          <select name="site_number" required defaultValue="" className={INPUT}>
            <option value="" disabled>
              Choose a site…
            </option>
            {options.map((s) => (
              <option key={s.site_number} value={s.site_number}>
                {s.site_number} — {s.site}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Reason</span>
          <select name="reason" required value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT}>
            <option value="" disabled>
              Choose a reason…
            </option>
            {board.reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <EstimateFields label="Expected to be closed for" />
        <label className="block sm:col-span-2">
          <span className={LABEL}>Details{reason === "other" ? " (required)" : " (optional)"}</span>
          <textarea
            name="reason_detail"
            rows={2}
            maxLength={1000}
            required={reason === "other"}
            className={INPUT}
            placeholder="What happened?"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <SubmitButton className="rounded-splash-sm bg-splash-deny px-4 py-2 text-sm font-bold text-white hover:opacity-90" pendingText="Closing…">
            Close site and send emails
          </SubmitButton>
          <button type="button" onClick={onDone} className={BTN_LINK}>
            Cancel
          </button>
          <span className="text-xs text-splash-navy/60">
            Emails the RD, RM, HRT, CRD agent and supervisor, and the site (with the link to mark it open).
          </span>
        </div>
      </ActionForm>
    </div>
  );
}

// ---- closed site card ----------------------------------------------------------------

function ClosedCard({ s, c, now, reasons }: { s: BoardSite; c: Closure; now: number; reasons: Map<string, string> }) {
  const [mode, setMode] = useState<"" | "open" | "estimate" | "down">("");
  const [showHistory, setShowHistory] = useState(false);
  const overdue = ms(c.est_reopen_at) < now;
  const changed = c.estimate_changes?.length ?? 0;
  return (
    <div className={`${CARD} border-l-4 ${overdue ? "border-l-splash-deny" : "border-l-amber-500"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-splash-deny/15 px-2.5 py-0.5 text-xs font-bold text-splash-deny">CLOSED</span>
            {overdue ? (
              <span className="rounded-full bg-splash-deny px-2.5 py-0.5 text-xs font-bold text-white">
                Overdue {fmtDuration(now - ms(c.est_reopen_at))}
              </span>
            ) : null}
            <h3 className="text-lg font-bold text-splash-navy">
              {s.site} <span className="font-normal text-splash-navy/60">({s.site_number})</span>
            </h3>
          </div>
          <p className="mt-1 text-sm text-splash-navy">
            <strong>{reasons.get(c.reason) ?? c.reason}</strong>
            {c.reason_detail ? ` — ${c.reason_detail}` : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums text-splash-navy">{fmtDuration(now - ms(c.closed_at))}</div>
          <div className="text-xs text-splash-navy/60">closed so far</div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-splash-navy/60">Authorized by</dt>
          <dd className="break-all text-splash-navy">{c.closed_by}</dd>
        </div>
        <div>
          <dt className="text-xs text-splash-navy/60">Closed at</dt>
          <dd className="text-splash-navy">{fmtEt(c.closed_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-splash-navy/60">Estimated length</dt>
          <dd className="text-splash-navy">
            {fmtDuration(ms(c.est_reopen_at) - ms(c.closed_at))}
            {changed > 0 ? (
              <button type="button" className="ml-1 text-xs font-semibold text-splash-blue hover:underline" onClick={() => setShowHistory((v) => !v)}>
                (changed {changed}× {showHistory ? "▴" : "▾"})
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-splash-navy/60">Expected to reopen</dt>
          <dd className={overdue ? "font-bold text-splash-deny" : "text-splash-navy"}>{fmtEt(c.est_reopen_at)}</dd>
        </div>
      </dl>

      {showHistory && changed > 0 ? <EstimateHistory c={c} /> : null}

      <DownChips s={s} />

      {s.can_manage ? (
        <div className="mt-3 border-t border-gray-light pt-3">
          {mode === "" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN_GREEN} onClick={() => setMode("open")}>
                Mark open
              </button>
              <button type="button" className={BTN_OUTLINE} onClick={() => setMode("estimate")}>
                Change estimate
              </button>
              <button type="button" className={BTN_OUTLINE} onClick={() => setMode("down")}>
                Log equipment down
              </button>
            </div>
          ) : null}
          {mode === "open" ? (
            <ActionForm action={reopenAction} onResult={(r) => r.ok && setMode("")} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="closure_id" value={c.id} />
              <label className="block min-w-[220px] flex-1">
                <span className={LABEL}>Note (optional)</span>
                <input name="note" maxLength={300} className={INPUT} />
              </label>
              <SubmitButton className={BTN_GREEN} pendingText="Opening…">
                Mark {s.site} open
              </SubmitButton>
              <button type="button" className={BTN_LINK} onClick={() => setMode("")}>
                Cancel
              </button>
            </ActionForm>
          ) : null}
          {mode === "estimate" ? (
            <ActionForm action={estimateAction} onResult={(r) => r.ok && setMode("")} className="grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="closure_id" value={c.id} />
              <EstimateFields label="Expected to reopen in (from now)" />
              <label className="block">
                <span className={LABEL}>Note (optional)</span>
                <input name="note" maxLength={300} className={INPUT} />
              </label>
              <div className="flex items-center gap-3 sm:col-span-2">
                <SubmitButton className={BTN} pendingText="Saving…">
                  Save and email update
                </SubmitButton>
                <button type="button" className={BTN_LINK} onClick={() => setMode("")}>
                  Cancel
                </button>
              </div>
            </ActionForm>
          ) : null}
          {mode === "down" ? <DownForm siteNumber={s.site_number} onDone={() => setMode("")} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- equipment down ---------------------------------------------------------------------

function DownChips({ s }: { s: BoardSite }) {
  if (s.down_items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {s.down_items.map((d) => (
        <span
          key={d.id}
          title={`${d.note ? `${d.note} — ` : ""}since ${fmtEt(d.reported_at)} (${d.reported_by})`}
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900"
        >
          ⚠ {d.item} down
          {s.can_manage ? (
            <ActionForm action={clearDownAction} className="inline">
              <input type="hidden" name="item_id" value={d.id} />
              <SubmitButton className="ml-1 font-bold text-amber-900 hover:text-splash-navy" pendingText="…">
                <span aria-label={`Mark ${d.item} back up`}>×</span>
              </SubmitButton>
            </ActionForm>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function DownForm({ siteNumber, onDone, suggestions }: { siteNumber: number; onDone: () => void; suggestions?: string[] }) {
  const listId = `down-items-${siteNumber}`;
  return (
    <ActionForm action={downItemAction} onResult={(r) => r.ok && onDone()} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="site_number" value={siteNumber} />
      <label className="block min-w-[160px] flex-1">
        <span className={LABEL}>What is down</span>
        <input name="item" required maxLength={80} list={listId} className={INPUT} placeholder="e.g. Vacuums" />
        <datalist id={listId}>
          {(suggestions ?? DEFAULT_SUGGESTIONS).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </label>
      <label className="block min-w-[200px] flex-1">
        <span className={LABEL}>Details (optional)</span>
        <input name="note" maxLength={300} className={INPUT} />
      </label>
      <SubmitButton className={BTN} pendingText="Saving…">
        Log it
      </SubmitButton>
      <button type="button" className={BTN_LINK} onClick={onDone}>
        Cancel
      </button>
      <p className="w-full text-xs text-splash-navy/60">Shows on this board only; no email is sent.</p>
    </ActionForm>
  );
}
const DEFAULT_SUGGESTIONS = ["Vacuums", "Tunnel / conveyor", "Pay station", "Dryers", "Tire shine", "Express lane", "Credit cards"];

// Every estimate change, oldest first: when, who, old -> new, and the note.
function EstimateHistory({ c }: { c: Closure }) {
  return (
    <ol className="mt-3 space-y-1.5 rounded-splash-sm bg-gray-light/40 p-3 text-sm">
      <li className="text-xs text-splash-navy/60">First estimate: reopen {fmtEt(c.original_est_reopen_at)}</li>
      {c.estimate_changes.map((e, i) => (
        <li key={`${e.at}-${i}`} className="text-splash-navy">
          <span className="text-xs text-splash-navy/60">
            {fmtEt(e.at)} · <span className="break-all">{e.by}</span>
          </span>
          <div>
            {fmtEt(e.from)} → <strong>{fmtEt(e.to)}</strong>
          </div>
          {e.note ? <div className="whitespace-pre-line text-splash-navy/80">“{e.note}”</div> : null}
        </li>
      ))}
    </ol>
  );
}

// ---- open site row ------------------------------------------------------------------------

function OpenRow({ s, reasons }: { s: BoardSite; reasons: Map<string, string> }) {
  const [logging, setLogging] = useState(false);
  const last = s.last_closure;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-splash-success/15 px-2 py-0.5 text-xs font-bold text-splash-success">OPEN</span>
            <span className="font-semibold text-splash-navy">
              {s.site} <span className="font-normal text-splash-navy/60">({s.site_number})</span>
            </span>
          </div>
          <div className="mt-0.5 text-xs text-splash-navy/60">
            {last ? (
              <>
                Last closed {fmtDate(last.closed_at)} · {reasons.get(last.reason) ?? last.reason}
                {last.reason_detail ? ` — ${last.reason_detail}` : ""}
                {last.reopened_at ? ` · ${fmtDuration(ms(last.reopened_at) - ms(last.closed_at))}` : ""}
                {last.reopened_by ? ` · reopened by ${last.reopened_by}` : ""}
                {last.reopen_note ? (
                  <span className="block text-splash-navy/80">Reopen note: “{last.reopen_note}”</span>
                ) : null}
              </>
            ) : (
              "No closures on record"
            )}
          </div>
        </div>
        {s.can_manage && !logging ? (
          <button type="button" className={BTN_LINK} onClick={() => setLogging(true)}>
            Log equipment down
          </button>
        ) : null}
      </div>
      <DownChips s={s} />
      {logging ? <DownForm siteNumber={s.site_number} onDone={() => setLogging(false)} /> : null}
    </li>
  );
}

// ---- board ----------------------------------------------------------------------------------

export function BoardClient({ board }: { board: Board }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState(false);
  const [rd, setRd] = useState("");
  const [rm, setRm] = useState("");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const refresh = setInterval(() => router.refresh(), 60_000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router]);

  const reasons = useMemo(() => new Map(board.reasons.map((r) => [r.value, r.label])), [board.reasons]);
  const rds = useMemo(() => [...new Set(board.sites.map((s) => s.rd_name).filter((x): x is string => !!x))].sort(), [board.sites]);
  const rms = useMemo(
    () =>
      [...new Set(board.sites.filter((s) => !rd || s.rd_name === rd).map((s) => s.rm_name).filter((x): x is string => !!x))].sort(),
    [board.sites, rd]
  );

  const filtered = board.sites.filter((s) => {
    if (rd && s.rd_name !== rd) return false;
    if (rm && s.rm_name !== rm) return false;
    if (mine && !s.can_manage) return false;
    if (q) {
      const needle = q.toLowerCase();
      if (!s.site.toLowerCase().includes(needle) && !String(s.site_number).includes(needle)) return false;
    }
    return true;
  });
  const closed = filtered.filter((s) => s.closure);
  const open = filtered.filter((s) => !s.closure);
  const downCount = board.sites.filter((s) => s.down_items.length > 0).length;
  const closedCount = board.sites.filter((s) => s.closure).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div className={`${CARD} text-center`}>
          <div className="text-3xl font-bold text-splash-deny">{closedCount}</div>
          <div className="text-xs font-semibold uppercase tracking-wider text-splash-navy/60">Closed</div>
        </div>
        <div className={`${CARD} text-center`}>
          <div className="text-3xl font-bold text-amber-700">{downCount}</div>
          <div className="text-xs font-semibold uppercase tracking-wider text-splash-navy/60">Equipment down</div>
        </div>
        <div className={`${CARD} text-center`}>
          <div className="text-3xl font-bold text-splash-success">{board.sites.length - closedCount}</div>
          <div className="text-xs font-semibold uppercase tracking-wider text-splash-navy/60">Open</div>
        </div>
      </div>

      {board.can_close_any ? (
        closing ? (
          <ClosePanel board={board} onDone={() => setClosing(false)} />
        ) : (
          <button type="button" onClick={() => setClosing(true)} className="rounded-splash-sm bg-splash-deny px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn hover:opacity-90">
            Close a site
          </button>
        )
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-40">
          <span className={LABEL}>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or #" className={INPUT} />
        </label>
        <label className="block w-48">
          <span className={LABEL}>Regional Director</span>
          <select value={rd} onChange={(e) => { setRd(e.target.value); setRm(""); }} className={INPUT}>
            <option value="">All</option>
            {rds.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="block w-48">
          <span className={LABEL}>Regional Manager</span>
          <select value={rm} onChange={(e) => setRm(e.target.value)} className={INPUT}>
            <option value="">All</option>
            {rms.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        {board.can_close_any ? (
          <label className="flex items-center gap-2 pb-2 text-sm text-splash-navy">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="h-4 w-4" />
            My sites only
          </label>
        ) : null}
      </div>

      <section className="space-y-3">
        {closed.length === 0 ? (
          <div className={`${CARD} text-sm text-splash-navy/70`}>No sites are closed{rd || rm || q || mine ? " in this view" : ""}.</div>
        ) : (
          closed.map((s) => <ClosedCard key={s.site_number} s={s} c={s.closure as Closure} now={now} reasons={reasons} />)
        )}
      </section>

      <section className="rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
        <h2 className="border-b border-gray-light px-4 py-3 text-sm font-bold uppercase tracking-wider text-splash-navy/70">
          Open sites ({open.length})
        </h2>
        <ul className="divide-y divide-gray-light">
          {open.map((s) => (
            <OpenRow key={s.site_number} s={s} reasons={reasons} />
          ))}
        </ul>
      </section>
    </div>
  );
}
