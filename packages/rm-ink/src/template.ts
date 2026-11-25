/**
 * Paper Pro page-template renderer.
 *
 * Ferrari firmware replaced PNG/SVG templates with a JSON DSL
 * (`/usr/share/remarkable/templates/*.template`): named constants with
 * arithmetic/ternary expressions over templateWidth/templateHeight, and
 * items (text, path, repeating group). This interprets that DSL to SVG.
 * Pure; safe against unknown item types (skipped).
 */

export interface RmTemplate {
    name?: string
    orientation?: string
    constants?: Record<string, number | string>[]
    items?: TemplateItem[]
}

export interface TemplateItem {
    type: string
    // text
    text?: string
    fontSize?: number | string
    position?: { x: number | string; y: number | string }
    // path
    data?: (number | string)[]
    // group
    boundingBox?: {
        x: number | string
        y: number | string
        width: number | string
        height: number | string
    }
    /** Keyword ('down'/'up'/'infinite' rows; 'right'/'left'/'infinite'
     *  columns), a fixed count (number), or an expression/constant name
     *  evaluating to a count — all forms appear in the 65 device templates. */
    repeat?: { rows?: string | number; columns?: string | number }
    children?: TemplateItem[]
}

type Vars = Map<string, number>

// ---------- expression evaluator ----------
// Grammar: ternary > logicalOr > logicalAnd > comparison > additive >
// multiplicative > unary > primary. The device corpus uses ternary,
// comparisons, || and arithmetic; && is included for symmetry. (No function
// calls exist in any device template — checked all 65.)

class Parser {
    private pos = 0
    constructor(
        private readonly src: string,
        private readonly vars: Vars,
    ) {}

    parse(): number {
        const v = this.ternary()
        this.skipWs()
        if (this.pos < this.src.length) {
            throw new Error(`trailing input at ${this.pos} in "${this.src}"`)
        }
        return v
    }

    private skipWs(): void {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++
    }

    private peek(): string {
        this.skipWs()
        return this.src[this.pos] ?? ''
    }

    private eat(token: string): boolean {
        this.skipWs()
        if (this.src.startsWith(token, this.pos)) {
            this.pos += token.length
            return true
        }
        return false
    }

    private ternary(): number {
        const cond = this.logicalOr()
        if (this.eat('?')) {
            const a = this.ternary()
            if (!this.eat(':')) throw new Error(`expected ':' in "${this.src}"`)
            const b = this.ternary()
            return cond !== 0 ? a : b
        }
        return cond
    }

    // NOT short-circuit: both sides always evaluate (they're pure arithmetic
    // over defined vars, and a missing var should fail the whole constant
    // loudly rather than depend on which side of a || it sits on).
    private logicalOr(): number {
        let left = this.logicalAnd()
        while (this.eat('||')) {
            const right = this.logicalAnd()
            left = left !== 0 || right !== 0 ? 1 : 0
        }
        return left
    }

    private logicalAnd(): number {
        let left = this.comparison()
        while (this.eat('&&')) {
            const right = this.comparison()
            left = left !== 0 && right !== 0 ? 1 : 0
        }
        return left
    }

    private comparison(): number {
        let left = this.additive()
        for (;;) {
            if (this.eat('>=')) left = left >= this.additive() ? 1 : 0
            else if (this.eat('<=')) left = left <= this.additive() ? 1 : 0
            else if (this.eat('==')) left = left === this.additive() ? 1 : 0
            else if (this.eat('>')) left = left > this.additive() ? 1 : 0
            else if (this.eat('<')) left = left < this.additive() ? 1 : 0
            else return left
        }
    }

    private additive(): number {
        let left = this.multiplicative()
        for (;;) {
            if (this.eat('+')) left += this.multiplicative()
            else if (this.peek() === '-' && !this.src.startsWith('->', this.pos)) {
                this.pos++
                left -= this.multiplicative()
            } else return left
        }
    }

    private multiplicative(): number {
        let left = this.unary()
        for (;;) {
            if (this.eat('*')) left *= this.unary()
            else if (this.eat('/')) left /= this.unary()
            else return left
        }
    }

    private unary(): number {
        if (this.eat('-')) return -this.unary()
        if (this.eat('+')) return this.unary()
        return this.primary()
    }

    private primary(): number {
        this.skipWs()
        if (this.eat('(')) {
            const v = this.ternary()
            if (!this.eat(')')) throw new Error(`expected ')' in "${this.src}"`)
            return v
        }
        const rest = this.src.slice(this.pos)
        const num = /^\d+(\.\d+)?/.exec(rest)
        if (num) {
            this.pos += num[0].length
            return parseFloat(num[0])
        }
        const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
        if (ident) {
            this.pos += ident[0].length
            const value = this.vars.get(ident[0])
            if (value === undefined) throw new Error(`unknown variable "${ident[0]}"`)
            return value
        }
        throw new Error(`unexpected token at ${this.pos} in "${this.src}"`)
    }
}

export function evalTemplateExpr(expr: number | string, vars: Vars): number {
    if (typeof expr === 'number') return expr
    return new Parser(expr, vars).parse()
}

// ---------- rendering ----------

export interface TemplateRenderOptions {
    /**
     * Template design space. xochitl evaluates the DSL with the classic
     * file-space page 1404 x 1872 and scales the result onto the panel
     * (x2160/1872 on Paper Pro).
     */
    width: number
    height: number
    /**
     * Repeat groups tile down to this height in template units (scrolling
     * pages grow beyond the design height). Defaults to `height`.
     */
    fillHeight?: number
    /**
     * Visible viewport in template units. The live device shows the full
     * panel (Paper Pro: x in [-108, 1512] around the 1404 design) and
     * template items deliberately overdraw their design width.
     */
    viewportX?: number
    viewportWidth?: number
    stroke?: string
    textColor?: string
    /** Called when a constant fails to evaluate or an item is skipped —
     *  silence hides renderer regressions (16/65 device templates once
     *  rendered blank without a whisper). Wire console.warn in dev. */
    onSkip?: (what: string, error: string) => void
}

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderTemplateSvg(template: RmTemplate, opts: TemplateRenderOptions): string {
    const fillHeight = opts.fillHeight ?? opts.height
    const vars: Vars = new Map([
        ['templateWidth', opts.width],
        ['templateHeight', opts.height],
        // Intrinsics: where the design page sits inside the physical panel
        // (Paper Pro: panel x ∈ [-108, 1512] around the 1404 design, so the
        // paper origin is +108 from the panel's left edge). Used by e.g.
        // Isometric / P Dots S to center patterns across the full panel.
        ['paperOriginX', -(opts.viewportX ?? 0)],
        ['paperOriginY', 0],
    ])
    for (const entry of template.constants ?? []) {
        for (const [name, expr] of Object.entries(entry)) {
            try {
                vars.set(name, evalTemplateExpr(expr, vars))
            } catch (e) {
                // leave undefined; items using it are skipped
                opts.onSkip?.(`constant ${name}`, String(e))
            }
        }
    }

    const stroke = opts.stroke ?? '#c4c4c4'
    const textColor = opts.textColor ?? '#9a9a9a'
    const parts: string[] = []

    const renderItem = (item: TemplateItem, originX: number, originY: number): void => {
        try {
            switch (item.type) {
                case 'text': {
                    if (!item.position || !item.text) return
                    const size = evalTemplateExpr(item.fontSize ?? 24, vars)
                    // xochitl exposes the MEASURED width/height of each text
                    // item as intrinsic vars (used as `anchor - textWidth/2`
                    // to center labels — 5 device templates). We can't
                    // measure device fonts here; ~0.5em per glyph is within
                    // a few px for the short planner labels that use it.
                    const prevTW = vars.get('textWidth')
                    const prevTH = vars.get('textHeight')
                    vars.set('textWidth', item.text.length * size * 0.5)
                    vars.set('textHeight', size)
                    const x = originX + evalTemplateExpr(item.position.x, vars)
                    const y = originY + evalTemplateExpr(item.position.y, vars)
                    if (prevTW === undefined) vars.delete('textWidth')
                    else vars.set('textWidth', prevTW)
                    if (prevTH === undefined) vars.delete('textHeight')
                    else vars.set('textHeight', prevTH)
                    parts.push(
                        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${textColor}" font-family="sans-serif">${esc(item.text)}</text>`,
                    )
                    return
                }
                case 'path': {
                    if (!item.data) return
                    const d: string[] = []
                    for (const token of item.data) {
                        if (typeof token === 'string' && /^[A-Za-z]$/.test(token)) {
                            d.push(token)
                        } else {
                            // expression tokens come in x,y pairs after commands;
                            // origin offset applies alternately (x then y)
                            d.push(evalTemplateExpr(token, vars).toFixed(1))
                        }
                    }
                    // apply group origin via transform instead of per-coordinate math
                    const transform =
                        originX !== 0 || originY !== 0
                            ? ` transform="translate(${originX.toFixed(1)} ${originY.toFixed(1)})"`
                            : ''
                    parts.push(
                        `<path d="${d.join(' ')}" fill="none" stroke="${stroke}" stroke-width="2"${transform}/>`,
                    )
                    return
                }
                case 'group': {
                    if (!item.boundingBox || !item.children) return
                    const bx = evalTemplateExpr(item.boundingBox.x, vars)
                    const by = evalTemplateExpr(item.boundingBox.y, vars)
                    const bh = evalTemplateExpr(item.boundingBox.height, vars)
                    const bw = evalTemplateExpr(item.boundingBox.width, vars)
                    // children may reference the group's box ("P Grid large")
                    const prevPW = vars.get('parentWidth')
                    const prevPH = vars.get('parentHeight')
                    vars.set('parentWidth', bw)
                    vars.set('parentHeight', bh)
                    // Repeat spec (device corpus): keyword fill, a fixed
                    // count (number), or an expression/const-name count
                    // ("rowCount"). Fill directions: rows down/up, columns
                    // right/left; 'infinite' = fill forward.
                    const countOf = (spec: string | number): number => {
                        const n = Math.floor(evalTemplateExpr(spec, vars))
                        return Number.isFinite(n) && n > 0 ? n : 1
                    }
                    // Fill repeats draw PARTIAL boxes at the edges (verified
                    // by eye against rendered output: whole-box-only tiling
                    // stopped grids/dots one cell short of the page edge —
                    // the device runs the pattern to the edge and clips).
                    const ys: number[] = []
                    const rows = item.repeat?.rows
                    if (rows !== undefined && bh > 0) {
                        if (rows === 'down' || rows === 'infinite') {
                            for (let y = by; y < fillHeight; y += bh) ys.push(y)
                        } else if (rows === 'up') {
                            for (let y = by; y > -bh; y -= bh) ys.push(y)
                        } else {
                            const n = countOf(rows)
                            for (let i = 0; i < n; i++) ys.push(by + i * bh)
                        }
                    }
                    if (ys.length === 0) ys.push(by)
                    // Columns tile across the whole visible viewport, not just
                    // the design width: the live panel is wider than the 1404
                    // design (Paper Pro shows x in [-108, 1512]) and xochitl
                    // fills it, so stopping at the design edge leaves blank
                    // side bands.
                    const vxLeft = opts.viewportX ?? 0
                    const vxRight = vxLeft + (opts.viewportWidth ?? opts.width)
                    const xs: number[] = []
                    const cols = item.repeat?.columns
                    if (cols !== undefined && bw > 0) {
                        if (cols === 'right' || cols === 'infinite') {
                            let startX = bx
                            while (startX > vxLeft) startX -= bw
                            for (let x = startX; x < vxRight; x += bw) xs.push(x)
                        } else if (cols === 'left') {
                            for (let x = bx; x > vxLeft - bw; x -= bw) xs.push(x)
                        } else {
                            const n = countOf(cols)
                            for (let i = 0; i < n; i++) xs.push(bx + i * bw)
                        }
                    }
                    if (xs.length === 0) xs.push(bx)
                    for (const y of ys) {
                        for (const x of xs) {
                            for (const child of item.children) renderItem(child, x, y)
                        }
                    }
                    if (prevPW === undefined) vars.delete('parentWidth')
                    else vars.set('parentWidth', prevPW)
                    if (prevPH === undefined) vars.delete('parentHeight')
                    else vars.set('parentHeight', prevPH)
                    return
                }
                default:
                    return // unknown item types are skipped
            }
        } catch (e) {
            // an item with unresolved vars is skipped, not fatal
            opts.onSkip?.(`item ${item.type}`, String(e))
        }
    }

    for (const item of template.items ?? []) renderItem(item, 0, 0)

    const vx = opts.viewportX ?? 0
    const vw = opts.viewportWidth ?? opts.width
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${fillHeight}" viewBox="${vx} 0 ${vw} ${fillHeight}">` +
        parts.join('') +
        `</svg>`
    )
}
