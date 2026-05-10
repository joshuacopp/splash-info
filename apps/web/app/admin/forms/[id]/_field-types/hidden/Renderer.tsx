import type { Field, HiddenField } from "@splash/forms-schema";

export default function HiddenRenderer({ field }: { field: Field }) {
  const f = field as HiddenField;
  return (
    <div className="rounded border border-dashed border-gray-light bg-sudsy-blue-soft/20 px-3 py-2 text-xs text-splash-navy/70">
      <span className="font-semibold">Hidden field:</span>{" "}
      <code className="font-mono">{f.key}</code>
      {f.defaultValueFromUrlParam && (
        <span className="ml-2">
          ← URL param <code className="font-mono">?{f.defaultValueFromUrlParam}</code>
        </span>
      )}
      {!f.defaultValueFromUrlParam && f.defaultValue !== undefined && (
        <span className="ml-2">
          ← default <code className="font-mono">"{f.defaultValue}"</code>
        </span>
      )}
    </div>
  );
}
