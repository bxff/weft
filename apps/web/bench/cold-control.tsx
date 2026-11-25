// Standalone SDK receiving the same native ink as the cold Weft import.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Tldraw, type Editor, type TLDrawShape, type TLCamera } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import 'tldraw/tldraw.css'

const { rows, camera }: { rows: TLDrawShape[]; camera: TLCamera } = await window.coldMaterial
createRoot(document.querySelector('#canvas')!).render(<Tldraw assetUrls={getAssetUrls({ baseUrl: '/sdk' })} onMount={editor => {
    editor.run(() => editor.store.put(rows.map(row => ({ ...row, parentId: editor.getCurrentPageId() }))), { history: 'ignore' })
    editor.setCamera(camera, { immediate: true })
    window.__weftEditor = editor
}} />)

declare global {
    interface Window {
        __weftEditor: Editor
        coldMaterial: Promise<{ rows: TLDrawShape[]; camera: TLCamera }>
    }
}
