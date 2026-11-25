<script lang="ts">
    import { onMount } from 'svelte'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    import { clerkEnabled, selfHostLogin } from '$lib/auth'
    import { connection } from '$lib/settings'

    // Self-host door (shared password). On a hosted build (Clerk configured)
    // there is no password login: redirect to the landing page. Don't call
    // signIn() here; its redirect target is this page, so Clerk would loop.
    let password = $state('')
    let busy = $state(false)
    let error = $state<string | null>(null)

    onMount(() => {
        if (clerkEnabled()) location.replace('/')
    })

    async function submit(e: Event) {
        e.preventDefault()
        busy = true
        error = null
        try {
            await selfHostLogin(password)
            // Return to `next` or the library. Only allow a same-origin path
            // (leading single slash): no open redirect.
            const raw = new URLSearchParams(location.search).get('next') || '/library'
            const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/library'
            location.href = next
        } catch (err) {
            error = String(err instanceof Error ? err.message : err)
        } finally {
            busy = false
        }
    }
</script>

<div class="mx-auto grid min-h-screen max-w-[1280px] grid-rows-[min-content_auto_min-content] gap-4 p-4">
    <SiteHeader />

    <main class="mt-4">
        {#if clerkEnabled()}
            <p class="text-gray-7">Redirecting…</p>
        {:else}
            <p class="mt-4 text-gray-7">Self-hosted</p>
            <h1 class="mt-1 mb-3" style="color: var(--gray-f); font-size: 2rem; font-weight: 400; line-height: 1.1">
                Log in
            </h1>
            <p class="mb-8 max-w-prose text-[14px] leading-relaxed" style="color: var(--gray-7)">
                Enter the shared password for your weft server
                (<code class="wf-icode">{connection().cloudUrl}</code>). It's the
                <code class="wf-icode">WEFT_PASSWORD</code> you set in your server's environment.
            </p>

            <form onsubmit={submit} class="max-w-sm">
                <label class="block">
                    <span class="text-gray-7 text-[14px]">Password</span>
                    <input
                        type="password"
                        bind:value={password}
                        autocomplete="current-password"
                        class="mt-2 w-full border px-3 py-2 text-sm outline-none focus:border-[var(--blue)]"
                        style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-0); color: var(--gray-b)"
                        data-testid="selfhost-password"
                    />
                </label>
                {#if error}
                    <p class="mt-3 text-[13px]" style="color: var(--red)" data-testid="login-error">{error}</p>
                {/if}
                <button
                    type="submit"
                    disabled={busy || !password}
                    class="wf-cta mt-5 cursor-pointer disabled:opacity-50"
                    data-testid="selfhost-login"
                >
                    {busy ? 'Logging in…' : 'Log in →'}
                </button>
            </form>
        {/if}
    </main>

    <SiteFooter />
</div>
