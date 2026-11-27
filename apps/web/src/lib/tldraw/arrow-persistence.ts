import { arrowBindingProps, getArrowInfo, shapeIdValidator, T, type Editor, type TLArrowBinding, type TLArrowShape, type TLShapeId } from 'tldraw'

type Link = Pick<TLArrowBinding, 'toId' | 'props'>
const storedLinks = 'weftArrowLinks'
const validLink = T.object({ toId: shapeIdValidator, props: T.object(arrowBindingProps) })

export function arrowRecordProps(editor: Editor, shape: TLArrowShape, previous?: object) {
    const links = editor.getBindingsFromShape<TLArrowBinding>(shape, 'arrow')
    if (!links.length && !(previous && storedLinks in previous)) return shape.props
    const info = links.length ? getArrowInfo(editor, shape) : undefined
    const point = (key: 'start' | 'end') => {
        const p = info?.isValid && info.bindings[key] ? info[key].point : shape.props[key]
        return { x: p.x, y: p.y }
    }
    return { ...shape.props, start: point('start'), end: point('end'),
        [storedLinks]: links.map(({ toId, props }) => ({ toId, props })).sort((a, b) => a.props.terminal.localeCompare(b.props.terminal)) }
}

const parsed = new WeakMap<object, { props: object; links?: Link[] }>()

export function unpackArrowProps(raw: object): { props: object; links?: Link[] } {
    if (!(storedLinks in raw)) return { props: raw }
    const cached = parsed.get(raw)
    if (cached) return cached
    const { [storedLinks]: value, ...props } = raw
    const links = Array.isArray(value) && value.length <= 2 && value.every((v) => validLink.isValid(v))
        ? value as Link[] : undefined
    const result = { props, links }
    parsed.set(raw, result)
    return result
}

export function restoreArrowLinks(editor: Editor, id: TLShapeId, raw: object): void {
    const { links } = unpackArrowProps(raw)
    if (!links || editor.getShape(id)?.type !== 'arrow') return
    const current = editor.getBindingsFromShape<TLArrowBinding>(id, 'arrow')
    const pageShapes = editor.getCurrentPageShapeIds()
    const fromShape = editor.getShape(id)!
    const desired = new Map(links.filter((link) => {
        if (link.toId === id || !pageShapes.has(link.toId)) return false
        const toShape = editor.getShape(link.toId)
        return !!toShape && editor.canBindShapes({ fromShape, toShape, binding: 'arrow' })
    })
        .map((link) => [link.props.terminal, link]))
    for (const record of current) {
        const link = desired.get(record.props.terminal)
        if (link && link.toId === record.toId) {
            if (JSON.stringify(link.props) !== JSON.stringify(record.props)) editor.updateBinding({ id: record.id, type: 'arrow', props: link.props })
            desired.delete(record.props.terminal)
        } else {
            // Avoid winding up with two links for one endpoint.
            editor.deleteBinding(record.id, { isolateShapes: false })
        }
    }
    for (const link of desired.values()) editor.createBinding({ type: 'arrow', fromId: id, ...link })
}
