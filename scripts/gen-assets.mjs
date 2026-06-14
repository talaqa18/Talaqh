/* Generate iOS/Android source art for @capacitor/assets into ./assets.
 *
 * This produces a clean, on-brand PLACEHOLDER mark (indigo→indigo gradient + a
 * white speech bubble with a gold-accented "fluency" sound-wave) so the icon/splash
 * pipeline works end-to-end on Windows with no Mac. Swap these out with final brand
 * art any time and re-run:  npm run ios:assets
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

// Four rounded "sound-wave" bars centered ~(512,456) in 1024 space; bar #2 is the gold accent.
function bars(barColor, accentColor) {
  const xs = [332, 432, 532, 632], hs = [150, 250, 200, 120], cy = 456, w = 60, rx = 30;
  return xs.map((x, i) => {
    const h = hs[i], y = cy - h / 2, fill = i === 1 ? accentColor : barColor;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
  }).join("");
}
// Speech bubble (rounded rect + tail) in 1024 space.
function bubble(fill) {
  return `<rect x="212" y="236" width="600" height="440" rx="104" fill="${fill}"/>` +
         `<path d="M360 632 L360 772 L478 648 Z" fill="${fill}"/>`;
}

// App icon: full-bleed indigo gradient, white bubble, indigo bars + gold accent.
const iconSVG = (withBg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${GRAD}</defs>` +
  (withBg ? `<rect width="1024" height="1024" fill="url(#g)"/>` : "") +
  bubble(WHITE) + bars(INDIGO, GOLD) + `</svg>`;

// Android adaptive background layer: solid gradient.
const bgSVG = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${GRAD}</defs><rect width="1024" height="1024" fill="url(#g)"/></svg>`;

// Launch splash: bubble in the brand gradient with white bars + gold, centered on the surface color.
const splashSVG = (bg) => {
  const f = 1.7, cx = 512, cy = 504, tx = 1366 - cx * f, ty = 1366 - cy * f;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732"><defs>${GRAD}</defs>` +
    `<rect width="2732" height="2732" fill="${bg}"/>` +
    `<g transform="translate(${tx},${ty}) scale(${f})">${bubble("url(#g)")}${bars(WHITE, GOLD)}</g></svg>`;
};

async function png(svg, file, size) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(OUT, file));
  console.log("wrote assets/" + file + "  (" + size + "x" + size + ")");
}

await png(iconSVG(true), "icon-only.png", 1024);       // iOS AppIcon + 1024 marketing icon source (opaque, no alpha)
await png(iconSVG(false), "icon-foreground.png", 1024); // Android adaptive foreground
await png(bgSVG(), "icon-background.png", 1024);         // Android adaptive background
await png(splashSVG("#eef1ff"), "splash.png", 2732);    // light launch screen
await png(splashSVG("#0e1220"), "splash-dark.png", 2732); // dark launch screen
console.log("done — now run:  npx @capacitor/assets generate --ios   (after `npx cap add ios`)");
