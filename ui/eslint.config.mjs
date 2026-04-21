// Flat-config port of the old `.eslintrc.json` (which was
// `{ "extends": "next/core-web-vitals" }`). ESLint 9+ and Next 16's
// eslint-config-next require flat-config; `next lint` is gone in
// Next 16 so `npm run lint` now invokes `eslint` directly.

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  {
    ignores: [
      '.next/**',
      'out/**',
      'node_modules/**',
      '**/*.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // React 19's new rule flags any setState reached from an effect
      // body, including the very common "fetch-then-setState" pattern
      // we use for polling sync status, loading persisted state after
      // a prop change, and SFTP refresh. Demote to warn — the cases
      // that aren't false positives still surface during review.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];

export default config;
