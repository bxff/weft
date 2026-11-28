import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'bxff/weft'
const WORKFLOW = REPO + '/.github/workflows/release-tablet.yml'
const TAG = /^tablet-v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/
const NO_LEGACY_UPDATER = '7aa37e65361bb219f579ea4926f73e7fa364fc59'
const SHA = /^[0-9a-f]{40}$/

export type TabletArch = 'aarch64' | 'armv7'
type GitHubCli = (args: string[]) => string
type Asset = { path: string; remove(): void; tag: string; commit: string; sha256: string }

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

function requireStableRelease(run: GitHubCli, tag: string): void {
    if (!TAG.test(tag)) throw Error('Use a release tag of the form tablet-vMAJOR.MINOR.PATCH.')
    const release: Release = JSON.parse(run(['release', 'view', tag, '--repo', REPO, '--json', 'tagName,isDraft,isPrerelease']))
    if (!stableTag(release) || release.tagName !== tag) throw Error('The requested tablet release is not published as stable.')
}

function sourceCommit(run: GitHubCli, tag: string): string {
    type GitObject = { type?: string; sha?: string }
    const read = (path: string): GitObject =>
        JSON.parse(run(['api', '--hostname', 'github.com', `repos/${REPO}/git/${path}`])).object
    let obj = read(`ref/tags/${tag}`)
    // Handle both lightweight and annotated tags with a bounded peel.
    for (let i = 0; i < 8 && obj?.type === 'tag' && SHA.test(obj.sha ?? ''); i++) obj = read(`tags/${obj.sha}`)
    if (obj?.type !== 'commit' || !SHA.test(obj.sha ?? '')) throw Error('Could not resolve the release tag to its exact source commit.')
    const commit = obj.sha!
    const ancestry = JSON.parse(run(['api', '--hostname', 'github.com',
        `repos/${REPO}/compare/${NO_LEGACY_UPDATER}...${commit}`]))
    if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.merge_base_commit?.sha !== NO_LEGACY_UPDATER) {
        throw Error('The release predates the verified distribution build guard.')
    }
    return commit
}

function verifyElf(path: string, arch: TabletArch): void {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size < 64 || stat.size > 64 * 1024 * 1024) throw Error('Unexpected tablet executable size or file type.')
    const elf = readFileSync(path)
    if (elf.includes(Buffer.from('/api/daemon/release?arch='))) throw Error('Tablet executable contains the legacy relay updater.')
    const arm32 = arch === 'armv7'
    if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== (arm32 ? 1 : 2) || elf[5] !== 1 ||
        elf[6] !== 1 || elf.readUInt16LE(18) !== (arm32 ? 40 : 183) ||
        (arm32 && !(elf.readUInt32LE(36) & 0x400))) {
        throw Error(`Tablet executable has the wrong architecture (expected ${arch}).`)
    }
}

export function stageTabletDaemon(arch: TabletArch, tag: string, run = gh): Asset {
    requireStableRelease(run, tag)
    const commit = sourceCommit(run, tag)
    const dir = mkdtempSync(join(tmpdir(), 'weft-daemon-'))
    const path = join(dir, `rmsyncd-${arch}`)
    function remove() { rmSync(dir, { recursive: true, force: true }) }
    try {
        run(['release', 'download', tag, '--repo', REPO, '--pattern', `rmsyncd-${arch}`, '--output', path])
        verifyElf(path, arch)
        run([
            'attestation', 'verify', path, '--hostname', 'github.com', '--repo', REPO,
            '--signer-workflow', WORKFLOW, '--source-ref', `refs/tags/${tag}`,
            '--source-digest', commit, '--deny-self-hosted-runners',
        ])
        const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
        return { path, tag, commit, sha256, remove }
    } catch (error) {
        remove()
        throw error
    }
}
