// Per-field-type Zod validators (Brief 90 — render-time + builder-save-time
// configuration validation). Brief 91 will add the submit-time PAYLOAD
// validators in a sibling file (`payload.ts`). This file validates that a
// field's CONFIG (the object stored under `form_versions.schema.fields[i]`)
// is well-formed.
//
// Why both compile-time TypeScript types AND runtime Zod: the typed
// `Field` discriminated union in `types.ts` enforces shape inside the
// monorepo, but `form_versions.schema` is JSONB read at request time —
// nothing prevents a hand-edited row from breaking the contract. The
// `formSchemaSchema` parse in the worker's render path is the boundary
// check; if it fails, the worker can 500 with a precise error rather
// than render half a form.

import { z } from "zod";

// Common base every field-config schema spreads in.
const fieldBaseSchema = {
  id: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string().min(1),
  required: z.boolean(),
  helpText: z.string().optional(),
  // Brief 129 — optional per-field flag that hides the field from the
  // completed-form PDF (generated when an email step has `attach_pdf:
  // true`). No structural enforcement beyond type — operators flip the
  // flag freely.
  exclude_from_pdf: z.boolean().optional()
};

const dropdownOptionSchema = z.object({
  value: z.string(),
  label: z.string()
});

// -----------------------------------------------------------------------------
// Display-only types (no payload)
// -----------------------------------------------------------------------------

export const headingFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("heading"),
  level: z.enum(["h1", "h2", "h3", "h4"]),
  text: z.string().min(1)
});

export const imageFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("image"),
  assetId: z.string().uuid(),
  altText: z.string().min(1),
  caption: z.string().optional(),
  maxWidth: z.enum(["small", "medium", "full"])
});

// -----------------------------------------------------------------------------
// Text inputs
// -----------------------------------------------------------------------------

export const nameFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("name"),
  maxLength: z.number().int().positive().optional()
});

export const emailFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("email"),
  maxLength: z.number().int().positive().optional()
});

export const phoneFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("phone")
});

export const shortTextFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("short_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional()
});

export const longTextFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("long_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional(),
  rows: z.number().int().positive().optional()
});

export const hiddenFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("hidden"),
  defaultValueFromUrlParam: z.string().optional(),
  defaultValue: z.string().optional()
});

// -----------------------------------------------------------------------------
// Choice
// -----------------------------------------------------------------------------

export const dropdownFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("dropdown"),
  options: z.array(dropdownOptionSchema),
  placeholder: z.string().optional()
});

export const multiFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("multi"),
  options: z.array(dropdownOptionSchema),
  minSelected: z.number().int().nonnegative().optional(),
  maxSelected: z.number().int().positive().optional()
});

// -----------------------------------------------------------------------------
// Date / Time
// -----------------------------------------------------------------------------

export const dateFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("date"),
  minDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultToToday: z.boolean().optional()
});

export const timeFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("time"),
  minTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxTime: z.string().regex(/^\d{2}:\d{2}$/).optional()
});

// -----------------------------------------------------------------------------
// File / signature — Brief 92 wires functional behavior; Brief 90 just
// validates the config shape so the render-time defensive check passes.
// -----------------------------------------------------------------------------

export const fileFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("file"),
  maxSizeMb: z.number().int().positive().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  allowMultiple: z.boolean().optional()
});

export const signatureFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("signature"),
  format: z.enum(["png", "svg"]),
  penColor: z.string().optional(),
  minStrokes: z.number().int().positive().optional()
});

// -----------------------------------------------------------------------------
// Location / Lookup
// -----------------------------------------------------------------------------

export const locationFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("location"),
  displayFormat: z.enum(["name", "name_and_address", "site_number"])
});

export const lookupFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("lookup"),
  keyFieldId: z.string().min(1),
  keyColumn: z.enum(["pricing_simple.location_code", "pricing_simple.site"]),
  sourceTable: z.enum(["pricing_simple", "locations"]),
  sourceColumn: z.string().min(1),
  resolutionMode: z.enum(["prefill_hidden", "prefill_visible", "display_only"]),
  nullBehavior: z.enum(["allow_empty", "block_submit"])
});

// -----------------------------------------------------------------------------
// Discriminated union + form schema
// -----------------------------------------------------------------------------

export const fieldSchema = z.discriminatedUnion("type", [
  headingFieldSchema,
  imageFieldSchema,
  nameFieldSchema,
  emailFieldSchema,
  phoneFieldSchema,
  shortTextFieldSchema,
  longTextFieldSchema,
  hiddenFieldSchema,
  dropdownFieldSchema,
  multiFieldSchema,
  dateFieldSchema,
  timeFieldSchema,
  fileFieldSchema,
  signatureFieldSchema,
  locationFieldSchema,
  lookupFieldSchema
]);

// -----------------------------------------------------------------------------
// Workflow (Brief 120) — Zod schemas + structural cross-checks
// -----------------------------------------------------------------------------
//
// The discriminated union mirrors `ApproverSource` in types.ts. Cross-field
// invariants (default_stage references a real stage, every transition's `to`
// references a real stage, no duplicate stage ids, payload_field
// approver_source references a real form field) live in a `.superRefine`
// applied at the FormSchema level so the issue path can include the field
// index of the offending stage/transition.

const approverSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("site_role"),
    role: z.enum(["am_email", "rm_email", "site_email"])
  }),
  z.object({
    type: z.literal("static_emails"),
    emails: z.array(z.string())
  }),
  z.object({
    type: z.literal("payload_field"),
    field_key: z.string().min(1)
  })
]);

const workflowTransitionSchema = z.object({
  to: z.string().min(1),
  label: z.string().min(1),
  requires: z
    .object({
      signature: z.boolean().optional(),
      typed_name: z.boolean().optional(),
      note: z.boolean().optional()
    })
    .optional()
});

const workflowStageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string().min(1),
  // Brief 123 — terminal stages (e.g. "approved", "denied") omit
  // approver_source entirely; they have no outgoing transitions and no
  // operator action is required to "act" on them.
  approver_source: approverSourceSchema.optional(),
  transitions: z.array(workflowTransitionSchema),
  // Brief 125 — UI bucket hint + outcome tint. Brief 127 added "email";
  // legacy "step" stays accepted so existing published forms keep
  // validating (predicate fallback treats both as approval).
  kind: z.enum(["step", "approval", "email", "outcome"]).optional(),
  tint: z
    .enum(["success", "danger", "warning", "info", "neutral"])
    .optional(),
  // Brief 127 — email-step-only fields. Empty / missing on approval +
  // outcome stages; required + non-empty on email stages (enforced in
  // the `superRefine` on `formSchemaSchema` so the issue path can point
  // at the offending stage index).
  recipients: z.array(approverSourceSchema).optional(),
  subject_template: z.string().optional(),
  body_template: z.string().optional(),
  // Brief 129 — email-step PDF attach flag. No strict-mode cross-check;
  // generator no-ops when false / missing.
  attach_pdf: z.boolean().optional()
});

const workflowNotificationsSchema = z.object({
  notify_approver_on_assignment: z.boolean().optional(),
  notify_submitter_on_outcome: z.boolean().optional(),
  notify_approvers_on_outcome: z.boolean().optional()
});

export const formWorkflowSchema = z.object({
  default_stage: z.string().min(1),
  stages: z.array(workflowStageSchema).min(1),
  notifications: workflowNotificationsSchema.optional()
});

// Lenient variant for save-draft — operator may be mid-build with one stage
// added but no transitions, an empty default_stage, or an in-progress
// `payload_field` field_key. Discriminator + enum constraints stay strict.
const approverSourceSchemaDraft = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("site_role"),
    role: z.enum(["am_email", "rm_email", "site_email"])
  }),
  z.object({
    type: z.literal("static_emails"),
    emails: z.array(z.string())
  }),
  z.object({
    type: z.literal("payload_field"),
    field_key: z.string()
  })
]);

const workflowTransitionSchemaDraft = z.object({
  to: z.string(),
  label: z.string(),
  requires: z
    .object({
      signature: z.boolean().optional(),
      typed_name: z.boolean().optional(),
      note: z.boolean().optional()
    })
    .optional()
});

const workflowStageSchemaDraft = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string(),
  approver_source: approverSourceSchemaDraft.optional(),
  transitions: z.array(workflowTransitionSchemaDraft),
  kind: z.enum(["step", "approval", "email", "outcome"]).optional(),
  tint: z
    .enum(["success", "danger", "warning", "info", "neutral"])
    .optional(),
  // Brief 127 — email-step-only fields. Draft variant accepts empty /
  // missing values; strict validator enforces shape at publish time.
  recipients: z.array(approverSourceSchemaDraft).optional(),
  subject_template: z.string().optional(),
  body_template: z.string().optional(),
  // Brief 129 — email-step PDF attach flag (draft variant).
  attach_pdf: z.boolean().optional()
});

export const formWorkflowSchemaDraft = z.object({
  default_stage: z.string(),
  stages: z.array(workflowStageSchemaDraft),
  notifications: workflowNotificationsSchema.optional()
});

// -----------------------------------------------------------------------------
// Top-level FormSchema — strict (publish + render time)
// -----------------------------------------------------------------------------

export const formSchemaSchema = z
  .object({
    fields: z.array(fieldSchema),
    workflow: formWorkflowSchema.optional()
  })
  .superRefine((data, ctx) => {
    if (!data.workflow) return;
    const { default_stage, stages } = data.workflow;
    const stageIds = new Set<string>();
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!stage) continue;
      if (stageIds.has(stage.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workflow", "stages", i, "id"],
          message: `duplicate stage id "${stage.id}"`
        });
      }
      stageIds.add(stage.id);
    }
    if (!stageIds.has(default_stage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow", "default_stage"],
        message: `default_stage "${default_stage}" not in stages[]`
      });
    }
    const fieldKeys = new Set(
      data.fields
        .filter((f) => f.type !== "heading" && f.type !== "image")
        .map((f) => f.key)
    );
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!stage) continue;
      for (let j = 0; j < stage.transitions.length; j++) {
        const transition = stage.transitions[j];
        if (!transition) continue;
        if (!stageIds.has(transition.to)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "stages", i, "transitions", j, "to"],
            message: `transition.to "${transition.to}" not in stages[]`
          });
        }
        // Brief 123 — self-transitions create infinite loops at the UX level
        // ("approve" button just lands you back on the same stage). Reject
        // outright at publish time.
        if (transition.to === stage.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "stages", i, "transitions", j, "to"],
            message: `Stage "${stage.id}" has a self-referencing transition. Pick a different destination.`
          });
        }
      }
      if (stage.approver_source && stage.approver_source.type === "payload_field") {
        if (!fieldKeys.has(stage.approver_source.field_key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "stages", i, "approver_source", "field_key"],
            message: `approver_source.field_key "${stage.approver_source.field_key}" does not reference a form field`
          });
        }
      }
      // Brief 127 — email stages have their own structural shape:
      //   - exactly one transition (auto-advance after enqueue)
      //   - non-empty recipients list
      //   - subject + body templates present (allowed to be empty
      //     strings — operator may want unsubstituted blank, validator
      //     just ensures the keys exist so the renderer doesn't crash).
      // Approval stages must NOT carry email-only fields and vice
      // versa (allowed but ignored — kept lenient at strict-validator
      // level to avoid double-touching every existing schema).
      const isEmailStage =
        stage.kind === "email" ||
        (!stage.approver_source &&
          stage.transitions.length === 1 &&
          (stage.recipients?.length ?? 0) > 0);
      if (isEmailStage) {
        if (!stage.recipients || stage.recipients.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "stages", i, "recipients"],
            message: `Email step "${stage.id}" has no recipients. Pick at least one To: option.`
          });
        }
        if (stage.transitions.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "stages", i, "transitions"],
            message: `Email step "${stage.id}" must have exactly one outgoing edge (it auto-advances after sending). Got ${stage.transitions.length}.`
          });
        }
        // approver_source on an email stage is a builder bug — the email
        // step kind doesn't gate on approver authority.
        if (stage.approver_source) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "stages", i, "approver_source"],
            message: `Email step "${stage.id}" should not carry an approver source.`
          });
        }
        continue;
      }
      // Brief 123 — orphaned approval stages. A stage with an approver but
      // no outgoing transitions strands submissions: the approver can't
      // act, the submission sits in `current_approver_emails` forever.
      // Either add a transition out or drop the approver_source so the
      // stage becomes terminal.
      if (stage.approver_source && stage.transitions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workflow", "stages", i],
          message: `Stage "${stage.id}" has an approver but no transitions out — submissions would be stuck. Either add a transition or remove the approver source to make it a terminal stage.`
        });
      }
      // Mirror: a stage with transitions out but no approver is also broken
      // — no one is authorized to advance the submission.
      if (!stage.approver_source && stage.transitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workflow", "stages", i],
          message: `Stage "${stage.id}" has outgoing transitions but no approver source. Add an approver source or remove the transitions to make it a terminal stage.`
        });
      }
    }

    // Brief 123 — reachability check. BFS from default_stage; require at
    // least one terminal stage (no outgoing transitions AND no approver
    // source) reachable. Otherwise submissions can never resolve.
    if (stageIds.has(default_stage) && stages.length > 0) {
      const stageById = new Map<string, (typeof stages)[number]>();
      for (const stage of stages) if (stage) stageById.set(stage.id, stage);
      const visited = new Set<string>([default_stage]);
      const queue: string[] = [default_stage];
      let reachableTerminal = false;
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) break;
        const stage = stageById.get(id);
        if (!stage) continue;
        if (stage.transitions.length === 0 && !stage.approver_source) {
          reachableTerminal = true;
          break;
        }
        for (const transition of stage.transitions) {
          if (!visited.has(transition.to) && stageById.has(transition.to)) {
            visited.add(transition.to);
            queue.push(transition.to);
          }
        }
      }
      if (!reachableTerminal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workflow", "default_stage"],
          message: `Workflow has no reachable terminal stage from "${default_stage}". Add a transition path that leads to a stage with no outgoing transitions and no approver source.`
        });
      }
    }
  });

// -----------------------------------------------------------------------------
// Draft schema — lenient variant for save-draft
// -----------------------------------------------------------------------------
//
// Drafts are work-in-progress: the operator may add a Lookup field and click
// Save Draft before they've picked a key field or source column. The strict
// `formSchemaSchema` above (used at render time + at publish time) requires
// those user-config fields to be non-empty / well-formed. The default config
// for `lookup` / `image` fields seeds them with empty strings, so a strict
// validation would 422 the moment the field hits the canvas.
//
// This draft variant relaxes ONLY the user-config strings that have no
// sensible default (keyFieldId, sourceColumn, assetId, altText, label, text)
// to plain `z.string()`. Discriminator literals, enum-typed config, and
// structural invariants (id, key regex) stay strict — those errors point at
// builder bugs, not work-in-progress.
//
// Publish re-validates against `formSchemaSchema` before promoting the draft,
// so anything that's draft-only-valid will surface a 422 at publish time
// instead of letting a half-configured field reach public render.

const fieldBaseSchemaDraft = {
  id: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string(),
  required: z.boolean(),
  helpText: z.string().optional(),
  // Brief 129 — see fieldBaseSchema for the rationale; draft variant
  // mirrors so save-draft accepts the flag mid-build.
  exclude_from_pdf: z.boolean().optional()
};

const headingFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("heading"),
  level: z.enum(["h1", "h2", "h3", "h4"]),
  text: z.string()
});

const imageFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("image"),
  assetId: z.string(),
  altText: z.string(),
  caption: z.string().optional(),
  maxWidth: z.enum(["small", "medium", "full"])
});

const nameFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("name"),
  maxLength: z.number().int().positive().optional()
});

const emailFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("email"),
  maxLength: z.number().int().positive().optional()
});

const phoneFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("phone")
});

const shortTextFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("short_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional()
});

const longTextFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("long_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional(),
  rows: z.number().int().positive().optional()
});

const hiddenFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("hidden"),
  defaultValueFromUrlParam: z.string().optional(),
  defaultValue: z.string().optional()
});

const dropdownFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("dropdown"),
  options: z.array(dropdownOptionSchema),
  placeholder: z.string().optional()
});

const multiFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("multi"),
  options: z.array(dropdownOptionSchema),
  minSelected: z.number().int().nonnegative().optional(),
  maxSelected: z.number().int().positive().optional()
});

const dateFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("date"),
  minDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultToToday: z.boolean().optional()
});

const timeFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("time"),
  minTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxTime: z.string().regex(/^\d{2}:\d{2}$/).optional()
});

const fileFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("file"),
  maxSizeMb: z.number().int().positive().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  allowMultiple: z.boolean().optional()
});

const signatureFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("signature"),
  format: z.enum(["png", "svg"]),
  penColor: z.string().optional(),
  minStrokes: z.number().int().positive().optional()
});

const locationFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("location"),
  displayFormat: z.enum(["name", "name_and_address", "site_number"])
});

const lookupFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("lookup"),
  keyFieldId: z.string(),
  keyColumn: z.enum(["pricing_simple.location_code", "pricing_simple.site"]),
  sourceTable: z.enum(["pricing_simple", "locations"]),
  sourceColumn: z.string(),
  resolutionMode: z.enum(["prefill_hidden", "prefill_visible", "display_only"]),
  nullBehavior: z.enum(["allow_empty", "block_submit"])
});

export const fieldSchemaDraft = z.discriminatedUnion("type", [
  headingFieldSchemaDraft,
  imageFieldSchemaDraft,
  nameFieldSchemaDraft,
  emailFieldSchemaDraft,
  phoneFieldSchemaDraft,
  shortTextFieldSchemaDraft,
  longTextFieldSchemaDraft,
  hiddenFieldSchemaDraft,
  dropdownFieldSchemaDraft,
  multiFieldSchemaDraft,
  dateFieldSchemaDraft,
  timeFieldSchemaDraft,
  fileFieldSchemaDraft,
  signatureFieldSchemaDraft,
  locationFieldSchemaDraft,
  lookupFieldSchemaDraft
]);

// Brief 120 — draft variant accepts a partial workflow (operator may save
// mid-build with an empty default_stage or a transition that doesn't yet
// reference an existing stage). Publish re-validates against the strict
// `formSchemaSchema` so anything draft-only-valid surfaces a 422 at
// publish time.
export const draftFormSchemaSchema = z.object({
  fields: z.array(fieldSchemaDraft),
  workflow: formWorkflowSchemaDraft.optional()
});
