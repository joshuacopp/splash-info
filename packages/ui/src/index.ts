// Public surface of @splash/ui — shared React components for apps/web.
//
// Step 5 ports a subset:
//   - Layout primitives (PageShell, BrandHeader, BrandFontLinks)
//   - PhoneInput with auto-format `(XXX)XXX-XXXX`
//   - The four signup-flow modals (Deny/Warn/Monitor/Success)
//   - BubbleBackground for the public claim form / landing page
//   - StatusBadge for the damage-claim manager UI
//   - PricingCard for the package picker
//   - Color tokens (TS mirror of tailwind.base.cjs)
//
// Step 7 will add the larger composites — full signup form, pricing admin
// grid, photo uploader, manage UI — when their pages land in apps/web.
//
// Re-exports are extensionless: tsc with moduleResolution: "Bundler" accepts
// both extensionless and ".js" forms, but Next.js's webpack pipeline (via
// transpilePackages) does NOT resolve ".js" → ".tsx" for these files. The
// extensionless form keeps both compilers happy.

export * from "./tokens";
export * from "./BrandFontLinks";
export * from "./PageShell";
export * from "./BrandHeader";
export * from "./PhoneInput";
export * from "./BubbleBackground";
export * from "./StatusBadge";
export * from "./PricingCard";

// Modals
export * from "./modals/ModalShell";
export * from "./modals/DenyModal";
export * from "./modals/WarnModal";
export * from "./modals/MonitorModal";
export * from "./modals/SuccessModal";
