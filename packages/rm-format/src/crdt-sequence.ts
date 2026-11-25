/**
 * Ordered CRDT sequence (YATA-style left/right origins).
 *
 * Items carry (leftId, rightId) origins; document order is reconstructed by
 * topological sort. Concurrent inserts at the same position are tie-broken by
 * NUMERIC (author index, clock) comparison, matching the Python rmscene
 * reference semantics (not lexicographic: "2:10" must sort after "2:9").
 *
 * File block order is a serialization convention ((author, clock)-sorted),
 * NOT document order; always derive order from this module. xochitl's exact
 * concurrency tie-break is unverified — a mismatch affects only z-order of
 * overlapping concurrent strokes.
 */

import { type CrdtId, crdtIdKey, isEndMarker } from './crdt-id'

export interface CrdtSequenceItem<T> {
    itemId: CrdtId
    leftId: CrdtId
    rightId: CrdtId
    /** > 0 marks a tombstone: the item is deleted but must be kept forever. */
    deletedLength: number
    value: T
}

export class CrdtSequence<T> {
    private items = new Map<string, CrdtSequenceItem<T>>()

    constructor(items?: Iterable<CrdtSequenceItem<T>>) {
        if (items) for (const item of items) this.merge(item)
    }

    /**
     * CRDT merge of an incoming item:
     * - unseen id → insert
     * - seen id with incoming tombstone → mark deleted (deletion is permanent)
     * - seen id otherwise → keep existing (first write wins for values)
     */
    merge(item: CrdtSequenceItem<T>): void {
        const key = crdtIdKey(item.itemId)
        const existing = this.items.get(key)
        if (!existing) {
            this.items.set(key, { ...item })
            return
        }
        if (item.deletedLength > 0) {
            existing.deletedLength = item.deletedLength
            existing.value = item.value ?? existing.value
        }
    }

    has(id: CrdtId): boolean {
        return this.items.has(crdtIdKey(id))
    }

    getItem(id: CrdtId): CrdtSequenceItem<T> | undefined {
        return this.items.get(crdtIdKey(id))
    }

    get(id: CrdtId): T | undefined {
        return this.items.get(crdtIdKey(id))?.value
    }

    get size(): number {
        return this.items.size
    }

    /** All items, unordered (includes tombstones). */
    allItems(): CrdtSequenceItem<T>[] {
        return [...this.items.values()]
    }

    /** Document-ordered ids (includes tombstoned ids). */
    orderedIds(): CrdtId[] {
        return toposortItems(this.allItems())
    }

    /** Document-ordered [id, value] pairs, tombstones excluded. */
    entries(): [CrdtId, T][] {
        const out: [CrdtId, T][] = []
        for (const id of this.orderedIds()) {
            const item = this.items.get(crdtIdKey(id))!
            if (item.deletedLength === 0) out.push([id, item.value])
        }
        return out
    }

    values(): T[] {
        return this.entries().map(([, v]) => v)
    }

    *[Symbol.iterator](): Iterator<CrdtId> {
        yield* this.orderedIds()
    }
}

const START = '__start'
const END = '__end'

/**
 * Topologically sort sequence items into document order. Ready items (all
 * dependencies emitted) are emitted author-DESCENDING, clock-ascending: the
 * device's render tie-break for concurrent same-origin inserts. This is NOT
 * crdtIdCompare (ascending author,clock), which is the file layout order.
 */
export function toposortItems<T>(items: CrdtSequenceItem<T>[]): CrdtId[] {
    if (items.length === 0) return []

    const byKey = new Map<string, CrdtSequenceItem<T>>()
    for (const item of items) byKey.set(crdtIdKey(item.itemId), item)

    const sideKey = (item: CrdtSequenceItem<T>, side: 'left' | 'right'): string => {
        const id = side === 'left' ? item.leftId : item.rightId
        const key = crdtIdKey(id)
        if (isEndMarker(id) || !byKey.has(key)) return side === 'left' ? START : END
        return key
    }

    // Kahn's algorithm, popping one node at a time so a just-unlocked
    // successor chain continues before other concurrent branches (keeps
    // same-author runs contiguous, like the device).
    const inDeg = new Map<string, number>([[START, 0], [END, 0]])
    const dependents = new Map<string, string[]>()
    const bump = (k: string, by: number) => inDeg.set(k, (inDeg.get(k) ?? 0) + by)
    const after = (k: string, d: string) => {
        let list = dependents.get(k)
        if (!list) {
            list = []
            dependents.set(k, list)
        }
        list.push(d)
    }
    for (const item of items) {
        const key = crdtIdKey(item.itemId)
        bump(key, 0)
        // item comes after its left neighbor…
        after(sideKey(item, 'left'), key)
        bump(key, 1)
        // …and before its right neighbor
        const right = sideKey(item, 'right')
        after(key, right)
        bump(right, 1)
    }
    // left edges from START don't gate anything
    inDeg.set(START, 0)

    // pop order: START first, END last, items author-DESC clock-ASC
    const better = (a: string, b: string): boolean => {
        if (a === START || b === END) return true
        if (a === END || b === START) return false
        const ia = byKey.get(a)!.itemId
        const ib = byKey.get(b)!.itemId
        return ib.part1 - ia.part1 < 0 || (ib.part1 === ia.part1 && ia.part2 < ib.part2)
    }

    // Binary min-heap of ready nodes keyed by `better` (a precedes b). Real
    // files have many concurrently-ready items (degenerate-origin tombstones);
    // an array + per-pop linear min-scan is O(n^2). The heap pops the
    // `better`-most node in O(log n) → O(n log n) overall. `better` is a total
    // order over distinct items (START min, END max), so it is a valid heap key.
    const heap: string[] = []
    const swap = (i: number, j: number) => {
        const t = heap[i]!
        heap[i] = heap[j]!
        heap[j] = t
    }
    const siftUp = (i: number) => {
        while (i > 0) {
            const p = (i - 1) >> 1
            if (!better(heap[i]!, heap[p]!)) break
            swap(i, p)
            i = p
        }
    }
    const siftDown = (i: number) => {
        const n = heap.length
        for (;;) {
            let best = i
            const l = 2 * i + 1
            const r = 2 * i + 2
            if (l < n && better(heap[l]!, heap[best]!)) best = l
            if (r < n && better(heap[r]!, heap[best]!)) best = r
            if (best === i) break
            swap(i, best)
            i = best
        }
    }
    const push = (k: string) => {
        heap.push(k)
        siftUp(heap.length - 1)
    }
    const pop = (): string => {
        const top = heap[0]!
        const last = heap.pop()!
        if (heap.length > 0) {
            heap[0] = last
            siftDown(0)
        }
        return top
    }

    for (const [k, d] of inDeg) if (d === 0) push(k)
    const result: CrdtId[] = []
    const emitted = new Set<string>()
    const drain = () => {
        while (heap.length > 0) {
            const node = pop()
            const item = byKey.get(node)
            if (item && !emitted.has(node)) {
                emitted.add(node)
                result.push(item.itemId)
            }
            for (const d of dependents.get(node) ?? []) {
                const left = inDeg.get(d)! - 1
                inDeg.set(d, left)
                if (left === 0) push(d)
            }
        }
    }
    drain()

    // Cycle recovery: a well-formed sequence is a DAG, but a pathological
    // origin graph (e.g. a badly reconstructed revert with mismatched
    // left/right chains) can leave a cycle Kahn can't drain. Z-order is
    // cosmetic (stroke stacking only) and must NEVER throw here — that would
    // take down buildView and block both rendering and sync. Instead,
    // force-emit the `better`-most stuck item and resume; bounded since each
    // pass emits at least one item.
    if (result.length !== byKey.size) {
        let broken = 0
        while (result.length < byKey.size) {
            let pick: string | null = null
            for (const k of byKey.keys()) {
                if (emitted.has(k)) continue
                if (pick === null || better(k, pick)) pick = k
            }
            if (pick === null) break
            broken++
            emitted.add(pick)
            result.push(byKey.get(pick)!.itemId)
            for (const d of dependents.get(pick) ?? []) {
                const left = inDeg.get(d)! - 1
                inDeg.set(d, left)
                if (left === 0) push(d)
            }
            drain()
        }
        if (typeof console !== 'undefined')
            console.warn(
                `toposortItems: broke ${broken} cyclic CRDT origin edge(s) across ${byKey.size} items; render order is best-effort`,
            )
    }
    return result
}
