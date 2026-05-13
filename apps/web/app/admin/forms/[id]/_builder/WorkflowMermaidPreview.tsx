// Brief 123 — live Mermaid flowchart preview of the workflow graph.
//
// Mermaid is lazy-loaded (~250 KB minified) — only operators editing
// workflows pay the cost. The outer `<WorkflowEditor>` already imports
// this module via `next/dynamic({ ssr: false })`, so the chunk is also
// kept out of the SSR runtime entirely.
//
// Re-render is debounced at 300 ms to avoid jank during fast typing.
// Mermaid's `render()` returns an SVG string that we inject via
// dangerouslySetInnerHTML; Mermaid sanitizes user-supplied label text on
// the way in.

"use client";

import { useEffect, useRef, useState } from "react";
import type { FormWorkflow, WorkflowStage } from "@splash/forms-schema";

interface Props {
  workflow: FormWorkflow;
}

function isTerminal(stage: WorkflowStage): boolean {
  return stage.transitions.length === 0 && !stage.approver_source;
}

// Escape characters that Mermaid would interpret structurally inside an
// edge label or node label. Mermaid's edge labels use `|...|` and node
// labels use `[...]`; backslashes and pipes need to be tame.
function escMermaidLabel(raw: string): string {
  return raw
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "/")
    .replace(/\n/g, " ")
    .trim();
}

// Mermaid node ids must be alphanumeric + underscore — that's what the
// stage_id regex enforces (`^[a-z][a-z0-9_]*$`), so we can pass
// `stage.id` through verbatim.
function buildMermaidSource(workflow: FormWorkflow): string {
  const lines: string[] = ["flowchart LR"];
  if (workflow.stages.length === 0) {
    return "";
  }
  for (const stage of workflow.stages) {
    const label = escMermaidLabel(stage.label || stage.id);
    const cls = isTerminal(stage) ? "terminal" : "approval";
    const prefix = stage.id === workflow.default_stage ? "START · " : "";
    lines.push(`  ${stage.id}["${prefix}${label}"]:::${cls}`);
  }
  for (const stage of workflow.stages) {
    for (const t of stage.transitions) {
      if (!t.to) continue;
      const label = escMermaidLabel(t.label || "Move");
      lines.push(`  ${stage.id} -->|${label}| ${t.to}`);
    }
  }
  lines.push(
    "  classDef approval fill:#ffffff,stroke:#1e3a8a,color:#1e3a8a,stroke-width:1.5px"
  );
  lines.push(
    "  classDef terminal fill:#f1f5f9,stroke:#64748b,color:#475569,stroke-width:1px"
  );
  if (workflow.stages.some((s) => s.id === workflow.default_stage)) {
    lines.push(`  class ${workflow.default_stage} approval`);
  }
  return lines.join("\n");
}

export default function WorkflowMermaidPreview({ workflow }: Props) {
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
    <div className="space-y-1 rounded-splash-sm border border-gray-light bg-white p-2">
      <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
        Workflow preview
      </p>
      {err ? (
        <p className="text-[0.7rem] text-racecar-red">
          Preview failed to render: {err}
        </p>
      ) : svg ? (
        <div
          className="workflow-mermaid-preview overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="text-[0.7rem] text-splash-navy/60">Rendering…</p>
      )}
    </div>
  );
}
