import { describe, expect, test } from 'bun:test'
import { diffCodePoints, type CodePointDiff } from '../src/text-edit'

/** Applies a diff the way the controller does: tombstone deleted code-point
 *  indices of `a`, splice each insert after its anchor code point (-1 = at
 *  the start). A passing round-trip proves the diff is valid regardless of
 *  whether Myers picked the minimal script. */
function applyDiff(a: string[], diff: CodePointDiff): string {
    const del = new Set(diff.deletes)
    // group inserts by anchor index
    const insAfter = new Map<number, string>()
    for (const ins of diff.inserts) {
        insAfter.set(ins.after, (insAfter.get(ins.after) ?? '') + ins.text)
    }
    let out = insAfter.get(-1) ?? ''
    for (let i = 0; i < a.length; i++) {
        if (!del.has(i)) out += a[i]
        out += insAfter.get(i) ?? ''
    }
    return out
}

function check(from: string, to: string): CodePointDiff {
    const a = [...from]
    const b = [...to]
    const diff = diffCodePoints(a, b)
    // every insert anchor must be a SURVIVING code point (never deleted) or -1
    const del = new Set(diff.deletes)
    for (const ins of diff.inserts) {
        expect(ins.after === -1 || !del.has(ins.after)).toBe(true)
        expect(ins.after).toBeGreaterThanOrEqual(-1)
        expect(ins.after).toBeLessThan(a.length)
    }
    // deletes are valid, in range, unique
    expect(new Set(diff.deletes).size).toBe(diff.deletes.length)
    for (const d of diff.deletes) {
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThan(a.length)
    }
    // round-trips to `to`
    expect(applyDiff(a, diff)).toBe(to)
    return diff
}

describe('diffCodePoints', () => {
    test('identical -> no ops', () => {
        const d = check('hello\nworld', 'hello\nworld')
        expect(d.deletes).toEqual([])
        expect(d.inserts).toEqual([])
    })

    test('pure insert at end', () => check('abc', 'abcdef'))
    test('pure insert at start', () => check('abc', 'Xabc'))
    test('pure delete', () => check('abcdef', 'abf'))
    test('empty -> text (create)', () => check('', 'hello'))
    test('text -> empty (clear)', () => check('hello', ''))

    test('typo fix keeps surrounding chars matched', () => {
        // "Aaa" -> "Aax": only index 2 changes
        const d = check('Aaa', 'Aax')
        expect(d.deletes).toEqual([2])
        expect(d.inserts).toEqual([{ after: 1, text: 'x' }])
    })

    test('#78 repro: edit two non-adjacent lines keeps the untouched middle \\n', () => {
        // lines: Aaa / bbb / Ccc ; fix a typo on line 1 AND line 3
        const from = 'Aaa\nbbb\nCcc'
        const to = 'Aax\nbbb\nCcx'
        const d = check(from, to)
        // the two '\n' separators are at code-point indices 3 and 7 — neither
        // may be tombstoned (they anchor the middle line's paragraph style/ink)
        expect(d.deletes).not.toContain(3)
        expect(d.deletes).not.toContain(7)
        // and every char of the untouched middle line (indices 4,5,6) survives
        expect(d.deletes).not.toContain(4)
        expect(d.deletes).not.toContain(5)
        expect(d.deletes).not.toContain(6)
    })

    test('#79 emoji: astral chars round-trip and index by code point', () => {
        check('AB😀CD', 'AB😀CDE')
        check('a😀b', 'a🎉b')
        check('😀😀😀', '😀X😀')
        // inserting after an emoji: anchor index must be the emoji code point
        const d = check('X😀', 'X😀!')
        expect(d.inserts.some((i) => i.text.includes('!'))).toBe(true)
    })

    test('leading newline (Enter at top)', () => check('Hello', '\nHello'))
    test('remove leading newline', () => check('\nHello', 'Hello'))
    test('CJK astral round-trips', () => check('𠀀中文', '𠀀日本'))

    test('brute-force random round-trips (incl. emoji/newlines)', () => {
        const alphabet = [...'ab\ncd😀🎉中']
        // deterministic LCG so the test is reproducible (no Math.random)
        let seed = 0x2545f491
        const rnd = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff
            return seed / 0x7fffffff
        }
        const mkStr = (len: number) => {
            let s = ''
            for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]
            return s
        }
        for (let t = 0; t < 4000; t++) {
            const a = mkStr(Math.floor(rnd() * 14))
            const b = mkStr(Math.floor(rnd() * 14))
            check(a, b)
        }
    })

    test('fallback path (tiny maxD) still round-trips', () => {
        const a = [...'the quick brown fox jumps']
        const b = [...'a completely different string here']
        // force the fallback by exhausting maxD
        const diff = diffCodePoints(a, b, 1)
        expect(applyDiff(a, diff)).toBe('a completely different string here')
    })
})
