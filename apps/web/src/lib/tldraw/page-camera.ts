import type { Editor } from 'tldraw'
import { localPreferenceOwner } from '../auth'
import { connection } from '../settings'

type Camera = { x: number; y: number; z: number }
type SavedView = { page: string; camera: Camera }

const storageKey = 'weft-page-views-v1'
const maxViews = 32
const activeCameras = new WeakMap<Editor, () => void>()

function readViews(): SavedView[] {
    try {
        const rows: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
        if (!Array.isArray(rows)) return []
        return rows.filter((row): row is SavedView =>
            typeof row?.page === 'string' && Number.isFinite(row.camera?.x)
            && Number.isFinite(row.camera?.y) && Number.isFinite(row.camera?.z) && row.camera.z > 0)
    } catch {
        return []
    }
}

function preferencePage(relay: string, docId: string, pageId: string): string | null {
    try {
        if (connection().cloudUrl !== relay) return null
        const owner = localPreferenceOwner()
        return owner ? JSON.stringify([relay, owner, docId, pageId]) : null
    } catch {
        return null
    }
}

/** Restore once at open and observe the SDK's local camera records. */
export function restorePageCamera(editor: Editor, relay: string, docId: string, pageId: string, initial: Camera) {
    activeCameras.get(editor)?.()
    let page = preferencePage(relay, docId, pageId)
    const saved = page ? readViews().find(row => row.page === page) : undefined
    editor.setCamera(saved?.camera ?? initial, { immediate: true })
    let pending: SavedView | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
        clearTimeout(timer)
        timer = undefined
        const view = pending
        if (!view) return
        try {
            const views = readViews().filter(row => row.page !== view.page)
            views.unshift(view)
            localStorage.setItem(storageKey, JSON.stringify(views.slice(0, maxViews)))
        } catch {
            // The editor stays usable when local preferences cannot be saved.
        }
        pending = undefined
    }
    const unwatch = editor.store.sideEffects.registerAfterChangeHandler('camera', (_before, after) => {
        const currentPage = preferencePage(relay, docId, pageId)
        if (!currentPage || (page && page !== currentPage)) return
        // If the account became known after opening, only save new movement.
        page = currentPage
        pending = { page, camera: { x: after.x, y: after.y, z: after.z } }
        clearTimeout(timer)
        timer = setTimeout(save, 250)
    })
    window.addEventListener('pagehide', save)

    const stop = () => {
        if (activeCameras.get(editor) !== stop) return
        activeCameras.delete(editor)
        unwatch()
        window.removeEventListener('pagehide', save)
        save()
    }
    activeCameras.set(editor, stop)
    return stop
}
