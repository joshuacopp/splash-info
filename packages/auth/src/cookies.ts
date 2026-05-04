// Cookie helpers for the Supabase auth session.
//
// Cookie names match what every legacy worker uses (see dashboard.js,
// signupworker.js, performancetracker.js — all read these names). Path=/
// so the cookies are visible across /, /admin/*, /sysadmin/*, /pertrack/*,
// /manage/* — that's the whole SSO design.

export const ACCESS_TOKEN_COOKIE = "sb-access-token";
export const REFRESH_TOKEN_COOKIE = "sb-refresh-token";

const DEFAULT_ACCESS_MAX_AGE = 60 * 60; // 1 hour — matches dashboard.js + signupworker.js
const DEFAULT_REFRESH_MAX_AGE = 60 * 60 * 24 * 7; // 7 days — matches the same

export interface AuthCookieOptions {
  /** Default 3600 (1 hour). Pass 28800 to match performancetracker.js. */
  accessTokenMaxAge?: number;
  /** Default 604800 (7 days). Pass 0 to skip the refresh cookie entirely
   *  (legacy/performancetracker.js does not set a refresh token). */
  refreshTokenMaxAge?: number | null;
}

/**
 * Build the two `Set-Cookie` header values for a fresh login.
 *
 * Returns an array so the caller can `headers.append("Set-Cookie", c)` for
 * each — Workers' Headers class supports multiple Set-Cookie headers via
 * append(). Joining into one string with commas (as legacy does) works but
 * is less robust because cookie attribute commas (e.g., expires=) confuse
 * proxies that re-parse.
 */
export function buildAuthCookies(
  accessToken: string,
  refreshToken: string | null,
  opts: AuthCookieOptions = {}
): string[] {
  const cookies: string[] = [];
  const accessMax = opts.accessTokenMaxAge ?? DEFAULT_ACCESS_MAX_AGE;
  cookies.push(
    `${ACCESS_TOKEN_COOKIE}=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${accessMax}`
  );
  const refreshMax = opts.refreshTokenMaxAge ?? DEFAULT_REFRESH_MAX_AGE;
  if (refreshMax !== null && refreshMax > 0 && refreshToken) {
    cookies.push(
      `${REFRESH_TOKEN_COOKIE}=${refreshToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${refreshMax}`
    );
  }
  return cookies;
}

/**
 * Build the two `Set-Cookie` header values that clear the session.
 * Source: legacy/dashboard.js:99, legacy/signupworker.js:104.
 */
export function buildLogoutCookies(): string[] {
  return [
    `${ACCESS_TOKEN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${REFRESH_TOKEN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  ];
}

/**
 * Parse a Cookie header into a name→value map. Decodes URI-encoded values
 * to match legacy/performancetracker.js:171. Returns {} for null / empty
 * input.
 */
export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Read a single cookie from the request. Returns null when absent.
 */
export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  const cookies = parseCookies(header);
  return cookies[name] ?? null;
}

/**
 * Read the access token from the standard cookie. Convenience wrapper.
 */
export function getAccessToken(request: Request): string | null {
  return getCookie(request, ACCESS_TOKEN_COOKIE);
}
