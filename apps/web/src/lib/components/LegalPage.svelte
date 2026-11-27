<script lang="ts">
    import SiteHeader from '$lib/components/SiteHeader.svelte'
    import SiteFooter from '$lib/components/SiteFooter.svelte'
    import type { RenderedDoc } from '$lib/docs/render'

    let { data }: { data: RenderedDoc } = $props()
</script>

<svelte:head>
    <title>{data.title} · Weft</title>
    <meta name="description" content={data.description} />
</svelte:head>

<div class="wf-docs-shell">
    <SiteHeader />
    <main class="wf-docs-article">
        <h1 class="wf-docs-title">{data.title}</h1>
        <!-- Build-time HTML from repository Markdown, not user content. -->
        {@html data.html}
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
