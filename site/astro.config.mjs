// site/astro.config.mjs
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({
  site: 'https://zerosandonesllc.github.io',
  base: '/ezTerm/',
  trailingSlash: 'ignore',
  vite: {
    plugins: [tailwindcss()],
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
  },
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
          items: [{ autogenerate: { directory: 'docs/features' } }],
        },
        { label: 'Troubleshooting', link: '/docs/troubleshooting/' },
        { label: 'FAQ', link: '/docs/faq/' },
      ],
    }),
  ],
});
