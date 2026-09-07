import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests for the OrcSpace desktop app.
 *
 * There is no webServer here: each test launches its own Electron instance via
 * `_electron.launch` (see `e2e/helpers/app.ts`) against the built output in
 * `out/` with a throwaway `--user-data-dir` profile and free MCP/control ports,
 * so runs are hermetic and parallel-safe.
 *
 * Two projects:
 *  - `local` — for day-to-day `npm run test:e2e`. No retries, trace kept on
 *    failure so a local flake is debuggable right away.
 *  - `ci`    — used by the e2e workflow. Two retries and a trace captured on the
 *    first retry, plus screenshots on failure for the uploaded report.
 *
 * Electron is launched "headful" by design — the canvas is a real GPU-backed
 * window. `--disable-gpu` (passed in the helper) keeps CI green without a GPU.
 */
const isCi = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  // Each worker owns a whole Electron app plus its bundled MCP child; more than
  // one at a time is a lot of node-pty/conpty instances on a dev machine.
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: isCi
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    trace: isCi ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'local', retries: 0 },
    { name: 'ci', retries: 2 },
    {
      name: 'ink',
      testMatch: '**/*.spec.ts',
      use: {
        ...use,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        hasTouch: true,
      },
    },
    {
      name: 'min',
      testMatch: '**/*.spec.ts',
      use: {
        ...use,
        viewport: { width: 800, height: 560 },
      },
    },
  ]
})