import type { Field, LocationField } from "@splash/forms-schema";

export default function LocationRenderer({ field }: { field: Field }) {
  const f = field as LocationField;
  const sample =
    f.displayFormat === "site_number"
      ? "147 — Oswego"
      : f.displayFormat === "name_and_address"
        ? "Oswego — 123 Main St"
        : "Oswego";
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
        <option>— Select a location —</option>
        <option>{sample}</option>
      </select>
      <p className="mt-1 text-xs text-splash-navy/60">
        {f.helpText ??
          "Sourced from pricing_simple at render time. Stored value is location_code (slug)."}
      </p>
    </div>
  );
}
