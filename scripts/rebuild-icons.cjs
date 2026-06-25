#!/usr/bin/env node
/* Regenerate PWA icons from the brand source assets/icon-only.png.
   Writes to icons/ AND dist/icons/ so both the source tree and the deploy
   bundle stay in sync. Maskable icon adds the safe-zone padding Android
   uses to clip adaptive icons. */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'assets', 'icon-only.png');
const OUT_DIRS = [
  path.join(ROOT, 'icons'),
  path.join(ROOT, 'dist', 'icons'),
];

const BG = { r: 79, g: 107, b: 240, alpha: 1 };

async function emit(name, size, opts = {}) {
  const img = sharp(SRC).resize(size, size, { fit: 'cover' });
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
    buf = await img.png().toBuffer();
  }
  for (const dir of OUT_DIRS) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    console.log('wrote', path.join(path.relative(ROOT, dir), name));
  }
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('missing source:', SRC); process.exit(1);
  }
  await emit('icon-192.png', 192);
  await emit('icon-512.png', 512);
  await emit('icon-maskable-512.png', 512, { padForMask: true });
  await emit('apple-touch-icon.png', 180);
  console.log('icons regenerated from', path.relative(ROOT, SRC));
})().catch(e => { console.error(e); process.exit(1); });
