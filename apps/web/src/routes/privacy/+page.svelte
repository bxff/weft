<script lang="ts">
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
</script>

<svelte:head>
    <title>Privacy Notice · Weft</title>
    <meta name="description" content="How hosted Weft handles sign-in, synced notebooks, and privacy requests." />
</svelte:head>

<div class="wf-docs-shell">
    <SiteHeader />
    <main class="wf-docs-article">
        <h1 class="wf-docs-title">Privacy Notice</h1>

        <p>Last revised 26 November 2026.</p>
        <h2>Who runs Weft and what this notice covers</h2>
        <p>I’m Musaab Khan. I operate hosted Weft at weft.page. This notice covers the website, beta waitlist and sign-in, browser editor, and hosted sync relay. It does not cover independently self-hosted Weft installations or reMarkable’s own cloud service.</p>
        <p>For privacy questions or requests, email me at <a href="mailto:musaab.khan@protonmail.com">musaab.khan@protonmail.com</a>. You do not need a Weft account.</p>
        <h2>Information we use</h2>
        <ul>
            <li><strong>Beta waitlist.</strong> If you join the waitlist, Clerk collects your email address. I use it to manage beta invitations and let you know about your request. You can browse the site without joining. To withdraw a pending request, email me.</li>
            <li><strong>Account and sign-in information.</strong> Clerk handles sign-in, including Google sign-in. The relay uses your Clerk account ID to associate your synced notebooks with your account. When you’re signed in, Weft displays your primary email address, or your username or account ID if no primary email address is available.</li>
            <li><strong>Your synced library.</strong> Pairing your tablet with hosted Weft sends a copy of your synced notebooks and related library data to the relay. This can include titles and folders, handwriting and typed text, PDFs and images, and edit history. Weft also uses pairing and device identifiers to connect your tablet to the right account. The Weft software installed on your tablet reads local notebook files to send changes and updates those files when it applies changes from the relay.</li>
            <li><strong>Service and support information.</strong> Running the service can involve processing network and request information, such as an IP address or request details. If you contact me, I receive your contact details and what you choose to send. If the relay receives a sync failure report, it can include an error message, app version, source, timestamp, and diagnostic details such as hashed notebook or page identifiers.</li>
        </ul>
        <h2>How we use it</h2>
        <p>We use account, device, and notebook information to provide the service you ask for: signing in, pairing a tablet, syncing notebooks, editing in the browser, and keeping revisions and backups. We use limited operational information to keep the service working and secure, respond to support and privacy requests, and comply with applicable legal obligations.</p>
        <p>Where data protection law requires a lawful basis, I use account and sync information as necessary to provide the service you request under our agreement. Where appropriate, I rely on legitimate interests to manage beta access, keep the service secure and reliable, and respond to requests. I process information to comply with legal obligations when required. Weft does not use notebook contents for advertising or to train AI models.</p>
        <p><strong>Hosted sync is not end-to-end encrypted.</strong> The relay can read the notebook data it needs to process. Do not use hosted Weft as your only copy of important material or to store clinical records or regulated third-party files.</p>
        <h2>Information about other people</h2>
        <p>A notebook you sync can contain information about someone else. Weft receives that information from the notebook, not from the person it’s about. I do not search notebooks to identify or contact the people mentioned in them. If you believe a notebook contains information about you, you can make a privacy request even if you don’t use Weft. Please describe the request without attaching a notebook or sensitive files.</p>
        <h2>Providers and storage locations</h2>
        <ul>
            <li><strong>Netcup</strong> hosts the notebook relay in Nürnberg, Germany.</li>
            <li><strong>Cloudflare</strong> delivers the website and proxies traffic to and from the relay. It terminates HTTPS at its network edge and can process connection information, request headers, and the contents of traffic it forwards, including synced notebook data.</li>
            <li><strong>Clerk</strong> handles the waitlist and account authentication. If you sign in with Google, <strong>Google</strong> handles that part of sign-in.</li>
            <li><strong>tldraw</strong> provides the editor SDK. Its license check sends the editor URL and license and SDK information to tldraw. The URL can include notebook and page identifiers. The license request does not contain notebook text, handwriting, or files.</li>
        </ul>
        <p>Nürnberg is the location of the primary notebook relay. Service administration, traffic delivery, and authentication may involve access or processing outside Germany.</p>
        <h2>Browser storage</h2>
        <p>Weft and its sign-in provider use browser storage for session and service functions. Weft can also keep copies of notebook pages, thumbnails, and pending edits in your browser so it can reopen them and support offline use. Signing out does not necessarily clear those copies. You can clear Weft site data in your browser settings, but save or sync pending edits first.</p>
        <h2>How long information stays</h2>
        <p>I keep synced notebook data and revisions while they are stored in your hosted library. Disconnecting a tablet does not start a deletion or retention timer. The beta does not automatically delete inactive accounts.</p>
        <p>A deleted live copy can remain in rolling recovery backups until those backups are replaced. The relay normally keeps the latest 24 successful backups and makes them roughly hourly; a failed backup can extend that window. A request to delete hosted data is separate from deleting files from your tablet or clearing your browser.</p>
        <p>I keep support messages and service records as needed to handle requests, diagnose problems, keep Weft secure, and meet any applicable legal obligations. The relay stores up to 200 sync failure reports per account.</p>
        <h2>Your choices and rights</h2>
        <p>For access, a copy, correction, or deletion, email <a href="mailto:musaab.khan@protonmail.com">musaab.khan@protonmail.com</a>. I may need to verify your identity and what the request covers. Depending on the law that applies, you may also have rights to restrict processing, object to processing based on legitimate interests, receive a portable copy, or complain to a data protection authority.</p>
        <p>Disconnecting your tablet stops syncing but does not remove the hosted copy. Deleting your Google account or clearing your browser does not delete data on the relay. Deleting hosted data does not erase your original tablet files, local browser copies on other devices, or files you exported.</p>
        <h2>Changes to this notice</h2>
        <p>I may update this notice as Weft changes. I’ll update the revision date and notify affected users before material changes to how I use their personal data take effect.</p>
    </main>
    <SiteFooter />
</div>

<style>
    main {
        width: min(100%, 68ch);
        margin-inline: auto;
        overflow-wrap: anywhere;
    }
</style>
