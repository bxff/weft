/**
 * The device-text stylesheet: one set of CSS rules, derived from the metrics
 * in text-metrics.ts, applied to both the static rich-text HTML and the
 * TipTap editor (they share the .tl-rich-text DOM), so entering edit mode
 * cannot shift the text; both match layoutText(), which positions ink anchors.
 *
 * Vertical model (uniform-glyph): every line is a lineStride-tall box; each
 * block adds marginTop(size) — body 19.6, h1 89.2, h2 54.4, h3 36.2 ink.
 *
 * tldraw's label CSS centers content (built for note/geo labels); the
 * scoped overrides below pin the column to the top-left instead.
 */

import { RM_SCALE } from '@weft/rm-ink'
import { DEVICE_TEXT_LEFT_MARGIN_INK, metricsFor } from './text-metrics'

const S = RM_SCALE
const px = (ink: number) => `${(ink * S).toFixed(3)}px`


const body = metricsFor(1)
const bold = metricsFor(3)
const h1 = metricsFor(2) // legacy heading = size 1 (XL serif)
const h2 = metricsFor(1, 3) // size 3: large serif
const h3 = metricsFor(1, 2) // size 2: medium bold sans
const bullet = metricsFor(4)
const bullet2 = metricsFor(5)
const checkbox = metricsFor(6)
const checkbox2 = metricsFor(8)
const numbered = metricsFor(10)
const numbered2 = metricsFor(11)

const SCOPE = `.tl-shape[data-shape-type='device-text']`

/* first-child margins are zeroed below: the device puts the first
   paragraph's line box at the column top for every size */
const headingRule = (sel: string, m: ReturnType<typeof metricsFor>) => `
${SCOPE} .tl-rich-text ${sel} {
    font-family: ${m.css.fontFamily};
    font-size: ${m.css.fontSizePx}px;
    font-weight: ${m.css.fontWeight ?? 400};
    line-height: ${px(m.lineStrideInk)};
    min-height: 1lh;
    margin: ${px(m.marginTopInk)} 0 0 0;
    padding-left: ${px(DEVICE_TEXT_LEFT_MARGIN_INK)};
}
`

export const DEVICE_TEXT_CSS = `
/* --- un-center tldraw's label plumbing: the column is a top-left page
       object, not a centered sticky-note label --- */
${SCOPE} .tl-text-label {
    justify-content: flex-start;
    align-items: flex-start;
}
${SCOPE} .tl-text-content__wrapper {
    justify-content: flex-start;
    align-items: flex-start;
    width: 100%;
}
${SCOPE} .tl-text-label__inner > .tl-text-content {
    width: 100%;
}
${SCOPE} .tl-rich-text {
    width: 100%;
    caret-color: #1a1a18;
}

/* --- device typography: strides and margins from text-metrics.ts --- */
/* plain paragraphs get the device's left text pad (first glyph at posX + 6.5
   = PAD 6.2 + LSB). List/checkbox indents are absolute from posX (numbered
   text at posX+53.5 / posX+102, no pad); their own padding-left overrides this. */
${SCOPE} .tl-rich-text p {
    margin: ${px(body.marginTopInk)} 0 0 0;
    min-height: 1lh;
    padding-left: ${px(DEVICE_TEXT_LEFT_MARGIN_INK)};
}
${SCOPE} .tl-rich-text li > p {
    padding-left: 0;
}
${headingRule('h1', h1)}
${headingRule('h2', h2)}
${headingRule('h3', h3)}
${SCOPE} .tl-rich-text > :first-child,
${SCOPE} .tl-rich-text .ProseMirror > :first-child {
    margin-top: 0;
}

/* --- lists: hanging indents + markers at the device x offsets --- */
${SCOPE} .tl-rich-text ul,
${SCOPE} .tl-rich-text ol {
    list-style: none;
    margin: ${px(body.marginTopInk)} 0 0 0;
    padding: 0;
    text-align: inherit;
    counter-reset: weft-ol;
}
${SCOPE} .tl-rich-text li {
    position: relative;
    padding-left: ${px(bullet.indentInk)};
}
${SCOPE} .tl-rich-text li + li {
    margin-top: ${px(body.marginTopInk)};
}
${SCOPE} .tl-rich-text li > p {
    margin-top: 0;
}
${SCOPE} .tl-rich-text li > ul,
${SCOPE} .tl-rich-text li > ol {
    margin-top: ${px(body.marginTopInk)};
}
${SCOPE} .tl-rich-text ul > li::before {
    content: '\\2022';
    position: absolute;
    left: ${px(bullet.marker!.xInk)};
    top: 0;
}
${SCOPE} .tl-rich-text ul ul > li {
    padding-left: ${px(bullet2.indentInk - bullet.indentInk)};
}
${SCOPE} .tl-rich-text ul ul > li::before {
    content: '\\25E6';
    left: ${px(bullet2.marker!.xInk - bullet.indentInk)};
}
/* an orphan bullet2 (no parent bullet) stays a flat li; the attr keeps its
   deep indent + hollow marker */
${SCOPE} .tl-rich-text li:has(> p[data-device-style='5']):not(li li) {
    padding-left: ${px(bullet2.indentInk)};
}
${SCOPE} .tl-rich-text li:has(> p[data-device-style='5']):not(li li)::before {
    content: '\\25E6';
    left: ${px(bullet2.marker!.xInk)};
}

/* --- numbered lists (device styles 10/11): "1." then "a." nested,
       numbers right-aligned before the text like the device --- */
${SCOPE} .tl-rich-text ol > li {
    counter-increment: weft-ol;
    padding-left: ${px(numbered.indentInk)};
}
${SCOPE} .tl-rich-text ol > li::before {
    content: counter(weft-ol) '.';
    position: absolute;
    left: 0;
    top: 0;
    /* marker right-aligned at indent - 16.8125; static view positions it
       per-glyph instead, this CSS is edit-mode only */
    width: ${px(numbered.indentInk - 16.8125)};
    text-align: right;
    font-variant-numeric: proportional-nums;
}
${SCOPE} .tl-rich-text ol ol > li {
    padding-left: ${px(numbered2.indentInk - numbered.indentInk)};
}
${SCOPE} .tl-rich-text ol ol > li::before {
    content: counter(weft-ol, lower-alpha) '.';
    width: ${px(numbered2.indentInk - numbered.indentInk - 17.1)};
}
${SCOPE} .tl-rich-text li:has(> p[data-device-style='11']):not(li li) {
    padding-left: ${px(numbered2.indentInk)};
}
${SCOPE} .tl-rich-text li:has(> p[data-device-style='11']):not(li li)::before {
    content: counter(weft-ol, lower-alpha) '.';
    width: ${px(numbered2.indentInk - 17.1)};
}

/* --- paragraph styles the editor has no node for (carried on the
       data-device-style attr): 3 BOLD, 6/8 CHECKBOX, 7/9 CHECKED --- */
${SCOPE} .tl-rich-text p[data-device-style='3'] {
    /* a full-BOLD paragraph takes the medium-bold-sans metrics
       (stride 43.4, margin 36.2), not body 50/19.6 */
    font-family: ${bold.css.fontFamily};
    font-size: ${bold.css.fontSizePx}px;
    font-weight: 700;
    line-height: ${px(bold.lineStrideInk)};
    min-height: 1lh;
    margin: ${px(bold.marginTopInk)} 0 0 0;
}
${SCOPE} .tl-rich-text p[data-device-style='6'],
${SCOPE} .tl-rich-text p[data-device-style='7'] {
    position: relative;
    padding-left: ${px(checkbox.indentInk)};
}
${SCOPE} .tl-rich-text p[data-device-style='8'],
${SCOPE} .tl-rich-text p[data-device-style='9'] {
    position: relative;
    padding-left: ${px(checkbox2.indentInk)};
}
/* checkboxes are real boxes, not glyphs: checkboxes must be consistent across fonts, so a
   substituted glyph would render at an arbitrary size. Box is a 26.667-ink
   square from baseline-24.9 */
${SCOPE} .tl-rich-text p[data-device-style='6']::before,
${SCOPE} .tl-rich-text p[data-device-style='7']::before,
${SCOPE} .tl-rich-text p[data-device-style='8']::before,
${SCOPE} .tl-rich-text p[data-device-style='9']::before {
    content: '';
    position: absolute;
    top: ${px(8.677)};
    width: ${px(26.667)};
    height: ${px(26.667)};
    border: ${px(1.594)} solid #1a1a18;
    box-sizing: border-box;
}
${SCOPE} .tl-rich-text p[data-device-style='7']::before,
${SCOPE} .tl-rich-text p[data-device-style='9']::before {
    background: #1a1a18 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 27 27'%3E%3Cpath d='M7.5 14l4 4 8-9' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;
}
${SCOPE} .tl-rich-text p[data-device-style='6']::before,
${SCOPE} .tl-rich-text p[data-device-style='7']::before {
    left: ${px(checkbox.checkbox!.xInk)};
}
${SCOPE} .tl-rich-text p[data-device-style='8']::before,
${SCOPE} .tl-rich-text p[data-device-style='9']::before {
    left: ${px(checkbox2.checkbox!.xInk)};
}
${SCOPE} .tl-rich-text p[data-device-style='7'],
${SCOPE} .tl-rich-text p[data-device-style='9'] {
    text-decoration: line-through;
}
`

let injected = false

/** Inject the stylesheet once per document. */
export function ensureDeviceTextStyles(): void {
    if (injected) return
    injected = true
    const el = document.createElement('style')
    el.id = 'weft-device-text-style'
    el.textContent = DEVICE_TEXT_CSS
    document.head.appendChild(el)
}
