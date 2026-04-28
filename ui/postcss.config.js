// Tailwind v4 provides its own PostCSS plugin out-of-band. Autoprefixer
// is retained so any generated utility that needs vendor prefixes still
// gets them — Tailwind itself produces clean modern CSS, but the
// `@apply`-driven utility classes in globals.css can still benefit.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};

export default config;
