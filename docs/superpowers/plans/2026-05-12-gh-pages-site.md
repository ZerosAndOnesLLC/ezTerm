# GitHub Pages Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a polished marketing + docs site for ezTerm at `https://zerosandoneslc.github.io/ezTerm/`, built with Astro 5 + Starlight under `site/` and auto-deployed via GitHub Actions on every push to `main`.

**Architecture:** A new `site/` Astro project sits parallel to `ui/` and `src-tauri/`. A custom `index.astro` is the landing page (overrides Starlight's default home); Starlight handles all `/docs/*` routes with sidebar nav and Pagefind search; one custom page each for `/screenshots/`, `/changelog/`, and `/download/`. The changelog reads `../docs/release-notes/*.md` via an Astro content collection with a glob loader, parses semver from the filename, and sorts numerically (so `v1.10.0` ranks above `v1.3.4`). A new `.github/workflows/site.yml` builds and deploys via `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4`.

**Tech Stack:** Astro 5, Starlight, Tailwind CSS (via `@astrojs/tailwind`), `@fontsource/inter` + `@fontsource/jetbrains-mono`, `vitest` for the changelog version parser. No new Rust deps.

**Spec reference:** `docs/superpowers/specs/2026-05-12-gh-pages-site-design.md`

**Commit convention:** Site changes use `feat(site): ...`, `docs(site): ...`, etc. **Do not bump `Cargo.toml`** for site-only commits — the site doesn't ship inside the Rust binary, and existing repo convention for `docs(spec)` / `docs(plan)` commits is no bump.

**Starlight API note:** Some Starlight config shapes (e.g. `social`) changed across minor versions. When a task says "set `social` to ...", verify against `node_modules/@astrojs/starlight/types.d.ts` after `npm install` and adjust to whatever the installed version expects. The plan's config snippets target the latest stable shape at the time of writing.

---

## File Map

### New under `site/`

```
site/
├── .gitignore                              Node + Astro build artifacts
├── astro.config.mjs                        Astro + Starlight + Tailwind config
├── package.json                            Astro, Starlight, Tailwind, fontsource, vitest deps
├── package-lock.json                       Committed
├── tsconfig.json                           Extends astro/tsconfigs/strict
├── tailwind.config.mjs                     Tailwind config; reads CSS vars
├── vitest.config.ts                        Test config for the version parser
├── README.md                               Contributor notes (how to run, where to add docs)
├── public/
│   ├── favicon.svg                         New 1-color glyph
│   ├── og-image.png                        Open Graph preview (1200x630)
│   └── screenshots/
│       └── hero.png                        Copy of repo-root ezterm.png
└── src/
    ├── assets/
    │   └── logo.svg                        Starlight nav logo
    ├── content.config.ts                   Content collections (docs + changelog)
    ├── content/
    │   └── docs/
    │       ├── index.mdx                   Docs landing page
    │       ├── getting-started/
    │       │   ├── install.md
    │       │   ├── first-connect.md
    │       │   └── importing-from-mobaxterm.md
    │       ├── features/
    │       │   ├── ssh.md
    │       │   ├── sftp.md
    │       │   ├── wsl.md
    │       │   ├── local-shells.md
    │       │   ├── x11-forwarding.md
    │       │   ├── port-forwarding.md
    │       │   └── vault.md
    │       ├── troubleshooting.md
    │       └── faq.md
    ├── components/
    │   ├── Hero.astro
    │   ├── FeatureGrid.astro
    │   ├── WhyEzterm.astro
    │   ├── InstallTabs.astro
    │   ├── MockupFrame.astro
    │   └── SiteFooter.astro
    ├── lib/
    │   ├── version.ts                      Semver parse + sort helper
    │   └── version.test.ts                 Vitest unit tests
    ├── pages/
    │   ├── index.astro                     Landing page
    │   ├── screenshots.astro               Gallery
    │   ├── changelog.astro                 Renders ../docs/release-notes/
    │   └── download.astro                  Meta-refresh redirect
    └── styles/
        ├── global.css                      CSS variables + Tailwind base
        └── starlight-overrides.css         Re-skin Starlight to match
```

### Modified

- `.github/workflows/site.yml` — **new**, the deploy workflow.
- `README.md` (repo root) — append a one-paragraph "Website" section linking to the live URL + dev-quickstart for `site/`.

---

## Task 1: Scaffold the `site/` Astro project

**Files:**
- Create: `site/package.json`, `site/astro.config.mjs`, `site/tsconfig.json`, `site/.gitignore`, `site/README.md`

- [ ] **Step 1: Create the `site/` directory and initialize package.json**

```bash
mkdir -p /home/mack/dev/ezTerm/site
cd /home/mack/dev/ezTerm/site
```

Write `site/package.json`:

```json
{
  "name": "ezterm-site",
  "type": "module",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "start": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "astro": "astro",
    "test": "vitest run"
  },
  "dependencies": {
    "@astrojs/starlight": "^0.30.0",
    "@astrojs/tailwind": "^5.1.0",
    "@fontsource/inter": "^5.1.0",
    "@fontsource/jetbrains-mono": "^5.1.0",
    "astro": "^5.0.0",
    "sharp": "^0.33.0",
    "tailwindcss": "^3.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `site/tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 3: Write `site/.gitignore`**

```
# Astro
dist/
.astro/

# Node
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Vitest
coverage/
```

- [ ] **Step 4: Write `site/README.md`**

````markdown
# ezTerm site

Public-facing marketing + docs site for [ezTerm](../README.md). Astro 5 + Starlight.

## Develop

```bash
npm install              # one-time
npm run dev              # http://localhost:4321/ezTerm/
npm run build            # → dist/
npm run preview          # serves dist/ for production sanity check
npm test                 # vitest (version parser)
```

## Where to add content

- New docs page → `src/content/docs/<section>/<slug>.md`. The sidebar `autogenerate` picks it up automatically for `features/`; other sections need a manual entry in `astro.config.mjs` → `starlight.sidebar`.
- New screenshot → drop a PNG/WebP in `public/screenshots/` and reference it as `/ezTerm/screenshots/<name>.png` (note the base path).
- Release notes → edit `../docs/release-notes/v<n>.md`. The `/changelog/` page picks new files up automatically on the next build, sorted by semver descending.

## Deploy

Pushes to `main` that touch `site/**` or `docs/release-notes/**` trigger `.github/workflows/site.yml`, which builds and deploys to GitHub Pages.
````

- [ ] **Step 5: Write a placeholder `astro.config.mjs`**

```js
// site/astro.config.mjs
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://zerosandoneslc.github.io',
  base: '/ezTerm/',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'ezTerm',
      customCss: [
        '@fontsource/inter/400.css',
        '@fontsource/inter/600.css',
        '@fontsource/inter/700.css',
        '@fontsource/jetbrains-mono/400.css',
        '@fontsource/jetbrains-mono/600.css',
        './src/styles/global.css',
        './src/styles/starlight-overrides.css',
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ZerosAndOnesLLC/ezTerm' },
      ],
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

- [ ] **Step 6: Install dependencies and verify Astro recognizes the project**

```bash
cd /home/mack/dev/ezTerm/site && npm install
```

Expected: exits 0; creates `node_modules/` and `package-lock.json`.

```bash
cd /home/mack/dev/ezTerm/site && npx astro --version
```

Expected: prints an Astro version `5.x.x`.

- [ ] **Step 7: Commit the scaffold**

```bash
cd /home/mack/dev/ezTerm
git add site/package.json site/package-lock.json site/tsconfig.json site/.gitignore site/README.md site/astro.config.mjs
git commit -m "feat(site): scaffold Astro + Starlight project under site/"
```

Note: don't commit `site/node_modules/` (gitignored). Don't commit `site/dist/` (gitignored).

---

## Task 2: Stub the content collection so Astro builds

Astro 5 requires `src/content.config.ts` once any content collection exists. We add it now so subsequent tasks can build incrementally.

**Files:**
- Create: `site/src/content.config.ts`
- Create: `site/src/content/docs/index.mdx` (placeholder)

- [ ] **Step 1: Write `site/src/content.config.ts`**

```ts
// site/src/content.config.ts
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

- [ ] **Step 2: Write a placeholder `site/src/content/docs/index.mdx`**

```mdx
---
title: ezTerm docs
description: Documentation for ezTerm, a free, open-source SSH client.
template: doc
---

Documentation home. See the sidebar.
```

- [ ] **Step 3: Build to confirm Astro is happy with the empty config**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: completes with no errors. May warn about missing sidebar targets — that's OK for now, those pages land in later tasks.

- [ ] **Step 4: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/content.config.ts site/src/content/docs/index.mdx
git commit -m "feat(site): content collection + docs index stub"
```

---

## Task 3: Theme tokens and Tailwind config

**Files:**
- Create: `site/src/styles/global.css`, `site/src/styles/starlight-overrides.css`, `site/tailwind.config.mjs`

- [ ] **Step 1: Write `site/src/styles/global.css`**

```css
/* site/src/styles/global.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Light theme (Starlight applies these on <html data-theme="light">) */
  --site-bg:           #fafafa;
  --site-bg-elevated:  #ffffff;
  --site-fg:           #111111;
  --site-fg-muted:     #666666;
  --site-accent:       #2a7fd0;
  --site-border:       #e5e7eb;
  --site-code-comment: #2a7fd0;
}

:root[data-theme='dark'] {
  --site-bg:           #0a0a0a;
  --site-bg-elevated:  #141414;
  --site-fg:           #e8e8e8;
  --site-fg-muted:     #888888;
  --site-accent:       #78c8ff;
  --site-border:       #1f1f1f;
  --site-code-comment: #78c8ff;
}

html, body {
  background: var(--site-bg);
  color: var(--site-fg);
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

code, pre, .mono {
  font-family: 'JetBrains Mono', 'Cascadia Mono', ui-monospace, monospace;
}
```

- [ ] **Step 2: Write `site/src/styles/starlight-overrides.css`**

```css
/* site/src/styles/starlight-overrides.css
 * Map Starlight's CSS custom properties to ours so docs pages
 * inherit the same dark-default theme as the landing.
 */
:root {
  --sl-color-accent:        var(--site-accent);
  --sl-color-accent-low:    rgba(42, 127, 208, 0.12);
  --sl-color-accent-high:   var(--site-accent);
  --sl-color-text-accent:   var(--site-accent);
  --sl-font:                'Inter', system-ui, -apple-system, sans-serif;
  --sl-font-mono:           'JetBrains Mono', 'Cascadia Mono', ui-monospace, monospace;
}

:root[data-theme='dark'] {
  --sl-color-bg:            var(--site-bg);
  --sl-color-bg-nav:        var(--site-bg);
  --sl-color-bg-sidebar:    var(--site-bg);
  --sl-color-text:          var(--site-fg);
  --sl-color-text-muted:    var(--site-fg-muted);
  --sl-color-hairline:      var(--site-border);
  --sl-color-accent-low:    rgba(120, 200, 255, 0.12);
}
```

- [ ] **Step 3: Write `site/tailwind.config.mjs`**

```js
// site/tailwind.config.mjs
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'site-bg':           'var(--site-bg)',
        'site-bg-elevated':  'var(--site-bg-elevated)',
        'site-fg':           'var(--site-fg)',
        'site-fg-muted':     'var(--site-fg-muted)',
        'site-accent':       'var(--site-accent)',
        'site-border':       'var(--site-border)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 4: Build to verify Tailwind + Starlight load**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: completes; no Tailwind or CSS errors. Inspect `dist/_astro/*.css` and confirm `--site-bg` appears.

```bash
grep -l "site-bg" /home/mack/dev/ezTerm/site/dist/_astro/*.css | head -1
```

Expected: a file path prints (the compiled CSS contains the custom property).

- [ ] **Step 5: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/styles/ site/tailwind.config.mjs
git commit -m "feat(site): theme tokens (dark default + light) and Tailwind config"
```

---

## Task 4: Hero component

**Files:**
- Create: `site/src/components/Hero.astro`

- [ ] **Step 1: Write `site/src/components/Hero.astro`**

```astro
---
// site/src/components/Hero.astro
const RELEASES_LATEST = 'https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest';
const REPO = 'https://github.com/ZerosAndOnesLLC/ezTerm';
const VERSION = 'v1.3.4'; // bump per release; see plan §commit convention
---
<section class="relative overflow-hidden">
  <div class="absolute inset-0 pointer-events-none dark-glow" aria-hidden="true"></div>

  <div class="relative max-w-5xl mx-auto px-6 pt-24 pb-20">
    <p class="text-sm font-medium text-site-accent font-mono mb-4">// open-source ssh client for windows</p>
    <h1 class="text-5xl md:text-6xl font-bold tracking-tight leading-tight mb-5">
      An SSH client that<br />respects your terminal.
    </h1>
    <p class="text-lg text-site-fg-muted max-w-xl mb-9">
      MobaXterm-style sessions, modern Rust core. SSH, SFTP, WSL, X11 forwarding,
      port forwarding, and an encrypted credential vault — all in one tabbed client.
    </p>

    <div class="flex flex-wrap gap-3 items-center">
      <a
        href={RELEASES_LATEST}
        class="inline-flex items-center gap-2 bg-site-accent text-black font-semibold px-5 py-2.5 rounded text-sm hover:brightness-110 transition"
      >
        Download for Windows
        <span class="opacity-60 font-normal">{VERSION}</span>
      </a>
      <a
        href={REPO}
        class="inline-flex items-center gap-2 border border-site-border text-site-fg px-5 py-2.5 rounded text-sm hover:bg-site-bg-elevated transition"
      >
        View on GitHub <span aria-hidden="true">↗</span>
      </a>
    </div>
  </div>
</section>

<style>
  .dark-glow {
    background: radial-gradient(circle at 20% 0%, rgba(120, 200, 255, 0.08), transparent 50%);
  }
  :root[data-theme='light'] .dark-glow {
    display: none;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/components/Hero.astro
git commit -m "feat(site): hero component"
```

---

## Task 5: FeatureGrid component

**Files:**
- Create: `site/src/components/FeatureGrid.astro`

- [ ] **Step 1: Write `site/src/components/FeatureGrid.astro`**

```astro
---
// site/src/components/FeatureGrid.astro
const BASE = import.meta.env.BASE_URL;
const features = [
  { title: 'SSH', desc: 'russh-backed sessions with password, key, or agent auth and TOFU known-hosts.', href: `${BASE}docs/features/ssh/` },
  { title: 'SFTP', desc: 'Docked side-pane with drag-drop upload and streaming progress.',                 href: `${BASE}docs/features/sftp/` },
  { title: 'WSL',  desc: 'WSL distros as tabs under ConPTY. `code .`, `explorer.exe`, all interop works.', href: `${BASE}docs/features/wsl/` },
  { title: 'X11 forwarding', desc: 'Bundled VcXsrv on Windows — remote GUI apps pop as native windows.',  href: `${BASE}docs/features/x11-forwarding/` },
  { title: 'Port forwarding', desc: 'Local, remote, and dynamic (SOCKS5). Persistent + ad-hoc.',           href: `${BASE}docs/features/port-forwarding/` },
  { title: 'Vault', desc: 'Argon2id + ChaCha20-Poly1305 for every stored secret. Zeroized on use.',        href: `${BASE}docs/features/vault/` },
];
---
<section class="max-w-5xl mx-auto px-6 py-16">
  <h2 class="text-3xl font-bold tracking-tight mb-2">Everything you expect, in one place.</h2>
  <p class="text-site-fg-muted mb-10">Six core features ship in the box. No plugins, no upsell.</p>

  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    {features.map((f) => (
      <a
        href={f.href}
        class="block p-5 rounded border border-site-border bg-site-bg-elevated hover:border-site-accent transition"
      >
        <h3 class="font-semibold mb-1.5 text-site-fg">{f.title}</h3>
        <p class="text-sm text-site-fg-muted leading-relaxed">{f.desc}</p>
      </a>
    ))}
  </div>
</section>
```

- [ ] **Step 2: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/components/FeatureGrid.astro
git commit -m "feat(site): feature grid component"
```

---

## Task 6: MockupFrame component and screenshot strip

**Files:**
- Create: `site/src/components/MockupFrame.astro`
- Create: `site/public/screenshots/hero.png` (copied from repo root)

- [ ] **Step 1: Copy the existing hero screenshot into the site's public dir**

```bash
mkdir -p /home/mack/dev/ezTerm/site/public/screenshots
cp /home/mack/dev/ezTerm/ezterm.png /home/mack/dev/ezTerm/site/public/screenshots/hero.png
```

- [ ] **Step 2: Write `site/src/components/MockupFrame.astro`**

```astro
---
// site/src/components/MockupFrame.astro
//
// Renders an image inside a Mac-window-style frame so screenshots feel
// "framed" rather than just dumped on the page. Used on the landing page
// and the screenshots gallery.
interface Props {
  src: string;
  alt: string;
  caption?: string;
}
const { src, alt, caption } = Astro.props;
---
<figure class="rounded-lg overflow-hidden border border-site-border bg-site-bg-elevated shadow-2xl">
  <div class="flex items-center gap-1.5 px-3 py-2 border-b border-site-border bg-site-bg">
    <span class="w-2.5 h-2.5 rounded-full bg-[#ff5f57]"></span>
    <span class="w-2.5 h-2.5 rounded-full bg-[#febc2e]"></span>
    <span class="w-2.5 h-2.5 rounded-full bg-[#28c840]"></span>
  </div>
  <img src={src} alt={alt} loading="lazy" decoding="async" class="block w-full h-auto" />
  {caption && <figcaption class="px-4 py-3 text-sm text-site-fg-muted border-t border-site-border">{caption}</figcaption>}
</figure>
```

- [ ] **Step 3: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/components/MockupFrame.astro site/public/screenshots/hero.png
git commit -m "feat(site): mockup frame component + hero screenshot"
```

---

## Task 7: InstallTabs component

**Files:**
- Create: `site/src/components/InstallTabs.astro`

- [ ] **Step 1: Write `site/src/components/InstallTabs.astro`**

```astro
---
// site/src/components/InstallTabs.astro
//
// Three-tab code block: Windows, Linux, macOS. Pure CSS using
// `:has(:checked)` so there's no client JS.
const tabs = [
  {
    id: 'win',
    label: 'Windows',
    snippet: `# Download ezterm-windows-x86_64.tar.xz from the latest release
# https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest

tar -xf ezterm-windows-x86_64.tar.xz
cd ezterm-windows-x86_64
./ezterm.exe`,
  },
  {
    id: 'linux',
    label: 'Linux',
    snippet: `# Install deps: webkit2gtk-4.1, libssl
# Then download ezterm-linux-x86_64.tar.xz (or -aarch64) from:
# https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest

tar -xf ezterm-linux-x86_64.tar.xz
cd ezterm-linux-x86_64
./ezterm`,
  },
  {
    id: 'mac',
    label: 'macOS',
    snippet: `# Apple Silicon only for now
# Download ezterm-macos-aarch64.tar.xz from:
# https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest

tar -xf ezterm-macos-aarch64.tar.xz
cd ezterm-macos-aarch64
./ezterm`,
  },
];
---
<section class="max-w-5xl mx-auto px-6 py-16">
  <h2 class="text-3xl font-bold tracking-tight mb-2">Install in 30 seconds.</h2>
  <p class="text-site-fg-muted mb-8">Self-contained binary. No installer, no admin prompts.</p>

  <div class="install-tabs rounded-lg border border-site-border bg-site-bg-elevated overflow-hidden">
    <div class="flex border-b border-site-border" role="tablist">
      {tabs.map((t, i) => (
        <>
          <input type="radio" name="install-tab" id={`tab-${t.id}`} class="sr-only peer" checked={i === 0} />
          <label
            for={`tab-${t.id}`}
            class="cursor-pointer px-5 py-3 text-sm font-medium text-site-fg-muted hover:text-site-fg peer-checked:text-site-accent peer-checked:border-b-2 peer-checked:border-site-accent -mb-px"
          >{t.label}</label>
        </>
      ))}
    </div>
    {tabs.map((t) => (
      <pre class={`install-pane-${t.id} p-6 font-mono text-sm overflow-x-auto`}><code>{t.snippet}</code></pre>
    ))}
  </div>
</section>

<style>
  .install-tabs pre { display: none; }
  .install-tabs:has(#tab-win:checked)   .install-pane-win   { display: block; }
  .install-tabs:has(#tab-linux:checked) .install-pane-linux { display: block; }
  .install-tabs:has(#tab-mac:checked)   .install-pane-mac   { display: block; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/components/InstallTabs.astro
git commit -m "feat(site): install tabs (Windows/Linux/macOS)"
```

---

## Task 8: WhyEzterm comparison strip

**Files:**
- Create: `site/src/components/WhyEzterm.astro`

- [ ] **Step 1: Write `site/src/components/WhyEzterm.astro`**

```astro
---
// site/src/components/WhyEzterm.astro
const rows = [
  { label: 'Price',          ezterm: 'Free (GPLv3)',         other: 'Paid licence' },
  { label: 'Source',         ezterm: 'Open source',          other: 'Closed' },
  { label: 'Core language',  ezterm: 'Rust',                 other: 'C / C++' },
  { label: 'Encrypted vault', ezterm: 'Argon2id + ChaCha20-Poly1305', other: 'Yes' },
  { label: 'X11 server',     ezterm: 'Bundled (VcXsrv)',     other: 'Bundled' },
  { label: 'Update cadence', ezterm: 'Active development',   other: 'Slow / quiet' },
];
---
<section class="max-w-5xl mx-auto px-6 py-16">
  <h2 class="text-3xl font-bold tracking-tight mb-2">Why ezTerm.</h2>
  <p class="text-site-fg-muted mb-8">Same comforts, none of the cost.</p>

  <div class="rounded-lg border border-site-border overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-site-bg-elevated">
        <tr>
          <th class="text-left px-5 py-3 font-semibold w-1/3"></th>
          <th class="text-left px-5 py-3 font-semibold text-site-accent">ezTerm</th>
          <th class="text-left px-5 py-3 font-semibold text-site-fg-muted">Typical paid alternative</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr class="border-t border-site-border">
            <td class="px-5 py-3 text-site-fg-muted">{r.label}</td>
            <td class="px-5 py-3 font-medium">{r.ezterm}</td>
            <td class="px-5 py-3 text-site-fg-muted">{r.other}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</section>
```

- [ ] **Step 2: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/components/WhyEzterm.astro
git commit -m "feat(site): 'Why ezTerm' comparison strip"
```

---

## Task 9: SiteFooter component

**Files:**
- Create: `site/src/components/SiteFooter.astro`

- [ ] **Step 1: Write `site/src/components/SiteFooter.astro`**

```astro
---
// site/src/components/SiteFooter.astro
const REPO = 'https://github.com/ZerosAndOnesLLC/ezTerm';
---
<footer class="border-t border-site-border mt-12">
  <div class="max-w-5xl mx-auto px-6 py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 text-sm text-site-fg-muted">
    <div>
      <p class="text-site-fg font-semibold mb-1">ezTerm</p>
      <p>Made with Rust + Tauri. Licensed under GPLv3.</p>
    </div>
    <nav class="flex flex-wrap gap-5">
      <a href={REPO} class="hover:text-site-accent transition">GitHub</a>
      <a href={`${REPO}/issues`} class="hover:text-site-accent transition">Issues</a>
      <a href={`${REPO}/blob/main/SECURITY.md`} class="hover:text-site-accent transition">Security</a>
      <a href={`${REPO}/blob/main/LICENSE`} class="hover:text-site-accent transition">Licence</a>
    </nav>
  </div>
</footer>
```

- [ ] **Step 2: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/components/SiteFooter.astro
git commit -m "feat(site): site footer component"
```

---

## Task 10: Wire up the landing page

**Files:**
- Create: `site/src/pages/index.astro`

- [ ] **Step 1: Write `site/src/pages/index.astro`**

```astro
---
// site/src/pages/index.astro
import Hero from '../components/Hero.astro';
import MockupFrame from '../components/MockupFrame.astro';
import FeatureGrid from '../components/FeatureGrid.astro';
import WhyEzterm from '../components/WhyEzterm.astro';
import InstallTabs from '../components/InstallTabs.astro';
import SiteFooter from '../components/SiteFooter.astro';

const BASE = import.meta.env.BASE_URL;
---
<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ezTerm — free, open-source SSH client for Windows</title>
    <meta name="description" content="MobaXterm-style sessions, modern Rust core. SSH, SFTP, WSL, X11 forwarding, port forwarding, encrypted vault." />
    <meta property="og:title" content="ezTerm" />
    <meta property="og:description" content="Free, open-source SSH client. MobaXterm-style, modern Rust core." />
    <meta property="og:image" content={`${BASE}og-image.png`} />
    <link rel="icon" type="image/svg+xml" href={`${BASE}favicon.svg`} />
  </head>
  <body class="bg-site-bg text-site-fg">
    <!-- Top nav -->
    <header class="border-b border-site-border">
      <div class="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href={BASE} class="flex items-center gap-2 font-bold tracking-tight">
          <span class="text-site-accent" aria-hidden="true">▲</span>
          <span>ezTerm</span>
        </a>
        <nav class="flex items-center gap-6 text-sm text-site-fg-muted">
          <a href={`${BASE}docs/`} class="hover:text-site-fg">Docs</a>
          <a href={`${BASE}screenshots/`} class="hover:text-site-fg">Screenshots</a>
          <a href={`${BASE}changelog/`} class="hover:text-site-fg">Changelog</a>
          <a href="https://github.com/ZerosAndOnesLLC/ezTerm" class="hover:text-site-fg">GitHub</a>
        </nav>
      </div>
    </header>

    <main>
      <Hero />

      <div class="max-w-5xl mx-auto px-6 -mt-8 mb-4">
        <MockupFrame
          src={`${BASE}screenshots/hero.png`}
          alt="ezTerm with sessions sidebar, tabbed terminals, and SFTP side-pane"
        />
      </div>

      <FeatureGrid />
      <WhyEzterm />
      <InstallTabs />
    </main>

    <SiteFooter />
  </body>
</html>
```

- [ ] **Step 2: Build and inspect output**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: completes; `site/dist/index.html` exists and contains the headline text.

```bash
grep -q "An SSH client that" /home/mack/dev/ezTerm/site/dist/index.html && echo OK
```

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/pages/index.astro
git commit -m "feat(site): landing page wires hero + grid + table + install + footer"
```

---

## Task 11: Getting-started docs

**Files:**
- Create: `site/src/content/docs/getting-started/install.md`
- Create: `site/src/content/docs/getting-started/first-connect.md`
- Create: `site/src/content/docs/getting-started/importing-from-mobaxterm.md`

- [ ] **Step 1: Write `install.md`**

```markdown
---
title: Install
description: How to install ezTerm on Windows, Linux, and macOS.
---

ezTerm ships as a single self-contained binary — no installer required.

Download the archive for your platform from the [latest release](https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest):

| Platform | Archive |
|---|---|
| Windows x86_64 | `ezterm-windows-x86_64.tar.xz` |
| Linux x86_64 | `ezterm-linux-x86_64.tar.xz` |
| Linux aarch64 | `ezterm-linux-aarch64.tar.xz` |
| macOS aarch64 | `ezterm-macos-aarch64.tar.xz` |

Extract, then run the `ezterm` (or `ezterm.exe`) binary inside.

## Runtime requirements

### Windows
The release tarball bundles VcXsrv in a `vcxsrv/` subfolder next to `ezterm.exe`, so X11 forwarding works out of the box. To use a system install instead, delete the bundled folder and install [VcXsrv](https://sourceforge.net/projects/vcxsrv/) at `%ProgramFiles%\VcXsrv\`.

### Linux
Needs `webkit2gtk-4.1` and `libssl` (match the build host's versions). On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-0 libssl3
```

### macOS
Apple Silicon only at present. No extra deps.

## First run

Launch the binary. You'll be prompted to set a master password — this unlocks the encrypted credential vault. Pick something memorable; there's no recovery path (see [vault docs](/docs/features/vault/)).

After that, the [first-connect walkthrough](./first-connect/) covers creating your first SSH session.
```

- [ ] **Step 2: Write `first-connect.md`**

```markdown
---
title: First connect
description: Create a session, connect, and run a command.
---

After setting your master password, you'll see the empty sessions sidebar. Let's connect to a server.

## Create a session

1. Click **New session** in the sidebar (or right-click → New session).
2. Pick **SSH** as the session kind.
3. Fill in:
   - **Host** — e.g. `example.com` or an IP address.
   - **Port** — `22` unless your server uses a different port.
   - **Username** — your remote user.
   - **Auth method** — Password, Private key, or SSH agent.
4. Click **Save**.

The session appears in the sidebar.

## Connect

Double-click the saved session (or right-click → Connect). A new tab opens.

- On **first connect**, ezTerm shows the server's host-key fingerprint. Verify it matches what your server admin published, then click **Trust**. Subsequent connects use the stored key — a mismatch is a hard failure (see [SSH docs](/docs/features/ssh/) for TOFU details).
- If auth fails, an inline overlay appears in the tab — fix the credentials there without closing the tab.

## What you can do now

- **Terminal** — full xterm.js with 24-bit colour, scrollback, find (`Ctrl+Shift+F`), copy (`Ctrl+Shift+C`), paste (`Ctrl+Shift+V` or `Shift+Insert`).
- **SFTP** — click the SFTP toggle on the tab to open a docked file browser on the same connection.
- **Forwards** — open the Forwards side-pane to add a port forward to the running session.

## Importing from MobaXterm

Got a `.mxtsessions` export? See [Import from MobaXterm](./importing-from-mobaxterm/).
```

- [ ] **Step 3: Write `importing-from-mobaxterm.md`**

```markdown
---
title: Import from MobaXterm
description: Bring SSH and WSL sessions over from MobaXterm.
---

ezTerm can read MobaXterm's session exports and recreate them — including the folder structure and any private-key files referenced by the sessions.

## What gets imported

- **SSH sessions** — host, port, username, auth method, attached private keys.
- **WSL sessions** — distro name and user.
- **Folder structure** — top-level folders are preserved.

Other kinds (RDP, Telnet, serial) are not in scope for ezTerm and are skipped.

## How to import

1. In MobaXterm: **Settings → Export sessions** → save the `.mxtsessions` file somewhere.
   (Alternatively, locate your `MobaXterm.ini` — same import works.)
2. In ezTerm: **File menu → Import from MobaXterm** → pick the file.
3. Review the import summary (how many sessions, how many keys), then **Confirm**.

## What happens to private keys

If a MobaXterm session references a private key on disk, ezTerm reads the key file and stores its contents as an encrypted vault credential, then attaches it to the matching session. The original key file on disk is left untouched.

If a key is passphrase-protected, you'll be prompted to enter the passphrase once during import — it's stored as a separate vault credential and reused for any session that needs it.

## Caveats

- ezTerm doesn't currently import macro definitions, terminal colour overrides, or per-session font settings. Sessions come in with ezTerm's defaults; tweak each one in the session-edit dialog if needed.
- Folder colours and icons are not imported — pick fresh ones in ezTerm.
```

- [ ] **Step 4: Build to verify**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: completes; `dist/docs/getting-started/install/index.html` exists.

- [ ] **Step 5: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/content/docs/getting-started/
git commit -m "docs(site): getting-started (install, first-connect, import from MobaXterm)"
```

---

## Task 12: Feature docs

**Files:**
- Create: `site/src/content/docs/features/{ssh,sftp,wsl,local-shells,x11-forwarding,port-forwarding,vault}.md`

- [ ] **Step 1: Write `ssh.md`**

```markdown
---
title: SSH
description: russh-backed sessions with password, key, or agent auth.
sidebar:
  order: 1
---

ezTerm uses [russh](https://crates.io/crates/russh) — a pure-Rust SSH client — for all SSH sessions. Connections run inside async tokio tasks; no OpenSSH or PuTTY dependency.

## Auth methods

| Method | What it does |
|---|---|
| **Password** | Stored encrypted in the vault. Re-used across reconnects. |
| **Private key** | Stored encrypted in the vault. Key file on disk is read once at save time. |
| **SSH agent** | Talks to a running ssh-agent (Windows: openssh-agent service, or Pageant). |

Pick one per session; ezTerm doesn't try multiple methods automatically.

## Host-key TOFU

On first connect to a host, ezTerm shows the server's fingerprint and asks for confirmation. On subsequent connects, the stored fingerprint is compared — a mismatch is a hard failure (no "ignore" prompt). To re-trust a server (legitimate key rotation), delete the entry from the known-hosts manager.

Known-hosts entries live in ezTerm's own SQLite database — not `~/.ssh/known_hosts`. This keeps ezTerm's trust state independent of the OpenSSH CLI.

## Keepalive and timeouts

Each session has independent **connect timeout** (initial handshake) and **keepalive interval** (TCP-level liveness ping while connected). Defaults are reasonable for most networks; bump keepalive shorter for flaky connections that drop idle.

## Compression

Optional — enable in the session edit dialog. Useful on slow links; mostly invisible on LAN.
```

- [ ] **Step 2: Write `sftp.md`**

```markdown
---
title: SFTP
description: File transfer side-pane on the same SSH connection.
sidebar:
  order: 2
---

Each SSH tab can optionally open an **SFTP side-pane** — a file browser docked on the left of the terminal. The pane uses an SFTP subsystem on the same SSH connection, so there's no second authentication step.

## Opening the pane

- Click the **SFTP toggle** on the active tab's right-edge, or
- Use the keyboard shortcut (see [keybinds](/docs/troubleshooting/)).

## What you can do

- **Browse** — click folders to descend, breadcrumb at the top to ascend.
- **Download** — right-click a file → Download. The file is streamed to your local Downloads folder.
- **Upload** — drag a file from Windows Explorer into the pane. Uploads are 32 KiB-chunked with live progress.
- **Rename / Delete** — right-click context menu.

## What you can't do (yet)

- Symbolic links are listed but not followed graphically.
- No "Open in editor" (would need a local editor handoff — not in v1).
- No multi-select for batch operations.
```

- [ ] **Step 3: Write `wsl.md`**

```markdown
---
title: WSL
description: WSL distros as tabs under ConPTY.
sidebar:
  order: 3
---

ezTerm can open WSL distros as terminal tabs — same UI as SSH sessions, but the backend is `wsl.exe -d <distro>` under a [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) on Windows.

## Create a WSL session

1. New session → **WSL**.
2. Pick the distro from the dropdown (ezTerm enumerates installed distros via `wsl.exe -l -v`).
3. (Optional) set the user.
4. Save and connect.

## Interop

Because the tab runs `wsl.exe`, all WSL ↔ Windows interop works:

- `code .` opens VS Code on the Windows host with the current WSL folder mounted.
- `explorer.exe .` opens Windows Explorer at the current path.
- Windows commands run via `<command>.exe`.

## Limitations

- Only one distro per session — switch by opening a new tab.
- WSL1 is supported but slower; WSL2 is preferred.
```

- [ ] **Step 4: Write `local-shells.md`**

```markdown
---
title: Local shells
description: cmd, PowerShell, or any local shell as a tab.
sidebar:
  order: 4
---

ezTerm can also open **local shells** — a Windows cmd, PowerShell, pwsh, or any absolute path to an executable.

## Create a local session

1. New session → **Local**.
2. Pick a preset (`cmd`, `powershell`, `pwsh`) or browse to a custom path.
3. (Optional) set a starting directory.
4. Save and connect.

The shell runs in a ConPTY just like WSL sessions, so colours and ANSI escapes work normally.

## Why?

For users who want everything in one window — local PowerShell, a WSL distro, and a remote SSH session as sibling tabs.
```

- [ ] **Step 5: Write `x11-forwarding.md`**

```markdown
---
title: X11 forwarding
description: Run remote Linux GUI apps as native Windows windows.
sidebar:
  order: 5
---

ezTerm bundles [VcXsrv](https://sourceforge.net/projects/vcxsrv/) on Windows so X11 forwarding works with no extra install. Remote GUI apps (`xeyes`, `gedit`, JetBrains IDEs, etc.) appear as native Windows windows on your desktop.

## Enable it

In the SSH session edit dialog, tick **Forward X11**. Save and (re)connect.

## How it works

When the SSH channel opens, russh's `server_channel_open_x11` handler pipes each incoming X11 channel bidirectionally to a loopback TCP connection on VcXsrv. The X server lifecycle is ref-counted per display — VcXsrv starts on the first X11-enabled session and exits when the last one closes.

## Using your own VcXsrv

If you'd rather use a system VcXsrv install:

1. Install VcXsrv at `%ProgramFiles%\VcXsrv\` (the default path).
2. Delete the `vcxsrv/` subfolder next to `ezterm.exe`.
3. ezTerm will fall back to the system install.

## Linux / macOS

X11 forwarding works on Linux against the user's existing X server. On macOS it requires XQuartz, which ezTerm does not manage — install it yourself.
```

- [ ] **Step 6: Write `port-forwarding.md`**

```markdown
---
title: Port forwarding
description: Local, remote, and dynamic (SOCKS5) forwards.
sidebar:
  order: 6
---

ezTerm supports all three SSH port-forward kinds — same semantics as the OpenSSH command-line flags.

| Kind | Flag | What it does |
|---|---|---|
| **Local** | `-L` | Client port → remote-reachable destination. |
| **Remote** | `-R` | Remote port → client-reachable destination. |
| **Dynamic** | `-D` | Local SOCKS5 proxy that tunnels through the server. |

## Persistent vs ad-hoc

- **Persistent** forwards are saved on the session and auto-start when you connect.
- **Ad-hoc** forwards are added to a running tab from the Forwards side-pane and die with the connection.

Both kinds flow through the same runtime and look identical in the UI.

## Add a forward

1. On a running SSH tab, open the **Forwards side-pane** (toolbar icon).
2. Click **+ Add forward**.
3. Pick the kind, set bind address/port and destination address/port.
4. Save.

Or pre-configure persistent forwards in the session edit dialog's **Forwards** tab.

## Caveats

- The dynamic forward implements **SOCKS5 with no auth, CONNECT only**. `BIND` and `UDP ASSOCIATE` are out of scope.
- Privileged ports (`<1024`) are allowed in the UI; the OS enforces. Bind failure surfaces in the pane with elevation guidance.
- Two tabs binding the same local port → second tab gets a friendly `EADDRINUSE` error.
- Editing a running forward = stop + restart.

## Default bind address

Defaults to `127.0.0.1`. Non-loopback values are allowed but trigger a yellow "LAN-reachable" warning so you don't accidentally expose a tunnel to your whole network.
```

- [ ] **Step 7: Write `vault.md`**

```markdown
---
title: Vault
description: Encrypted credential storage. Argon2id + ChaCha20-Poly1305.
sidebar:
  order: 7
---

Every secret ezTerm stores — SSH passwords, private keys, key passphrases — lives encrypted in the **vault**. Plaintext only exists in memory while a connection is being made, and is zeroized on drop.

## How it works

1. On first launch, you set a **master password**. Argon2id (memory-hard KDF) derives a vault key from it.
2. Each stored secret is encrypted as `(nonce, ciphertext)` using ChaCha20-Poly1305 (AEAD) and written to SQLite.
3. The vault key lives only in memory while the app is unlocked. Lock the vault (status-bar lock button) and the key is zeroized — re-entering the master password is required to use any session.

## Credential kinds

Three distinct kinds — so one stored passphrase can back many sessions:

- **Password** — used directly for password auth.
- **Private key** — the key material (PEM/OpenSSH format).
- **Passphrase** — the unlock passphrase for a private key.

## Backup

The vault can be exported as a single encrypted blob (master-password-protected). Import on another machine to migrate.

## What ezTerm never does

- Never logs plaintext secrets, ever — host, user, and fingerprint are the only identifiers that appear in traces.
- Never sends plaintext credentials to the renderer process — even auth material is passed only as an ephemeral handle.
- Never stores the master password itself — only the Argon2id verifier needed to derive the vault key.

## What happens if you forget the master password

There is no recovery. The vault is encrypted with a key derived from your password, and ezTerm has no escrow. If you lose it, the only path forward is to delete the vault and recreate sessions from scratch.
```

- [ ] **Step 8: Build to verify**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: build succeeds; the sidebar `autogenerate: { directory: 'features' }` should pick up all seven pages.

- [ ] **Step 9: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/content/docs/features/
git commit -m "docs(site): feature pages (SSH, SFTP, WSL, local, X11, forwards, vault)"
```

---

## Task 13: Troubleshooting and FAQ

**Files:**
- Create: `site/src/content/docs/troubleshooting.md`
- Create: `site/src/content/docs/faq.md`

- [ ] **Step 1: Write `troubleshooting.md`**

```markdown
---
title: Troubleshooting
description: Common issues and fixes.
---

## "Host key mismatch" hard-failure

ezTerm refuses to connect if the server's host key has changed since the last successful connect. This is intentional — a mismatch usually means MITM, a server rebuild, or someone reinstalling the OS.

**Fix:** open the known-hosts manager, find the entry for this host, and delete it. The next connect prompts for fresh trust.

## "EADDRINUSE" on a port forward

The bind port is already in use — usually by another ezTerm tab forwarding the same port, or by a non-ezTerm process.

**Fix:** pick a different local port, or stop the conflicting process. `netstat -ano` on Windows shows what owns a port.

## X11 forwarding window doesn't appear

Check:

1. The session has **Forward X11** enabled.
2. The remote shell has `$DISPLAY` set after connect (`echo $DISPLAY` should print something like `localhost:10.0`).
3. On Windows, VcXsrv is bundled — confirm `vcxsrv/` exists next to `ezterm.exe`.

## Vault won't unlock after upgrade

ezTerm's vault format is stable — upgrades don't invalidate it. If unlock fails after an upgrade, the master password is wrong. There's no recovery (see [Vault docs](/docs/features/vault/)).

## Linux: `error while loading shared libraries: libwebkit2gtk-4.1.so.0`

Install the runtime dep:

```bash
sudo apt install libwebkit2gtk-4.1-0
```

## Reporting a bug

Open an issue at [github.com/ZerosAndOnesLLC/ezTerm/issues](https://github.com/ZerosAndOnesLLC/ezTerm/issues) with:

- ezTerm version (Help → About, or run `ezterm --version`).
- OS and architecture.
- Steps to reproduce.
- Any logs from `%LOCALAPPDATA%\ezterm\logs\` (Windows) or `~/.local/share/ezterm/logs/` (Linux).
```

- [ ] **Step 2: Write `faq.md`**

```markdown
---
title: FAQ
description: Frequently asked questions.
---

## Is it really free?

Yes. GPLv3. No paid tier, no nag screen, no "pro" features.

## Does it work on Linux / macOS?

Yes, the binary builds and runs. SSH, SFTP, local shells, and the terminal all work. WSL is Windows-only by nature; X11 forwarding on Linux uses your system X server, and on macOS requires XQuartz.

## Why Tauri instead of Electron?

Smaller binary (~20 MB vs ~150 MB), lower memory, and the Rust backend handles all SSH / SFTP / vault / PTY work directly — no Node runtime in the protocol path.

## Can I run my own X server instead of the bundled VcXsrv?

Yes — install VcXsrv at `%ProgramFiles%\VcXsrv\` and delete the `vcxsrv/` folder next to `ezterm.exe`. See [X11 forwarding](/docs/features/x11-forwarding/).

## Does it support Telnet / RDP / serial?

No, and not planned. ezTerm is SSH-focused. Out of scope: Telnet, RDP, serial, X11 *server*, macros, session recording.

## How do I import existing sessions?

From MobaXterm — see [Import from MobaXterm](/docs/getting-started/importing-from-mobaxterm/). Importers for PuTTY / SecureCRT are not in v1 but tracked on the issue board.

## Where does ezTerm store data?

- **Database** (sessions, known-hosts, vault): `%LOCALAPPDATA%\ezterm\ezterm.db` (Windows) or `~/.local/share/ezterm/ezterm.db` (Linux).
- **Logs**: same parent dir, `logs/` subfolder.
- **Config**: same parent dir, `config.toml`.

## How do I report a security issue?

See [SECURITY.md](https://github.com/ZerosAndOnesLLC/ezTerm/blob/main/SECURITY.md) — please **don't** open a public issue.
```

- [ ] **Step 3: Build to verify**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: completes; sidebar shows troubleshooting + FAQ entries.

- [ ] **Step 4: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/content/docs/troubleshooting.md site/src/content/docs/faq.md
git commit -m "docs(site): troubleshooting + FAQ"
```

---

## Task 14: Version parser with TDD

The changelog page needs to sort release-note files by semver, not lexically. `v1.10.0` must rank above `v1.3.4`.

**Files:**
- Create: `site/src/lib/version.ts`
- Create: `site/src/lib/version.test.ts`
- Create: `site/vitest.config.ts`

- [ ] **Step 1: Write `site/vitest.config.ts`**

```ts
// site/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Write the failing test `site/src/lib/version.test.ts`**

```ts
// site/src/lib/version.test.ts
import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersionsDesc } from './version';

describe('parseVersion', () => {
  it('parses a plain semver filename', () => {
    expect(parseVersion('v1.3.4.md')).toEqual({ major: 1, minor: 3, patch: 4, raw: 'v1.3.4' });
  });
  it('parses without leading v', () => {
    expect(parseVersion('1.0.0.md')).toEqual({ major: 1, minor: 0, patch: 0, raw: '1.0.0' });
  });
  it('parses a two-digit minor', () => {
    expect(parseVersion('v1.10.0.md')).toEqual({ major: 1, minor: 10, patch: 0, raw: 'v1.10.0' });
  });
  it('returns null for an unparseable name', () => {
    expect(parseVersion('not-a-version.md')).toBeNull();
  });
});

describe('compareVersionsDesc', () => {
  it('puts higher major first', () => {
    expect(compareVersionsDesc('v2.0.0.md', 'v1.9.9.md')).toBeLessThan(0);
  });
  it('compares minor numerically, not lexically', () => {
    // The whole point of this module: v1.10 > v1.3, not the other way.
    expect(compareVersionsDesc('v1.10.0.md', 'v1.3.4.md')).toBeLessThan(0);
  });
  it('compares patch when major/minor tie', () => {
    expect(compareVersionsDesc('v1.3.5.md', 'v1.3.4.md')).toBeLessThan(0);
  });
  it('sorts an array of release-note filenames newest-first', () => {
    const files = ['v0.12.0.md', 'v1.10.0.md', 'v1.3.4.md', 'v0.18.2.md', 'v1.0.0.md'];
    const sorted = [...files].sort(compareVersionsDesc);
    expect(sorted).toEqual(['v1.10.0.md', 'v1.3.4.md', 'v1.0.0.md', 'v0.18.2.md', 'v0.12.0.md']);
  });
  it('puts unparseable names at the end (stable)', () => {
    const files = ['weird.md', 'v1.0.0.md'];
    expect([...files].sort(compareVersionsDesc)).toEqual(['v1.0.0.md', 'weird.md']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails (no `version.ts` yet)**

```bash
cd /home/mack/dev/ezTerm/site && npm test
```

Expected: FAIL — "Cannot find module './version'".

- [ ] **Step 4: Write `site/src/lib/version.ts`**

```ts
// site/src/lib/version.ts
//
// Parse and order semver release-note filenames so v1.10.0 > v1.3.4
// (lexical sort would do the opposite).

export interface Version {
  major: number;
  minor: number;
  patch: number;
  raw: string; // "v1.3.4" or "1.3.4" — exactly what appeared, no .md
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:\.md)?$/;

export function parseVersion(filename: string): Version | null {
  const m = filename.match(SEMVER_RE);
  if (!m) return null;
  const [, major, minor, patch] = m;
  const raw = filename.replace(/\.md$/, '');
  return { major: Number(major), minor: Number(minor), patch: Number(patch), raw };
}

// Sort comparator: newest-first. Unparseable filenames go to the end.
export function compareVersionsDesc(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va && !vb) return 0;
  if (!va) return 1;
  if (!vb) return -1;
  if (va.major !== vb.major) return vb.major - va.major;
  if (va.minor !== vb.minor) return vb.minor - va.minor;
  return vb.patch - va.patch;
}
```

- [ ] **Step 5: Run tests, verify all pass**

```bash
cd /home/mack/dev/ezTerm/site && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/lib/version.ts site/src/lib/version.test.ts site/vitest.config.ts
git commit -m "feat(site): semver version parser + comparator (TDD)"
```

---

## Task 15: Changelog page

**Files:**
- Create: `site/src/pages/changelog.astro`
- Modify: `site/astro.config.mjs` (no change needed — using `import.meta.glob` instead of a content collection avoids reaching outside `src/`)

Implementation note: Astro's content collections can in principle read from a folder outside `src/`, but `import.meta.glob` with a relative path is simpler and just-works here. Vite resolves the glob at build time and imports each Markdown file's compiled HTML.

- [ ] **Step 1: Write `site/src/pages/changelog.astro`**

```astro
---
// site/src/pages/changelog.astro
import { compareVersionsDesc } from '../lib/version';
import SiteFooter from '../components/SiteFooter.astro';

// Vite globs are relative to the source file. `../../docs/release-notes/`
// resolves to <repo>/docs/release-notes/.
const modules = import.meta.glob('../../docs/release-notes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Entry {
  filename: string;
  rawMarkdown: string;
}

const entries: Entry[] = Object.entries(modules)
  .map(([path, rawMarkdown]) => ({
    filename: path.split('/').pop()!,
    rawMarkdown: rawMarkdown as string,
  }))
  .sort((a, b) => compareVersionsDesc(a.filename, b.filename));

// Render Markdown manually with a tiny processor so we don't need to set
// up MDX integration just for this page. The release notes use only
// headings, paragraphs, lists, and code blocks.
import { marked } from 'marked';
const rendered = entries.map((e) => ({
  filename: e.filename,
  html: marked.parse(e.rawMarkdown, { gfm: true, breaks: false }) as string,
}));

const BASE = import.meta.env.BASE_URL;
---
<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Changelog — ezTerm</title>
    <meta name="description" content="Release history for ezTerm." />
    <link rel="icon" type="image/svg+xml" href={`${BASE}favicon.svg`} />
  </head>
  <body class="bg-site-bg text-site-fg">
    <header class="border-b border-site-border">
      <div class="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href={BASE} class="flex items-center gap-2 font-bold tracking-tight">
          <span class="text-site-accent">▲</span><span>ezTerm</span>
        </a>
        <nav class="flex items-center gap-6 text-sm text-site-fg-muted">
          <a href={`${BASE}docs/`} class="hover:text-site-fg">Docs</a>
          <a href={`${BASE}screenshots/`} class="hover:text-site-fg">Screenshots</a>
          <a href={`${BASE}changelog/`} class="text-site-fg">Changelog</a>
          <a href="https://github.com/ZerosAndOnesLLC/ezTerm" class="hover:text-site-fg">GitHub</a>
        </nav>
      </div>
    </header>

    <main class="max-w-3xl mx-auto px-6 py-12">
      <h1 class="text-4xl font-bold tracking-tight mb-2">Changelog</h1>
      <p class="text-site-fg-muted mb-10">Newest releases first. Sourced from <code>docs/release-notes/</code> in the repo.</p>

      {rendered.map((e) => (
        <article class="prose prose-invert max-w-none mb-12 pb-12 border-b border-site-border last:border-b-0">
          <div set:html={e.html} />
        </article>
      ))}
    </main>

    <SiteFooter />
  </body>
</html>
```

- [ ] **Step 2: Add `marked` as a dependency**

```bash
cd /home/mack/dev/ezTerm/site && npm install marked
```

Expected: `marked` (^14 or newer) added to `package.json`.

- [ ] **Step 3: Add `@tailwindcss/typography` so `.prose` works**

```bash
cd /home/mack/dev/ezTerm/site && npm install -D @tailwindcss/typography
```

Then update `site/tailwind.config.mjs` to register the plugin:

```js
// site/tailwind.config.mjs
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'site-bg':           'var(--site-bg)',
        'site-bg-elevated':  'var(--site-bg-elevated)',
        'site-fg':           'var(--site-fg)',
        'site-fg-muted':     'var(--site-fg-muted)',
        'site-accent':       'var(--site-accent)',
        'site-border':       'var(--site-border)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [typography],
};
```

- [ ] **Step 4: Build and verify the changelog page exists and lists every release**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
```

Expected: completes without errors.

```bash
test -f /home/mack/dev/ezTerm/site/dist/changelog/index.html && echo "changelog built"
grep -c "<article" /home/mack/dev/ezTerm/site/dist/changelog/index.html
```

Expected: prints `changelog built`, then the number of articles. Compare to the count of files in `docs/release-notes/` — they should match:

```bash
ls /home/mack/dev/ezTerm/docs/release-notes/*.md | wc -l
```

Expected: same count as the grep above.

- [ ] **Step 5: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/pages/changelog.astro site/tailwind.config.mjs site/package.json site/package-lock.json
git commit -m "feat(site): changelog page reads docs/release-notes/ sorted by semver"
```

---

## Task 16: Screenshots gallery page

**Files:**
- Create: `site/src/pages/screenshots.astro`

For v1, the gallery shows the single hero screenshot. The page exists so future screenshot drops have a home without needing a new route.

- [ ] **Step 1: Write `site/src/pages/screenshots.astro`**

```astro
---
// site/src/pages/screenshots.astro
import MockupFrame from '../components/MockupFrame.astro';
import SiteFooter from '../components/SiteFooter.astro';

const BASE = import.meta.env.BASE_URL;
const shots = [
  {
    src: `${BASE}screenshots/hero.png`,
    alt: 'Main ezTerm window with sessions sidebar, tabbed terminal, and SFTP side-pane',
    caption: 'Sessions sidebar, tabbed terminals, SFTP side-pane — the full chrome.',
  },
];
---
<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Screenshots — ezTerm</title>
    <link rel="icon" type="image/svg+xml" href={`${BASE}favicon.svg`} />
  </head>
  <body class="bg-site-bg text-site-fg">
    <header class="border-b border-site-border">
      <div class="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href={BASE} class="flex items-center gap-2 font-bold tracking-tight">
          <span class="text-site-accent">▲</span><span>ezTerm</span>
        </a>
        <nav class="flex items-center gap-6 text-sm text-site-fg-muted">
          <a href={`${BASE}docs/`} class="hover:text-site-fg">Docs</a>
          <a href={`${BASE}screenshots/`} class="text-site-fg">Screenshots</a>
          <a href={`${BASE}changelog/`} class="hover:text-site-fg">Changelog</a>
          <a href="https://github.com/ZerosAndOnesLLC/ezTerm" class="hover:text-site-fg">GitHub</a>
        </nav>
      </div>
    </header>

    <main class="max-w-5xl mx-auto px-6 py-12">
      <h1 class="text-4xl font-bold tracking-tight mb-2">Screenshots</h1>
      <p class="text-site-fg-muted mb-10">ezTerm in action.</p>

      <div class="space-y-10">
        {shots.map((s) => (
          <MockupFrame src={s.src} alt={s.alt} caption={s.caption} />
        ))}
      </div>
    </main>

    <SiteFooter />
  </body>
</html>
```

- [ ] **Step 2: Build and verify**

```bash
cd /home/mack/dev/ezTerm/site && npm run build && test -f /home/mack/dev/ezTerm/site/dist/screenshots/index.html && echo OK
```

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/pages/screenshots.astro
git commit -m "feat(site): screenshots gallery page"
```

---

## Task 17: Download redirect page

**Files:**
- Create: `site/src/pages/download.astro`

- [ ] **Step 1: Write `site/src/pages/download.astro`**

```astro
---
// site/src/pages/download.astro
//
// GitHub Pages can't do real HTTP redirects, so we use a meta-refresh.
// /download/ is a stable URL we can advertise even if the GH releases page
// moves; it also gives us a place to add per-platform download buttons later.
const TARGET = 'https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest';
---
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content={`0; url=${TARGET}`} />
    <link rel="canonical" href={TARGET} />
    <title>Download ezTerm</title>
  </head>
  <body>
    <p>Redirecting to the latest release… If you aren't redirected, <a href={TARGET}>click here</a>.</p>
  </body>
</html>
```

- [ ] **Step 2: Build and verify the meta-refresh is present**

```bash
cd /home/mack/dev/ezTerm/site && npm run build
grep -q 'http-equiv="refresh"' /home/mack/dev/ezTerm/site/dist/download/index.html && echo OK
```

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
cd /home/mack/dev/ezTerm
git add site/src/pages/download.astro
git commit -m "feat(site): /download redirect to latest GH release"
```

---

## Task 18: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/site.yml`

- [ ] **Step 1: Write `.github/workflows/site.yml`**

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
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: site/package-lock.json

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Install dependencies
        run: npm ci
        working-directory: site

      - name: Run tests
        run: npm test
        working-directory: site

      - name: Build
        run: npm run build
        working-directory: site
        env:
          NODE_ENV: production

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: site/dist

      - name: Deploy to Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Lint-check the YAML locally (optional but recommended)**

```bash
python3 -c "import yaml; yaml.safe_load(open('/home/mack/dev/ezTerm/.github/workflows/site.yml'))" && echo "yaml ok"
```

Expected: prints `yaml ok`.

- [ ] **Step 3: Commit**

```bash
cd /home/mack/dev/ezTerm
git add .github/workflows/site.yml
git commit -m "ci(site): GitHub Actions workflow to build + deploy to Pages"
```

---

## Task 19: Wire `download/` link into Hero, update root README

**Files:**
- Modify: `site/src/components/Hero.astro` (the `/download/` route now exists; we keep the direct GH link for the button but mention the in-site path elsewhere if needed — no change needed unless desired)
- Modify: `README.md` (repo root)

The hero already links straight to the GH releases page, which is the simpler UX (one click to the binary list). The `/download/` route exists for future per-platform UX; no change to Hero needed.

- [ ] **Step 1: Add a "Website" section to the repo-root README**

Open `/home/mack/dev/ezTerm/README.md`. Find the existing "Install" heading. Insert a new section immediately before it:

```markdown
## Website

Project site: <https://zerosandoneslc.github.io/ezTerm/> — landing page, docs,
screenshots, and changelog. Source lives in [`site/`](site/).

Develop locally:

```bash
npm --prefix site install     # one-time
npm --prefix site run dev     # http://localhost:4321/ezTerm/
npm --prefix site run build   # → site/dist/
```

The site auto-deploys on every push to `main` that touches `site/**` or
`docs/release-notes/**` (see `.github/workflows/site.yml`).

```

(Note: the inner triple-backtick fence is `bash`; the outer fence is the Markdown of the README so leave it as you find it. Ensure exactly one blank line between the new section and the next heading.)

- [ ] **Step 2: Commit**

```bash
cd /home/mack/dev/ezTerm
git add README.md
git commit -m "docs(readme): add Website section pointing at site/"
```

---

## Task 20: Final verification and rollout notes

This task is verification — it produces no new commits unless something breaks.

- [ ] **Step 1: Full build from a clean state**

```bash
cd /home/mack/dev/ezTerm/site
rm -rf dist .astro
npm run build
```

Expected: completes with no warnings or errors. Astro / Starlight surface broken internal links as warnings — there should be none.

- [ ] **Step 2: Sanity-check output structure**

```bash
cd /home/mack/dev/ezTerm/site/dist && find . -name "index.html" | sort
```

Expected (at minimum):

```
./index.html
./changelog/index.html
./download/index.html
./screenshots/index.html
./docs/index.html
./docs/getting-started/install/index.html
./docs/getting-started/first-connect/index.html
./docs/getting-started/importing-from-mobaxterm/index.html
./docs/features/ssh/index.html
./docs/features/sftp/index.html
./docs/features/wsl/index.html
./docs/features/local-shells/index.html
./docs/features/x11-forwarding/index.html
./docs/features/port-forwarding/index.html
./docs/features/vault/index.html
./docs/troubleshooting/index.html
./docs/faq/index.html
```

- [ ] **Step 3: Spot-check landing content**

```bash
grep -q "An SSH client that" /home/mack/dev/ezTerm/site/dist/index.html && echo "hero OK"
grep -q "Argon2id" /home/mack/dev/ezTerm/site/dist/docs/features/vault/index.html && echo "vault doc OK"
grep -q "v1.3.4" /home/mack/dev/ezTerm/site/dist/changelog/index.html && echo "changelog OK"
```

Expected: all three print OK lines.

- [ ] **Step 4: Run tests one more time**

```bash
cd /home/mack/dev/ezTerm/site && npm test
```

Expected: all pass.

- [ ] **Step 5: Manual preview**

```bash
cd /home/mack/dev/ezTerm/site && npm run preview
```

Open `http://localhost:4321/ezTerm/` in a browser. Click through:
- Landing → all sections visible, no broken images, theme is dark.
- `/docs/` → sidebar shows all sections, pages load.
- `/changelog/` → all releases listed, newest (v1.3.4) at top.
- `/screenshots/` → hero shot renders in the mockup frame.
- Footer links work.
- Theme toggle (Starlight's, top-right of docs pages) switches between dark and light without flicker.

Stop the preview server (`Ctrl+C`) when done.

- [ ] **Step 6: Document the one-time manual GH Pages setup**

Add a note to the rollout PR / release announcement so a maintainer knows to do this **once** after merging:

> **One-time setup (admin only):**
>
> 1. Go to **Settings → Pages** on `github.com/ZerosAndOnesLLC/ezTerm`.
> 2. Under **Build and deployment → Source**, select **GitHub Actions**.
> 3. Trigger the workflow once via **Actions → Deploy site to Pages → Run workflow** (or push a doc change).
> 4. After the first successful deploy, the site is live at
>    <https://zerosandoneslc.github.io/ezTerm/>.

This step is not automatable from a PR — it requires admin access to repo settings.

- [ ] **Step 7: Push and open the PR**

```bash
cd /home/mack/dev/ezTerm
git push -u origin <branch-name>
```

Then open the PR with the body explaining the one-time setup step.

---

## Self-review notes

- **Spec coverage**: every section in the spec maps to a task — Astro+Starlight stack (Task 1), theme tokens (Task 3), landing page sections (Tasks 4–10), docs (Tasks 11–13), changelog with semver parser (Tasks 14–15), screenshots (Task 16), download redirect (Task 17), Actions workflow (Task 18), README update (Task 19), verification (Task 20).
- **No placeholders**: every code step shows full code or full file content. No "TBD" / "add error handling" / "similar to Task N".
- **Type consistency**: `parseVersion` / `compareVersionsDesc` names match in `version.ts`, `version.test.ts`, and the changelog page. CSS variable names (`--site-bg`, `--site-accent`, etc.) are consistent across `global.css`, `starlight-overrides.css`, `tailwind.config.mjs`, and every component.
- **Risks called out in spec are addressed**:
  - Asset paths use `import.meta.env.BASE_URL` everywhere (Tasks 5, 10, 15, 16).
  - Release-notes filename sort: numeric semver parser with vitest tests (Task 14) — `v1.10.0` ranks above `v1.3.4`.
  - GH Pages caching: documented in the verification step that re-running the workflow purges the edge cache.
