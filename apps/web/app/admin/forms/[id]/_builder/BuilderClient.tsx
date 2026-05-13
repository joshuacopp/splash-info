// 3-column builder client island. Owns canvas state via useReducer, drag-
// and-drop via dnd-kit, and the Save Draft / Publish actions.
//
// Per Brief 95: canvas mutations are NOT server actions. They're useReducer
// dispatches mutating client-only state until the operator clicks Save Draft,
// which fires updateDraftAdmin (the canonical PATCH). Publish creates a new
// immutable form_versions row and spawns a fresh draft (Brief 94 lifecycle).

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
import Inspector, { type WorkflowDispatch } from "./Inspector";
import Palette from "./Palette";
import TopBar from "./TopBar";
import { initialState, reducer } from "./reducer";

interface Props {
  initial: FormDetail;
  lookupSources: readonly LookupSource[];
  formId: string;
}

export default function BuilderClient({ initial, lookupSources, formId }: Props) {
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
    const res = await saveDraftAction(formId, state.fields, state.workflow);
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
      const saveRes = await saveDraftAction(formId, state.fields, state.workflow);
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

  const workflowDispatch: WorkflowDispatch = {
    onEnable: () => dispatch({ type: "workflow_enable" }),
    onDisable: () => dispatch({ type: "workflow_disable" }),
    onSetDefaultStage: (stageId) =>
      dispatch({ type: "workflow_set_default_stage", stageId }),
    onAddStage: () => dispatch({ type: "workflow_add_stage" }),
    onRemoveStage: (stageId) =>
      dispatch({ type: "workflow_remove_stage", stageId }),
    onMoveStage: (stageId, direction) =>
      dispatch({ type: "workflow_move_stage", stageId, direction }),
    onUpdateStage: (stageId, patch) =>
      dispatch({ type: "workflow_update_stage", stageId, patch }),
    onSetApproverSource: (stageId, source) =>
      dispatch({ type: "workflow_set_approver_source", stageId, source }),
    onAddTransition: (stageId) =>
      dispatch({ type: "workflow_add_transition", stageId }),
    onUpdateTransition: (stageId, index, patch) =>
      dispatch({ type: "workflow_update_transition", stageId, index, patch }),
    onRemoveTransition: (stageId, index) =>
      dispatch({ type: "workflow_remove_transition", stageId, index })
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
      <div
        className="flex gap-4"
        style={{ minHeight: "calc(100vh - 280px)" }}
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
          formMeta={state.formMeta}
          workflow={state.workflow}
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
          onFormMetaUpdate={(patch) =>
            dispatch({ type: "update_form_meta", patch })
          }
          workflowDispatch={workflowDispatch}
        />
      </div>
    </div>
  );
}
