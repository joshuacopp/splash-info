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

import { useEffect, useRef, useState } from "react";
import { LocationPicker } from "../../performance/_components/LocationPicker";
import { MetricFields } from "./MetricFields";

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
  defaultDate
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaultDate: string;
}) {
  const [locationId, setLocationId] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState("");
  const [manualName, setManualName] = useState("");
  const seqRef = useRef(0);

  useEffect(() => {
    setSelectedId("");
    setManualName("");
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

  // The name is stored alongside the id as a display snapshot, so a later
  // rename in Beekeeper doesn't rewrite history. Derive it from the picked
  // option rather than asking the user to type it twice.
  const selectedName =
    members.find((m) => m.id === selectedId)?.name ?? "";

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Date *</span>
          <input
            type="date"
            name="business_date"
            required
            defaultValue={defaultDate}
            className={inputCls}
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className={labelCls}>Location *</span>
          <LocationPicker
            name="location_id"
            required
            placeholder="Search by site number, name, or location code…"
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

      <MetricFields />

      <div className="mt-1">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
        >
          Save day
        </button>
      </div>
    </form>
  );
}
