// Single source of truth for Splash brand assets served from public R2.
// Currently hardcoded in every worker file as
// https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/...
// Centralizing here so a logo change is a one-file edit.

const PUBLIC_R2_BASE = "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev";

export const ASSETS = {
  logoWhite: `${PUBLIC_R2_BASE}/SplashScriptWhite_RedCar.png`,
  logoBlue: `${PUBLIC_R2_BASE}/Splash_logo_full%20(1)%201.png`,
  favicon: `${PUBLIC_R2_BASE}/favicon-32x32.png`
} as const;

export type AssetKey = keyof typeof ASSETS;
