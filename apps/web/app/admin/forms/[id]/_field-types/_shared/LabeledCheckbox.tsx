"use client";

interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

export default function LabeledCheckbox({ label, checked, onChange, hint }: Props) {
  return (
    <label className="flex items-start gap-2 text-sm text-splash-navy">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
      />
      <span className="flex-1">
        <span className="font-medium">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-xs text-splash-navy/60">{hint}</span>
        )}
      </span>
    </label>
  );
}
