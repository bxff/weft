<script lang="ts">
    import { onMount } from 'svelte'
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    import { connection } from '$lib/settings'
    import { getAuthToken, currentUserLabel, clerkEnabled, signIn } from '$lib/auth'

    // Browsers can't SSH: the wizard emits one command that installs the daemon
    // and connects the tablet to the account (no separate pair step).
    let host = $state('10.11.99.1')
    let copied = $state(false)
    // Setup parameters (map 1:1 to weft CLI flags).
    let autoUpdate = $state(true) //   --no-auto-reinstall when off: boot-guard self-heal after OTA
    // --store-timeout -> XOCHITL_STORE_TIMEOUT (xochitl.service drop-in): how
    // long xochitl buffers strokes before writing the .rm to disk. Lower =
    // faster tablet->web sync (daemon sees the write sooner). Default 1000ms.
    let storeTimeout = $state(500)

    // The command needs a device token tied to the account and the server it
    // mirrors to.
    const server = connection().cloudUrl
    let userLabel = $state<string | null>(null)
    let ready = $state(false)
    let token = $state<string | null>(null)
    let minting = $state(false)
    let mintError = $state<string | null>(null)
    const hostedPairing = server === 'https://api.weft.page' || server === 'https://weft.page'
    let acceptTerms = $state(false)

    onMount(() => {
        // Don't auto-mint the token: it's a credential, so showing it on load
        // risks leaking it. Mint only on a deliberate click.
        void currentUserLabel()
            .then((label) => (userLabel = label), () => (userLabel = null))
            .finally(() => (ready = true))
    })

    async function generate() {
        if (hostedPairing && !acceptTerms) return
        minting = true
        mintError = null
        try {
            const t = await getAuthToken()
            if (!t) throw new Error('sign in first')
            let r: Response
            try {
                r = await fetch(`${server}/api/pair`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ label: 'tablet' }),
                })
            } catch {
                // fetch rejects (network error) when the server is unreachable
                throw new Error(`Couldn't reach your weft server at ${server}. Is it running?`)
            }
            if (r.status === 401) throw new Error('Your session expired. Sign in again.')
            if (!r.ok) throw new Error(`Server error minting token (${r.status}).`)
            token = ((await r.json()) as { token: string }).token
        } catch (e) {
            mintError = String(e instanceof Error ? e.message : e)
        } finally {
            minting = false
        }
    }

    const command = $derived(
        `bunx @bxff/weft setup --host root@${host} --cloud ${server || '<your-server>'}` +
            ` --token ${token ?? '<TOKEN>'} --store-timeout ${storeTimeout}` +
            (autoUpdate ? '' : ' --no-auto-reinstall'),
    )

    async function copy() {
        try {
            await navigator.clipboard.writeText(command)
            copied = true
            setTimeout(() => (copied = false), 1500)
        } catch {
            const range = document.createRange()
            const el = document.querySelector('code.installer-cmd')
            if (el) {
                range.selectNodeContents(el)
                getSelection()?.removeAllRanges()
                getSelection()?.addRange(range)
            }
        }
    }
</script>

<div class="mx-auto max-w-[1280px] p-4">
    <SiteHeader />

    <main class="mt-4">
        <h1 class="my-4" style="color: var(--gray-f)">Set up your reMarkable</h1>

        <p class="my-4">
            This installs the weft sync agent on your tablet so its notebooks sync to your
            weft account. The app itself runs here on the website, from anywhere; nothing is
            hosted on the tablet. <span style="color: var(--gray-b)">Sign in first</span>, then
            run the one-liner below over USB.
        </p>

        <p class="my-4">
            <span style="color: var(--gray-b)">Supported today: reMarkable Paper Pro.</span>
            reMarkable 1 and 2 have experimental builds that haven't been verified on real
            hardware yet: the installer asks for an explicit
            <code class="wf-icode">--experimental-rm2</code> flag, and if the firmware looks
            incompatible weft refuses to take over sync and leaves the tablet stock. On rM1/2
            there's no developer mode and nothing gets erased; the SSH password is already on
            the device under Settings &rsaquo; Help &rsaquo; Copyrights and licenses.
        </p>

        <p class="my-4">
            <span style="color: var(--gray-f)">1. Enable developer mode.</span>
            Newer reMarkables gate SSH behind developer mode. On the tablet, open
            <span style="color: var(--gray-b)">Settings › General › Software</span> and turn on
            developer mode. <span style="color: var(--red)">This factory-resets the device</span>,
            so make sure your notebooks are synced/backed up first. Follow reMarkable's official
            steps:
            <a href="https://support.remarkable.com/s/article/Developer-mode" class="wf-link" target="_blank" rel="noreferrer">Developer mode guide →</a>
        </p>

        <p class="my-4">
            <span style="color: var(--gray-f)">2. Get the SSH password.</span>
            Once developer mode is on, open
            <span style="color: var(--gray-b)">Settings › General › Help › Copyrights and licenses</span>
            and note the password (and IP) shown under the "GPLv3 Compliance" section.
        </p>

        <p class="my-4">
            <span style="color: var(--gray-f)">3. Connect it to this computer.</span>
            A USB cable is simplest (the tablet appears at
            <code class="wf-icode">10.11.99.1</code>). Wi-Fi works too: use the IP from the
            same screen.
        </p>

        <label class="my-4 block">
            <span class="text-gray-7">Tablet address</span>
            <input
                class="mt-1 block w-56 border px-3 py-1.5 text-sm outline-none focus:border-[var(--blue)]"
                style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-1); color: var(--gray-b)"
                bind:value={host}
            />
            <span class="mt-1 block text-[12px]" style="color: var(--gray-6)">
                Pre-filled for USB ({host === '10.11.99.1' ? 'the standard address' : 'edited'}).
                Only change it for Wi-Fi.
            </span>
        </label>

        <p class="my-4">
            <span style="color: var(--gray-f)">4. Options.</span>
            Sensible defaults; adjust only if you need to.
        </p>
        <div class="my-4 flex flex-col gap-3 text-[14px]">
            <label class="flex items-center gap-2.5">
                <input type="checkbox" bind:checked={autoUpdate} class="accent-[var(--blue)]" />
                <span style="color: var(--gray-b)">Survive firmware updates</span>
                <span class="text-[12px]" style="color: var(--gray-6)">(reinstalls after a reMarkable update)</span>
            </label>
            <label class="flex items-center gap-2.5">
                <span style="color: var(--gray-b)">Tablet → web delay</span>
                <input
                    type="number"
                    bind:value={storeTimeout}
                    min="500"
                    step="100"
                    class="w-20 border px-2 py-1 text-sm outline-none focus:border-[var(--blue)]"
                    style="border-color: var(--gray-3); border-radius: var(--radius); background: var(--gray-1); color: var(--gray-b)"
                />
                <span style="color: var(--gray-b)">ms</span>
                <span class="text-[12px]" style="color: var(--gray-6)">(lower is faster but writes to the tablet more often, stock is 10s)</span>
            </label>
        </div>

        <p class="my-4">
            <span style="color: var(--gray-f)">5. Run the installer.</span>
            This generates one command (with the server and your account baked in) that
            installs the daemon and connects the tablet to your weft account. Run it in a
            terminal; you'll be asked for the SSH password once.
        </p>

        <p class="my-2 text-[13px]" style="color: var(--gray-7)">
            Syncing to <span style="color: var(--gray-b)">{server || 'no server set'}</span>.
            Self-hosting? Point at your own server in
            <a href="/settings" class="wf-link">Settings → Server</a>.
        </p>

        <p class="my-4">
            If you connect to hosted Weft, the tablet sends synced notebooks and related files
            to the weft.page relay. Hosted sync is not end-to-end encrypted.
            Read the <a href="/privacy" class="wf-link">Privacy Notice</a> before connecting.
        </p>

        <!-- The command is always visible; signing in just fills the <TOKEN>. -->
        <div class="my-4 flex items-center gap-3">
            <code class="installer-cmd wf-code flex-1"><span class="line">{command}</span></code>
            <button class="wf-link cursor-pointer disabled:opacity-40" onclick={copy} disabled={!token}>
                {copied ? 'Copied!' : 'Copy'}
            </button>
        </div>

        {#if !ready}
            <p class="my-2 text-[13px] text-gray-7">Checking whether you're signed in…</p>
        {:else if !token && !userLabel && clerkEnabled()}
            <div class="my-3 flex items-center gap-3">
                <button type="button" class="wf-cta" onclick={() => void signIn()}>Sign in</button>
                <span class="text-[13px]" style="color: var(--gray-7)">
                    to fill in <code class="wf-icode">&lt;TOKEN&gt;</code> with your account token.
                </span>
            </div>
        {:else if !token && !userLabel}
            <div class="my-3 flex items-center gap-3">
                <a href="/login" class="wf-cta">Log in</a>
                <span class="text-[13px]" style="color: var(--gray-7)">
                    to your self-hosted server to fill in <code class="wf-icode">&lt;TOKEN&gt;</code>.
                </span>
            </div>
        {:else if !token}
            {#if hostedPairing}
                <div class="my-3">
                    <input id="accept-hosted-terms" type="checkbox" bind:checked={acceptTerms} />
                    <label for="accept-hosted-terms">I agree to the Hosted Terms.</label>
                    <a href="/terms" target="_blank" rel="noopener" class="wf-link">Read the Hosted Terms</a>
                    ·
                    <a href="/privacy" class="wf-link">Privacy Notice</a>
                </div>
            {/if}
            <div class="my-3 flex items-center gap-3">
                <button type="button" class="wf-cta disabled:opacity-50" onclick={generate} disabled={minting || (hostedPairing && !acceptTerms)}>
                    {minting ? 'Generating…' : 'Generate my token'}
                </button>
                <span class="text-[13px]" style="color: var(--gray-7)">
                    fills in <code class="wf-icode">&lt;TOKEN&gt;</code> above.
                    {#if mintError}<span style="color: var(--red)"> {mintError}</span>{/if}
                </span>
            </div>
        {:else}
            <p class="my-2 text-[12px]" style="color: var(--gray-6)">
                Token filled in above. It's shown once; regenerate any time.
            </p>
        {/if}

        <p class="my-4">
            <span style="color: var(--gray-f)">6. You're synced.</span>
            Your tablet now mirrors its notebooks to your weft account in the cloud. Open
            them from <a href="/library" class="wf-link">your library</a> at weft.page, in
            any browser, from anywhere.
        </p>

        <p class="my-4 text-gray-7">
            After a reMarkable software update the daemon's boot guard restores itself
            automatically. If the app shows "tablet unreachable", run
            <code class="wf-icode">bunx @bxff/weft doctor</code>.
        </p>
    </main>

    <SiteFooter />
</div>
