import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { readRuntime, runtimeDir } from './scripts/e2e/runtime.mjs'

const runtime = readRuntime()

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 3000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: '.e2e/results.json' }]],
  use: {
    baseURL: runtime.appUrl,
    // Match the app server's calendar date, including Swedish midnight.
    timezoneId: 'Europe/Stockholm',
    storageState: path.join(runtimeDir, 'auth.json'),
    actionTimeout: 3000,
    navigationTimeout: 5000,
    // Full-DOM trace snapshots serialize thousands of expanded ledger rows
    // inside timed actions. Keep action traces and failure screenshots
    // without adding diagnostic DOM-copy work to user-facing latency budgets.
    trace: { mode: 'retain-on-failure', snapshots: false },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'startup', testMatch: '**/startup.spec.mts', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop', dependencies: ['startup'], testIgnore: '**/startup.spec.mts', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', dependencies: ['startup'], testIgnore: '**/startup.spec.mts', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node scripts/e2e/run.mjs serve',
    url: `${runtime.appUrl}/api/health`,
    timeout: 30_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    stdout: 'pipe', stderr: 'pipe',
  },
})
