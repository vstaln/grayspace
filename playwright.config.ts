import { defineConfig } from '@playwright/test'

const isCi = Boolean(process.env.CI)
const baseUse = {
  trace: isCi ? 'on-first-retry' : 'retain-on-failure',
  screenshot: 'only-on-failure'
} as const

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: isCi
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: baseUse,
  projects: [
    { name: 'local', retries: 0 },
    { name: 'ci', retries: 2 },
    {
      name: 'ink',
      testMatch: '**/*.spec.ts',
      use: {
        ...baseUse,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        hasTouch: true,
      },
    },
    {
      name: 'min',
      testMatch: '**/*.spec.ts',
      use: {
        ...baseUse,
        viewport: { width: 800, height: 560 },
      },
    },
  ]
})
