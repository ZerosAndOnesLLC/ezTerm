// Cross-platform post-build step.
// 1. Rename Astro's auto-emitted sitemap-0.xml to the conventional sitemap.xml
//    (what robots.txt advertises and search engines auto-discover).
// 2. Remove sitemap-index.xml so we don't serve three identical sitemap URLs.
// 3. Normalize the sitemap XML: strip unused namespaces and pretty-print —
//    Astro's compact one-line output with news/xhtml/image/video namespaces
//    can trip strict parsers (e.g. GSC sometimes reports "could not be read"
//    on the dense form).
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

if (fs.existsSync(`${DIST}/sitemap.xml`)) {
  const raw = fs.readFileSync(`${DIST}/sitemap.xml`, 'utf8');
  const locs = [...raw.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (locs.length > 0) {
    const body = locs
      .map((u) => `  <url>\n    <loc>${u}</loc>\n  </url>`)
      .join('\n');
    const out =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      body +
      '\n</urlset>\n';
    fs.writeFileSync(`${DIST}/sitemap.xml`, out);
    console.log(`post-build: normalized dist/sitemap.xml (${locs.length} URLs, pretty-printed, single namespace)`);
  }
}
