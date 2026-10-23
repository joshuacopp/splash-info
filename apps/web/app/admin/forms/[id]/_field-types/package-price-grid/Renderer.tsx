import type { Field } from "@splash/forms-schema";

// Canvas preview. The real rows depend on the site picked at fill time, so
// the builder shows one illustrative package rather than pretending to know.
export default function PackagePriceGridRenderer({ field }: { field: Field }) {
  return (
    <div>
      <p className="mb-1 block text-sm font-semibold text-splash-navy">
        {field.label}
        {field.required && <span className="ml-0.5 text-racecar-red">*</span>}
      </p>
      <div className="rounded border border-gray-light bg-white p-2 text-sm text-splash-navy/80">
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" disabled checked readOnly />
          <span>Example package</span>
        </label>
        <div className="mt-2 grid grid-cols-[70px_1fr_1fr] gap-x-2 gap-y-1 text-xs">
          <span />
          <span className="font-semibold uppercase text-splash-navy/60">Current</span>
          <span className="font-semibold uppercase text-splash-navy/60">New</span>
          <span>Single</span>
          <input disabled className="rounded border border-gray-light px-1" placeholder="0.00" />
          <input disabled className="rounded border border-gray-light px-1" placeholder="Same as current" />
          <span>Monthly</span>
          <input disabled className="rounded border border-gray-light px-1" placeholder="0.00" />
          <input disabled className="rounded border border-gray-light px-1" placeholder="Same as current" />
        </div>
      </div>
      <p className="mt-1 text-xs text-splash-navy/60">
        Lists the packages at the chosen site when the form is filled in.
      </p>
      {field.helpText && <p className="mt-1 text-xs text-splash-navy/60">{field.helpText}</p>}
    </div>
  );
}
