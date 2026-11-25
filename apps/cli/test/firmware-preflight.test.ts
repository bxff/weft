import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dir, '../src/cli.ts')

const expectedSignature = `signal name="documentFinished"
    type="(ay)"
    type="a(ay)"
    type="a(ay)"
`

test.each([false, true])('setup rejects a changed stock signature before mutating files (existing install=%s)', (existing) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-firmware-'))
    try {
        for (const path of ['usr/bin', 'usr/lib/systemd/system', 'home/root/weft']) {
            mkdirSync(join(dir, path), { recursive: true })
        }
        writeFileSync(join(dir, 'usr/bin/rm-sync'), expectedSignature.replace('(ay)', '(i)'))
        writeFileSync(join(dir, 'usr/bin/rm-sync.original'), expectedSignature)
        const oldUnit = join(dir, 'usr/lib/systemd/system/weft.service')
        if (existing) writeFileSync(oldUnit, 'ExecStartPre=/home/root/weft/boot-guard.sh\n')
        const mock = (name: string, script: string) =>
            writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        mock('strings', 'cat "$1"')
        mock('ssh', `
case "$1" in -fNM|-O) exit 0 ;; esac
for arg do remote=$arg; done
case "$remote" in
    "uname -m"*) echo aarch64; exit 0 ;;
    'SIG=$('*)
        printf '%s\\n' "$remote" >> "$TABLET/preflight"
        /bin/sh -c "$(printf '%s' "$remote" | sed "s|/usr/bin/|$TABLET/usr/bin/|g")" ;;
    *) echo "$remote" >> "$TABLET/mutations"; exit 1 ;;
esac
`)
        const run = Bun.spawnSync([
            process.execPath, cli, 'setup', ...(existing ? ['--no-auto-reinstall'] : []),
        ], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TABLET: dir, RM_SSH_PASS: '' } })
        expect(run.exitCode).not.toBe(0)
        expect(run.stderr.toString()).toContain('FIRMWARE MISMATCH')
        expect(readFileSync(join(dir, 'preflight'), 'utf8')).toContain('strings /usr/bin/rm-sync ')
        expect(Bun.file(join(dir, 'mutations')).size).toBe(0)
        if (existing) {
            expect(readFileSync(oldUnit, 'utf8')).toBe('ExecStartPre=/home/root/weft/boot-guard.sh\n')
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
