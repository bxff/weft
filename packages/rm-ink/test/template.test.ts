/**
 * Paper Pro JSON template DSL, using original synthetic test fixtures.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evalTemplateExpr, renderTemplateSvg, type RmTemplate } from '../src/template'

const FIXTURES = join(import.meta.dir, '../../../fixtures')
const checklist = JSON.parse(
    readFileSync(join(FIXTURES, 'Weft Test Checklist.template'), 'utf-8'),
) as RmTemplate

describe('expression evaluator', () => {
    const vars = new Map([
        ['templateWidth', 1620],
        ['templateHeight', 2160],
        ['a', 10],
    ])
    test('arithmetic and precedence', () => {
        expect(evalTemplateExpr('templateWidth / 2 + 522', vars)).toBe(1332)
        expect(evalTemplateExpr('a * 2 + 3', vars)).toBe(23)
        expect(evalTemplateExpr('a * (2 + 3)', vars)).toBe(50)
        expect(evalTemplateExpr('-a + 5', vars)).toBe(-5)
        expect(evalTemplateExpr(42, vars)).toBe(42)
    })
    test('ternary with comparison (the DSL idiom)', () => {
        expect(evalTemplateExpr('templateWidth > 1000 ? 270 : 257', vars)).toBe(270)
        expect(evalTemplateExpr('templateWidth > 9999 ? 270 : 257', vars)).toBe(257)
    })
    test('unknown variable throws (item gets skipped, not corrupted)', () => {
        expect(() => evalTemplateExpr('nope + 1', vars)).toThrow()
    })
})

describe('synthetic checklist rendering', () => {
    const svg = renderTemplateSvg(checklist, { width: 1620, height: 2160 })

    test('produces valid svg with content', () => {
        expect(svg.startsWith('<svg')).toBe(true)
        expect(svg).toContain('viewBox="0 0 1620 2160"')
    })
    test('renders the sample label', () => {
        expect(svg).toContain('>Sample checklist</text>')
    })
    test('repeating group fills the page with checklist rows', () => {
        const paths = svg.match(/<path /g) ?? []
        // 1 deadline rule + ~19 repeated rows ((2160-270)/97.4)
        expect(paths.length).toBeGreaterThan(15)
        expect(paths.length).toBeLessThan(30)
    })
    test('all coordinates are finite (no NaN leakage)', () => {
        expect(svg).not.toContain('NaN')
        expect(svg).not.toContain('Infinity')
    })
})

describe('synthetic grid rendering (infinite repeat, parent vars)', () => {
    const grid = JSON.parse(
        readFileSync(join(FIXTURES, 'Weft Test Grid.template'), 'utf-8'),
    ) as RmTemplate

    test('renders a full grid (h+v lines), not blank', () => {
        const svg = renderTemplateSvg(grid, { width: 1404, height: 1872 })
        const paths = svg.match(/<path /g) ?? []
        // gridSize=104: 18 h-lines + ~17 v-lines (vlines start at xpos=-312)
        expect(paths.length).toBeGreaterThan(25)
        expect(paths.length).toBeLessThan(50)
        expect(svg).not.toContain('NaN')
    })

    test('tiles past the design height with fillHeight', () => {
        const one = (renderTemplateSvg(grid, { width: 1404, height: 1872 }).match(/<path /g) ?? []).length
        const three = (
            renderTemplateSvg(grid, { width: 1404, height: 1872, fillHeight: 1872 * 3 }).match(/<path /g) ?? []
        ).length
        expect(three).toBeGreaterThan(one * 2)
    })
})

describe('repeat directions and counts', () => {
    const options = { width: 420, height: 400, viewportX: -42, viewportWidth: 504 }
    const draw = (rows: string | number, columns?: string | number) => renderTemplateSvg({
        constants: [{ rowCount: 'templateWidth / 140' }],
        items: [{
            type: 'group',
            boundingBox: { x: 0, y: 252, width: 42, height: 42 },
            repeat: { rows, columns },
            children: [{ type: 'path', data: ['M', 0, 0, 'L', 'parentWidth', 'parentHeight'] }],
        }],
    }, options)
    test('upward rows reach the top from a lower anchor', () => {
        const svg = draw('up')
        expect((svg.match(/<path /g) ?? []).length).toBe(7)
        expect(svg).toContain('translate(0.0 42.0)')
    })
    test('numeric columns and expression-based rows render every cell', () => {
        const svg = draw('rowCount', 2)
        expect((svg.match(/<path /g) ?? []).length).toBe(6)
    })
    test('infinite columns fill the viewport beyond the design width', () => {
        const svg = draw(1, 'right')
        expect(svg).toContain('translate(-42.0 252.0)')
        expect(svg).toContain('translate(420.0 252.0)')
    })
})

describe('expression evaluator: logical operators (device corpus uses ||)', () => {
    const v = new Map<string, number>([
        ['templateWidth', 1404],
        ['templateHeight', 1872],
        ['mobileMaxWidth', 1000],
    ])
    test('|| with ternary — the exact device pattern', () => {
        expect(
            evalTemplateExpr(
                'templateWidth < mobileMaxWidth || templateHeight < mobileMaxWidth ? 100 : 702',
                v,
            ),
        ).toBe(702)
        expect(
            evalTemplateExpr('templateWidth < 2000 || templateHeight < 100 ? 100 : 702', v),
        ).toBe(100)
    })
    test('&& binds tighter than ||', () => {
        expect(evalTemplateExpr('1 || 0 && 0', v)).toBe(1)
        expect(evalTemplateExpr('(1 || 0) && 0', v)).toBe(0)
    })
    test('comparison binds tighter than &&', () => {
        expect(evalTemplateExpr('2 > 1 && 3 > 2', v)).toBe(1)
        expect(evalTemplateExpr('2 > 1 && 3 > 4', v)).toBe(0)
    })
    test('unknown variables still fail loudly', () => {
        expect(() => evalTemplateExpr('nope || 1', v)).toThrow()
    })
})
