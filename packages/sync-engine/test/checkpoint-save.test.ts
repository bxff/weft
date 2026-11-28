import { expect, test } from 'bun:test'
import { MemoryStorage } from '../src/storage'

const bytes = (n: number) => Uint8Array.of(n)

test('concurrent checkpoint saves never retire the losing author outbox', async () => {
    const disk = new MemoryStorage()
    await disk.setPair(['base', bytes(1)], ['state', bytes(1)])
    await disk.set('pending/a', bytes(2))
    await disk.set('pending/b', bytes(3))
    const before = await disk.getPair('base', 'state')
    const save = (id: 'a' | 'b', n: number) => disk.commitSave({
        expected: before, checkpoint: [['base', bytes(n)], ['state', bytes(n)]],
        queue: { key: `pending/${id}`, bytes: null }, mayWrite: () => true,
    })
    expect(await Promise.all([save('a', 2), save('b', 3)])).toEqual(['committed', 'conflict'])
    expect(await disk.getPair('base', 'state')).toEqual([bytes(2), bytes(2)])
    expect(await disk.get('pending/a')).toBeNull()
    expect(await disk.get('pending/b')).toEqual(bytes(3))
    // A change to one member of the pair is enough to invalidate the
    // expectation, even if the native bytes look exactly the same.
    await disk.set('base', bytes(1))
    expect(await save('b', 3)).toBe('conflict')
    expect(await disk.get('pending/b')).toEqual(bytes(3))
})
