"use client";

interface Option {
  value: string;
  label: string;
}

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  hint?: string;
}

export default function LabeledSelect({ label, value, onChange, options, hint }: Props) {
  return (
    <label className="block text-xs font-semibold text-splash-navy/80">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <span className="mt-1 block font-normal text-[0.7rem] text-splash-navy/60">
          {hint}
        </span>
      )}
    </label>
  );
}
