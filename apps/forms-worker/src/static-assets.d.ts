// Brief 92 — text imports for vendored static assets.
//
// `[[rules]] type = "Text"` in wrangler.toml turns each .js file under
// `static/` into a default-exported string at bundle time. TypeScript
// doesn't know about that rule on its own, so without this shim every
// import fails with "Cannot find module './static/foo.js'".
//
// Worker bundle only — apps/web ships its own asset pipeline.

declare module "*/static/signature-pad.min.js" {
  const contents: string;
  export default contents;
}

declare module "*/static/forms-public.js" {
  const contents: string;
  export default contents;
}

// NY pay notice templates -- `[[rules]] type = "Data"` imports each PDF under
// templates/ as an ArrayBuffer.
declare module "*/templates/ny-ls54.pdf" {
  const contents: ArrayBuffer;
  export default contents;
}

declare module "*/templates/ny-ls59.pdf" {
  const contents: ArrayBuffer;
  export default contents;
}

// Digest chart font (fonts/*.ttf, `[[rules]] type = "Data"`) and the resvg
// wasm module (wrangler bundles *.wasm as a CompiledWasm module by default).
declare module "*/fonts/noto-sans-regular.ttf" {
  const contents: ArrayBuffer;
  export default contents;
}

declare module "@resvg/resvg-wasm/index_bg.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
