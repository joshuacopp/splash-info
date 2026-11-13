import type { EmployeeField, Field } from "@splash/forms-schema";

// Canvas preview. Who appears depends on the site picked at fill time, so the
// builder shows the search box and one example result.
export default function EmployeeRenderer({ field }: { field: Field }) {
  const f = field as EmployeeField;
  return (
    <div>
      <p className="mb-1 block text-sm font-semibold text-splash-navy">
        {field.label}
        {field.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </p>
      <input
        disabled
        className="w-full rounded border border-gray-light bg-white px-2 py-1.5 text-sm"
        placeholder="Type a name…"
      />
      <div className="mt-1 rounded border border-gray-light bg-white px-2 py-1.5 text-sm">
        <span className="block font-semibold text-splash-navy">Example Employee</span>
        <span className="block text-xs text-splash-navy/60">Customer Service Advisor · Site (000)</span>
      </div>
      <p className="mt-1 text-xs text-splash-navy/60">
        {f.keyFieldKey
          ? `Searches employees at the site in "${f.keyFieldKey}".`
          : "Pick the site field in the inspector."}
        {f.allowTyped === false ? " Must be picked from the list." : " A name can be typed if nobody matches."}
      </p>
      {field.helpText && <p className="mt-1 text-xs text-splash-navy/60">{field.helpText}</p>}
    </div>
  );
}
