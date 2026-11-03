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
  /** Phone layout: up/down buttons replace the drag handle, because a drag
   *  gesture on a touch screen fights the page scroll. */
  narrow?: boolean;
  onMove?: (id: string, direction: -1 | 1) => void;
}

export default function Canvas({
  fields,
  selectedFieldId,
  onSelect,
  onDelete,
  onDuplicate,
  narrow = false,
  onMove
}: Props) {
  return (
    <section
      className={
        narrow
          ? "min-w-0 rounded-splash-md border border-gray-light bg-white px-3 py-3"
          : "min-h-[400px] min-w-0 flex-1 overflow-y-auto rounded-splash-md border border-gray-light bg-white px-4 py-3"
      }
    >
      {fields.length === 0 ? (
        <div className="flex h-full min-h-[200px] items-center justify-center text-center text-sm italic text-splash-navy/60">
          {narrow
            ? "No fields yet. Tap “+ Add field” to start."
            : "Empty canvas. Add fields from the palette on the left."}
        </div>
      ) : (
        <ul className="space-y-3">
          {fields.map((field, i) => (
            <CanvasField
              key={field.id}
              field={field}
              selected={selectedFieldId === field.id}
              onSelect={() => onSelect(field.id)}
              onDelete={() => onDelete(field.id)}
              onDuplicate={() => onDuplicate(field.id)}
              narrow={narrow}
              onMoveUp={i > 0 && onMove ? () => onMove(field.id, -1) : undefined}
              onMoveDown={i < fields.length - 1 && onMove ? () => onMove(field.id, 1) : undefined}
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
  narrow: boolean;
  /** Undefined = no field in that direction (first / last). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function CanvasField({
  field,
  selected,
  onSelect,
  onDelete,
  onDuplicate,
  narrow,
  onMoveUp,
  onMoveDown
}: CanvasFieldProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.id, disabled: narrow });

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

  // Bigger hit areas on touch screens; the desktop icons stay compact.
  const iconBtn = narrow
    ? "rounded px-2.5 py-1.5 text-sm disabled:opacity-25"
    : "rounded px-2 py-0.5 text-xs";

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
      className={`cursor-pointer rounded-splash-md border bg-white p-3 ${borderClass}`}
    >
      {/* Header row: label on the left (wraps on narrow screens), controls on
          the right. The controls used to be absolutely positioned over the
          header and covered it at narrow widths. */}
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.65rem] uppercase tracking-wide text-splash-navy/50">
          <span>{mod.label}</span>
          <span className="break-all font-mono normal-case text-splash-navy/40">{field.key}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {narrow ? (
            <>
              <button
                type="button"
                disabled={!onMoveUp}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveUp?.();
                }}
                aria-label="Move field up"
                className={`${iconBtn} text-splash-navy/70`}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={!onMoveDown}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveDown?.();
                }}
                aria-label="Move field down"
                className={`${iconBtn} text-splash-navy/70`}
              >
                ↓
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            aria-label="Duplicate field"
            className={`${iconBtn} text-splash-navy/70 hover:bg-sudsy-blue-soft/40`}
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
            className={`${iconBtn} text-racecar-red hover:bg-racecar-red/10`}
          >
            ✕
          </button>
          {narrow ? null : (
            <button
              type="button"
              aria-label="Drag to reorder"
              className={`${iconBtn} cursor-grab text-splash-navy/70 hover:bg-sudsy-blue-soft/40 active:cursor-grabbing`}
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
            >
              ⋮⋮
            </button>
          )}
        </div>
      </div>
      <Renderer field={field} />
    </li>
  );
}
