// Regional Director / Regional Manager filter selects, shared by
// /admin/greeters and /admin/greeters/report.
//
// LABELS ARE NOT THE COLUMN NAMES, and this is the one place the difference is
// worth stating twice. The database column `area_manager` holds the Regional
// DIRECTOR's name; `regional_manager` holds the Regional Manager's. The mapping
// happens in listContactRoster() worker-side; nothing on this page ever sees
// the raw columns. If a dropdown ever shows the wrong people, that is where to
// look — not here.
//
// PLAIN <select>, no client component. Both pages wrap their filters in a
// `<form method="GET">`, so the browser puts the chosen value in the query
// string on submit and the server re-renders from the URL. A typeahead would
// need client state, and the roster is a few dozen names.
//
// FILTERING BY EMAIL, LABELLING BY NAME. The email is the stable key the worker
// resolves against pricing_simple; two managers can share a first name and one
// manager's name can be spelled two ways across rows (listContactRoster picks
// the most common). Round-tripping the name would break on both.
//
// EMPTY ROSTER RENDERS A DISABLED SELECT, not a hidden one. listContactRoster
// is fail-soft — an outage or a caller whose sites have no manager assigned
// both arrive here as []. Hiding the control would read as "this feature is
// gone"; a disabled control with a reason reads as what it is.

import type { ReactNode } from "react";
import { performanceGetJson } from "../../performance/_lib/worker-fetch";

export interface ManagerOption {
  email: string;
  name: string;
  location_codes: string[];
}

export interface ManagerRosters {
  rd: ManagerOption[];
  rm: ManagerOption[];
}

export const EMPTY_ROSTERS: ManagerRosters = { rd: [], rm: [] };

/**
 * Both roster lists, already scoped to the caller by the worker.
 *
 * Never throws and never returns null: a manager filter that can't load is a
 * degraded filter bar, not a broken page. performanceGetJson returns null on
 * 401/403 (which the pages already handle via their main fetches) and throws on
 * 5xx, and both collapse to an empty list here.
 */
export async function fetchManagerRosters(): Promise<ManagerRosters> {
  const [rd, rm] = await Promise.all([
    performanceGetJson<ManagerOption[]>(
      "/pertrack/api/greeter/contact-roster?role=regional_director"
    ).catch(() => null),
    performanceGetJson<ManagerOption[]>(
      "/pertrack/api/greeter/contact-roster?role=regional_manager"
    ).catch(() => null)
  ]);
  return { rd: rd ?? [], rm: rm ?? [] };
}

/**
 * The two selects, as sibling grid cells — the caller owns the grid.
 *
 * `selected` values that aren't in the roster are still rendered, as a
 * disabled-looking extra option. A shared link carrying a manager the recipient
 * can't see must not silently reset to "(any)" and show them a wider report
 * than the URL describes.
 *
 * `note` captions the PAIR and so renders under the second select only. The two
 * cells are adjacent at every breakpoint the callers use, and the sentence
 * ("narrows the whole page") is true of both together — printing it twice reads
 * as a rendering bug rather than as emphasis.
 */
export function ManagerFilters({
  rosters,
  rd,
  rm,
  note
}: {
  rosters: ManagerRosters;
  rd: string;
  rm: string;
  note?: ReactNode;
}) {
  return (
    <>
      <ManagerSelect
        name="rd"
        label="Regional Director"
        options={rosters.rd}
        selected={rd}
      />
      <ManagerSelect
        name="rm"
        label="Regional Manager"
        options={rosters.rm}
        selected={rm}
        note={note}
      />
    </>
  );
}

function ManagerSelect({
  name,
  label,
  options,
  selected,
  note
}: {
  name: string;
  label: string;
  options: ManagerOption[];
  selected: string;
  note?: ReactNode;
}) {
  const known = options.some(
    (o) => o.email.toLowerCase() === selected.trim().toLowerCase()
  );
  const orphan = selected.trim() && !known ? selected.trim() : null;

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        {label}
      </span>
      <select
        name={name}
        defaultValue={selected}
        disabled={options.length === 0 && !orphan}
        className="rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none disabled:bg-splash-navy/5 disabled:text-splash-navy/40"
      >
        <option value="">
          {options.length === 0 && !orphan ? "None assigned" : "Any"}
        </option>
        {options.map((o) => (
          <option key={o.email} value={o.email}>
            {o.name} ({o.location_codes.length})
          </option>
        ))}
        {orphan ? <option value={orphan}>{orphan}</option> : null}
      </select>
      {note}
    </label>
  );
}
