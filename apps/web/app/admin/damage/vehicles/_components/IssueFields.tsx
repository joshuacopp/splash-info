"use client";

// The parts of the Vehicle Guide form that depend on each other, so they need
// a little state: the category picks which issue types are offered, and the
// "All models" box turns the models box off. Everything else on the form is
// plain server-rendered inputs. The worker re-checks all of it (an issue type
// from the other category, an empty model list without All models).

import { useState } from "react";
import {
  VEHICLE_ISSUE_CATEGORIES,
  vehicleIssueTypesFor,
  type VehicleIssueCategory
} from "@splash/types/vehicle-guide";

const LABEL_CLS = "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none disabled:bg-splash-navy/5 disabled:text-splash-navy/40";

export function CategoryTypeFields({
  defaultCategory,
  defaultType
}: {
  defaultCategory: VehicleIssueCategory;
  defaultType: string;
}) {
  const [category, setCategory] = useState<VehicleIssueCategory>(defaultCategory);
  const types = vehicleIssueTypesFor(category);
  // Keep the saved type while it belongs to the chosen category; otherwise
  // make them pick again rather than silently saving the first option.
  const [type, setType] = useState(defaultType);
  const typeValue = types.some((t) => t.value === type) ? type : "";

  return (
    <>
      <fieldset className="flex flex-col gap-1 sm:col-span-2">
        <legend className={`mb-1 ${LABEL_CLS}`}>Category *</legend>
        <div className="flex flex-wrap gap-2">
          {VEHICLE_ISSUE_CATEGORIES.map((c) => (
            <label
              key={c.value}
              className={`flex cursor-pointer items-center gap-2 rounded-splash-sm border px-3 py-2 text-sm font-semibold ${
                category === c.value
                  ? "border-splash-blue bg-splash-blue/5 text-splash-navy"
                  : "border-gray-light bg-white text-splash-navy/70"
              }`}
            >
              <input
                type="radio"
                name="category"
                value={c.value}
                checked={category === c.value}
                onChange={() => setCategory(c.value)}
              />
              {c.label}
            </label>
          ))}
        </div>
        <span className="text-xs text-splash-navy/60">
          {category === "vehicle"
            ? "A part known to break on this vehicle (weak mounting, a service bulletin). Shown on damage claims for matching vehicles."
            : "How to get this vehicle through the tunnel (neutral, park, safety systems)."}
        </span>
      </fieldset>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className={LABEL_CLS}>Issue type *</span>
        <select
          name="issue_type"
          required
          value={typeValue}
          onChange={(e) => setType(e.target.value)}
          className={INPUT_CLS}
        >
          <option value="" disabled>
            Select…
          </option>
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function ModelsField({ defaultModels }: { defaultModels: string[] | null }) {
  // null = new entry; [] = saved as all models.
  const [all, setAll] = useState(defaultModels !== null && defaultModels.length === 0);
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL_CLS}>Model(s) *</span>
      <input
        name="models"
        required={!all}
        disabled={all}
        maxLength={1000}
        list="vg-models"
        defaultValue={defaultModels?.join(", ") ?? ""}
        placeholder={all ? "Every model" : "Telluride, Sorento"}
        className={INPUT_CLS}
      />
      <span className="flex items-center gap-2 text-xs text-splash-navy/70">
        <input
          type="checkbox"
          name="all_models"
          value="1"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        All models of this make
      </span>
      <span className="text-xs text-splash-navy/60">Separate several models with commas.</span>
    </label>
  );
}
