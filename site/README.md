# ezTerm site

Public-facing marketing + docs site for [ezTerm](../README.md). Astro 5 + Starlight.

## Develop

```bash
npm install              # one-time
npm run dev              # http://localhost:4321/
npm run build            # → dist/
npm run preview          # serves dist/ for production sanity check
npm test                 # vitest (version parser)
```

## Where to add content

- New docs page → `src/content/docs/<section>/<slug>.md`. The sidebar `autogenerate` picks it up automatically for `features/`; other sections need a manual entry in `astro.config.mjs` → `starlight.sidebar`.
- New screenshot → drop a PNG/WebP in `public/screenshots/` and reference it through `${BASE}screenshots/<name>.png` so the path stays correct if the deploy base ever changes.
- Release notes → edit `../docs/release-notes/v<n>.md`. The `/changelog/` page picks new files up automatically on the next build, sorted by semver descending.
- SEO: give every page a ~50–60 char `<title>` and a ~140–160 char `description`. On docs pages keep the frontmatter `title` short (it's the H1 and sidebar label) and override the tab/SERP title via `head:` → `- tag: title` — see any existing docs page.

## Deploy

Pushes to `main` that touch `site/**` or `docs/release-notes/**` trigger `.github/workflows/site.yml`, which builds and deploys to GitHub Pages.

After each deploy the workflow submits every sitemap URL to [IndexNow](https://www.indexnow.org/) so Bing/Yandex-family engines recrawl within minutes (Google ignores IndexNow — it discovers changes via the sitemap registered in Search Console). The key file `public/fc2e8a4b7218fe19b3d54bba2d8215cb.txt` is public by design: engines fetch it from the live site to verify domain ownership. Don't delete or rename it — it must match `INDEXNOW_KEY` in `site.yml`.
