import { spawnSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'bxff/weft'
const WORKFLOW = REPO + '/.github/workflows/release-tablet.yml'
const TAG = /^tablet-v\d+\.\d+\.\d+$/
const SHA = /^[0-9a-f]{40}$/

export type TabletArch = 'aarch64' | 'armv7'
type GitHubCli = (args: string[]) => string
type Asset = { path: string; remove(): void; tag?: string }

function gh(args: string[]): string {
    const run = spawnSync('gh', args, {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
    })
    if (run.error || run.status !== 0) {
        const exit = run.error?.name ?? run.status ?? 'timeout'
        throw Error(`GitHub CLI ${args.slice(0, 2).join(' ')} failed (${exit}). Install a trusted recent gh, sign in on github.com and retry.`)
    }
    return run.stdout.trim()
}

type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean }

function stableTag(c: Release): boolean {
    return c.isDraft === false && c.isPrerelease === false && typeof c.tagName === 'string' && TAG.test(c.tagName)
}

function versionOrder(a: string, b: string): number {
    const av = a.slice(8).split('.').map(BigInt)
    const bv = b.slice(8).split('.').map(BigInt)
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return av[i]! > bv[i]! ? -1 : 1
    return a.localeCompare(b)
}

function selectRelease(run: GitHubCli, requested?: string): string {
    if (requested !== undefined) {
        if (!TAG.test(requested)) throw Error('Use a release tag of the form tablet-vMAJOR.MINOR.PATCH.')
        const release: Release = JSON.parse(run(['release', 'view', requested, '--repo', REPO, '--json', 'tagName,isDraft,isPrerelease']))
        if (!stableTag(release) || release.tagName !== requested) throw Error('The requested tablet release is not published as stable.')
        return requested
    }
    const releases: Release[] = JSON.parse(run([
        'release', 'list', '--repo', REPO, '--exclude-drafts', '--exclude-pre-releases',
        '--limit', '100', '--json', 'tagName,isDraft,isPrerelease',
    ]))
    const tag = releases.filter(stableTag).map((r) => r.tagName).sort(versionOrder)[0]
    if (!tag) throw Error('No stable attested tablet release is published. Use --local-daemon with a trusted source build if you need to install now.')
    return tag
}

function sourceCommit(run: GitHubCli, tag: string): string {
    type GitObject = { type?: string; sha?: string }
    const read = (path: string): GitObject =>
        JSON.parse(run(['api', '--hostname', 'github.com', `repos/${REPO}/git/${path}`])).object
    let obj = read(`ref/tags/${tag}`)
    // Handle both lightweight and annotated tags with a bounded peel.
    for (let i = 0; i < 8 && obj?.type === 'tag' && SHA.test(obj.sha ?? ''); i++) obj = read(`tags/${obj.sha}`)
    if (obj?.type !== 'commit' || !SHA.test(obj.sha ?? '')) throw Error('Could not resolve the release tag to its exact source commit.')
    return obj.sha!
}

function verifyElf(path: string, arch: TabletArch): void {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size < 64 || stat.size > 64 * 1024 * 1024) throw Error('Unexpected tablet executable size or file type.')
    const elf = readFileSync(path)
    const arm32 = arch === 'armv7'
    if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== (arm32 ? 1 : 2) || elf[5] !== 1 ||
        elf[6] !== 1 || elf.readUInt16LE(18) !== (arm32 ? 40 : 183) ||
        (arm32 && !(elf.readUInt32LE(36) & 0x400))) {
        throw Error(`Tablet executable has the wrong architecture (expected ${arch}).`)
    }
}

export function stageTabletDaemon(arch: TabletArch, options: { tag?: string; local?: string } = {}, run = gh): Asset {
    if (options.tag !== undefined && options.local !== undefined) throw Error('Choose --release or --local-daemon, not both.')
    const dir = mkdtempSync(join(tmpdir(), 'weft-daemon-'))
    const path = join(dir, `rmsyncd-${arch}`)
    function remove() { rmSync(dir, { recursive: true, force: true }) }
    try {
        if (options.local !== undefined) {
            verifyElf(options.local, arch)
            copyFileSync(options.local, path)
            verifyElf(path, arch)
            return { path, remove }
        }
        const tag = selectRelease(run, options.tag)
        const digest = sourceCommit(run, tag)
        run(['release', 'download', tag, '--repo', REPO, '--pattern', `rmsyncd-${arch}`, '--output', path])
        verifyElf(path, arch)
        run([
            'attestation', 'verify', path, '--hostname', 'github.com', '--repo', REPO,
            '--signer-workflow', WORKFLOW, '--source-ref', `refs/tags/${tag}`,
            '--source-digest', digest, '--deny-self-hosted-runners',
        ])
        return { path, tag, remove }
    } catch (error) {
        remove()
        throw error
    }
}
