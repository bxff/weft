<script lang="ts">
    import { onMount } from 'svelte'
    import { connection, setCloudUrl, isSelfHosted, docsUrl } from '$lib/settings'
    import { clerkEnabled, currentUserLabel, ensureClerk, signIn, signOut } from '$lib/auth'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'

    let selfHost = $state(false)
    let serverUrl = $state('')
    let userLabel = $state<string | null>(null)
    let saved = $state(false)

    let seenLabel: string | null = null

    onMount(() => {
        selfHost = isSelfHosted()
        serverUrl = selfHost ? connection().cloudUrl : ''
        void refreshUser()
        if (clerkEnabled()) {
            void ensureClerk().then((clerk) =>
                clerk?.addListener(() => {
                    void onClerkChange()
                }),
            )
        }
    })

    async function refreshUser() {
        userLabel = await currentUserLabel()
        seenLabel = userLabel
    }

    // On an identity switch (login as a different user, no explicit sign-out) the
    // browser still holds the previous account's cached doc list + label and
    // paints from it, so purge those and reload. A token refresh (same label)
    // just updates; sign-out (label null) is handled by signOut().
    async function onClerkChange() {
        const label = await currentUserLabel()
        if (seenLabel !== null && label !== null && label !== seenLabel) {
            try {
                localStorage.removeItem('weft-docs-cache')
                localStorage.removeItem('weft-user-label')
            } catch {
                // best-effort
            }
            location.reload()
            return
        }
        seenLabel = label
        userLabel = label
    }

    // Per-doc storage breakdown, class meters (notes vs PDFs), the residency
    // chip for tablet-only sources, and daemon-filed sync failure reports.
    interface DocUsage {
        doc: string
        blobBytes: number
        opsBytes: number
        snapshotBytes: number
        sourceBytes: number
        totalBytes: number
    }
    interface ClassUsage {
        bytes: number
        limit: number
    }
    let usage = $state<{ docs: DocUsage[]; created: ClassUsage; sources: ClassUsage } | null>(
        null,
    )
    let docNames = $state<Record<string, string>>({})
    let reports = $state<{ tag: string; message: string; source: string }[]>([])
    // Selective sync: docs/folders kept off the cloud.
    let allDocs = $state<{ id: string; name: string; type: string; parent?: string }[]>([])
    let excluded = $state<Set<string>>(new Set())
    let exclusionsBusy = $state(false)

    // tree shape + per-doc sizes for the selective-sync list
    const docIds = $derived(new Set(allDocs.map((d) => d.id)))
    const childrenOf = $derived.by(() => {
        const m = new Map<string, typeof allDocs>()
        for (const d of allDocs) {
            const p = d.parent && docIds.has(d.parent) ? d.parent : ''
            const list = m.get(p) ?? []
            list.push(d)
            m.set(p, list)
        }
        for (const list of m.values())
            list.sort(
                (a, b) =>
                    (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) ||
                    a.name.localeCompare(b.name),
            )
        return m
    })
    const sizeOf = $derived(
        new Map((usage?.docs ?? []).map((d) => [d.doc, d.totalBytes])),
    )
    // Residency: a pdf/epub with no source bytes on the cloud is "tablet only":
    // still fully synced (ink, text, thumbnails), just no PDF underlay until
    // opened somewhere. Independent of the exclusion checkbox.
    const sourceBytesOf = $derived(
        new Map((usage?.docs ?? []).map((d) => [d.doc, d.sourceBytes])),
    )
    const tabletOnly = (d: { id: string; type: string }) =>
        (d.type === 'pdf' || d.type === 'epub') &&
        !excluded.has(d.id) &&
        (sourceBytesOf.get(d.id) ?? 0) === 0
    // folders show the total of everything inside them
    function treeSize(id: string): number {
        let n = sizeOf.get(id) ?? 0
        for (const c of childrenOf.get(id) ?? []) n += treeSize(c.id)
        return n
    }
    // a folder whose subtree is only partly synced shows an indeterminate checkbox
    function partiallyExcluded(id: string): boolean {
        if (excluded.has(id)) return false
        const kids = childrenOf.get(id) ?? []
        return kids.some(
            (k) => excluded.has(k.id) || (k.type === 'folder' && partiallyExcluded(k.id)),
        )
    }
    // folders start collapsed so the tree stays small; click the chevron
    let expanded = $state<Set<string>>(new Set())
    function toggleExpanded(id: string) {
        const next = new Set(expanded)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        expanded = next
    }
    const pct = (bytes: number, limit: number) => {
        const p = (bytes / limit) * 100
        return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
    }

    async function toggleExcluded(id: string) {
        const next = new Set(excluded)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        exclusionsBusy = true
        try {
            const { apiBase } = await import('$lib/settings')
            const { authHeaders } = await import('$lib/authedAsset')
            const r = await fetch(`${apiBase()}/api/sync-exclusions`, {
                method: 'PUT',
                headers: { ...(await authHeaders()), 'content-type': 'application/json' },
                body: JSON.stringify({ docs: [...next] }),
            })
            if (r.ok) excluded = next
        } finally {
            exclusionsBusy = false
        }
    }
    const gb = (n: number) =>
        n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`

    onMount(() => {
        if (connection().mode !== 'cloud') return
        void (async () => {
            try {
                const { apiBase } = await import('$lib/settings')
                const { authHeaders } = await import('$lib/authedAsset')
                const h = await authHeaders()
                const [u, d, f, x] = await Promise.all([
                    fetch(`${apiBase()}/api/usage/breakdown`, { headers: h }),
                    fetch(`${apiBase()}/api/documents`, { headers: h }),
                    fetch(`${apiBase()}/api/telemetry/failures`, { headers: h }),
                    fetch(`${apiBase()}/api/sync-exclusions`, { headers: h }),
                ])
                if (u.ok) usage = (await u.json()) as typeof usage
                if (d.ok) {
                    const body = (await d.json()) as {
                        documents: { id: string; name: string; type: string; parent?: string }[]
                    }
                    docNames = Object.fromEntries(body.documents.map((x2) => [x2.id, x2.name]))
                    allDocs = body.documents
                }
                if (x.ok) {
                    const body = (await x.json()) as {
                        docs: string[]
                        info?: { id: string; name: string | null; type: string | null; parent: string | null }[]
                    }
                    excluded = new Set(body.docs)
                    // Excluded docs are dropped from the cloud list, so merge
                    // their remembered info back in to keep a re-tickable row
                    // (else they can never be re-included from the web).
                    const have = new Set(allDocs.map((d2) => d2.id))
                    for (const e of body.info ?? []) {
                        if (have.has(e.id)) continue
                        allDocs = [
                            ...allDocs,
                            {
                                id: e.id,
                                name: e.name ?? '(excluded)',
                                type: e.type ?? 'notebook',
                                parent: e.parent ?? '',
                            },
                        ]
                        if (!(e.id in docNames)) docNames[e.id] = e.name ?? '(excluded)'
                    }
                }
                if (f.ok) {
                    const body = (await f.json()) as { reports: typeof reports }
                    reports = body.reports ?? []
                }
            } catch {
                /* section is best-effort */
            }
        })()
    })

    function save() {
        // empty override = use the hosted default; a URL = self-host
        setCloudUrl(selfHost ? serverUrl : '')
        saved = true
        // transport singleton is constructed from settings at startup
        setTimeout(() => location.reload(), 300)
    }
</script>

<div class="mx-auto grid min-h-screen max-w-[1280px] grid-rows-[min-content_auto_min-content] gap-4 p-4">
    <SiteHeader />

  <main>
    <p class="mt-4 text-gray-7">Configuration</p>
    <h1 class="mt-1 mb-10" style="color: var(--gray-f); font-size: 2rem; font-weight: 400; line-height: 1.1">Settings</h1>

    <!-- Account -->
    <section>
        <h2 style="color: var(--gray-f); font-size: 1.5rem; font-weight: 400">Account</h2>
        {#if clerkEnabled()}
            {#if userLabel}
                <p class="mt-2 text-[14px]" style="color: var(--gray-b)">
                    Signed in as <span style="color: var(--gray-f)">{userLabel}</span>
                </p>
                <button onclick={() => void signOut().then(refreshUser)} class="wf-link mt-4 cursor-pointer">
                    Sign out →
                </button>
            {:else}
                <p class="mt-2 text-[14px] leading-relaxed" style="color: var(--gray-7)">
                    Sign in and your reMarkable notebooks sync to your account, free, from
                    any browser.
                </p>
                <button onclick={() => void signIn()} class="wf-link mt-4 cursor-pointer">
                    Sign in with Google →
                </button>
            {/if}
        {:else}
            <!-- Self-host: shared-password session (no Clerk). -->
            {#if userLabel}
                <p class="mt-2 text-[14px]" style="color: var(--gray-b)">
                    Signed in to your <span style="color: var(--gray-f)">self-hosted</span> server.
                </p>
                <button onclick={() => void signOut().then(refreshUser)} class="wf-link mt-4 cursor-pointer">
                    Sign out →
                </button>
            {:else}
                <p class="mt-2 text-[14px] leading-relaxed" style="color: var(--gray-7)">
                    This is a self-hosted weft server. Log in with the shared password set in your
                    server's <code class="wf-icode">WEFT_PASSWORD</code>.
                </p>
                <a href="/login" class="wf-link mt-4 inline-block">Log in →</a>
            {/if}
        {/if}
    </section>

    <!-- Your tablet -->
    <section class="mt-10 border-t pt-8" style="border-color: var(--gray-2)">
        <h2 style="color: var(--gray-f); font-size: 1.5rem; font-weight: 400">Your tablet</h2>
        <p class="mt-1.5 text-[14px] leading-relaxed" style="color: var(--gray-7)">
            Pair your reMarkable once and its notebooks sync to your account. The one command
            and full steps are in <a href="/install" class="wf-link">setup</a>. Manage paired
            devices (and revoke a lost one) under
            <a href="/settings/keys" class="wf-link">Devices &amp; API keys</a>.
        </p>
    </section>

    <!-- Gate on the session: signed-out users have no storage/doc tree (would
         render a permanent "loading…"). -->
    {#if connection().mode === 'cloud' && userLabel}
        <section class="mt-10 border-t pt-8" style="border-color: var(--gray-2)" data-testid="storage-section">
            <h2 style="color: var(--gray-f); font-size: 1.5rem; font-weight: 400">Storage &amp; sync</h2>
            <!-- Only the sources (PDFs & books) meter: notes & ink have no
                 meaningful cap, so that meter is omitted. -->
            {#if usage}
                <div class="mt-3 grid gap-2 text-[13px]" style="color: var(--gray-b)" data-testid="storage-meters">
                    <div class="flex items-baseline gap-3">
                        <span class="w-36 shrink-0">PDFs &amp; books</span>
                        {#if usage.sources.limit > 0}
                            <span>{gb(usage.sources.bytes)} of {gb(usage.sources.limit)} ({pct(usage.sources.bytes, usage.sources.limit)})</span>
                        {:else}
                            <span>{gb(usage.sources.bytes)} (no limit)</span>
                        {/if}
                    </div>
                </div>
            {/if}
            <p class="mt-3 text-[14px] leading-relaxed" style="color: var(--gray-7)">
                Your notes and ink always sync. PDFs and books have their own space; when it
                fills up, the ones that don't fit stay on the tablet ("tablet only" below) and
                sync back to the cloud once there's room in that space. Uncheck a notebook or
                folder to keep it off the cloud entirely (unchecking a folder covers everything
                inside it). Sizes include each document's files and its edit history. Content
                that already reached the cloud stays there for now (full un-sync is coming).
                Need more space? Ask us, it's free during the beta.
            </p>
            {#snippet syncNode(items: typeof allDocs, depth: number)}
                {#each items as d (d.id)}
                    <div
                        class="flex items-baseline gap-2 py-0.5"
                        style={`padding-left: ${depth * 18}px`}
                    >
                        {#if d.type === 'folder' && childrenOf.get(d.id)?.length}
                            <button
                                class="w-4 shrink-0 cursor-pointer text-left"
                                style="color: var(--gray-6); background: none; border: none; padding: 0"
                                onclick={() => toggleExpanded(d.id)}
                                data-testid={`sync-expand-${d.id}`}
                            >
                                {expanded.has(d.id) ? '▾' : '▸'}
                            </button>
                        {:else}
                            <span class="w-4 shrink-0"></span>
                        {/if}
                        <label class="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2">
                            <input
                                type="checkbox"
                                checked={!excluded.has(d.id)}
                                indeterminate={d.type === 'folder' && partiallyExcluded(d.id)}
                                disabled={exclusionsBusy}
                                onchange={() => void toggleExcluded(d.id)}
                                class="accent-[var(--blue)]"
                                data-testid={`sync-toggle-${d.id}`}
                            />
                            <span class="truncate">
                                {d.type === 'folder' ? `${d.name}/` : d.name}
                            </span>
                            {#if tabletOnly(d)}
                                <!-- residency, not intent: box stays checked,
                                     only the PDF isn't resident right now -->
                                <span
                                    class="ml-auto shrink-0 border px-1.5 py-px"
                                    style="color: var(--gray-6); border-color: var(--gray-3); border-radius: 999px; font-size: 10.5px"
                                    data-testid={`residency-chip-${d.id}`}
                                    title="The PDF is on your tablet only. It syncs back to the cloud when there's room in the PDF space."
                                >
                                    tablet only
                                </span>
                            {/if}
                            {#if treeSize(d.id) > 0}
                                <span
                                    class="shrink-0 {tabletOnly(d) ? '' : 'ml-auto'}"
                                    style="color: var(--gray-6); font-size: 11px"
                                >
                                    {gb(treeSize(d.id))}
                                </span>
                            {/if}
                        </label>
                    </div>
                    {#if d.type === 'folder' && expanded.has(d.id) && childrenOf.get(d.id)?.length}
                        {@render syncNode(childrenOf.get(d.id)!, depth + 1)}
                    {/if}
                {/each}
            {/snippet}
            <div
                class="mt-4 flex max-h-96 flex-col overflow-y-auto text-[13px]"
                style="color: var(--gray-b)"
            >
                {#if allDocs.length === 0}
                    <span style="color: var(--gray-6)">loading…</span>
                {:else}
                    {@render syncNode(childrenOf.get('') ?? [], 0)}
                {/if}
            </div>
            {#if reports.length > 0}
                <p class="mt-5 text-[13px]" style="color: var(--yellow)" data-testid="sync-reports">
                    {reports.length} sync issue{reports.length === 1 ? '' : 's'} reported by your
                    devices. Most recent: “{reports[0]!.tag}: {reports[0]!.message}”
                </p>
            {/if}
        </section>
    {/if}

    <section class="mt-10 border-t pt-8" style="border-color: var(--gray-2)">
        <h2 style="color: var(--gray-f); font-size: 1.5rem; font-weight: 400">Developer</h2>
        <p class="mt-1.5 text-[14px] leading-relaxed" style="color: var(--gray-7)">
            Build your own app on your notes with the weft API. (Pairing and revoking your
            tablet lives under Your tablet above.)
        </p>
        <div class="mt-4 flex gap-6">
            <a href="/settings/keys" class="wf-link" data-testid="manage-keys">API keys →</a>
            <a href={docsUrl()} class="wf-link">API reference →</a>
        </div>
    </section>

    <!-- Server -->
    <section class="mt-10 border-t pt-8" style="border-color: var(--gray-2)">
        <h2 style="color: var(--gray-f); font-size: 1.5rem; font-weight: 400">Server</h2>
        <p class="mt-2 text-[14px] leading-relaxed" style="color: var(--gray-7)">
            By default weft uses the hosted service. Self-host by running your own weft
            server and pointing the app at it.
        </p>

        <div class="mt-5 space-y-3">
            <label class="flex items-start gap-3">
                <input type="radio" bind:group={selfHost} value={false} class="mt-1 accent-[var(--blue)]" />
                <span class="text-[14px]" style="color: var(--gray-b)">Hosted weft cloud (default)</span>
            </label>
            <label class="flex items-start gap-3">
                <input type="radio" bind:group={selfHost} value={true} class="mt-1 accent-[var(--blue)]" />
                <span class="flex-1">
                    <span class="text-[14px]" style="color: var(--gray-b)">Self-hosted server</span>
                    {#if selfHost}
                        <input
                            type="url"
                            bind:value={serverUrl}
                            placeholder="https://your-weft-server.example"
                            class="mt-2 w-full border px-3 py-2 text-sm outline-none focus:border-[var(--blue)]"
                            style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-0); color: var(--gray-b)"
                            data-testid="cloud-url"
                        />
                    {/if}
                </span>
            </label>
        </div>

        <button onclick={save} class="wf-link mt-6 cursor-pointer" data-testid="save-connection">
            {saved ? 'Saved, reloading…' : 'Save & reload →'}
        </button>
    </section>
  </main>

  <SiteFooter />
</div>
