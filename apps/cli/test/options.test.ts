import { expect, test } from 'bun:test'
import { join } from 'node:path'

const cli = join(import.meta.dir, '../src/cli.ts')

function run(...args: string[]) {
    return Bun.spawnSync([process.execPath, cli, 'setup', ...args])
}

test('a password that looks like an option stays a value and is redacted', () => {
    const result = run('--dry-run', '--password=--no-auto-reinstall')
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain('auto-reinstall=on')
    expect(output).toContain('sshpass -p [redacted]')
    expect(output).not.toContain('--no-auto-reinstall')
})

test('separate values still work and an explicit opt-out disables auto-reinstall', () => {
    const result = run('--dry-run', '--password', 'test-tablet-password', '--no-auto-reinstall')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('auto-reinstall=off')
    expect(result.stdout.toString()).not.toContain('test-tablet-password')
})

test('a missing option value fails before setup', () => {
    const result = run('--dry-run', '--token')
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('Invalid installer options')
    expect(result.stdout.toString()).toBe('')
})
