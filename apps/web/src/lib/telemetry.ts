/**
 * Browser crash reporter for GlitchTip (Sentry store API). Reports uncaught
 * exceptions and unhandled rejections. DSN is baked at build time via
 * PUBLIC_SENTRY_DSN (a DSN is a public key by design); unset = inert.
 * Fire-and-forget, deduped per session so an error loop can't spam.
 */
import { env } from '$env/dynamic/public'

const dsn = env.PUBLIC_SENTRY_DSN
const target = (() => {
    if (!dsn) return null
    try {
        const u = new URL(dsn)
        const projectId = u.pathname.replace(/^\//, '')
        if (!u.username || !projectId) return null
        return {
            url: `${u.protocol}//${u.host}/api/${projectId}/store/`,
            auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=weft-web/1`,
        }
    } catch {
        return null
    }
})()

const seen = new Set<string>()

export function reportError(e: unknown, origin: string): void {
    if (!target) return
    const err = e instanceof Error ? e : new Error(String(e))
    const key = `${err.name}|${err.message}`
    if (seen.has(key) || seen.size > 50) return
    seen.add(key)
    void fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sentry-auth': target.auth },
        body: JSON.stringify({
            platform: 'javascript',
            level: 'error',
            logger: 'weft-web',
            exception: {
                values: [
                    {
                        type: err.name,
                        value: err.message,
                        stacktrace: {
                            frames: (err.stack ?? '')
                                .split('\n')
                                .slice(1, 21)
                                .map((l) => ({ function: l.trim() }))
                                .reverse(),
                        },
                    },
                ],
            },
            tags: { origin },
            request: { url: location.href.split('?')[0] },
            timestamp: Date.now() / 1000,
        }),
    }).catch(() => {})
}

/** Install once from the root layout. */
export function installGlobalHandlers(): void {
    if (!target) return
    window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message, 'window.onerror'))
    window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'unhandledrejection'))
}
