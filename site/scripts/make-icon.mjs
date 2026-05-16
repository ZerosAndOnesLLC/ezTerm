// One-off: crop the splash logo to an icon-only PNG for use in the docs nav.
// Splash is 1254x1254; the terminal panel sits in the upper-middle, with
// "ezTerm SSH CLIENT" text below — we want just the panel.
import sharp from 'sharp';

const SRC = 'src/assets/ezterm.png';
const OUT = 'src/assets/ezterm-icon.png';

await sharp(SRC)
  .extract({ left: 310, top: 150, width: 620, height: 620 })
  .resize(256, 256)
  .toFile(OUT);

console.log(`wrote ${OUT}`);
