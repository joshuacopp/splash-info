import type { Field, HeadingField } from "@splash/forms-schema";

export default function HeadingRenderer({ field }: { field: Field }) {
  const f = field as HeadingField;
  const sizes: Record<HeadingField["level"], string> = {
    h1: "text-2xl",
    h2: "text-xl",
    h3: "text-lg",
    h4: "text-base"
  };
  const Tag = f.level;
  return (
    <Tag className={`font-bold text-splash-navy ${sizes[f.level]}`}>{f.text}</Tag>
  );
}
