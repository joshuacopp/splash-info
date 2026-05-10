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
