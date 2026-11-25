// Run from the repo root. --synthetic creates a board in memory using the SDK.
import { isAbsolute, join } from 'node:path'
import { chromium } from 'playwright'
import type { Renderer } from './personal-renderer'

const privateFile = process.env.WEFT_TLDR_FILE
const synthetic = process.argv.includes('--synthetic')
if (synthetic === !!privateFile || (privateFile && !isAbsolute(privateFile))) {
    throw new Error('Pass an absolute WEFT_TLDR_FILE or use --synthetic')
}
const runs = Number(process.env.WEFT_BENCH_RUNS ?? 10)
if (!Number.isSafeInteger(runs) || runs < 1)
    throw new Error('WEFT_BENCH_RUNS must be a positive integer')

let data = ''
if (privateFile) {
    try {
        data = await Bun.file(privateFile).text()
    } catch {
        throw new Error('Could not read local export')
    }
}
const bundle = await Bun.build({
    entrypoints: ['apps/web/bench/personal-renderer.tsx'],
    target: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
})
if (!bundle.success) throw new Error(bundle.logs.join('\n'))
const bundles = new Map(bundle.outputs.map((file) => ['/' + file.path.split('/').at(-1), file]))
const sdk = 'apps/web/node_modules/@tldraw/assets'
const input = '/input/' + crypto.randomUUID()
const headers = {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
}
const csp =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src data: blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
        const target = new URL(request.url)
        if (request.method !== 'GET' || target.host !== server.url.host)
            return new Response(null, { status: 403 })
        if (target.pathname === '/')
            return new Response(
                '<meta charset="utf-8"><link rel="stylesheet" href="/personal-renderer.css"><div id="app" style="position:fixed;inset:0"></div><script type="module" src="/personal-renderer.js"></script>',
                {
                    headers: {
                        ...headers,
                        'content-type': 'text/html',
                        'content-security-policy': csp,
                    },
                },
            )
        if (target.pathname === input && request.headers.get('sec-fetch-site') === 'same-origin')
            return new Response(data, {
                headers: { ...headers, 'content-type': 'application/json' },
            })
        const file = bundles.get(target.pathname)
        if (file) return new Response(file, { headers })
        // The SDK resolves these asset classes locally in both modes.
        const asset = target.pathname.match(
            /^\/sdk\/((?:fonts|translations|embed-icons)\/[a-zA-Z0-9_.-]+\.(?:woff2|json|png|svg)|icons\/icon\/0_merged\.svg)$/,
        )?.[1]
        if (asset) return new Response(Bun.file(join(sdk, asset)), { headers })
        return new Response(null, { status: 404 })
    },
})
const origin = server.url.origin
const browser = await chromium.launch({
    channel: process.env.WEFT_BENCH_CHANNEL,
    args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-crash-reporter',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
}).catch((error: unknown) => {
    server.stop(true)
    throw error
})
async function pageForRun() {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
        acceptDownloads: false,
    })
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url())
        return url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:'
            ? route.continue()
            : route.abort()
    })
    await context.routeWebSocket('**/*', (socket) => socket.close())
    const page = await context.newPage()
    await page.goto(origin)
    await page.waitForFunction(() => !!window.personalBench)
    return { page, context }
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Renderer timed out after 90 seconds')),
                    90_000,
                )
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

try {
    const sdk = await Bun.file(
        new URL('../node_modules/tldraw/package.json', import.meta.url),
    ).json()
    console.log(
        JSON.stringify({
            browser: browser.version(),
            channel: process.env.WEFT_BENCH_CHANNEL ?? 'bundled',
            sdk: sdk.version,
            platform: process.platform,
            arch: process.arch,
            runs,
        }),
    )
    if (synthetic) {
        const { page, context } = await pageForRun()
        data = await bounded(page.evaluate(() => window.personalBench.synthetic()))
        await context.close()
    }
    {
        const { page, context } = await pageForRun()
        try {
            const normalized = await bounded(
                page.evaluate((input) => window.personalBench.normalize(input), input),
            ).catch(() => { throw new Error('Could not normalize the local export') })
            data = normalized.json
            console.log(
                JSON.stringify({
                    kind: 'preparation',
                    normalizedDocumentRecords: normalized.records,
                    normalization: 'stock SDK before matched trials; original file unchanged',
                }),
            )
        } finally {
            await context.close()
        }
    }
    console.log(
        JSON.stringify({
            kind: 'environment',
            sdk: JSON.parse(await Bun.file('apps/web/node_modules/tldraw/package.json').text())
                .version,
            browser: browser.version(),
            bundleSha256: new Bun.CryptoHasher('sha256')
                .update(await bundle.outputs[0]!.arrayBuffer())
                .digest('hex'),
            scope: 'renderer only; JS already loaded, no durable cache or sync',
            view: 'canonical SDK first-page/default view, not the exported session',
            readiness: 'font settlement and animation frames; no image/GPU completion claim',
        }),
    )
    const rows = []
    let original: string | undefined
    for (let i = 0; i < runs; i++) {
        const pair: Renderer[] = i % 2 ? ['weft', 'stock'] : ['stock', 'weft']
        for (const renderer of pair) {
            const { context, page } = await pageForRun()
            try {
                // Never propagate page errors (which may quote document records) into the report.
                const outcome = await bounded(
                    page.evaluate(
                        ({ renderer, input }) => window.personalBench.run(renderer, input),
                        { renderer, input },
                    ),
                )
                if (!outcome.ok) throw new Error(renderer + ': ' + outcome.type)
                const { signature, ...row } = outcome.row
                if (original && signature !== original)
                    throw new Error('Unmatched SDK document or camera')
                original = signature
                rows.push({ renderer, ...row })
                console.log(JSON.stringify({ kind: 'sample', trial: i, renderer, ...row }))
            } finally {
                await context.close()
            }
        }
    }
    for (const renderer of new Set(rows.map((row) => row.renderer))) {
        const samples = rows.filter((row) => row.renderer === renderer)
        const metrics = [
            'rendererOpenMs',
            'parseMs',
            'memoryReopenMs',
            'panP95Ms',
            'zoomP95Ms',
            'selectMs',
        ] as const
        const medians = Object.fromEntries(
            metrics.map((metric) => {
                const sorted = samples.map((row) => row[metric]).sort((a, b) => a - b)
                return [
                    metric,
                    Number(
                        (
                            (sorted[Math.floor((sorted.length - 1) / 2)]! +
                                sorted[Math.floor(sorted.length / 2)]!) /
                            2
                        ).toFixed(2),
                    ),
                ]
            }),
        )
        const { pageShapes, renderedShapes, selected, documentRecords, externalAssets } =
            samples[0]!
        console.log(
            JSON.stringify({
                renderer,
                runs: samples.length,
                pageShapes,
                renderedShapes,
                documentRecords,
                externalAssets,
                selected,
                ...medians,
            }),
        )
    }
} finally {
    data = ''
    await browser.close()
    await server.stop(true)
}
