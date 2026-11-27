#!/usr/bin/env bun
/**
 * weft — installer & doctor for the reMarkable tablet daemon.
 *
 *   weft setup     --host root@10.11.99.1 [--cloud URL --token chd_...] [--password X] [--dry-run]
 *   weft doctor    --host root@10.11.99.1 [--password X]
 *   weft uninstall --host root@10.11.99.1 [--password X]
 *   weft link      --cloud URL --token chd_... [--host root@10.11.99.1]
 *
 * Everything installs into /home/root/weft (survives firmware updates);
 * a boot guard re-creates the system bits updates wipe, and restores stock
 * sync if the firmware looks incompatible.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const command = process.argv[2]
const flags = (() => {
    try {
        return parseArgs({
            args: process.argv.slice(3),
            options: {
                host: { type: 'string' },
                password: { type: 'string' },
                cloud: { type: 'string' },
                token: { type: 'string' },
                'store-timeout': { type: 'string' },
                'dry-run': { type: 'boolean' },
                'two-way': { type: 'boolean' },
                'no-auto-reinstall': { type: 'boolean' },
                'experimental-rm2': { type: 'boolean' },
            },
        }).values
    } catch {
        console.error('Invalid installer options. For a value beginning with a dash, use --option=value.')
        process.exit(1)
    }
})()

const HOST = flags.host ?? 'root@10.11.99.1'
const PASSWORD = flags.password ?? process.env.RM_SSH_PASS
const DRY = flags['dry-run']

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const DAEMON_BIN = join(REPO_ROOT, 'device/target/aarch64-unknown-linux-musl/release/rmsyncd')

/** Daemon binary for `arch`: a local source-tree build if present, otherwise
 *  downloaded from the cloud's release endpoint (the file tablets self-update
 *  from). */
async function daemonBinary(arch: 'aarch64' | 'armv7'): Promise<string> {
    const target = arch === 'armv7' ? 'armv7-unknown-linux-musleabihf' : 'aarch64-unknown-linux-musl'
    const local = join(REPO_ROOT, `device/target/${target}/release/rmsyncd`)
    if (existsSync(local)) return local
    if (!CLOUD || !TOKEN) {
        console.error(
            'no daemon binary: not in a source tree and no --cloud/--token to download from.\n' +
                'Use the setup page (it fills both in), or build from source:\n' +
                `  cd device && cargo zigbuild --release --target ${target}`,
        )
        process.exit(1)
    }
    process.stdout.write(`  downloading daemon (${arch}) from ${CLOUD} ... `)
    const r = await fetch(`${CLOUD}/api/daemon/release?arch=${arch}`, {
        headers: { 'x-device-token': TOKEN },
    }).catch((e: unknown) => {
        console.error(`\ncouldn't reach ${CLOUD}: ${e instanceof Error ? e.message : e}`)
        return process.exit(1)
    })
    if (!r.ok) {
        console.error(
            `\ndaemon download failed (${r.status})${r.status === 401 ? ' — bad or expired token' : ''}` +
                `${r.status === 404 && arch === 'armv7' ? ' — the server has no armv7 release yet' : ''}`,
        )
        process.exit(1)
    }
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes.length < 1024 * 1024 || bytes[0] !== 0x7f || bytes[1] !== 0x45) {
        console.error('\ndownloaded file does not look like the daemon binary')
        process.exit(1)
    }
    const path = join(tmpdir(), `weft-rmsyncd-${process.pid}`)
    writeFileSync(path, bytes)
    console.log(`ok (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
    return path
}

const INSTALL_DIR = '/home/root/weft'

// SSH connection multiplexing: one password prompt per run, every ssh/scp
// reuses the master. Must open with -fNM (an auto-master would inherit the
// command's stdout pipe and hang the capture).
const CONTROL_PATH = `/tmp/weft-ssh-${process.pid}.sock`
const REUSE = ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=no']
let muxOpen = false

/** Open the shared master once. Idempotent. */
function openMux(): void {
    if (DRY || muxOpen) return
    // With a password, sshpass answers every connection — no master needed.
    if (PASSWORD) return
    const base = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-o', `ControlPath=${CONTROL_PATH}`,
        '-o', 'ControlPersist=120',
    ]
    const r = spawnSync('ssh', ['-fNM', ...base, HOST], { stdio: 'inherit', timeout: 60_000 })
    // On failure each ssh/scp falls back to its own connection (may prompt).
    muxOpen = r.status === 0
}

/** Close the shared master (best-effort). */
function closeMux(): void {
    if (DRY || !muxOpen) return
    spawnSync('ssh', ['-O', 'exit', '-o', `ControlPath=${CONTROL_PATH}`, HOST], {
        timeout: 10_000,
        stdio: 'ignore',
    })
    muxOpen = false
}

// Tear the master down on every exit path (normal, step() failure, signal).
process.on('exit', closeMux)

function sshBase(): string[] {
    const base = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', ...REUSE]
    return PASSWORD ? ['sshpass', '-p', PASSWORD, 'ssh', ...base, HOST] : ['ssh', ...base, HOST]
}

function run(argv: string[], input?: string): { ok: boolean; out: string } {
    if (DRY) {
        const displayed = argv[0] === 'sshpass'
            ? ['sshpass', '-p', '[redacted]', ...argv.slice(3)]
            : argv
        console.log(`  [dry-run] ${displayed.join(' ')}`)
        return { ok: true, out: '' }
    }
    const [cmd, ...rest] = argv
    const r = spawnSync(cmd!, rest, { encoding: 'utf-8', input, timeout: 120_000 })
    return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

function ssh(remote: string): { ok: boolean; out: string } {
    openMux()
    return run([...sshBase(), remote])
}

function scp(local: string, remote: string, recursive = false): { ok: boolean; out: string } {
    openMux()
    const base = ['-o', 'StrictHostKeyChecking=accept-new', ...REUSE]
    const argv = PASSWORD
        ? ['sshpass', '-p', PASSWORD, 'scp', ...base, ...(recursive ? ['-r'] : []), local, `${HOST}:${remote}`]
        : ['scp', ...base, ...(recursive ? ['-r'] : []), local, `${HOST}:${remote}`]
    return run(argv)
}

function step(label: string, result: { ok: boolean; out: string }): void {
    console.log(`${result.ok ? '✓' : '✗'} ${label}`)
    if (!result.ok) {
        console.error(result.out.trim())
        process.exit(1)
    }
}

// ----- flags -----
// --store-timeout <ms>: xochitl's stroke flush timer (lower = faster sync).
// --no-auto-reinstall: skip the boot-guard self-heal after firmware updates.
const STORE_TIMEOUT = (() => {
    const n = Number(flags['store-timeout'] ?? 500)
    return Number.isFinite(n) && n >= 500 ? Math.round(n) : 500
})()
const AUTO_REINSTALL = !flags['no-auto-reinstall']
// --cloud + --token: connect the tablet to a weft account in the same pass.
const CLOUD = flags.cloud?.replace(/\/+$/, '')
const TOKEN = flags.token

// Check the running firmware's stock binary; the preserved copy may predate an OTA.
const firmwareSignature = `SIG=$(strings /usr/bin/rm-sync 2>/dev/null | grep -A3 'signal name="documentFinished"' | grep -o 'type="[^"]*"' | tr '\\n' ' ')
EXPECTED='type="(ay)" type="a(ay)" type="a(ay)" '`
const firmwareMismatch = '[ -n "$SIG" ] && [ "$SIG" != "$EXPECTED" ]'
const firmwarePreflight = `${firmwareSignature}
if ${firmwareMismatch}; then
  echo "FIRMWARE MISMATCH: documentFinished signature changed: $SIG" >&2
  exit 1
fi`

/** Boot guard (ExecStartPre): re-creates what a firmware update wipes and
 *  restores stock sync if the firmware looks incompatible. */
const bootGuard = (storeTimeout: number): string => `#!/bin/sh
set -e
log() { echo "weft-guard: $1"; }

mount -o remount,rw / 2>/dev/null || true

# Preserve the original rm-sync once as a backup.
if [ ! -f /usr/bin/rm-sync.original ] && [ -f /usr/bin/rm-sync ]; then
  cp /usr/bin/rm-sync /usr/bin/rm-sync.original
  log "preserved rm-sync.original"
fi

# firmware compat check: refuse takeover if the D-Bus signature changed
${firmwareSignature}
if ${firmwareMismatch}; then
  log "FIRMWARE MISMATCH: documentFinished signature changed: $SIG"
  log "refusing to take over sync; restoring stock"
  systemctl unmask rm-sync 2>/dev/null || true
  echo "$SIG" > ${INSTALL_DIR}/firmware-mismatch
  exit 1
fi
rm -f ${INSTALL_DIR}/firmware-mismatch

# store-timeout drop-in lives in /usr/lib (persistent), not /etc (tmpfs)
mkdir -p /usr/lib/systemd/system/xochitl.service.d
cat > /usr/lib/systemd/system/xochitl.service.d/weft.conf <<EOF
[Service]
Environment=XOCHITL_STORE_TIMEOUT=${storeTimeout}
[Unit]
After=weft.service
Wants=weft.service
EOF
# stale /etc copies would shadow the /usr/lib units — clear them
rm -f /etc/systemd/system/xochitl.service.d/weft.conf \
      /etc/systemd/system/weft.service \
      /etc/systemd/system/multi-user.target.wants/weft.service 2>/dev/null || true
rm -f /home/root/weft/install-service.sh 2>/dev/null || true

# keep stock cloud sync out of the way (we own the bus name)
systemctl mask rm-sync 2>/dev/null || true
systemctl stop rm-sync 2>/dev/null || true

systemctl daemon-reload
log "ok"
`

const unit = (autoReinstall: boolean): string => `[Unit]
Description=Weft tablet daemon
# must claim the sync bus name before xochitl starts
Before=xochitl.service
After=dbus.service home.mount

[Service]
Type=simple
${autoReinstall ? `ExecStartPre=${INSTALL_DIR}/boot-guard.sh\n` : ''}ExecStart=${INSTALL_DIR}/rmsyncd --cloud-config ${INSTALL_DIR}/cloud.json${autoReinstall ? ' --ota-survival' : ''}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`

/** Install manually in one remote operation so a failed takeover restores stock sync. */
function activateManualSetup(configured: boolean): void {
    const activate = `set -e
stock_mask=$(systemctl is-enabled rm-sync.service 2>/dev/null) || :
stock_active=$(systemctl is-active rm-sync.service 2>/dev/null) || :
weft_active=$(systemctl is-active weft.service 2>/dev/null) || :
case "$stock_mask" in
    enabled|enabled-runtime|linked|linked-runtime|alias|static|indirect|disabled|generated|transient|masked|masked-runtime) ;;
    *) echo 'Could not determine stock sync unit state.' >&2; exit 1 ;;
esac
case "$stock_active:$weft_active" in
    active:inactive|active:failed|inactive:active|inactive:inactive|inactive:failed|failed:active|failed:inactive|failed:failed) ;;
    *) echo 'Could not determine a stable service state.' >&2; exit 1 ;;
esac
case "$stock_active:$stock_mask" in
    active:masked|active:masked-runtime) echo 'Stock sync is active but masked.' >&2; exit 1 ;;
esac

mount -o remount,rw / 2>/dev/null || true
backup=$(mktemp -d "${INSTALL_DIR}/setup-rollback.XXXXXX")
paths="${INSTALL_DIR}/rmsyncd${configured ? `
${INSTALL_DIR}/cloud.json` : ''}
/usr/lib/systemd/system/weft.service
/usr/lib/systemd/system/multi-user.target.wants/weft.service
/usr/lib/systemd/system/xochitl.service.d/weft.conf
/etc/systemd/system/weft.service
/etc/systemd/system/multi-user.target.wants/weft.service
/etc/systemd/system/xochitl.service.d/weft.conf"
mask_attempted=0
stock_stop_attempted=0
weft_attempted=0
files_changed=0
rollback() {
    result=$?
    trap - 0
    trap '' HUP INT TERM
    if [ "$result" -eq 0 ]; then rm -rf "$backup"; return; fi
    set +e
    failed=0
    if [ "$weft_attempted" -eq 1 ]; then systemctl stop weft.service || failed=1; fi
    if [ "$files_changed" -eq 1 ]; then
        index=0
        for file in $paths; do
            index=$((index + 1))
            rm -f "$file" || failed=1
            if [ -e "$backup/$index" ] || [ -L "$backup/$index" ]; then
                cp -a "$backup/$index" "$file" || failed=1
            fi
        done
        systemctl daemon-reload || failed=1
    fi
    if [ "$mask_attempted" -eq 1 ]; then systemctl unmask rm-sync.service || failed=1; fi
    if [ "$stock_stop_attempted" -eq 1 ]; then systemctl start rm-sync.service || failed=1; fi
    if [ "$weft_active" = active ] && [ "$weft_attempted" -eq 1 ]; then
        systemctl start weft.service || failed=1
    fi
    if [ "$failed" -eq 0 ]; then
        rm -rf "$backup"
    else
        echo "Setup rollback was incomplete. Backups remain at $backup" >&2
    fi
    exit "$result"
}
trap rollback 0
trap 'exit 1' HUP INT TERM

index=0
for file in $paths; do
    index=$((index + 1))
    if [ -e "$file" ] || [ -L "$file" ]; then cp -a "$file" "$backup/$index"; fi
done
case "$stock_mask" in
    masked|masked-runtime) ;;
    *) mask_attempted=1; systemctl mask rm-sync.service ;;
esac
if [ "$stock_active" = active ]; then
    stock_stop_attempted=1
    systemctl stop rm-sync.service
fi

files_changed=1
rm -f ${INSTALL_DIR}/rmsyncd
mv ${INSTALL_DIR}/rmsyncd.new ${INSTALL_DIR}/rmsyncd
chmod +x ${INSTALL_DIR}/rmsyncd
${configured ? `rm -f ${INSTALL_DIR}/cloud.json
mv ${INSTALL_DIR}/cloud.json.new ${INSTALL_DIR}/cloud.json
` : ''}mkdir -p /usr/lib/systemd/system/multi-user.target.wants /usr/lib/systemd/system/xochitl.service.d
rm -f /usr/lib/systemd/system/weft.service /usr/lib/systemd/system/xochitl.service.d/weft.conf
cat > /usr/lib/systemd/system/weft.service <<'WEFT_UNIT'
${unit(false)}WEFT_UNIT
cat > /usr/lib/systemd/system/xochitl.service.d/weft.conf <<'WEFT_DROP_IN'
[Service]
Environment=XOCHITL_STORE_TIMEOUT=${STORE_TIMEOUT}
[Unit]
After=weft.service
Wants=weft.service
WEFT_DROP_IN
ln -sfn ../weft.service /usr/lib/systemd/system/multi-user.target.wants/weft.service
rm -f /etc/systemd/system/weft.service /etc/systemd/system/multi-user.target.wants/weft.service /etc/systemd/system/xochitl.service.d/weft.conf
systemctl daemon-reload
weft_attempted=1
systemctl restart weft.service
sleep 3
systemctl is-active --quiet weft.service
wget -q -O- http://127.0.0.1:9000/api/health
systemctl restart xochitl
`
    step('activate manual setup', run([...sshBase(), 'sh -s'], activate))
}

// ----- commands -----

async function setup(): Promise<void> {
    console.log(`Installing weft on ${HOST}${DRY ? ' (dry run)' : ''}\n`)

    // Probe BEFORE fetching a binary or touching the device: the arch decides
    // which build to install, and an unsupported device must be a clean no —
    // the boot guard would otherwise run (it's a shell script) and mask the
    // official sync around a binary that can't even exec.
    const probe = ssh('uname -m && cat /etc/version')
    step('reachable', probe)
    const isArm32 = /\barmv7/.test(probe.out)
    if (!DRY && !probe.out.includes('aarch64') && !isArm32) {
        const arch = probe.out.trim().split('\n')[0] ?? 'unknown'
        console.error(
            `\nThis tablet reports "${arch}". weft supports the reMarkable Paper Pro (aarch64)\n` +
                `and, experimentally, reMarkable 1/2 (armv7). Nothing was installed or changed.`,
        )
        process.exit(1)
    }
    if (!DRY && isArm32 && !flags['experimental-rm2']) {
        console.error(
            `\nThis looks like a reMarkable 1 or 2. weft on these devices is EXPERIMENTAL:\n` +
                `it has not been verified on this hardware yet. The safety net: if the\n` +
                `firmware looks incompatible, weft refuses to take over sync and restores\n` +
                `stock behavior. To proceed anyway, re-run with --experimental-rm2.\n` +
                `Nothing was installed or changed.`,
        )
        process.exit(1)
    }
    step('check firmware compatibility', ssh(firmwarePreflight))
    const daemonBin = DRY ? DAEMON_BIN : await daemonBinary(isArm32 ? 'armv7' : 'aarch64')
    step('create install dir', ssh(`mkdir -p ${INSTALL_DIR}`))
    step('deploy daemon', scp(daemonBin, `${INSTALL_DIR}/rmsyncd.new`))
    // file contents travel via stdin, never heredocs inside joined commands
    console.log(
        `  config: store-timeout=${STORE_TIMEOUT}ms, auto-reinstall=${AUTO_REINSTALL ? 'on' : 'off'}, ` +
            `cloud=${CLOUD ? CLOUD : 'unchanged (keeping existing config if present)'}`,
    )
    if (AUTO_REINSTALL) {
        step(
            'install boot guard',
            run(
                [...sshBase(), `cat > ${INSTALL_DIR}/boot-guard.sh && chmod +x ${INSTALL_DIR}/boot-guard.sh`],
                bootGuard(STORE_TIMEOUT),
            ),
        )

        step(
            'install unit',
            // /usr/lib is persistent rootfs; /etc is a tmpfs overlay wiped on reboot
            run(
                [...sshBase(), 'mount -o remount,rw / 2>/dev/null; cat > /usr/lib/systemd/system/weft.service'],
                unit(AUTO_REINSTALL),
            ),
        )
        if (CLOUD && TOKEN) {
            step(
                'connect to weft account',
                run([...sshBase(), `cat > ${INSTALL_DIR}/cloud.json`], JSON.stringify({ url: CLOUD, token: TOKEN })),
            )
        }
        step(
            'activate',
            ssh(
                [
                    `mv ${INSTALL_DIR}/rmsyncd.new ${INSTALL_DIR}/rmsyncd && chmod +x ${INSTALL_DIR}/rmsyncd`,
                    // enable via /usr/lib wants-symlink (survives reboot; /etc doesn't)
                    'mkdir -p /usr/lib/systemd/system/multi-user.target.wants',
                    'ln -sf ../weft.service /usr/lib/systemd/system/multi-user.target.wants/weft.service',
                    'rm -f /etc/systemd/system/weft.service /etc/systemd/system/multi-user.target.wants/weft.service 2>/dev/null || true',
                    'systemctl daemon-reload',
                    'systemctl restart weft.service',
                    'sleep 2',
                    'systemctl restart xochitl',
                ].join(' && '),
            ),
        )
        step('daemon healthy', ssh('sleep 3; wget -q -O- http://127.0.0.1:9000/api/health'))
    } else {
        if (CLOUD && TOKEN) {
            step(
                'stage cloud config',
                run([...sshBase(), `umask 077; cat > ${INSTALL_DIR}/cloud.json.new`], JSON.stringify({ url: CLOUD, token: TOKEN })),
            )
        }
        activateManualSetup(Boolean(CLOUD && TOKEN))
    }
    step('unit parses cleanly', ssh('journalctl -u weft --no-pager | grep -c "Missing" | grep -q "^0$" || systemd-analyze verify /usr/lib/systemd/system/weft.service 2>&1 | head -n 2; echo ok'))
    // no --cloud: keep the existing cloud.json, so re-running setup is a safe redeploy
    const keptUrl = CLOUD
        ? null
        : (() => {
              const raw = ssh(`cat ${INSTALL_DIR}/cloud.json 2>/dev/null`).out.trim()
              try {
                  return raw.startsWith('{') ? ((JSON.parse(raw) as { url?: string }).url ?? null) : null
              } catch {
                  return null
              }
          })()
    console.log(
        CLOUD
            ? `\nDone. Your tablet now mirrors to ${CLOUD}. Open your notes at weft.page.`
            : keptUrl
              ? `\nDone. Redeployed and kept your existing settings (still syncing to ${keptUrl}).\nRe-running 'weft setup' any time is safe, it remembers your account and config.`
              : `\nDone, but no cloud is configured yet: the tablet won't sync anywhere.\nRun 'weft setup --cloud <url> --token <chd_...>' (or use the web setup page).`,
    )
}

function doctor(): void {
    console.log(`Doctor for ${HOST}\n`)
    const checks: [string, string][] = [
        ['ssh reachable', 'echo ok'],
        ['daemon running', 'pidof rmsyncd'],
        ['daemon healthy', 'wget -q -O- http://127.0.0.1:9000/api/health'],
        ['owns sync bus name', "dbus-send --system --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner string:no.remarkable.sync | grep -q ':' && echo yes"],
        ['xochitl active', 'systemctl is-active xochitl'],
        ['stock rm-sync masked', 'systemctl is-enabled rm-sync 2>&1 | grep -q masked && echo masked || systemctl is-enabled rm-sync'],
        ['store timeout drop-in', 'grep -q XOCHITL_STORE_TIMEOUT /usr/lib/systemd/system/xochitl.service.d/weft.conf && echo present'],
        // the env must be in the RUNNING xochitl, not just the config
        ['store timeout LIVE in xochitl', 'tr "\\0" "\\n" < /proc/$(pidof xochitl)/environ | grep -q XOCHITL_STORE_TIMEOUT && echo live || (echo "MISSING - restart xochitl"; false)'],
        ['rm-sync.original preserved', 'ls /usr/bin/rm-sync.original'],
        ['no firmware mismatch flag', `[ ! -f ${INSTALL_DIR}/firmware-mismatch ] && echo clean || cat ${INSTALL_DIR}/firmware-mismatch`],
    ]
    let failures = 0
    for (const [label, remote] of checks) {
        const r = ssh(remote)
        console.log(`${r.ok ? '✓' : '✗'} ${label}${r.ok ? '' : `\n    ${r.out.trim().split('\n')[0] ?? ''}`}`)
        if (!r.ok) failures++
    }
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed. Re-run: weft setup`)
    process.exit(failures === 0 ? 0 : 1)
}

function uninstall(): void {
    console.log(`Removing weft from ${HOST}\n`)
    step(
        'restore stock sync',
        ssh(
            [
                'systemctl disable weft.service 2>/dev/null || true',
                'systemctl stop weft.service 2>/dev/null || true',
                'mount -o remount,rw / 2>/dev/null || true',
                'rm -f /usr/lib/systemd/system/weft.service /etc/systemd/system/weft.service',
                'rm -f /usr/lib/systemd/system/multi-user.target.wants/weft.service /etc/systemd/system/multi-user.target.wants/weft.service',
                'rm -f /usr/lib/systemd/system/xochitl.service.d/weft.conf /etc/systemd/system/xochitl.service.d/weft.conf',
                'systemctl unmask rm-sync 2>/dev/null || true',
                'systemctl daemon-reload',
                'systemctl start rm-sync 2>/dev/null || true',
                'systemctl restart xochitl',
            ].join('; '),
        ),
    )
    console.log(`\nDaemon removed. Files in ${INSTALL_DIR} were kept; delete manually if desired.`)
}

function link(): void {
    const cloudUrl = flags.cloud
    const token = flags.token
    if (!cloudUrl || !token) {
        console.error('usage: weft link --cloud https://your-host --token chd_... [--host root@10.11.99.1]')
        process.exit(1)
    }
    console.log(`Linking ${HOST} to ${cloudUrl}\n`)
    openMux() // first step pipes via run(); open the shared master before it
    step(
        'write cloud config',
        run(
            [...sshBase(), `cat > ${INSTALL_DIR}/cloud.json`],
            JSON.stringify({ url: cloudUrl, token }),
        ),
    )
    step('restart daemon', ssh('systemctl restart weft.service'))
    step(
        'cloud loop active',
        ssh('sleep 3; journalctl -u weft --since "-30s" --no-pager | grep -q "cloud: sync loop active" && echo ok'),
    )
    console.log('\nLinked. The tablet now mirrors to your hosted store.')
}

switch (command) {
    case 'setup':
        await setup()
        break
    case 'doctor':
        doctor()
        break
    case 'uninstall':
        uninstall()
        break
    case 'link':
        link()
        break
    default:
        console.log('usage: weft <setup [--store-timeout ms] [--no-auto-reinstall] [--experimental-rm2] [--cloud URL --token chd_...]|doctor|uninstall|link> --host root@10.11.99.1 [--password X] [--dry-run]')
        process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0)
}
