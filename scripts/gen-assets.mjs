/* Generate iOS/Android source art for @capacitor/assets into ./assets.
 *
 * Produces the official brand mark — the "spark" star (4-point sparkle + 3
 * gold trail dots) on an indigo gradient — matching the in-app brandMark()
 * shape in index.html so the launcher icon and the in-app logo are the same.
 *
 * Pure vector shapes only (no fonts) so it rasterizes identically everywhere.
 * Run:  node scripts/gen-assets.mjs   (sharp ships with @capacitor/assets)
 */
import sharp from "sharp";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");
mkdirSync(OUT, { recursive: true });

const INDIGO = "#4f6bf0", INDIGO_D = "#3a52d6", GOLD = "#ffd43b", WHITE = "#ffffff";
const GRAD = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${INDIGO}"/><stop offset="1" stop-color="${INDIGO_D}"/></linearGradient>`;

/* The brand "spark": a 4-point sparkle with a 3-dot gold trail leading into it
   from the lower-left. SAME path as the in-app brandMark() (index.html ~ line
   886) so launcher icon ↔ in-app logo stay identical. Coordinates are in a
   60×60 viewBox; outer SVG resizes that to whatever target we need. */
function sparkMark(starColor, trailColor) {
  return (
    `<circle cx="9" cy="52" r="1.7" fill="${trailColor}"/>` +
    `<circle cx="14" cy="47" r="2.4" fill="${trailColor}"/>` +
    `<circle cx="21" cy="40" r="3.4" fill="${trailColor}"/>` +
    `<path d="M36 8 C 38 22, 41 25, 54 27 C 41 29, 38 32, 36 46 C 34 32, 31 29, 18 27 C 31 25, 34 22, 36 8 Z" fill="${starColor}"/>`
  );
}

// App icon: full-bleed indigo gradient, white spark, gold trail.
// withBg=false drops the background (Android adaptive foreground layer).
const iconSVG = (withBg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 60 60"><defs>${GRAD}</defs>` +
  (withBg ? `<rect width="60" height="60" fill="url(#g)"/>` : "") +
  sparkMark(WHITE, GOLD) +
  `</svg>`;

// Android adaptive background layer: solid gradient.
const bgSVG = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${GRAD}</defs><rect width="1024" height="1024" fill="url(#g)"/></svg>`;

// Launch splash: a rounded indigo card with the spark inside, centered on the
// surface color. Card occupies ~28% of width, matching iOS app-icon proportions.
const splashSVG = (bg) => {
  const CANVAS = 2732, TARGET = 760, SCALE = TARGET / 60;
  const TX = (CANVAS - TARGET) / 2, TY = (CANVAS - TARGET) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}"><defs>${GRAD}</defs>` +
    `<rect width="${CANVAS}" height="${CANVAS}" fill="${bg}"/>` +
    `<g transform="translate(${TX},${TY}) scale(${SCALE})">` +
    `<rect width="60" height="60" rx="13.5" fill="url(#g)"/>` +
    sparkMark(WHITE, GOLD) +
    `</g></svg>`
  );
};

async function png(svg, file, size) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(OUT, file));
  console.log("wrote assets/" + file + "  (" + size + "x" + size + ")");
}

await png(iconSVG(true),  "icon-only.png",       1024);  // iOS AppIcon + 1024 marketing icon source (opaque, no alpha)
await png(iconSVG(false), "icon-foreground.png", 1024);  // Android adaptive foreground
await png(bgSVG(),         "icon-background.png", 1024); // Android adaptive background
await png(splashSVG("#eef1ff"), "splash.png",       2732); // light launch screen
await png(splashSVG("#0e1220"), "splash-dark.png",  2732); // dark launch screen
console.log("done — Codemagic will run `npx @capacitor/assets generate --ios` automatically on next build.");
