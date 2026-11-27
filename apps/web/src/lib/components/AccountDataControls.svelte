<script lang="ts">
    import { onMount } from 'svelte'
    import { connection, watchRelayChange } from '$lib/settings'
    import { hostedAccountRequest, signOut } from '$lib/auth'

    let { onDeleted }: { onDeleted: () => void } = $props()
    let enabled = $state(false)
    let confirm = $state(false)
    let phrase = $state('')
    let busy = $state(false)
    let status = $state('')
    let error = $state('')

    onMount(() => {
        const controller = new AbortController()
        const relay = connection().cloudUrl
        watchRelayChange(() => { enabled = false; controller.abort() }, controller.signal)
        void fetch(relay + '/api/health', { signal: controller.signal }).then(async response => {
            if (!response.ok) return
            const health = await response.json()
            enabled = !controller.signal.aborted && connection().cloudUrl === relay &&
                health.authMode === 'clerk' && health.accountSelfService === true
        }).catch(() => {})
        return () => controller.abort()
    })

    async function act(kind: 'export' | 'delete') {
        if (busy || !enabled || (kind === 'delete' && phrase !== 'DELETE')) return
        busy = true
        error = status = ''
        try {
            const auth = await hostedAccountRequest()
            if (!auth) throw new Error('The account or server changed. Please reopen Settings and try again.')
            const response = await fetch(auth.relay + (kind === 'export' ? '/api/account/export' : '/api/account'), {
                method: kind === 'export' ? 'POST' : 'DELETE',
                headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json' },
                ...(kind === 'delete' && { body: JSON.stringify({ confirm: phrase }) }),
            })
            if (!auth.stillCurrent()) return
            if (kind === 'export' && response.ok) {
                const { ticket } = await response.json()
                if (!auth.stillCurrent() || typeof ticket !== 'string') return
                const form = document.createElement('form')
                form.action = auth.relay + '/api/account/export/download'
                form.method = 'POST'
                form.rel = 'noreferrer'
                form.hidden = true
                const grant = document.createElement('input')
                grant.type = 'hidden'
                grant.name = 'ticket'
                grant.value = ticket
                form.append(grant)
                document.body.append(form)
                try { form.submit() } finally { form.remove() }
                status = 'Export requested. Check your downloads.'
            } else if (kind === 'delete' && response.status === 204) {
                await signOut().catch(() => {})
                onDeleted()
            } else if (kind === 'delete' && response.status === 202) {
                status = 'Deletion is in progress. You can close this page; Weft will finish it automatically.'
            } else if (response.status === 403 && kind === 'delete') {
                error = 'Sign out and sign in again, then return here to confirm deletion.'
            } else {
                error = kind === 'export' ? 'Export could not start. Please try again.' : 'Deletion could not start. Please try again.'
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : 'The request failed. Please try again.'
        } finally {
            busy = false
        }
    }
</script>

{#if enabled}
    <div class="mt-5" data-testid="account-data-controls">
        <button class="wf-link cursor-pointer" onclick={() => void act('export')} disabled={busy}>
            Download synced notebooks
        </button>
        <p class="mt-2 text-[13px]" style="color: var(--gray-7)">
            Exports current notebook content, editable browser shapes, and available source files. It does not include edit history or tablet-only files.
        </p>
        {#if !confirm}
            <button class="wf-link mt-4 cursor-pointer" onclick={() => { confirm = true }} disabled={busy}>
                Delete account…
            </button>
        {:else}
            <div class="mt-4 grid gap-2" data-testid="account-delete-confirmation">
                <label class="text-[14px]">
                    This permanently deletes your hosted account and synced data. Copies on your tablet, in this browser, and in backups are not immediately removed. Type DELETE to confirm.
                    <input class="mt-2 block border p-1" aria-label="Type DELETE to confirm" autocomplete="off" bind:value={phrase} disabled={busy} />
                </label>
                <div class="flex gap-4">
                    <button class="wf-link cursor-pointer" onclick={() => void act('delete')} disabled={busy || phrase !== 'DELETE'}>
                        Delete account
                    </button>
                    <button class="wf-link cursor-pointer" onclick={() => { confirm = false; phrase = '' }} disabled={busy}>
                        Cancel
                    </button>
                </div>
            </div>
        {/if}
        {#if status}<p class="mt-2 text-[13px]" role="status">{status}</p>{/if}
        {#if error}<p class="mt-2 text-[13px]" role="alert">{error}</p>{/if}
    </div>
{/if}
