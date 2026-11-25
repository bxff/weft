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

    // API example, hand-highlighted with the wf-code token classes. Static and
    // self-authored, so @html is safe.
    const kw = (s: string) => `<span class="tok-keyword">${s}</span>`
    const str = (s: string) => `<span class="tok-string">${s}</span>`
    const fn = (s: string) => `<span class="tok-variableName">${s}</span>`
    const prop = (s: string) => `<span class="tok-propertyName">${s}</span>`
    const op = (s: string) => `<span class="tok-operator">${s}</span>`
    const cmt = (s: string) => `<span class="tok-comment">${s}</span>`
    const API_EXAMPLE_HTML = [
        `${kw('const')} headers ${op('=')} { ${str('"x-api-key"')}: key }`,
        ``,
        `${kw('const')} r ${op('=')} ${kw('await')} ${fn('fetch')}(${str('"https://api.weft.page/api/documents"')}, { headers })`,
        `${kw('const')} { ${prop('documents')} } ${op('=')} ${kw('await')} r.${fn('json')}()`,
        ``,
        `${kw('const')} doc ${op('=')} documents.${fn('find')}((d) ${op('=&gt;')} d.type ${op('===')} ${str('"notebook"')})`,
        `${kw('const')} page ${op('=')} ${kw('await')} ${fn('fetch')}(`,
        `  ${str('`https://api.weft.page/api/documents/${doc.id}/pages/${doc.pages[0].id}/rm`')},`,
        `  { headers },`,
        `)`,
        `${cmt("// page.arrayBuffer() is the page's real .rm file:")}`,
        `${cmt("// every stroke, in the tablet's own format")}`,
    ]
        .map((l) => `<span class="line">${l || ' '}</span>`)
        .join('')
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
                both ways on its own: pen strokes land in the browser a second or two after
                you lift the pen, and browser edits land back on paper. When both sides touch the same
                page at once (you reorganize a page in the browser while someone is still
                writing on it), weft merges the strokes instead of keeping one side and
                losing the other. Every page also keeps its edit history, so you can put a
                page back to how it looked yesterday.
            </p>

            <p class="my-4">
                weft adds one small program to the tablet and changes nothing else. One
                thing to know before you install: a tablet can only have one sync agent,
                so weft takes the place of reMarkable&rsquo;s own cloud sync. While
                it&rsquo;s installed, your notes sync to weft and not to reMarkable&rsquo;s
                cloud or their apps. The daemon runs as its own service beside xochitl
                (the reMarkable UI), reads and writes the same note files, and never
                patches the system software. Firmware updates install normally; weft puts
                itself back afterward and keeps itself up to date, so you set it up once.
                Uninstalling removes that one program and stock sync comes back, so there
                is nothing to brick.
            </p>

            <p class="my-4">
                The hosted beta is free, and none of it needs a reMarkable Connect
                subscription: browser editing, backup, version history, PDFs, and images in
                your notes all work on a plain account (the official apps reserve image
                support for Connect subscribers). The beta is invite-only for now; the
                source and a self-hosting guide come with the public release.
            </p>

            <p class="my-4">
                Other apps can build on your notes too. The API is the same one this web app
                uses, scoped to your account with keys you control (create one in
                <a href="/settings/keys" class="wf-link">settings</a>, revoke it any time).
                The full reference is still being written and lands with the public release;
                during the beta the endpoints work but may change. This lists your documents
                and downloads a page&rsquo;s actual ink file:
            </p>

            <div class="my-4">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- static, self-authored -->
                <code class="wf-code">{@html API_EXAMPLE_HTML}</code>
            </div>

            <p class="my-4">
                Under the hood weft reads and writes the reMarkable&rsquo;s CRDT file format
                and syncs per-stroke diffs rather than whole files. That is what makes the
                merging and the history work.
            </p>
        </div>
    </main>

    <SiteFooter />
</div>
