"use client";

import { useSortable } from "@dnd-kit/sortable";
import type { Field } from "@splash/forms-schema";

function transformToCss(transform: { x: number; y: number; scaleX: number; scaleY: number } | null) {
  if (!transform) return undefined;
  return `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`;
}

import { getFieldModule } from "../_field-types";

interface Props {
  fields: Field[];
  selectedFieldId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}

export default function Canvas({
  fields,
  selectedFieldId,
  onSelect,
  onDelete,
  onDuplicate
}: Props) {
  return (
    <section className="min-h-[400px] flex-1 overflow-y-auto rounded-splash-md border border-gray-light bg-white px-4 py-3">
      {fields.length === 0 ? (
        <div className="flex h-full min-h-[300px] items-center justify-center text-sm italic text-splash-navy/60">
          Empty canvas. Add fields from the palette on the left.
        </div>
      ) : (
        <ul className="space-y-3">
          {fields.map((field) => (
            <CanvasField
              key={field.id}
              field={field}
              selected={selectedFieldId === field.id}
              onSelect={() => onSelect(field.id)}
              onDelete={() => onDelete(field.id)}
              onDuplicate={() => onDuplicate(field.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface CanvasFieldProps {
  field: Field;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function CanvasField({
  field,
  selected,
  onSelect,
  onDelete,
  onDuplicate
}: CanvasFieldProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.id });

  const mod = getFieldModule(field.type);
  const Renderer = mod.Renderer;

  const style = {
    transform: transformToCss(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  const borderClass = selected
    ? "border-splash-blue ring-2 ring-splash-blue/20"
    : "border-gray-light hover:border-splash-blue/40";

  return (
    <li
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      className={`relative cursor-pointer rounded-splash-md border bg-white p-3 ${borderClass}`}
    >
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
          aria-label="Duplicate field"
          className="rounded px-2 py-0.5 text-xs text-splash-navy/70 hover:bg-sudsy-blue-soft/40"
        >
          ⧉
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete field"
          className="rounded px-2 py-0.5 text-xs text-racecar-red hover:bg-racecar-red/10"
        >
          ✕
        </button>
        <button
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab rounded px-2 py-0.5 text-xs text-splash-navy/70 hover:bg-sudsy-blue-soft/40 active:cursor-grabbing"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          ⋮⋮
        </button>
      </div>
      <div className="mb-1 flex items-center gap-2 text-[0.65rem] uppercase tracking-wide text-splash-navy/50">
        <span>{mod.label}</span>
        <span className="font-mono normal-case text-splash-navy/40">
          {field.key}
        </span>
      </div>
      <Renderer field={field} />
    </li>
  );
}
