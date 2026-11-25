/**
 * Replica LRU sweep tests. Invariant: a replica with unpushed work is never
 * swept.
 */
import { test, expect, beforeEach } from 'bun:test'
import { idb } from './idb'
import {
    sweepReplicas,
    noteReplicaClosed,
    markReplicaInUse,
    clearReplicaInUse,
    MAX_BYTES,
} from './replicaSweep'

const enc = new TextEncoder()

// the idb singleton persists across tests: wipe it so each test's totals are its own
beforeEach(async () => {
    for (const k of await idb.keys('')) await idb.delete(k)
})

/** Seed a replica (base + state). `pending` puts unpushed ops in the state. */
async function seedReplica(
    doc: string,
    page: string,
    opts: { pending?: boolean; overlayDirty?: boolean; padBytes?: number } = {},
): Promise<void> {
    const key = `${doc}/${page}`
    // pad `base` so the replica has a size the sweep can total
    await idb.set(`page/${key}/base`, new Uint8Array(opts.padBytes ?? 1024))
    const state = {
        baseRevision: 'r',
        pendingOps: opts.pending ? [{ type: 'noop' }] : [],
        overlay: { shapes: [] },
        overlayDirty: opts.overlayDirty ?? false,
    }
    await idb.set(`page/${key}/state`, enc.encode(JSON.stringify(state)))
}

/** Force the index to claim `bytes` and a recency for a replica, so a sweep
 *  can be triggered without allocating hundreds of MB. */
async function setIndexRow(key: string, bytes: number, at: number): Promise<void> {
    const raw = await idb.get('meta/replica-index')
    const index = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : {}
    index[key] = { bytes, at }
    await idb.set('meta/replica-index', enc.encode(JSON.stringify(index)))
}

test('sweep drops the least-recently-opened clean replicas past the cap', async () => {
    const big = Math.ceil(MAX_BYTES * 0.7) // three of these exceed the cap
    await seedReplica('swA', 'p')
    await seedReplica('swB', 'p')
    await seedReplica('swC', 'p')
    await setIndexRow('swA/p', big, 1000) // oldest
    await setIndexRow('swB/p', big, 2000)
    await setIndexRow('swC/p', big, 3000) // newest

    const { swept } = await sweepReplicas()
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(await idb.get('page/swC/p/base')).not.toBeNull()
    expect(await idb.get('page/swA/p/base')).toBeNull()
    expect(await idb.get('page/swA/p/state')).toBeNull()
})

test('a replica with pending ops is NEVER swept, even as the oldest', async () => {
    const big = MAX_BYTES // each alone meets the cap
    await seedReplica('penOld', 'p', { pending: true })
    await seedReplica('penNew', 'p')
    await setIndexRow('penOld/p', big, 100) // oldest: first eviction candidate
    await setIndexRow('penNew/p', big, 9999)

    await sweepReplicas()
    expect(await idb.get('page/penOld/p/base')).not.toBeNull()
    expect(await idb.get('page/penOld/p/state')).not.toBeNull()
})

test('an overlay-dirty replica is treated as pending work (not swept)', async () => {
    await seedReplica('dirty', 'p', { overlayDirty: true })
    await setIndexRow('dirty/p', MAX_BYTES + 1, 1)
    await sweepReplicas()
    expect(await idb.get('page/dirty/p/base')).not.toBeNull()
})

test('an in-use replica is never swept', async () => {
    await seedReplica('open', 'p')
    await setIndexRow('open/p', MAX_BYTES + 1, 1)
    markReplicaInUse('open', 'p')
    try {
        await sweepReplicas()
        expect(await idb.get('page/open/p/base')).not.toBeNull()
    } finally {
        clearReplicaInUse('open', 'p')
    }
})

test('under the cap, nothing is swept', async () => {
    await seedReplica('small', 'p')
    await noteReplicaClosed('small', 'p') // real (tiny) size in the index
    const { swept } = await sweepReplicas()
    expect(swept).toBe(0)
    expect(await idb.get('page/small/p/base')).not.toBeNull()
})
