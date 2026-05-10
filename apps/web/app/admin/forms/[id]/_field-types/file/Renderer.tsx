import type { Field, FileField } from "@splash/forms-schema";

export default function FileRenderer({ field }: { field: Field }) {
  const f = field as FileField;
  const accept = f.allowedMimeTypes?.join(", ") ?? "*/*";
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </label>
      <input
        type="file"
        disabled
        multiple={f.allowMultiple}
        accept={accept}
        className="block w-full text-sm text-splash-navy/60"
      />
      <p className="mt-1 text-xs text-splash-navy/60">
        {f.helpText ??
          `Up to ${f.maxSizeMb ?? 10} MB. Accepts ${f.allowedMimeTypes?.join(", ") ?? "any file"}.`}
      </p>
    </div>
  );
}
