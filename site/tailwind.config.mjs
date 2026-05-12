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
