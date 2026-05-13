// Brief 119 — schema-union column computation for the wide-table view.
//
// Inputs: the list of submissions returned from `?include=payload`. Each
// row carries its specific version's schema (the version it was submitted
// against — not the form's current).
//
// Output: an ordered list of answer columns. Most-recent-version field
// order wins for keys present there; fields that only appear on older
// versions get appended in alphabetical key order at the end. Display-only
// `heading` / `image` field types are skipped (no payload value).

import type { Field, FormSchema } from "@splash/forms-schema";
import type { SubmissionListItem } from "../../../_lib/worker-fetch";

export interface AnswerColumn {
  key: string;
  label: string;
  field: Field;
}

export function computeSchemaUnion(items: SubmissionListItem[]): AnswerColumn[] {
  const byVersion = new Map<number, FormSchema>();
  let mostRecent: { versionNumber: number; schema: FormSchema } | null = null;

  for (const item of items) {
    if (!item.version) continue;
    const v = item.version.version_number;
    if (!byVersion.has(v)) byVersion.set(v, item.version.schema);
    if (mostRecent === null || v > mostRecent.versionNumber) {
      mostRecent = { versionNumber: v, schema: item.version.schema };
    }
  }

  if (!mostRecent) return [];

  const cols: AnswerColumn[] = [];
  const seen = new Set<string>();

  for (const f of mostRecent.schema.fields) {
    if (f.type === "heading" || f.type === "image") continue;
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    cols.push({ key: f.key, label: f.label, field: f });
  }

  const olderExtras: AnswerColumn[] = [];
  for (const [versionNumber, schema] of byVersion) {
    if (versionNumber === mostRecent.versionNumber) continue;
    for (const f of schema.fields) {
      if (f.type === "heading" || f.type === "image") continue;
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      olderExtras.push({ key: f.key, label: f.label, field: f });
    }
  }
  olderExtras.sort((a, b) => a.key.localeCompare(b.key));
  cols.push(...olderExtras);

  return cols;
}
