// Brief 148 — Shared data model for the SCORM Package Builder.
//
// Mirrors the standalone scorm-builder.html `state` object exactly so the
// helper modules (manifest, player, build) stay drop-in equivalent to the
// inline JS in that file.

export interface Question {
  /** Stable id used as React key and for radio-group `name` attrs. */
  id: string;
  type: "mc" | "tf";
  text: string;
  /** ["", "", "", ""] for mc; ["True", "False"] for tf. */
  choices: string[];
  correctIndex: number;
}

export interface BuilderState {
  title: string;
  description: string;
  passScore: number;
  /** Auto-generated; readonly in UI. Persisted into the SCORM manifest. */
  courseId: string;
  video: File | null;
  questions: Question[];
}
