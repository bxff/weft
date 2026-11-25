// bun apps/web/bench/cold.ts after building the production app.
// Fresh Chromium profiles, a public fixture and loopback only. Stock receives
// the same freehand records and camera, with the original SDK ink renderer.
// The stock server uses the encodings observed on the local relay.
// The relay is seeded before measurement. Each browser profile starts cold.
// Ink readiness means an editable editor with visible ink, then two frames.
import type {} from './cold-control'
import { installVisibleInkProbe } from './visible-ink'
import { chromium, type Browser } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { brotliCompressSync, createBrotliCompress, createGzip, gzipSync, constants as zlib } from 'node:zlib'
import type { CloudServer } from '../../cloud/src/server'

async function main(): Promise<void> {
    const runs = Number(process.env.WEFT_BENCH_RUNS ?? 5)
    if (!Number.isInteger(runs) || runs < 1) throw new Error('WEFT_BENCH_RUNS must be a positive integer')
    const dir = process.env.WEFT_BENCH_BUILD_DIR ?? 'apps/web/build'
    if (!await Bun.file(dir + '/index.html').exists()) throw new Error('Build the production web app first')
    const bundle = await Bun.build({ entrypoints: ['apps/web/bench/cold-control.tsx'], target: 'browser', minify: true,
        define: { 'process.env.NODE_ENV': '"production"' } })
    if (!bundle.success) throw new Error(bundle.logs.join('\n'))
    type Coding = 'identity' | 'br' | 'gzip'
    const coding: Record<'html' | 'js' | 'css' | 'drawing', Coding> = {
        html: 'identity', js: 'identity', css: 'identity', drawing: 'identity',
    }
    const files = new Map<string, { bytes: Uint8Array<ArrayBuffer> | string; type: string; encoding?: Coding }>()
    function add(path: string, data: Uint8Array | string, type: string) {
        files.set(path, { bytes: data, type })
    }
    for (const file of bundle.outputs) add('/' + file.path.split('/').at(-1), new Uint8Array(await file.arrayBuffer()), file.type)
    add('/', '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="/cold-control.css"><div id="canvas" style="position:fixed;inset:0"></div><script>window.coldMaterial=fetch("/drawing.json").then(r=>r.json())</script><script type="module" src="/cold-control.js"></script>', 'text/html')

    function sdkAsset(path: string): Response | null {
        const file = path.match(/^\/sdk\/((?:fonts|translations|embed-icons)\/[\w.-]+\.(?:woff2|json|png|svg)|icons\/icon\/0_merged\.svg)$/)?.[1]
        return file ? new Response(Bun.file(join('apps/web/node_modules/@tldraw/assets', file))) : null
    }
    let stock: ReturnType<typeof Bun.serve> | undefined
    let cloud: CloudServer | undefined
    let browser: Browser | undefined
    let temp: string | undefined
    const previousTmp = process.env.TMPDIR
    try {
        const control = stock = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
            const path = new URL(req.url).pathname
            const built = files.get(path)
            if (built) {
                const headers = new Headers({ 'content-type': built.type })
                if (path === '/drawing.json' && coding.drawing !== 'identity') {
                    headers.set('content-encoding', coding.drawing)
                    const compressor = coding.drawing === 'br'
                        ? createBrotliCompress({ params: { [zlib.BROTLI_PARAM_QUALITY]: 2 } })
                        : createGzip({ level: zlib.Z_BEST_SPEED })
                    const stream = Readable.from([built.bytes]).pipe(compressor)
                    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers })
                }
                if (built.encoding) headers.set('content-encoding', built.encoding)
                return new Response(built.bytes, { headers })
            }
            return sdkAsset(path) ?? new Response(null, { status: 404 })
        } })
        // Do not inherit deployment credentials, telemetry, backups, or quota settings.
        for (const key of Object.keys(process.env)) {
            if (key === 'SENTRY_DSN' || key.startsWith('CLERK_') ||
                (key.startsWith('WEFT_') && !key.startsWith('WEFT_BENCH_'))) delete process.env[key]
        }
        process.env.HOST = '127.0.0.1'
        process.env.CLOUD_DEV_USER = '1'
        const { startCloud } = await import('../../cloud/src/server')
        temp = await mkdtemp(join(tmpdir(), 'weft-cold-'))
        // Also own the temporary directories Playwright creates before launch succeeds.
        process.env.TMPDIR = temp
        const relay = cloud = startCloud({ staticDir: dir, port: 0, db: join(temp, 'relay.sqlite') })
        const doc = '11111111-1111-4111-a111-111111111111'
        const pageId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
        relay.store.putDocuments('bench', JSON.stringify({ documents: [{ id: doc, parent: '', type: 'notebook', name: 'Mako', pages: [{ id: pageId }] }] }))
        relay.store.putPage('bench', doc, pageId, '', new Uint8Array(await Bun.file('fixtures/mako-p1.rm').arrayBuffer()), 'seed')
        const origin = 'http://127.0.0.1:' + relay.port
        const notebook = origin + '/app/' + doc + '/' + pageId
        const viewport = { width: 1280, height: 800 }

        async function context(browser: Browser, size: typeof viewport) {
            const ctx = await browser.newContext({ viewport: size, serviceWorkers: 'block' })
            await ctx.route('**/*', route => {
                const target = new URL(route.request().url()).origin
                return target === origin || target === control.url.origin ? route.continue() : route.abort()
            })
            await ctx.routeWebSocket('**/*', (socket) => {
                const target = new URL(socket.url())
                if (target.protocol === 'ws:' && target.host === new URL(origin).host && target.pathname === '/ws') {
                    socket.connectToServer()
                } else {
                    socket.close()
                }
            })
            await ctx.addInitScript(server => {
                if (location.origin !== server) return
                localStorage.setItem('weft-server-url', server)
                localStorage.setItem('weft-dev-user', 'bench')
                localStorage.setItem('weft-clerk-pk', '')
            }, origin)
            return ctx
        }

        async function fingerprint() {
            const editor = window.__weftEditor
            const { x, y, z } = editor.getCamera()
            const { w, h } = editor.getViewportScreenBounds()
            const rows = editor.getCurrentPageShapes()
                .filter(row => row.type === 'draw')
                .sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0)
                // Reopened native shapes are assigned fresh SDK IDs and indices.
                .map(row => [row.x, row.y, row.rotation, row.opacity, row.props, row.meta])
            const bytes = new TextEncoder().encode(JSON.stringify({ x, y, z, w, h, rows }))
            return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        }
        browser = await chromium.launch({ channel: process.env.WEFT_BENCH_CHANNEL ?? 'chromium',
            args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] })
        // Generate matching native records and camera out of band in a discarded profile.
        const seed = await context(browser, viewport)
        await seed.addInitScript(installVisibleInkProbe)
        const source = await seed.newPage()
        source.on('response', (response) => {
            if (!response.ok()) return
            const path = new URL(response.url()).pathname
            const encoding = response.headers()['content-encoding']
            if (encoding !== 'br' && encoding !== 'gzip') return
            if (path.endsWith('/snapshot')) coding.drawing = encoding
            if (path === new URL(notebook).pathname) coding.html = encoding
            if (path.endsWith('.js')) coding.js = encoding
            if (path.endsWith('.css')) coding.css = encoding
        })
        await source.goto(notebook)
        await source.waitForFunction(() => window.__weftEditor?.getCurrentPageShapeIds().size >= 3287 &&
            !window.__weftEditor.getIsReadonly() && window.benchHasVisibleInk())
        const { rows, camera, size } = await source.evaluate(() => {
            const ed = window.__weftEditor
            const { w, h } = ed.getViewportScreenBounds()
            return { rows: ed.getCurrentPageShapes().filter(s => s.type === 'draw'), camera: ed.getCamera(),
                size: { width: Math.round(w), height: Math.round(h) } }
        })
        const expected = JSON.stringify(await source.evaluate(fingerprint))
        await seed.close()
        if (rows.length !== 3287) throw new Error('Mako fixture has changed')
        add('/drawing.json', JSON.stringify({ rows, camera }), 'application/json')
        for (const [path, file] of files) {
            const encoding = path === '/' ? coding.html : path.endsWith('.js') ? coding.js : path.endsWith('.css') ? coding.css : 'identity'
            if (encoding === 'identity') continue
            const buffer = encoding === 'br'
                ? brotliCompressSync(file.bytes, { params: {
                    [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
                    [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
                    [zlib.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(file.bytes),
                } })
                : gzipSync(file.bytes, { level: zlib.Z_BEST_COMPRESSION })
            file.bytes = Uint8Array.from(buffer)
            file.encoding = encoding
        }
        console.log(JSON.stringify({ browser: browser.version(), records: rows.length, size, runs, coding, cpu: 'unthrottled' }))
        for (const link of ['localhost', '10Mbps-80ms']) {
            const samples: Record<string, number[]> = { weft: [], sdk: [] }
            for (let i = 0; i < runs; i++) for (const arm of (i % 2 ? ['sdk','weft'] : ['weft','sdk'])) {
                const ctx = await context(browser, arm === 'weft' ? viewport : size)
                try {
                    await ctx.addInitScript(installVisibleInkProbe)
                    await ctx.addInitScript(({ count, x, y, z }) => {
                        performance.setResourceTimingBufferSize(2000)
                        const sample = () => {
                            const ed = window.__weftEditor
                            if (!ed || ed.getCurrentPageShapeIds().size < count || ed.getIsReadonly()) {
                                return void requestAnimationFrame(sample)
                            }
                            const current = ed.getCamera()
                            const draws = ed.getCurrentPageShapes().filter(shape => shape.type === 'draw')
                            if (draws.length !== count || current.x !== x || current.y !== y || current.z !== z ||
                                !window.benchHasVisibleInk()) return void requestAnimationFrame(sample)
                            requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('bench-ink')))
                        }
                        requestAnimationFrame(sample)
                    }, { count: rows.length, x: camera.x, y: camera.y, z: camera.z })
                    const tab = await ctx.newPage()
                    const cdp = await ctx.newCDPSession(tab)
                    if (link !== 'localhost') await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80,
                        downloadThroughput: 1250000, uploadThroughput: 1250000 })
                    await tab.goto(arm === 'weft' ? notebook : control.url.href, { waitUntil: 'commit' })
                    await tab.waitForFunction(() => performance.getEntriesByName('bench-ink').length > 0)
                    const metrics = await tab.evaluate(() => {
                        const paint = performance.getEntriesByName('bench-ink')[0]!.startTime
                        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
                        const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(r => r.responseEnd <= paint)
                        const bytes = (entries: PerformanceResourceTiming[]) => entries.reduce((n,r) => n + r.encodedBodySize, 0)
                        const data = resources.filter(r => r.encodedBodySize > 0 && /\/snapshot(?:\?|$)|\/drawing\.json$/.test(r.name))
                        return { inkMs: Math.round(paint), htmlTtfbMs: Math.round(nav.responseStart),
                            scriptBytes: bytes(resources.filter(r => /\.js(?:\?|$)/.test(r.name))), drawingBytes: bytes(data),
                            drawingRequestStartMs: data.length ? Math.round(Math.min(...data.map(r => r.startTime))) : null,
                            documentResponseEndMs: data.length ? Math.round(Math.max(...data.map(r => r.responseEnd))) : null,
                            completedBodyBytesByPaint: nav.encodedBodySize + bytes(resources) }
                    })
                    if (!metrics.drawingBytes) throw new Error('Fresh page did not transfer its drawing')
                    if (JSON.stringify(await tab.evaluate(fingerprint)) !== expected) {
                        throw new Error(`${arm}: drawing records or camera differ from the source fixture`)
                    }
                    console.log(JSON.stringify({ trial: i + 1, arm, link, ...metrics }))
                    samples[arm]!.push(metrics.inkMs)
                } finally { await ctx.close() }
            }
            for (const [arm, values] of Object.entries(samples)) {
                values.sort((a,b) => a-b)
                console.log(JSON.stringify({ arm, link, medianInkMs: (values[Math.floor((runs-1)/2)]! + values[Math.floor(runs/2)]!)/2 }))
            }
        }
    } finally {
        try {
            await browser?.close()
        } finally {
            try {
                stock?.stop(true)
            } finally {
                try {
                    cloud?.stop()
                } finally {
                    if (previousTmp === undefined) delete process.env.TMPDIR
                    else process.env.TMPDIR = previousTmp
                    if (temp) await rm(temp, { recursive: true, force: true })
                }
            }
        }
    }
}

main().catch((error: unknown) => {
    console.error('Cold editor benchmark failed:', error)
    process.exitCode = 1
})
