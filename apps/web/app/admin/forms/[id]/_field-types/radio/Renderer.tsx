import type { RadioField, Field } from "@splash/forms-schema";

export default function RadioRenderer({ field }: { field: Field }) {
  const f = field as RadioField;
  const inline = f.layout === "inline";
  return (
    <div>
      <p className="mb-1 block text-sm font-semibold text-splash-navy">
        {f.label}
        {f.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </p>
      {/* Mirrors the public renderer's inline/vertical split so the canvas
          preview matches what the person filling it in will see. */}
      <div className={inline ? "flex flex-wrap gap-x-5 gap-y-1" : "space-y-1"}>
        {f.options.map((o) => (
          <label
            key={o.value}
            className="flex items-center gap-2 text-sm text-splash-navy/80"
          >
            <input type="radio" disabled readOnly />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {f.helpText && <p className="mt-1 text-xs text-splash-navy/60">{f.helpText}</p>}
    </div>
  );
}
