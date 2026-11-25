import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('embedded relays leave process error handling and failure exit status to their caller', () => {
    const child = Bun.spawnSync([process.execPath, '-e', `
        import { startCloud } from './src/server'
        const events = ['uncaughtException', 'unhandledRejection']
        const counts = () => events.map(event => process.listenerCount(event))
        const before = counts()
        const relays = [startCloud({port: 0}), startCloud({port: 0})]
        const during = counts()
        for (const relay of relays) relay.stop()
        console.log(JSON.stringify({ before, during, after: counts() }))
        throw Error('failed after stopping both relays')
    `], {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, CLOUD_DEV_USER: '1', CLERK_SECRET_KEY: '', WEFT_PASSWORD: '', SENTRY_DSN: '' },
    })
    const counts = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)
    expect(counts.during).toEqual(counts.before)
    expect(counts.after).toEqual(counts.before)
    expect(child.stderr.toString()).toContain('failed after stopping both relays')
    expect(child.exitCode).toBe(1)
})


test('standalone startup errors still exit unsuccessfully', () => {
    const child = Bun.spawnSync([process.execPath, 'src/server.ts', '--port', '0', '--db', ':memory:'], {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, CLERK_SECRET_KEY: 'fixture', WEFT_PASSWORD: 'fixture', SENTRY_DSN: '' },
    })
    expect(child.stderr.toString()).toContain('Set only one of WEFT_PASSWORD')
    expect(child.exitCode).toBe(1)
})
