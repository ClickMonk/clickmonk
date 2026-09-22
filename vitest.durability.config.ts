import { defineConfig } from 'vitest/config'

// Separate from vitest.config.ts so plain `pnpm test` never starts Docker.
// It selects test/*.test.ts rather than naming this one file, so a new suite
// under test/ belongs to this job automatically instead of to no job at all.
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
