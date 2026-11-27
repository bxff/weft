<script lang="ts">
    import { onMount } from 'svelte'
    import { afterNavigate, beforeNavigate } from '$app/navigation'
    import { page } from '$app/state'
    import Editor from '$lib/Editor.svelte'
    import { cachedDocuments, resetTransport, transport } from '$lib/transport'
    import { readCachedDocumentList } from '$lib/library-cache'
    import { getAuthToken, guardedPageScope, isKnownSignedOut, localPreferenceOwner } from '$lib/auth'
    import { connection, watchRelayChange } from '$lib/settings'
    import type { DocumentInfo } from '@weft/sync-engine'

    const docId = $derived(page.params.doc!)
    const pageId = $derived(page.params.page!)

    // Mark when this page open began so open laps measure from the navigation,
    // not from tab open.
    $effect(() => {
        void docId
        void pageId
        ;(window as unknown as { __weftNavAt?: number }).__weftNavAt = performance.now()
    })

    const guarded = import.meta.env.PUBLIC_GUARDED_SAVES === '1'
    let guardedOwner: string | null = null
    let guardedReloadRequired = $state(false)
    let notebookRelay: string | null = null
    let notebookOwner: string | null = null
    let ownerChanged = false
    let scopeChanged = $state(false)
    let reconnectRequired = $state(false)

    function checkNotebookScope(): boolean {
        if (guarded && guardedOwner && guardedPageScope()?.key !== guardedOwner) {
            // A mounted guarded editor never changes account in place. Preserve
            // its journal under the original scope and require a fresh open.
            guardedReloadRequired = true
        }
        if (guardedReloadRequired) return true
        if (notebookOwner !== null) {
            const owner = localPreferenceOwner()
            if (owner !== null) ownerChanged = owner !== notebookOwner
            else if (isKnownSignedOut()) ownerChanged = true
            // When an offline token expires, keep the previous verdict until
            // the active account is known again.
        }
        const changed = notebookRelay !== null && (notebookRelay !== connection().cloudUrl || ownerChanged)
        if (changed && !scopeChanged) {
            resetTransport()
            reconnectRequired = true
        }
        scopeChanged = changed
        return changed
    }

    function opensAppPage(url: URL): boolean {
        return url.origin === window.location.origin && /^\/(app|library|settings)(\/|$)/.test(url.pathname)
    }

    // Keep the outgoing notebook mounted while its pending edits still
    // belong to the original relay. The Settings link opens a separate tab.
    beforeNavigate(({ cancel, to, type }) => {
        if (type !== 'leave' && to?.url && opensAppPage(to.url) && checkNotebookScope()) cancel()
    })

    afterNavigate(({ from, to }) => {
        if (to?.url && from?.url?.pathname !== to.url.pathname && !checkNotebookScope()) reconnectRequired = false
    })

    onMount(() => {
        notebookRelay = connection().cloudUrl
        notebookOwner = localPreferenceOwner()
        guardedOwner = guarded ? guardedPageScope()?.key ?? null : null
        const listener = new AbortController()
        watchRelayChange(checkNotebookScope, listener.signal)
        window.addEventListener('storage', checkNotebookScope, { signal: listener.signal })
        // Also fence ordinary links that the browser may follow without a
        // SvelteKit navigation intent, such as a full same-origin load.
        window.addEventListener('click', (event) => {
            const link = event.target instanceof Element ? event.target.closest('a[href]') : null
            if (!(link instanceof HTMLAnchorElement) || !opensAppPage(new URL(link.href))) return
            if (link.pathname === '/settings' && link.target === '_blank') return
            if (checkNotebookScope()) event.preventDefault()
        }, { capture: true, signal: listener.signal })
        void getAuthToken().then(() => {
            if (listener.signal.aborted || notebookRelay !== connection().cloudUrl) return
            notebookOwner ??= localPreferenceOwner()
            checkNotebookScope()
        }).catch(() => {})
        return () => listener.abort()
    })

    let docs = $state<DocumentInfo[]>([])
    const doc = $derived(docs.find((d) => d.id === docId) ?? null)
    onMount(() => {
        // The header and canvas share both the cache and the fresh request.
        docs = readCachedDocumentList() ?? []
        const source = transport()
        let disposed = false
        const refresh = () => {
            void cachedDocuments(source).then((next) => {
                if (!disposed && !checkNotebookScope()) docs = next
            }).catch(() => {})
        }
        refresh()
        const unsubscribe = source.subscribeDocList(refresh)
        return () => {
            disposed = true
            unsubscribe()
        }
    })

    const pageIndex = $derived(doc?.pages.findIndex((p) => p.id === pageId) ?? -1)
    // Back into the folder this doc lives in, not the library root ('' and
    // 'trash' mean root).
    const backHref = $derived(
        doc?.parent && doc.parent !== 'trash'
            ? `/library?folder=${encodeURIComponent(doc.parent)}`
            : '/library',
    )
</script>

<!-- top-center: tldraw owns top-left (toolbar) and top-right (style panel) -->
<div
    inert={scopeChanged || guardedReloadRequired}
    class="fixed top-2 left-1/2 z-[250] flex max-w-[calc(100vw-16px)] -translate-x-1/2 flex-nowrap items-center gap-2 overflow-hidden border px-3 py-1.5 whitespace-nowrap sm:gap-3"
    style="border-color: var(--gray-3); border-radius: var(--radius); background: color-mix(in srgb, var(--gray-1) 96%, transparent)"
>
    <a
        href={backHref}
        class="wf-nav"
    >
        ← Files
    </a>
    {#if doc}
        <span class="h-3.5 w-px" style="background: var(--gray-3)"></span>
        <span class="max-w-24 truncate text-[13px] sm:max-w-48" style="color: var(--gray-f)">{doc.name}</span>
        {#if doc.pages.length > 1}
            <nav class="flex items-center gap-2" data-testid="page-strip">
                {#if pageIndex > 0}
                    <a
                        class="wf-nav px-1 text-[15px] leading-none"
                        href={`/app/${docId}/${doc.pages[pageIndex - 1].id}`}>‹</a
                    >
                {/if}
                <span class="text-[11px]" style="color: var(--gray-7)">{pageIndex + 1} / {doc.pages.length}</span>
                {#if pageIndex >= 0 && pageIndex < doc.pages.length - 1}
                    <a
                        class="wf-nav px-1 text-[15px] leading-none"
                        href={`/app/${docId}/${doc.pages[pageIndex + 1].id}`}>›</a
                    >
                {/if}
            </nav>
        {/if}
    {/if}
</div>

<!-- No {#key} here: a page/doc switch must not tear down and rebuild the tldraw
     editor (its mount is the dominant open cost). Editor persists across
     navigations and swaps only the page content on docId/pageId change. -->
<div inert={scopeChanged || reconnectRequired || guardedReloadRequired} class:invisible={scopeChanged || reconnectRequired || guardedReloadRequired}>
    <Editor {docId} {pageId} />
</div>

{#if scopeChanged || reconnectRequired || guardedReloadRequired}
    <p role="status"
        class="fixed top-14 left-1/2 z-[250] w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 border px-3 py-2 text-sm"
        style="border-color: var(--gray-3); background: var(--gray-1)"
    >
        {#if guardedReloadRequired}
            Notebook paused because the connection changed.
            <button type="button" class="underline" onclick={() => window.location.reload()}>Reload to reopen</button>
        {:else if scopeChanged}
            Notebook paused because the connection changed.
            <a class="underline" href="/settings" target="_blank" rel="noopener">Open Settings in a new tab</a>
            to select the original relay and account.
        {:else}
            Original connection selected. Switch pages or return to Files to reopen this notebook.
        {/if}
    </p>
{/if}
