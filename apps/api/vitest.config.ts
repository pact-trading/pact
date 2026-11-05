import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// SDK packages are consumed from source in tests, so no package build is needed first.
const pkg = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pactagent\/core$/, replacement: pkg('core/src/index.ts') },
      { find: /^@pactagent\/core\/(.*)$/, replacement: pkg('core/src/$1.ts') },
      { find: /^@pactagent\/node$/, replacement: pkg('node/src/index.ts') },
    ],
  },
});
