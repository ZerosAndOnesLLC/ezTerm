// Build-time image generation for ezTerm site assets.
// Idempotent: re-running overwrites with the same output for the same source.
//
// Inputs:  src/assets/ezterm.png (the 1254×1254 splash logo)
// Outputs:
//   - src/assets/ezterm-icon.png   (256×256, Starlight nav)
//   - public/ezterm-icon.png       (96×96, marketing-page nav — light enough for hi-DPI render at 34×34)
//   - public/og.png                (1200×630, social-share card)
//
// Re-run with: node scripts/make-icon.mjs
import sharp from 'sharp';

const SRC = 'src/assets/ezterm.png';

// Terminal-panel-only icon (drops the wordmark text at the bottom of the splash).
const CROP = { left: 310, top: 150, width: 620, height: 620 };

// Starlight nav (uses the icon at its native 256 size; Starlight downsizes for the nav).
await sharp(SRC)
  .extract(CROP)
  .resize(256, 256)
  .toFile('src/assets/ezterm-icon.png');
console.log('wrote src/assets/ezterm-icon.png (256×256)');

// Custom-page nav — smaller so the homepage doesn't ship 256KB for a 34×34 thumbnail.
await sharp(SRC)
  .extract(CROP)
  .resize(96, 96)
  .png({ compressionLevel: 9, quality: 90 })
  .toFile('public/ezterm-icon.png');
console.log('wrote public/ezterm-icon.png (96×96)');

// OG / social-share card: splash centered on a dark canvas.
const splashSize = 500;
const splash = await sharp(SRC).resize(splashSize, splashSize).toBuffer();
await sharp({
  create: {
    width: 1200,
    height: 630,
    channels: 4,
    background: { r: 5, g: 7, b: 8, alpha: 1 },
  },
})
  .composite([{ input: splash, gravity: 'center' }])
  .png({ compressionLevel: 9 })
  .toFile('public/og.png');
console.log('wrote public/og.png (1200×630)');
