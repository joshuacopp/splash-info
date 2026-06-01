// Brief 148 — Builder state validation. Mirrors scorm-builder.html `validate()`.

import type { BuilderState } from "./types";

export function validateState(state: BuilderState): string[] {
  const errs: string[] = [];
  if (!state.title.trim()) errs.push("Title is required.");
  if (!state.video) errs.push("Video file is required.");
  if (state.questions.length === 0) errs.push("Add at least one question.");
  state.questions.forEach((q, i) => {
    if (!q.text.trim()) errs.push(`Question ${i + 1} text is empty.`);
    if (q.type === "mc") {
      const filled = q.choices.filter((c) => c.trim()).length;
      if (filled < 2) errs.push(`Question ${i + 1} needs at least 2 choices.`);
      const correct = q.choices[q.correctIndex];
      if (!correct || !correct.trim()) {
        errs.push(`Question ${i + 1}: the marked-correct choice is empty.`);
      }
    }
  });
  return errs;
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
