<script lang="ts">
    // Hidden until nearing the notes quota (>=80%); the quota number itself
    // isn't shown elsewhere. Only the "created" class triggers this: a full
    // sources budget is a steady state (PDFs go tablet-only) explained in settings.
    import { apiBase } from '$lib/settings'
    import { authHeaders } from '$lib/authedAsset'

    let created = $state<{ bytes: number; limit: number } | null>(null)

    $effect(() => {
        let cancelled = false
        void (async () => {
            try {
                const r = await fetch(`${apiBase()}/api/usage`, { headers: await authHeaders() })
                if (!r.ok || cancelled) return
                const body = (await r.json()) as { created: { bytes: number; limit: number } }
                created = body.created
            } catch {
                // best-effort; never block the library on it
            }
        })()
        return () => {
            cancelled = true
        }
    })

    const frac = $derived(created && created.limit > 0 ? created.bytes / created.limit : 0)
    const full = $derived(frac >= 1)
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1)
</script>

{#if created && created.limit > 0 && frac >= 0.8}
    <div
        data-testid="storage-banner"
        class="mx-auto mt-4 max-w-[1280px] border px-4 py-3 text-sm"
        style="border-radius: var(--radius); border-color: {full
            ? 'var(--red)'
            : 'var(--yellow)'}; background: var(--gray-1); color: var(--gray-c)"
    >
        {#if full}
            <strong style="color: var(--red)">Notes storage full.</strong>
            New edits and uploads aren't syncing (your notes remain safe and readable
            everywhere). Free space by deleting documents on the tablet, or contact us
            for more space, it's free.
        {:else}
            <strong style="color: var(--yellow)">Notes storage {Math.round(frac * 100)}% used</strong>
            ({gb(created.bytes)} of {gb(created.limit)} GB). If it fills up, new edits pause
            syncing until space is freed. Deleting documents or asking for a free
            increase both work.
        {/if}
    </div>
{/if}
