import type { Config } from 'tailwindcss';

/*
 * Tailwind config is intentionally minimal; the design system lives in CSS
 * variables (see ui/app/globals.css and docs/design/design-system.md).
 *
 * Variable names are fixed — components from Plan 1 Tasks 15-17 reference
 * them (bg, surface, surface2, border, fg, muted, accent). New semantic
 * tokens (success, warning, danger, selection) are added; do NOT rename.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg:        'rgb(var(--bg) / <alpha-value>)',
        surface:   'rgb(var(--surface) / <alpha-value>)',
        surface2:  'rgb(var(--surface-2) / <alpha-value>)',
        border:    'rgb(var(--border) / <alpha-value>)',
        fg:        'rgb(var(--fg) / <alpha-value>)',
        muted:     'rgb(var(--muted) / <alpha-value>)',
        accent:    'rgb(var(--accent) / <alpha-value>)',
        success:   'rgb(var(--success) / <alpha-value>)',
        warning:   'rgb(var(--warning) / <alpha-value>)',
        danger:    'rgb(var(--danger) / <alpha-value>)',
        selection: 'rgb(var(--selection) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          "'Segoe UI Variable'",
          "'Segoe UI'",
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: [
          "'Cascadia Mono'",
          "'Consolas'",
          'ui-monospace',
          'monospace',
        ],
      },
      borderRadius: {
        // Windows-native: sharp or very subtle.
        DEFAULT: '2px',
        sm: '2px',
        md: '3px',
        lg: '4px',
      },
      fontSize: {
        // Match design-system.md §3.
        xs: ['11px', '1.3'],
        sm: ['12px', '1.3'],
        base: ['13px', '1.4'],
        md: ['14px', '1.3'],
        lg: ['15px', '1.3'],
      },
      boxShadow: {
        // Subtle dropdown / context-menu elevation; no macOS-style blur.
        menu: '0 4px 12px rgba(0, 0, 0, 0.35)',
        dialog: '0 8px 24px rgba(0, 0, 0, 0.45)',
      },
      transitionDuration: {
        fast: '80ms',
        DEFAULT: '120ms',
      },
    },
  },
  plugins: [],
};
export default config;
