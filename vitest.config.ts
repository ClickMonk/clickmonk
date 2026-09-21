import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Test files share one Postgres and one ClickHouse and reset them in
    // beforeAll. Files must run one at a time or they delete each other's
    // fixtures mid-assertion. This orders files within a run; nothing
    // coordinates two separate runs, so never run two at once.
    fileParallelism: false,
  },
})
