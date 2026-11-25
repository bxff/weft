<script lang="ts">
    import { onMount } from 'svelte'
    import { afterNavigate, beforeNavigate, goto } from '$app/navigation'
    import { navigating } from '$app/state'
    import type { StudioController } from './tldraw/controller'
    import { useReplica } from './replicaSweep'

    let { docId, pageId }: { docId: string; pageId: string } = $props()
    let downloadFailed = $state(false)
    // Protect the offline page as soon as its route mounts, including while
    // the editor bundle is still downloading.
    $effect.pre(() => {
        if (downloadFailed) return
        const key = `${docId}/${pageId}`
        const lifetime = new AbortController()
        void useReplica(key, lifetime.signal).catch(() => {})
        return () => lifetime.abort()
    })
    let container: HTMLDivElement

    let root: import('react-dom/client').Root | null = null
    let createElement: typeof import('react').createElement | null = null
    let TldrawApp: typeof import('./tldraw/TldrawApp').TldrawApp | null = null
    let controller: StudioController | null = null
    let frozen: { docId: string; pageId: string; focus: HTMLElement | null } | null = null
    function resumeEditor(restoreFocus = false) {
        if (!frozen) return
        const focus = frozen.focus
        frozen = null
        container.inert = false
        if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true })
    }
    function watchNavigation(completion: Promise<void>, outgoing: NonNullable<typeof frozen>) {
        void completion.catch(() => {
            if (frozen !== outgoing) return
            const replacement = navigating.complete
            if (replacement && replacement !== completion) {
                // SvelteKit skips beforeNavigate for some superseding
                // transitions. Keep the outgoing editor frozen for those too.
                watchNavigation(replacement, outgoing)
            } else {
                resumeEditor(true)
            }
        })
    }
    const onController = (next: StudioController | null) => {
        controller = next
        // React can swap the persistent editor after SvelteKit has committed.
        if (next && frozen && (frozen.docId !== docId || frozen.pageId !== pageId)) resumeEditor()
    }
    let saving = $state(false)
    let saveError = $state('')
    let navigation = 0
    let historyEntry = ''
    afterNavigate(() => {
        historyEntry = JSON.stringify(history.state)
        if (frozen?.docId === docId && frozen.pageId === pageId) resumeEditor()
    })

    beforeNavigate((nav) => {
        if (!nav.willUnload) controller?.completeNavigationGesture()
        if (!controller?.hasUnsavedEdits && !saving) {
            if (nav.willUnload || !nav.to || frozen) return
            const focus = document.activeElement
            const outgoing = frozen = {
                docId, pageId,
                focus: focus instanceof HTMLElement && container.contains(focus) ? focus : null,
            }
            // The destination may still be loading. Stop input before passing
            // the last durability check, even if the editor started clean.
            container.inert = true
            outgoing.focus?.blur()
            controller?.blurForNavigation()
            if (!controller?.hasUnsavedEdits) {
                watchNavigation(nav.complete, outgoing)
                return
            }
            resumeEditor()
        }
        nav.cancel()
        if (nav.willUnload || !nav.to) return
        const attempt = ++navigation
        const outgoing = controller
        const destination = nav.to.url
        // A cancelled back/forward navigation first returns to the old history
        // entry. Wait for that restoration before replaying its delta.
        const restored = nav.type === 'popstate'
            ? new Promise<void>((resolve, reject) => {
                const expected = historyEntry
                const timeout = setTimeout(() => {
                    window.removeEventListener('popstate', listener)
                    reject(new Error('History restoration did not complete'))
                }, 5000)
                const listener = (event: PopStateEvent) => {
                    if (JSON.stringify(event.state) !== expected) return
                    clearTimeout(timeout)
                    window.removeEventListener('popstate', listener)
                    resolve()
                }
                window.addEventListener('popstate', listener)
            }) : Promise.resolve()
        saving = true
        saveError = ''
        void (async () => {
            try {
                await Promise.all([outgoing?.saveBeforeNavigation(), restored])
                if (attempt !== navigation) return
                saving = false
                if (nav.type === 'popstate') history.go(nav.delta)
                else await goto(destination)
            } catch {
                if (attempt !== navigation) return
                saving = false
                saveError = 'Your latest edits could not be saved on this device. Stay on this page and try again.'
            }
        })()
    })

    onMount(() => {
        let cancelled = false
        // Lazy-load React + tldraw so landing stays light. Root is created once
        // and reused; page/doc switches re-render TldrawApp instead of remounting.
        void (async () => {
            const nav = (window as unknown as { __weftNavAt?: number }).__weftNavAt ?? 0
            const since = () => (performance.now() - nav).toFixed(0)
            const modules = await Promise.all([
                import('react'),
                import('react-dom/client'),
                import('./tldraw/TldrawApp'),
            ]).catch(() => {
                if (!cancelled) downloadFailed = true
                return null
            })
            if (cancelled || !modules) return
            const [react, { createRoot }, mod] = modules
            console.debug(`weft:boot chunk-loaded +${since()}ms after nav`)
            createElement = react.createElement
            TldrawApp = mod.TldrawApp
            root = createRoot(container)
            root.render(createElement(TldrawApp, { docId, pageId, onController }))
            console.debug(`weft:boot react-render-called +${since()}ms after nav`)
        })()
        return () => {
            cancelled = true
            root?.unmount()
            root = null
        }
    })

    // Re-render (not remount) on route change: TldrawApp keeps one <Tldraw>
    // mounted and swaps content internally.
    $effect(() => {
        const d = docId
        const p = pageId
        if (root && createElement && TldrawApp) {
            root.render(createElement(TldrawApp, { docId: d, pageId: p, onController }))
        }
    })
</script>

<div bind:this={container} class="fixed inset-0"></div>

{#if downloadFailed}
    <div role="alert" class="fixed bottom-4 left-1/2 z-[500] -translate-x-1/2 rounded bg-white px-3 py-2 text-black">
        Could not load the editor.
        <button type="button" class="underline" onclick={() => window.location.reload()}>Reload page</button>
    </div>
{:else if saving || saveError}
    <div role="alert" class="fixed bottom-4 left-1/2 z-[500] -translate-x-1/2 bg-white p-3 text-black">
        {saving ? 'Saving your latest edits…' : saveError}
    </div>
{/if}
