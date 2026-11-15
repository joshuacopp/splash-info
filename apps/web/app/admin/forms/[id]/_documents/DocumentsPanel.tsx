"use client";

// Documents tab (/admin/forms/{id}?tab=documents) -- fill an uploaded PDF from
// this form, the JotForm way (PLAN_FORMS_PDF_TEMPLATES.md): upload the blank
// document, drag boxes onto its pages, say what goes in each, then tick the
// document on an email step ("Attach filled documents") to send it.
//
// Talks to the forms worker straight from the browser (same origin, /forms/*):
// the upload is multipart, the blank PDF feeds pdf.js, and the preview comes
// back as a PDF -- none of which suit a server action.
//
// pdf.js is VENDORED in the forms worker (static/pdfjs*.js, served at
// /forms/api/static/pdfjs-4.10.38*.js) and loaded at runtime with a
// webpackIgnore'd dynamic import, so it is not bundled into apps/web and
// only loads on this tab. No CDN (CLAUDE.md supply-chain posture).
//
// Box coordinates are PDF points from the page's top-left (pdf-template.ts);
// the page is drawn at `scale` px per point, so screen px = points * scale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Field, FormWorkflow } from "@splash/forms-schema";
import type { PdfBox, PdfBoxSource, PdfTemplate } from "@splash/forms-schema/pdf-template";

const PDFJS_URL = "/forms/api/static/pdfjs-4.10.38.min.js";
const PDFJS_WORKER_URL = "/forms/api/static/pdfjs-4.10.38.worker.min.js";
const MAX_PAGE_PX = 860;

interface Props {
  formId: string;
  fields: Field[];
  workflow: FormWorkflow | null;
  initialTemplates: PdfTemplate[];
}

function api(formId: string, rest = ""): string {
  return `/forms/admin/api/forms/${encodeURIComponent(formId)}/pdf-templates${rest}`;
}

async function errorText(r: Response): Promise<string> {
  const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  return j.message ?? j.error ?? `Request failed (${r.status})`;
}

// --- list -----------------------------------------------------------------------------

export default function DocumentsPanel({ formId, fields, workflow, initialTemplates }: Props) {
  const [templates, setTemplates] = useState<PdfTemplate[]>(initialTemplates);
  const [editing, setEditing] = useState<PdfTemplate | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function upload() {
    if (!file || !name.trim()) {
      setNotice({ kind: "error", text: "Give the document a name and choose a PDF." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const fd = new FormData();
    fd.append("name", name.trim());
    fd.append("file", file);
    const r = await fetch(api(formId), { method: "POST", body: fd, credentials: "same-origin" }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      setNotice({ kind: "error", text: r ? await errorText(r) : "Upload failed." });
      return;
    }
    const { template } = (await r.json()) as { template: PdfTemplate };
    setTemplates((t) => [...t, template]);
    setName("");
    setFile(null);
    setEditing(template);
  }

  async function remove(t: PdfTemplate) {
    if (!window.confirm(`Delete "${t.name}"? Email steps that attach it will stop attaching it.`)) return;
    const r = await fetch(api(formId, `/${t.id}`), { method: "DELETE", credentials: "same-origin" }).catch(() => null);
    if (r?.ok) setTemplates((list) => list.filter((x) => x.id !== t.id));
    else setNotice({ kind: "error", text: r ? await errorText(r) : "Delete failed." });
  }

  if (editing) {
    return (
      <TemplateEditor
        formId={formId}
        template={editing}
        fields={fields}
        workflow={workflow}
        onBack={() => setEditing(null)}
        onSaved={(t) => setTemplates((list) => list.map((x) => (x.id === t.id ? t : x)))}
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-splash-navy/80">
        Fill a real document from this form: upload the blank PDF, draw boxes where the answers go, then tick it on an
        email step (&quot;Attach filled documents&quot; on the Workflow tab). From Word, use File &gt; Save As &gt; PDF
        first.
      </p>

      <section className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
        <h2 className="text-sm font-bold uppercase tracking-wide text-splash-navy/80">Add a document</h2>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-splash-navy/80">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Rate of Pay Change form"
              className="mt-1 block w-72 rounded border border-gray-light px-3 py-1.5 text-sm font-normal"
            />
          </label>
          <label className="text-xs font-semibold text-splash-navy/80">
            Blank PDF
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block text-sm font-normal"
            />
          </label>
          <button
            type="button"
            onClick={upload}
            disabled={busy}
            className="rounded-full bg-splash-navy px-4 py-2 text-sm font-bold text-white shadow-splash-btn disabled:opacity-60"
          >
            {busy ? "Uploading..." : "Upload"}
          </button>
        </div>
      </section>

      {notice ? <Notice notice={notice} /> : null}

      {templates.length === 0 ? (
        <p className="rounded-splash-lg border border-dashed border-gray-light bg-white p-6 text-sm text-splash-navy/70">
          No documents yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
              <div>
                <p className="font-bold text-splash-navy">{t.name}</p>
                <p className="text-xs text-splash-navy/60">
                  {t.pages.length} page{t.pages.length === 1 ? "" : "s"} &middot; {t.boxes.length} box{t.boxes.length === 1 ? "" : "es"}
                </p>
              </div>
              <div className="flex gap-2">
                <SmallButton onClick={() => setEditing(t)}>Edit boxes</SmallButton>
                <SmallButton onClick={() => remove(t)} danger>
                  Delete
                </SmallButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- sources --------------------------------------------------------------------------

type SourceOption = { value: string; label: string; group: string };

const FILLABLE = (f: Field) => !["heading", "image", "hidden"].includes(f.type);
const CHOICE = (f: Field) => ["radio", "dropdown", "multi"].includes(f.type);

function stageList(workflow: FormWorkflow | null) {
  return (workflow?.stages ?? []).filter(
    (s) => s.kind !== "email" && s.kind !== "outcome" && (s.kind === "approval" || !!s.approver_source)
  );
}

const STAGE_PARTS: { part: "by" | "date" | "signature" | "typed_name" | "note"; label: string }[] = [
  { part: "by", label: "who approved" },
  { part: "date", label: "date" },
  { part: "signature", label: "signature" },
  { part: "typed_name", label: "typed name" },
  { part: "note", label: "note" }
];

function sourceKey(s: PdfBoxSource): string {
  switch (s.type) {
    case "field":
      return `field:${s.key}`;
    case "check":
      return `check:${s.key}`;
    case "stage":
      return `stage:${s.stage}:${s.part}`;
    default:
      return s.type;
  }
}

function sourceFromKey(k: string, fields: Field[], prev: PdfBoxSource): PdfBoxSource {
  if (k.startsWith("field:")) return { type: "field", key: k.slice(6) };
  if (k.startsWith("check:")) {
    const key = k.slice(6);
    const opts = (fields.find((f) => f.key === key) as { options?: { value: string }[] } | undefined)?.options ?? [];
    return { type: "check", key, value: prev.type === "check" && prev.key === key ? prev.value : opts[0]?.value ?? "" };
  }
  if (k.startsWith("stage:")) {
    const [, stage, part] = k.split(":");
    return { type: "stage", stage: stage!, part: part as "by" };
  }
  if (k === "text") return { type: "text", text: prev.type === "text" ? prev.text : "" };
  return { type: k as "submitted_date" | "submission_id" };
}

function shortLabel(s: PdfBoxSource, fields: Field[]): string {
  const fl = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  switch (s.type) {
    case "field":
      return fl(s.key);
    case "check": {
      const f = fields.find((x) => x.key === s.key) as { options?: { label: string; value: string }[] } | undefined;
      return `✓ ${f?.options?.find((o) => o.value === s.value)?.label ?? s.value}`;
    }
    case "stage":
      return `${s.stage}: ${STAGE_PARTS.find((p) => p.part === s.part)?.label ?? s.part}`;
    case "submitted_date":
      return "Date submitted";
    case "submission_id":
      return "Submission #";
    case "text":
      return s.text ? `"${s.text}"` : "Fixed text";
  }
}

// --- editor ------------------------------------------------------------------------------

type Drag =
  | { kind: "draw"; page: number; x0: number; y0: number; x1: number; y1: number; rect: DOMRect; scale: number }
  | { kind: "move" | "resize"; id: string; corner?: "nw" | "ne" | "sw" | "se"; startX: number; startY: number; orig: PdfBox; scale: number };

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function TemplateEditor({
  formId,
  template,
  fields,
  workflow,
  onBack,
  onSaved
}: {
  formId: string;
  template: PdfTemplate;
  fields: Field[];
  workflow: FormWorkflow | null;
  onBack: () => void;
  onSaved: (t: PdfTemplate) => void;
}) {
  const [boxes, setBoxes] = useState<PdfBox[]>(template.boxes);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [width, setWidth] = useState(MAX_PAGE_PX);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fillable = useMemo(() => fields.filter(FILLABLE), [fields]);
  const choices = useMemo(() => fields.filter(CHOICE), [fields]);
  const stages = useMemo(() => stageList(workflow), [workflow]);

  const sourceOptions: SourceOption[] = useMemo(
    () => [
      ...fillable.map((f) => ({ value: `field:${f.key}`, label: f.label || f.key, group: "Form answers" })),
      ...choices.map((f) => ({ value: `check:${f.key}`, label: `Tick when "${f.label || f.key}" is...`, group: "Tick boxes" })),
      ...stages.flatMap((s) =>
        STAGE_PARTS.map((p) => ({ value: `stage:${s.id}:${p.part}`, label: `${s.label || s.id}: ${p.label}`, group: "Approval steps" }))
      ),
      { value: "submitted_date", label: "Date submitted", group: "Other" },
      { value: "submission_id", label: "Submission number", group: "Other" },
      { value: "text", label: "Fixed text", group: "Other" }
    ],
    [fillable, choices, stages]
  );

  // Page width follows the container (phones / narrow windows), capped.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(MAX_PAGE_PX, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw the PDF's pages with pdf.js.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url: string = PDFJS_URL;
        // Untyped on purpose: pdf.js is loaded from the worker at runtime, not installed.
        const pdfjs = (await import(/* webpackIgnore: true */ url)) as {
          GlobalWorkerOptions: { workerSrc: string };
          getDocument: (o: { url: string; withCredentials: boolean }) => {
            promise: Promise<{
              getPage: (n: number) => Promise<{
                getViewport: (o: { scale: number }) => { width: number; height: number };
                render: (o: { canvasContext: CanvasRenderingContext2D | null; viewport: unknown }) => { promise: Promise<void> };
              }>;
            }>;
          };
        };
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        const doc = await pdfjs.getDocument({ url: api(formId, `/${template.id}/file`), withCredentials: true }).promise;
        const dpr = window.devicePixelRatio || 1;
        for (let i = 0; i < template.pages.length; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i + 1);
          const scale = width / template.pages[i]!.w;
          const vp = page.getViewport({ scale: scale * dpr });
          const canvas = canvasRefs.current[i];
          if (!canvas) continue;
          canvas.width = vp.width;
          canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formId, template.id, template.pages, width]);

  const update = useCallback((id: string, patch: Partial<PdfBox>) => {
    setBoxes((list) => list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    setDirty(true);
  }, []);

  // Pointer drags: draw a new box, move one, or resize from a corner.
  useEffect(() => {
    if (!drag) return;
    const pageOf = (b: { page: number }) => template.pages[b.page]!;
    function onMove(e: PointerEvent) {
      if (!drag) return;
      if (drag.kind === "draw") {
        setDrag({ ...drag, x1: (e.clientX - drag.rect.left) / drag.scale, y1: (e.clientY - drag.rect.top) / drag.scale });
        return;
      }
      const dx = (e.clientX - drag.startX) / drag.scale;
      const dy = (e.clientY - drag.startY) / drag.scale;
      const o = drag.orig;
      const pg = pageOf(o);
      if (drag.kind === "move") {
        update(o.id, {
          x: round(Math.min(Math.max(0, o.x + dx), pg.w - o.w)),
          y: round(Math.min(Math.max(0, o.y + dy), pg.h - o.h))
        });
        return;
      }
      let { x, y, w, h } = o;
      const c = drag.corner!;
      if (c.includes("e")) w = Math.max(4, o.w + dx);
      if (c.includes("s")) h = Math.max(4, o.h + dy);
      if (c.includes("w")) {
        w = Math.max(4, o.w - dx);
        x = o.x + o.w - w;
      }
      if (c.includes("n")) {
        h = Math.max(4, o.h - dy);
        y = o.y + o.h - h;
      }
      update(o.id, { x: round(Math.max(0, x)), y: round(Math.max(0, y)), w: round(Math.min(w, pg.w)), h: round(Math.min(h, pg.h)) });
    }
    function onUp() {
      if (drag?.kind === "draw") {
        const pg = template.pages[drag.page]!;
        const x = Math.max(0, Math.min(drag.x0, drag.x1));
        const y = Math.max(0, Math.min(drag.y0, drag.y1));
        const w = Math.min(Math.abs(drag.x1 - drag.x0), pg.w - x);
        const h = Math.min(Math.abs(drag.y1 - drag.y0), pg.h - y);
        if (w >= 6 && h >= 6) {
          const first = fillable[0];
          const box: PdfBox = {
            id: newId(),
            page: drag.page,
            x: round(x),
            y: round(y),
            w: round(w),
            h: round(h),
            source: first ? { type: "field", key: first.key } : { type: "text", text: "" }
          };
          setBoxes((list) => [...list, box]);
          setSelected(box.id);
          setDirty(true);
        }
      }
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, fillable, template.pages, update]);

  // Arrow keys nudge the selected box (Shift = 10pt); Delete removes it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selected) return;
      const t = e.target as HTMLElement;
      if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      const b = boxes.find((x) => x.id === selected);
      if (!b) return;
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        const [dx, dy] = moves[e.key]!;
        update(b.id, { x: round(Math.max(0, b.x + dx)), y: round(Math.max(0, b.y + dy)) });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setBoxes((list) => list.filter((x) => x.id !== b.id));
        setSelected(null);
        setDirty(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boxes, selected, update]);

  async function save(): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    const r = await fetch(api(formId, `/${template.id}`), {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxes })
    }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      setNotice({ kind: "error", text: r ? await errorText(r) : "Save failed." });
      return false;
    }
    const { template: t } = (await r.json()) as { template: PdfTemplate };
    onSaved(t);
    setDirty(false);
    setNotice({ kind: "ok", text: "Saved." });
    return true;
  }

  async function preview() {
    // Open the tab first (synchronously, inside the click) so pop-up blockers allow it.
    const win = window.open("", "_blank");
    setBusy(true);
    const r = await fetch(api(formId, `/${template.id}/preview`), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxes })
    }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      win?.close();
      setNotice({ kind: "error", text: r ? await errorText(r) : "Preview failed." });
      return;
    }
    const from = r.headers.get("X-Preview-Source") ?? "";
    const blobUrl = URL.createObjectURL(await r.blob());
    if (win) win.location.href = blobUrl;
    else window.open(blobUrl, "_blank");
    setNotice({
      kind: "ok",
      text: from.startsWith("submission:")
        ? "Preview filled from the most recent submission."
        : "No submissions yet, so the preview shows what each box is set to, in [brackets]."
    });
  }

  const sel = boxes.find((b) => b.id === selected) ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (dirty && !window.confirm("Leave without saving your box changes?")) return;
              onBack();
            }}
            className="text-sm text-splash-blue hover:underline"
          >
            Back to documents
          </button>
          <span className="font-bold text-splash-navy">{template.name}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={preview} disabled={busy} className="rounded-full border border-splash-navy px-4 py-1.5 text-sm font-bold text-splash-navy disabled:opacity-60">
              Preview
            </button>
            <button type="button" onClick={save} disabled={busy || !dirty} className="rounded-full bg-splash-navy px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn disabled:opacity-60">
              {busy ? "Working..." : dirty ? "Save boxes" : "Saved"}
            </button>
          </div>
        </div>
        <p className="text-xs text-splash-navy/60">
          Drag on the page to draw a box. Drag a box to move it, or its corners to resize. Arrow keys nudge the selected
          box (Shift for bigger steps); Delete removes it.
        </p>
        {notice ? <Notice notice={notice} /> : null}
        {loadError ? <p className="text-sm text-red-700">Couldn&apos;t draw the PDF: {loadError}</p> : null}

        <div ref={wrapRef} className="space-y-4">
          {template.pages.map((pg, pi) => {
            const scale = width / pg.w;
            return (
              <div key={pi}>
                {template.pages.length > 1 ? <p className="mb-1 text-xs text-splash-navy/60">Page {pi + 1}</p> : null}
                <div
                  className="relative select-none border border-gray-light bg-white shadow-sm"
                  style={{ width: pg.w * scale, height: pg.h * scale, touchAction: "none" }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = (e.clientX - rect.left) / scale;
                    const y = (e.clientY - rect.top) / scale;
                    setSelected(null);
                    setDrag({ kind: "draw", page: pi, x0: x, y0: y, x1: x, y1: y, rect, scale });
                  }}
                >
                  <canvas
                    ref={(el) => {
                      canvasRefs.current[pi] = el;
                    }}
                    style={{ width: pg.w * scale, height: pg.h * scale }}
                    className="pointer-events-none absolute inset-0"
                  />
                  {boxes
                    .filter((b) => b.page === pi)
                    .map((b) => {
                      const isSel = b.id === selected;
                      return (
                        <div
                          key={b.id}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setSelected(b.id);
                            setDrag({ kind: "move", id: b.id, startX: e.clientX, startY: e.clientY, orig: b, scale });
                          }}
                          className={`absolute cursor-move overflow-hidden border text-[10px] leading-tight ${
                            isSel ? "border-splash-blue bg-splash-blue/20" : "border-amber-500 bg-amber-200/40"
                          }`}
                          style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }}
                          title={shortLabel(b.source, fields)}
                        >
                          <span className="pointer-events-none block truncate px-0.5 text-splash-navy">{shortLabel(b.source, fields)}</span>
                          {isSel
                            ? (["nw", "ne", "sw", "se"] as const).map((c) => (
                                <span
                                  key={c}
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    setDrag({ kind: "resize", id: b.id, corner: c, startX: e.clientX, startY: e.clientY, orig: b, scale });
                                  }}
                                  className="absolute h-2.5 w-2.5 border border-white bg-splash-blue"
                                  style={{
                                    [c.includes("n") ? "top" : "bottom"]: -4,
                                    [c.includes("w") ? "left" : "right"]: -4,
                                    cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize"
                                  }}
                                />
                              ))
                            : null}
                        </div>
                      );
                    })}
                  {drag?.kind === "draw" && drag.page === pi ? (
                    <div
                      className="pointer-events-none absolute border border-dashed border-splash-blue bg-splash-blue/10"
                      style={{
                        left: Math.min(drag.x0, drag.x1) * scale,
                        top: Math.min(drag.y0, drag.y1) * scale,
                        width: Math.abs(drag.x1 - drag.x0) * scale,
                        height: Math.abs(drag.y1 - drag.y0) * scale
                      }}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        {sel ? (
          <BoxInspector
            box={sel}
            fields={fields}
            sourceOptions={sourceOptions}
            onChange={(patch) => update(sel.id, patch)}
            onDuplicate={() => {
              const copy = { ...sel, id: newId(), y: round(sel.y + sel.h + 4) };
              setBoxes((l) => [...l, copy]);
              setSelected(copy.id);
              setDirty(true);
            }}
            onDelete={() => {
              setBoxes((l) => l.filter((x) => x.id !== sel.id));
              setSelected(null);
              setDirty(true);
            }}
          />
        ) : (
          <div className="rounded-splash-lg border border-gray-light bg-white p-4 text-sm text-splash-navy/70 shadow-splash-card">
            <p className="font-bold text-splash-navy">{boxes.length} box{boxes.length === 1 ? "" : "es"}</p>
            <p className="mt-1">Click a box to set what goes in it, or drag on the page to add one.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

// --- box inspector ----------------------------------------------------------------------

function BoxInspector({
  box,
  fields,
  sourceOptions,
  onChange,
  onDuplicate,
  onDelete
}: {
  box: PdfBox;
  fields: Field[];
  sourceOptions: SourceOption[];
  onChange: (patch: Partial<PdfBox>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const key = sourceKey(box.source);
  const groups = [...new Set(sourceOptions.map((o) => o.group))];
  const isText = box.source.type !== "check" && !(box.source.type === "stage" && box.source.part === "signature") &&
    !(box.source.type === "field" && ["signature", "file"].includes(fields.find((f) => f.key === (box.source as { key: string }).key)?.type ?? ""));
  const checkField =
    box.source.type === "check"
      ? (fields.find((f) => f.key === (box.source as { key: string }).key) as { options?: { label: string; value: string }[] } | undefined)
      : undefined;
  const num = (v: string) => (v === "" ? undefined : Number(v));

  return (
    <div className="space-y-3 rounded-splash-lg border border-gray-light bg-white p-4 text-sm text-splash-navy shadow-splash-card">
      <label className="block text-xs font-semibold text-splash-navy/80">
        Fill with
        <select
          value={key}
          onChange={(e) => onChange({ source: sourceFromKey(e.target.value, fields, box.source) })}
          className="mt-1 block w-full rounded border border-gray-light px-2 py-1.5 text-sm font-normal"
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {sourceOptions
                .filter((o) => o.group === g)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
          {!sourceOptions.some((o) => o.value === key) ? <option value={key}>{key} (no longer on the form)</option> : null}
        </select>
      </label>

      {box.source.type === "check" ? (
        <label className="block text-xs font-semibold text-splash-navy/80">
          Tick this box when the answer is
          <select
            value={box.source.value}
            onChange={(e) => onChange({ source: { ...(box.source as { type: "check"; key: string }), value: e.target.value } })}
            className="mt-1 block w-full rounded border border-gray-light px-2 py-1.5 text-sm font-normal"
          >
            {(checkField?.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {box.source.type === "text" ? (
        <label className="block text-xs font-semibold text-splash-navy/80">
          Text
          <input
            value={box.source.text}
            maxLength={500}
            onChange={(e) => onChange({ source: { type: "text", text: e.target.value } })}
            className="mt-1 block w-full rounded border border-gray-light px-2 py-1.5 text-sm font-normal"
          />
        </label>
      ) : null}

      {isText ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-splash-navy/80">
              Font size
              <input
                type="number"
                min={4}
                max={72}
                value={box.font_size ?? ""}
                placeholder="auto"
                onChange={(e) => onChange({ font_size: num(e.target.value) })}
                className="mt-1 block w-full rounded border border-gray-light px-2 py-1 text-sm font-normal"
              />
            </label>
            <label className="text-xs font-semibold text-splash-navy/80">
              Align
              <select
                value={box.align ?? "left"}
                onChange={(e) => onChange({ align: e.target.value === "left" ? undefined : (e.target.value as "center") })}
                className="mt-1 block w-full rounded border border-gray-light px-2 py-1 text-sm font-normal"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!box.multiline} onChange={(e) => onChange({ multiline: e.target.checked || undefined })} />
            Wrap onto several lines
          </label>
          {box.multiline ? (
            <label className="block text-xs font-semibold text-splash-navy/80">
              Line spacing (points)
              <input
                type="number"
                min={4}
                max={100}
                value={box.line_height ?? ""}
                placeholder="auto"
                onChange={(e) => onChange({ line_height: num(e.target.value) })}
                className="mt-1 block w-full rounded border border-gray-light px-2 py-1 text-sm font-normal"
              />
              <span className="mt-0.5 block font-normal text-splash-navy/60">Match the gap between the form&apos;s printed lines so the text sits on them.</span>
            </label>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-splash-navy/60">
          {box.source.type === "check" ? "An X is drawn in this box when the answer matches." : "The image is fitted inside the box, sitting on its bottom edge."}
        </p>
      )}

      <fieldset className="grid grid-cols-4 gap-1">
        <legend className="mb-1 text-xs font-semibold text-splash-navy/80">Position (points)</legend>
        {(["x", "y", "w", "h"] as const).map((k) => (
          <label key={k} className="text-[11px] text-splash-navy/70">
            {k.toUpperCase()}
            <input
              type="number"
              step={0.5}
              value={box[k]}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= (k === "w" || k === "h" ? 1 : 0)) onChange({ [k]: v } as Partial<PdfBox>);
              }}
              className="block w-full rounded border border-gray-light px-1 py-0.5 text-xs"
            />
          </label>
        ))}
      </fieldset>

      <div className="flex gap-2 pt-1">
        <SmallButton onClick={onDuplicate}>Duplicate</SmallButton>
        <SmallButton onClick={onDelete} danger>
          Delete box
        </SmallButton>
      </div>
    </div>
  );
}

// --- bits -------------------------------------------------------------------------------

function SmallButton({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-bold ${danger ? "border-red-300 text-red-700 hover:bg-red-50" : "border-splash-navy text-splash-navy hover:bg-splash-navy/5"}`}
    >
      {children}
    </button>
  );
}

function Notice({ notice }: { notice: { kind: "ok" | "error"; text: string } }) {
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>
      {notice.text}
    </p>
  );
}
