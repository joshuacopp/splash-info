// Add/remove/reorder a list of {value, label} option pairs. Used by the
// Dropdown and Multi inspectors.

"use client";

import type { DropdownOption } from "@splash/forms-schema";

interface Props {
  options: DropdownOption[];
  onChange: (options: DropdownOption[]) => void;
}

export default function OptionListEditor({ options, onChange }: Props) {
  function update(index: number, patch: Partial<DropdownOption>) {
    onChange(options.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  }
  function remove(index: number) {
    onChange(options.filter((_, i) => i !== index));
  }
  function move(index: number, delta: number) {
    const next = [...options];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange(next);
  }
  function add() {
    onChange([
      ...options,
      { value: `option_${options.length + 1}`, label: `Option ${options.length + 1}` }
    ]);
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-splash-navy/80">Options</p>
      {options.length === 0 && (
        <p className="text-xs italic text-splash-navy/60">
          No options yet. Add one below.
        </p>
      )}
      {options.map((opt, i) => (
        <div
          key={i}
          className="flex items-center gap-1 rounded-splash-sm border border-gray-light bg-white p-1.5"
        >
          <div className="flex flex-1 flex-col gap-1">
            <input
              type="text"
              value={opt.label}
              onChange={(e) => update(i, { label: e.currentTarget.value })}
              placeholder="Label"
              className="rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-xs text-splash-navy"
            />
            <input
              type="text"
              value={opt.value}
              onChange={(e) => update(i, { value: e.currentTarget.value })}
              placeholder="value (stored)"
              className="rounded-splash-sm border border-gray-light bg-white px-2 py-1 font-mono text-[0.7rem] text-splash-navy/80"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
              className="rounded px-1.5 text-xs text-splash-navy/70 hover:bg-sudsy-blue-soft/40 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === options.length - 1}
              aria-label="Move down"
              className="rounded px-1.5 text-xs text-splash-navy/70 hover:bg-sudsy-blue-soft/40 disabled:opacity-30"
            >
              ↓
            </button>
          </div>
          <button
            type="button"
            onClick={() => remove(i)}
            aria-label="Remove option"
            className="rounded px-2 py-1 text-xs text-racecar-red hover:bg-racecar-red/10"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="w-full rounded-splash-sm border border-dashed border-splash-blue/60 bg-white px-2 py-1.5 text-xs font-semibold text-splash-blue hover:bg-splash-blue/5"
      >
        + Add option
      </button>
    </div>
  );
}
