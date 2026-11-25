<script lang="ts">
    import { onMount } from 'svelte'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    import { connection } from '$lib/settings'

    // Shareable beta door: code rides the URL (#<code> or ?code=), visitor
    // types only their email. POST /api/invite returns a ticketed sign-up URL.
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
        <h1 class="my-4" style="color: var(--gray-f)">You're invited</h1>

        {#if code}
            <p class="my-4">
                Someone shared their weft beta invite with you. Enter the email of the
                Google account you'll sign in with, and you'll go straight to sign-up.
            </p>

            <form class="my-6 flex items-center gap-3" onsubmit={join}>
                <input
                    type="email"
                    required
                    placeholder="you@gmail.com"
                    bind:value={email}
                    class="w-72 border px-3 py-1.5 text-sm outline-none focus:border-[var(--blue)]"
                    style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-1); color: var(--gray-b)"
                />
                <button type="submit" class="wf-cta disabled:opacity-50" disabled={busy || !email}>
                    {busy ? 'One moment' : 'Get access'}
                </button>
            </form>
            {#if error}
                <p class="my-2 text-[13px]" style="color: var(--red)">{error}</p>
            {/if}
        {:else}
            <p class="my-4">
                This page needs an invite link with its code attached. If a friend sent
                you here, ask them for the full link.
            </p>
        {/if}
        </div>
    </main>

    <SiteFooter />
</div>
