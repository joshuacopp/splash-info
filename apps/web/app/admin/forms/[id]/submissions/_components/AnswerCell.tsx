// Brief 119 — per-field-type cell renderer for the wide-table submissions
// view. Lifts the value-rendering logic from PayloadRenderer (Brief 96
// detail page) into a compact, table-friendly variant: long text truncates
// with a hover-tooltip, file thumbnails are small, signature renders
// inline, lookup drops the "(resolved from X)" annotation. For any field
// type whose payload value is missing (schema-union case), renders a muted
// em-dash.

import type {
  Field,
  DropdownField,
  MultiField,
  SignatureField,
  FileField
} from "@splash/forms-schema";

const TRUNCATE_AT = 80;

interface Props {
  field: Field;
  value: unknown;
}

export default function AnswerCell({ field, value }: Props) {
  switch (field.type) {
    case "name":
    case "email":
    case "phone":
    case "short_text":
    case "hidden":
    case "date":
    case "time":
      return value == null || value === "" ? <Em /> : <PlainText value={String(value)} />;

    case "long_text":
      return value == null || value === "" ? <Em /> : <LongText value={String(value)} />;

    case "dropdown":
      return value == null || value === "" ? (
        <Em />
      ) : (
        <DropdownLabel field={field} value={String(value)} />
      );

    case "multi":
      return Array.isArray(value) && value.length > 0 ? (
        <MultiLabels field={field} values={value as unknown[]} />
      ) : (
        <Em />
      );

    case "location":
      return value == null || value === "" ? (
        <Em />
      ) : (
        <code className="rounded bg-gray-light/40 px-1 py-0.5 text-xs">{String(value)}</code>
      );

    case "lookup":
      return value == null || value === "" ? <Em /> : <PlainText value={String(value)} />;

    case "file":
      return <FileCell field={field} value={value} />;

    case "signature":
      return <SignatureCell field={field} value={value} />;
  }
}

function Em() {
  return <span className="text-splash-navy/40">—</span>;
}

function PlainText({ value }: { value: string }) {
  if (value.length <= TRUNCATE_AT) {
    return <span className="whitespace-nowrap">{value}</span>;
  }
  return (
    <span title={value} className="block max-w-[28rem] truncate">
      {value}
    </span>
  );
}

function LongText({ value }: { value: string }) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TRUNCATE_AT) {
    return <span>{collapsed}</span>;
  }
  return (
    <span title={value} className="block max-w-[28rem] truncate">
      {collapsed.slice(0, TRUNCATE_AT)}…
    </span>
  );
}

function DropdownLabel({ field, value }: { field: DropdownField; value: string }) {
  const opt = field.options.find((o) => o.value === value);
  return <span className="whitespace-nowrap">{opt?.label ?? value}</span>;
}

function MultiLabels({ field, values }: { field: MultiField; values: unknown[] }) {
  const labels = values.map((v) => {
    const s = String(v);
    const opt = field.options.find((o) => o.value === s);
    return opt?.label ?? s;
  });
  const joined = labels.join(", ");
  if (joined.length <= TRUNCATE_AT) {
    return <span>{joined}</span>;
  }
  return (
    <span title={joined} className="block max-w-[28rem] truncate">
      {joined.slice(0, TRUNCATE_AT)}…
    </span>
  );
}

function FileCell({ field: _field, value }: { field: FileField; value: unknown }) {
  if (!value || typeof value !== "object") return <Em />;
  const obj = value as Record<string, unknown>;
  const r2Key = typeof obj.r2_key === "string" ? obj.r2_key : null;
  if (!r2Key) return <Em />;
  const mime = typeof obj.mime === "string" ? obj.mime : "application/octet-stream";
  const originalFilename =
    typeof obj.original_filename === "string" ? obj.original_filename : null;
  const url = `/forms/admin/api/files/${encodeR2Key(r2Key)}`;
  const isImage = mime.startsWith("image/");
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={originalFilename ?? "uploaded file"}
          className="max-h-12 max-w-[6rem] rounded border border-gray-light bg-white"
        />
      </a>
    );
  }
  const label = originalFilename ?? r2Key.split("/").pop() ?? "file";
  return (
    <a
      href={url}
      download={originalFilename ?? undefined}
      title={label}
      className="block max-w-[12rem] truncate text-splash-blue hover:underline"
    >
      {label}
    </a>
  );
}

function SignatureCell({
  field: _field,
  value
}: {
  field: SignatureField;
  value: unknown;
}) {
  if (!value || typeof value !== "object") return <Em />;
  const obj = value as Record<string, unknown>;
  const r2Key = typeof obj.r2_key === "string" ? obj.r2_key : null;
  if (!r2Key) return <Em />;
  const url = `/forms/admin/api/files/${encodeR2Key(r2Key)}`;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Signature"
        className="max-h-12 max-w-[8rem] rounded border border-gray-light bg-white"
      />
    </a>
  );
}

function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
