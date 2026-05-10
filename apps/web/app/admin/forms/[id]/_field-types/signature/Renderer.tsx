import type { Field, SignatureField } from "@splash/forms-schema";

export default function SignatureRenderer({ field }: { field: Field }) {
  const f = field as SignatureField;
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </label>
      <div className="flex h-28 items-center justify-center rounded border border-dashed border-gray-light bg-gray-light/30 text-xs italic text-splash-navy/50">
        Signature pad — sign-area placeholder
      </div>
      {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
    </div>
  );
}
