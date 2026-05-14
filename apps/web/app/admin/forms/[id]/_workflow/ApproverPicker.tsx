// Brief 125 — "Who approves?" picker.
//
// Single dropdown with three `<optgroup>` sections:
//   1. "From your form" — auto-detected from `state.fields` (lookup
//      fields whose value column is email-shaped; email-type fields;
//      location fields).
//   2. "Specific person" — single picked email (org-directory
//      autosuggest).
//   3. "Multiple people" — tag-input list (org-directory autosuggest).
//
// Selecting an auto-detected option maps to the matching
// `ApproverSource` schema shape. Selecting Specific person / Multiple
// people opens the autosuggest below the dropdown.

"use client";

import { useMemo, useState } from "react";
import type { ApproverSource, Field } from "@splash/forms-schema";

import PersonAutosuggest from "./PersonAutosuggest";

interface Props {
  source: ApproverSource | undefined;
  fields: Field[];
  onChange: (source: ApproverSource | undefined) => void;
  /**
   * Brief 131 — contextualizes the dropdown copy. "approver" (default)
   * is the wording for an approval step's "Who approves this step?"
   * label. "recipient" is the wording for an email step's "Send email
   * to" label, set by EmailStepCard's RecipientsList.
   */
  mode?: "approver" | "recipient";
}

type AutoOption =
  | {
      kind: "lookup_role";
      key: string;
      label: string;
      role: "am_email" | "rm_email" | "site_email";
      sourceFieldKey: string;
      sourceFieldLabel: string;
    }
  | {
      kind: "lookup_email";
      key: string;
      label: string;
      fieldKey: string;
      fieldLabel: string;
    }
  | {
      kind: "email_field";
      key: string;
      label: string;
      fieldKey: string;
      fieldLabel: string;
    }
  | {
      kind: "location_role";
      key: string;
      label: string;
      role: "am_email" | "rm_email" | "site_email";
    };

const ROLE_LABELS: Record<"am_email" | "rm_email" | "site_email", string> = {
  am_email: "Regional Director email",
  rm_email: "Regional Manager email",
  site_email: "Site email"
};

function detectFromFields(fields: Field[]): AutoOption[] {
  const out: AutoOption[] = [];
  let hasLocation = false;
  for (const field of fields) {
    if (field.type === "location") {
      hasLocation = true;
      continue;
    }
    if (field.type === "email") {
      out.push({
        kind: "email_field",
        key: `email_field:${field.key}`,
        label: `Email entered in '${field.label}' field`,
        fieldKey: field.key,
        fieldLabel: field.label
      });
      continue;
    }
    if (field.type === "lookup") {
      const col = field.sourceColumn;
      if (col === "am_email" || col === "rm_email" || col === "site_email") {
        const role = col as "am_email" | "rm_email" | "site_email";
        out.push({
          kind: "lookup_role",
          key: `lookup_role:${role}:${field.key}`,
          label: `${ROLE_LABELS[role]} (resolved via '${field.label}' lookup)`,
          role,
          sourceFieldKey: field.key,
          sourceFieldLabel: field.label
        });
        continue;
      }
      if (col.endsWith("_email") || col === "email") {
        out.push({
          kind: "lookup_email",
          key: `lookup_email:${field.key}`,
          label: `Email from '${field.label}' lookup`,
          fieldKey: field.key,
          fieldLabel: field.label
        });
      }
    }
  }
  if (hasLocation) {
    out.push({
      kind: "location_role",
      key: "location:am_email",
      label: "Regional Director for the picked location",
      role: "am_email"
    });
    out.push({
      kind: "location_role",
      key: "location:rm_email",
      label: "Regional Manager for the picked location",
      role: "rm_email"
    });
    out.push({
      kind: "location_role",
      key: "location:site_email",
      label: "Site email for the picked location",
      role: "site_email"
    });
  }
  return out;
}

// Match a current `source` back to one of the auto-detected dropdown
// options, so that on load the dropdown reflects the right selection.
function sourceToAutoKey(
  source: ApproverSource | undefined,
  options: AutoOption[]
): string | null {
  if (!source) return null;
  if (source.type === "site_role") {
    // `site_role` is now only saved by `location_role` picks (Brief 131
    // — `lookup_role` picks save as `payload_field` because the lookup
    // field's payload value IS the resolved email). Legacy schemas that
    // still carry `site_role` from a lookup-keyed step continue to round-
    // trip through the `lookup_role` selection as a UI courtesy: when a
    // matching lookup option exists we surface it, else fall back to the
    // location_role option.
    const lookupOpt = options.find(
      (o): o is Extract<AutoOption, { kind: "lookup_role" }> =>
        o.kind === "lookup_role" && o.role === source.role
    );
    if (lookupOpt) return lookupOpt.key;
    const locOpt = options.find(
      (o): o is Extract<AutoOption, { kind: "location_role" }> =>
        o.kind === "location_role" && o.role === source.role
    );
    return locOpt?.key ?? null;
  }
  if (source.type === "payload_field") {
    const opt = options.find(
      (o): o is Extract<
        AutoOption,
        { kind: "email_field" | "lookup_email" | "lookup_role" }
      > =>
        (o.kind === "email_field" ||
          o.kind === "lookup_email" ||
          o.kind === "lookup_role") &&
        (o.kind === "lookup_role"
          ? o.sourceFieldKey === source.field_key
          : o.fieldKey === source.field_key)
    );
    return opt?.key ?? null;
  }
  return null;
}

const SPECIFIC_KEY = "__specific__";
const MULTIPLE_KEY = "__multiple__";
const UNSET_KEY = "__unset__";

export default function ApproverPicker({
  source,
  fields,
  onChange,
  mode = "approver"
}: Props) {
  const options = useMemo(() => detectFromFields(fields), [fields]);
  const autoKey = sourceToAutoKey(source, options);
  const isRecipient = mode === "recipient";
  const headerLabel = isRecipient ? "Send email to" : "Who approves this step?";
  const unsetLabel = isRecipient
    ? "— Pick a recipient —"
    : "— Pick an approver —";
  const specificLabel = isRecipient
    ? "Specific person"
    : "Specific person";
  const multipleLabel = isRecipient ? "Multiple recipients" : "Multiple people";

  // Determine which select-option the picker should render as active.
  // Renamed from `mode` in Brief 131 because the prop `mode` ("approver" |
  // "recipient") was shadowing this local — `selectMode` is the active
  // <select> value, not the picker's contextual wording.
  let selectMode: string;
  if (autoKey) selectMode = autoKey;
  else if (source?.type === "static_emails") {
    selectMode = source.emails.length > 1 ? MULTIPLE_KEY : SPECIFIC_KEY;
  } else if (!source) {
    selectMode = UNSET_KEY;
  } else {
    // payload_field that doesn't match a current field — surface as missing
    selectMode = "__missing__";
  }

  const [, forceRerender] = useState(0);

  function pickOption(value: string) {
    if (value === UNSET_KEY) {
      onChange(undefined);
      return;
    }
    if (value === SPECIFIC_KEY) {
      onChange({ type: "static_emails", emails: [] });
      return;
    }
    if (value === MULTIPLE_KEY) {
      onChange({ type: "static_emails", emails: [] });
      return;
    }
    const opt = options.find((o) => o.key === value);
    if (!opt) return;
    if (opt.kind === "lookup_role") {
      // Brief 131 — the lookup field has already resolved the email at
      // submit time, so its payload value IS the email. Save as
      // `payload_field` keyed on the lookup field's `key` (the same
      // identifier the submit handler uses when writing
      // `payload[field.key] = <resolved value>`).
      onChange({
        type: "payload_field",
        field_key: opt.sourceFieldKey
      });
      return;
    }
    if (opt.kind === "location_role") {
      // Location-shaped fields stay `site_role` — the worker resolver
      // finds the location_code in payload and goes through
      // `getLocationContactInfo` to look up the matching contact email.
      onChange({ type: "site_role", role: opt.role });
      return;
    }
    if (opt.kind === "lookup_email" || opt.kind === "email_field") {
      onChange({ type: "payload_field", field_key: opt.fieldKey });
      return;
    }
  }

  const isSpecific = selectMode === SPECIFIC_KEY;
  const isMultiple = selectMode === MULTIPLE_KEY;
  const emails =
    source?.type === "static_emails" ? source.emails : [];

  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold text-splash-navy">
        {headerLabel}
        <select
          value={selectMode}
          onChange={(e) => pickOption(e.currentTarget.value)}
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-2 text-sm font-normal text-splash-navy"
        >
          <option value={UNSET_KEY}>{unsetLabel}</option>
          {options.length > 0 && (
            <optgroup label="From your form">
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={specificLabel}>
            <option value={SPECIFIC_KEY}>Type or pick from org directory…</option>
          </optgroup>
          <optgroup label={multipleLabel}>
            <option value={MULTIPLE_KEY}>Build a list…</option>
          </optgroup>
          {selectMode === "__missing__" && (
            <option value="__missing__" disabled>
              ⚠ Saved {isRecipient ? "recipient" : "approver"} no longer matches a form field
            </option>
          )}
        </select>
      </label>
      {options.length === 0 && (
        <p className="text-xs text-splash-navy/60">
          Options come from your form&apos;s fields. Add a lookup, an email
          field, or a location field on the Fields tab to surface more
          choices here.
        </p>
      )}

      {isSpecific && (
        <div className="space-y-1.5 rounded-splash-sm border border-gray-light bg-sudsy-blue/5 p-2">
          <p className="text-[0.7rem] font-semibold text-splash-navy">
            Specific person
          </p>
          {emails[0] ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-splash-navy ring-1 ring-gray-light">
                {emails[0]}
              </span>
              <button
                type="button"
                onClick={() =>
                  onChange({ type: "static_emails", emails: [] })
                }
                className="text-[0.65rem] text-racecar-red underline"
              >
                Change
              </button>
            </div>
          ) : (
            <PersonAutosuggest
              placeholder="Type a name or email…"
              onPick={(email) =>
                onChange({ type: "static_emails", emails: [email] })
              }
            />
          )}
        </div>
      )}

      {isMultiple && (
        <div className="space-y-1.5 rounded-splash-sm border border-gray-light bg-sudsy-blue/5 p-2">
          <p className="text-[0.7rem] font-semibold text-splash-navy">
            Multiple people
          </p>
          {emails.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {emails.map((e) => (
                <li
                  key={e}
                  className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-splash-navy ring-1 ring-gray-light"
                >
                  {e}
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        type: "static_emails",
                        emails: emails.filter((x) => x !== e)
                      })
                    }
                    className="text-racecar-red"
                    aria-label={`Remove ${e}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <PersonAutosuggest
            placeholder="Add another approver…"
            onPick={(email) => {
              if (emails.includes(email)) {
                forceRerender((n) => n + 1);
                return;
              }
              onChange({
                type: "static_emails",
                emails: [...emails, email]
              });
            }}
          />
        </div>
      )}
    </div>
  );
}
