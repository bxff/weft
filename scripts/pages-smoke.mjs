import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const routes = [['/', 'index.html'], ['/library', 'library.html']]
const marker = (sha, route) => `<meta name="weft-build" content="${sha}:${route}">`

function hasMarker(html, sha, route) {
    const value = (tag, attribute) => {
        const m = new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
        return m?.[1] ?? m?.[2] ?? m?.[3]
    }
    return [...html.matchAll(/<meta\b[^>]*>/gi)].some(([tag]) =>
        value(tag, 'name') === 'weft-build' && value(tag, 'content') === `${sha}:${route}`,
    )
}

function entries(html, url) {
    const paths = [...html.matchAll(/["']((?:\/|\.\/|\.\.\/)?_app\/immutable\/entry\/[\w.-]+\.js)["']/g)]
        .map(([, path]) => new URL(path, url))
    return [...new Set(paths.filter((path) => path.origin === url.origin).map((path) => path.pathname))].sort()
}

async function request(url, mime) {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8_000) })
    if (res.status !== 200 || !mime.test(res.headers.get('content-type') ?? '')) {
        await res.body?.cancel()
        throw new Error(`Unexpected status/type at ${url.pathname}: ${res.status} ${res.headers.get('content-type')}`)
    }
    const contents = await res.text()
    if (!contents.trim()) throw new Error(`Empty response at ${url.pathname}`)
    return contents
}

const [mode, build, sha, origin = 'https://weft.page', once] = process.argv.slice(2)
if ((once !== undefined && once !== '--once') || !['stamp', 'verify'].includes(mode) || !build || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error('Usage: node scripts/pages-smoke.mjs <stamp|verify> BUILD_DIR DEPLOY_SHA [ORIGIN] [--once]')
}

const shells = await Promise.all(routes.map(async ([route, file]) => {
    const url = new URL(route, origin)
    const path = join(build, file)
    const html = await readFile(path, 'utf8')
    const paths = entries(html, url)
    if (!paths.length || !html.includes('</head>')) throw new Error(`Missing build shell at ${route}`)
    if (mode === 'stamp') {
        await writeFile(path, html.replace('</head>', `${marker(sha, route)}\n</head>`))
        // Svelte's precompressed shells predate the stamp. Pages can compress
        // the stamped HTML itself; leave all other precompressed assets intact.
        await Promise.all(['br', 'gz'].map(ext => rm(`${path}.${ext}`, { force: true })))
    } else if (!hasMarker(html, sha, route)) {
        throw new Error(`Missing expected deployment marker in the local shell at ${route}`)
    }
    return { route, url, paths }
}))

if (mode === 'verify') {
    let lastError
    const attempts = once ? 1 : 12
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const modules = new Set()
            for (const { route, url, paths } of shells) {
                const html = await request(url, /^text\/html(?:;|$)/i)
                if (!hasMarker(html, sha, route)) throw new Error(`Wrong deployment or shell at ${route}`)
                const live = entries(html, url)
                if (JSON.stringify(live) !== JSON.stringify(paths)) throw new Error(`Wrong app entry references at ${route}`)
                for (const path of live) modules.add(path)
            }
            await Promise.all([...modules].map(path => request(new URL(path, origin), /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)(?:;|$)/i)))
            console.log(`Verified / and /library on ${sha} and loaded ${modules.size} entry modules`)
            lastError = undefined
            break
        } catch (error) {
            lastError = error
            if (attempt + 1 < attempts) await delay(5000)
        }
    }
    if (lastError) throw lastError
}
