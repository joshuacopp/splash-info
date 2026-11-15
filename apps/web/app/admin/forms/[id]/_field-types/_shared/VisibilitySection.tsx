// "Show only when..." (2026-11-14) -- sets `visible_if` from the builder. Every
// recent form needed it (rewash reasons, warning-notice prior warnings, the
// car count's Bay 2 photo) and it was only settable from generator scripts.
//
// Rules this enforces, matching what the public form can actually do:
//   - The controlling question must be a choice (radio / dropdown / checkboxes).
//     A ticked checkbox counts if ANY ticked value is one of the chosen answers.
//   - ONE LEVEL ONLY. forms-public.js does not cascade visibility, so a field
//     that is itself conditional cannot control another, and a field that
//     controls others cannot be made conditional. Both are refused here with
//     the reason, rather than saved and silently misbehaving on the form.
//   - A hidden required field is not required: the browser skips it and the
//     server only enforces fields it considers visible.

"use client";

import type { Field } from "@splash/forms-schema";

interface Props {
  field: Field;
  allFields: Field[];
  onUpdate: (patch: Partial<Field>) => void;
}

type Option = { label: string; value: string };
const CHOICE_TYPES = ["radio", "dropdown", "multi"];

function optionsOf(f: Field): Option[] {
  const o = (f as { options?: Option[] }).options;
  return Array.isArray(o) ? o : [];
}

export default function VisibilitySection({ field, allFields, onUpdate }: Props) {
  const rule = field.visible_if;
  const controlsOthers = allFields.filter((f) => f.id !== field.id && f.visible_if?.field_key === field.key);
  const candidates = allFields.filter(
    (f) => f.id !== field.id && CHOICE_TYPES.includes(f.type) && !f.visible_if && optionsOf(f).length > 0
  );
  const controller = rule ? allFields.find((f) => f.key === rule.field_key) : undefined;

  const set = (field_key: string | null, equals: string[] = []) =>
    onUpdate({ visible_if: field_key ? { field_key, equals } : undefined } as Partial<Field>);

  if (controlsOthers.length > 0 && !rule) {
    return (
      <section className="rounded-splash-sm border border-gray-light px-3 py-2 text-xs text-splash-navy/70">
        <span className="font-semibold text-splash-navy">Show only when...</span> Not available: other questions
        ({controlsOthers.map((f) => f.label).join(", ")}) depend on this one, and conditions can only be one level deep.
      </section>
    );
  }

  return (
    <section className="space-y-2 rounded-splash-sm border border-gray-light px-3 py-2 text-sm text-splash-navy">
      <label className="block font-semibold">
        Show only when...
        <select
          value={rule?.field_key ?? ""}
          onChange={(e) => set(e.currentTarget.value || null)}
          className="mt-1 block w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal"
        >
          <option value="">Always show</option>
          {candidates.map((f) => (
            <option key={f.id} value={f.key}>
              {f.label || f.key}
            </option>
          ))}
          {rule && !candidates.some((f) => f.key === rule.field_key) ? (
            <option value={rule.field_key}>{controller?.label ?? rule.field_key} (no longer usable)</option>
          ) : null}
        </select>
      </label>

      {rule && controller ? (
        <div>
          <p className="text-xs text-splash-navy/70">...the answer is any of:</p>
          <div className="mt-1 space-y-1">
            {optionsOf(controller).map((o) => {
              const on = rule.equals.includes(o.value);
              return (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      set(rule.field_key, on ? rule.equals.filter((v) => v !== o.value) : [...rule.equals, o.value])
                    }
                  />
                  {o.label}
                </label>
              );
            })}
          </div>
          {rule.equals.length === 0 ? (
            <p className="mt-1 text-xs text-amber-800">Tick at least one answer, or this question never shows.</p>
          ) : null}
          {controlsOthers.length > 0 ? (
            <p className="mt-1 text-xs text-red-700">
              Other questions depend on this one ({controlsOthers.map((f) => f.label).join(", ")}). Conditions can only
              be one level deep, so remove this condition or theirs.
            </p>
          ) : null}
        </div>
      ) : null}
      {rule && !controller ? (
        <p className="text-xs text-red-700">The question this depended on was removed. Pick another or choose Always show.</p>
      ) : null}
      {!rule && candidates.length === 0 ? (
        <p className="text-xs text-splash-navy/60">Add a multiple-choice, dropdown or checkbox question first to make this conditional.</p>
      ) : null}
    </section>
  );
}
