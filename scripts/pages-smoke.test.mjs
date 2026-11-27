import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

test('smoke requires the right live route, SHA, entry references and JavaScript', async () => {
    const build = await mkdtemp(join(tmpdir(), 'weft-pages-smoke-'))
    const sha = 'a'.repeat(40)
    const entry = '/_app/immutable/entry/start.synthetic.js'
    const shell = `<html><head></head><body><script>import(".${entry}")</script></body></html>`
    const cli = fileURLToPath(new URL('./pages-smoke.mjs', import.meta.url))
    const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args])
    let home, library, scenario
    const server = createServer((req, res) => {
        if (req.url === '/') {
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.end(home.replace(/name="weft-build" content="([^"]+)"/, "content=$1 name=weft-build"))
        } else if (req.url === '/library') {
            res.setHeader('content-type', 'text/html; charset=utf-8')
            if (scenario === 'wrong route') res.end(home)
            else if (scenario === 'stale') res.end(library.replace(sha, 'b'.repeat(40)))
            else if (scenario === 'wrong entry') res.end(library.replace('start.synthetic.js', 'start.stale.js'))
            else res.end(library)
        } else if (req.url === entry && scenario !== 'fallback asset') {
            res.setHeader('content-type', 'application/javascript')
            res.end('export const start = true')
        } else {
            res.setHeader('content-type', 'text/html')
            res.end(home)
        }
    })
    try {
        await writeFile(join(build, 'index.html'), shell)
        await writeFile(join(build, 'library.html'), shell)
        await run('stamp', build, sha)
        home = await readFile(join(build, 'index.html'), 'utf8')
        library = await readFile(join(build, 'library.html'), 'utf8')
        assert.notEqual(home, library)
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const verify = () => run('verify', build, sha, `http://127.0.0.1:${server.address().port}`, '--once')
        assert.match((await verify()).stdout, /loaded 1 entry modules/)
        for (const [failure, message] of [
            ['wrong route', /Wrong deployment or shell at \/library/],
            ['stale', /Wrong deployment or shell at \/library/],
            ['wrong entry', /Wrong app entry references at \/library/],
            ['fallback asset', /Unexpected status\/type at \/_app/],
        ]) {
            scenario = failure
            await assert.rejects(verify(), message)
        }
    } finally {
        server.close()
        await rm(build, { recursive: true, force: true })
    }
})
