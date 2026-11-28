import { parseDeviceIndent } from './device-text-richtext'
import {
    commands,
    Extension,
    extensions,
    getSchema,
    textblockTypeInputRule,
    type AnyExtension,
    type Editor as TextEditor,
    type KeyboardShortcutCommand,
} from '@tiptap/core'
import { Bold } from '@tiptap/extension-bold'
import { Italic } from '@tiptap/extension-italic'
import { DOMParser, Slice, type Mark, type Node, type ParseOptions } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { StarterKit } from '@tiptap/starter-kit'
import { getTipTapDefaultExtensions } from 'tldraw'

/** Paragraph/heading nodes carry their rm paragraph style
 *  (data-device-style) so BOLD/CHECKBOX/CHECKED (styles with no TipTap node)
 *  survive edits and render via CSS. */
const DeviceStyleAttr = Extension.create({
    name: 'weftDeviceStyle',
    addGlobalAttributes() {
        return [
            {
                types: ['paragraph', 'heading'],
                attributes: {
                    deviceIndent: {
                        default: null,
                        parseHTML: (el: HTMLElement) =>
                            parseDeviceIndent(el.getAttribute('data-device-indent')) ?? null,
                        renderHTML: (attrs: Record<string, unknown>) =>
                            attrs.deviceIndent == null
                                ? {}
                                : { 'data-device-indent': String(attrs.deviceIndent) },
                    },
                    deviceStyle: {
                        default: null,
                        parseHTML: (el: HTMLElement) => {
                            const v = el.getAttribute('data-device-style')
                            return v === null ? null : Number(v)
                        },
                        renderHTML: (attrs: Record<string, unknown>) =>
                            attrs.deviceStyle == null
                                ? {}
                                : { 'data-device-style': String(attrs.deviceStyle) },
                    },
                },
            },
        ]
    },
})

function isDeviceColumn(editor?: TextEditor): boolean {
    const element = editor?.options.element
    return element instanceof HTMLElement && !!element.closest('[data-shape-type="device-text"]')
}

const entryFocusState = new WeakMap<TextEditor, TextEditor['state']>()
const PreserveLabelCaret = Extension.create({
    name: 'weftPreserveLabelCaret',
    addCommands() {
        return {
            focus: (position, options) => (props) => {
                // tldraw also retries focus('end') after mount. Keep the caret
                // if the user has already typed or moved it since entry.
                if (position === 'end' && props.dispatch) {
                    const initial = entryFocusState.get(props.editor)
                    entryFocusState.delete(props.editor)
                    if (
                        initial &&
                        (props.state.doc !== initial.doc || !props.state.selection.eq(initial.selection))
                    ) {
                        return commands.focus(null, options)(props)
                    }
                }
                return commands.focus(position, options)(props)
            },
        }
    },
})

export function toggleDeviceMark(editor: TextEditor, name: 'bold' | 'italic') {
    const other = name === 'bold' ? 'italic' : 'bold'
    const chain = editor.chain().focus()
    if (!editor.isActive(name)) chain.unsetMark(other)
    return chain.toggleMark(name).run()
}

function isDeviceMark(mark: Mark): boolean {
    return mark.type.name === 'bold' || mark.type.name === 'italic'
}

const tabletHeadingLevels = [1, 2, 3] as const

function isUnsupportedHeading(node: Node): boolean {
    return node.type.name === 'heading' && !tabletHeadingLevels.includes(node.attrs.level)
}

// Keep the column's original DOM parsing rules. Mark exclusion and whitespace
// handling depend on the schema used while the clipboard HTML is parsed.
const tabletClipboardSchema = getSchema([
    StarterKit.configure({
        blockquote: false,
        bold: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        heading: { levels: [...tabletHeadingLevels] },
        horizontalRule: false,
        italic: false,
        link: false,
        strike: false,
        underline: false,
    }),
    Bold.extend({ excludes: 'italic' }),
    Italic.extend({ excludes: 'bold' }),
    DeviceStyleAttr,
    extensions.TextDirection.configure({ direction: 'auto' }),
])

class TabletClipboardParser extends DOMParser {
    override parseSlice(dom: HTMLElement, options: ParseOptions = {}): Slice {
        const context =
            options.context &&
            tabletClipboardSchema
                .nodeFromJSON(options.context.doc.toJSON())
                .resolve(options.context.pos)
        const slice = super.parseSlice(dom, { ...options, context })
        return Slice.fromJSON(this.editorSchema, slice.toJSON())
    }

    constructor(private readonly editorSchema: TextEditor['schema']) {
        super(tabletClipboardSchema, DOMParser.fromSchema(tabletClipboardSchema).rules)
    }
}

function hasUnsupportedMarks(marks: readonly Mark[]): boolean {
    return marks.length > 1 || marks.some((mark) => !isDeviceMark(mark))
}

const DeviceInput = Extension.create({
    name: 'weftDeviceInput',
    priority: 1200,
    addKeyboardShortcuts(): Record<string, KeyboardShortcutCommand> {
        if (!isDeviceColumn(this.editor)) return {}
        return {
            'Mod-b': () => toggleDeviceMark(this.editor, 'bold'),
            'Mod-i': () => toggleDeviceMark(this.editor, 'italic'),
        }
    },
    addProseMirrorPlugins() {
        if (!isDeviceColumn(this.editor)) return []
        return [
            new Plugin({
                props: { clipboardParser: new TabletClipboardParser(this.editor.schema) },
                filterTransaction(transaction, state) {
                    if (transaction.storedMarks && hasUnsupportedMarks(transaction.storedMarks))
                        return false
                    if (!transaction.docChanged) return true
                    const start = state.doc.content.findDiffStart(transaction.doc.content)
                    if (start === null) return true
                    const end = state.doc.content.findDiffEnd(transaction.doc.content)?.b ?? start
                    let valid = true
                    transaction.doc.nodesBetween(start, Math.max(start, end), (node) => {
                        if (
                            node.type.name === 'hardBreak' ||
                            isUnsupportedHeading(node) ||
                            hasUnsupportedMarks(node.marks)
                        )
                            valid = false
                        return valid
                    })
                    return valid
                },
            }),
        ]
    },
})

function skipDevicePlugins(extension: AnyExtension): AnyExtension {
    return extension.extend({
        addProseMirrorPlugins() {
            return isDeviceColumn(this.editor) ? [] : (this.parent?.() ?? [])
        },
    })
}

const stockExtensions = getTipTapDefaultExtensions().map((extension) => {
    if (extension.name === 'starterKit') {
        return extension.extend({
            addExtensions() {
                // The stock link paste handler consumes a pasted URL when text is selected.
                return (
                    this.parent?.().map((child) => {
                        if (child.name === 'link') return skipDevicePlugins(child)
                        if (child.name === 'bold' || child.name === 'italic') {
                            const mark = child.name === 'bold' ? Bold : Italic
                            return mark.extend({
                                // TipTap input and paste rules consult the active editor's mark
                                // exclusions before removing literal Markdown delimiters.
                                excludes() {
                                    if (isDeviceColumn(this.editor)) {
                                        return child.name === 'bold' ? 'italic' : 'bold'
                                    }
                                    return typeof this.parent === 'function'
                                        ? this.parent()
                                        : this.parent
                                },
                            })
                        }
                        if (child.name !== 'heading') return child
                        return child.extend({
                            addInputRules() {
                                if (!isDeviceColumn(this.editor)) return this.parent?.() ?? []
                                return tabletHeadingLevels.map((level) =>
                                    textblockTypeInputRule({
                                        find: new RegExp(`^(#{1,${level}})\\s$`),
                                        type: this.editor.schema.nodes.heading!,
                                        getAttributes: { level },
                                    }),
                                )
                            },
                        })
                    }) ?? []
                )
            },
        })
    }
    if (extension.name === 'wrapSelection' || extension.name === 'literalTyping') {
        return skipDevicePlugins(extension)
    }
    return extension
})

const deviceRules = ['bold', 'italic', 'bulletList', 'orderedList', 'heading']

export const richTextConfig = {
    extensions: [...stockExtensions, DeviceStyleAttr, DeviceInput, PreserveLabelCaret],
    onBeforeCreate({ editor }: { editor: TextEditor }) {
        if (isDeviceColumn(editor)) {
            editor.setOptions({ enableInputRules: deviceRules, enablePasteRules: deviceRules })
            // Native toolbar entry has no click position or select-all event.
            // Preserve changes made before the SDK's delayed focus('end') retry.
            queueMicrotask(() => {
                if (!editor.isDestroyed) entryFocusState.set(editor, editor.state)
            })
            return
        }
        const element = editor.options.element
        if (
            !(element instanceof HTMLElement) ||
            !element.closest('[data-shape-type="text"], [data-shape-type="geo"], [data-shape-type="note"]')
        ) {
            return
        }

        // tldraw captures the entry caret or select-all during the input event.
        // Apply it when that event ends, before TipTap's delayed create/autofocus.
        const initializeLabel = editor.options.onCreate
        editor.setOptions({
            autofocus: false,
            editorProps: {
                ...editor.options.editorProps,
                handleClick(view, position, event) {
                    if (
                        event.detail !== 1 ||
                        event.button !== 0 ||
                        event.shiftKey ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.altKey
                    ) {
                        return false
                    }
                    const interactive =
                        event.target instanceof Element &&
                        event.target.closest('a, [contenteditable="false"]')
                    if (interactive && view.dom.contains(interactive)) return false
                    if (!view.state.doc.resolve(position).parent.inlineContent) return false
                    // Commit a single-click caret before the next key. Multiple-click
                    // selection belongs to the SDK at entry and the browser inside the editor.
                    return editor.chain().setTextSelection(position).setMeta('pointer', true).run()
                },
            },
        })

        const focusText = () => {
            if (!editor.isDestroyed && editor.view.dom.isConnected) editor.view.focus()
        }
        queueMicrotask(() => {
            if (editor.isDestroyed) return
            editor.off('create', initializeLabel)
            initializeLabel({ editor })
            focusText()
            if (editor.view.hasFocus()) entryFocusState.set(editor, editor.state)

            // Chromium can blur the newly mounted text view when it completes
            // the entry click on the old canvas target. An actual focus move
            // provides a destination and must be left alone.
            const view = editor.view.dom
            const restoreEntryFocus = (event: FocusEvent) => {
                if (event.relatedTarget === null) {
                    queueMicrotask(() => {
                        const active = document.activeElement
                        if (document.hasFocus() && active === document.body) focusText()
                    })
                }
            }
            view.addEventListener('focusout', restoreEntryFocus, { once: true })
            requestAnimationFrame(() => view.removeEventListener('focusout', restoreEntryFocus))
        })
    },
}
