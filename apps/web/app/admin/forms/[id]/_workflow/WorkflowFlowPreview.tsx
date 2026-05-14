// Brief 125 — live diagram of the workflow's flow.
//
// Renamed from Brief 123's `WorkflowMermaidPreview` to use user language
// ("Flow preview", not "Mermaid preview"). Mermaid is still the underlying
// renderer (lazy-loaded via `next/dynamic({ ssr: false })` in the parent).
// Three node classes now:
//   - `:::entry`   — "Form submitted" anchor (gray-toned)
//   - `:::step`    — approval steps (blue/info-toned)
//   - `:::outcome` — outcomes (color varies by tint)
//
// Re-render is debounced 300 ms. Mermaid's `render()` returns an SVG
// string injected via `dangerouslySetInnerHTML`; Mermaid sanitizes
// user-supplied label text on the way in.

"use client";

import { useEffect, useRef, useState } from "react";
import type { FormWorkflow, WorkflowStage } from "@splash/forms-schema";

import { stageIsEmail, stageIsOutcome } from "../_builder/reducer";

interface Props {
  workflow: FormWorkflow;
}

function escMermaidLabel(raw: string): string {
  return raw
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "/")
    .replace(/\n/g, " ")
    .trim();
}

function tintToClass(tint: WorkflowStage["tint"]): string {
  switch (tint) {
    case "success":
      return "outcomeSuccess";
    case "danger":
      return "outcomeDanger";
    case "warning":
      return "outcomeWarning";
    case "info":
      return "outcomeInfo";
    default:
      return "outcomeNeutral";
  }
}

function buildMermaidSource(workflow: FormWorkflow): string {
  if (workflow.stages.length === 0) return "";
  const lines: string[] = ["flowchart LR"];
  lines.push(`  __entry__(["Form submitted"]):::entry`);

  for (const stage of workflow.stages) {
    const label = escMermaidLabel(stage.label || stage.id);
    if (stageIsOutcome(stage)) {
      lines.push(`  ${stage.id}(("${label}")):::${tintToClass(stage.tint)}`);
    } else if (stageIsEmail(stage)) {
      lines.push(`  ${stage.id}["📧 ${label}"]:::emailstep`);
    } else {
      lines.push(`  ${stage.id}["${label}"]:::step`);
    }
  }

  // Entry edge to default step.
  if (
    workflow.default_stage &&
    workflow.stages.some((s) => s.id === workflow.default_stage)
  ) {
    lines.push(`  __entry__ --> ${workflow.default_stage}`);
  }

  for (const stage of workflow.stages) {
    const isEmail = stageIsEmail(stage);
    for (const t of stage.transitions) {
      if (!t.to) continue;
      // Email steps auto-advance and never carry a meaningful action
      // label (the operator picks "Then go to" but there's no
      // approver-facing button). Render as an unlabeled edge.
      if (isEmail) {
        lines.push(`  ${stage.id} --> ${t.to}`);
        continue;
      }
      const label = escMermaidLabel(t.label || "Move");
      lines.push(`  ${stage.id} -->|${label}| ${t.to}`);
    }
  }

  lines.push("  classDef entry fill:#f1f5f9,stroke:#64748b,color:#1e293b,stroke-width:1px");
  lines.push("  classDef step fill:#ffffff,stroke:#1e3a8a,color:#1e3a8a,stroke-width:1.5px");
  lines.push("  classDef emailstep fill:#fffbeb,stroke:#d97706,color:#78350f,stroke-width:1.5px");
  lines.push("  classDef outcomeSuccess fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:1.5px");
  lines.push("  classDef outcomeDanger fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:1.5px");
  lines.push("  classDef outcomeWarning fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:1.5px");
  lines.push("  classDef outcomeInfo fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:1.5px");
  lines.push("  classDef outcomeNeutral fill:#f1f5f9,stroke:#64748b,color:#1e293b,stroke-width:1.5px");
  return lines.join("\n");
}

export default function WorkflowFlowPreview({ workflow }: Props) {
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const idRef = useRef<number>(0);

  useEffect(() => {
    if (workflow.stages.length === 0) {
      setSvg("");
      setErr(null);
      return;
    }
    const source = buildMermaidSource(workflow);
    if (!source) {
      setSvg("");
      setErr(null);
      return;
    }
    const renderId = `wfprev-${++idRef.current}`;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mod = await import("mermaid");
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          themeVariables: {
            fontFamily:
              'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
          }
        });
        const { svg: rendered } = await mermaid.render(renderId, source);
        if (!cancelled) {
          setSvg(rendered);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : String(e);
          setErr(message);
          setSvg("");
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workflow]);

  if (workflow.stages.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1 rounded-splash-md border border-gray-light bg-white p-3">
      {err ? (
        <p className="text-[0.7rem] text-racecar-red">
          Preview failed to render: {err}
        </p>
      ) : svg ? (
        <div
          className="workflow-flow-preview overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="text-[0.7rem] text-splash-navy/60">Rendering…</p>
      )}
    </div>
  );
}
