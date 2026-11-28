import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each(['success', 'mask', 'stop', 'restart', 'health', 'upgrade', 'auto-success', 'auto-health', 'auto-upgrade-health', 'auto-xochitl', 'auto-no-config-health', 'auto-config-stage', 'auto-activation-busy', 'auto-runtime-mask-health', 'release', 'release-health', 'release-downgrade', 'release-retag', 'release-untrusted', 'release-old-source', 'release-wrong-arch', 'release-draft', 'release-copy-corrupt', 'release-activation-busy', 'release-xochitl', 'auto-vs-release', 'release-vs-auto'])('manual setup restores stock state when activation fails (%s)', failure => {
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
        if (verified || failure === 'auto-vs-release') {
            if (verified) writeFileSync(path('home/root/weft/verified-release'), installedReceipt)
            const binary = Buffer.alloc(64)
            binary.writeUInt32BE(0x7f454c46, 0)
            binary[4] = failure === 'release-wrong-arch' ? 1 : 2
            binary[5] = binary[6] = 1
            binary.writeUInt16LE(183, 18)
            writeFileSync(path('signed-daemon'), binary)
        }
        const auto = failure.startsWith('auto-')
        const upgrade = failure === 'upgrade' || failure === 'auto-upgrade-health'
        if (auto) {
            if (upgrade) writeFileSync(path('usr/bin/rm-sync.original'), 'older preserved stock copy')
            writeFileSync(path('home/root/weft/boot-guard.sh'), 'original boot guard')
            writeFileSync(path('home/root/weft/install-service.sh'), 'original legacy script')
            writeFileSync(path('home/root/weft/firmware-mismatch'), 'original mismatch marker')
        }
        const runtimeMask = failure === 'auto-runtime-mask-health'
        writeFileSync(path(runtimeMask ? 'stock-mask-runtime' : upgrade ? 'stock-mask' : 'stock-active'), '')
        const activationBusy = failure.endsWith('-activation-busy')
        if (activationBusy) mkdirSync(path('home/root/weft/setup-activation.lock'))
        const mock = (name: string, script: string) =>
            writeFileSync(path(name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        if (process.platform === 'darwin') mock('sha256sum', 'shasum -a 256 "$@"')
        mock('journalctl', 'exit 0')
        mock('sleep', 'exit 0')
        mock('mount', 'exit 0')
        mock('strings', 'cat "$1"')
        mock('wget', 'case "$FAILURE" in *health) exit 1 ;; *) exit 0 ;; esac')
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
    release*|contest-release) cp "$src" "$TABLET$target" ;;
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
    *cloud.json.new*) if [ "$FAILURE" = auto-config-stage ]; then exit 1; fi ;;

esac
/bin/sh -c "$(printf '%s' "$remote" | rewrite)"
`)
        mock('systemctl', `
printf '%s\\n' "$*" >> "$TABLET/systemctl.log"
case "$*" in
    "is-enabled rm-sync.service"|"is-enabled rm-sync")
        if [ -f "$TABLET/stock-mask" ]; then echo masked; exit 1; fi
        if [ -f "$TABLET/stock-mask-runtime" ]; then echo masked-runtime; exit 1; fi
        if { [ "$FAILURE" = upgrade ] || [ "$FAILURE" = auto-upgrade-health ]; }; then echo masked; exit 1; fi
        echo enabled ;;
    "is-active rm-sync.service")
        if [ -f "$TABLET/stock-mask-runtime" ]; then echo inactive; exit 3; fi
        if { [ "$FAILURE" = upgrade ] || [ "$FAILURE" = auto-upgrade-health ]; }; then echo inactive; exit 3; fi
        echo active ;;
    "is-active xochitl.service") echo active ;;
    "is-active weft.service")
        if { [ "$FAILURE" = upgrade ] || [ "$FAILURE" = auto-upgrade-health ]; }; then echo active; else echo inactive; exit 3; fi ;;
    "mask rm-sync.service"|"mask rm-sync")
        touch "$TABLET/stock-mask"
        test "$FAILURE" != mask ;;
    "unmask rm-sync.service") rm -f "$TABLET/stock-mask" ;;
    "stop rm-sync.service"|"stop rm-sync")
        rm -f "$TABLET/stock-active"
        test "$FAILURE" != stop ;;
    "start rm-sync.service") touch "$TABLET/stock-active" ;;
    "restart weft.service")
        test -d "$TABLET/home/root/weft/setup-activation.lock" || exit 1
        case "$FAILURE" in
          auto-vs-release)
            if FAILURE=contest-release "$CLI_BUN" "$CLI_ENTRY" setup --no-auto-reinstall --release tablet-v2.10.0 --cloud https://relay.example --token competing > "$TABLET/contender.log" 2>&1; then exit 1; fi
            grep -q 'Another setup activation is in progress' "$TABLET/contender.log" || exit 1 ;;
          release-vs-auto)
            if FAILURE=contest-auto "$CLI_BUN" "$CLI_ENTRY" setup --cloud https://relay.example --token competing > "$TABLET/contender.log" 2>&1; then exit 1; fi
            grep -q 'Another setup activation is in progress' "$TABLET/contender.log" || exit 1 ;;
        esac
        { test -f "$TABLET/stock-mask" || test -f "$TABLET/stock-mask-runtime"; } && test ! -f "$TABLET/stock-active" || exit 1
        test "$FAILURE" != restart && test "$FAILURE" != upgrade || exit 1
        case "$FAILURE" in
            auto*) sed -e "s|/usr/|$TABLET/usr/|g" -e "s|/etc/|$TABLET/etc/|g" -e "s|/home/root/|$TABLET/home/root/|g" "$TABLET/home/root/weft/boot-guard.sh" | /bin/sh ;;
        esac ;;
    "restart xochitl") test "$FAILURE" != auto-xochitl && test "$FAILURE" != release-xochitl ;;
esac
`)
        const run = Bun.spawnSync([
            process.execPath, cli, 'setup',
            ...(auto ? [] : ['--no-auto-reinstall']),
            ...(verified ? ['--release', 'tablet-v2.10.0'] : []),
            ...(failure === 'auto-no-config-health' ? [] : ['--cloud', 'https://relay.example', '--token', 'sample']),
        ], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TABLET: dir, FAILURE: failure, RM_SSH_PASS: '', CLI_BUN: process.execPath, CLI_ENTRY: process.env.PACKED_CLI ?? cli },
        })
        const calls = existsSync(path('systemctl.log')) ? readFileSync(path('systemctl.log'), 'utf8') : ''
        if (failure === 'success' || failure === 'auto-success' || failure === 'release' || failure.includes('-vs-')) {
            expect(run.exitCode).toBe(0)
            expect(existsSync(path('stock-mask'))).toBe(true)
            expect(existsSync(path('stock-active'))).toBe(false)
            expect(calls).toContain('restart xochitl')
            if (auto) {
                expect(readFileSync(path('usr/lib/systemd/system/weft.service'), 'utf8')).toContain(`ExecStartPre=${path('home/root/weft/boot-guard.sh')}`)
                expect(readFileSync(path('home/root/weft/boot-guard.sh'), 'utf8')).toContain('weft-guard')
                expect(existsSync(path('usr/bin/rm-sync.original'))).toBe(true)
            }
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
            expect(existsSync(path('stock-active'))).toBe(!upgrade && !runtimeMask)
            expect(existsSync(path('stock-mask-runtime'))).toBe(runtimeMask)
            if (upgrade) {
                expect(calls).toContain('start weft.service\n')
                expect(calls).not.toContain('unmask rm-sync.service')
            }
            if (failure.endsWith('-xochitl')) expect(calls).toContain('start xochitl.service')
            else expect(calls).not.toContain('restart xochitl')
            if (auto) {
                expect(readFileSync(path('home/root/weft/boot-guard.sh'), 'utf8')).toBe('original boot guard')
                expect(readFileSync(path('home/root/weft/firmware-mismatch'), 'utf8')).toBe('original mismatch marker')
                expect(readFileSync(path('home/root/weft/install-service.sh'), 'utf8')).toBe('original legacy script')
                if (upgrade) expect(readFileSync(path('usr/bin/rm-sync.original'), 'utf8')).toBe('older preserved stock copy')
                else expect(existsSync(path('usr/bin/rm-sync.original'))).toBe(false)
            }
            expect(readFileSync(path('home/root/weft/cloud.json'), 'utf8')).toBe('original config')
            expect(readFileSync(path('home/root/weft/rmsyncd'), 'utf8')).toBe('original daemon')
            expect(readFileSync(path('usr/lib/systemd/system/weft.service'), 'utf8')).toBe('original unit')
            expect(readFileSync(path('usr/lib/systemd/system/xochitl.service.d/weft.conf'), 'utf8')).toBe('original drop-in')
            expect(readlinkSync(path('usr/lib/systemd/system/multi-user.target.wants/weft.service'))).toBe('/previous/weft.service')
        }
        expect(readdirSync(path('home/root/weft')).filter(name => name.startsWith('setup-stage-'))).toEqual([])
        expect(existsSync(path('home/root/weft/setup-activation.lock'))).toBe(activationBusy)
        if (failure === 'auto-config-stage' || activationBusy) expect(calls).toBe('')
        expect(existsSync(path('gh.log'))).toBe(verified || failure === 'auto-vs-release')
        if (failure.includes('-vs-')) {
            expect(readFileSync(path('contender.log'), 'utf8')).toContain('Another setup activation is in progress')
            const staged = readFileSync(path('scp.log'), 'utf8').trim().split('\n')
            expect(new Set(staged).size).toBe(2)
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
