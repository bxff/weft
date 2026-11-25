/**
 * Dock panel exclusivity: layers/history/template panels share one fixed
 * position, so opening one closes the others.
 */
export function announceDockOpen(id: string): void {
    window.dispatchEvent(new CustomEvent('weft:dock-open', { detail: id }))
}

export function onOtherDockOpen(id: string, close: () => void): () => void {
    const handler = (e: Event) => {
        if ((e as CustomEvent).detail !== id) close()
    }
    window.addEventListener('weft:dock-open', handler)
    return () => window.removeEventListener('weft:dock-open', handler)
}
