import type { Field, MultiField } from "@splash/forms-schema";

export default function MultiRenderer({ field }: { field: Field }) {
  const f = field as MultiField;
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </label>
      <div className="space-y-1 rounded border border-gray-light bg-gray-light/30 px-3 py-2">
        {f.options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled className="h-4 w-4" />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
    </div>
  );
}
