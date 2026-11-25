import { test, expect } from 'bun:test'
import { b64Vecs, type TLDrawShape } from 'tldraw'
import { drawShapeToInk, freehandOptions } from '../src/draw'
import { freehandStrokePoints } from '../src/tldraw-internal'

test('tablet line widths retain the 5.1 pen, mouse, and constant-width mappings', () => {
    const raw = [{ x: 0, y: 3, z: .1 }, { x: 7, y: 8, z: .9 }, { x: 11, y: 2, z: .45 }, { x: 29, y: 12, z: .8 }]
    const widths = (dash: string, pen: boolean) =>
        freehandStrokePoints(raw, freehandOptions(dash, pen, true, 4.5)).map(p => Number(p.radius.toFixed(6)))
    expect(widths('draw', true)).toEqual([2.988957, 3.095179, 3.600906, 3.954485])
    expect(widths('draw', false)).toEqual([2.846437, 2.557557, 2.337692, 2.173288])
    expect(widths('solid', false)).toEqual([2.25, 2.25, 2.25, 2.25])
})

test('the public stroke helper retains tapered endpoints and short pen dots', () => {
    const options = { ...freehandOptions('draw', true, true, 4.5), start: { taper: true }, end: { taper: true } }
    const points = freehandStrokePoints([
        { x: 0, y: 3, z: .1 }, { x: 7, y: 8, z: .9 },
        { x: 11, y: 2, z: .45 }, { x: 29, y: 12, z: .8 },
    ], options)
    expect(points[0]!.radius).toBe(0.01)
    expect(points.at(-1)!.radius).toBe(0.01)
    const dot = [{ x: 0, y: 0, z: .8 }]
    expect(freehandStrokePoints(dot, options)).toEqual(
        freehandStrokePoints(dot, { ...options, start: {}, end: {} }),
    )
})


function drawDot(path: string, dim?: 2): TLDrawShape {
    return { props: {
        segments: [{ type: 'free', path, ...(dim && { dim }) }],
        dash: 'draw', size: 'm', isPen: false, isComplete: true, scale: 1,
    } } as TLDrawShape
}

test('2D and legacy 3D mouse dots project to one native point at the transformed position', () => {
    const point = { x: 3, y: 7, z: .5 }
    for (const shape of [drawDot(b64Vecs.encodePoints([point], 2), 2), drawDot(b64Vecs.encodePoints([point]))]) {
        const dot = drawShapeToInk(shape, 'black', ({ x, y }) => ({ x: x + 30, y: y + 70 }))
        expect(dot?.points).toHaveLength(1)
        expect(dot?.points[0]).toMatchObject({ x: 33, y: 77, speed: 0 })
        expect(dot!.points[0]!.width).toBeGreaterThan(0)
        expect(drawShapeToInk({ ...shape, props: { ...shape.props, segments: [] } }, 'black')).toBeNull()
    }
})

test('a packed single-point stroke with a nonfinite coordinate is rejected', () => {
    expect(drawShapeToInk(drawDot('AADAfwAA4EA=', 2), 'black')).toBeNull()
})
