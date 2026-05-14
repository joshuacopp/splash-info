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
import { initialState, reducer, stripBuilderArtifacts } from "./reducer";
import WorkflowTab, {
  type WorkflowTabDispatch
} from "../_workflow/WorkflowTab";
import SettingsTab from "../_workflow/SettingsTab";
import type { BuilderTab } from "../_components/FormBuilderTabs";

interface Props {
  initial: FormDetail;
  lookupSources: readonly LookupSource[];
  formId: string;
  activeTab: BuilderTab;
}

export default function BuilderClient({
  initial,
  lookupSources,
  formId,
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

  const workflowTabDispatch: WorkflowTabDispatch = {
    onEnable: () => dispatch({ type: "workflow_enable" }),
    onDisable: () => dispatch({ type: "workflow_disable" }),
    onAddStep: () => dispatch({ type: "workflow_add_step" }),
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
    onAddOutcome: () => dispatch({ type: "workflow_add_outcome" }),
    onUpdateOutcome: (outcomeId, patch) =>
      dispatch({ type: "workflow_update_outcome", outcomeId, patch }),
    onRemoveOutcome: (outcomeId) =>
      dispatch({ type: "workflow_remove_outcome", outcomeId }),
    onSetNotifications: (patch) =>
      dispatch({ type: "workflow_set_notifications", patch })
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

      {activeTab === "fields" && (
        <div
          className="flex gap-4"
          style={{ minHeight: "calc(100vh - 320px)" }}
        >
          <Palette
            onAdd={(fieldType) =>
              dispatch({ type: "add_field", fieldType })
            }
          />
          <DndContext
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
        />
      )}

      {activeTab === "settings" && (
        <SettingsTab
          formMeta={state.formMeta}
          onUpdate={(patch) =>
            dispatch({ type: "update_form_meta", patch })
          }
        />
      )}
    </div>
  );
}
