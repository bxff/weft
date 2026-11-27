/// <reference lib="webworker" />
import { base, build, files, version } from '$service-worker'

const worker = self as unknown as ServiceWorkerGlobalScope
const cachePrefix = `weft-shell:${worker.registration.scope}:`
const cacheName = cachePrefix + version
const shell = `${base}/app/shell/shell.html`
const cleanShell = `${base}/app/shell/shell`
const environment = `${base}/_app/env.js`
const immutable = new Set(build.filter((path) => path.startsWith(`${base}/_app/immutable/`)))
const fonts = files.filter((path) => path.startsWith(`${base}/fonts/`) && /\.(?:[ot]tf|woff2?)$/.test(path))
const publicAssets = new Set([environment, ...immutable, ...fonts])

async function fetchPublicFile(path: string, alreadyRequested = false): Promise<Response> {
    const cache = alreadyRequested || immutable.has(path) ? 'force-cache'
        : path === shell || path === environment ? 'reload' : 'default'
    const options: RequestInit = { credentials: 'omit', redirect: 'error', cache }
    let response: Response
    try {
        response = await fetch(path, options)
    } catch (error) {
        if (path !== shell) throw error
        // Pages redirects .html URLs. Fetch the known same-origin clean URL
        // directly so the cached response itself isn't a redirected response.
        response = await fetch(cleanShell, options)
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim()
    const usable = path === shell ? type === 'text/html'
        : /\.m?js$/.test(path) ? /^(?:text|application)\/(?:java|ecma)script$/.test(type ?? '')
        : path.endsWith('.css') ? type === 'text/css' : !!type && type !== 'text/html'
    const sensitive = /(?:no-store|private)/i.test(response.headers.get('cache-control') ?? '') ||
        /(?:^|,\s*)(?:cookie|authorization|\*)(?:\s*,|$)/i.test(response.headers.get('vary') ?? '')
    if (!response.ok || !usable || sensitive) {
        throw new Error(`Unavailable public editor asset: ${path}`)
    }
    return response
}

worker.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const html = await fetchPublicFile(shell)
        const source = await html.clone().text()
        const matchesBuild = ['start', 'app'].every((name) => {
            const entry = build.find((path) => path.startsWith(`${base}/_app/immutable/entry/${name}.`))
            return entry && source.includes(entry.slice(entry.lastIndexOf('/') + 1))
        })
        if (!matchesBuild) {
            throw new Error('The notebook shell and editor assets are from different builds')
        }
        const cache = await caches.open(cacheName)
        await cache.put(environment, await fetchPublicFile(environment))
        await cache.put(shell, html)
    })())
})

worker.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key.startsWith(cachePrefix) && key !== cacheName) await caches.delete(key)
        }
        await worker.clients.claim()
    })())
})

async function cached(path: string): Promise<Response | undefined> {
    return (await caches.open(cacheName)).match(path)
}

// Write a public asset at most once even if the first visit report and a
// controlled fetch coincide. The caller can still consume the response.
const loading = new Map<string, Promise<Response>>()
async function cacheAsset(path: string, alreadyRequested = false): Promise<Response> {
    let pending = loading.get(path)
    if (!pending) {
        pending = (async () => {
            const cache = await caches.open(cacheName)
            const prior = await cache.match(path)
            if (prior) return prior
            const response = await fetchPublicFile(path, alreadyRequested)
            await cache.put(path, response.clone()).catch(() => {})
            return response
        })()
        loading.set(path, pending)
        void pending.finally(() => loading.delete(path)).catch(() => {})
    }
    return (await pending).clone()
}

let warmQueue = Promise.resolve()
worker.addEventListener('message', (event) => {
    const message = event.data as { type?: unknown; paths?: unknown } | null
    if (message?.type !== 'cache-notebook-assets' || !Array.isArray(message.paths)) return
    const paths = [...new Set(message.paths.filter((path): path is string =>
        typeof path === 'string' && publicAssets.has(path),
    ))]
    // Warm the public resources fetched before the first worker took control.
    // Reuse HTTP-cache bytes downloaded by that visit when available.
    warmQueue = warmQueue.then(async () => {
        for (let offset = 0; offset < paths.length; offset += 3) {
            await Promise.allSettled(paths.slice(offset, offset + 3).map(path => cacheAsset(path, true)))
        }
    })
    event.waitUntil(warmQueue)
})

worker.addEventListener('fetch', (event) => {
    const { request } = event
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.origin !== worker.location.origin) return

    if (request.mode === 'navigate' && url.pathname.startsWith(`${base}/app/`) &&
        /^\/app\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname.slice(base.length))) {
        // A worker-forwarded reload can lose the navigation headers that
        // the relay uses to distinguish notebook routes from asset requests.
        // This public shell serves the same notebook route in either case.
        event.respondWith((async () => {
            try {
                const response = await fetch(request)
                if (response.status !== 404) return response
                return (await cached(shell)) ?? response
            } catch {
                return (await cached(shell)) ?? Response.error()
            }
        })())
    } else if (!url.search && publicAssets.has(url.pathname)) {
        event.respondWith(cacheAsset(url.pathname).catch(() => fetch(request)))
    }
})
