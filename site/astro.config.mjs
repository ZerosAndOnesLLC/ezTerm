// site/astro.config.mjs
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({
  site: 'https://ezterm.zerosandones.us',
  trailingSlash: 'ignore',
  vite: {
    plugins: [tailwindcss()],
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
    build: {
      // Don't inline assets as data: URIs — @fontsource ships small woff
      // fallbacks that get base64-embedded under the default 4KB threshold,
      // which defeats HTTP caching and bloats the page CSS by 4–8 KB each.
      assetsInlineLimit: 0,
    },
  },
  integrations: [
    starlight({
      title: 'ezTerm',
      logo: {
        src: './src/assets/ezterm-icon.png',
      },
      components: {
        Head: './src/components/starlight/Head.astro',
      },
      customCss: [
        '@fontsource/inter/400.css',
        '@fontsource/inter/600.css',
        '@fontsource/inter/700.css',
        '@fontsource/jetbrains-mono/400.css',
        '@fontsource/jetbrains-mono/600.css',
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
          items: [{ autogenerate: { directory: 'docs/features' } }],
        },
        { label: 'Troubleshooting', link: '/docs/troubleshooting/' },
        { label: 'FAQ', link: '/docs/faq/' },
      ],
    }),
  ],
});
