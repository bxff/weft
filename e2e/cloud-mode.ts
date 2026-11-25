/**
 * Shared setup for specs run against the cloud topology. useCloudMode() flips
 * the SPA into cloud mode signed in as the seeded dev user and attaches that
 * user's dev bearer to raw page.request API probes. Cloud + seeded store come
 * from scripts/e2e-serve.ts (the Playwright webServer); the bearer is scoped
 * per-spec (test.use) so cloud.spec / clerk.spec are untouched.
 */
import { test } from '@playwright/test'

export const E2E_USER = 'e2e'
export const CLOUD_ORIGIN = 'http://localhost:9100'

/**
 * Flip the SPA into cloud mode signed in as the dev user. Op-mode (the
 * commutative op channel) is the sole web sync path — the blob-CAS kill-switch
 * was removed pre-launch, so there is nothing to select.
 */
export function useCloudMode(): void {
    test.use({ extraHTTPHeaders: { authorization: `Bearer dev:${E2E_USER}` } })
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(
            ([url, user]) => {
                // weft-server-url is the cloud-url override read by settings.ts
                localStorage.setItem('weft-server-url', url!)
                localStorage.setItem('weft-dev-user', user!)
                // empty clerk pk disables Clerk so the dev-token path is used
                // (the build bakes in a real pk; this runtime override turns it off)
                localStorage.setItem('weft-clerk-pk', '')
                localStorage.removeItem('weft-docs-cache')
            },
            [CLOUD_ORIGIN, E2E_USER],
        )
    })
}
