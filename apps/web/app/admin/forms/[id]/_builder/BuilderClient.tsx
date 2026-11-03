// 3-column builder client island. Owns canvas state via useReducer, drag-
// and-drop via dnd-kit, and the Save Draft / Publish actions.
//
// Per Brief 95: canvas mutations are NOT server actions. They're useReducer
// dispatches mutating client-only state until the operator clicks Save Draft,
// which fires updateDraftAdmin (the canonical PATCH). Publish creates a new
// immutable form_versions row and spawns a fresh draft (Brief 94 lifecycle).
//
// Brief 125 — tab-aware. Renders Fields / Workflow / Settings based on the
// `activeTab` prop (page-controlled via `?tab=`). State is shared across
// tabs in the single useReducer; dirty flag tracks every tab.

"use client";

import { useEffect, useReducer, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import type { LookupSource } from "@splash/forms-schema";

import { publishFormAction, saveDraftAction } from "../actions";
import type { FormDetail } from "../../_lib/worker-fetch";
import Canvas from "./Canvas";
import Inspector from "./Inspector";
import Palette from "./Palette";
import TopBar from "./TopBar";
import { BottomSheet, useIsWide } from "./MobileSheet";
import { getFieldModule } from "../_field-types";
import {
  initialState,
  reducer,
  stripBuilderArtifacts,
  hasScopeField
} from "./reducer";
import WorkflowTab, {
  type WorkflowTabDispatch
} from "../_workflow/WorkflowTab";
import SettingsTab from "../_workflow/SettingsTab";
import type { BuilderTab } from "../_components/FormBuilderTabs";

interface Props {
  initial: FormDetail;
  lookupSources: readonly LookupSource[];
  formId: string;
  accessTag: string | null;
  activeTab: BuilderTab;
}

export default function BuilderClient({
  initial,
  lookupSources,
  formId,
  accessTag,
  activeTab
}: Props) {
  const [state, dispatch] = useReducer(
    reducer,
    initial,
    (init): ReturnType<typeof initialState> =>
      initialState({
        form: {
          slug: init.form.slug,
          title: init.form.title,
          description: init.form.description,
          audience: init.form.audience,
          notifyWebhook: init.form.notifyWebhook,
          successMessage: init.form.successMessage,
          turnstileRequired: init.form.turnstileRequired
        },
        draftSchema: init.draftSchema
      })
  );
  const [saving, setSaving] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [publishing, setPublishing] = useState<
    "idle" | "publishing" | "done" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Phone layout (see MobileSheet.tsx): the palette and the field settings
  // are bottom sheets instead of side columns.
  const wide = useIsWide();
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  // Beforeunload warning when there are unsaved changes.
  useEffect(() => {
    if (!state.dirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.dirty]);

  async function handleSaveDraft() {
    setSaving("saving");
    setErrorMsg(null);
    const res = await saveDraftAction(
      formId,
      state.fields,
      stripBuilderArtifacts(state.workflow)
    );
    if (res.ok) {
      setSaving("saved");
      dispatch({ type: "mark_clean" });
      setTimeout(() => setSaving("idle"), 2000);
    } else {
      setSaving("error");
      setErrorMsg(res.error);
    }
  }

  async function handlePublish() {
    if (state.dirty) {
      const proceed = window.confirm(
        "You have unsaved changes. Save Draft and publish?"
      );
      if (!proceed) return;
      const saveRes = await saveDraftAction(
        formId,
        state.fields,
        stripBuilderArtifacts(state.workflow)
      );
      if (!saveRes.ok) {
        setErrorMsg(saveRes.error);
        return;
      }
      dispatch({ type: "mark_clean" });
    }
    setPublishing("publishing");
    setErrorMsg(null);
    const res = await publishFormAction(formId);
    if (res.ok) {
      setPublishing("done");
      // Reload to pick up the new draft + version history.
      window.alert(`Published as version ${res.published_version_number}.`);
      window.location.reload();
    } else {
      setPublishing("error");
      setErrorMsg(res.error);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = state.fields.findIndex((f) => f.id === active.id);
    const newIdx = state.fields.findIndex((f) => f.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    dispatch({
      type: "reorder_field",
      fields: arrayMove(state.fields, oldIdx, newIdx)
    });
  }

  const selectedField = state.selectedFieldId
    ? state.fields.find((f) => f.id === state.selectedFieldId)
    : undefined;

  // Internal / link-only forms are location-scoped: they need a site-number
  // field so location admins see only their site's submissions. If it's
  // missing, the worker auto-injects one at publish — warn here so the
  // operator can add it themselves (controlling label / placement) rather
  // than being surprised by an appended field after publishing. Public forms
  // are never scoped (anonymous fillers don't know site numbers).
  //
  // Publish only injects while forms.scope_location_field_key is still NULL
  // (admin/forms.ts). Once it is set -- the price change form keeps it set
  // and deliberately has no site field -- publish leaves the fields alone, so
  // the warning would be false. An older worker that does not send the key
  // (undefined) keeps the old behaviour.
  const needsScopeField =
    (state.formMeta.audience === "internal" ||
      state.formMeta.audience === "link-only") &&
    !hasScopeField(state.fields) &&
    (initial.scopeLocationFieldKey === undefined || initial.scopeLocationFieldKey === null);

  function moveField(id: string, direction: -1 | 1) {
    const from = state.fields.findIndex((f) => f.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= state.fields.length) return;
    dispatch({ type: "reorder_field", fields: arrayMove(state.fields, from, to) });
  }

  const workflowTabDispatch: WorkflowTabDispatch = {
    onEnable: () => dispatch({ type: "workflow_enable" }),
    onDisable: () => dispatch({ type: "workflow_disable" }),
    onAddStep: () => dispatch({ type: "workflow_add_step" }),
    onAddEmailStep: () => dispatch({ type: "workflow_add_email_step" }),
    onDuplicateStep: (stepId) =>
      dispatch({ type: "workflow_duplicate_step", stepId }),
    onRemoveStep: (stepId) =>
      dispatch({ type: "workflow_remove_step", stepId }),
    onReorderSteps: (fromIndex, toIndex) =>
      dispatch({ type: "workflow_reorder_steps", fromIndex, toIndex }),
    onUpdateStepLabel: (stepId, label) =>
      dispatch({ type: "workflow_update_step_label", stepId, label }),
    onSetStepApprover: (stepId, source) =>
      dispatch({ type: "workflow_set_step_approver", stepId, source }),
    onAddTransition: (stepId) =>
      dispatch({ type: "workflow_add_transition", stageId: stepId }),
    onUpdateTransition: (stepId, index, patch) =>
      dispatch({
        type: "workflow_update_transition",
        stageId: stepId,
        index,
        patch
      }),
    onRemoveTransition: (stepId, index) =>
      dispatch({
        type: "workflow_remove_transition",
        stageId: stepId,
        index
      }),
    onUpdateEmailTemplates: (stepId, patch) =>
      dispatch({ type: "workflow_update_email_step", stepId, patch }),
    onSetEmailRecipients: (stepId, recipients) =>
      dispatch({ type: "workflow_set_email_recipients", stepId, recipients }),
    onApplyQuickPattern: (pattern) =>
      dispatch({ type: "workflow_apply_pattern", pattern }),
    onCreateAndRouteToEmailStep: (stepId, transitionIndex) =>
      dispatch({
        type: "workflow_add_email_step_from_action",
        stepId,
        transitionIndex
      }),
    onAddOutcome: () => dispatch({ type: "workflow_add_outcome" }),
    onUpdateOutcome: (outcomeId, patch) =>
      dispatch({ type: "workflow_update_outcome", outcomeId, patch }),
    onRemoveOutcome: (outcomeId) =>
      dispatch({ type: "workflow_remove_outcome", outcomeId })
  };

  return (
    <div className="flex flex-col gap-4">
      <TopBar
        formMeta={state.formMeta}
        status={initial.form.status}
        currentVersionNumber={initial.currentVersionNumber}
        dirty={state.dirty}
        saving={saving}
        publishing={publishing}
        errorMsg={errorMsg}
        onSaveDraft={handleSaveDraft}
        onPublish={handlePublish}
        onTitleChange={(title) =>
          dispatch({ type: "update_form_meta", patch: { title } })
        }
      />

      {activeTab === "fields" && needsScopeField && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-splash-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            This {state.formMeta.audience} form has no{" "}
            <strong>Site number</strong> field. One will be added automatically
            on publish so location admins see only their site&rsquo;s
            submissions — add it now to control its label and placement.
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: "add_scope_field" })}
            className="inline-flex shrink-0 items-center rounded-splash-sm border border-amber-500 bg-white px-3 py-1.5 text-sm font-bold text-amber-900 hover:bg-amber-100"
          >
            Add site-number field
          </button>
        </div>
      )}

      {activeTab === "fields" && !wide && (
        <div className="flex flex-col gap-3">
          <DndContext id="form-builder-fields-narrow" sensors={sensors}>
          <SortableContext items={state.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
          <Canvas
            narrow
            fields={state.fields}
            selectedFieldId={state.selectedFieldId}
            onSelect={(id) => {
              dispatch({ type: "select_field", fieldId: id });
              setSettingsSheetOpen(true);
            }}
            onDelete={(id) => dispatch({ type: "remove_field", fieldId: id })}
            onDuplicate={(id) => dispatch({ type: "duplicate_field", fieldId: id })}
            onMove={moveField}
          />
          </SortableContext>
          </DndContext>
          {/* Sticky so it is reachable from anywhere in a long form. */}
          <div className="sticky bottom-3 z-20 flex justify-center pb-[env(safe-area-inset-bottom,0px)]">
            <button
              type="button"
              onClick={() => setAddSheetOpen(true)}
              className="rounded-full bg-splash-blue px-6 py-3 text-sm font-bold text-white shadow-splash-btn"
            >
              + Add field
            </button>
          </div>

          <BottomSheet open={addSheetOpen} title="Add a field" doneLabel="Close" onClose={() => setAddSheetOpen(false)}>
            <p className="mb-3 text-xs text-splash-navy/60">
              {selectedField
                ? "Goes right after the field you have selected."
                : "Goes at the end of the form."}
            </p>
            <Palette
              layout="sheet"
              onAdd={(fieldType) => {
                dispatch({ type: "add_field", fieldType, afterId: state.selectedFieldId ?? undefined });
                setAddSheetOpen(false);
                setSettingsSheetOpen(true);
              }}
              onAddScopeField={() => {
                dispatch({ type: "add_scope_field" });
                setAddSheetOpen(false);
                setSettingsSheetOpen(true);
              }}
            />
          </BottomSheet>

          <BottomSheet
            open={settingsSheetOpen && !!selectedField}
            title={selectedField ? `${getFieldModule(selectedField.type).label} settings` : "Field settings"}
            onClose={() => setSettingsSheetOpen(false)}
          >
            <Inspector
              layout="sheet"
              selectedField={selectedField}
              allFields={state.fields}
              lookupSources={lookupSources}
              formId={formId}
              onFieldUpdate={(patch) => {
                if (selectedField) {
                  dispatch({ type: "update_field_config", fieldId: selectedField.id, patch });
                }
              }}
            />
          </BottomSheet>
        </div>
      )}

      {activeTab === "fields" && wide && (
        <div
          className="flex gap-4"
          style={{ minHeight: "calc(100vh - 320px)" }}
        >
          <Palette
            onAdd={(fieldType) =>
              dispatch({ type: "add_field", fieldType })
            }
            onAddScopeField={() => dispatch({ type: "add_scope_field" })}
          />
          <DndContext
            // Fixed id: dnd-kit's generated accessibility ids differ between
            // the server render and the browser otherwise (hydration warning).
            id="form-builder-fields"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={state.fields.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              <Canvas
                fields={state.fields}
                selectedFieldId={state.selectedFieldId}
                onSelect={(id) => dispatch({ type: "select_field", fieldId: id })}
                onDelete={(id) => dispatch({ type: "remove_field", fieldId: id })}
                onDuplicate={(id) =>
                  dispatch({ type: "duplicate_field", fieldId: id })
                }
              />
            </SortableContext>
          </DndContext>
          <Inspector
            selectedField={selectedField}
            allFields={state.fields}
            lookupSources={lookupSources}
            formId={formId}
            onFieldUpdate={(patch) => {
              if (selectedField) {
                dispatch({
                  type: "update_field_config",
                  fieldId: selectedField.id,
                  patch
                });
              }
            }}
          />
        </div>
      )}

      {activeTab === "workflow" && (
        <WorkflowTab
          workflow={state.workflow}
          fields={state.fields}
          dispatch={workflowTabDispatch}
          formId={formId}
        />
      )}

      {activeTab === "settings" && (
        <SettingsTab
          formMeta={state.formMeta}
          onUpdate={(patch) =>
            dispatch({ type: "update_form_meta", patch })
          }
          formId={formId}
          accessTag={accessTag}
          crdVisible={initial.crdVisible === true}
          fillAudience={initial.fillAudience ?? []}
        />
      )}
    </div>
  );
}
