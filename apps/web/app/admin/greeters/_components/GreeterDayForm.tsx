"use client";

// Per-greeter day submission form.
//
// Client component for one reason: the people dropdown is chained to the
// location. Beekeeper's roster is per-site, so nothing can populate the picker
// until a location is chosen — hence LocationPicker's onSelect callback and the
// fetch below.
//
// The roster fetch goes to apps/web's own /admin/greeters/roster handler, NOT
// straight to /pertrack/api/greeter/roster. performance-worker is route-bound
// on staging only, so a browser fetch at /pertrack/... 404s on the apex; the
// handler proxies over the service binding, which works everywhere. (This is
// also why the location typeahead above may not search on production — it
// still fetches /pertrack/api/locations directly. Separate fix.)
//
// EMPTY-STATE RULE: a location with no mapped Beekeeper schedule returns
// `mapped: false`, which is normal (that site isn't on the scheduler yet) and
// must be SAID, not rendered as an empty dropdown that reads like "nobody
// works here". The fallback is a free-text name box so the day can still be
// logged — beekeeper_user_id then falls back to a stable synthetic key.

// EDIT MODE is the same form with a `row` prop and a hidden `id`. The worker
// distinguishes the two by that id alone, so nothing about the fields, the
// coercions or the goal snapshot can drift between adding a day and fixing one.
// An edit may move the day to another date, site or greeter — that is why every
// control below is seeded rather than locked.

import { useEffect, useRef, useState } from "react";
import type { GreeterDayEditRow } from "@splash/types/greeter";
import {
  RedirectForm,
  type RedirectResult
} from "../../_components/RedirectForm";
import { LocationPicker } from "../../performance/_components/LocationPicker";
import { GreeterMetricFields } from "./MetricFields";
import { SavingButton } from "./SavingButton";
import { ShiftTimePicker } from "./ShiftTimePicker";

interface RosterMember {
  id: string;
  name: string;
}

interface RosterResponse {
  location_code: string;
  mapped: boolean;
  schedule_id: string | null;
  members: RosterMember[];
}

type RosterState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; mapped: boolean; members: RosterMember[] }
  | { status: "error"; message: string };

const labelCls =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

export function GreeterDayForm({
  action,
  defaultDate,
  row,
  locationLabel,
  returnTo
}: {
  action: (formData: FormData) => Promise<RedirectResult>;
  defaultDate: string;
  /** Present = editing that row. Absent = a new day. */
  row?: GreeterDayEditRow | null;
  /**
   * The URL to land back on after a successful save — normally
   * /admin/greeters with the caller's current filters still on it.
   *
   * Matters most when EDITING. The row being fixed was found by narrowing the
   * Daily submissions table to a date range and a site; without this the save
   * returned to the unfiltered list, so the correction succeeded and then
   * scrolled the user away from the row they had just corrected. Cancel already
   * preserved the filters, which made saving feel like the destructive option.
   *
   * The server allow-lists this against a fixed set of paths before redirecting
   * — it is a form field, so it is whatever the poster says it is.
   */
  returnTo?: string;
  /**
   * Display label for the row's location, e.g. "BINGHAMTON · 7042".
   *
   * Needed because LocationPicker's defaultValue only shows a selection when
   * paired with a label, and the day row carries a site_number rather than the
   * name the typeahead renders. Without it the picker would look empty on an
   * edit and the user would re-search for the site they were already on.
   */
  locationLabel?: string | null;
}) {
  const [locationId, setLocationId] = useState<number | null>(
    row?.location_id ?? null
  );
  const [roster, setRoster] = useState<RosterState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState(row?.beekeeper_user_id ?? "");
  const [manualName, setManualName] = useState(row?.greeter_name ?? "");
  const seqRef = useRef(0);
  // True until the roster effect has run once for an edit. Without it that
  // effect's opening two lines would wipe the greeter the moment the form
  // mounted — it clears the person on every location change, and the initial
  // render counts as one.
  const seedingEditRef = useRef(Boolean(row));

  useEffect(() => {
    if (seedingEditRef.current) {
      seedingEditRef.current = false;
    } else {
      setSelectedId("");
      setManualName("");
    }
    if (locationId == null) {
      setRoster({ status: "idle" });
      return;
    }

    const seq = ++seqRef.current;
    setRoster({ status: "loading" });

    (async () => {
      try {
        const resp = await fetch(
          `/admin/greeters/roster?location_id=${locationId}`,
          { method: "GET", credentials: "include", cache: "no-store" }
        );
        if (seq !== seqRef.current) return; // a newer location won the race
        if (!resp.ok) {
          setRoster({
            status: "error",
            message:
              resp.status === 401 || resp.status === 403
                ? "You don't have access to this location's roster."
                : `Could not load the roster (${resp.status}).`
          });
          return;
        }
        const data = (await resp.json()) as RosterResponse;
        if (seq !== seqRef.current) return;
        setRoster({
          status: "ready",
          mapped: data.mapped,
          members: data.members ?? []
        });
      } catch (err) {
        if (seq !== seqRef.current) return;
        setRoster({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load the roster."
        });
      }
    })();
  }, [locationId]);

  const members = roster.status === "ready" ? roster.members : [];
  const usingManualName =
    roster.status === "ready" && (!roster.mapped || members.length === 0);

  // THE ROW'S GREETER MAY NOT BE ON THE ROSTER ANY MORE — people leave, and
  // their days stay. Without this the select would silently fall back to
  // "Select a person…", the hidden greeter_name would go empty, and a day
  // belonging to someone who has since left would be uneditable for a reason
  // the screen never states. So when editing, the stored person is offered as
  // an option of their own.
  const strandedGreeter =
    row && selectedId === row.beekeeper_user_id &&
    roster.status === "ready" &&
    !members.some((m) => m.id === selectedId)
      ? { id: row.beekeeper_user_id, name: row.greeter_name }
      : null;

  // The name is stored alongside the id as a display snapshot, so a later
  // rename in Beekeeper doesn't rewrite history. Derive it from the picked
  // option rather than asking the user to type it twice.
  const selectedName =
    members.find((m) => m.id === selectedId)?.name ??
    (strandedGreeter && strandedGreeter.id === selectedId
      ? strandedGreeter.name
      : "");

  return (
    <RedirectForm action={action} className="flex flex-col gap-4">
      {/* The whole of edit mode, as far as the server is concerned. */}
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      {returnTo ? (
        <input type="hidden" name="return_to" value={returnTo} />
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Date *</span>
          <input
            type="date"
            name="business_date"
            required
            defaultValue={row?.business_date ?? defaultDate}
            className={inputCls}
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className={labelCls}>Location *</span>
          <LocationPicker
            name="location_id"
            required
            placeholder="Search by site number, name, or location code…"
            defaultValue={row?.location_id}
            defaultLabel={locationLabel ?? undefined}
            onSelect={(sel) => setLocationId(sel ? sel.id : null)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className={labelCls}>Greeter *</span>

        {roster.status === "idle" ? (
          <p className="text-sm text-splash-navy/60">
            Pick a location first — the people list comes from that site&rsquo;s
            Beekeeper roster.
          </p>
        ) : null}

        {roster.status === "loading" ? (
          <p className="text-sm text-splash-navy/60">Loading roster…</p>
        ) : null}

        {roster.status === "error" ? (
          <p className="text-sm text-splash-deny">{roster.message}</p>
        ) : null}

        {roster.status === "ready" && !usingManualName ? (
          <>
            <select
              name="beekeeper_user_id"
              required
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className={inputCls}
            >
              <option value="">Select a person…</option>
              {strandedGreeter ? (
                <option value={strandedGreeter.id}>
                  {strandedGreeter.name} (no longer on this roster)
                </option>
              ) : null}
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <input type="hidden" name="greeter_name" value={selectedName} />
          </>
        ) : null}

        {usingManualName ? (
          <>
            <input
              type="text"
              required
              maxLength={200}
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="Type the greeter's name"
              className={inputCls}
            />
            <input type="hidden" name="greeter_name" value={manualName} />
            {/* No Beekeeper id available — the server action derives a stable
                synthetic one from the typed name so corrections still land on
                the same row. */}
            <input type="hidden" name="beekeeper_user_id" value="" />
            <span className="text-[11px] text-splash-navy/60">
              {roster.status === "ready" && !roster.mapped
                ? "This site isn't mapped to a Beekeeper schedule, so there's no roster to pick from. Names typed here won't link to a Beekeeper profile."
                : "That site's Beekeeper roster came back empty. Names typed here won't link to a Beekeeper profile."}
            </span>
          </>
        ) : null}
      </div>

      <GreeterMetricFields row={row} />

      {/* Optional. Filling both unlocks hours worked and wash sales per hour;
          leaving both blank just means those two read as unknown, not zero.
          The worker rejects one-without-the-other with a readable message. */}
      <div className="flex flex-col gap-2 rounded-splash-sm border border-gray-light bg-splash-navy/[0.02] p-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
          Shift (optional)
        </span>
        <div className="flex flex-wrap gap-5">
          <ShiftTimePicker
            name="shift_start"
            label="Start"
            defaultValue={row?.shift_start}
          />
          <ShiftTimePicker
            name="shift_end"
            label="End"
            defaultValue={row?.shift_end}
          />
        </div>
        <span className="text-[11px] text-splash-navy/60">
          Fill both or neither. An end time earlier than the start is read as an
          overnight shift.
        </span>
      </div>

      <div className="mt-1">
        <SavingButton>{row ? "Save changes" : "Save day"}</SavingButton>
      </div>
    </RedirectForm>
  );
}
