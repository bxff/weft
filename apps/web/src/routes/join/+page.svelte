<script lang="ts">
    import { onMount } from 'svelte'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    import { connection } from '$lib/settings'

    // Keep coded links working for deployments that still enable invitations.
    let code = $state('')
    let email = $state('')
    let busy = $state(false)
    let error = $state<string | null>(null)

    onMount(() => {
        const fromHash = window.location.hash.replace(/^#/, '')
        const fromQuery = new URLSearchParams(window.location.search).get('code') ?? ''
        code = fromHash || fromQuery
    })

    async function join(e: SubmitEvent) {
        e.preventDefault()
        busy = true
        error = null
        try {
            const r = await fetch(`${connection().cloudUrl}/api/invite`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code, email }),
            })
            const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string }
            if (!r.ok || !data.url) throw new Error(data.error ?? `invite failed (${r.status})`)
            window.location.href = data.url
        } catch (err) {
            error = String(err instanceof Error ? err.message : err)
            busy = false
        }
    }
</script>

<div class="mx-auto grid size-full min-h-screen max-w-[1280px] grid-cols-1 grid-rows-[min-content_auto_min-content] gap-4 p-4">
    <SiteHeader />

    <!-- Block centered in the viewport, text left-aligned. -->
    <main class="grid place-content-center">
        <div style="max-width: 46ch">
            <h1 class="my-4" style="color: var(--gray-f)">Join Weft</h1>
            <p class="my-4">Weft’s hosted beta is open. You don’t need an invitation to sign up.</p>
            <a href="/" class="wf-cta" rel="noreferrer">Continue to Weft</a>

            {#if code}
                <details class="my-6">
                    <summary>Use an existing invitation instead</summary>
                    <form class="my-4 flex flex-wrap items-end gap-3" onsubmit={join}>
                        <label class="flex flex-col gap-1">
                            Google account email
                            <input
                                type="email"
                                required
                                autocomplete="email"
                                bind:value={email}
                                class="border px-3 py-1.5 text-sm outline-none focus:border-[var(--blue)]"
                                style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-1); color: var(--gray-b)"
                            />
                        </label>
                        <button type="submit" class="wf-cta disabled:opacity-50" disabled={busy || !email}>
                            {busy ? 'One moment' : 'Use invitation'}
                        </button>
                    </form>
                    {#if error}
                        <p class="my-2 text-[13px]" role="alert" style="color: var(--red)">{error}</p>
                    {/if}
                </details>
            {/if}
        </div>
    </main>

    <SiteFooter />
</div>
