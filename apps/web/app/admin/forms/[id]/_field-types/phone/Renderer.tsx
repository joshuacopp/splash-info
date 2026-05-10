import type { Field, PhoneField } from "@splash/forms-schema";

export default function PhoneRenderer({ field }: { field: Field }) {
  const f = field as PhoneField;
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </label>
      <input
        type="tel"
        disabled
        placeholder="(555) 123-4567"
        className="w-full rounded border border-gray-light bg-gray-light/30 px-3 py-2 text-sm"
      />
      {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
    </div>
  );
}
