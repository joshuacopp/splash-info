// UpdateLocationCard — client island on /admin/sysadmin. Brief 27.
//
// Search-then-edit flow for one row of the `locations` table identified
// by either id or site_number. Posts to PATCH /sysadmin/api/locations
// via updateLocationAction (server action).
//
// Why this card exists separately from Update Package: the locations
// table is the source-of-truth for denormalized fields the rest of the
// system reads off of. Two DB triggers cascade outward:
//   - trg_sync_pricing_simple ON locations AFTER UPDATE — copies the
//     denormalized fields (area_manager, regional_manager, am_email,
//     rm_email, site_email, address) into pricing_simple.
//   - trg_sync_user_permissions ON pricing_simple AFTER UPDATE —
//     propagates email-based permissions into user_permissions.
// Editing those fields anywhere else gets reverted (Update Package
// rejects them with 400 for the same reason). This editor is the ONLY
// supported way to change them.
//
// Layout:
//   1. LocationsSearchPicker at top (typeahead).
//   2. Until a row is selected, the rest of the form is hidden.
//   3. On selection: form inflates with the row's current values
//      pre-filled. Editable: site, location, area_manager,
//      regional_manager, am_email, rm_email, site_email, hrt_email,
//      rm_group.
//   4. Read-only context block below: id, site_number, mla_location,
//      created_at, updated_at — display only.
//   5. Submit: "Save changes". Cancel link: clears picker + resets form.
//
// Hidden inputs that travel with the submit:
//   - selector_kind  (always "id" — the row's PK is the safest selector;
//                     site_number is supported by the worker but the
//                     picker always carries id)
//   - selector_value (the actual row.id from the picker)
//
// Conditional rendering pattern: form is only mounted when `selected`
// is non-null. ActionForm's resetOnSuccess remounts on success — the
// onResult callback clears the selection on success so the picker
// returns to its empty state. Operator picks the next location.

"use client";

import { useState } from "react";
import { ActionForm, type ActionResult } from "../../_components/ActionForm";
import { updateLocationAction } from "../actions";
import {
  LocationsSearchPicker,
  type LocationsSearchRow
} from "./LocationsSearchPicker";

const labelCls =
  "mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const helperCls =
  "ml-2 normal-case tracking-normal text-[0.6875rem] font-normal text-splash-navy/50";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
const submitCls =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";
const cancelLinkCls =
  "text-sm font-semibold text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline";

const CASCADE_HINT =
  "Cascades to pricing_simple + user_permissions via DB triggers. Edits here are the only supported way to change this.";
const CASCADE_HINT_NO_PERMS =
  "Cascades to pricing_simple via DB trigger.";
const LOCATIONS_ONLY_HINT = "Locations table only — no cascade.";

function valueOrEmpty(v: string | null | undefined): string {
  if (v === null || v === undefined) return "";
  return v;
}

export function UpdateLocationCard() {
  const [selected, setSelected] = useState<LocationsSearchRow | null>(null);

  function onResult(result: ActionResult) {
    if (result.ok) {
      setSelected(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="update-loc-search" className={labelCls}>
          Find a location
          <span className={helperCls}>matches site #, name, address, or manager</span>
        </label>
        <LocationsSearchPicker
          inputId="update-loc-search"
          selected={selected}
          onSelect={setSelected}
        />
      </div>

      {selected ? (
        <ActionForm
          key={String(selected.id)}
          action={updateLocationAction}
          onResult={onResult}
          resetOnSuccess={false}
          className="space-y-5"
        >
          {/* Selector hidden inputs ------------------------------- */}
          <input type="hidden" name="selector_kind" value="id" />
          <input
            type="hidden"
            name="selector_value"
            value={String(selected.id)}
          />

          <p className="text-[0.6875rem] italic text-splash-navy/70">
            Editing the email fields below cascades to pricing_simple
            AND grants/revokes permissions in user_permissions.
          </p>

          {/* Editable fields -------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="update-loc-site" className={labelCls}>
                site
                <span className={helperCls}>display name (e.g. Binghamton)</span>
              </label>
              <input
                id="update-loc-site"
                name="site"
                type="text"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.site)}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="update-loc-location" className={labelCls}>
                location
                <span className={helperCls}>postal address</span>
              </label>
              <input
                id="update-loc-location"
                name="location"
                type="text"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.location)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {CASCADE_HINT_NO_PERMS}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-area-manager" className={labelCls}>
                area_manager
              </label>
              <input
                id="update-loc-area-manager"
                name="area_manager"
                type="text"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.area_manager)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {CASCADE_HINT_NO_PERMS}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-regional-manager" className={labelCls}>
                regional_manager
              </label>
              <input
                id="update-loc-regional-manager"
                name="regional_manager"
                type="text"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.regional_manager)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {CASCADE_HINT_NO_PERMS}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-am-email" className={labelCls}>
                am_email
              </label>
              <input
                id="update-loc-am-email"
                name="am_email"
                type="email"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.am_email)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {CASCADE_HINT}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-rm-email" className={labelCls}>
                rm_email
              </label>
              <input
                id="update-loc-rm-email"
                name="rm_email"
                type="email"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.rm_email)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {CASCADE_HINT}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-site-email" className={labelCls}>
                site_email
              </label>
              <input
                id="update-loc-site-email"
                name="site_email"
                type="email"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.site_email)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {CASCADE_HINT}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-hrt-email" className={labelCls}>
                hrt_email
                <span className={helperCls}>optional</span>
              </label>
              <input
                id="update-loc-hrt-email"
                name="hrt_email"
                type="email"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.hrt_email)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {LOCATIONS_ONLY_HINT}
              </p>
            </div>

            <div>
              <label htmlFor="update-loc-rm-group" className={labelCls}>
                rm_group
                <span className={helperCls}>optional</span>
              </label>
              <input
                id="update-loc-rm-group"
                name="rm_group"
                type="text"
                autoComplete="off"
                defaultValue={valueOrEmpty(selected.rm_group)}
                className={inputCls}
              />
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {LOCATIONS_ONLY_HINT}
              </p>
            </div>
          </div>

          {/* Read-only context block ------------------------------ */}
          <ReadOnlyContext row={selected} />

          {/* Actions ---------------------------------------------- */}
          <div className="flex items-center gap-4 pt-1">
            <button type="submit" className={submitCls}>
              Save changes
            </button>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className={cancelLinkCls}
            >
              Cancel / pick another
            </button>
          </div>
        </ActionForm>
      ) : (
        <p className="text-sm italic text-splash-navy/60">
          Pick a location above to edit its denormalized fields.
        </p>
      )}
    </div>
  );
}

function ReadOnlyContext({ row }: { row: LocationsSearchRow }) {
  return (
    <div className="rounded-splash-sm border border-gray-light bg-gray-light/30 p-4">
      <p className="mb-2 text-[0.6875rem] italic text-splash-navy/70">
        Read-only — these fields are auto-managed or part of the row's
        identity. Changing site_number or id is a separate, careful
        operation.
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs text-splash-navy md:grid-cols-2">
        <ReadOnlyField label="id" mono value={String(row.id)} />
        <ReadOnlyField
          label="site_number"
          mono
          value={row.site_number !== null && row.site_number !== undefined ? String(row.site_number) : null}
        />
        <ReadOnlyField label="mla_location" value={(row.mla_location as string | null | undefined) ?? null} />
        <ReadOnlyField
          label="created_at"
          mono
          value={
            row.created_at
              ? row.created_at.replace("T", " ").slice(0, 19)
              : null
          }
        />
        <ReadOnlyField
          label="updated_at"
          mono
          value={
            row.updated_at
              ? row.updated_at.replace("T", " ").slice(0, 19)
              : null
          }
        />
      </dl>
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  mono
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 font-semibold uppercase tracking-wider text-splash-navy/60">
        {label}
      </dt>
      <dd className={`text-splash-navy/80 ${mono ? "font-mono" : ""}`}>
        {value && value.length > 0 ? value : <span className="text-splash-navy/40">—</span>}
      </dd>
    </div>
  );
}
