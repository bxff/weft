import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** Start a private relay for tests that switch away from the application's origin. */
export async function startTestRelay() {
    const child = spawn(
        join(homedir(), '.bun/bin/bun'),
        ['apps/cloud/src/server.ts', '--port', '0', '--db', ':memory:'],
        {
            cwd: join(import.meta.dirname, '..'),
            env: { ...process.env, CLOUD_DEV_USER: '1', HOST: '127.0.0.1' },
            stdio: ['ignore', 'pipe', 'inherit'],
        },
    )
    const lines = createInterface({ input: child.stdout })
    const stop = () => child.kill()
    try {
        const port = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Timed out waiting for test relay to listen')),
                15_000,
            )
            lines.on('line', (line) => {
                const ready = /^weft-cloud listening on :(\d+)$/.exec(line)
                if (ready) {
                    clearTimeout(timeout)
                    resolve(ready[1])
                }
            })
            lines.once('close', () => {
                clearTimeout(timeout)
                reject(new Error('Test relay exited before reporting its listening port'))
            })
            child.once('error', (error) => {
                clearTimeout(timeout)
                reject(error)
            })
        })
        return { origin: `http://127.0.0.1:${port}`, stop }
    } catch (error) {
        stop()
        throw error
    } finally {
        lines.close()
        child.stdout.resume()
    }
}
