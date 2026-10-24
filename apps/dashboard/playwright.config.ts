import { defineConfig, devices } from '@playwright/test'

/**
 * E2E config for a deliberately provisioned disposable stack (API + dashboard).
 * Never default to a hosted deployment: these scenarios create and update data.
 */
const base = process.env.BASE_URL
if (!base) throw new Error('Set BASE_URL to the explicitly provisioned disposable E2E stack')
let target: URL
try {
  target = new URL(base)
} catch {
  throw new Error('BASE_URL must be an absolute disposable test origin')
}
const safeHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'chorala-test-edge'])
if (
  !safeHosts.has(target.hostname) ||
  !['http:', 'https:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.pathname !== '/' ||
  target.search ||
  target.hash
) {
  throw new Error('BASE_URL must be a root HTTP(S) origin on loopback or chorala-test-edge')
}
if (!process.env.E2E_ADMIN_EMAIL || !process.env.E2E_ADMIN_PASSWORD) {
  throw new Error('Set explicit E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for the disposable fixture')
}

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: target.origin,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
