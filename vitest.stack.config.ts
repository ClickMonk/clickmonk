import { defineConfig } from 'vitest/config'

// The suites that drive the whole Compose stack, separate from
// vitest.durability.config.ts because both call `down -v` and this one binds
// 80 and 443 while that one binds 8080 and 8123. Two of them at once on one
// machine is not a slow test, it is a pair of failures that read as broken
// code.
//
// `test/stack/*.test.ts`, so a new suite in that directory belongs to this
// job rather than to none. The durability config's `test/*.test.ts` does not
// reach into this directory.
export default defineConfig({
  test: {
    include: ['test/stack/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
