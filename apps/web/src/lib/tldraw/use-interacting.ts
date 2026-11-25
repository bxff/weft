/** True while panning/zooming the camera or moving/resizing shapes, i.e. when
 *  transient guides (tablet width, text column outline) should show. */

import { useEditor, useValue } from 'tldraw'

export function useInteracting(): boolean {
    const editor = useEditor()
    return useValue(
        'interacting',
        () => {
            if (editor.getCameraState() === 'moving') return true
            const p = editor.getPath()
            return (
                p.includes('translating') ||
                p.includes('resizing') ||
                p.includes('rotating') ||
                p.includes('dragging')
            )
        },
        [editor],
    )
}
