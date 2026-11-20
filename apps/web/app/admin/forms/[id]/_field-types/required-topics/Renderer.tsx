import type { Field, RequiredTopicsField } from "@splash/forms-schema";

// Canvas preview: the real list depends on the month picked at fill time.
export default function RequiredTopicsRenderer({ field }: { field: Field }) {
  const f = field as RequiredTopicsField;
  return (
    <div>
      <p className="mb-1 block text-sm font-semibold text-splash-navy">{field.label}</p>
      <div className="rounded border border-gray-light bg-white px-2 py-1.5 text-sm">
        {["Example required topic", "Another required topic"].map((t) => (
          <label key={t} className="flex items-center gap-2 py-1">
            <input type="checkbox" disabled /> {t}
            <span className="ml-auto text-xs text-splash-navy/50">Covered</span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-splash-navy/60">
        {f.dateFieldKey
          ? `Topics set at /admin/safety-topics for the month of "${f.dateFieldKey}". Each must be ticked.`
          : "Pick the date field in the inspector."}
      </p>
      {field.helpText && <p className="mt-1 text-xs text-splash-navy/60">{field.helpText}</p>}
    </div>
  );
}
