import type { DropdownField, Field } from "@splash/forms-schema";

export default function DropdownRenderer({ field }: { field: Field }) {
  const f = field as DropdownField;
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </label>
      <select
        disabled
        className="w-full rounded border border-gray-light bg-gray-light/30 px-3 py-2 text-sm"
      >
        <option>{f.placeholder ?? "— Select an option —"}</option>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
    </div>
  );
}
