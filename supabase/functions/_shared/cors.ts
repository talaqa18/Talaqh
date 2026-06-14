// Shared CORS for Edge Functions called from the PWA / Capacitor shell.
// ----------------------------------------------------------------------------
// We allow an explicit ALLOWLIST of origins instead of "*" so that, even though
// every function is verify_jwt=true, the browser preflight only succeeds for our
// own shells. The reply echoes the request Origin when it is on the list.
//
// Allowed:
//   - the deployed PWA origin (set APP_ORIGIN as a function secret)
//   - capacitor://localhost   (iOS Capacitor webview)
//   - https://localhost       (Android Capacitor webview)
//   - http(s)://localhost:*   (Vite dev server) — dev convenience only
//
// TODO(prod): set APP_ORIGIN to the real production origin, e.g.
//   supabase secrets set APP_ORIGIN=https://app.yourdomain.com
// and drop the localhost dev entries below before going live.

// Always-allowed native shells + the production custom domain.
const STATIC_ALLOWED: ReadonlyArray<string> = [
  "capacitor://localhost", // iOS Capacitor
  "https://localhost", // Android Capacitor
  "https://talaqh.com", // production PWA (custom domain)
  "https://www.talaqh.com", // production PWA (www)
];

// Dev origins (Vite / localhost) are allowed ONLY when ALLOW_DEV_ORIGINS=1 — so
// production (which sets APP_ORIGIN and leaves this unset) never trusts localhost.
const DEV_ALLOWED: ReadonlyArray<string> = [
  "http://localhost",
  "https://localhost:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function allowedOrigins(): Set<string> {
  const set = new Set<string>(STATIC_ALLOWED);
  if (Deno.env.get("ALLOW_DEV_ORIGINS") === "1") {
    for (const o of DEV_ALLOWED) set.add(o);
  }
  // APP_ORIGIN may be a comma-separated list of deployed origins.
  const appOrigin = Deno.env.get("APP_ORIGIN");
  if (appOrigin) {
    for (const o of appOrigin.split(",")) {
      const trimmed = o.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}

const BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

/**
 * Build CORS headers for a given request. If the request Origin is on the
 * allowlist we echo it; otherwise we omit Allow-Origin (the browser then blocks
 * the response). Server-to-server callers (no Origin header) are unaffected.
 */
// Any *.netlify.app site is trusted (the app may be deployed under different
// Netlify site names). Calls are still gated by verify_jwt + per-user quotas.
const NETLIFY_RE = /^https:\/\/[a-z0-9-]+(--[a-z0-9-]+)?\.netlify\.app$/i;

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (origin && (allowedOrigins().has(origin) || NETLIFY_RE.test(origin))) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Backwards-compatible static export. Prefer corsHeadersFor(req) so the allowed
 * origin is echoed per request. This static object intentionally omits
 * Allow-Origin (set it per request).
 */
export const corsHeaders: Record<string, string> = { ...BASE_HEADERS };
