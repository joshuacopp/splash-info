// Brief 96 — submission status pill. Three states (new / in_progress /
// closed) mirroring the form_submissions.status enum from Brief 89's
// schema. Same shape as the form status pill in /admin/forms (Brief 95)
// and the legacy fleet StatusPill (Brief 83) — neutral / amber / green
// per state. Splash tokens used to stay aligned with the rest of the
// admin UI palette.

import type { SubmissionStatus } from "../../../_lib/worker-fetch";

interface Props {
  status: SubmissionStatus;
}

export default function StatusPill({ status }: Props) {
  const cls =
    status === "closed"
      ? "bg-splash-success/15 text-splash-success"
      : status === "in_progress"
        ? "bg-amber-100 text-amber-800"
        : "bg-gray-light text-splash-navy/80";
  const label =
    status === "in_progress" ? "In progress" : capitalize(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {label}
    </span>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
