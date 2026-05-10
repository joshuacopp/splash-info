"use client";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  hint?: string;
}

export default function LabeledTextarea({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
  hint
}: Props) {
  return (
    <label className="block text-xs font-semibold text-splash-navy/80">
      {label}
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
      />
      {hint && (
        <span className="mt-1 block font-normal text-[0.7rem] text-splash-navy/60">
          {hint}
        </span>
      )}
    </label>
  );
}
