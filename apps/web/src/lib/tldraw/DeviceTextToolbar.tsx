/**
 * Toolbar for native typed text: H1/H2/H3, bullet and numbered lists,
 * bold, and italic. Uses tldraw's DefaultRichTextToolbar shell.
 */

import { useEffect, useState } from 'react'
import {
    DefaultRichTextToolbar,
    TldrawUiButtonIcon,
    TldrawUiToolbarButton,
    preventDefault,
    useEditor,
    useValue,
} from 'tldraw'
import { toggleDeviceMark } from './device-text-extensions'

function Buttons() {
    const editor = useEditor()
    const textEditor = useValue('textEditor', () => editor.getRichTextEditor(), [editor])
    const [, set] = useState(0)
    useEffect(() => {
        if (!textEditor) return
        const bump = () => set((t) => t + 1)
        textEditor.on('update', bump)
        textEditor.on('selectionUpdate', bump)
        return () => {
            textEditor.off('update', bump)
            textEditor.off('selectionUpdate', bump)
        }
    }, [textEditor])
    if (!textEditor) return null
    const heading = (level: 1 | 2 | 3) => ({
        name: `heading${level}`,
        text: `H${level}`,
        isActive: textEditor.isActive('heading', { level }),
        run: () => textEditor.chain().focus().toggleHeading({ level }).run(),
    })
    const items: {
        name: string
        icon?: string
        text?: string
        isActive: boolean
        run: () => void
    }[] = [
        heading(1),
        heading(2),
        heading(3),
        {
            name: 'bulletList',
            icon: 'bulletList',
            isActive: textEditor.isActive('bulletList'),
            run: () => textEditor.chain().focus().toggleBulletList().run(),
        },
        {
            name: 'orderedList',
            text: '1.',
            isActive: textEditor.isActive('orderedList'),
            run: () => textEditor.chain().focus().toggleOrderedList().run(),
        },
        {
            name: 'bold',
            icon: 'bold',
            isActive: textEditor.isActive('bold'),
            run: () => toggleDeviceMark(textEditor, 'bold'),
        },
        {
            name: 'italic',
            icon: 'italic',
            isActive: textEditor.isActive('italic'),
            run: () => toggleDeviceMark(textEditor, 'italic'),
        },
    ]
    return (
        <>
            {items.map((item) => (
                <TldrawUiToolbarButton
                    key={item.name}
                    title={item.name}
                    data-testid={`rich-text.${item.name}`}
                    type="icon"
                    isActive={item.isActive}
                    onPointerDown={preventDefault}
                    onClick={item.run}
                    role="option"
                    aria-pressed={item.isActive}
                >
                    {item.icon ? (
                        <TldrawUiButtonIcon small icon={item.icon} />
                    ) : (
                        <span
                            style={{
                                fontSize: 11,
                                fontWeight: 700,
                                minWidth: 16,
                                textAlign: 'center',
                            }}
                        >
                            {item.text}
                        </span>
                    )}
                </TldrawUiToolbarButton>
            ))}
        </>
    )
}

export function DeviceRichTextToolbar() {
    const editor = useEditor()
    const isDevice = useValue(
        'device column editing',
        () => editor.getEditingShapeId() === 'shape:device-text',
        [editor],
    )
    if (!isDevice) return <DefaultRichTextToolbar />
    return (
        <DefaultRichTextToolbar>
            <Buttons />
        </DefaultRichTextToolbar>
    )
}
