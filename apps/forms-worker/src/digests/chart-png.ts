// SVG -> PNG for digest emails, inside the worker (resvg compiled to wasm).
// Nothing leaves Cloudflare: no third-party chart service ever sees form data.
//
// The font is vendored (fonts/noto-sans-regular.ttf, SIL OFL, the Latin
// subset Next's OG renderer ships) because a worker has no system fonts and
// resvg draws no text without one. Rendered at 2x so it stays sharp on phones
// and high-DPI screens; the email displays it at 1x width.

import { initWasm, Resvg } from "@resvg/resvg-wasm";
// wrangler: *.wasm is a CompiledWasm module by default; *.ttf is Data (wrangler.toml [[rules]]).
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import notoSans from "../../fonts/noto-sans-regular.ttf";
import { FONT_FAMILY } from "./chart-svg.js";

let ready: Promise<void> | null = null;

function init(): Promise<void> {
  // initWasm throws if called twice in one isolate; one shared promise.
  ready ??= initWasm(resvgWasm as unknown as WebAssembly.Module).catch((err) => {
    ready = null; // let a later call retry
    throw err;
  });
  return ready;
}

export async function svgToPng(svg: string, width: number): Promise<Uint8Array> {
  await init();
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width * 2 },
    font: {
      fontBuffers: [new Uint8Array(notoSans)],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY
    }
  });
  const png = r.render().asPng();
  r.free();
  return png;
}
