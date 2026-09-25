import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The interface has its own vitest config (jsdom, a setup file, TZ) and
    // its own `pnpm test` step, chained after this one at the root. Without
    // this exclude, this glob would also match its plain `.ts` tests and run
    // them a second time, in Node rather than jsdom and without the setup.
    exclude: [...configDefaults.exclude, 'packages/ui/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Test files share one Postgres and one ClickHouse and reset them in
    // beforeAll. Files must run one at a time or they delete each other's
    // fixtures mid-assertion. This orders files within a run; nothing
    // coordinates two separate runs, so never run two at once.
    fileParallelism: false,
  },
})
