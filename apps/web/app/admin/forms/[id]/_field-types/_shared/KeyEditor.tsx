// Snake_case key editor for the inspector. Per Brief 95 spec, the regex is
// ^[a-z][a-z0-9_]*$ — first char must be a lowercase letter, remaining must
// be lowercase letters / digits / underscores. The editor blocks invalid
// keystrokes by stripping them on input (rather than red-squiggle warnings)
// so the operator can't end up with a half-typed bad key.

"use client";

const VALID_RE = /^[a-z][a-z0-9_]*$/;

function sanitize(raw: string): string {
  // Lowercase, drop everything outside [a-z0-9_], and ensure first char
  // is a letter (drop leading digits/underscores).
  let s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
  while (s.length > 0) {
    const first = s[0] ?? "";
    if (/[a-z]/.test(first)) break;
    s = s.slice(1);
  }
  return s;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}

export default function KeyEditor({ value, onChange, hint }: Props) {
  const isValid = VALID_RE.test(value);
  return (
    <label className="block text-xs font-semibold text-splash-navy/80">
      Key
      <input
        type="text"
        value={value}
        onChange={(e) => {
          const cleaned = sanitize(e.currentTarget.value);
          onChange(cleaned);
        }}
        className={`mt-1 w-full rounded-splash-sm border bg-white px-2 py-1.5 font-mono text-sm font-normal text-splash-navy ${
          isValid ? "border-gray-light" : "border-racecar-red"
        }`}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="mt-1 block font-normal text-[0.7rem] text-splash-navy/60">
        {hint ??
          "Snake_case payload key. Lowercase letters, digits, underscores; must start with a letter."}
      </span>
      {!isValid && (
        <span className="mt-0.5 block font-normal text-[0.7rem] text-racecar-red">
          Invalid key — must match /^[a-z][a-z0-9_]*$/
        </span>
      )}
    </label>
  );
}
