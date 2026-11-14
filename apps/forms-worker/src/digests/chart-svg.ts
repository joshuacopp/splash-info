// Digest charts as SVG, rasterised to PNG for email (chart-png.ts). Email
// clients run no scripts and Outlook drops SVG, so the email gets a picture;
// the numbers behind it are always in the table under it.
//
// Design rules (dataviz skill): categorical hues in a FIXED order, never
// cycled, past 7 series the rest is "Other" in gray (aggregate.ts folds them);
// one y axis; thin marks with a 2px surface gap between fills; recessive grid
// and axes; a legend whenever there are two or more series; text in ink
// colours, never the series colour. Average + split draws GROUPED bars --
// stacking averages adds numbers that mean nothing.

import type { ChartData } from "./aggregate.js";
import { OTHER_KEY } from "./aggregate.js";

// Validated light-mode categorical slots 1-7 (dataviz references/palette.md).
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
export const OTHER_COLOR = "#a3a29c";
const INK = "#0b0b0b";
const INK_2 = "#52514e";
const GRID = "#e6e5e1";
const SURFACE = "#ffffff";
export const FONT_FAMILY = "Noto Sans";

export const CHART_W = 600;

export function seriesColor(key: string, index: number): string {
  return key === OTHER_KEY ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length]!;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function text(x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: string; weight?: string } = {}): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${o.size ?? 11}" fill="${o.fill ?? INK_2}" text-anchor="${o.anchor ?? "start"}"${o.weight ? ` font-weight="${o.weight}"` : ""}>${esc(s)}</text>`;
}

/** Rough width of a label in px (Noto Sans averages ~0.55em). */
function textWidth(s: string, size = 11): number {
  return s.length * size * 0.56;
}

function truncate(s: string, maxPx: number, size = 11): string {
  if (textWidth(s, size) <= maxPx) return s;
  const n = Math.max(1, Math.floor(maxPx / (size * 0.56)) - 1);
  return `${s.slice(0, n)}...`;
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1, step: 1 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { max: Math.ceil(v / step) * step, step };
}

function fmtTick(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1);
}

/** Legend rows across the top; returns svg + the height used. */
function legend(items: { label: string; color: string }[], y: number): { svg: string; h: number } {
  let x = 0;
  let row = 0;
  const parts: string[] = [];
  for (const it of items) {
    const label = truncate(it.label, 150);
    const w = 18 + textWidth(label) + 16;
    if (x + w > CHART_W && x > 0) {
      x = 0;
      row += 1;
    }
    const yy = y + row * 18;
    parts.push(`<rect x="${x}" y="${yy - 9}" width="10" height="10" rx="2" fill="${it.color}"/>`);
    parts.push(text(x + 15, yy, label, { fill: INK }));
    x += w;
  }
  return { svg: parts.join(""), h: (row + 1) * 18 + 6 };
}

export function chartSvg(d: ChartData): { svg: string; width: number; height: number } {
  if (d.type === "pie") return pieSvg(d);
  return cartesianSvg(d);
}

function cartesianSvg(d: ChartData): { svg: string; width: number; height: number } {
  const multi = d.series.length > 1;
  const stacked = d.type === "bar" && multi && d.agg !== "avg";
  const parts: string[] = [];
  let top = 6;
  if (multi) {
    const lg = legend(
      d.series.map((s, i) => ({ label: s.label, color: seriesColor(s.key, i) })),
      top + 10
    );
    parts.push(lg.svg);
    top += lg.h;
  }
  const plotH = 200;
  const height = top + plotH + 44;

  // y scale
  let maxV = 0;
  for (let i = 0; i < d.x.length; i++) {
    if (stacked) maxV = Math.max(maxV, d.series.reduce((t, s) => t + (s.values[i] ?? 0), 0));
    else for (const s of d.series) maxV = Math.max(maxV, s.values[i] ?? 0);
  }
  const { max, step } = niceMax(maxV);
  const tickLabels: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) tickLabels.push(v);
  const left = Math.max(...tickLabels.map((v) => textWidth(fmtTick(v)))) + 10;
  const right = 8;
  const plotW = CHART_W - left - right;
  const y0 = top + plotH;
  const yOf = (v: number) => y0 - (v / max) * plotH;

  for (const v of tickLabels) {
    const y = yOf(v);
    parts.push(`<line x1="${left}" x2="${CHART_W - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${v === 0 ? INK_2 : GRID}" stroke-width="1"/>`);
    parts.push(text(left - 6, y + 4, fmtTick(v), { anchor: "end" }));
  }

  // x labels: skip to avoid collisions
  const band = plotW / Math.max(1, d.x.length);
  const widest = Math.max(...d.x.map((b) => textWidth(b.label)), 1);
  const every = Math.max(1, Math.ceil((widest + 8) / band));
  d.x.forEach((b, i) => {
    if (i % every !== 0) return;
    const cx = left + band * (i + 0.5);
    parts.push(text(cx, y0 + 16, truncate(b.label, band * every - 4), { anchor: "middle" }));
  });
  parts.push(text(left, height - 6, d.xLabel, { size: 10 }));

  if (d.type === "bar") {
    const groupW = Math.min(band * 0.7, 56);
    if (stacked || !multi) {
      for (let i = 0; i < d.x.length; i++) {
        const x = left + band * (i + 0.5) - groupW / 2;
        let acc = 0;
        const segs = d.series
          .map((s, si) => ({ v: s.values[i] ?? 0, color: seriesColor(s.key, si) }))
          .filter((s) => s.v > 0);
        segs.forEach((s, si) => {
          const yTop = yOf(acc + s.v);
          const yBot = yOf(acc);
          acc += s.v;
          const gap = si > 0 ? 2 : 0; // 2px surface gap between stacked fills
          const h = Math.max(0, yBot - yTop - gap);
          parts.push(barPath(x, yTop, groupW, h, si === segs.length - 1, s.color));
        });
      }
    } else {
      const n = d.series.length;
      const bw = Math.max(2, (groupW - (n - 1) * 2) / n);
      for (let i = 0; i < d.x.length; i++) {
        const gx = left + band * (i + 0.5) - (bw * n + (n - 1) * 2) / 2;
        d.series.forEach((s, si) => {
          const v = s.values[i];
          if (v == null || v <= 0) return;
          parts.push(barPath(gx + si * (bw + 2), yOf(v), bw, y0 - yOf(v), true, seriesColor(s.key, si)));
        });
      }
    }
  } else {
    d.series.forEach((s, si) => {
      const color = seriesColor(s.key, si);
      // A null (average over nothing) breaks the line rather than diving to zero.
      let path = "";
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) {
          pen = false;
          return;
        }
        const x = left + band * (i + 0.5);
        path += `${pen ? "L" : "M"}${x.toFixed(1)},${yOf(v).toFixed(1)}`;
        pen = true;
      });
      if (path) parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (d.x.length <= 31) {
        s.values.forEach((v, i) => {
          if (v == null) return;
          const x = left + band * (i + 0.5);
          parts.push(`<circle cx="${x.toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`);
        });
      }
    });
  }

  return wrap(parts.join(""), CHART_W, height);
}

/** A bar with 4px rounded data-end (top) and a square base on the axis. */
function barPath(x: number, y: number, w: number, h: number, roundTop: boolean, fill: string): string {
  if (h <= 0) return "";
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  const d = `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `<path d="${d}" fill="${fill}"/>`;
}

function pieSvg(d: ChartData): { svg: string; width: number; height: number } {
  const values = d.series[0]?.values.map((v) => v ?? 0) ?? [];
  const total = values.reduce((t, v) => t + v, 0);
  const height = 240;
  const cx = 120;
  const cy = height / 2;
  const r = 100;
  const parts: string[] = [];
  if (total <= 0) {
    parts.push(text(CHART_W / 2, cy, "No data", { anchor: "middle" }));
    return wrap(parts.join(""), CHART_W, height);
  }
  let a = -Math.PI / 2;
  values.forEach((v, i) => {
    const color = seriesColor(d.x[i]!.key, i);
    if (v >= total) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
      return;
    }
    const a2 = a + (v / total) * Math.PI * 2;
    const large = a2 - a > Math.PI ? 1 : 0;
    const p1 = `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    const p2 = `${(cx + r * Math.cos(a2)).toFixed(2)},${(cy + r * Math.sin(a2)).toFixed(2)}`;
    // 2px surface stroke = the gap between slices.
    parts.push(`<path d="M${cx},${cy}L${p1}A${r},${r} 0 ${large} 1 ${p2}Z" fill="${color}" stroke="${SURFACE}" stroke-width="2" stroke-linejoin="round"/>`);
    a = a2;
  });
  // Legend with value + share; the pie itself carries no numbers.
  const lx = cx + r + 40;
  const rowH = 22;
  const ly = cy - ((values.length - 1) * rowH) / 2;
  values.forEach((v, i) => {
    const y = ly + i * rowH;
    const color = seriesColor(d.x[i]!.key, i);
    const pct = Math.round((v / total) * 100);
    parts.push(`<rect x="${lx}" y="${y - 9}" width="10" height="10" rx="2" fill="${color}"/>`);
    parts.push(text(lx + 16, y, truncate(d.x[i]!.label, 200), { fill: INK, size: 12 }));
    parts.push(text(CHART_W - 8, y, `${fmtTick(Math.round(v * 10) / 10)}  (${pct}%)`, { anchor: "end", size: 12 }));
  });
  return wrap(parts.join(""), CHART_W, height);
}

function wrap(body: string, width: number, height: number): { svg: string; width: number; height: number } {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${SURFACE}"/>${body}</svg>`,
    width,
    height
  };
}
