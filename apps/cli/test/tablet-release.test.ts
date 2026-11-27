import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageTabletDaemon, type TabletArch } from '../src/tablet-release'

const commit = 'a'.repeat(40)
const annotated = 'b'.repeat(40)
const release = 'tablet-v2.10.0'
const stable = (tagName: string) => ({ tagName, isDraft: false, isPrerelease: false })

function elf(arch: TabletArch) {
    const bytes = Buffer.alloc(64)
    bytes.writeUInt32BE(0x7f454c46, 0)
    bytes[4] = arch === 'armv7' ? 1 : 2
    bytes[5] = bytes[6] = 1
    bytes.writeUInt16LE(arch === 'armv7' ? 40 : 183, 18)
    if (arch === 'armv7') bytes.writeUInt32LE(0x400, 36)
    return bytes
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

function fixture(arch: TabletArch, options: { downloadedArch?: TabletArch; changedBytes?: boolean; deny?: boolean; badTag?: boolean } = {}) {
    let file = ''
    let checks = 0
    const original = elf(arch)
    const run = (argv: string[]) => {
        if (argv[0] === 'release') {
            expect(argv).toContain('bxff/weft')
            if (argv[1] === 'list') return JSON.stringify([
                stable('app-v99.0.0'), stable('tablet-v2.9.99'),
                { ...stable('tablet-v5.0.0'), isDraft: true },
                { ...stable('tablet-v4.0.0'), isPrerelease: true },
                stable(release),
            ])
            if (argv[1] === 'view') return JSON.stringify(stable(argv[2]!))
            expect(argv.slice(0, 7)).toEqual(['release', 'download', release, '--repo', 'bxff/weft', '--pattern', `rmsyncd-${arch}`])
            file = argv.at(-1)!
            const supplied = elf(options.downloadedArch ?? arch)
            if (options.changedBytes) supplied[60] = 17
            writeFileSync(file, supplied)
            return ''
        }
        if (argv[0] === 'api') {
            expect(argv.slice(1, 3)).toEqual(['--hostname', 'github.com'])
            if (argv[3] === `repos/bxff/weft/git/ref/tags/${release}`) {
                return JSON.stringify({ object: { type: 'tag', sha: annotated } })
            }
            expect(argv[3]).toBe(`repos/bxff/weft/git/tags/${annotated}`)
            return JSON.stringify({ object: { type: options.badTag ? 'tree' : 'commit', sha: commit } })
        }
        checks++
        expect(argv).toEqual([
            'attestation', 'verify', file, '--hostname', 'github.com', '--repo', 'bxff/weft',
            '--signer-workflow', 'bxff/weft/.github/workflows/release-tablet.yml',
            '--source-ref', `refs/tags/${release}`, '--source-digest', commit, '--deny-self-hosted-runners',
        ])
        if (options.deny || sha(readFileSync(file)) !== sha(original)) throw Error('unverified release')
        return ''
    }
    return { run, checks: () => checks, file: () => file }
}

test.each(['aarch64', 'armv7'] as const)('installer selects a stable release and verifies the exact %s file', (arch) => {
    const f = fixture(arch)
    const staged = stageTabletDaemon(arch, {}, f.run)
    try {
        expect(staged.tag).toBe(release)
        expect(f.checks()).toBe(1)
        expect(readFileSync(staged.path)).toEqual(elf(arch))
    } finally { staged.remove() }
    expect(existsSync(staged.path)).toBe(false)
})

test('an explicit stable release pin still verifies the annotated tag commit', () => {
    const f = fixture('aarch64')
    const staged = stageTabletDaemon('aarch64', { tag: release }, f.run)
    staged.remove()
    expect(f.checks()).toBe(1)
})

test.each([{ changedBytes: true }, { deny: true }, { downloadedArch: 'armv7' as const }, { badTag: true }])(
    'a failed release check never returns a daemon or leaves staged bytes: %j', (options) => {
        const f = fixture('aarch64', options)
        expect(() => stageTabletDaemon('aarch64', {}, f.run)).toThrow()
        expect(existsSync(f.file())).toBe(false)
        expect(f.checks()).toBe(options.downloadedArch || options.badTag ? 0 : 1)
    },
)

test('legacy/local build requires an explicit path and cannot bypass architecture or combine with --release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-local-build-test-'))
    try {
        const path = join(dir, 'rmsyncd')
        writeFileSync(path, elf('aarch64'))
        const noNetwork = () => { throw Error('unexpected network request') }
        const staged = stageTabletDaemon('aarch64', { local: path }, noNetwork)
        try {
            expect(staged.tag).toBeUndefined()
            expect(readFileSync(staged.path)).toEqual(elf('aarch64'))
        } finally { staged.remove() }
        expect(() => stageTabletDaemon('armv7', { local: path }, noNetwork)).toThrow('wrong architecture')
        expect(() => stageTabletDaemon('aarch64', { local: path, tag: release }, noNetwork)).toThrow('not both')
        expect(() => stageTabletDaemon('aarch64', {}, () => '[]')).toThrow('No stable attested tablet release')
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('installer verifies provenance before creating or copying anything on the tablet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-stage-guard-test-'))
    try {
        const sample = join(dir, 'binary.elf')
        const touched = join(dir, 'mutations')
        const verified = join(dir, 'verified')
        writeFileSync(sample, elf('aarch64'))
        const mock = (name: string, script: string) =>
            writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        mock('ssh', `
case "$1" in -fNM|-O) exit 0 ;; esac
for arg do remote=$arg; done
case "$remote" in
    "uname -m"*) echo aarch64; exit 0 ;;
    'SIG=$('*) exit 0 ;;
    *) echo "$remote" > "$TOUCHED"; exit 1 ;;
esac
`)
        mock('scp', 'echo scp > "$TOUCHED"; exit 1')
        mock('gh', `
case "$1 $2" in
    "release list") echo '[{"tagName":"${release}","isDraft":false,"isPrerelease":false}]';;
    "api --hostname") echo '{"object":{"type":"commit","sha":"${commit}"}}';;
    "release download")
        for arg do output=$arg; done
        cp "$SAMPLE" "$output";;
    "attestation verify") echo "$@" > "$VERIFIED"; exit 1;;
    *) exit 2;;
esac
`)
        const result = Bun.spawnSync([
            process.execPath, join(import.meta.dir, '../src/cli.ts'), 'setup', '--host', 'root@synthetic',
        ], {
            env: {
                ...process.env, PATH: `${dir}:${process.env.PATH}`, RM_SSH_PASS: '',
                SAMPLE: sample, TOUCHED: touched, VERIFIED: verified,
            },
        })
        expect(result.exitCode).toBe(1)
        expect(result.stderr.toString()).toContain('GitHub CLI attestation verify failed')
        expect(readFileSync(verified, 'utf8')).toContain(`--source-digest ${commit}`)
        expect(existsSync(touched)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
