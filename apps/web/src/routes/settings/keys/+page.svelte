<script lang="ts">
    import { onMount } from 'svelte'
    import { docsUrl } from '$lib/settings'
    import { currentUserLabel } from '$lib/auth'
    import {
        listKeys,
        createKey,
        revokeKey,
        listDevices,
        revokeDevice,
        type ApiKey,
        type Device,
    } from '$lib/keys'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'

    let loading = $state(true)
    let error = $state<string | null>(null)
    let signedIn = $state(false)

    let devices = $state<Device[]>([])
    let keys = $state<ApiKey[]>([])

    let newLabel = $state('')
    let creating = $state(false)
    let freshSecret = $state<string | null>(null)
    let confirming = $state<string | null>(null)
    let copiedId = $state<string | null>(null)

    onMount(() => {
        void (async () => {
            signedIn = (await currentUserLabel()) !== null
            if (signedIn) await refresh()
            loading = false
        })()
    })

    async function refresh() {
        try {
            ;[devices, keys] = await Promise.all([listDevices(), listKeys()])
            error = null
        } catch (e) {
            error = String(e instanceof Error ? e.message : e)
        }
    }

    async function create() {
        if (!newLabel.trim()) return
        creating = true
        try {
            const { key } = await createKey(newLabel.trim())
            freshSecret = key
            newLabel = ''
            await refresh()
        } catch (e) {
            error = String(e instanceof Error ? e.message : e)
        } finally {
            creating = false
        }
    }

    async function doRevoke(kind: 'device' | 'key', id: string) {
        confirming = null
        try {
            if (kind === 'device') await revokeDevice(id)
            else await revokeKey(id)
            await refresh()
        } catch (e) {
            error = String(e instanceof Error ? e.message : e)
        }
    }

    async function copy(text: string, id: string) {
        await navigator.clipboard.writeText(text)
        copiedId = id
        setTimeout(() => { if (copiedId === id) copiedId = null }, 1500)
    }


    // devices + keys merged into one list, newest first
    const all = $derived(
        [
            ...devices.map((d) => ({ kind: 'device' as const, ...d })),
            ...keys.map((k) => ({ kind: 'key' as const, ...k })),
        ].sort((a, b) => b.createdAt - a.createdAt),
    )

    function fmtUsed(ms: number | null): string {
        if (!ms) return 'never used'
        const days = Math.floor((Date.now() - ms) / 86_400_000)
        if (days === 0) return 'used today'
        if (days === 1) return 'used yesterday'
        return `used ${days}d ago`
    }
</script>

{#snippet row(kind: 'device' | 'key', id: string, label: string, token: string, preview: string, used: number | null)}
    <li class="flex items-center justify-between gap-4 py-3.5">
        <div class="min-w-0">
            <div class="text-[14px]" style="color: var(--gray-f)">{label}</div>
            <div class="mt-0.5 text-[11.5px]" style="color: var(--gray-7)">
                {kind === 'device' ? 'device' : 'api key'} · <code>{preview}</code> · {fmtUsed(used)}
            </div>
        </div>
        <div class="flex shrink-0 items-center gap-4 text-[11px] uppercase tracking-wider">
            <button class="cursor-pointer transition hover:text-[var(--gray-f)]" style="color: var(--gray-7)" onclick={() => void copy(token, id)} data-testid="copy-token">{copiedId === id ? 'Copied' : 'Copy'}</button>
            {#if confirming === id}
                <span class="flex items-center gap-3">
                    <button onclick={() => void doRevoke(kind, id)} class="cursor-pointer" style="color: var(--red)" data-testid="revoke-confirm">Confirm</button>
                    <button onclick={() => (confirming = null)} class="cursor-pointer" style="color: var(--gray-7)">Cancel</button>
                </span>
            {:else}
                <button class="cursor-pointer transition hover:text-[var(--red)]" style="color: var(--gray-7)" onclick={() => (confirming = id)} data-testid={`revoke-${label}`}>Revoke</button>
            {/if}
        </div>
    </li>
{/snippet}

<div class="mx-auto grid min-h-screen max-w-[1280px] grid-rows-[min-content_auto_min-content] gap-4 p-4">
    <SiteHeader />

  <main>
    <p class="mt-4 text-gray-7">Configuration</p>
    <h1 class="mt-1 mb-10" style="color: var(--gray-f); font-size: 2rem; font-weight: 400; line-height: 1.1">Access</h1>

    {#if loading}
        <p class="text-gray-7">Loading…</p>
    {:else if !signedIn}
        <h2 style="color: var(--gray-f); font-size: 1.5rem; font-weight: 400">Sign in to manage access</h2>
        <a href="/settings" class="wf-link mt-4 inline-block">Go to sign in →</a>
    {:else}
        {#if error}<p class="mb-4 text-[13px]" style="color: var(--red)" data-testid="access-error">{error}</p>{/if}

        <p class="text-[14px] leading-relaxed" style="color: var(--gray-7)">
            Everything that can access your account: tokens from
            <span style="color: var(--gray-b)">devices</span> you've paired and
            <span style="color: var(--gray-b)">API keys</span> you create for your own apps. Both
            use the same weft API. See the <a href={docsUrl()} class="wf-link">API reference</a>.
        </p>

        <div class="mt-6 flex flex-wrap items-center gap-3">
            <form onsubmit={(e) => { e.preventDefault(); void create() }} class="flex gap-3">
                <input
                    bind:value={newLabel}
                    placeholder="New API key name (e.g. my-app)"
                    data-testid="key-label"
                    class="w-72 border px-3 py-2 text-sm outline-none focus:border-[var(--blue)]"
                    style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-0); color: var(--gray-b)"
                />
                <button class="wf-link cursor-pointer whitespace-nowrap" type="submit" disabled={creating || !newLabel.trim()} data-testid="key-create">
                    {creating ? 'Creating…' : 'Create API key →'}
                </button>
            </form>
            <span class="text-gray-6">or</span>
            <a href="/install" class="wf-link cursor-pointer whitespace-nowrap" data-testid="pair-button">
                Pair a device →
            </a>
        </div>
        {#if freshSecret}
            <div class="mt-4 border p-4" style="border-color: var(--blue); border-radius: var(--radius); background: var(--gray-0)">
                <p class="text-[13px]" style="color: var(--blue)">Copy it now: the full key won't be shown again.</p>
                <div class="mt-2 flex items-center gap-2">
                    <code class="wf-icode flex-1 overflow-x-auto py-2 text-[12px]" data-testid="key-secret">{freshSecret}</code>
                    <button class="wf-link cursor-pointer" type="button" onclick={() => void copy(freshSecret!, 'fresh')}>{copiedId === 'fresh' ? 'Copied' : 'Copy'}</button>
                </div>
            </div>
        {/if}

        {#if all.length}
            <ul class="mt-8 divide-y border-t" style="border-color: var(--gray-2)">
                {#each all as r (r.id)}{@render row(r.kind, r.id, r.label, r.token, r.preview, r.lastUsedAt)}{/each}
            </ul>
        {:else}
            <p class="mt-8 text-gray-7">No devices or keys yet.</p>
        {/if}
    {/if}
  </main>

  <SiteFooter />
</div>
