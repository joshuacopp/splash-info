// Brief 176 — turn ticked questions into action_items rows.
//
// Runs once per fresh submission, after the row lands and `location_code` is
// resolved. Reads `payload._action_items` (written by parse.ts from the
// schema, not from the form data) and inserts one row per ticked question.
//
// FAIL-SOFT ON PURPOSE. A failure here must not reverse the submission: losing
// a 73-question site visit is far worse than losing rows that can be rebuilt,
// and they can ALWAYS be rebuilt, because the ticks live in the payload. This
// table is a materialization of the submission, not the source of truth.
//
// DEFAULTS, because fill-time is tick-only (Brief 176 operator decision). The
// RM taps a box while walking a property; describing, prioritising and dating
// the item happens afterwards on the action items page, where there is a
// keyboard.

import {
  ACTION_ITEM_PAYLOAD_KEY,
  ACTION_ITEM_NOTES_PAYLOAD_KEY,
  type Field,
  type FormSchema
} from "@splash/forms-schema";
import type { Env } from "../index.js";

/** Days from submission to the default due date. Deliberately generous: it is
 *  a placeholder the RM adjusts, and a default that is already overdue trains
 *  people to ignore the due date entirely. */
const DEFAULT_DUE_DAYS = 14;

/** Matches the DB check constraint. Worker-side too so an over-long label
 *  truncates rather than 400-ing the whole batch. */
const DESCRIPTION_MAX = 5000;

/** Built from a char code so the escape cannot be eaten by tooling on its
 *  way into this file -- it already was once. */
const NEWLINE = String.fromCharCode(10);

export interface ActionItemInsertResult {
  attempted: number;
  inserted: number;
  error: string | null;
}

/**
 * Due date in EASTERN, not UTC. `due_date` is a DATE — a calendar day at the
 * site — so deriving it from a UTC instant shifts it a day for anything
 * submitted after 8pm ET. Mirrors the two-pass offset resolution in
 * workorders-worker's eastern-time.ts, kept local because forms-worker has no
 * dependency on that package and one date helper does not justify one.
 */
export function easternDuePlusDays(at: Date, days: number): string {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const y = Number(parts.get("year"));
  const m = Number(parts.get("month"));
  const d = Number(parts.get("day"));
  // Arithmetic on a UTC-midnight anchor of the Eastern calendar date: adding
  // days to a date has no DST hazard once the date itself is correct.
  const anchor = new Date(Date.UTC(y, m - 1, d));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** One line of context for the item, from whatever the question was answered
 *  with. Objects (file / signature refs) have no useful one-line form, so they
 *  contribute nothing rather than "[object Object]".
 *
 *  Choice fields store the option VALUE ("fail"); this renders the LABEL
 *  ("Fail"), because the snapshot is denormalized and permanent -- it is read
 *  by a site weeks later with no access to the option table, and every other
 *  surface in the codebase maps value to label before showing it. */
function snapshotOf(value: unknown, field?: Field): string | null {
  const labelFor = (v: string): string => {
    if (
      field &&
      (field.type === "radio" || field.type === "dropdown" || field.type === "multi")
    ) {
      return field.options.find((o) => o.value === v)?.label ?? v;
    }
    return v;
  };
  if (value == null || value === "") return null;
  if (typeof value === "string") return labelFor(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const flat = (value.filter((v) => typeof v === "string") as string[]).map(labelFor);
    return flat.length > 0 ? flat.join(", ").slice(0, 500) : null;
  }
  return null;
}

/** One derived action item, before anything that needs a submission row.
 *  Exported because the PDF's corrective-action table is built from these
 *  too -- see `deriveActionItemRows`. */
export interface DerivedActionItem {
  field_key: string;
  question_label: string;
  answer_snapshot: string | null;
  description: string;
  priority: string;
  due_date: string;
}

/**
 * Everything the ticks in a payload imply, with nothing that needs the
 * database. Pure, so it can run before the submission row exists.
 *
 * SHARED WITH THE PDF ON PURPOSE. The completed-form PDF prints a corrective
 * action table, and the natural way to build it would be to read `action_items`
 * back. That does not work at the only moment the PDF is generated: the email
 * cascade runs BEFORE the submission insert and long before the action items
 * are written, so the table would come out empty, silently. Deriving both the
 * table and the inserted rows from this one function means the paper record and
 * the worklist cannot disagree -- and a second implementation of "what does a
 * tick mean" is exactly the kind of drift that goes unnoticed for months.
 */
export function deriveActionItemRows(args: {
  schema: FormSchema;
  payload: Record<string, unknown>;
  submittedAt: Date;
}): DerivedActionItem[] {
  const raw = args.payload[ACTION_ITEM_PAYLOAD_KEY];
  const ticked = Array.isArray(raw)
    ? (raw.filter((k) => typeof k === "string") as string[])
    : [];
  if (ticked.length === 0) return [];

  const rawNotes = args.payload[ACTION_ITEM_NOTES_PAYLOAD_KEY];
  const notes: Record<string, unknown> =
    rawNotes && typeof rawNotes === "object" && !Array.isArray(rawNotes)
      ? (rawNotes as Record<string, unknown>)
      : {};

  /** Tolerates a bare string as well as a list: the first shipped shape of
   *  this key was one note per question, and a submission written under it
   *  must still regenerate correctly.
   *
   *  The string branch SPLITS, exactly as parse.ts does for the live shape.
   *  Returning the raw string instead gave back-compat different semantics
   *  from the current path -- one item carrying embedded newlines rather than
   *  one item per line -- which contradicts what the form itself promises
   *  under the tick box, and hands a multi-line string to PDF text drawing,
   *  which cannot encode a newline and throws. */
  const noteLinesFor = (key: string): string[] => {
    const rawLine = notes[key];
    if (typeof rawLine === "string") {
      return rawLine
        .split(NEWLINE)
        .map((l) => l.trim())
        .filter((l) => l !== "");
    }
    if (Array.isArray(rawLine)) {
      return rawLine
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    }
    return [];
  };

  const dueDate = easternDuePlusDays(args.submittedAt, DEFAULT_DUE_DAYS);
  const byKey = new Map(args.schema.fields.map((f) => [f.key, f]));

  return ticked.flatMap((key) => {
    const field = byKey.get(key);
    // The tick came from the schema, so this should not miss. If it somehow
    // does, skip rather than inventing a label for a question nobody asked.
    if (!field) {
      console.error(`[forms.action-items] ticked key "${key}" not in schema`);
      return [];
    }
    const label = (field.label || key).slice(0, DESCRIPTION_MAX);
    // The notes are what the person actually SAW; the question label is only
    // where they were standing. ONE ROW PER LINE, because one question
    // routinely produces several separate jobs -- mulch and weeds are not the
    // same task and should not close together. No lines falls back to a single
    // row described by the label, so an un-noted tick still produces something
    // usable rather than nothing.
    const lines = noteLinesFor(key);
    const descriptions = lines.length > 0 ? lines : [label];
    const snapshot = snapshotOf(args.payload[key], field);
    return descriptions.map((d) => ({
      field_key: key,
      question_label: label,
      answer_snapshot: snapshot,
      description: d.slice(0, DESCRIPTION_MAX),
      priority: "Medium",
      due_date: dueDate
    }));
  });
}

export async function createActionItemsForSubmission(
  env: Env,
  args: {
    submissionId: string;
    locationCode: string | null;
    schema: FormSchema;
    payload: Record<string, unknown>;
    submittedAt: Date;
    createdBy: string | null;
  }
): Promise<ActionItemInsertResult> {
  const raw = args.payload[ACTION_ITEM_PAYLOAD_KEY];
  const ticked = Array.isArray(raw)
    ? (raw.filter((k) => typeof k === "string") as string[])
    : [];
  if (ticked.length === 0) return { attempted: 0, inserted: 0, error: null };

  // An action item with no site is unreachable: every read path filters by
  // location. Better to refuse loudly than to write orphans nobody can see.
  if (!args.locationCode) {
    const error = "submission has no location_code; action items need a site";
    console.error(`[forms.action-items] ${error} (submission=${args.submissionId})`);
    return { attempted: ticked.length, inserted: 0, error };
  }

  const rows = deriveActionItemRows({
    schema: args.schema,
    payload: args.payload,
    submittedAt: args.submittedAt
  }).map((r) => ({
    submission_id: args.submissionId,
    location_code: args.locationCode,
    field_key: r.field_key,
    question_label: r.question_label,
    answer_snapshot: r.answer_snapshot,
    description: r.description,
    priority: r.priority,
    due_date: r.due_date,
    status: "open",
    created_by: args.createdBy
  }));

  if (rows.length === 0) return { attempted: ticked.length, inserted: 0, error: null };

  try {
    const url = new URL("/rest/v1/action_items", env.SUPABASE_URL);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(rows)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const error = `${resp.status}: ${text.slice(0, 200)}`;
      console.error(`[forms.action-items] insert failed ${error}`);
      return { attempted: ticked.length, inserted: 0, error };
    }
    console.log(
      `[forms.action-items] created ${rows.length} for submission=${args.submissionId} location=${args.locationCode}`
    );
    return { attempted: ticked.length, inserted: rows.length, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[forms.action-items] insert threw", err);
    return { attempted: ticked.length, inserted: 0, error };
  }
}
