<script lang="ts">
    import { onMount } from 'svelte'
    import { docsUrl, connection } from '$lib/settings'
    import { currentUserLabel, clerkEnabled, joinWaitlist } from '$lib/auth'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'

    // Auth state for the in-body CTA (the header has its own copy).
    let userLabel = $state<string | null>(null)
    let ready = $state(false)

    onMount(() => {
        if (connection().mode === 'cloud') {
            void currentUserLabel()
                .then((l) => (userLabel = l))
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
                weft puts your reMarkable notebooks in the browser, live. Write on paper
                and the page follows you to any computer; edit it there and the changes
                show up back on the tablet, right under the pen. weft syncs the
                tablet&rsquo;s own stroke files, not screenshots or exports, so the page
                you open in the browser is the page itself. Handwriting, typed text, and
                the PDFs you mark up all come along.
            </p>

            <!-- Primary action: sign in (hosted). -->
            <p class="my-6">
                {#if userLabel}
                    <a href="/library" class="wf-cta">Open your notes</a>
                    <a href={docsUrl()} class="wf-link" style="margin-left: 1rem; display: inline-block; white-space: nowrap">Read the docs &rarr;</a>
                {:else if showSignIn}
                    <!-- One door: the hosted waitlist page. New visitors leave
                         their email; it links to sign-in for approved users. -->
                    <button type="button" class="wf-cta" onclick={() => void joinWaitlist()}>Sign in or join the waitlist</button>
                    <a href={docsUrl()} class="wf-link" style="margin-left: 1rem; display: inline-block; white-space: nowrap">Read the docs &rarr;</a>
                    <span class="mt-2 block text-[12px]" style="color: var(--gray-6)">
                        Waitlist invites arrive by email. The domain is new, so check spam.
                    </span>
                {:else}
                    <a href="/library" class="wf-cta">Open your notes</a>
                    <a href={docsUrl()} class="wf-link" style="margin-left: 1rem; display: inline-block; white-space: nowrap">Read the docs &rarr;</a>
                {/if}
            </p>

            <p class="my-4">
                <a href="/install" class="wf-link">Set up the tablet</a> once and sync runs
                both ways while your tablet and browser can reach the relay: pen strokes
                show up in the browser, and browser edits sync back to the tablet. When both sides touch the same
                page at once (you reorganize a page in the browser while someone is still
                writing on it), weft merges the strokes instead of keeping one side and
                losing the other. Every page also keeps its edit history, so you can put a
                page back to how it looked yesterday.
            </p>

            <p class="my-4">
                weft installs a sync agent on the tablet. One thing to know before you install: a tablet can only have one sync agent,
                so weft takes the place of reMarkable&rsquo;s own cloud sync. While
                it&rsquo;s installed, your notes sync to weft and not to reMarkable&rsquo;s
                cloud or their apps. The daemon runs as its own service beside xochitl
                (the reMarkable UI), reads and writes the same note files, and never
                patches the system software. Check the <a href="/install" class="wf-link">setup guide</a> for your model before
                installing. Back up your notes before changing sync services, and check
                that stock sync resumes after uninstalling.
            </p>

            <p class="my-4">
                The hosted beta is free, and none of it needs a reMarkable Connect
                subscription: browser editing, backup, version history, PDFs, and images in
                your notes all work on a plain account (the official apps reserve image
                support for Connect subscribers). The hosted beta is invite-only. The
                <a href="https://github.com/bxff/weft" class="wf-link">source is public</a>,
                and you can <a href={docsUrl()} class="wf-link">run it yourself</a>.
            </p>

            <p class="my-4">
                Other apps can build on your notes too. See the <a href="/docs/api" class="wf-link">API docs</a>.
            </p>

            <p class="my-4">
                Under the hood weft reads and writes the reMarkable&rsquo;s CRDT file format
                and syncs per-stroke diffs rather than whole files. That is what makes the
                merging and the history work.
            </p>
        </div>
    </main>

    <SiteFooter />
</div>
