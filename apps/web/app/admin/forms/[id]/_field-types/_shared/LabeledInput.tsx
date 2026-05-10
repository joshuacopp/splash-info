"use client";

import { type InputHTMLAttributes } from "react";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: InputHTMLAttributes<HTMLInputElement>["type"];
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}

export default function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  disabled
}: Props) {
  return (
    <label className="block text-xs font-semibold text-splash-navy/80">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy disabled:bg-gray-light/40"
      />
      {hint && (
        <span className="mt-1 block font-normal text-[0.7rem] text-splash-navy/60">
          {hint}
        </span>
      )}
    </label>
  );
}
