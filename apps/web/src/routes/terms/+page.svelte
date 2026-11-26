<script lang="ts">
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
</script>

<svelte:head>
    <title>Hosted Terms · Weft</title>
    <meta name="description" content="Terms for using Weft’s hosted editor and notebook sync service." />
</svelte:head>

<div class="wf-docs-shell">
    <SiteHeader />
    <main class="wf-docs-article">
        <h1 class="wf-docs-title">Hosted Terms</h1>

        <h2>What these terms cover</h2>
        <p>I’m Musaab Khan, and I run hosted Weft at <a href="https://weft.page">weft.page</a>. These terms cover the hosted editor and sync service. They do not change the <a href="https://github.com/bxff/weft/blob/main/LICENSE">MIT license for Weft’s source code</a> or apply to someone else’s self-hosted installation.</p>
        <h2>Your notebooks</h2>
        <p>Your content stays yours. You give me permission to store, process, transmit, and back it up only as needed to run, secure, and recover the hosted service. You must have the right to upload what you sync, including any material that belongs to or identifies someone else. See the <a href="/privacy">Privacy Notice</a> for what Weft collects and how it is handled.</p>
        <h2>Using the beta</h2>
        <p>Hosted Weft is for personal notebooks. Do not use it to store clinical records or regulated client files. Do not access another account without permission, use Weft to upload unlawful content, or deliberately disrupt the service.</p>
        <h2>Keeping a copy and leaving</h2>
        <p>Hosted Weft is in beta. Sync may be delayed or incomplete, so keep your tablet originals or an independent copy of important material. Export anything you want to keep before closing your account. Disconnecting a tablet stops sync, but it does not delete the hosted copy. To request account closure or hosted data deletion, email <a href="mailto:musaab.khan@protonmail.com">musaab.khan@protonmail.com</a>.</p>
        <p>I may pause access to address abuse, a security issue, or legal obligations. I may change or shut down the hosted service. Where reasonably possible, I’ll give affected users advance notice and a chance to export before a planned shutdown. Nothing in these terms limits rights or remedies you have under mandatory law.</p>
        <h2>Contact</h2>
        <p>For questions about the hosted service, email <a href="mailto:musaab.khan@protonmail.com">musaab.khan@protonmail.com</a>.</p>
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
