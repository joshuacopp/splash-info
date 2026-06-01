// Brief 148 — SCORM Package Builder client island.
//
// Ported from scorm-builder.html (repo root). Same data model, same
// validation rules, same build pipeline — pulled into apps/web's admin
// chrome so it lives next to Pricing, Form Builder, etc.
//
// All state lives in this single client component. No server actions, no DB
// persistence (v1 parity with the standalone tool — videos and zips never
// leave the browser).

"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { buildScormZip, safeTitleStem } from "../_lib/build";
import { formatBytes, validateState } from "../_lib/validate";
import type { BuilderState, Question } from "../_lib/types";

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
  | { type: "set_title"; value: string }
  | { type: "set_description"; value: string }
  | { type: "set_pass_score"; value: number }
  | { type: "set_video"; value: File | null }
  | { type: "add_question"; questionType: "mc" | "tf" }
  | { type: "remove_question"; id: string }
  | { type: "update_question_text"; id: string; value: string }
  | { type: "update_question_type"; id: string; value: "mc" | "tf" }
  | { type: "update_choice_text"; id: string; index: number; value: string }
  | { type: "update_correct_index"; id: string; index: number };

function makeQuestion(type: "mc" | "tf"): Question {
  return {
    id: nanoid(8),
    type,
    text: "",
    choices: type === "mc" ? ["", "", "", ""] : ["True", "False"],
    correctIndex: 0
  };
}

function initialState(): BuilderState {
  return {
    title: "",
    description: "",
    passScore: 80,
    courseId: "",
    video: null,
    questions: []
  };
}

function reducer(state: BuilderState, action: Action): BuilderState {
  switch (action.type) {
    case "set_title":
      return { ...state, title: action.value };
    case "set_description":
      return { ...state, description: action.value };
    case "set_pass_score":
      return {
        ...state,
        passScore: Math.max(1, Math.min(100, Number.isFinite(action.value) ? action.value : 80))
      };
    case "set_video":
      return { ...state, video: action.value };
    case "add_question":
      return { ...state, questions: [...state.questions, makeQuestion(action.questionType)] };
    case "remove_question":
      return { ...state, questions: state.questions.filter((q) => q.id !== action.id) };
    case "update_question_text":
      return {
        ...state,
        questions: state.questions.map((q) =>
          q.id === action.id ? { ...q, text: action.value } : q
        )
      };
    case "update_question_type": {
      const newType = action.value;
      return {
        ...state,
        questions: state.questions.map((q) =>
          q.id === action.id
            ? {
                ...q,
                type: newType,
                choices: newType === "mc" ? ["", "", "", ""] : ["True", "False"],
                correctIndex: 0
              }
            : q
        )
      };
    }
    case "update_choice_text":
      return {
        ...state,
        questions: state.questions.map((q) => {
          if (q.id !== action.id) return q;
          const choices = q.choices.slice();
          choices[action.index] = action.value;
          return { ...q, choices };
        })
      };
    case "update_correct_index":
      return {
        ...state,
        questions: state.questions.map((q) =>
          q.id === action.id ? { ...q, correctIndex: action.index } : q
        )
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Status =
  | { kind: "idle"; message: string }
  | { kind: "info"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "err"; message: string };

export default function ScormBuilderClient() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [status, setStatus] = useState<Status>({
    kind: "idle",
    message: "Fill in the fields, then build the SCORM package."
  });
  const [progress, setProgress] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Course id is generated client-side once on mount (crypto.randomUUID is
  // browser-only; can't be a useReducer initializer without hydration
  // warnings under SSR-then-mount).
  const [courseId, setCourseId] = useState("");
  useEffect(() => {
    const id =
      "COURSE-" +
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8).toUpperCase()
        : nanoid(8).toUpperCase());
    setCourseId(id);
  }, []);

  const stateWithCourseId = useMemo<BuilderState>(
    () => ({ ...state, courseId }),
    [state, courseId]
  );

  const onVideoFile = useCallback(
    (file: File | null | undefined) => {
      if (!file || typeof file.size !== "number" || file.size === 0) {
        console.warn("[scorm-builder] setVideo got an empty file:", file);
        setStatus({
          kind: "err",
          message:
            "Couldn't read that video (0 bytes). Try the file picker again, or drag-drop instead."
        });
        return;
      }
      dispatch({ type: "set_video", value: file });
      setStatus({
        kind: "ok",
        message: `Video loaded: ${file.name} (${formatBytes(file.size)}).`
      });
    },
    []
  );

  const onPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    onVideoFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragHover(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) onVideoFile(file);
  };

  const clearVideo = () => {
    dispatch({ type: "set_video", value: null });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onBuild = async () => {
    const errs = validateState(stateWithCourseId);
    if (errs.length) {
      setStatus({ kind: "err", message: errs.join(" ") });
      return;
    }
    if (!stateWithCourseId.video) return; // validateState already covers this

    setBuilding(true);
    setProgress(0);
    setStatus({ kind: "info", message: "Reading video…" });

    try {
      const blob = await buildScormZip(
        { ...stateWithCourseId, video: stateWithCourseId.video },
        {
          onProgress: (pct, message) => {
            setProgress(pct);
            setStatus({ kind: "info", message });
          }
        }
      );

      const stem = safeTitleStem(stateWithCourseId.title);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = stem + ".zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus({
        kind: "ok",
        message: "SCORM package ready. Upload the .zip to your LMS."
      });
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "err", message: "Build failed: " + msg });
    } finally {
      setBuilding(false);
      setTimeout(() => setProgress(null), 2000);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[880px] px-5 py-8">
      <div className="mb-2 text-sm">
        <a href="/admin/dashboard" className="text-splash-blue hover:underline">
          ← Dashboard
        </a>
      </div>
      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Training
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">SCORM Package Builder</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Build a video + quiz training package and download a SCORM 1.2 .zip for upload to your LMS.
        </p>
      </div>

      {/* Course basics */}
      <section className="mb-5 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-splash-navy">Course basics</h2>
        </div>
        <Field label="Course title">
          <input
            type="text"
            value={state.title}
            onChange={(e) => dispatch({ type: "set_title", value: e.target.value })}
            placeholder="e.g. Damage Claim Submission Training"
            className={inputClass}
          />
        </Field>
        <Field label="Short description (optional)">
          <textarea
            value={state.description}
            onChange={(e) =>
              dispatch({ type: "set_description", value: e.target.value })
            }
            placeholder="What this course covers in 1-2 sentences."
            className={inputClass + " min-h-[80px] resize-y"}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Pass threshold (%)"
            sub="Score the learner must hit to be marked passed."
          >
            <input
              type="number"
              min={1}
              max={100}
              value={state.passScore}
              onChange={(e) =>
                dispatch({ type: "set_pass_score", value: Number(e.target.value) })
              }
              className={inputClass}
            />
          </Field>
          <Field
            label="Course identifier (auto)"
            sub="Used inside the SCORM manifest. Don't edit."
          >
            <input
              type="text"
              value={courseId}
              readOnly
              placeholder="auto-generated"
              className={inputClass + " bg-gray-light/30 text-splash-navy/70"}
            />
          </Field>
        </div>
      </section>

      {/* Video */}
      <section className="mb-5 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-splash-navy">Video</h2>
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragHover(true);
          }}
          onDragLeave={() => setDragHover(false)}
          onDrop={onDrop}
          className={
            "cursor-pointer rounded-splash-md border-2 border-dashed px-7 py-7 text-center transition-colors " +
            (dragHover
              ? "border-sudsy-blue bg-sudsy-blue-soft"
              : "border-gray-light bg-[#fafbfd] hover:border-sudsy-blue/60")
          }
        >
          <div className="text-[15px] font-semibold text-splash-navy">
            Drop a video file here, or click to choose
          </div>
          <div className="mt-1 text-xs text-splash-navy/60">
            .mp4 recommended · .webm and .mov also work
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          onChange={onPickerChange}
          className="hidden"
        />
        {state.video && (
          <div className="mt-3 flex items-center justify-between rounded-splash-sm border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <div>
              <strong className="font-bold">{state.video.name}</strong> ·{" "}
              <span>{formatBytes(state.video.size)}</span>
            </div>
            <button
              type="button"
              onClick={clearVideo}
              className="font-semibold text-racecar-red hover:underline"
            >
              Remove
            </button>
          </div>
        )}
      </section>

      {/* Questions */}
      <section className="mb-5 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-splash-navy">Quiz questions</h2>
          <button
            type="button"
            onClick={() => dispatch({ type: "add_question", questionType: "mc" })}
            className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-3 py-1.5 text-xs font-bold text-splash-blue hover:bg-splash-blue/5"
          >
            + Add question
          </button>
        </div>
        {state.questions.length === 0 ? (
          <div className="text-sm text-splash-navy/60">
            No questions yet. Click "Add question" to start.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {state.questions.map((q, idx) => (
              <QuestionCard
                key={q.id}
                index={idx}
                question={q}
                dispatch={dispatch}
              />
            ))}
          </div>
        )}
      </section>

      {/* Build bar */}
      <div className="sticky bottom-4 z-10 flex flex-col gap-2 rounded-splash-lg border border-gray-light bg-white px-5 py-4 shadow-splash-card md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1">
          <div
            className={
              "text-sm " +
              (status.kind === "ok"
                ? "font-semibold text-emerald-700"
                : status.kind === "err"
                  ? "font-semibold text-racecar-red"
                  : "text-splash-navy/70")
            }
          >
            {status.message}
          </div>
          {progress !== null && (
            <progress
              max={100}
              value={progress}
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
            />
          )}
        </div>
        <button
          type="button"
          onClick={onBuild}
          disabled={building}
          className="inline-flex items-center justify-center rounded-splash-sm bg-splash-blue px-7 py-3 text-[15px] font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {building ? "Building…" : "Build SCORM package"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const inputClass =
  "w-full rounded-splash-sm border-[1.5px] border-gray-light bg-white px-3 py-2 text-sm text-splash-navy outline-none transition-colors focus:border-splash-blue focus:ring-2 focus:ring-sudsy-blue/30";

function Field({
  label,
  sub,
  children
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-sudsy-blue">
        {label}
      </span>
      {children}
      {sub && <span className="mt-1 block text-xs text-splash-navy/60">{sub}</span>}
    </label>
  );
}

function QuestionCard({
  index,
  question,
  dispatch
}: {
  index: number;
  question: Question;
  dispatch: React.Dispatch<Action>;
}) {
  return (
    <div className="rounded-splash-md border-[1.5px] border-gray-light bg-[#fafbfd] p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-sudsy-blue">
          Question {index + 1} · {question.type === "mc" ? "Multiple choice" : "True / False"}
        </span>
        <button
          type="button"
          onClick={() => dispatch({ type: "remove_question", id: question.id })}
          className="text-xs font-semibold text-racecar-red hover:underline"
        >
          Remove
        </button>
      </div>
      <Field label="Question text">
        <textarea
          value={question.text}
          onChange={(e) =>
            dispatch({
              type: "update_question_text",
              id: question.id,
              value: e.target.value
            })
          }
          placeholder="Write the question here"
          className={inputClass + " min-h-[60px] resize-y"}
        />
      </Field>
      <Field label="Type">
        <select
          value={question.type}
          onChange={(e) =>
            dispatch({
              type: "update_question_type",
              id: question.id,
              value: e.target.value as "mc" | "tf"
            })
          }
          className={inputClass}
        >
          <option value="mc">Multiple choice</option>
          <option value="tf">True / False</option>
        </select>
      </Field>
      {question.type === "mc" ? (
        <McChoices question={question} dispatch={dispatch} />
      ) : (
        <TfChoices question={question} dispatch={dispatch} />
      )}
    </div>
  );
}

function McChoices({
  question,
  dispatch
}: {
  question: Question;
  dispatch: React.Dispatch<Action>;
}) {
  return (
    <div className="mt-1">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-sudsy-blue">
        Choices (select the correct answer)
      </span>
      <div className="flex flex-col gap-2">
        {question.choices.map((choice, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <input
              type="radio"
              name={`correct-${question.id}`}
              checked={question.correctIndex === i}
              onChange={() =>
                dispatch({ type: "update_correct_index", id: question.id, index: i })
              }
              className="h-[18px] w-[18px] flex-shrink-0 cursor-pointer accent-splash-blue"
            />
            <input
              type="text"
              value={choice}
              onChange={(e) =>
                dispatch({
                  type: "update_choice_text",
                  id: question.id,
                  index: i,
                  value: e.target.value
                })
              }
              placeholder={`Choice ${i + 1}`}
              className={inputClass + " flex-1"}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TfChoices({
  question,
  dispatch
}: {
  question: Question;
  dispatch: React.Dispatch<Action>;
}) {
  return (
    <div className="mt-1">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-sudsy-blue">
        Correct answer
      </span>
      <div className="flex gap-2.5">
        {(["True", "False"] as const).map((label, i) => {
          const checked = question.correctIndex === i;
          return (
            <label
              key={label}
              className={
                "flex flex-1 cursor-pointer items-center gap-2 rounded-splash-sm border-[1.5px] px-3.5 py-2.5 font-semibold transition-colors " +
                (checked
                  ? "border-splash-blue bg-sudsy-blue-soft text-splash-blue"
                  : "border-gray-light bg-white text-splash-navy")
              }
            >
              <input
                type="radio"
                name={`tf-${question.id}`}
                checked={checked}
                onChange={() =>
                  dispatch({
                    type: "update_correct_index",
                    id: question.id,
                    index: i
                  })
                }
                className="h-[16px] w-[16px] flex-shrink-0 cursor-pointer accent-splash-blue"
              />
              <span>{label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
