# GitHub Pages website — design

A public marketing + docs site for ezTerm, hosted on GitHub Pages and built
with Astro 5 + Starlight. Lives in-repo under `site/`, deploys via GitHub
Actions, and replaces the README as the canonical user-facing landing page.

## Goal

Give ezTerm a polished public presence at
`https://zerosandonesllc.github.io/ezTerm/` that:

1. Pitches the product to first-time visitors (hero + screenshots + download).
2. Walks new users through install and first connect.
3. Documents each feature (SSH, SFTP, WSL, X11, port forwarding, vault,
   MobaXterm import) so users have somewhere to land beyond the README.
4. Surfaces release notes as a versioned changelog page.
5. Stays in lockstep with the codebase — docs and release notes live in the
   same repo, deploy on every push to `main` that touches them.

Non-goal: replacing the in-app help (there isn't any yet) or maintaining
versioned docs for old releases.

## Decisions (locked in during brainstorming)

| Topic                | Decision                                                                                |
|----------------------|-----------------------------------------------------------------------------------------|
| Site purpose         | Landing page + docs (not docs-only, not landing-only).                                  |
| Stack                | Astro 5 + Starlight + Tailwind CSS.                                                     |
| Visual direction     | Direction "B" — developer/terminal aesthetic. Deep black, cyan-blue accent, mono motifs.|
| Theme                | Dark default with light-mode toggle (Starlight default).                                |
| URL                  | GitHub Pages default `zerosandonesllc.github.io/ezTerm/`. Custom domain deferred.        |
| Pages source         | "GitHub Actions" mode (modern path; no `gh-pages` branch).                              |
| Source location      | `site/` at repo root, parallel to `ui/` and `src-tauri/`.                               |
| Fonts                | Inter (body) + JetBrains Mono (code/terminal). Self-hosted via `@fontsource`.           |
| Search               | Pagefind (ships with Starlight) — free, no Algolia.                                     |
| Analytics            | None in v1.                                                                             |
| Versioned docs       | One current version only; changelog page covers history.                                |
| i18n                 | English only.                                                                           |

## Visual direction

Direction B from brainstorming — locked in after side-by-side mockups. Concrete
tokens:

| Token            | Dark              | Light             | Notes                                              |
|------------------|-------------------|-------------------|----------------------------------------------------|
| `--bg`           | `#0a0a0a`         | `#fafafa`         | Page background.                                   |
| `--bg-elevated`  | `#141414`         | `#ffffff`         | Cards, mockup frames.                              |
| `--fg`           | `#e8e8e8`         | `#111111`         | Body text.                                         |
| `--fg-muted`     | `#888888`         | `#666666`         | Secondary text.                                    |
| `--accent`       | `#78c8ff`         | `#2a7fd0`         | Cyan-blue. Used for links, primary buttons, glow.  |
| `--border`       | `#1f1f1f`         | `#e5e7eb`         | Hairlines.                                         |
| `--code-comment` | `#78c8ff`         | `#2a7fd0`         | `//` comments in code blocks pick up accent.       |

Hero gets a subtle `radial-gradient(circle at 20% 0%, rgba(120,200,255,0.08), transparent 50%)`
glow on the dark theme; light theme drops the glow.

Font stack:
- Body: `'Inter', system-ui, -apple-system, sans-serif`
- Code / terminal motifs: `'JetBrains Mono', 'Cascadia Mono', ui-monospace, monospace`

Body 15px / line-height 1.55. Headings tightened to `letter-spacing: -0.3px`
(hero gets `-0.6px`). Border-radius is small but not sharp: 4px on cards,
6px on buttons.

## Sitemap

```
/                                  Custom landing page (NOT Starlight default)
/docs/                             Starlight docs index
  getting-started/
    install
    first-connect
    importing-from-mobaxterm
  features/
    ssh
    sftp
    wsl
    local-shells
    x11-forwarding
    port-forwarding
    vault
  troubleshooting
  faq
/screenshots/                      Custom Astro gallery page
/changelog/                        Auto-built from docs/release-notes/*.md
/download/                         Tiny page that redirects to latest GH release
```

## Landing page sections (single scroll)

1. **Hero** — direction-B styled. Headline ("An SSH client that respects your
   terminal."), 2-line pitch, "Download for Windows" primary button linking
   to `https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest`, "View on
   GitHub" secondary button, subtle radial glow. Top nav: ezTerm logo +
   Features / Docs / Changelog / GitHub. Version pill (e.g. "v1.3.4") sits
   next to the download button and is hard-coded — bumped per release as
   part of the existing `Cargo.toml` version-bump step. A follow-up can
   fetch this from the GH releases API at build time once we have a reason.
2. **App screenshot strip** — `ezterm.png` (already in repo) rendered in a
   styled "mockup frame" component. Future enhancement: short MP4/WebM loop.
3. **Feature grid** — 6 cards in a responsive grid (3×2 desktop, 1×6 mobile):
   SSH, SFTP, WSL, X11, Vault, MobaXterm import. Each card: lucide-react icon,
   one-line description, link to the matching `/docs/features/<x>` page.
4. **Why ezTerm** — short comparison strip (table or card row): "Free vs paid",
   "Open source vs closed", "Modern Rust core vs legacy", "Active vs
   maintenance-mode". No vendor-bashing — factual and short.
5. **Install snippet** — tabbed code block (Windows / Linux / macOS) with the
   real install steps from the README (download `.tar.xz`, extract, run the
   binary). No fake `curl | sh` — that's not how ezTerm installs.
6. **Footer** — GPLv3 license link, GitHub link, issues link, security policy
   link, "Made with Rust + Tauri" line.

## Repository layout

```
ezTerm/
├── site/                              NEW
│   ├── astro.config.mjs
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── tailwind.config.mjs
│   ├── public/
│   │   ├── favicon.svg
│   │   ├── og-image.png               # Open Graph preview
│   │   └── screenshots/               # PNG/WebP, copied or re-captured
│   │   # CNAME is intentionally absent in v1. If/when a custom domain lands,
│   │   # add site/public/CNAME with the bare domain on one line.
│   └── src/
│       ├── content/
│       │   ├── config.ts              # Starlight content collection + custom changelog collection
│       │   └── docs/
│       │       ├── getting-started/
│       │       │   ├── install.md
│       │       │   ├── first-connect.md
│       │       │   └── importing-from-mobaxterm.md
│       │       ├── features/
│       │       │   ├── ssh.md
│       │       │   ├── sftp.md
│       │       │   ├── wsl.md
│       │       │   ├── local-shells.md
│       │       │   ├── x11-forwarding.md
│       │       │   ├── port-forwarding.md
│       │       │   └── vault.md
│       │       ├── troubleshooting.md
│       │       └── faq.md
│       ├── components/
│       │   ├── Hero.astro
│       │   ├── FeatureGrid.astro
│       │   ├── InstallTabs.astro
│       │   ├── WhyEzterm.astro
│       │   ├── MockupFrame.astro
│       │   └── Footer.astro
│       ├── pages/
│       │   ├── index.astro            # Landing (overrides Starlight default)
│       │   ├── screenshots.astro      # Gallery
│       │   ├── changelog.astro        # Reads docs/release-notes/*.md
│       │   └── download.astro         # Redirect to latest GH release
│       └── styles/
│           ├── global.css             # CSS variables for theme tokens
│           └── starlight-overrides.css
├── src-tauri/
├── ui/
├── docs/
│   ├── release-notes/                 # Read by site at build time (relative path)
│   └── superpowers/specs/
└── .github/workflows/
    ├── release.yml                    # existing
    └── site.yml                       # NEW
```

## Astro configuration

```js
// site/astro.config.mjs (shape only — exact API verified at implementation time)
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://zerosandonesllc.github.io',
  base: '/ezTerm/',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'ezTerm',
      logo: { src: './src/assets/logo.svg' },
      social: { github: 'https://github.com/ZerosAndOnesLLC/ezTerm' },
      customCss: ['./src/styles/global.css', './src/styles/starlight-overrides.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Install', link: '/docs/getting-started/install/' },
            { label: 'First connect', link: '/docs/getting-started/first-connect/' },
            { label: 'Import from MobaXterm', link: '/docs/getting-started/importing-from-mobaxterm/' },
          ],
        },
        {
          label: 'Features',
          autogenerate: { directory: 'features' },
        },
        { label: 'Troubleshooting', link: '/docs/troubleshooting/' },
        { label: 'FAQ', link: '/docs/faq/' },
      ],
    }),
    tailwind({ applyBaseStyles: false }),
  ],
});
```

Notes:
- `base: '/ezTerm/'` is critical — without it, GH Pages serves from the
  subpath and asset links break. Every internal `href` either uses Astro's
  `<a>` helpers or is written relative.
- Starlight's `customCss` order matters: `global.css` first (defines variables),
  `starlight-overrides.css` second (re-skins built-in components).

## Changelog page

The site reads `docs/release-notes/*.md` at build time using an Astro content
collection rooted at `../docs/release-notes/` (relative to `site/`). Each file
becomes a section on a single `/changelog/` page, sorted by filename
descending (the existing convention is `v1.3.4.md`, `v1.3.3.md`, …).

If a release-notes file uses a frontmatter `date:` field, sort by that
instead. Today the files have no frontmatter; the implementation step will
add `date:` to the latest one and document the convention.

## Download page

`/download/` is a tiny Astro page that 302-redirects to
`https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest`. Implemented as
a `<meta http-equiv="refresh" content="0; url=...">` because Pages can't do
real HTTP redirects.

The hero's "Download" button can also link directly to the GH releases page —
the `/download/` route exists so future content (e.g., a checksum table or
install instructions per platform) has somewhere to live.

## GitHub Actions workflow

`.github/workflows/site.yml`:

```yaml
name: Deploy site to Pages

on:
  push:
    branches: [main]
    paths:
      - 'site/**'
      - 'docs/release-notes/**'
      - '.github/workflows/site.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: site/package-lock.json
      - uses: actions/configure-pages@v5
      - run: npm ci
        working-directory: site
      - run: npm run build
        working-directory: site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

Single deploy job (no build/deploy split — build is fast and the simpler
shape is easier to reason about). The workflow is intentionally separate
from the existing release workflow so a site-only change doesn't trigger a
release build and vice versa.

## One-time manual GitHub setup

Once before the first deploy, a maintainer must:

1. Repo → Settings → Pages → **Build and deployment** → Source = **GitHub Actions**.
2. (Optional, later) Add a custom domain by creating `site/public/CNAME`
   with the bare domain on a single line and configuring DNS A/AAAA or
   CNAME records to GitHub Pages. (The file is intentionally absent in v1.)

These can't be automated from PR code — they require admin access to repo
settings. The implementation plan calls this out explicitly so the rollout
PR doesn't merge with deploys silently failing.

## Local dev

```bash
npm --prefix site install      # one-time
npm --prefix site run dev      # live preview at http://localhost:4321/ezTerm/
npm --prefix site run build    # produces site/dist/
npm --prefix site run preview  # serves site/dist/ for production sanity check
```

Update the root `README.md` "Dev quickstart" section with a short pointer to
these commands.

## Content authoring rules

- Docs pages are hand-written Markdown. Seed content comes from existing
  prose in `README.md` and the SSH-port-forwarding spec, then expanded.
- Every feature page must include at least one screenshot (PNG or WebP under
  `site/public/screenshots/`).
- Code blocks use fenced syntax with a language hint so Starlight syntax-
  highlights them.
- External links open in the same tab by default; explicit `target="_blank"`
  only for the GitHub / Releases destinations.
- No marketing-speak in docs ("blazing fast", "revolutionary", etc.).
  Match the README's tone: dry, specific, technical.

## Testing & verification

- `npm --prefix site run build` must pass clean (no warnings about broken
  links or missing assets). Astro and Starlight both surface these as build
  errors when strict.
- `actions/configure-pages` validates the Pages config; the workflow fails
  loudly if Pages isn't enabled or the source isn't "GitHub Actions".
- After first successful deploy, manually verify:
  - Landing page renders at `/ezTerm/` (note trailing slash).
  - Theme toggle persists across pages.
  - At least one docs page loads and the sidebar nav works.
  - Changelog page lists every entry from `docs/release-notes/`.
  - Lighthouse score ≥ 95 on Performance / Accessibility / Best Practices /
    SEO for the landing page.

## Out of scope for this site v1

- Custom domain (deferred, but unblocked — drop a CNAME file when ready).
- Search beyond Pagefind defaults (no Algolia, no custom index).
- Versioned docs (one current version only).
- Internationalization.
- Blog / news section.
- Analytics / telemetry / cookie banners.
- A separate brand identity beyond the existing `ezterm.png` logo —
  if a new logo is wanted, that's a follow-up.
- Comment system, contact form, or any server-side feature (Pages is static-only).

## Risks & open questions

- **Asset paths inside Markdown** — Astro's base path applies to `<a>` and
  `<Image>` but raw Markdown `![](/screenshots/x.png)` needs the base prefix
  or it 404s on GH Pages. Mitigation: use Astro's `<Image>` component or a
  Starlight-recommended helper for asset references; document the rule in
  the site's contributor README.
- **Release-notes filename convention** — sorting by filename works today
  because every release is `v1.3.x.md`. Once we hit `v1.10.0`, lexical sort
  breaks (`v1.10.0` < `v1.3.0`). Mitigation: parse the version from the
  filename and sort numerically, or require a frontmatter `date:` field.
  The plan will add a parser, not require frontmatter.
- **GH Pages caching** — Pages caches aggressively at the edge. Document a
  "force-purge" path (re-run the workflow) for the rare cases where a CSS
  change isn't picked up.
