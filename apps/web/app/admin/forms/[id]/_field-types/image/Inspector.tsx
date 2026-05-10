// Image inspector — wires the asset upload helper from Brief 94. The upload
// lands an asset row + R2 object and returns its `asset_id`, which we set on
// the field's config. Replacing an asset is a fresh upload + setting a new
// assetId; the prior asset is left in R2 (Brief 97 cron sweeps orphans).

"use client";

import { useState } from "react";
import type { Field, ImageField } from "@splash/forms-schema";

import LabeledInput from "../_shared/LabeledInput";
import LabeledSelect from "../_shared/LabeledSelect";
import KeyEditor from "../_shared/KeyEditor";
import type { InspectorProps } from "../index";

export default function ImageInspector({ field, formId, onUpdate }: InspectorProps) {
  const f = field as ImageField;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("alt_text", f.altText || file.name);
      const resp = await fetch(
        `/forms/admin/api/forms/${encodeURIComponent(formId)}/assets`,
        { method: "POST", body: fd, credentials: "include" }
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`upload ${resp.status}${text ? ` — ${text}` : ""}`);
      }
      const json = (await resp.json()) as { asset_id: string };
      onUpdate({
        assetId: json.asset_id,
        altText: f.altText || file.name
      } as Partial<Field>);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <KeyEditor
        value={f.key}
        onChange={(v) => onUpdate({ key: v } as Partial<Field>)}
      />
      <div>
        <p className="text-xs font-semibold text-splash-navy/80">Image asset</p>
        {f.assetId ? (
          <p className="mt-1 break-all rounded-splash-sm border border-gray-light bg-sudsy-blue-soft/20 px-2 py-1 font-mono text-[0.7rem] text-splash-navy/80">
            {f.assetId}
          </p>
        ) : (
          <p className="mt-1 text-xs italic text-splash-navy/60">No asset yet.</p>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void handleUpload(file);
          }}
          disabled={uploading}
          className="mt-2 block w-full text-xs text-splash-navy/80"
        />
        {uploading && (
          <p className="mt-1 text-xs text-splash-navy/70">Uploading…</p>
        )}
        {error && <p className="mt-1 text-xs text-racecar-red">{error}</p>}
      </div>
      <LabeledInput
        label="Alt text"
        value={f.altText}
        onChange={(v) => onUpdate({ altText: v } as Partial<Field>)}
        hint="Required for accessibility. Describe what's in the image."
      />
      <LabeledInput
        label="Caption (optional)"
        value={f.caption ?? ""}
        onChange={(v) =>
          onUpdate({ caption: v || undefined } as Partial<Field>)
        }
      />
      <LabeledSelect
        label="Max width"
        value={f.maxWidth}
        onChange={(v) =>
          onUpdate({ maxWidth: v as ImageField["maxWidth"] } as Partial<Field>)
        }
        options={[
          { value: "small", label: "Small (25% of form width)" },
          { value: "medium", label: "Medium (50%)" },
          { value: "full", label: "Full (100%)" }
        ]}
      />
    </div>
  );
}
