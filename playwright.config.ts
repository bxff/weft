import { defineConfig } from '@playwright/test'

/**
 * E2E against a real browser in the production topology (no tablet): the
 * weft-cloud server serves the built SPA + device-protocol API single-origin,
 * and rmsyncd (sync agent) pushes a synthetic store into it. Orchestrated by
 * scripts/e2e-serve.ts, which opens the readiness port only once the store has
 * fully seeded.
 */
export default defineConfig({
    testDir: 'e2e',
    timeout: 60_000,
    retries: 0,
    use: {
        baseURL: 'http://localhost:9100',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: {
        // absolute bun path: Playwright's spawned /bin/sh may not have it on PATH
        command: '"$HOME/.bun/bin/bun" scripts/e2e-serve.ts',
        url: 'http://localhost:9101',
        reuseExistingServer: false,
        timeout: 60_000,
    },
})
