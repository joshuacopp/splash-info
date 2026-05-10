import type { Field, LookupField } from "@splash/forms-schema";

export default function LookupRenderer({ field }: { field: Field }) {
  const f = field as LookupField;
  if (f.resolutionMode === "prefill_hidden") {
    return (
      <div className="rounded border border-dashed border-gray-light bg-sudsy-blue-soft/20 px-3 py-2 text-xs text-splash-navy/70">
        <span className="font-semibold">Lookup (hidden):</span>{" "}
        <code className="font-mono">{f.key}</code>
        <span className="ml-2 text-splash-navy/60">
          ← {f.sourceTable}.{f.sourceColumn}
        </span>
      </div>
    );
  }
  if (f.resolutionMode === "display_only") {
    return (
      <div>
        <p className="mb-1 text-sm font-semibold text-splash-navy">{f.label}</p>
        <div className="rounded border border-gray-light bg-sudsy-blue-soft/20 px-3 py-2 text-sm italic text-splash-navy/70">
          (resolved from {f.sourceTable}.{f.sourceColumn} when key field is filled)
        </div>
        {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
      </div>
    );
  }
  // prefill_visible
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </label>
      <input
        type="text"
        disabled
        placeholder={`Resolved from ${f.sourceTable}.${f.sourceColumn}`}
        className="w-full rounded border border-gray-light bg-gray-light/30 px-3 py-2 text-sm"
      />
      {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
    </div>
  );
}
