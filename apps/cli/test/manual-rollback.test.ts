import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each(['success', 'mask', 'stop', 'restart', 'health', 'upgrade', 'auto-success', 'auto-health', 'auto-upgrade-health', 'auto-xochitl', 'auto-no-config-health', 'auto-config-stage', 'auto-activation-busy'])('manual setup restores stock state when activation fails (%s)', failure => {
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
        writeFileSync(path('device/target/aarch64-unknown-linux-musl/release/rmsyncd'), '')
        writeFileSync(path('usr/bin/rm-sync'), 'signal name="documentFinished"\n type="(ay)"\n type="a(ay)"\n type="a(ay)"')
        writeFileSync(path('home/root/weft/cloud.json'), 'original config')
        writeFileSync(path('home/root/weft/rmsyncd'), 'original daemon')
        writeFileSync(path('usr/lib/systemd/system/weft.service'), 'original unit')
        writeFileSync(path('usr/lib/systemd/system/xochitl.service.d/weft.conf'), 'original drop-in')
        symlinkSync('/previous/weft.service', path('usr/lib/systemd/system/multi-user.target.wants/weft.service'))
        const auto = failure.startsWith('auto-')
        const upgrade = failure === 'upgrade' || failure === 'auto-upgrade-health'
        if (auto) {
            if (upgrade) writeFileSync(path('usr/bin/rm-sync.original'), 'older preserved stock copy')
            writeFileSync(path('home/root/weft/boot-guard.sh'), 'original boot guard')
            writeFileSync(path('home/root/weft/install-service.sh'), 'original legacy script')
            writeFileSync(path('home/root/weft/firmware-mismatch'), 'original mismatch marker')
        }
        writeFileSync(path(upgrade ? 'stock-mask' : 'stock-active'), '')
        if (failure === 'auto-activation-busy') mkdirSync(path('home/root/weft/setup-activation.lock'))
        const mock = (name: string, script: string) =>
            writeFileSync(path(name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        mock('journalctl', 'exit 0')
        mock('sleep', 'exit 0')
        mock('mount', 'exit 0')
        mock('strings', 'cat "$1"')
        mock('wget', 'case "$FAILURE" in *health) exit 1 ;; *) exit 0 ;; esac')
        mock('scp', `
for arg do target=$arg; done
target=$(printf '%s' "$target" | cut -d: -f2-)
printf 'new daemon' > "$TABLET$target"
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
    "is-enabled rm-sync.service")
        if { [ "$FAILURE" = upgrade ] || [ "$FAILURE" = auto-upgrade-health ]; }; then echo masked; exit 1; fi
        echo enabled ;;
    "is-active rm-sync.service")
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
        test -f "$TABLET/stock-mask" && test ! -f "$TABLET/stock-active" || exit 1
        test "$FAILURE" != restart && test "$FAILURE" != upgrade || exit 1
        case "$FAILURE" in
            auto*) sed -e "s|/usr/|$TABLET/usr/|g" -e "s|/etc/|$TABLET/etc/|g" -e "s|/home/root/|$TABLET/home/root/|g" "$TABLET/home/root/weft/boot-guard.sh" | /bin/sh ;;
        esac ;;
    "restart xochitl") test "$FAILURE" != auto-xochitl ;;
esac
`)
        const run = Bun.spawnSync([
            process.execPath, cli, 'setup',
            ...(auto ? [] : ['--no-auto-reinstall']),
            ...(failure === 'auto-no-config-health' ? [] : ['--cloud', 'https://relay.example', '--token', 'sample']),
        ], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TABLET: dir, FAILURE: failure, RM_SSH_PASS: '' },
        })
        const calls = existsSync(path('systemctl.log')) ? readFileSync(path('systemctl.log'), 'utf8') : ''
        if (failure === 'success' || failure === 'auto-success') {
            expect(run.exitCode).toBe(0)
            expect(existsSync(path('stock-mask'))).toBe(true)
            expect(existsSync(path('stock-active'))).toBe(false)
            expect(calls).toContain('restart xochitl')
            if (auto) {
                expect(readFileSync(path('usr/lib/systemd/system/weft.service'), 'utf8')).toContain(`ExecStartPre=${path('home/root/weft/boot-guard.sh')}`)
                expect(readFileSync(path('home/root/weft/boot-guard.sh'), 'utf8')).toContain('weft-guard')
                expect(existsSync(path('usr/bin/rm-sync.original'))).toBe(true)
            }
            expect(readFileSync(path('home/root/weft/rmsyncd'), 'utf8')).toBe('new daemon')
            expect(JSON.parse(readFileSync(path('home/root/weft/cloud.json'), 'utf8')).token).toBe('sample')
        } else {
            expect(run.exitCode).toBe(1)
            expect(existsSync(path('stock-mask'))).toBe(upgrade)
            expect(existsSync(path('stock-active'))).toBe(!upgrade)
            if (upgrade) {
                expect(calls).toContain('start weft.service\n')
                expect(calls).not.toContain('unmask rm-sync.service')
            }
            if (failure === 'auto-xochitl') expect(calls).toContain('start xochitl.service')
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
        expect(existsSync(path('home/root/weft/setup-activation.lock'))).toBe(failure === 'auto-activation-busy')
        if (failure === 'auto-config-stage' || failure === 'auto-activation-busy') expect(calls).toBe('')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
