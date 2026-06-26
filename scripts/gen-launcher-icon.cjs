#!/usr/bin/env node
/* Generate a fresh launcher icon (home-screen / app store) that is DISTINCT
 * from the in-app brand mark (the white "spark" star with gold trail used by
 * brandMark()). The launcher icon is what users see on their home screen and
 * needs to be its own recognizable shape — not the same star.
 *
 * Design: indigo gradient + a bold white speech bubble holding 4 rounded
 * "fluency wave" bars, with the second bar in gold. Speaks to: conversation
 * (bubble), speaking practice (waves), the brand's gold accent (spark of
 * fluency). Pure SVG paths — no fonts needed, rasterizes identically.
 *
 * Writes:
 *   - assets/icon-only.png (1024 square, opaque — iOS marketing source)
 *   - assets/icon-foreground.png (1024 transparent — Android adaptive)
 *   - assets/icon-background.png (1024 indigo — Android adaptive)
 *   - icons/icon-192.png, icon-512.png, icon-maskable-512.png,
 *     apple-touch-icon.png  (PWA icon set)
 *   - dist/icons/* mirrors of the above
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ICONS = [path.join(ROOT, 'icons'), path.join(ROOT, 'dist', 'icons')];

const INDIGO = '#4f6bf0';
const INDIGO_D = '#3a52d6';
const GOLD = '#ffd43b';
const WHITE = '#ffffff';

const GRAD = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${INDIGO}"/><stop offset="1" stop-color="${INDIGO_D}"/></linearGradient></defs>`;

/* In a 1024 viewBox, lay out a chat bubble (rounded rect + tail) plus 4
 * sound-wave bars centered inside it. The bubble is shifted up a bit so the
 * tail tucks under without crowding the safe-area for maskable icons. */
function bubble(fill) {
  // Rounded rect bubble — keeps a comfortable margin from the edges.
  // x=192, y=232, w=640, h=448, rx=120 => bubble centered horizontally
  return `<rect x="192" y="232" width="640" height="448" rx="120" fill="${fill}"/>`
       + `<path d="M380 656 L380 800 L500 668 Z" fill="${fill}"/>`;
}

function bars(barColor, accentColor) {
  // Four bars centered horizontally inside the bubble (cx=512), each rounded.
  // bar width = 60, gap = 40 => total width 4*60 + 3*40 = 360 => start x = 332
  const xs = [332, 432, 532, 632];
  const hs = [150, 250, 200, 130];
  const cy = 456;
  const w = 60;
  const rx = 30;
  return xs.map((x, i) => {
    const hi = hs[i];
    const y = cy - hi / 2;
    const fill = i === 1 ? accentColor : barColor;
    return `<rect x="${x}" y="${y}" width="${w}" height="${hi}" rx="${rx}" fill="${fill}"/>`;
  }).join('');
}

function iconSVG(withBg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${GRAD}`
       + (withBg ? `<rect width="1024" height="1024" fill="url(#g)"/>` : '')
       + bubble(WHITE)
       + bars(INDIGO, GOLD)
       + `</svg>`;
}

function bgSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${GRAD}`
       + `<rect width="1024" height="1024" fill="url(#g)"/>`
       + `</svg>`;
}

async function png(svg, file, size) {
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}

(async () => {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

  // 1) Source art into assets/
  const iconBuf = await png(iconSVG(true), 'icon-only.png', 1024);
  fs.writeFileSync(path.join(ASSETS, 'icon-only.png'), iconBuf);
  console.log('wrote assets/icon-only.png (1024x1024)');

  const fgBuf = await png(iconSVG(false), 'icon-foreground.png', 1024);
  fs.writeFileSync(path.join(ASSETS, 'icon-foreground.png'), fgBuf);
  console.log('wrote assets/icon-foreground.png (1024x1024)');

  const bgBuf = await png(bgSVG(), 'icon-background.png', 1024);
  fs.writeFileSync(path.join(ASSETS, 'icon-background.png'), bgBuf);
  console.log('wrote assets/icon-background.png (1024x1024)');

  // 2) PWA icons from the assets source, mirroring rebuild-icons.cjs.
  const SRC = path.join(ASSETS, 'icon-only.png');
  const BG = { r: 79, g: 107, b: 240, alpha: 1 };

  async function emit(name, size, opts) {
    opts = opts || {};
    let buf;
    if (opts.padForMask) {
      const inner = Math.round(size * 0.78);
      const inset = Math.round((size - inner) / 2);
      const innerBuf = await sharp(SRC).resize(inner, inner, { fit: 'cover' }).png().toBuffer();
      buf = await sharp({
        create: { width: size, height: size, channels: 4, background: BG }
      })
        .composite([{ input: innerBuf, top: inset, left: inset }])
        .png()
        .toBuffer();
    } else {
      buf = await sharp(SRC).resize(size, size, { fit: 'cover' }).png().toBuffer();
    }
    for (const dir of ICONS) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      console.log('wrote', path.relative(ROOT, path.join(dir, name)));
    }
  }

  await emit('icon-192.png', 192);
  await emit('icon-512.png', 512);
  await emit('icon-maskable-512.png', 512, { padForMask: true });
  await emit('apple-touch-icon.png', 180);
  console.log('done — launcher icon refreshed (bubble + waves).');
})().catch(e => { console.error(e); process.exit(1); });
