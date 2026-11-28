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
                weft syncs reMarkable notebooks with a browser editor using the tablet&rsquo;s
                native notebook files. Handwriting, typed text, images and PDF annotations sync
                both ways. If you add strokes on both sides, weft merges them. You can restore
                an earlier version of a page.
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
                <a href="/install" class="wf-link">Setup</a>: Paper Pro is supported; reMarkable 1 and 2
                are experimental. Back up your notes first: turning on Developer Mode factory-resets
                the Paper Pro. weft replaces reMarkable Cloud sync while installed, so new edits
                won&rsquo;t appear in reMarkable&rsquo;s apps.
            </p>

            <p class="my-4">
                The hosted beta is free and doesn&rsquo;t require reMarkable Connect.
                The code is open source if you&rsquo;d rather run it yourself.
            </p>
        </div>
    </main>

    <SiteFooter />
</div>
