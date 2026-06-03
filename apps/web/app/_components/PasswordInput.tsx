"use client";

import { useState } from "react";

export interface PasswordInputProps {
  id: string;
  name?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Optional aria-describedby for the live requirements list. */
  describedBy?: string;
  /** Defaults to "Show password". */
  showLabel?: string;
  /** Defaults to "Hide password". */
  hideLabel?: string;
}

export default function PasswordInput({
  id,
  name,
  value,
  onChange,
  autoComplete,
  required,
  placeholder,
  autoFocus,
  describedBy,
  showLabel = "Show password",
  hideLabel = "Hide password"
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-describedby={describedBy}
        className="block h-10 w-full rounded-splash-sm border-[1.5px] border-gray-light pl-3 pr-16 text-base outline-none focus:border-splash-blue focus:ring-2 focus:ring-sudsy-blue/30"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? hideLabel : showLabel}
        className="absolute inset-y-0 right-0 flex items-center gap-1 px-3 text-xs font-semibold text-splash-blue hover:text-splash-blue-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-sudsy-blue/40 rounded-r-splash-sm"
      >
        <EyeIcon hidden={visible} />
        <span>{visible ? "Hide" : "Show"}</span>
      </button>
    </div>
  );
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  if (hidden) {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a19.7 19.7 0 0 1 4.22-5.06" />
        <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a19.6 19.6 0 0 1-3.16 4.19" />
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
