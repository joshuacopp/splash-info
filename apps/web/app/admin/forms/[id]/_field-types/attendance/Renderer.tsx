import type { AttendanceField, Field } from "@splash/forms-schema";

// Canvas preview: two example rows of name search + signature box.
export default function AttendanceRenderer({ field }: { field: Field }) {
  const f = field as AttendanceField;
  return (
    <div>
      <p className="mb-1 block text-sm font-semibold text-splash-navy">
        {field.label}
        {field.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </p>
      {[1, 2].map((n) => (
        <div key={n} className="mb-2 rounded border border-gray-light bg-white p-2">
          <p className="text-xs font-semibold text-splash-navy/70">Employee {n}</p>
          <input
            disabled
            className="mt-1 w-full rounded border border-gray-light bg-white px-2 py-1.5 text-sm"
            placeholder="Type a name to search"
          />
          <div className="mt-1 h-10 rounded border border-dashed border-gray-light text-center text-xs leading-10 text-splash-navy/40">
            signature
          </div>
        </div>
      ))}
      <div className="rounded border-2 border-dashed border-sudsy-blue/50 py-1.5 text-center text-sm font-semibold text-splash-navy/70">
        + Add employee
      </div>
      <p className="mt-1 text-xs text-splash-navy/60">
        Starts with {f.initialRows ?? 5} rows.{" "}
        {f.keyFieldKey
          ? `Searches employees at the site in "${f.keyFieldKey}".`
          : "Pick the site field in the inspector."}
      </p>
      {field.helpText && <p className="mt-1 text-xs text-splash-navy/60">{field.helpText}</p>}
    </div>
  );
}
