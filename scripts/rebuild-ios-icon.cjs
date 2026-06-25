#!/usr/bin/env node
/* Rebuild the iOS-source icon set in assets/ from the star icon
   (icons/icon-512.png). @capacitor/assets reads from assets/icon-only.png
   to generate the entire iOS AppIcon.appiconset on the Codemagic build.
   Apple expects a 1024x1024 SQUARE PNG with no transparency in the corners
   (iOS applies its own rounded-rect mask), so we flatten onto the brand
   gradient background. */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'icons', 'icon-512.png');
const ASSETS = path.join(ROOT, 'assets');

const BG = { r: 79, g: 107, b: 240, alpha: 1 }; // brand blue (matches --p / theme_color)

async function main() {
  if (!fs.existsSync(SRC)) { console.error('missing', SRC); process.exit(1); }

  const inner = await sharp(SRC).resize(1024, 1024, { fit: 'cover' }).png().toBuffer();

  // icon-only.png: full-bleed square 1024x1024 with brand bg behind any
  // transparent corners. This is the file @capacitor/assets reads.
  const iconOnly = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: BG }
  }).composite([{ input: inner }]).png().toBuffer();
  fs.writeFileSync(path.join(ASSETS, 'icon-only.png'), iconOnly);
  console.log('wrote assets/icon-only.png');

  // Adaptive Android: foreground = star + dots only on transparent,
  // background = brand fill. We rebuild both from the star.
  const foreground = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
  }).composite([{ input: inner }]).png().toBuffer();
  fs.writeFileSync(path.join(ASSETS, 'icon-foreground.png'), foreground);
  console.log('wrote assets/icon-foreground.png');

  const background = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: BG }
  }).png().toBuffer();
  fs.writeFileSync(path.join(ASSETS, 'icon-background.png'), background);
  console.log('wrote assets/icon-background.png');
}
main().catch(e => { console.error(e); process.exit(1); });
