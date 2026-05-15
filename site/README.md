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

## Deploy

Pushes to `main` that touch `site/**` or `docs/release-notes/**` trigger `.github/workflows/site.yml`, which builds and deploys to GitHub Pages.
