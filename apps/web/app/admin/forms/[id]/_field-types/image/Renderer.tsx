import type { Field, ImageField } from "@splash/forms-schema";

export default function ImageRenderer({ field }: { field: Field }) {
  const f = field as ImageField;
  const widthClass: Record<ImageField["maxWidth"], string> = {
    small: "max-w-[25%]",
    medium: "max-w-[50%]",
    full: "max-w-full"
  };
  if (!f.assetId) {
    return (
      <div className={`rounded border border-dashed border-gray-light bg-sudsy-blue-soft/30 p-4 text-center text-xs italic text-splash-navy/60 ${widthClass[f.maxWidth]}`}>
        Image placeholder — upload an asset in the inspector.
      </div>
    );
  }
  return (
    <div className={widthClass[f.maxWidth]}>
      <div className="rounded border border-gray-light bg-white px-3 py-2 text-xs text-splash-navy/70">
        Asset: <code className="font-mono">{f.assetId}</code>
        {f.altText && <span className="ml-2 text-splash-navy/60">alt: {f.altText}</span>}
      </div>
      {f.caption && (
        <p className="mt-1 text-xs text-splash-navy/70">{f.caption}</p>
      )}
    </div>
  );
}
