/* Refresh dist/ from the root static files — the byte-for-byte set Netlify publishes.
 *
 * WHY THIS EXISTS: this app has NO build step. `npm run build` (tsc + vite) would
 * MANGLE the single inline-script index.html and ship a broken app. So dist/ is a
 * plain COPY of the root web assets. Capacitor bundles whatever is in dist/ (webDir),
 * so we must refresh it before every `npx cap copy ios` / `npx cap sync ios`.
 *
 * Run:  npm run dist:copy   (chained automatically by ios:copy / ios:sync / ios:add)
 */
import { rmSync, mkdirSync, cpSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const FILES = ["index.html", "supabase-bridge.js", "sw.js", "app-config.js", "manifest.webmanifest", "_headers", "privacy.html", "terms.html"];
const DIRS = ["icons", "content", "vendor"];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

let n = 0;
for (const f of FILES) {
  const s = join(ROOT, f);
  if (existsSync(s)) { cpSync(s, join(DIST, f)); n++; } else console.warn("  skip (missing file):", f);
}
for (const d of DIRS) {
  const s = join(ROOT, d);
  if (existsSync(s)) { cpSync(s, join(DIST, d), { recursive: true }); n++; } else console.warn("  skip (missing dir):", d);
}
console.log(`dist/ refreshed — ${n} items copied from root. Ready for: npx cap copy ios`);
