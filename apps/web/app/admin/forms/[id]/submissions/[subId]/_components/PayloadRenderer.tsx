// Brief 96 — submission payload renderer for the detail page.
//
// Iterates the submission's specific schema (NOT the form's current schema —
// past submissions render against THEIR version per planning Decision 1)
// and renders each non-display field's value with light type-aware
// formatting. Unknown / extra payload keys (operator hand-edited the
// JSONB, or schema evolved) render in a "Other payload entries" appendix
// at the bottom so nothing silently disappears.

import type {
  Field,
  FormSchema,
  DropdownField,
  MultiField,
  LookupField
} from "@splash/forms-schema";
import type { SubmissionFile } from "../../../../_lib/worker-fetch";

interface Props {
  schema: FormSchema;
  payload: Record<string, unknown>;
  files: SubmissionFile[];
  formId: string;
}

export default function PayloadRenderer({ schema, payload, files }: Props) {
  const filesByKey = new Map<string, SubmissionFile[]>();
  for (const f of files) {
    const arr = filesByKey.get(f.field_key);
    if (arr) arr.push(f);
    else filesByKey.set(f.field_key, [f]);
  }

  const renderedKeys = new Set<string>();

  const fieldRows = schema.fields
    .filter((f) => f.type !== "heading" && f.type !== "image")
    .map((f) => {
      renderedKeys.add(f.key);
      const value = payload[f.key];
      const fieldFiles = filesByKey.get(f.key) ?? [];
      return (
        <div
          key={f.id}
          className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[200px_1fr] sm:gap-4"
        >
          <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
            {f.label}
            <span className="ml-1 font-mono text-[10px] text-splash-navy/40">
              {f.key}
            </span>
          </dt>
          <dd className="text-sm text-splash-navy">
            <FieldValue
              field={f}
              value={value}
              files={fieldFiles}
              schema={schema}
            />
          </dd>
        </div>
      );
    });

  const extraEntries = Object.entries(payload).filter(
    ([k]) => !renderedKeys.has(k)
  );

  return (
    <div className="overflow-hidden rounded-splash-md border border-gray-light bg-white">
      <dl className="divide-y divide-gray-light">{fieldRows}</dl>
      {extraEntries.length > 0 && (
        <div className="border-t border-gray-light bg-gray-light/30 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
            Other payload entries
          </p>
          <p className="mb-2 text-xs text-splash-navy/60">
            Keys present in the JSONB payload but not in this version&rsquo;s
            schema. May indicate hand-edited rows or schema drift.
          </p>
          <dl className="divide-y divide-gray-light">
            {extraEntries.map(([k, v]) => (
              <div
                key={k}
                className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[200px_1fr] sm:gap-4"
              >
                <dt className="font-mono text-xs text-splash-navy/60">{k}</dt>
                <dd className="font-mono text-xs text-splash-navy">
                  {typeof v === "string" ? v : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function em() {
  return <span className="text-splash-navy/40">—</span>;
}

function FieldValue({
  field,
  value,
  files,
  schema
}: {
  field: Field;
  value: unknown;
  files: SubmissionFile[];
  schema: FormSchema;
}) {
  switch (field.type) {
    case "name":
    case "email":
    case "phone":
    case "short_text":
    case "long_text":
    case "hidden":
    case "date":
    case "time":
      return value == null || value === "" ? em() : <PlainText value={String(value)} />;

    case "dropdown":
      return value == null || value === "" ? em() : (
        <DropdownLabel field={field} value={String(value)} />
      );

    case "multi":
      return Array.isArray(value) && value.length > 0 ? (
        <MultiLabels field={field} values={value as unknown[]} />
      ) : (
        em()
      );

    case "location":
      return value == null || value === "" ? em() : (
        <code className="rounded bg-gray-light/40 px-1 py-0.5 text-xs">{String(value)}</code>
      );

    case "lookup":
      return <LookupValue field={field} value={value} schema={schema} />;

    case "file":
      return <FileValue files={files} value={value} />;

    case "signature":
      return <SignatureValue files={files} value={value} />;
  }
}

function PlainText({ value }: { value: string }) {
  // Preserve whitespace for textarea-style content; collapse for short single-line.
  if (value.includes("\n")) {
    return (
      <pre className="whitespace-pre-wrap font-sans text-sm text-splash-navy">
        {value}
      </pre>
    );
  }
  return <span>{value}</span>;
}

function DropdownLabel({
  field,
  value
}: {
  field: DropdownField;
  value: string;
}) {
  const opt = field.options.find((o) => o.value === value);
  return (
    <span>
      {opt?.label ?? value}
      {opt && opt.label !== opt.value && (
        <code className="ml-2 text-xs text-splash-navy/50">{opt.value}</code>
      )}
    </span>
  );
}

function MultiLabels({
  field,
  values
}: {
  field: MultiField;
  values: unknown[];
}) {
  const stringValues = values.map(String);
  return (
    <ul className="list-disc pl-5">
      {stringValues.map((v) => {
        const opt = field.options.find((o) => o.value === v);
        return (
          <li key={v}>
            {opt?.label ?? v}
            {opt && opt.label !== opt.value && (
              <code className="ml-2 text-xs text-splash-navy/50">{opt.value}</code>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LookupValue({
  field,
  value,
  schema
}: {
  field: LookupField;
  value: unknown;
  schema: FormSchema;
}) {
  const keyField = schema.fields.find((f) => f.id === field.keyFieldId);
  const keyLabel = keyField?.label ?? "key field";
  if (value == null || value === "") {
    return (
      <span className="text-splash-navy/60">
        {em()}{" "}
        <span className="ml-1 text-xs">
          (resolves from <strong>{keyLabel}</strong>)
        </span>
      </span>
    );
  }
  return (
    <span>
      {String(value)}{" "}
      <span className="ml-1 text-xs text-splash-navy/60">
        (resolved from <strong>{keyLabel}</strong>)
      </span>
    </span>
  );
}

function FileValue({
  files,
  value
}: {
  files: SubmissionFile[];
  value: unknown;
}) {
  // Some file payload entries land as a single { r2_key, ... } object on
  // the form_submissions.payload row; the canonical ledger is
  // form_submission_files. Prefer the files-table rows when present.
  const entries: Array<{
    r2_key: string;
    mime: string;
    size_bytes: number;
    original_filename: string | null;
  }> = files.map((f) => ({
    r2_key: f.r2_key,
    mime: f.mime,
    size_bytes: f.size_bytes,
    original_filename: f.original_filename
  }));

  if (entries.length === 0 && value && typeof value === "object") {
    // Legacy / hand-edited payload — fall back to whatever is on the JSONB.
    const obj = value as Record<string, unknown>;
    if (typeof obj.r2_key === "string") {
      entries.push({
        r2_key: obj.r2_key,
        mime: typeof obj.mime === "string" ? obj.mime : "application/octet-stream",
        size_bytes: typeof obj.size_bytes === "number" ? obj.size_bytes : 0,
        original_filename:
          typeof obj.original_filename === "string"
            ? obj.original_filename
            : null
      });
    }
  }

  if (entries.length === 0) return em();

  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.r2_key}>
          <FileEntry entry={e} />
        </li>
      ))}
    </ul>
  );
}

function SignatureValue({
  files,
  value
}: {
  files: SubmissionFile[];
  value: unknown;
}) {
  // Signature is always a single file per field; render the first match.
  const sig = files[0];
  if (!sig && (!value || typeof value !== "object")) return em();
  const r2Key = sig?.r2_key ?? (value as { r2_key?: string }).r2_key;
  if (!r2Key) return em();
  const url = `/forms/admin/api/files/${encodeR2Key(r2Key)}`;
  const isImage = (sig?.mime ?? "image/png").startsWith("image/");
  return (
    <div>
      {isImage ? (
        <a href={url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt="Signature"
            className="max-h-24 rounded border border-gray-light bg-white"
          />
        </a>
      ) : (
        <a href={url} className="text-splash-blue hover:underline">
          Download signature
        </a>
      )}
    </div>
  );
}

function FileEntry({
  entry
}: {
  entry: {
    r2_key: string;
    mime: string;
    size_bytes: number;
    original_filename: string | null;
  };
}) {
  const url = `/forms/admin/api/files/${encodeR2Key(entry.r2_key)}`;
  const isImage = entry.mime.startsWith("image/");
  return (
    <div className="flex items-center gap-3">
      {isImage ? (
        <a href={url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={entry.original_filename ?? "uploaded file"}
            className="max-h-16 rounded border border-gray-light"
          />
        </a>
      ) : (
        <span className="rounded bg-gray-light/40 px-2 py-1 font-mono text-xs">
          {entry.mime}
        </span>
      )}
      <a
        href={url}
        download={entry.original_filename ?? undefined}
        className="text-sm text-splash-blue hover:underline"
      >
        {entry.original_filename ?? entry.r2_key.split("/").pop() ?? "file"}
      </a>
      <span className="text-xs text-splash-navy/60">
        {formatSize(entry.size_bytes)}
      </span>
    </div>
  );
}

function encodeR2Key(key: string): string {
  // The serve route at /forms/admin/api/files/{r2_key} decodeURIComponents
  // the captured segment. Encode each path segment so slashes survive intact
  // through the URL-decoder + match the R2 path namespace.
  return key.split("/").map(encodeURIComponent).join("/");
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
