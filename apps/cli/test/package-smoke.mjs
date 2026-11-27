// Exercise the npm artifact, not the workspace CLI. Install from that tarball
// in an isolated directory so a missing runtime file can't resolve in the repo.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'weft-package-smoke-'))
const run = (command, args, cwd) => execFileSync(command, args, {
    cwd, encoding: 'utf8', timeout: 30_000,
})

try {
    run('npm', ['pack', '--offline', '--ignore-scripts', '--pack-destination', scratch], source)
    const archives = readdirSync(scratch).filter(name => name.endsWith('.tgz'))
    assert.equal(archives.length, 1, 'npm pack should produce one CLI tarball')

    const consumer = join(scratch, 'consumer')
    mkdirSync(consumer)
    run('npm', [
        'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
        join(scratch, archives[0]),
    ], consumer)
    const help = run(join(consumer, 'node_modules/.bin/weft'), ['--help'], consumer)
    assert.match(help, /usage: weft <setup\b/)
    for (const subcommand of ['doctor', 'uninstall', 'link']) assert.ok(help.includes(subcommand))
    console.log(`CLI smoke passed: ${archives[0]}`)
} finally {
    rmSync(scratch, { recursive: true, force: true })
}
