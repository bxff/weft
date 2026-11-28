<script lang="ts">
    import { onMount } from 'svelte'
    import { docsUrl } from '$lib/settings'
    import { currentUserLabel, clerkEnabled, signIn } from '$lib/auth'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    import heroManifest from '$lib/home-hero.json'

    const heroImage = heroManifest.at(-1)
    const heroSrcset = heroManifest.map(({ src, width }) => `${src} ${width}w`).join(', ')

    // Auth state for the in-body CTA (the header has its own copy).
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

<div
    class="mx-auto grid size-full min-h-screen max-w-[1280px] grid-cols-1 grid-rows-[min-content_auto_min-content] gap-4 p-4"
>
    <SiteHeader />

    <!-- Main: single dense column, terminal-doc style -->
    <main>
        <div>
            <p class="my-4 first:mt-0 last:mb-0" style="color: var(--gray-e)">
                Edit your reMarkable notebooks in a browser. Ink, text, and PDF annotations sync both ways.
                Page history lets you restore earlier versions.
            </p>

            <!-- Primary action: sign in (hosted). -->
            <p class="my-6">
                {#if userLabel}
                    <a href="/library" class="wf-cta">Open your notes</a>
                    <a href={docsUrl()} class="wf-link" style="margin-left: 1rem; display: inline-block; white-space: nowrap">Read the docs &rarr;</a>
                {:else if showSignIn}
                    <button type="button" class="wf-cta" onclick={() => void signIn()}>Sign in or sign up</button>
                    <a href={docsUrl()} class="wf-link" style="margin-left: 1rem; display: inline-block; white-space: nowrap">Read the docs &rarr;</a>
                {:else}
                    {#if ready}<a href="/library" class="wf-cta">Open your notes</a>{/if}
                    <a href={docsUrl()} class="wf-link" style:margin-left={ready ? '1rem' : undefined} style="display: inline-block; white-space: nowrap">Read the docs &rarr;</a>
                {/if}
            </p>

            {#if heroImage}
                <img
                    class="my-6 block h-auto w-full"
                    src={heroImage.src}
                    srcset={heroSrcset}
                    sizes="(min-width: 1280px) 1248px, calc(100vw - 32px)"
                    width={heroImage.width}
                    height={heroImage.height}
                    alt="The same annotated notebook page on a reMarkable tablet and in the Weft browser editor."
                />
            {/if}

            <p class="my-4">
                Weft supports the reMarkable Paper Pro. Back up your notes before
                <a href="/install" class="wf-link">setting up your tablet</a>: Developer Mode factory-resets it.
                While installed, Weft replaces reMarkable cloud sync, so changes won&rsquo;t
                reach reMarkable&rsquo;s apps.
            </p>

            <p class="my-4">
                The hosted beta is free. You don&rsquo;t need reMarkable Connect.
                Weft is open source and you can run it yourself.
            </p>
        </div>
    </main>

    <SiteFooter />
</div>
