import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  target: 'node20',
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['canvas', 'jsdom'],
});
