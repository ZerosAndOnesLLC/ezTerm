// Cross-platform post-build step.
// 1. Rename Astro's auto-emitted sitemap-0.xml to the conventional sitemap.xml
//    (what robots.txt advertises and search engines auto-discover).
// 2. Remove sitemap-index.xml so we don't serve three identical sitemap URLs.
import fs from 'node:fs';

const DIST = 'dist';

if (fs.existsSync(`${DIST}/sitemap-0.xml`)) {
  fs.renameSync(`${DIST}/sitemap-0.xml`, `${DIST}/sitemap.xml`);
  console.log('post-build: dist/sitemap-0.xml → dist/sitemap.xml');
}
if (fs.existsSync(`${DIST}/sitemap-index.xml`)) {
  fs.rmSync(`${DIST}/sitemap-index.xml`);
  console.log('post-build: removed dist/sitemap-index.xml (duplicate)');
}
