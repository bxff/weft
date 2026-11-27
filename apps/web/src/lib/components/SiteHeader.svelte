<script lang="ts">
    import { onMount } from 'svelte'
    import { docsUrl } from '$lib/settings'
    import { currentUserLabel, clerkEnabled, joinWaitlist } from '$lib/auth'

    let userLabel = $state<string | null>(null)
    let ready = $state(false)

    onMount(() => {
        if (clerkEnabled()) {
            void currentUserLabel()
                .then((l) => (userLabel = l), () => (userLabel = null))
                .finally(() => (ready = true))
        } else {
            ready = true
        }
    })

    const showSignIn = $derived(ready && clerkEnabled() && !userLabel)
</script>

<header class="wf-topbar">
    <a href="/" class="wf-wordmark select-none">weft</a>
    <nav class="wf-topnav">
        <a href={docsUrl()} class="wf-nav">Docs</a>
        <a href="/install" class="wf-nav">Setup</a>
        <a href="/settings" class="wf-nav">Settings</a>
        {#if userLabel}
            <a href="/library" class="wf-link">Open notes</a>
        {:else if showSignIn}
            <!-- routes to the waitlist page, which links to sign-in for approved users -->
            <button type="button" class="wf-nav" style="cursor: pointer" onclick={() => void joinWaitlist()}>Sign in</button>
        {:else if ready}
            <a href="/library" class="wf-link">Open notes</a>
        {/if}
    </nav>
</header>
