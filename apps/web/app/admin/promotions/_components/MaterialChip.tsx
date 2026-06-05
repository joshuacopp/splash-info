// Brief 158a — single material chip rendered in the materials grid on
// the live-view page.
//
// Each chip carries the material's name, kind, file size, and a download
// link to the Brief 156 serve endpoint
// (`GET /promo/api/promos/{promoId}/materials/{materialId}/file`). Image
// MIMEs additionally render an inline thumbnail (same-origin path-carve
// per Brief 153 means the worker URL is just a relative path).

import type { PromoMaterial } from "../_lib/types";
import MaterialDeleteButton from "./MaterialDeleteButton";

interface Props {
  promoId: string;
  material: PromoMaterial;
  /** Brief 158b — when true, renders a Delete button on the chip. */
  canDelete?: boolean;
}

const KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  copy_messaging: "Copy / messaging",
  signage: "Signage",
  email_asset: "Email asset",
  other: "Other"
};

function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function MaterialChip({ promoId, material, canDelete = false }: Props) {
  const fileUrl = `/promo/api/promos/${encodeURIComponent(
    promoId
  )}/materials/${encodeURIComponent(material.id)}/file`;
  const isImage = (material.fileMime ?? "").startsWith("image/");
  const kindLabel = KIND_LABELS[material.kind] ?? material.kind;

  return (
    <div className="flex flex-col gap-2 rounded-splash-md border border-gray-light bg-white p-3">
      {isImage && (
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block overflow-hidden rounded-splash-sm border border-gray-100 bg-gray-50"
        >
          <img
            src={fileUrl}
            alt={material.name}
            className="h-24 w-full object-cover"
            loading="lazy"
          />
        </a>
      )}
      <div className="flex flex-col gap-0.5">
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-sm font-bold text-splash-blue hover:underline"
          title={material.name}
        >
          {material.name}
        </a>
        <div className="flex flex-wrap items-baseline gap-2 text-[0.6875rem] text-splash-navy/60">
          <span className="rounded-full bg-sudsy-blue-soft/60 px-2 py-0.5 font-semibold text-splash-navy/70">
            {kindLabel}
          </span>
          <span>{formatBytes(material.fileSizeBytes)}</span>
        </div>
      </div>
      {canDelete && (
        <div className="mt-1 flex justify-end">
          <MaterialDeleteButton
            promoId={promoId}
            materialId={material.id}
            materialName={material.name}
          />
        </div>
      )}
    </div>
  );
}

export default MaterialChip;
