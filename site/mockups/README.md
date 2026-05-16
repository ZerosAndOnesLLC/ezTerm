# site/mockups/

Design-iteration scaffolds for the ezTerm marketing site. **Not deployed.**
Astro only serves `src/pages/*` and `public/*`, so these standalone HTML files
ride along in the repo but never reach `ezterm.zerosandones.us`.

## What's here

| Path | Direction |
|---|---|
| `option-1-terminal/` | Terminal-native — dark, monospace, animated terminal hero |
| `option-2-saas/` | Modern SaaS minimal — Linear/Vercel/Resend aesthetic |
| `option-3-brand/` | Brand-forward vibrant — oversized gradient wordmark + glow |
| `option-mix/` | The 1+3 mix that shipped — option 3's foundation with option 1's animated terminal slotted in |
| `index.html` | Side-by-side picker for previewing the four directions |

The mix variant (`option-mix/`) is the design that became `src/pages/index.astro`.
The other three exist as reference if you want to revisit a different direction.

## Previewing locally

```bash
cd site
python3 -m http.server 8000
# open http://localhost:8000/mockups/
```

Images load via `../../public/screenshots/*.png`, so serve from `site/` (not from `mockups/`).
