"use client";

import type { FieldType } from "@splash/forms-schema";
import { FIELD_TYPE_REGISTRY } from "../_field-types";

interface Props {
  onAdd: (type: FieldType) => void;
  onAddScopeField: () => void;
}

export default function Palette({ onAdd, onAddScopeField }: Props) {
  return (
    <aside className="flex w-44 shrink-0 flex-col gap-2 border-r border-gray-light pr-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
        Add field
      </h2>
      <ul className="space-y-1">
        {FIELD_TYPE_REGISTRY.map((m) => (
          <li key={m.type}>
            <button
              type="button"
              onClick={() => onAdd(m.type)}
              className="block w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-left text-sm text-splash-navy hover:border-splash-blue hover:bg-splash-blue/5"
            >
              {m.label}
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mt-3 text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
        Scoping
      </h2>
      <button
        type="button"
        onClick={onAddScopeField}
        title="Adds a required short-text field keyed site_number. Its value resolves to a location so location admins see only their site's submissions."
        className="block w-full rounded-splash-sm border border-splash-blue/40 bg-splash-blue/5 px-2 py-1.5 text-left text-sm font-semibold text-splash-blue hover:border-splash-blue hover:bg-splash-blue/10"
      >
        Site number
      </button>
    </aside>
  );
}
