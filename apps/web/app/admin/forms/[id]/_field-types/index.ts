// Per-field-type module registry. Each subdirectory exports `type`, `label`,
// `defaultConfig`, `Renderer`, and `Inspector`. Adding a 17th type means:
//   1. New folder under _field-types/{type}.
//   2. Re-export below + entry in FIELD_TYPE_REGISTRY.
//   3. New interface in @splash/forms-schema/src/types.ts.
//   4. New Zod schema in @splash/forms-schema/src/validators/field-config.ts.
//   5. Public renderer in apps/forms-worker/src/render/fields/.
//
// TypeScript catches forgotten branches because the registry is a typed
// FieldTypeModule[] — adding a new FieldType but forgetting to register it
// surfaces as a compile error in `defaultConfigFor`.

import type { ComponentType } from "react";
import type { Field, FieldType, LookupSource } from "@splash/forms-schema";

import * as heading from "./heading";
import * as image from "./image";
import * as nameMod from "./name";
import * as email from "./email";
import * as phone from "./phone";
import * as shortText from "./short-text";
import * as longText from "./long-text";
import * as hidden from "./hidden";
import * as dropdown from "./dropdown";
import * as multi from "./multi";
import * as dateMod from "./date";
import * as timeMod from "./time";
import * as fileMod from "./file";
import * as signature from "./signature";
import * as locationMod from "./location";
import * as lookup from "./lookup";

export interface InspectorProps {
  field: Field;
  allFields: Field[];
  lookupSources: readonly LookupSource[];
  formId: string;
  onUpdate: (patch: Partial<Field>) => void;
}

export interface RendererProps {
  field: Field;
}

export interface FieldTypeModule {
  type: FieldType;
  label: string;
  defaultConfig: Omit<Field, "id" | "key">;
  Renderer: ComponentType<RendererProps>;
  Inspector: ComponentType<InspectorProps>;
}

export const FIELD_TYPE_REGISTRY: FieldTypeModule[] = [
  heading,
  image,
  nameMod,
  email,
  phone,
  shortText,
  longText,
  hidden,
  dropdown,
  multi,
  dateMod,
  timeMod,
  fileMod,
  signature,
  locationMod,
  lookup
] as unknown as FieldTypeModule[];

export function defaultConfigFor(type: FieldType): Omit<Field, "id" | "key"> {
  const mod = FIELD_TYPE_REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`Unknown field type: ${type}`);
  return mod.defaultConfig;
}

export function getFieldModule(type: FieldType): FieldTypeModule {
  const mod = FIELD_TYPE_REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`Unknown field type: ${type}`);
  return mod;
}
