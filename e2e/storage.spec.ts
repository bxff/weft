import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { IdbStorage } from '../packages/sync-engine/src/storage'

declare global {
    interface Window { storage: IdbStorage }
}

// Exercise the real storage implementation in Chromium, without app or relay state.
const source = readFileSync('packages/sync-engine/src/storage.ts', 'utf8')
const script = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

test.beforeEach(async ({ page }) => {
    await page.route('**/__storage_test', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Storage regression</title>',
    }))
    await page.goto('/__storage_test')
    await page.addScriptTag({ content: `const exports = {}; ${script}; window.storage = new exports.IdbStorage();` })
})

test('local writes resolve after transaction completion and survive a new connection', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const storage = window.storage
        const original = IDBDatabase.prototype.transaction
        let completed = false
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
            const tx = original.apply(this, args)
            tx.addEventListener('complete', () => { completed = true })
            return tx
        } as typeof original
        try {
            await storage.set('page:test', new Uint8Array([1, 2, 3]))
            const completeWhenResolved = completed
            const reopened = new (storage.constructor as typeof IdbStorage)()
            const bytes = Array.from((await reopened.get('page:test'))!)
            const keys = await reopened.keys('page:')
            await reopened.delete('page:test')
            return { completeWhenResolved, bytes, keys, afterDelete: await reopened.get('page:test') }
        } finally {
            IDBDatabase.prototype.transaction = original
        }
    })
    expect(result).toEqual({ completeWhenResolved: true, bytes: [1, 2, 3], keys: ['page:test'], afterDelete: null })
})

for (const operation of ['set', 'delete'] as const) {
    test(`an aborted ${operation} rejects even after its request succeeds`, async ({ page }) => {
        const result = await page.evaluate(async (operation) => {
            const storage = window.storage
            await storage.set('page:test', new Uint8Array([7]))
            const original = IDBDatabase.prototype.transaction
            let requestSucceeded = false
            let aborted!: () => void
            const abortFinished = new Promise<void>((resolve) => { aborted = resolve })
            IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
                const tx = original.apply(this, args)
                tx.addEventListener('success', () => {
                    requestSucceeded = true
                    tx.abort()
                }, { once: true, capture: true })
                tx.addEventListener('abort', aborted, { once: true })
                return tx
            } as typeof original
            let error: string | null = null
            try {
                if (operation === 'set') await storage.set('page:test', new Uint8Array([9]))
                else await storage.delete('page:test')
            } catch (caught) {
                error = (caught as DOMException).name
            } finally {
                await abortFinished
                IDBDatabase.prototype.transaction = original
            }
            return { requestSucceeded, error, saved: Array.from((await storage.get('page:test'))!) }
        }, operation)
        expect(result).toEqual({ requestSucceeded: true, error: 'AbortError', saved: [7] })
    })
}

for (const operation of ['update', 'eviction'] as const) {
    test(`an aborted checkpoint ${operation} leaves the previous base and cursor together`, async ({ page }) => {
        const result = await page.evaluate(async operation => {
            const storage = window.storage
            const first = 'page:test/base'
            const second = 'page:test/state'
            await storage.setPair([first, new Uint8Array([1])], [second, new Uint8Array([2])])
            const original = IDBDatabase.prototype.transaction
            let successfulRequests = 0
            IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
                const transaction = original.apply(this, args)
                if (args[1] === 'readwrite') {
                    transaction.addEventListener('success', () => {
                        successfulRequests++
                        if (successfulRequests === 2) transaction.abort()
                    }, { capture: true })
                }
                return transaction
            } as typeof original

            let writeError: string | null = null
            try {
                if (operation === 'eviction') await storage.delete(first, second)
                else await storage.setPair([first, new Uint8Array([3])], [second, new Uint8Array([4])])
            } catch (error) {
                writeError = (error as DOMException).name
            } finally {
                IDBDatabase.prototype.transaction = original
            }
            const reopened = new (storage.constructor as typeof IdbStorage)()
            const previous = (await reopened.getPair(first, second)).map((bytes) => Array.from(bytes!))
            await reopened.setPair([first, new Uint8Array([3])], [second, new Uint8Array([4])])
            await storage.setPair([first, new Uint8Array([5])], [second, new Uint8Array([6])], () => false)
            const replacement = (await storage.getPair(first, second)).map((bytes) => Array.from(bytes!))
            return { successfulRequests, writeError, previous, replacement }
        }, operation)
        expect(result).toEqual({
            successfulRequests: 2, writeError: 'AbortError', previous: [[1], [2]], replacement: [[3], [4]],
        })
    })
}

test('an aborted transfer retains both old values after both requests succeed', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const storage = window.storage
        await storage.set('pending:destination', new Uint8Array([1]))
        await storage.set('pending:source', new Uint8Array([2]))
        const original = IDBDatabase.prototype.transaction
        let successes = 0
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
            const tx = original.apply(this, args)
            tx.addEventListener('success', () => {
                successes++
                if (successes === 2) tx.abort()
            }, { capture: true })
            return tx
        } as typeof original
        let error: string | null = null
        try {
            await storage.setAndDelete('pending:destination', new Uint8Array([1, 2]), 'pending:source')
        } catch (caught) {
            error = (caught as DOMException).name
        } finally {
            IDBDatabase.prototype.transaction = original
        }

        const reopened = new (storage.constructor as typeof IdbStorage)()
        const oldDestination = Array.from((await reopened.get('pending:destination'))!)
        const oldSource = Array.from((await reopened.get('pending:source'))!)
        await reopened.setAndDelete('pending:destination', new Uint8Array([1, 2]), 'pending:source')
        return {
            successes, error, oldDestination, oldSource,
            destination: Array.from((await storage.get('pending:destination'))!),
            source: await storage.get('pending:source'),
        }
    })
    expect(result).toEqual({
        successes: 2, error: 'AbortError', oldDestination: [1], oldSource: [2],
        destination: [1, 2], source: null,
    })
})
