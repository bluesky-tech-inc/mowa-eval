import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli/index.ts', index: 'src/core/index.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: { entry: { index: 'src/core/index.ts' } },
  banner: { js: '#!/usr/bin/env node' },
})
