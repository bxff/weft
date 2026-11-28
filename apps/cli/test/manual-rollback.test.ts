import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each(['success', 'mask', 'stop', 'restart', 'health', 'upgrade', 'release', 'release-health', 'release-downgrade', 'release-retag', 'release-untrusted', 'release-old-source', 'release-wrong-arch', 'release-draft', 'release-copy-corrupt'])('manual setup restores stock state when activation fails (%s)', failure => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-manual-rollback-'))
    const path = (name: string) => join(dir, name)
    try {
        for (const name of [
            'apps/cli/src', 'device/target/aarch64-unknown-linux-musl/release',
            'usr/bin', 'usr/lib/systemd/system/multi-user.target.wants',
            'usr/lib/systemd/system/xochitl.service.d', 'home/root/weft',
        ]) mkdirSync(path(name), { recursive: true })
        const cli = path('apps/cli/src/cli.ts')
        copyFileSync(join(import.meta.dir, '../src/cli.ts'), cli)
        copyFileSync(join(import.meta.dir, '../src/tablet-release.ts'), path('apps/cli/src/tablet-release.ts'))
        writeFileSync(path('device/target/aarch64-unknown-linux-musl/release/rmsyncd'), '')
        writeFileSync(path('usr/bin/rm-sync'), 'signal name="documentFinished"\n type="(ay)"\n type="a(ay)"\n type="a(ay)"')
        writeFileSync(path('home/root/weft/cloud.json'), 'original config')
        writeFileSync(path('home/root/weft/rmsyncd'), 'original daemon')
        writeFileSync(path('usr/lib/systemd/system/weft.service'), 'original unit')
        writeFileSync(path('usr/lib/systemd/system/xochitl.service.d/weft.conf'), 'original drop-in')
        symlinkSync('/previous/weft.service', path('usr/lib/systemd/system/multi-user.target.wants/weft.service'))
        const verified = failure.startsWith('release')
        const commit = 'a'.repeat(40)
        const installedReceipt = failure === 'release-downgrade' ? `tablet-v3.0.0 ${commit}\n`
            : failure === 'release-retag' ? `tablet-v2.10.0 ${'b'.repeat(40)}\n` : `tablet-v2.9.9 ${commit}\n`
        if (verified) {
            writeFileSync(path('home/root/weft/verified-release'), installedReceipt)
            const binary = Buffer.alloc(64)
            binary.writeUInt32BE(0x7f454c46, 0)
            binary[4] = failure === 'release-wrong-arch' ? 1 : 2
            binary[5] = binary[6] = 1
            binary.writeUInt16LE(183, 18)
            writeFileSync(path('signed-daemon'), binary)
        }
        const upgrade = failure === 'upgrade'
        writeFileSync(path(upgrade ? 'stock-mask' : 'stock-active'), '')
        const mock = (name: string, script: string) =>
            writeFileSync(path(name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        if (process.platform === 'darwin') mock('sha256sum', 'shasum -a 256 "$@"')
        mock('journalctl', 'exit 0')
        mock('sleep', 'exit 0')
        mock('mount', 'exit 0')
        mock('strings', 'cat "$1"')
        mock('wget', 'test "$FAILURE" != health && test "$FAILURE" != release-health')
        mock('gh', `
printf '%s\\n' "$*" >> "$TABLET/gh.log"
case "$1 $2" in
    "release view")
        if [ "$FAILURE" = release-draft ]; then draft=true; else draft=false; fi
        printf '{"tagName":"tablet-v2.10.0","isDraft":%s,"isPrerelease":false}' "$draft" ;;
    "api --hostname")
        case "$4" in
            *git/ref/tags/tablet-v2.10.0) echo '{"object":{"type":"tag","sha":"${'b'.repeat(40)}"}}' ;;
            *git/tags/${'b'.repeat(40)}) echo '{"object":{"type":"commit","sha":"${commit}"}}' ;;
            *compare/7aa37e65361bb219f579ea4926f73e7fa364fc59...${commit})
                if [ "$FAILURE" = release-old-source ]; then status=behind; else status=ahead; fi
                printf '{"status":"%s","merge_base_commit":{"sha":"7aa37e65361bb219f579ea4926f73e7fa364fc59"}}' "$status" ;;
            *) exit 1 ;;
        esac ;;
    "release download") for arg do target=$arg; done; cp "$TABLET/signed-daemon" "$target" ;;
    "attestation verify")
        [ "$FAILURE" != release-untrusted ] &&
        [ "$4 $5 $6 $7 $8 $9 ${'\$'}{10} ${'\$'}{11} ${'\$'}{12} ${'\$'}{13} ${'\$'}{14}" = "--hostname github.com --repo bxff/weft --signer-workflow bxff/weft/.github/workflows/release-tablet.yml --source-ref refs/tags/tablet-v2.10.0 --source-digest ${commit} --deny-self-hosted-runners" ] &&
        cmp "$3" "$TABLET/signed-daemon" ;;
    *) exit 1 ;;
esac
`)
        mock('scp', `
for arg do src=$target; target=$arg; done
target=$(printf '%s' "$target" | cut -d: -f2-)
printf '%s\\n' "$target" >> "$TABLET/scp.log"
case "$FAILURE" in
    release-copy-corrupt) printf incorrect > "$TABLET$target" ;;
    release*) cp "$src" "$TABLET$target" ;;
    *) printf 'new daemon' > "$TABLET$target" ;;
esac
`)
        mock('ssh', `
case "$1" in -fNM|-O) exit 0 ;; esac
for arg do remote=$arg; done
rewrite() {
    sed -e "s|/usr/|$TABLET/usr/|g" -e "s|/etc/|$TABLET/etc/|g" -e "s|/home/root/|$TABLET/home/root/|g"
}
case "$remote" in
    "uname -m"*) echo aarch64; exit 0 ;;
    "sh -s") rewrite | /bin/sh -s; exit $? ;;
esac
/bin/sh -c "$(printf '%s' "$remote" | rewrite)"
`)
        mock('systemctl', `
printf '%s\\n' "$*" >> "$TABLET/systemctl.log"
case "$*" in
    "is-enabled rm-sync.service")
        if [ "$FAILURE" = upgrade ]; then echo masked; exit 1; fi
        echo enabled ;;
    "is-active rm-sync.service")
        if [ "$FAILURE" = upgrade ]; then echo inactive; exit 3; fi
        echo active ;;
    "is-active weft.service")
        if [ "$FAILURE" = upgrade ]; then echo active; else echo inactive; exit 3; fi ;;
    "mask rm-sync.service"|"mask rm-sync")
        touch "$TABLET/stock-mask"
        test "$FAILURE" != mask ;;
    "unmask rm-sync.service") rm -f "$TABLET/stock-mask" ;;
    "stop rm-sync.service")
        rm -f "$TABLET/stock-active"
        test "$FAILURE" != stop ;;
    "start rm-sync.service") touch "$TABLET/stock-active" ;;
    "restart weft.service")
        test -f "$TABLET/stock-mask" && test ! -f "$TABLET/stock-active" || exit 1
        test "$FAILURE" != restart && test "$FAILURE" != upgrade ;;
esac
`)
        const run = Bun.spawnSync([
            process.execPath, cli, 'setup', '--no-auto-reinstall', '--cloud', 'https://relay.example', '--token', 'sample',
            ...(verified ? ['--release', 'tablet-v2.10.0'] : []),
        ], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TABLET: dir, FAILURE: failure, RM_SSH_PASS: '' },
        })
        const calls = existsSync(path('systemctl.log')) ? readFileSync(path('systemctl.log'), 'utf8') : ''
        if (failure === 'success' || failure === 'release') {
            expect(run.exitCode).toBe(0)
            expect(existsSync(path('stock-mask'))).toBe(true)
            expect(existsSync(path('stock-active'))).toBe(false)
            expect(calls).toContain('restart xochitl')
            if (verified) {
                expect(readFileSync(path('home/root/weft/rmsyncd'))).toEqual(readFileSync(path('signed-daemon')))
                expect(readFileSync(path('home/root/weft/verified-release'), 'utf8')).toBe(`tablet-v2.10.0 ${commit}\n`)
            } else expect(readFileSync(path('home/root/weft/rmsyncd'), 'utf8')).toBe('new daemon')
            expect(JSON.parse(readFileSync(path('home/root/weft/cloud.json'), 'utf8')).token).toBe('sample')
        } else {
            expect(run.exitCode).toBe(1)
            if (verified) expect(readFileSync(path('home/root/weft/verified-release'), 'utf8')).toBe(installedReceipt)
            if (['release-untrusted', 'release-old-source', 'release-wrong-arch', 'release-draft'].includes(failure)) expect(existsSync(path('scp.log'))).toBe(false)
            expect(existsSync(path('stock-mask'))).toBe(upgrade)
            expect(existsSync(path('stock-active'))).toBe(!upgrade)
            if (upgrade) {
                expect(calls).toContain('start weft.service\n')
                expect(calls).not.toContain('unmask rm-sync.service')
            }
            expect(calls).not.toContain('restart xochitl')
            expect(readFileSync(path('home/root/weft/cloud.json'), 'utf8')).toBe('original config')
            expect(readFileSync(path('home/root/weft/rmsyncd'), 'utf8')).toBe('original daemon')
            expect(readFileSync(path('usr/lib/systemd/system/weft.service'), 'utf8')).toBe('original unit')
            expect(readFileSync(path('usr/lib/systemd/system/xochitl.service.d/weft.conf'), 'utf8')).toBe('original drop-in')
            expect(readlinkSync(path('usr/lib/systemd/system/multi-user.target.wants/weft.service'))).toBe('/previous/weft.service')
        }
        expect(existsSync(path('gh.log'))).toBe(verified)
        expect(readdirSync(path('home/root/weft')).filter(name => name.startsWith('verified-stage-') || name === 'verified-install.lock')).toEqual([])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
