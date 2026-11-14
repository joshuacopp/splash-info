// One recipient's digest email: charts as inline PNGs (cid:), then the table,
// inside the shared Splash shell. Everything is inline-styled tables, the only
// layout Outlook renders reliably.

import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";
import type { ChartData, TableData } from "./aggregate.js";
import { chartSvg } from "./chart-svg.js";
import { svgToPng } from "./chart-png.js";
import { renderTableHtml, renderTableText } from "./table-html.js";

const NAVY = "#0b2a4a";
const INK_2 = "#52514e";

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
  images: { contentId: string; filename: string; png: Uint8Array }[];
}

export interface DigestEmailInput {
  formTitle: string;
  digestName: string;
  periodLabel: string;
  /** "all sites" or "Binghamton, Vestal" / "12 sites". */
  scopeLabel: string;
  total: number;
  charts: ChartData[];
  table: TableData | null;
  capped: boolean;
  submissionsUrl: string;
}

export async function renderDigestEmail(input: DigestEmailInput): Promise<RenderedDigest> {
  const images: RenderedDigest["images"] = [];
  const blocks: string[] = [];
  const text: string[] = [];

  const headline = `${input.formTitle}: ${input.digestName}`;
  blocks.push(`<h2 style="margin:0 0 4px 0;font-size:20px;color:${NAVY};">${escapeHtml(headline)}</h2>`);
  const sub = `${input.periodLabel} &middot; ${escapeHtml(input.scopeLabel)} &middot; ${input.total.toLocaleString("en-US")} submission${input.total === 1 ? "" : "s"}`;
  blocks.push(`<p style="margin:0 0 18px 0;font-size:14px;color:${INK_2};">${sub}</p>`);
  text.push(headline, `${input.periodLabel} - ${input.scopeLabel} - ${input.total} submissions`, "");

  if (input.capped) {
    const warn = "This period had more submissions than a digest can include; the numbers below are incomplete. Use the submissions export for the full set.";
    blocks.push(`<p style="margin:0 0 16px 0;padding:10px 12px;background:#fff7e6;border-left:4px solid #eda100;font-size:13px;">${escapeHtml(warn)}</p>`);
    text.push(warn, "");
  }

  // Nothing to show: say so, rather than a blank chart and a header-only table.
  const empty = input.total === 0;
  if (empty) {
    blocks.push(`<p style="margin:0 0 8px 0;padding:14px 16px;background:#f6f6f4;font-size:14px;color:${INK_2};">No submissions in this period.</p>`);
    text.push("No submissions in this period.", "");
  }

  for (let i = 0; !empty && i < input.charts.length; i++) {
    const c = input.charts[i]!;
    const { svg, width, height } = chartSvg(c);
    try {
      const png = await svgToPng(svg, width);
      const cid = `digest-chart-${i + 1}`;
      images.push({ contentId: cid, filename: `chart-${i + 1}.png`, png });
      blocks.push(`<h3 style="margin:18px 0 6px 0;font-size:15px;color:${NAVY};">${escapeHtml(c.title)}</h3>`);
      blocks.push(
        `<img src="cid:${cid}" width="${width}" height="${height}" alt="${escapeHtml(`Chart: ${c.title}. The numbers are in the table below.`)}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;" />`
      );
    } catch (err) {
      // A chart that fails to draw must not stop the digest: the table carries the numbers.
      console.error("[forms.digest] chart render failed", err);
      blocks.push(`<p style="font-size:13px;color:${INK_2};">(The chart "${escapeHtml(c.title)}" could not be drawn. The numbers are in the table.)</p>`);
    }
  }

  if (input.table && !empty) {
    blocks.push(renderTableHtml(input.table));
    text.push(...renderTableText(input.table), "");
  }

  blocks.push(
    `<p style="margin:22px 0 0 0;font-size:13px;"><a href="${escapeHtml(input.submissionsUrl)}" style="color:#2a78d6;">View the submissions</a></p>`
  );
  text.push(`View the submissions: ${input.submissionsUrl}`);

  const subject = `${input.formTitle}: ${input.digestName} (${input.periodLabel})`;
  return {
    subject,
    html: wrapInEmailShell(blocks.join("\n"), { title: subject, preheader: `${input.total} submissions, ${input.periodLabel}` }),
    text: text.join("\n"),
    images
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
