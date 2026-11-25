<script lang="ts">
    // An <img> that loads via an authed fetch (blob URL). Tries `paths` in
    // order until one resolves; falls back to a placeholder tile if none do.
    // Thumbnail paths go through the persistent SWR cache: cached copy renders
    // immediately (and offline), then swaps in place if the server has newer bytes.
    import { untrack } from 'svelte'
    import { fetchBlobUrl, fetchThumbnail } from '$lib/authedAsset'

    let {
        paths,
        alt = '',
        class: klass = '',
        style = '',
        placeholder = '',
        refreshKey = 0,
    }: {
        paths: string[]
        alt?: string
        class?: string
        style?: string
        placeholder?: string
        refreshKey?: number
    } = $props()

    let url = $state<string | null>(null)

    const isThumbnail = (p: string) => p.endsWith('/thumbnail')

    // `paths` is rebuilt inline on every refresh, so dedupe by value (not
    // identity) and never null `url` while re-resolving, to avoid flashing.
    const requestKey = $derived(JSON.stringify([refreshKey, ...paths]))
    let lastKey = ''
    let attempt = 0
    let retryTick = $state(0)
    $effect(() => {
        void retryTick // retrying re-runs the resolver
        const key = requestKey
        if (key === lastKey) return
        lastKey = key
        let cancelled = false
        const candidates = untrack(() => paths)
        void (async () => {
            for (const p of candidates) {
                if (isThumbnail(p)) {
                    const result = await fetchThumbnail(p)
                    if (cancelled) return
                    if (result.url) {
                        url = result.url
                        // swap when newer bytes land; null (thumbnail gone) keeps last known image
                        void result.fresh.then((freshUrl) => {
                            if (cancelled || freshUrl === undefined) return
                            if (freshUrl) url = freshUrl
                        })
                        return
                    }
                    continue
                }
                const u = await fetchBlobUrl(p)
                if (cancelled) return
                if (u) {
                    url = u
                    return
                }
            }
            // fall back to placeholder only if nothing to show; stale beats a flash to empty
            if (!cancelled && url === null) {
                // failure may be transient (401/5xx); retry with backoff. Genuine
                // absences stay cheap since the negative cache serves retries from memory
                lastKey = ''
                if (attempt < 3) {
                    const delay = 1500 * 2 ** attempt
                    attempt++
                    setTimeout(() => {
                        if (!cancelled) lastKey = ''
                        retryTick++
                    }, delay)
                } else {
                    attempt = 0
                }
            } else if (!cancelled) {
                attempt = 0
            }
        })()
        return () => {
            cancelled = true
        }
    })
</script>

{#if url}
    <img src={url} {alt} class={klass} {style} draggable="false" />
{:else if placeholder}
    <!-- shown while loading and when missing, so the grid never renders empty -->
    <div
        class={klass}
        {style}
        style:background="#fbfbfa"
        style:display="flex"
        style:align-items="center"
        style:justify-content="center"
    >
        <span style="color: #c9c9c9; font-size: 2.2rem; font-weight: 500">
            {placeholder.slice(0, 1).toUpperCase()}
        </span>
    </div>
{/if}
