<script lang="ts">
    import { onMount } from 'svelte'
    import { page } from '$app/state'
    import { replaceState } from '$app/navigation'
    import { transport, cachedDocuments } from '$lib/transport'
    import { connection, watchRelayChange } from '$lib/settings'
    import { readCachedDocumentList } from '$lib/library-cache'
    import { currentUserLabel, signIn, signOut, getAuthToken, ensureClerk, isKnownSignedOut, localPreferenceOwner } from '$lib/auth'
    import { EngineFailure, type DocumentInfo } from '@weft/sync-engine'
    import AuthImg from '$lib/components/AuthImg.svelte'
    import { clearAssetMisses } from '$lib/authedAsset'
    import StorageBanner from '$lib/components/StorageBanner.svelte'

    let docs = $state<DocumentInfo[]>([])
    let health = $state<{ model: string; firmware: string } | null>(null)
    let error = $state<string | null>(null)
    let unauthorized = $state(false)
    let loaded = $state(false)
    let thumbnailRefresh = $state(0)
    // The open folder lives in the URL (?folder=...) so leaving for a note and
    // returning lands in the same folder.
    let currentFolder = $state(page.url.searchParams.get('folder') ?? '')
    const setFolder = (id: string) => {
        currentFolder = id
        const url = new URL(page.url)
        if (id) url.searchParams.set('folder', id)
        else url.searchParams.delete('folder')
        replaceState(url, {})
    }
    let cloud = $state(false)
    let userLabel = $state<string | null>(null)

    async function loadDocuments(source = transport(), refresh = false, signal?: AbortSignal) {
        try {
            const fresh = await cachedDocuments(source, refresh)
            if (signal?.aborted) return
            docs = fresh
            unauthorized = false
            error = null
        } catch (failure) {
            if (signal?.aborted) return
            unauthorized = failure instanceof EngineFailure && failure.error._tag === 'Unauthorized'
            if (unauthorized) docs = []
            error = String(failure)
        } finally {
            if (!signal?.aborted) loaded = true
        }
    }

    onMount(() => {
        const relayWatcher = new AbortController()
        const reopen = () => {
            relayWatcher.abort()
            docs = []
            userLabel = null
            location.reload()
        }
        watchRelayChange(reopen, relayWatcher.signal)
        let owner = localPreferenceOwner()
        const checkAccount = () => {
            if (relayWatcher.signal.aborted) return
            const next = localPreferenceOwner()
            if (owner !== null && next !== owner && (next !== null || isKnownSignedOut())) reopen()
            else if (next !== null) owner = next
        }
        window.addEventListener('storage', checkAccount, { signal: relayWatcher.signal })
        let stopAccountWatch: void | (() => void)
        void ensureClerk().then((clerk) => {
            if (relayWatcher.signal.aborted) return
            checkAccount()
            if (!relayWatcher.signal.aborted) stopAccountWatch = clerk?.addListener(checkAccount)
        }).catch(() => {})
        // Re-entering the library: forget remembered 404s so thumbnails that
        // arrived while away get one fresh attempt instead of a blank tile.
        clearAssetMisses()
        // Warm the editor: the tldraw chunk is slow to fetch+parse on first
        // use. Kick the import while the user is still browsing.
        void Promise.all([
            import('react-dom/client'),
            import('react'),
            import('$lib/tldraw/TldrawApp'),
        ])
        // Warm the auth token: the first authed request mints a Clerk JWT over
        // the network. Kick it here so the editor's first fetch reads the cache.
        void getAuthToken()
        cloud = connection().mode === 'cloud'
        if (cloud) {
            void currentUserLabel().then((label) => {
                if (!relayWatcher.signal.aborted) userLabel = label
            })
        }
        // Paint the selected account's last successful list while refreshing.
        const cached = readCachedDocumentList()
        if (cached) {
            docs = cached
            loaded = true
        }
        const source = transport()
        void loadDocuments(source, false, relayWatcher.signal)
        void source.health().then((fresh) => {
            if (!relayWatcher.signal.aborted) health = fresh
        }).catch(() => {})
        const unsubscribe = source.subscribeDocList(() => {
            // New content may include thumbnails that previously 404'd.
            clearAssetMisses()
            thumbnailRefresh++
            void loadDocuments(source, false, relayWatcher.signal)
        })
        return () => {
            relayWatcher.abort()
            stopAccountWatch?.()
            unsubscribe()
        }
    })

    // Folders sit above the documents and sort alphabetically, matching the tablet.
    const folders = $derived(
        docs
            .filter((d) => d.type === 'folder' && d.parent === currentFolder)
            .sort((a, b) => a.name.localeCompare(b.name)),
    )

    // Sort mode mirrors the tablet's home-screen options, default "Last
    // modified" to match the tablet. Persisted per-browser.
    type SortMode = 'lastModified' | 'lastOpened' | 'created' | 'name' | 'pages' | 'size'
    const SORT_LABELS: Record<SortMode, string> = {
        lastModified: 'Last modified',
        lastOpened: 'Last opened',
        created: 'Date created',
        name: 'Name',
        pages: 'Page count',
        size: 'File size',
    }
    let sortMode = $state<SortMode>('lastModified')
    onMount(() => {
        const saved = localStorage.getItem('weft-library-sort')
        if (saved && saved in SORT_LABELS) {
            sortMode = saved as SortMode
            if (sortMode === 'size') void loadSizes()
        }
    })
    function setSort(mode: SortMode) {
        sortMode = mode
        try {
            localStorage.setItem('weft-library-sort', mode)
        } catch {
            // best-effort
        }
        if (mode === 'size') void loadSizes()
    }
    // Per-doc byte sizes for the "File size" sort, fetched lazily from the
    // usage breakdown only when needed.
    let sizes = $state<Map<string, number>>(new Map())
    let sizesLoaded = false
    async function loadSizes() {
        if (sizesLoaded || connection().mode !== 'cloud') return
        sizesLoaded = true
        try {
            const { apiBase } = await import('$lib/settings')
            const { authHeaders } = await import('$lib/authedAsset')
            const r = await fetch(`${apiBase()}/api/usage/breakdown`, { headers: await authHeaders() })
            if (!r.ok) return
            const body = (await r.json()) as { docs: { doc: string; totalBytes: number }[] }
            sizes = new Map(body.docs.map((d) => [d.doc, d.totalBytes]))
        } catch {
            sizesLoaded = false // allow a retry
        }
    }
    // Move = drag a notebook onto a folder card (or "library" in the breadcrumb
    // for root). A partial doc-list PUT; the daemon moves it on-device on its
    // next pull.
    let dragId = $state<string | null>(null)
    let dropTarget = $state<string | null>(null)
    // "Move to…" dialog: works at any folder depth and on touch devices, where
    // drag-and-drop can't reach nested targets.
    let moveTarget = $state<DocumentInfo | null>(null)
    let moveExpanded = $state<Set<string>>(new Set())
    const folderChildren = $derived.by(() => {
        const m = new Map<string, DocumentInfo[]>()
        for (const d of docs) {
            if (d.type !== 'folder') continue
            const parent = docs.some((x) => x.id === d.parent) ? d.parent : ''
            const list = m.get(parent) ?? []
            list.push(d)
            m.set(parent, list)
        }
        for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name))
        return m
    })
    function toggleMoveExpanded(id: string) {
        const next = new Set(moveExpanded)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        moveExpanded = next
    }
    async function pickMoveDestination(parent: string) {
        const doc = moveTarget
        moveTarget = null
        if (doc) await moveDoc(doc.id, parent)
    }

    // New notebook / folder via an inline name field. The daemon materializes
    // the xochitl files on the tablet; refetch so the new item shows at once.
    let creating = $state<'notebook' | 'folder' | null>(null)
    let newName = $state('')
    let creatingBusy = $state(false)
    function startCreate(kind: 'notebook' | 'folder') {
        creating = kind
        newName = ''
    }
    async function submitCreate() {
        if (!creating || creatingBusy) return
        const kind = creating
        const name = newName.trim()
        creatingBusy = true
        try {
            const { apiBase } = await import('$lib/settings')
            const { authHeaders } = await import('$lib/authedAsset')
            const r = await fetch(`${apiBase()}/api/documents/new`, {
                method: 'POST',
                headers: { ...(await authHeaders()), 'content-type': 'application/json' },
                body: JSON.stringify({ name, kind, parent: currentFolder }),
            })
            if (r.ok) {
                creating = null
                newName = ''
                docs = await cachedDocuments(transport(), true).catch(() => docs)
            }
        } finally {
            creatingBusy = false
        }
    }
    // Import: drop .rm files on the library to create one notebook per file in
    // the current folder. Reacts only to OS file drags; the move drag carries
    // text/plain (never Files), so the paths can't collide. Depth counter
    // because dragleave fires on every child.
    let fileDragDepth = $state(0)
    let importBusy = $state<string | null>(null)
    let importErrors = $state<string[]>([])
    const isFileDrag = (e: DragEvent) =>
        !dragId && !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    async function importFiles(files: File[]) {
        importErrors = []
        const rm = files.filter((f) => f.name.toLowerCase().endsWith('.rm'))
        if (rm.length < files.length) {
            const n = files.length - rm.length
            importErrors = [...importErrors, `${n} file${n === 1 ? '' : 's'} skipped, only .rm files import`]
        }
        if (!rm.length) return
        const { apiBase } = await import('$lib/settings')
        const { authHeaders } = await import('$lib/authedAsset')
        for (const f of rm) {
            importBusy = f.name
            try {
                const q = new URLSearchParams({
                    name: f.name.replace(/\.rm$/i, ''),
                    parent: currentFolder,
                })
                const r = await fetch(`${apiBase()}/api/documents/import?${q}`, {
                    method: 'POST',
                    headers: { ...(await authHeaders()), 'content-type': 'application/octet-stream' },
                    body: await f.arrayBuffer(),
                })
                if (!r.ok) {
                    const msg = ((await r.json().catch(() => null)) as { error?: string } | null)?.error
                    importErrors = [...importErrors, `${f.name}: ${msg ?? `import failed (${r.status})`}`]
                }
            } catch {
                importErrors = [...importErrors, `${f.name}: import failed`]
            }
        }
        importBusy = null
        docs = await cachedDocuments(transport(), true).catch(() => docs)
    }

    async function moveDoc(id: string, parent: string) {
        const cached = docs.find((d) => d.id === id)
        if (!cached || cached.parent === parent) return
        // Never move a folder into itself or a descendant (parent cycle). The
        // server clamps cycles to root, but catching it here avoids an
        // optimistic UI flip that reverts on the next fetch.
        if (cached.type === 'folder') {
            const byId = new Map(docs.map((d) => [d.id, d]))
            const seen = new Set<string>()
            let p: string | undefined = parent
            while (p && !seen.has(p)) {
                if (p === id) return // target sits under the folder being moved
                seen.add(p)
                p = byId.get(p)?.parent
            }
        }
        const { apiBase } = await import('$lib/settings')
        const { authHeaders } = await import('$lib/authedAsset')
        // Reflect the move in the grid immediately, not after the round-trip.
        // The doc-list is whole-doc LWW on the server, so the PUT below only
        // persists; the UI can lead. Revert to prevParent if the PUT fails.
        const prevParent = cached.parent
        docs = docs.map((d) => (d.id === id ? { ...d, parent } : d))
        // Base the PUT on the doc's CURRENT server state, not the cached grid
        // copy. The server merge is whole-doc LWW on lastModified, so PUTting a
        // stale cached doc stamped "now" would revert any newer tablet state we
        // haven't pulled yet — e.g. a rename the tablet just made (#76). Refetch
        // fresh, then change only `parent`. (A sub-second window remains if the
        // tablet edits again between this fetch and the PUT; closing it fully
        // needs the movable-tree CRDT follow-up, #80.)
        let doc = { ...cached, parent }
        try {
            const fresh = await cachedDocuments(transport(), true)
            const f = fresh.find((d) => d.id === id)
            if (!f) {
                docs = fresh // deleted on the tablet meanwhile — adopt server truth
                return
            }
            // adopt fresh fields for everything, but KEEP our optimistic parent
            // on the moved doc so the grid doesn't flicker back mid-flight
            docs = fresh.map((d) => (d.id === id ? { ...d, parent } : d))
            doc = { ...f, parent }
        } catch {
            // offline / fetch failed: fall back to the cached copy. There is no
            // fresher server state reachable to clobber, so this is best-effort.
        }
        // #80: claim ONLY the parent field (fieldStamps) — the carried name
        // must not win over a concurrent tablet rename. lastModified still
        // bumps so the daemon's device-ward apply fires.
        const now = Date.now()
        const r = await fetch(`${apiBase()}/api/documents`, {
            method: 'PUT',
            headers: { ...(await authHeaders()), 'content-type': 'application/json' },
            body: JSON.stringify({
                documents: [
                    { ...doc, parent, lastModified: now, fieldStamps: { parent: now } },
                ],
            }),
        })
        if (!r.ok) {
            // persist failed: undo the optimistic move so the grid matches reality
            docs = docs.map((d) => (d.id === id ? { ...d, parent: prevParent } : d))
        }
    }
    const notebooks = $derived.by(() => {
        const list = docs.filter((d) => d.type !== 'folder' && d.parent === currentFolder)
        const byName = (a: DocumentInfo, b: DocumentInfo) => a.name.localeCompare(b.name)
        // recency/count sorts are DESC (newest/biggest first); name is ASC.
        // Name is the stable tiebreak so equal keys have a deterministic order.
        const desc = (key: (d: DocumentInfo) => number) => (a: DocumentInfo, b: DocumentInfo) =>
            key(b) - key(a) || byName(a, b)
        switch (sortMode) {
            case 'name':
                return list.sort(byName)
            case 'lastOpened':
                return list.sort(desc((d) => d.lastOpened ?? 0))
            case 'created':
                return list.sort(desc((d) => d.createdTime ?? 0))
            case 'pages':
                return list.sort(desc((d) => d.pages.length))
            case 'size':
                return list.sort(desc((d) => sizes.get(d.id) ?? 0))
            case 'lastModified':
            default:
                return list.sort(desc((d) => d.lastModified ?? 0))
        }
    })
    const breadcrumb = $derived.by(() => {
        const trail: { id: string; name: string }[] = []
        let cursor = currentFolder
        while (cursor) {
            const folder = docs.find((d) => d.id === cursor)
            if (!folder) break
            trail.unshift({ id: folder.id, name: folder.name })
            cursor = folder.parent
        }
        return trail
    })

    function docCount(folderId: string): number {
        return docs.filter((d) => d.parent === folderId).length
    }

    // The small caption under each card reflects the ACTIVE sort, so the
    // ordering is legible (e.g. sorting by page count shows "12 pages").
    function sortCaption(doc: DocumentInfo): string {
        switch (sortMode) {
            case 'lastOpened':
                return doc.lastOpened ? fmtDate(doc.lastOpened) : 'never opened'
            case 'created':
                return fmtDate(doc.createdTime)
            case 'name':
                return fmtDate(doc.lastModified)
            case 'pages':
                return `${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}`
            case 'size': {
                const b = sizes.get(doc.id)
                return b === undefined ? '' : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`
            }
            case 'lastModified':
            default:
                return fmtDate(doc.lastModified)
        }
    }

    function fmtDate(ms?: number): string {
        if (!ms) return ''
        return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="min-h-screen"
    ondragenter={(e) => {
        if (!cloud || !isFileDrag(e)) return
        e.preventDefault()
        fileDragDepth += 1
    }}
    ondragover={(e) => {
        if (cloud && isFileDrag(e)) e.preventDefault()
    }}
    ondragleave={(e) => {
        if (cloud && isFileDrag(e)) fileDragDepth = Math.max(0, fileDragDepth - 1)
    }}
    ondrop={(e) => {
        if (!cloud || !isFileDrag(e)) return
        e.preventDefault()
        fileDragDepth = 0
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length) void importFiles(files)
    }}
>
    {#if fileDragDepth > 0}
        <div class="pointer-events-none fixed inset-0 z-[400] flex items-center justify-center" style="background: rgba(0,0,0,0.55)">
            <div class="border px-8 py-6 text-[15px]" style="background: var(--gray-1); border-color: var(--blue); border-radius: var(--radius); color: var(--gray-f)">
                Drop to import{breadcrumb.length ? ` into ${breadcrumb[breadcrumb.length - 1].name}` : ''}
            </div>
        </div>
    {/if}
    <header class="border-b" style="border-color: var(--gray-2); background: var(--gray-0)">
        <div class="mx-auto flex max-w-[1280px] items-center justify-between px-4 py-4">
            <a href="/" class="wf-wordmark select-none">weft</a>
            <!-- the account email is long: hide it on phones so the nav stays
                 one row instead of squishing into a column -->
            <nav class="flex shrink-0 items-center gap-3 text-[1rem] sm:gap-4">
                <span class="hidden text-gray-7 sm:inline">
                    {#if cloud}{userLabel ?? ''}{:else if health}{health.model || 'tablet'}{:else}offline{/if}
                </span>
                <span class="hidden text-gray-6 sm:inline">|</span>
                <a href="/settings" class="wf-nav">Settings</a>
                {#if cloud && userLabel}
                    <button class="wf-nav cursor-pointer" onclick={() => void signOut().then(() => location.reload())}>
                        Sign out
                    </button>
                {/if}
            </nav>
        </div>
    </header>

    {#if cloud}<StorageBanner />{/if}

    {#if importBusy || importErrors.length}
        <div class="mx-auto max-w-[1280px] px-4 pt-4 text-[13px]">
            {#if importBusy}<p style="color: var(--gray-7)">Importing {importBusy}…</p>{/if}
            {#each importErrors as err (err)}
                <p style="color: var(--red)">{err}</p>
            {/each}
        </div>
    {/if}

    <main class="mx-auto max-w-[1280px] px-4 pb-20">
        {#if !loaded}
            <p class="py-24 text-center text-gray-7">Loading…</p>
        {:else if unauthorized && cloud}
            <div class="mx-auto mt-24 max-w-sm border p-10 text-center" style="border-color: var(--gray-2); border-radius: var(--radius); background: var(--gray-1)">
                <p class="text-gray-7">Signed out</p>
                <h2 class="mt-3 text-2xl font-bold" style="color: var(--gray-f)">Sign in to see your notebooks</h2>
                <button onclick={() => void signIn()} class="wf-link mt-6 inline-block cursor-pointer">Go to sign in &rarr;</button>
            </div>
        {:else if error && docs.length === 0}
            <div class="mx-auto mt-24 max-w-md border p-10 text-center" style="border-color: var(--gray-2); border-radius: var(--radius); background: var(--gray-1)">
                <p class="text-gray-7">Couldn’t load your notebooks.</p>
                <button onclick={() => void loadDocuments(transport(), true)} class="wf-link mt-5 inline-block cursor-pointer">Retry</button>
            </div>
        {:else if cloud && docs.length === 0}
            <!-- A successful empty list is the setup state. -->
            <div class="mx-auto mt-24 max-w-md border p-10 text-center" style="border-color: var(--gray-2); border-radius: var(--radius); background: var(--gray-1)">
                <p class="text-gray-7">No notebooks yet</p>
                <h2 class="mt-3 text-2xl font-bold" style="color: var(--gray-f)">Set up your tablet to sync</h2>
                <p class="mt-3 text-sm leading-relaxed" style="color: var(--gray-7)">
                    You're signed in. Pair your reMarkable once and its notebooks
                    sync to your account here automatically.
                </p>
                <a href="/install" class="wf-link mt-5 inline-block">Set up your tablet &rarr;</a>
            </div>
        {:else}
            <!-- title row -->
            <div class="flex items-baseline justify-between border-b py-8" style="border-color: var(--gray-2)">
                <div class="flex items-baseline gap-4">
                    <h1 class="text-[28px] font-bold" style="color: var(--gray-f); letter-spacing: -0.01em">
                        {breadcrumb.length ? breadcrumb[breadcrumb.length - 1].name : 'Library'}
                    </h1>
                    <nav class="flex items-center gap-1.5 text-gray-7">
                        {#if breadcrumb.length}
                            <button
                                class="wf-nav"
                                style={dropTarget === '' && dragId ? 'color: var(--blue)' : ''}
                                onclick={() => setFolder('')}
                                ondragover={(e) => {
                                    if (!dragId) return
                                    e.preventDefault()
                                    dropTarget = ''
                                }}
                                ondragleave={() => (dropTarget = null)}
                                ondrop={(e) => {
                                    e.preventDefault()
                                    if (dragId) void moveDoc(dragId, '')
                                    dragId = null
                                    dropTarget = null
                                }}
                            >library</button>
                            {#each breadcrumb.slice(0, -1) as crumb (crumb.id)}
                                <span>/</span>
                                <button class="wf-nav" onclick={() => setFolder(crumb.id)}>{crumb.name}</button>
                            {/each}
                            <span>/</span>
                        {/if}
                    </nav>
                </div>
                <div class="flex items-center gap-4 text-[13px]">
                    {#if creating}
                        <!-- svelte-ignore a11y_autofocus -->
                        <input
                            autofocus
                            bind:value={newName}
                            placeholder={creating === 'folder' ? 'Folder name' : 'Notebook name'}
                            disabled={creatingBusy}
                            onkeydown={(e) => {
                                if (e.key === 'Enter') void submitCreate()
                                else if (e.key === 'Escape') creating = null
                            }}
                            class="border px-2 py-1 text-[13px] outline-none focus:border-[var(--blue)]"
                            style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-0); color: var(--gray-b)"
                        />
                        <button class="wf-nav cursor-pointer" disabled={creatingBusy} onclick={() => void submitCreate()}>
                            Create
                        </button>
                        <button class="wf-nav cursor-pointer" onclick={() => (creating = null)}>Cancel</button>
                    {:else}
                        <button class="wf-nav cursor-pointer" onclick={() => startCreate('notebook')}>New notebook</button>
                        <button class="wf-nav cursor-pointer" onclick={() => startCreate('folder')}>New folder</button>
                    {/if}
                    <label class="flex items-center gap-2" style="color: var(--gray-7)">
                        <span>Sort</span>
                        <select
                            data-testid="library-sort"
                            value={sortMode}
                            onchange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as SortMode)}
                            class="cursor-pointer border px-2 py-1 text-[13px] outline-none focus:border-[var(--blue)]"
                            style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-0); color: var(--gray-b)"
                        >
                            {#each Object.entries(SORT_LABELS) as [mode, label] (mode)}
                                <option value={mode}>{label}</option>
                            {/each}
                        </select>
                    </label>
                    <span style="color: var(--gray-7)">{notebooks.length} document{notebooks.length === 1 ? '' : 's'}</span>
                </div>
            </div>

            <!-- folders: compact index tabs, not cards -->
            {#if folders.length}
                <div class="flex flex-wrap gap-2.5 border-b py-5" style="border-color: var(--gray-2)">
                    {#each folders as folder (folder.id)}
                        <button
                            class="group flex items-center gap-3 border px-4 py-2.5 transition hover:border-[var(--gray-f)]"
                            style={`border-color: ${dropTarget === folder.id ? 'var(--blue)' : 'var(--gray-3)'}; border-radius: var(--radius); background: var(--gray-1)`}
                            onclick={() => setFolder(folder.id)}
                            ondragover={(e) => {
                                if (!dragId) return
                                e.preventDefault()
                                dropTarget = folder.id
                            }}
                            ondragleave={() => (dropTarget = null)}
                            ondrop={(e) => {
                                e.preventDefault()
                                if (dragId) void moveDoc(dragId, folder.id)
                                dragId = null
                                dropTarget = null
                            }}
                        >
                            <span class="text-gray-6 group-hover:text-[var(--gray-f)]">/</span>
                            <span class="text-[13.5px]" style="color: var(--gray-b)">{folder.name}</span>
                            <span class="text-[11px]" style="color: var(--gray-7)">{docCount(folder.id)}</span>
                        </button>
                    {/each}
                </div>
            {/if}

            <!-- documents: the thumbnail IS the object -->
            <div class="grid grid-cols-2 gap-x-7 gap-y-10 pt-8 sm:grid-cols-3 lg:grid-cols-5">
                {#each notebooks as doc (doc.id)}
                    {#if doc.pages.length > 0}
                        <!-- Cover = whatever page the TABLET uses as its cover:
                             the daemon resolves .content coverPageNumber (-1 =
                             last-visited page, N>=0 = fixed page) to `coverPage`.
                             We use exactly that, so the web cover always matches
                             the device. Fall back to page 1 only when the daemon
                             didn't supply one (older data). No fallthrough to
                             other pages (that showed a viewed page and caused the
                             mismatch). (The open link still deep-links to
                             lastOpenedPage.) -->
                        {@const coverPageId =
                            (doc.coverPage && doc.pages.some((p) => p.id === doc.coverPage)
                                ? doc.coverPage
                                : doc.pages[0].id)}
                        {@const thumbPaths = [
                            `/api/documents/${doc.id}/pages/${coverPageId}/thumbnail`,
                        ]}
                        <div class="group">
                        <a
                            href={`/app/${doc.id}/${doc.lastOpenedPage && doc.pages.some((p) => p.id === doc.lastOpenedPage) ? doc.lastOpenedPage : doc.pages[0].id}`}
                            draggable={cloud}
                            ondragstart={(e) => {
                                dragId = doc.id
                                e.dataTransfer?.setData('text/plain', doc.id)
                                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                            }}
                            ondragend={() => {
                                dragId = null
                                dropTarget = null
                            }}
                        >
                            <div
                                class="relative aspect-[3/4] overflow-hidden border transition group-hover:border-[var(--gray-f)]"
                                style="border-color: var(--gray-2); border-radius: var(--radius); background-color: var(--gray-1)"
                            >
                                <AuthImg
                                    paths={thumbPaths}
                                    refreshKey={thumbnailRefresh}
                                    alt=""
                                    class="absolute inset-0 h-full w-full object-cover object-top"
                                    placeholder={doc.name}
                                />
                                {#if doc.type !== 'notebook'}
                                    <span class="absolute top-2 right-2 border px-1.5 py-0.5 text-gray-7" style="background: var(--gray-0); border-color: var(--gray-3); border-radius: 2px; font-size: 9.5px">
                                        {doc.type}
                                    </span>
                                {/if}
                            </div>
                            <div class="mt-2.5 flex items-baseline justify-between gap-2">
                                <span class="line-clamp-1 text-[13.5px]" style="color: var(--gray-b)">{doc.name}</span>
                                <span class="shrink-0 text-[10.5px]" style="color: var(--gray-7)">{sortCaption(doc)}</span>
                            </div>
                        </a>
                        <div class="flex items-baseline justify-between">
                            <span class="text-[10.5px]" style="color: var(--gray-7)">{doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}</span>
                            {#if cloud}
                                <button
                                    class="wf-move-btn text-[10.5px]"
                                    style="color: var(--gray-6); background: none; border: none; cursor: pointer; padding: 0"
                                    data-testid={`move-open-${doc.id}`}
                                    onclick={(e) => {
                                        e.preventDefault()
                                        moveTarget = doc
                                    }}
                                >
                                    move…
                                </button>
                            {/if}
                        </div>
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}
    </main>

    {#if moveTarget}
        {#snippet moveNode(items: DocumentInfo[], depth: number)}
            {#each items as f (f.id)}
                <div class="flex items-center gap-1" style={`padding-left: ${depth * 16}px`}>
                    {#if folderChildren.get(f.id)?.length}
                        <button
                            class="w-4 shrink-0 cursor-pointer text-left"
                            style="color: var(--gray-6); background: none; border: none; padding: 0"
                            onclick={() => toggleMoveExpanded(f.id)}
                        >
                            {moveExpanded.has(f.id) ? '▾' : '▸'}
                        </button>
                    {:else}
                        <span class="w-4 shrink-0"></span>
                    {/if}
                    <button
                        class="flex-1 cursor-pointer truncate rounded px-2 py-1.5 text-left text-[13px] hover:bg-[var(--gray-2)]"
                        style={`background: none; border: none; color: ${moveTarget?.parent === f.id ? 'var(--gray-5)' : 'var(--gray-b)'}`}
                        disabled={moveTarget?.parent === f.id}
                        data-testid={`move-dest-${f.id}`}
                        onclick={() => void pickMoveDestination(f.id)}
                    >
                        {f.name}/
                    </button>
                </div>
                {#if moveExpanded.has(f.id) && folderChildren.get(f.id)?.length}
                    {@render moveNode(folderChildren.get(f.id)!, depth + 1)}
                {/if}
            {/each}
        {/snippet}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
            class="fixed inset-0 z-[500] flex items-center justify-center p-4"
            style="background: rgba(0,0,0,0.6)"
            onclick={() => (moveTarget = null)}
            data-testid="move-dialog"
        >
            <div
                class="flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden border"
                style="background: var(--gray-1); border-color: var(--gray-3); border-radius: var(--radius)"
                onclick={(e) => e.stopPropagation()}
            >
                <div class="border-b px-4 py-3 text-[13px]" style="border-color: var(--gray-2); color: var(--gray-c)">
                    Move “<span style="color: var(--gray-f)">{moveTarget.name}</span>” to…
                </div>
                <div class="flex-1 overflow-y-auto p-2">
                    <button
                        class="w-full cursor-pointer truncate rounded px-2 py-1.5 text-left text-[13px] hover:bg-[var(--gray-2)]"
                        style={`background: none; border: none; color: ${!moveTarget.parent ? 'var(--gray-5)' : 'var(--gray-b)'}`}
                        disabled={!moveTarget.parent}
                        data-testid="move-dest-root"
                        onclick={() => void pickMoveDestination('')}
                    >
                        My files
                    </button>
                    {@render moveNode(folderChildren.get('') ?? [], 1)}
                </div>
                <button
                    class="cursor-pointer border-t px-4 py-2.5 text-left text-[12px]"
                    style="border-color: var(--gray-2); color: var(--gray-7); background: none"
                    onclick={() => (moveTarget = null)}
                >
                    Cancel
                </button>
            </div>
        </div>
    {/if}
</div>
